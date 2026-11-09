const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');
const { broadcast } = require('../services/socket.service');

router.use(authenticateToken);

// 1. Get current inventory & shelf locations for transfer/move
router.get('/inventory', async (req, res) => {
  try {
    const variants = await prisma.variants.findMany({
      take: 50,
      orderBy: { VariantID: 'asc' }
    });

    const shelves = await prisma.shelves.findMany({
      take: 50
    });

    const stores = await prisma.stores.findMany({
      take: 20
    });

    const enriched = await Promise.all(
      variants.map(async (v) => {
        const prod = await prisma.products.findUnique({ where: { ProductID: v.ProductID } });
        const stock = await prisma.stocks.findFirst({ where: { VariantID: v.VariantID } });
        return {
          variantId: v.VariantID,
          productName: prod?.ProductName || 'Grocery Item',
          sku: v.SKU || `SKU-${v.VariantID}`,
          barcode: v.SKU || `BARCODE-${v.VariantID}`,
          currentShelf: `Aisle-01-Rack-0${(v.VariantID % 5) + 1}-S0${(v.VariantID % 3) + 1}`,
          onHandQty: stock?.OnHandQty || (10 + (v.VariantID * 3)),
          weight: v.Weight || 0.5
        };
      })
    );

    res.json({
      success: true,
      items: enriched,
      shelves: shelves.map(s => s.ShelfCode || `Aisle-1-Rack-${s.ShelfID}-S1`),
      stores: stores.map(st => ({ storeId: st.StoreID, name: st.StoreName || `Dark Store #${st.StoreID}` }))
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Step 7A: Internal Shelf-to-Shelf Move
router.post('/internal-shelf', async (req, res) => {
  try {
    const { variantId, sourceShelf, targetShelf, qty, reason } = req.body;
    if (!variantId || !sourceShelf || !targetShelf || !qty) {
      return res.status(400).json({
        success: false,
        message: 'variantId, sourceShelf, targetShelf, and qty are required.'
      });
    }

    const moveQty = parseInt(qty, 10);
    if (moveQty <= 0) {
      return res.status(400).json({ success: false, message: 'Quantity must be at least 1' });
    }

    if (sourceShelf.trim().toUpperCase() === targetShelf.trim().toUpperCase()) {
      return res.status(400).json({ success: false, message: 'Source shelf and target shelf cannot be identical.' });
    }

    const staff = await prisma.staff.findFirst({ where: { UserID: req.user.userId } });

    // Record StockMovement
    const movement = await prisma.stockMovements.create({
      data: {
        VariantID: parseInt(variantId, 10),
        FromStoreID: staff?.StoreID || 1,
        ToStoreID: staff?.StoreID || 1,
        FromShelf: sourceShelf.trim(),
        ToShelf: targetShelf.trim(),
        Qty: moveQty,
        Type: 'INTERNAL_SHELF',
        Reason: reason || 'Stock Relocation / Consolidation',
        Status: 'COMPLETED',
        Date: new Date(),
        CreatedBy: req.user.userId,
        CreatedByName: req.user.name || `Staff #${req.user.userId}`
      }
    });

    // Audit log
    await logAudit({
      userId: req.user.userId,
      action: 'INTERNAL_SHELF_MOVE',
      tableName: 'StockMovements',
      recordId: movement.MovementID,
      details: {
        variantId,
        sourceShelf,
        targetShelf,
        qty: moveQty,
        reason
      }
    });

    // Kafka event
    await emitWarehouseEvent('wms.stock.moved_internal', {
      movementId: movement.MovementID,
      variantId,
      sourceShelf,
      targetShelf,
      qty: moveQty,
      operator: req.user.name
    });

    // Socket broadcast
    broadcast('wms:stock_updated', {
      type: 'INTERNAL_MOVE',
      movementId: movement.MovementID,
      sourceShelf,
      targetShelf,
      qty: moveQty
    });

    res.json({
      success: true,
      message: `✅ Successfully moved ${moveQty} units from ${sourceShelf} to ${targetShelf}!`,
      movement
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Step 7B: Store-to-Store (Inter-Dark Store) Dispatch
router.post('/store-dispatch', async (req, res) => {
  try {
    const { toStoreId, variantId, qty, transporter, vehicleNo, sealNo, reason } = req.body;
    if (!toStoreId || !variantId || !qty || !sealNo) {
      return res.status(400).json({
        success: false,
        message: 'toStoreId, variantId, qty, and sealNo are required.'
      });
    }

    const staff = await prisma.staff.findFirst({ where: { UserID: req.user.userId } });
    const moveQty = parseInt(qty, 10);
    const transferNo = `STO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

    const movement = await prisma.stockMovements.create({
      data: {
        VariantID: parseInt(variantId, 10),
        FromStoreID: staff?.StoreID || 1,
        ToStoreID: parseInt(toStoreId, 10),
        FromShelf: 'DISPATCH_BAY',
        ToShelf: 'TRANSIT',
        Qty: moveQty,
        Type: 'STORE_TO_STORE_DISPATCH',
        TransferNo: transferNo,
        Transporter: transporter || 'Zepto Dark Logistics Fleet',
        VehicleNo: vehicleNo || 'MH-04-AB-1234',
        SealNo: sealNo,
        Reason: reason || 'Inter-Store Inventory Balancing',
        Status: 'IN_TRANSIT',
        Date: new Date(),
        CreatedBy: req.user.userId,
        CreatedByName: req.user.name || `Staff #${req.user.userId}`
      }
    });

    await logAudit({
      userId: req.user.userId,
      action: 'STORE_TRANSFER_DISPATCHED',
      tableName: 'StockMovements',
      recordId: movement.MovementID,
      details: { transferNo, toStoreId, qty: moveQty, sealNo }
    });

    res.json({
      success: true,
      message: `🚚 Transfer Dispatch Manifest Created! Transfer No: ${transferNo}`,
      manifest: {
        transferNo,
        movementId: movement.MovementID,
        fromStore: staff?.StoreID || 1,
        toStore: parseInt(toStoreId, 10),
        qty: moveQty,
        sealNo,
        transporter: transporter || 'Zepto Dark Logistics Fleet',
        vehicleNo: vehicleNo || 'MH-04-AB-1234',
        dispatchedAt: new Date()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Step 7C: Store-to-Store Inbound Receive
router.post('/store-receive', async (req, res) => {
  try {
    const { transferNo, sealNo, targetShelf } = req.body;
    if (!transferNo || !sealNo || !targetShelf) {
      return res.status(400).json({
        success: false,
        message: 'transferNo, sealNo, and targetShelf are required.'
      });
    }

    const movement = await prisma.stockMovements.findFirst({
      where: {
        TransferNo: transferNo.trim(),
        Type: 'STORE_TO_STORE_DISPATCH'
      }
    });

    if (!movement) {
      return res.status(404).json({
        success: false,
        message: `Transfer #${transferNo} not found in transit manifest.`
      });
    }

    if (movement.SealNo && movement.SealNo.trim() !== sealNo.trim()) {
      return res.status(400).json({
        success: false,
        message: `⚠️ Security Seal Mismatch! Expected: ${movement.SealNo}, Scanned: ${sealNo}. Report discrepancy to floor lead!`
      });
    }

    // Mark as completed
    const updated = await prisma.stockMovements.update({
      where: { MovementID: movement.MovementID },
      data: {
        Status: 'RECEIVED',
        ToShelf: targetShelf.trim()
      }
    });

    await logAudit({
      userId: req.user.userId,
      action: 'STORE_TRANSFER_RECEIVED',
      tableName: 'StockMovements',
      recordId: movement.MovementID,
      details: { transferNo, sealNo, targetShelf }
    });

    res.json({
      success: true,
      message: `✅ Transfer #${transferNo} safely received and placed into shelf ${targetShelf}!`,
      movement: updated
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Transfer & Movement History
router.get('/history', async (req, res) => {
  try {
    const movements = await prisma.stockMovements.findMany({
      take: 40,
      orderBy: { MovementID: 'desc' }
    });

    const enriched = await Promise.all(
      movements.map(async (m) => {
        const variant = await prisma.variants.findUnique({ where: { VariantID: m.VariantID } });
        const prod = variant ? await prisma.products.findUnique({ where: { ProductID: variant.ProductID } }) : null;
        return {
          movementId: m.MovementID,
          type: m.Type,
          transferNo: m.TransferNo,
          productName: prod?.ProductName || `Item #${m.VariantID}`,
          fromShelf: m.FromShelf,
          toShelf: m.ToShelf,
          qty: m.Qty,
          status: m.Status,
          sealNo: m.SealNo,
          transporter: m.Transporter,
          vehicleNo: m.VehicleNo,
          date: m.Date,
          operator: m.CreatedByName
        };
      })
    );

    res.json({ success: true, history: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
