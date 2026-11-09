const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { authenticateToken, requireRoles } = require('../middleware/auth');
const { triggerAutoAssignment } = require('../services/autoAssign.service');
const { emitToRole, emitToUser } = require('../services/socket.service');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');
const { cache } = require('../config/redis');

// Apply auth to all picker routes
router.use(authenticateToken);
router.use(requireRoles('picker', 'manager', 'superadmin', 'admin'));

// 1. Get active assigned picking task
router.get('/active-task', async (req, res) => {
  try {
    const staff = await prisma.staff.findFirst({ where: { UserID: req.user.userId } });
    if (!staff) return res.json({ success: true, activeTask: null });

    // Look for in-progress or assigned picklist
    const pickList = await prisma.pickLists.findFirst({
      where: {
        StaffID: staff.StaffID,
        Status: { in: ['ASSIGNED', 'PICKING'] }
      },
      orderBy: { PickListID: 'desc' }
    });

    if (!pickList) {
      // If duty is ON, try auto-assigning right now
      const dutyData = await cache.get(`wms:duty:${req.user.userId}`);
      const parsedDuty = dutyData ? (typeof dutyData === 'string' ? JSON.parse(dutyData) : dutyData) : null;
      if (parsedDuty?.duty === 'ON' && !parsedDuty?.onBreak) {
        await triggerAutoAssignment(staff.StoreID);
        // recheck
        const recheck = await prisma.pickLists.findFirst({
          where: { StaffID: staff.StaffID, Status: { in: ['ASSIGNED', 'PICKING'] } },
          orderBy: { PickListID: 'desc' }
        });
        if (recheck) return res.json(await formatPickListResponse(recheck));
      }
      return res.json({ success: true, activeTask: null, message: 'No active orders assigned.' });
    }

    res.json(await formatPickListResponse(pickList));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

async function formatPickListResponse(pickList) {
  const items = await prisma.pickListItems.findMany({
    where: { PickListID: pickList.PickListID }
  });

  const enrichedItems = await Promise.all(
    items.map(async (item) => {
      const variant = await prisma.variants.findUnique({
        where: { VariantID: item.VariantID }
      });
      const product = variant ? await prisma.products.findUnique({
        where: { ProductID: variant.ProductID }
      }) : null;
      const shelf = await prisma.shelves.findUnique({
        where: { ShelfID: item.ShelfID }
      });

      return {
        itemId: item.ItemID,
        pickListId: item.PickListID,
        variantId: item.VariantID,
        productName: product?.ProductName || 'Unknown Item',
        sku: variant?.SKU || `SKU-${item.VariantID}`,
        barcode: variant?.SKU || `BARCODE-${item.VariantID}`,
        weight: variant?.Weight || 0.5,
        imageUrl: variant?.ImageURL || 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=200&q=80',
        shelfCode: shelf?.ShelfCode || `Aisle-1-Rack-0${item.ShelfID}-S01`,
        qtyToPick: item.QtyToPick,
        qtyPicked: item.QtyPicked || 0,
        status: item.Status || 'PENDING',
        targetSeconds: 75 // 60-90s target
      };
    })
  );

  const order = await prisma.orders.findUnique({
    where: { OrderID: pickList.OrderID }
  });

  return {
    success: true,
    activeTask: {
      pickListId: pickList.PickListID,
      orderId: pickList.OrderID,
      status: pickList.Status,
      createdAt: pickList.CreatedAt,
      customerOrder: order,
      items: enrichedItems,
      totalItems: enrichedItems.reduce((acc, i) => acc + i.qtyToPick, 0),
      totalPicked: enrichedItems.reduce((acc, i) => acc + i.qtyPicked, 0)
    }
  };
}

// 2. Barcode Scan & Verification for Item
router.post('/scan-item', async (req, res) => {
  try {
    const { itemId, scannedBarcode, durationSeconds } = req.body;
    if (!itemId || !scannedBarcode) {
      return res.status(400).json({ success: false, message: 'Item ID and scanned barcode are required.' });
    }

    const item = await prisma.pickListItems.findUnique({
      where: { ItemID: Number(itemId) }
    });

    if (!item) {
      return res.status(404).json({ success: false, message: 'Pick item not found.' });
    }

    const variant = await prisma.variants.findUnique({
      where: { VariantID: item.VariantID }
    });

    // Validate barcode against SKU or Barcode
    const validBarcodes = [
      (variant?.SKU || '').trim().toLowerCase(),
      `barcode-${item.VariantID}`.toLowerCase(),
      `sku-${item.VariantID}`.toLowerCase()
    ];

    const cleanScanned = scannedBarcode.trim().toLowerCase();
    const isMatch = validBarcodes.includes(cleanScanned) || cleanScanned === String(variant?.VariantID);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        matched: false,
        message: `❌ Barcode Mismatch! Scanned '${scannedBarcode}'. Expected SKU: '${variant?.SKU || 'SKU-' + item.VariantID}'. Galat product na pick karein!`
      });
    }

    const newQtyPicked = (item.QtyPicked || 0) + 1;
    const isCompleted = newQtyPicked >= (item.QtyToPick || 1);

    const updatedItem = await prisma.pickListItems.update({
      where: { ItemID: item.ItemID },
      data: {
        QtyPicked: newQtyPicked,
        Status: isCompleted ? 'PICKED' : 'PARTIAL'
      }
    });

    // Speed evaluation (60 - 90 seconds target)
    const speedRating = (durationSeconds && durationSeconds <= 90) ? 'EXCELLENT' : (durationSeconds <= 120 ? 'GOOD' : 'SLOW');

    await logAudit({
      userId: req.user.userId,
      action: 'SCAN_PICK_ITEM',
      tableName: 'PickListItems',
      recordId: item.ItemID,
      details: {
        barcode: scannedBarcode,
        variantId: item.VariantID,
        qtyPicked: newQtyPicked,
        durationSeconds,
        speedRating
      }
    });

    res.json({
      success: true,
      matched: true,
      message: `✅ Verified & Picked! (${newQtyPicked}/${item.QtyToPick})`,
      item: updatedItem,
      speedRating
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Complete Picking Order & Trigger Auto Assignment of NEXT Order!
router.post('/complete-pick', async (req, res) => {
  try {
    const { pickListId } = req.body;
    if (!pickListId) {
      return res.status(400).json({ success: false, message: 'PickList ID is required.' });
    }

    const pickList = await prisma.pickLists.findUnique({
      where: { PickListID: Number(pickListId) }
    });

    if (!pickList) {
      return res.status(404).json({ success: false, message: 'PickList not found.' });
    }

    // Verify all items are picked
    const items = await prisma.pickListItems.findMany({
      where: { PickListID: pickList.PickListID }
    });

    const unpicked = items.filter(i => (i.QtyPicked || 0) < (i.QtyToPick || 1));
    if (unpicked.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot complete: ${unpicked.length} item(s) are not fully picked yet!`
      });
    }

    // Mark PickList as PICKED
    await prisma.pickLists.update({
      where: { PickListID: pickList.PickListID },
      data: { Status: 'PICKED' }
    });

    // Update order status to READY_FOR_PACKING
    await prisma.orders.update({
      where: { OrderID: pickList.OrderID },
      data: { Status: 'READY_FOR_PACKING' }
    });

    // Create entry in PackingLists
    let packList = await prisma.packingLists.findFirst({
      where: { OrderID: pickList.OrderID }
    });

    if (!packList) {
      packList = await prisma.packingLists.create({
        data: {
          PickListID: pickList.PickListID,
          OrderID: pickList.OrderID,
          StaffID: 0,
          Status: 'READY_FOR_PACKING'
        }
      });
    }

    // Clear active picker assignment in Redis
    await cache.del(`wms:active_pick:${req.user.userId}`);

    // Notify Packers room
    emitToRole('packer', 'wms:order_ready_for_packing', {
      orderId: pickList.OrderID,
      pickListId: pickList.PickListID,
      packId: packList.PackID,
      message: `Order #${pickList.OrderID} is picked and waiting at packing table!`
    });

    // Log audit & Kafka
    await logAudit({
      userId: req.user.userId,
      action: 'COMPLETE_PICKING',
      tableName: 'PickLists',
      recordId: pickList.PickListID,
      details: { orderId: pickList.OrderID }
    });

    await emitWarehouseEvent('wms.picking.completed', {
      orderId: pickList.OrderID,
      pickListId: pickList.PickListID,
      pickerId: req.user.userId,
      summary: `Order #${pickList.OrderID} picked by Picker #${req.user.userId}`
    });

    // 🔥 AUTO ASSIGN NEXT ORDER TO THIS PICKER IMMEDIATELY! 🔥
    setTimeout(async () => {
      const assignResult = await triggerAutoAssignment(pickList.StoreID);
      console.log('⚡ Auto-assignment for freed picker:', assignResult);
    }, 600);

    res.json({
      success: true,
      message: `🎉 Order #${pickList.OrderID} picked successfully! Hand over to Packing Table. Next order will be auto-assigned.`,
      nextAutoAssigned: true
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Customer Return Picking (Return items from bin to return dock)
router.get('/return-tasks', async (req, res) => {
  try {
    // Return sample/actual returns needing picking to dock
    const returnTasks = [
      {
        returnId: 'RET-101',
        orderId: 1045,
        variantId: 1,
        productName: 'Amul Taaza Homogenised Toned Milk',
        shelfCode: 'Aisle-01-Rack-01-Bin-04',
        qty: 2,
        customerName: 'Rahul Verma',
        riderName: 'Vikram Singh (Rider #12)',
        reason: 'Customer rejected - Packaging Seal Loose',
        status: 'PENDING_RETURN_PICK'
      },
      {
        returnId: 'RET-102',
        orderId: 1078,
        variantId: 2,
        productName: "Lay's India's Magic Masala Potato Chips",
        shelfCode: 'Aisle-02-Rack-03-Bin-02',
        qty: 1,
        customerName: 'Priya Sharma',
        riderName: 'Amit Kumar (Rider #07)',
        reason: 'Wrong item delivered',
        status: 'PENDING_RETURN_PICK'
      }
    ];

    res.json({ success: true, returns: returnTasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/pick-return', async (req, res) => {
  try {
    const { returnId, scannedBinBarcode, returnDockCode } = req.body;
    if (!returnId || !scannedBinBarcode) {
      return res.status(400).json({ success: false, message: 'Return ID and scanned bin barcode are required.' });
    }

    await logAudit({
      userId: req.user.userId,
      action: 'CUSTOMER_RETURN_PICK',
      tableName: 'OrderReturns',
      recordId: 0,
      details: { returnId, scannedBinBarcode, returnDockCode: returnDockCode || 'RETURN-DOCK-A' }
    });

    res.json({
      success: true,
      message: `✅ Return #${returnId} picked from bin and placed at Return Dock [${returnDockCode || 'DOCK-A'}]`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
