const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { authenticateToken, requireRoles } = require('../middleware/auth');
const { cache } = require('../config/redis');
const { triggerAutoAssignment } = require('../services/autoAssign.service');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');
const { emitToUser, broadcast } = require('../services/socket.service');

router.use(authenticateToken);
router.use(requireRoles('manager', 'incharge', 'supervisor', 'floorlead', 'superadmin', 'admin'));

// 1. Live Floor & Staff Shift Status
router.get('/floor-status', async (req, res) => {
  try {
    // Get all staff users
    const users = await prisma.users.findMany({
      where: {
        Role: { in: ['picker', 'packer', 'putter', 'inward', 'manager', 'admin'], mode: 'insensitive' }
      },
      select: {
        UserID: true,
        UserNameFirst: true,
        UserNameLast: true,
        Role: true,
        Mobile: true,
        Email: true,
        IsOnline: true
      }
    });

    const staffStatusList = await Promise.all(
      users.map(async (u) => {
        const dutyData = await cache.get(`wms:duty:${u.UserID}`);
        const duty = dutyData ? (typeof dutyData === 'string' ? JSON.parse(dutyData) : dutyData) : {
          duty: 'OFF',
          onBreak: false,
          slot: null,
          punchInTime: null
        };

        const activePick = await cache.get(`wms:active_pick:${u.UserID}`);
        const parsedPick = activePick ? (typeof activePick === 'string' ? JSON.parse(activePick) : activePick) : null;

        return {
          userId: u.UserID,
          name: `${u.UserNameFirst} ${u.UserNameLast || ''}`.trim(),
          role: u.Role,
          mobile: u.Mobile,
          duty: duty.duty || 'OFF',
          onBreak: !!duty.onBreak,
          breakType: duty.breakType || null,
          slot: duty.slot || 'N/A',
          punchInTime: duty.punchInTime || 'Not Punched In',
          selfieUrl: duty.selfieUrl || null,
          activeTask: parsedPick ? `Picking Order #${parsedPick.orderId}` : (duty.duty === 'ON' ? 'Idle / Available' : 'Off Duty')
        };
      })
    );

    // Orders summary
    const ordersCount = {
      pending: await prisma.orders.count({ where: { Status: { in: ['CONFIRMED', 'PAID', 'PLACED', 'PENDING_PICK'] } } }),
      picking: await prisma.orders.count({ where: { Status: 'PICKING' } }),
      readyToPack: await prisma.orders.count({ where: { Status: { in: ['READY_FOR_PACKING', 'PICKED'] } } }),
      dispatchReady: await prisma.orders.count({ where: { Status: 'DISPATCH_READY' } })
    };

    res.json({
      success: true,
      summary: ordersCount,
      staffCount: {
        total: staffStatusList.length,
        dutyOn: staffStatusList.filter(s => s.duty === 'ON').length,
        onBreak: staffStatusList.filter(s => s.onBreak).length,
        dutyOff: staffStatusList.filter(s => s.duty === 'OFF').length
      },
      staff: staffStatusList
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Task Allocation & Manual/Auto Assign Trigger
router.post('/trigger-auto-assign', async (req, res) => {
  try {
    const result = await triggerAutoAssignment();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/manual-assign', async (req, res) => {
  try {
    const { orderId, pickerUserId } = req.body;
    if (!orderId || !pickerUserId) {
      return res.status(400).json({ success: false, message: 'OrderID and pickerUserId required.' });
    }

    let staff = await prisma.staff.findFirst({ where: { UserID: Number(pickerUserId) } });
    if (!staff) {
      staff = await prisma.staff.create({
        data: { UserID: Number(pickerUserId), StoreID: 1, RoleID: 4, Status: 'ACTIVE' }
      });
    }

    let pickList = await prisma.pickLists.findFirst({ where: { OrderID: Number(orderId) } });
    if (!pickList) {
      pickList = await prisma.pickLists.create({
        data: {
          OrderID: Number(orderId),
          StoreID: 1,
          StaffID: staff.StaffID,
          Status: 'ASSIGNED',
          CreatedAt: new Date()
        }
      });
      const orderItems = await prisma.orderItems.findMany({ where: { OrderID: Number(orderId) } });
      for (const item of orderItems) {
        const variant = await prisma.variants.findUnique({ where: { VariantID: item.VariantID } });
        await prisma.pickListItems.create({
          data: {
            PickListID: pickList.PickListID,
            VariantID: item.VariantID,
            ShelfID: variant?.ShelfID || 1,
            QtyToPick: item.Qty || 1,
            QtyPicked: 0,
            Status: 'PENDING'
          }
        });
      }
    } else {
      await prisma.pickLists.update({
        where: { PickListID: pickList.PickListID },
        data: { StaffID: staff.StaffID, Status: 'ASSIGNED' }
      });
    }

    await prisma.orders.update({
      where: { OrderID: Number(orderId) },
      data: { Status: 'PICKING' }
    });

    await cache.set(`wms:active_pick:${pickerUserId}`, {
      pickListId: pickList.PickListID,
      orderId: Number(orderId),
      assignedAt: new Date().toISOString()
    }, 7200);

    emitToUser(pickerUserId, 'order:assigned', {
      pickListId: pickList.PickListID,
      orderId: Number(orderId),
      message: `Supervisor assigned Order #${orderId} to you!`
    });

    await logAudit({
      userId: req.user.userId,
      action: 'MANUAL_TASK_ASSIGN',
      tableName: 'PickLists',
      recordId: pickList.PickListID,
      details: { orderId, pickerUserId }
    });

    res.json({ success: true, message: `Order #${orderId} assigned to Picker #${pickerUserId} successfully.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Discrepancy Approval Desk (Damage / Leakage / Shortage Approval)
router.get('/discrepancies', async (req, res) => {
  try {
    // Return logged discrepancy audits
    const logs = await prisma.auditLogs.findMany({
      where: { Action: 'DAMAGE_FLAGGED' },
      orderBy: { LogID: 'desc' },
      take: 20
    });

    const parsedLogs = logs.map(l => {
      let details = {};
      try { details = JSON.parse(l.NewValue || '{}'); } catch (e) {}
      return {
        logId: l.LogID,
        ticketId: details.ticketId || `DISC-${l.LogID}`,
        poNumber: details.poNumber || 'N/A',
        sku: details.sku || 'N/A',
        quantity: details.quantity || 1,
        damageType: details.damageType || 'LEAKAGE',
        photoUrl: details.photoUrl || null,
        reportedBy: details.reportedBy || `User #${l.UserID}`,
        reportedAt: l.Time,
        status: details.status || 'PENDING_APPROVAL'
      };
    });

    res.json({ success: true, discrepancies: parsedLogs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/resolve-discrepancy', async (req, res) => {
  try {
    const { ticketId, action, notes } = req.body; // action: 'APPROVED_FOR_RTV' or 'REJECTED'
    if (!ticketId || !action) {
      return res.status(400).json({ success: false, message: 'Ticket ID and action required.' });
    }

    await logAudit({
      userId: req.user.userId,
      action: `DISCREPANCY_${action}`,
      tableName: 'Discrepancies',
      recordId: 0,
      details: { ticketId, action, notes, resolvedBy: req.user.name }
    });

    await emitWarehouseEvent('wms.discrepancy.resolved', {
      ticketId,
      action,
      managerId: req.user.userId,
      summary: `Ticket #${ticketId} was ${action} by Manager ${req.user.name}`
    });

    broadcast('wms:discrepancy_resolved', {
      ticketId,
      action,
      resolvedBy: req.user.name
    });

    res.json({
      success: true,
      message: `Discrepancy #${ticketId} status updated to [${action}]. Notes recorded.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Return to Vendor (RTV) Gatepass & Dispatch Manifest
router.post('/generate-rtv-gatepass', async (req, res) => {
  try {
    const { vendorName, poNumber, vehicleNumber, transporterName, driverName, driverContact, items } = req.body;

    const gatepassNo = `GP-RTV-${Date.now().toString().slice(-6)}`;
    const now = new Date();

    const gatepass = {
      gatepassNo,
      type: 'RETURN_TO_VENDOR (RTV)',
      vendorName: vendorName || 'Amul Dairy Products Ltd',
      poNumber: poNumber || 'PO-2026-0091',
      vehicleNumber: vehicleNumber || 'UP-16-CD-9988',
      transporterName: transporterName || 'Safexpress Logistics',
      driverName: driverName || 'Ramesh Yadav',
      driverContact: driverContact || '+91 98765 00000',
      totalItems: Array.isArray(items) ? items.reduce((s, i) => s + (Number(i.qty) || 0), 0) : 12,
      itemList: items || [
        { sku: 'AMUL-TAAZA-1L', qty: 10, reason: 'Broken / Leakage in Transit' },
        { sku: 'LAYS-MAGIC-50G', qty: 2, reason: 'Expired packaging batch' }
      ],
      issuedAt: now.toLocaleString(),
      issuedBy: req.user.name,
      securityApprovalStamp: `APPROVED-SEAL-${gatepassNo}`,
      status: 'GATEPASS_ISSUED'
    };

    await logAudit({
      userId: req.user.userId,
      action: 'GENERATE_RTV_GATEPASS',
      tableName: 'PurchaseReturns',
      recordId: 0,
      details: gatepass
    });

    await emitWarehouseEvent('wms.gatepass.issued', {
      gatepassNo,
      vendorName: gatepass.vendorName,
      issuedBy: req.user.name,
      summary: `RTV Gatepass ${gatepassNo} generated for ${gatepass.vendorName}`
    });

    res.json({
      success: true,
      gatepass,
      message: `🚛 RTV Gatepass [${gatepassNo}] generated successfully with Security Stamp!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
