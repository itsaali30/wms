const express = require('express');
const router = express.Router();
const multer = require('multer');
const prisma = require('../config/db');
const { authenticateToken, requireRoles } = require('../middleware/auth');
const { minioClient, BUCKETS } = require('../config/minio');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');
const { emitToRole } = require('../services/socket.service');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(authenticateToken);
router.use(requireRoles('inward', 'receiving', 'manager', 'superadmin', 'admin'));

// 1. Get incoming/active Purchase Orders
router.get('/purchase-orders', async (req, res) => {
  try {
    const pos = [
      {
        poNumber: 'PO-2026-0091',
        supplierName: 'Amul Dairy Products Ltd',
        truckNumber: 'DL-01-AB-4052',
        expectedCartons: 50,
        expectedUnits: 600,
        driverContact: '+91 98765 43210',
        arrivalDate: '2026-11-02',
        status: 'ARRIVED_AT_DOCK'
      },
      {
        poNumber: 'PO-2026-0092',
        supplierName: 'PepsiCo India Holdings',
        truckNumber: 'MH-04-CP-8819',
        expectedCartons: 80,
        expectedUnits: 1600,
        driverContact: '+91 98220 11223',
        arrivalDate: '2026-11-02',
        status: 'UNLOADING'
      },
      {
        poNumber: 'PO-2026-0093',
        supplierName: 'Hindustan Unilever Goods',
        truckNumber: 'KA-05-MN-3341',
        expectedCartons: 40,
        expectedUnits: 480,
        driverContact: '+91 99001 55667',
        arrivalDate: '2026-11-02',
        status: 'SCHEDULED'
      }
    ];

    res.json({ success: true, purchaseOrders: pos });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Unload & Quality Check (Physical Count vs PO)
router.post('/receive-po', async (req, res) => {
  try {
    const { poNumber, truckNumber, receivedCartons, expectedCartons, remarks } = req.body;
    if (!poNumber || !receivedCartons) {
      return res.status(400).json({ success: false, message: 'PO Number and received cartons are required.' });
    }

    const recCount = Number(receivedCartons);
    const expCount = Number(expectedCartons) || recCount;
    const isShortage = recCount < expCount;
    const isExcess = recCount > expCount;

    let checkStatus = 'VERIFIED_OK';
    if (isShortage) checkStatus = 'SHORTAGE_REPORTED';
    if (isExcess) checkStatus = 'EXCESS_REPORTED';

    await logAudit({
      userId: req.user.userId,
      action: 'PO_RECEIVING_UNLOAD',
      tableName: 'PurchaseOrders',
      recordId: 0,
      details: {
        poNumber,
        truckNumber,
        receivedCartons: recCount,
        expectedCartons: expCount,
        checkStatus,
        remarks
      }
    });

    await emitWarehouseEvent('wms.inward.received', {
      poNumber,
      truckNumber,
      receivedCartons: recCount,
      checkStatus,
      receiverId: req.user.userId,
      summary: `Truck ${truckNumber} unloaded for PO ${poNumber}. Status: ${checkStatus}`
    });

    res.json({
      success: true,
      checkStatus,
      difference: recCount - expCount,
      message: `✅ PO ${poNumber} unloaded. Received ${recCount}/${expCount} cartons. Status: ${checkStatus}.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Damaged / Leakage Flagging with MinIO Photo Upload
router.post('/flag-damage', upload.single('damagePhoto'), async (req, res) => {
  try {
    const { poNumber, sku, quantity, damageType, remarks } = req.body;
    if (!poNumber || !sku || !quantity) {
      return res.status(400).json({ success: false, message: 'PO, SKU, and Quantity are required.' });
    }

    let photoUrl = null;
    if (req.file) {
      const fileName = `damage_${Date.now()}_${sku.replace(/[^a-zA-Z0-9]/g, '_')}.jpg`;
      await minioClient.putObject(
        BUCKETS.DAMAGES,
        fileName,
        req.file.buffer,
        req.file.size,
        { 'Content-Type': req.file.mimetype }
      );
      photoUrl = `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}/${BUCKETS.DAMAGES}/${fileName}`;
    }

    const ticketId = `DISC-${Date.now().toString().slice(-6)}`;

    // Log to AuditLogs
    await logAudit({
      userId: req.user.userId,
      action: 'DAMAGE_FLAGGED',
      tableName: 'Discrepancies',
      recordId: 0,
      details: {
        ticketId,
        poNumber,
        sku,
        quantity: Number(quantity),
        damageType: damageType || 'LEAKAGE',
        photoUrl,
        remarks,
        reportedBy: req.user.name
      }
    });

    // Alert manager in real-time
    emitToRole('manager', 'wms:discrepancy_reported', {
      ticketId,
      poNumber,
      sku,
      quantity,
      damageType: damageType || 'DAMAGED_CRATE',
      photoUrl,
      reporterName: req.user.name,
      reportedAt: new Date().toLocaleTimeString()
    });

    await emitWarehouseEvent('wms.inward.damage_flagged', {
      ticketId,
      poNumber,
      sku,
      quantity,
      photoUrl,
      summary: `Damage ticket #${ticketId} created by ${req.user.name} for PO ${poNumber}`
    });

    res.json({
      success: true,
      ticketId,
      photoUrl,
      message: `⚠️ Damage Reported! Ticket #${ticketId} submitted to Warehouse Manager for approval.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Staging Tagging (Generate Pallet / Staging slip)
router.post('/generate-pallet-tag', async (req, res) => {
  try {
    const { poNumber, sku, quantity, stagingBay } = req.body;
    const palletId = `PALLET-INW-${Date.now().toString().slice(-6)}`;
    const barcode = `BAR-${palletId}`;

    const palletTag = {
      palletId,
      barcode,
      poNumber: poNumber || 'PO-2026-GEN',
      sku: sku || 'VARIOUS',
      quantity: Number(quantity) || 50,
      stagingBay: stagingBay || 'STAGING-BAY-01',
      generatedAt: new Date().toLocaleString(),
      generatedBy: req.user.name
    };

    await logAudit({
      userId: req.user.userId,
      action: 'GENERATE_PALLET_TAG',
      tableName: 'StagingTags',
      recordId: 0,
      details: palletTag
    });

    res.json({
      success: true,
      palletTag,
      message: `🏷️ Pallet Tag [${palletId}] generated successfully. Paste slip on crate/pallet.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
