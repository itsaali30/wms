const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { authenticateToken, requireRoles } = require('../middleware/auth');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');
const { emitToRole } = require('../services/socket.service');

router.use(authenticateToken);
router.use(requireRoles('packer', 'sorter', 'manager', 'superadmin', 'admin'));

// 1. Get orders waiting for packing
router.get('/orders-to-pack', async (req, res) => {
  try {
    const orders = await prisma.orders.findMany({
      where: {
        Status: { in: ['READY_FOR_PACKING', 'PICKED'] }
      },
      orderBy: { OrderID: 'asc' },
      take: 20
    });

    const enrichedOrders = await Promise.all(
      orders.map(async (o) => {
        const orderItems = await prisma.orderItems.findMany({
          where: { OrderID: o.OrderID }
        });

        const itemsWithDetails = await Promise.all(
          orderItems.map(async (item) => {
            const variant = await prisma.variants.findUnique({
              where: { VariantID: item.VariantID }
            });
            const product = variant ? await prisma.products.findUnique({
              where: { ProductID: variant.ProductID }
            }) : null;

            return {
              orderItemId: item.OrderItemID,
              variantId: item.VariantID,
              productName: product?.ProductName || 'Item',
              sku: variant?.SKU || `SKU-${item.VariantID}`,
              barcode: variant?.SKU || `BARCODE-${item.VariantID}`,
              qty: item.Qty || 1,
              weightKg: (variant?.Weight || 0.5)
            };
          })
        );

        const expectedWeightKg = itemsWithDetails.reduce((sum, i) => sum + (i.weightKg * i.qty), 0);

        return {
          orderId: o.OrderID,
          status: o.Status,
          createdAt: o.CreatedAt,
          items: itemsWithDetails,
          totalQty: itemsWithDetails.reduce((sum, i) => sum + i.qty, 0),
          expectedWeightKg: parseFloat(expectedWeightKg.toFixed(2)),
          suggestedBag: expectedWeightKg > 4 ? 'HEAVY_DUTY_LARGE_CRATE' : 'STANDARD_ECO_CARRYBAG'
        };
      })
    );

    res.json({ success: true, orders: enrichedOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Packing Table - Verify Item by scanning
router.post('/verify-item', async (req, res) => {
  try {
    const { orderId, scannedBarcode } = req.body;
    if (!orderId || !scannedBarcode) {
      return res.status(400).json({ success: false, message: 'Order ID and barcode are required.' });
    }

    const orderItems = await prisma.orderItems.findMany({
      where: { OrderID: Number(orderId) }
    });

    // Check if scanned barcode matches any variant in this order
    let matchedItem = null;
    for (const item of orderItems) {
      const variant = await prisma.variants.findUnique({
        where: { VariantID: item.VariantID }
      });
      const validCodes = [
        (variant?.SKU || '').toLowerCase(),
        `barcode-${item.VariantID}`.toLowerCase(),
        `sku-${item.VariantID}`.toLowerCase()
      ];
      if (validCodes.includes(scannedBarcode.trim().toLowerCase()) || scannedBarcode === String(variant?.VariantID)) {
        matchedItem = { item, variant };
        break;
      }
    }

    if (!matchedItem) {
      return res.status(400).json({
        success: false,
        matched: false,
        message: `❌ Wrong Item! Barcode '${scannedBarcode}' does not belong to Order #${orderId}!`
      });
    }

    res.json({
      success: true,
      matched: true,
      variantId: matchedItem.variant.VariantID,
      sku: matchedItem.variant.SKU,
      message: `✅ Verified: ${matchedItem.variant.SKU} tallied on packing table.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Seal Bag & Handover to Delivery Rider Bay
router.post('/seal-bag', async (req, res) => {
  try {
    const { orderId, sealBarcode, actualWeightKg, handoverBay, bagType } = req.body;
    if (!orderId || !sealBarcode) {
      return res.status(400).json({ success: false, message: 'Order ID and Bag Seal barcode are required.' });
    }

    const order = await prisma.orders.findUnique({
      where: { OrderID: Number(orderId) }
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Update order status to DISPATCH_READY
    await prisma.orders.update({
      where: { OrderID: order.OrderID },
      data: { Status: 'DISPATCH_READY' }
    });

    // Update PackingLists record
    const packList = await prisma.packingLists.findFirst({
      where: { OrderID: order.OrderID }
    });

    if (packList) {
      await prisma.packingLists.update({
        where: { PackID: packList.PackID },
        data: {
          Status: 'SEALED_AND_HANDOVER',
          PackedAt: new Date()
        }
      });
    }

    const targetBay = handoverBay || 'BAY-DISPATCH-01';

    // Log audit & Kafka
    await logAudit({
      userId: req.user.userId,
      action: 'SEAL_AND_HANDOVER',
      tableName: 'PackingLists',
      recordId: packList?.PackID || order.OrderID,
      details: {
        orderId: order.OrderID,
        sealBarcode,
        actualWeightKg: Number(actualWeightKg) || 0,
        handoverBay: targetBay,
        bagType: bagType || 'CARRYBAG'
      }
    });

    await emitWarehouseEvent('wms.packing.dispatched', {
      orderId: order.OrderID,
      sealBarcode,
      handoverBay: targetBay,
      packerId: req.user.userId,
      summary: `Order #${order.OrderID} sealed [${sealBarcode}] and moved to ${targetBay}`
    });

    // Notify Rider and Manager
    emitToRole('manager', 'wms:order_dispatch_ready', {
      orderId: order.OrderID,
      sealBarcode,
      bay: targetBay,
      packerName: req.user.name
    });

    res.json({
      success: true,
      message: `🎉 Order #${order.OrderID} sealed successfully! Bag Seal: [${sealBarcode}]. Placed at ${targetBay} for Rider pickup.`,
      dispatchReady: true,
      handoverBay: targetBay
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
