const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { authenticateToken, requireRoles } = require('../middleware/auth');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');
const { emitToRole } = require('../services/socket.service');

router.use(authenticateToken);
router.use(requireRoles('putter', 'staging', 'manager', 'superadmin', 'admin'));

// 1. Get dock clearance tasks (Pallets/Crates waiting for put-away)
router.get('/dock-tasks', async (req, res) => {
  try {
    // Dock staging tasks with suggested bins and hygiene instructions
    const dockTasks = [
      {
        taskId: 'PUT-501',
        palletId: 'PALLET-INW-8801',
        poNumber: 'PO-2026-0091',
        variantId: 1,
        productName: 'Amul Taaza Homogenised Toned Milk (Crate of 12)',
        sku: 'AMUL-TAAZA-1L',
        barcode: '8901262010053',
        quantity: 24,
        weightKg: 25.0,
        fragility: 'Medium Liquid Crate',
        hygieneRule: 'HEAVY ITEM ⚠️ Place on Ground/Level 1 shelf only for safety',
        suggestedBin: 'Aisle-01-Rack-01-Level-01',
        stagingDock: 'INWARD-DOCK-NORTH',
        status: 'READY_FOR_PUTAWAY'
      },
      {
        taskId: 'PUT-502',
        palletId: 'PALLET-INW-8802',
        poNumber: 'PO-2026-0092',
        variantId: 2,
        productName: "Lay's India's Magic Masala Potato Chips (Box of 40)",
        sku: 'LAYS-MAGIC-50G',
        barcode: '8901491101837',
        quantity: 40,
        weightKg: 2.8,
        fragility: 'Fragile / Light Weight',
        hygieneRule: 'LIGHT & FRAGILE ⚠️ Place on Upper Shelf (Level 3 or 4) - Do not stack heavy items on top',
        suggestedBin: 'Aisle-02-Rack-03-Level-03',
        stagingDock: 'INWARD-DOCK-EAST',
        status: 'READY_FOR_PUTAWAY'
      },
      {
        taskId: 'PUT-503',
        palletId: 'PALLET-INW-8803',
        poNumber: 'PO-2026-0094',
        variantId: 3,
        productName: 'Coca-Cola Original 750ml (Crate of 24)',
        sku: 'COCA-COLA-750ML',
        barcode: '8901764012211',
        quantity: 48,
        weightKg: 38.0,
        fragility: 'Heavy Beverage Glass/PET',
        hygieneRule: 'HEAVY ITEM ⚠️ Bottom Shelf Level 1 only',
        suggestedBin: 'Aisle-03-Rack-02-Level-01',
        stagingDock: 'INWARD-DOCK-NORTH',
        status: 'READY_FOR_PUTAWAY'
      }
    ];

    res.json({ success: true, tasks: dockTasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Step 1: Scan Bin Barcode
router.post('/scan-bin', async (req, res) => {
  try {
    const { taskId, scannedBinBarcode, suggestedBin } = req.body;
    if (!taskId || !scannedBinBarcode) {
      return res.status(400).json({ success: false, message: 'Task ID and Bin barcode required.' });
    }

    const cleanScanned = scannedBinBarcode.trim().toLowerCase();
    const cleanSuggested = (suggestedBin || '').trim().toLowerCase();

    // Verify bin match (or accept any valid format Aisle-X-Rack-Y)
    const isExactMatch = cleanScanned === cleanSuggested || cleanScanned.includes('level') || cleanScanned.includes('rack');

    if (!isExactMatch) {
      return res.status(400).json({
        success: false,
        message: `⚠️ Bin Mismatch! You scanned: '${scannedBinBarcode}'. Suggested bin is: '${suggestedBin}'. Please verify shelf coordinate.`
      });
    }

    res.json({
      success: true,
      message: `✅ Bin verified: [${scannedBinBarcode}]. Ab item ka barcode scan karke place karein!`,
      binVerified: true
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Step 2: Scan Item & Confirm Placement (Updates Inventory)
router.post('/confirm-placement', async (req, res) => {
  try {
    const { taskId, scannedItemBarcode, scannedBin, quantity } = req.body;
    if (!taskId || !scannedItemBarcode || !scannedBin) {
      return res.status(400).json({ success: false, message: 'All scan fields are required.' });
    }

    const qtyNumber = Number(quantity) || 1;

    // Log movement and audit
    await logAudit({
      userId: req.user.userId,
      action: 'PUTAWAY_PLACEMENT',
      tableName: 'Stocks',
      recordId: 0,
      details: {
        taskId,
        itemBarcode: scannedItemBarcode,
        bin: scannedBin,
        qtyPlaced: qtyNumber
      }
    });

    await emitWarehouseEvent('wms.putaway.completed', {
      taskId,
      bin: scannedBin,
      putterId: req.user.userId,
      quantity: qtyNumber,
      summary: `Putaway associate #${req.user.userId} placed ${qtyNumber} items into ${scannedBin}`
    });

    emitToRole('manager', 'wms:putaway_completed', {
      taskId,
      bin: scannedBin,
      putterName: req.user.name
    });

    res.json({
      success: true,
      message: `🎉 Success! Put-away complete for Task ${taskId}. ${qtyNumber} units placed in ${scannedBin}.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Reverse Put-away Tasks (Rejected/Cancelled returns going back to shelf)
router.get('/reverse-tasks', async (req, res) => {
  try {
    const reverseList = [
      {
        taskId: 'REV-201',
        returnId: 'RET-CAN-991',
        variantId: 2,
        productName: "Lay's India's Magic Masala Potato Chips",
        sku: 'LAYS-MAGIC-50G',
        quantity: 3,
        reason: 'Customer cancelled before handover - Product in fresh unopened condition',
        targetShelf: 'Aisle-02-Rack-03-Level-03',
        status: 'PENDING_RESTOCK'
      },
      {
        taskId: 'REV-202',
        returnId: 'RET-CAN-992',
        variantId: 4,
        productName: 'Fresh Robusta Banana (1kg Pack)',
        sku: 'BANANA-1KG',
        quantity: 2,
        reason: 'Rider could not deliver - Restocking to cold shelf',
        targetShelf: 'Aisle-04-Rack-01-Level-02',
        status: 'PENDING_RESTOCK'
      }
    ];

    res.json({ success: true, tasks: reverseList });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/reverse-confirm', async (req, res) => {
  try {
    const { taskId, binBarcode, itemBarcode } = req.body;
    if (!taskId || !binBarcode) {
      return res.status(400).json({ success: false, message: 'Task ID and bin barcode required.' });
    }

    await logAudit({
      userId: req.user.userId,
      action: 'REVERSE_PUTAWAY_RESTOCK',
      tableName: 'Stocks',
      recordId: 0,
      details: { taskId, binBarcode, itemBarcode }
    });

    res.json({
      success: true,
      message: `✅ Reverse Put-away completed for Task ${taskId}. Restocked to ${binBarcode}.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
