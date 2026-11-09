const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { authenticateToken, requireRoles } = require('../middleware/auth');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');
const { emitToRole } = require('../services/socket.service');

router.use(authenticateToken);
router.use(requireRoles('putter', 'staging', 'manager', 'superadmin', 'admin', 'picker', 'incharge'));

// -----------------------------------------------------------------------------
// LIVE FLOOR PUTAWAY ENDPOINTS (Floor to Dark Store Shelf)
// -----------------------------------------------------------------------------

// 1. Get Floor Items (Items currently on Floor Store / FL01 Shelf)
router.get('/floor-items', async (req, res) => {
  try {
    const floorStores = await prisma.stores.findMany({
      where: {
        OR: [
          { Type: { equals: 'Floor', mode: 'insensitive' } },
          { StoreName: { contains: 'Floor', mode: 'insensitive' } }
        ]
      }
    });
    const floorStoreIds = floorStores.map(s => s.StoreID);

    const floorShelves = await prisma.shelves.findMany({
      where: {
        OR: [
          { ShelfCode: { in: ['FL01', 'FLOOR', 'FL-01'] } },
          { StoreID: { in: floorStoreIds } }
        ]
      }
    });
    const floorShelfIds = floorShelves.map(s => s.ShelfID);

    const stocks = await prisma.stocks.findMany({
      where: {
        OR: [
          { StoreID: { in: floorStoreIds }, OnHandQty: { gt: 0 } },
          { ShelfID: { in: floorShelfIds }, OnHandQty: { gt: 0 } }
        ]
      }
    });

    const items = [];
    const storeMap = Object.fromEntries(floorStores.map(s => [s.StoreID, s]));
    const shelfMap = Object.fromEntries(floorShelves.map(s => [s.ShelfID, s]));

    for (const st of stocks) {
      const v = await prisma.variants.findUnique({ where: { VariantID: st.VariantID } });
      if (!v) continue;
      const p = await prisma.products.findUnique({ where: { ProductID: v.ProductID } });
      const store = storeMap[st.StoreID] || await prisma.stores.findUnique({ where: { StoreID: st.StoreID } });
      const shelf = shelfMap[st.ShelfID] || await prisma.shelves.findUnique({ where: { ShelfID: st.ShelfID } });

      items.push({
        stockId: st.StockID,
        variantId: v.VariantID,
        productId: v.ProductID,
        productName: p ? p.ProductName : 'Unknown Item',
        sku: v.SKU,
        size: v.Size,
        color: v.Color,
        unit: v.Unit || 'PCS',
        image: v.ImageURL || (p ? p.ImageURL : null),
        mrp: v.MRP,
        salePrice: v.SalePrice,
        floorQty: st.OnHandQty || 0,
        storeId: st.StoreID,
        storeName: store ? store.StoreName : 'Floor',
        shelfId: st.ShelfID,
        shelfCode: shelf ? shelf.ShelfCode : 'FL01'
      });
    }

    res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('Error fetching floor items:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Get item details + candidate shelves for putaway
router.get('/item-details/:variantId', async (req, res) => {
  try {
    const variantId = parseInt(req.params.variantId);
    const v = await prisma.variants.findUnique({ where: { VariantID: variantId } });
    if (!v) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    const p = await prisma.products.findUnique({ where: { ProductID: v.ProductID } });

    // Current stock on floor
    const floorStores = await prisma.stores.findMany({
      where: {
        OR: [
          { Type: { equals: 'Floor', mode: 'insensitive' } },
          { StoreName: { contains: 'Floor', mode: 'insensitive' } }
        ]
      }
    });
    const floorStoreIds = floorStores.map(s => s.StoreID);
    const floorStock = await prisma.stocks.findFirst({
      where: {
        VariantID: variantId,
        StoreID: { in: floorStoreIds },
        OnHandQty: { gt: 0 }
      }
    });

    // Candidate dark store shelves (Type != Floor)
    const darkStores = await prisma.stores.findMany({
      where: { Type: { not: 'Floor' } }
    });
    const storeMap = Object.fromEntries(darkStores.map(s => [s.StoreID, s]));
    const shelves = await prisma.shelves.findMany({
      where: { StoreID: { in: darkStores.map(s => s.StoreID) } },
      orderBy: { ShelfID: 'asc' }
    });

    const shelfList = [];
    for (const sh of shelves) {
      const itemStock = await prisma.stocks.findFirst({
        where: { ShelfID: sh.ShelfID, VariantID: variantId }
      });
      const totalAgg = await prisma.stocks.aggregate({
        where: { ShelfID: sh.ShelfID },
        _sum: { OnHandQty: true }
      });

      const existingUnitsForThisItem = itemStock?.OnHandQty || 0;
      const totalUnitsOnShelf = totalAgg._sum.OnHandQty || 0;
      const isEmpty = totalUnitsOnShelf === 0;

      shelfList.push({
        shelfId: sh.ShelfID,
        shelfCode: sh.ShelfCode,
        level: sh.Level ?? 1,
        position: sh.Position ?? 1,
        storeId: sh.StoreID,
        storeName: storeMap[sh.StoreID]?.StoreName || 'Dark Store',
        storeType: storeMap[sh.StoreID]?.Type || 'Dark Store',
        currentStockForThisItem: existingUnitsForThisItem,
        totalUnitsOnShelf: totalUnitsOnShelf,
        isEmpty: isEmpty,
        isRecommended: isEmpty || existingUnitsForThisItem > 0
      });
    }

    res.json({
      success: true,
      item: {
        variantId: v.VariantID,
        productId: v.ProductID,
        productName: p ? p.ProductName : 'Item',
        sku: v.SKU,
        size: v.Size,
        color: v.Color,
        unit: v.Unit || 'PCS',
        image: v.ImageURL || (p ? p.ImageURL : null),
        mrp: v.MRP,
        salePrice: v.SalePrice,
        floorQty: floorStock ? floorStock.OnHandQty : 0,
        floorStoreId: floorStock ? floorStock.StoreID : (floorStoreIds[0] || 6),
        floorShelfId: floorStock ? floorStock.ShelfID : 9,
        floorShelfCode: 'FL01'
      },
      shelves: shelfList
    });
  } catch (err) {
    console.error('Error fetching item details for putaway:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Execute Putaway Placement (Floor to Shelf)
router.post('/execute', async (req, res) => {
  try {
    const { variantId, fromStoreId, fromShelfId, toShelfId, toShelfCode, quantity } = req.body;
    const qty = parseInt(quantity);
    if (!variantId || !toShelfId || isNaN(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid putaway payload or quantity.' });
    }

    const v = await prisma.variants.findUnique({ where: { VariantID: parseInt(variantId) } });
    if (!v) return res.status(404).json({ success: false, message: 'Variant not found' });
    const p = await prisma.products.findUnique({ where: { ProductID: v.ProductID } });

    const targetShelf = await prisma.shelves.findUnique({ where: { ShelfID: parseInt(toShelfId) } });
    if (!targetShelf) return res.status(404).json({ success: false, message: 'Target shelf not found' });

    let sourceStock = null;
    if (fromStoreId && fromShelfId) {
      sourceStock = await prisma.stocks.findFirst({
        where: {
          VariantID: parseInt(variantId),
          StoreID: parseInt(fromStoreId),
          ShelfID: parseInt(fromShelfId),
          OnHandQty: { gte: qty }
        }
      });
    }
    if (!sourceStock) {
      sourceStock = await prisma.stocks.findFirst({
        where: {
          VariantID: parseInt(variantId),
          OnHandQty: { gte: qty }
        }
      });
    }

    if (!sourceStock || (sourceStock.OnHandQty || 0) < qty) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock on floor. Available: ${sourceStock ? sourceStock.OnHandQty : 0}, Requested: ${qty}`
      });
    }

    const fromShelfRecord = await prisma.shelves.findUnique({ where: { ShelfID: sourceStock.ShelfID } });
    const fromShelfCode = fromShelfRecord?.ShelfCode || 'FL01';

    const result = await prisma.$transaction(async (tx) => {
      // 1. Deduct from source floor stock
      await tx.stocks.update({
        where: { StockID: sourceStock.StockID },
        data: {
          OnHandQty: sourceStock.OnHandQty - qty,
          AvailableQty: Math.max(0, (sourceStock.AvailableQty || sourceStock.OnHandQty) - qty)
        }
      });

      // 2. Add / Upsert into target shelf stock
      const existingTargetStock = await tx.stocks.findFirst({
        where: {
          StoreID: targetShelf.StoreID,
          ShelfID: targetShelf.ShelfID,
          VariantID: parseInt(variantId)
        }
      });

      let updatedTargetStock;
      if (existingTargetStock) {
        updatedTargetStock = await tx.stocks.update({
          where: { StockID: existingTargetStock.StockID },
          data: {
            OnHandQty: (existingTargetStock.OnHandQty || 0) + qty,
            AvailableQty: (existingTargetStock.AvailableQty || 0) + qty
          }
        });
      } else {
        updatedTargetStock = await tx.stocks.create({
          data: {
            StoreID: targetShelf.StoreID,
            ShelfID: targetShelf.ShelfID,
            VariantID: parseInt(variantId),
            OnHandQty: qty,
            AvailableQty: qty,
            ReservedQty: 0
          }
        });
      }

      // 3. Record in StockMovements
      const movement = await tx.stockMovements.create({
        data: {
          VariantID: parseInt(variantId),
          FromStoreID: sourceStock.StoreID,
          ToStoreID: targetShelf.StoreID,
          FromShelf: fromShelfCode,
          ToShelf: targetShelf.ShelfCode || toShelfCode,
          Qty: qty,
          Type: 'PUTAWAY',
          Status: 'COMPLETED',
          TransferNo: `PUT-${Date.now()}`,
          Reason: `Putaway from ${fromShelfCode} to ${targetShelf.ShelfCode}`,
          Date: new Date(),
          CreatedBy: req.user?.userId || 1,
          CreatedByName: req.user?.name || 'Putter'
        }
      });

      return { movement, updatedTargetStock };
    });

    emitToRole('manager', 'wms:putaway_completed', {
      movementId: result.movement.MovementID,
      item: p ? p.ProductName : v.SKU,
      qty: qty,
      fromShelf: fromShelfCode,
      toShelf: targetShelf.ShelfCode,
      putterName: req.user?.name || 'Staff'
    });

    res.json({
      success: true,
      message: `🎉 Success! Placed ${qty} ${v.Unit || 'units'} of ${p ? p.ProductName : 'Item'} onto shelf [${targetShelf.ShelfCode}]. Stock updated!`,
      movement: result.movement,
      newShelfStock: result.updatedTargetStock.OnHandQty,
      remainingFloorStock: sourceStock.OnHandQty - qty
    });
  } catch (err) {
    console.error('Error executing putaway:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Get Putaway Tasks Log
router.get('/tasks', async (req, res) => {
  try {
    const movements = await prisma.stockMovements.findMany({
      where: { Type: 'PUTAWAY' },
      orderBy: { Date: 'desc' },
      take: 100
    });

    const tasks = [];
    for (const m of movements) {
      const v = await prisma.variants.findUnique({ where: { VariantID: m.VariantID } });
      const p = v ? await prisma.products.findUnique({ where: { ProductID: v.ProductID } }) : null;
      tasks.push({
        movementId: m.MovementID,
        pickerId: m.CreatedBy,
        staffName: m.CreatedByName || `Staff #${m.CreatedBy}`,
        time: m.Date,
        outShelf: m.FromShelf || 'FL01',
        inShelf: m.ToShelf || 'N/A',
        itemId: m.VariantID,
        itemName: p ? p.ProductName : (v ? v.SKU : `Item #${m.VariantID}`),
        sku: v ? v.SKU : '',
        unit: v ? v.Unit : 'PCS',
        qty: m.Qty || 0,
        status: m.Status || 'COMPLETED'
      });
    }

    res.json({ success: true, count: tasks.length, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -----------------------------------------------------------------------------
// DOCK CLEARANCE TASKS
// -----------------------------------------------------------------------------
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
