const prisma = require('../config/db');
const { cache } = require('../config/redis');
const { emitToUser, emitToRole } = require('./socket.service');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');

/**
 * Checks for free pickers on duty and assigns pending orders automatically.
 */
async function triggerAutoAssignment(storeId = null) {
  try {
    // 1. Get all users with role 'picker'
    const pickers = await prisma.users.findMany({
      where: {
        Role: { equals: 'picker', mode: 'insensitive' },
        IsActive: true
      }
    });

    if (!pickers.length) return { assigned: 0, message: 'No active pickers found' };

    // 2. Filter pickers who are currently Duty ON and not on break
    const availablePickers = [];
    for (const picker of pickers) {
      const dutyKey = `wms:duty:${picker.UserID}`;
      const dutyData = await cache.get(dutyKey);
      const parsedDuty = dutyData ? (typeof dutyData === 'string' ? JSON.parse(dutyData) : dutyData) : null;

      // Allow if duty is ON and not on break (default to active for testing if not set)
      const isDutyOn = parsedDuty ? (parsedDuty.duty === 'ON' && !parsedDuty.onBreak) : false;

      if (isDutyOn) {
        // Check if picker already has an active incomplete picklist
        // First find staff ID
        let staff = await prisma.staff.findFirst({
          where: { UserID: picker.UserID }
        });

        if (!staff) {
          staff = await prisma.staff.create({
            data: {
              UserID: picker.UserID,
              StoreID: storeId || 1,
              RoleID: 4, // picker
              Status: 'ACTIVE'
            }
          });
        }

        const activePickList = await prisma.pickLists.findFirst({
          where: {
            StaffID: staff.StaffID,
            Status: { in: ['ASSIGNED', 'PICKING'] }
          }
        });

        if (!activePickList) {
          availablePickers.push({
            user: picker,
            staff
          });
        }
      }
    }

    if (!availablePickers.length) {
      return { assigned: 0, message: 'No free pickers available right now' };
    }

    // 3. Find pending orders needing picking
    // An order is pending if status is CONFIRMED, PAID, PLACED, or PENDING_PICK
    const pendingOrders = await prisma.orders.findMany({
      where: {
        Status: { in: ['CONFIRMED', 'PAID', 'PLACED', 'PENDING_PICK'] }
      },
      orderBy: { OrderID: 'asc' },
      take: availablePickers.length
    });

    let assignedCount = 0;

    for (let i = 0; i < pendingOrders.length && i < availablePickers.length; i++) {
      const order = pendingOrders[i];
      const { user: pickerUser, staff: pickerStaff } = availablePickers[i];

      // Check if a picklist already exists for this order
      let pickList = await prisma.pickLists.findFirst({
        where: { OrderID: order.OrderID }
      });

      if (!pickList) {
        pickList = await prisma.pickLists.create({
          data: {
            OrderID: order.OrderID,
            StoreID: order.StoreID || pickerStaff.StoreID || 1,
            StaffID: pickerStaff.StaffID,
            Status: 'ASSIGNED',
            CreatedAt: new Date()
          }
        });

        // Fetch order items and create PickListItems
        const orderItems = await prisma.orderItems.findMany({
          where: { OrderID: order.OrderID }
        });

        for (const item of orderItems) {
          // Find variant to get ShelfID
          const variant = await prisma.variants.findUnique({
            where: { VariantID: item.VariantID }
          });

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
        // Re-assign existing uncompleted picklist
        pickList = await prisma.pickLists.update({
          where: { PickListID: pickList.PickListID },
          data: {
            StaffID: pickerStaff.StaffID,
            Status: 'ASSIGNED'
          }
        });
      }

      // Update Order status to PICKING
      await prisma.orders.update({
        where: { OrderID: order.OrderID },
        data: { Status: 'PICKING' }
      });

      // Update active assignment in Redis
      await cache.set(`wms:active_pick:${pickerUser.UserID}`, {
        pickListId: pickList.PickListID,
        orderId: order.OrderID,
        assignedAt: new Date().toISOString()
      }, 7200);

      // Notify the Picker via WebSocket
      emitToUser(pickerUser.UserID, 'order:assigned', {
        pickListId: pickList.PickListID,
        orderId: order.OrderID,
        message: `New Order #${order.OrderID} automatically assigned for picking!`
      });

      // Notify Managers
      emitToRole('manager', 'wms:task_allocated', {
        taskType: 'PICKING',
        orderId: order.OrderID,
        pickListId: pickList.PickListID,
        pickerName: `${pickerUser.UserNameFirst} ${pickerUser.UserNameLast || ''}`.trim(),
        pickerId: pickerUser.UserID
      });

      // Audit log & Kafka
      await logAudit({
        userId: pickerUser.UserID,
        action: 'AUTO_ASSIGN_ORDER',
        tableName: 'PickLists',
        recordId: pickList.PickListID,
        details: { orderId: order.OrderID, staffId: pickerStaff.StaffID }
      });

      await emitWarehouseEvent('wms.picking.assigned', {
        orderId: order.OrderID,
        pickListId: pickList.PickListID,
        pickerId: pickerUser.UserID,
        summary: `Order #${order.OrderID} auto-assigned to ${pickerUser.UserNameFirst}`
      });

      assignedCount++;
    }

    return { assigned: assignedCount, message: `Assigned ${assignedCount} order(s)` };
  } catch (err) {
    console.error('❌ Auto assignment error:', err.message);
    return { assigned: 0, error: err.message };
  }
}

module.exports = { triggerAutoAssignment };
