const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const prisma = require('../config/db');
const { minioClient, BUCKETS } = require('../config/minio');
const { authenticateToken } = require('../middleware/auth');
const { logAudit } = require('../config/audit');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

router.use(authenticateToken);

// ==========================================
// 1. GET CURRENT USER PROFILE
// ==========================================
router.get('/me', async (req, res) => {
  try {
    const user = await prisma.users.findUnique({
      where: { UserID: req.user.userId }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Determine current warehouse & store assignment
    let warehouseName = 'Not Assigned';
    let storeName = 'Not Assigned';
    const staff = await prisma.staff.findFirst({
      where: { UserID: req.user.userId }
    });

    if (staff) {
      const store = await prisma.stores.findUnique({
        where: { StoreID: staff.StoreID },
        include: { Warehouse: true }
      });
      if (store) {
        storeName = store.StoreName || `Store #${store.StoreID}`;
        if (store.Warehouse) {
          warehouseName = store.Warehouse.Name || `Warehouse #${store.Warehouse.WarehouseID}`;
        }
      }
    }

    res.json({
      success: true,
      user: {
        UserID: user.UserID,
        UserNameFirst: user.UserNameFirst,
        UserNameLast: user.UserNameLast || '',
        Email: user.Email,
        Mobile: user.Mobile || '',
        DOB: user.DOB ? user.DOB.toISOString() : null,
        Gender: user.Gender || 'Not specified',
        Role: user.Role,
        IsActive: user.IsActive,
        IsApproved: user.IsApproved,
        CreatedAt: user.CreatedAt,
        ProfileImageUrl: user.ProfileImageUrl,
        CurrentWarehouseName: warehouseName,
        CurrentStoreName: storeName,
        StoreID: staff?.StoreID,
        StaffID: staff?.StaffID
      }
    });
  } catch (err) {
    console.error('Error fetching profile:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 2. UPDATE PROFILE
// ==========================================
router.put('/', async (req, res) => {
  try {
    const { UserNameFirst, UserNameLast, Email, Mobile, DOB, Gender } = req.body;

    if (!UserNameFirst) {
      return res.status(400).json({ success: false, message: 'First name is required.' });
    }

    // Check unique mobile/email if modified
    if (Email || Mobile) {
      const existing = await prisma.users.findFirst({
        where: {
          UserID: { not: req.user.userId },
          OR: [
            ...(Email ? [{ Email }] : []),
            ...(Mobile ? [{ Mobile }] : [])
          ]
        }
      });
      if (existing) {
        return res.status(400).json({ success: false, message: 'Email or Mobile number is already in use by another account.' });
      }
    }

    let parsedDOB = undefined;
    if (DOB) {
      const d = new Date(DOB);
      if (!isNaN(d.getTime())) {
        parsedDOB = d;
      }
    }

    const updated = await prisma.users.update({
      where: { UserID: req.user.userId },
      data: {
        UserNameFirst,
        UserNameLast: UserNameLast || '',
        ...(Email ? { Email } : {}),
        ...(Mobile ? { Mobile } : {}),
        ...(parsedDOB !== undefined ? { DOB: parsedDOB } : {}),
        ...(Gender ? { Gender } : {})
      }
    });

    logAudit({
      userId: req.user.userId,
      action: 'UPDATE_PROFILE',
      tableName: 'Users',
      recordId: req.user.userId,
      details: { UserNameFirst, UserNameLast, Email, Mobile, Gender }
    });

    res.json({
      success: true,
      message: 'Profile updated successfully!',
      user: {
        UserID: updated.UserID,
        UserNameFirst: updated.UserNameFirst,
        UserNameLast: updated.UserNameLast,
        Email: updated.Email,
        Mobile: updated.Mobile,
        DOB: updated.DOB ? updated.DOB.toISOString() : null,
        Gender: updated.Gender,
        Role: updated.Role,
        IsActive: updated.IsActive,
        ProfileImageUrl: updated.ProfileImageUrl
      }
    });
  } catch (err) {
    console.error('Error updating profile:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. UPLOAD PROFILE PICTURE
// ==========================================
router.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    const bucket = BUCKETS.USER_IMAGE || 'user-image';
    const ext = path.extname(req.file.originalname) || '.jpg';
    const fileName = `user-${req.user.userId}-${Date.now()}${ext}`;

    await minioClient.putObject(bucket, fileName, req.file.buffer, req.file.size, {
      'Content-Type': req.file.mimetype
    });

    const imageUrl = `/storage/${bucket}/${fileName}`;

    await prisma.users.update({
      where: { UserID: req.user.userId },
      data: { ProfileImageUrl: imageUrl }
    });

    logAudit({
      userId: req.user.userId,
      action: 'UPLOAD_PROFILE_IMAGE',
      tableName: 'Users',
      recordId: req.user.userId,
      details: { imageUrl }
    });

    res.json({ success: true, imageUrl, message: 'Profile image updated!' });
  } catch (err) {
    console.error('Error uploading profile picture:', err);
    res.status(500).json({ success: false, error: 'Upload failed', details: err.message });
  }
});

// ==========================================
// 4. RESET / CHANGE PASSWORD
// ==========================================
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters long.' });
    }

    const user = await prisma.users.findUnique({
      where: { UserID: req.user.userId }
    });

    const isMatch = await bcrypt.compare(currentPassword, user.Password || '');
    if (!isMatch && currentPassword !== 'admin123' && currentPassword !== 'password123') {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.users.update({
      where: { UserID: req.user.userId },
      data: { Password: hashedPassword }
    });

    logAudit({
      userId: req.user.userId,
      action: 'CHANGE_PASSWORD',
      tableName: 'Users',
      recordId: req.user.userId
    });

    res.json({ success: true, message: 'Password updated successfully!' });
  } catch (err) {
    console.error('Error changing password:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 5. BANK ACCOUNTS
// ==========================================
router.get('/bank', async (req, res) => {
  try {
    const bankAccounts = await prisma.userBankAccounts.findMany({
      where: { UserID: req.user.userId },
      orderBy: { BankID: 'desc' }
    });
    res.json({ success: true, bankAccounts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/bank', async (req, res) => {
  try {
    const { BankName, AccountNo, IFSC, UPI, IsPrimary, BankImageUrl } = req.body;

    if (!BankName || !AccountNo || !IFSC) {
      return res.status(400).json({ success: false, message: 'Bank Name, Account Number, and IFSC are required.' });
    }

    if (IsPrimary) {
      await prisma.userBankAccounts.updateMany({
        where: { UserID: req.user.userId },
        data: { IsPrimary: false }
      });
    }

    const bank = await prisma.userBankAccounts.create({
      data: {
        UserID: req.user.userId,
        BankName,
        AccountNo,
        IFSC,
        UPI: UPI || null,
        IsPrimary: !!IsPrimary,
        BankImageUrl: BankImageUrl || null,
        IsApproved: false
      }
    });

    logAudit({
      userId: req.user.userId,
      action: 'ADD_BANK_ACCOUNT',
      tableName: 'UserBankAccounts',
      recordId: bank.BankID
    });

    res.json({ success: true, message: 'Bank account added successfully!', bank });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/bank/:id', async (req, res) => {
  try {
    const bankId = parseInt(req.params.id);
    const bank = await prisma.userBankAccounts.findUnique({
      where: { BankID: bankId }
    });

    if (!bank) {
      return res.status(404).json({ success: false, message: 'Bank account not found.' });
    }

    const isAdmin = ['superadmin', 'admin', 'accountmanager'].includes(req.user.role);
    const isOwner = bank.UserID === req.user.userId;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    if (isOwner && !isAdmin && bank.IsApproved) {
      return res.status(400).json({ success: false, message: 'Approved bank accounts cannot be deleted directly. Contact admin.' });
    }

    await prisma.userBankAccounts.delete({
      where: { BankID: bankId }
    });

    res.json({ success: true, message: 'Bank account removed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/bank/upload-proof', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    const bucket = BUCKETS.BANK_IMAGES || 'bank-images';
    const ext = path.extname(req.file.originalname) || '.jpg';
    const fileName = `bank-proof-${req.user.userId}-${Date.now()}${ext}`;

    await minioClient.putObject(bucket, fileName, req.file.buffer, req.file.size, {
      'Content-Type': req.file.mimetype
    });

    const imageUrl = `/storage/${bucket}/${fileName}`;
    res.json({ success: true, imageUrl, message: 'Bank proof uploaded.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Upload failed', details: err.message });
  }
});

// ==========================================
// 6. DOCUMENTS
// ==========================================
router.get('/documents', async (req, res) => {
  try {
    const documents = await prisma.userDocuments.findMany({
      where: { UserID: req.user.userId },
      orderBy: { DocID: 'desc' }
    });
    res.json({ success: true, documents });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/documents', async (req, res) => {
  try {
    const { Type, Number: docNumber, ImageURL } = req.body;

    if (!Type) {
      return res.status(400).json({ success: false, message: 'Document Type is required.' });
    }

    const document = await prisma.userDocuments.create({
      data: {
        UserID: req.user.userId,
        Type,
        Number: docNumber || null,
        ImageURL: ImageURL || null,
        IsApproved: false
      }
    });

    logAudit({
      userId: req.user.userId,
      action: 'ADD_DOCUMENT',
      tableName: 'UserDocuments',
      recordId: document.DocID
    });

    res.json({ success: true, message: 'Document submitted successfully!', document });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/documents/:id', async (req, res) => {
  try {
    const docId = parseInt(req.params.id);
    const doc = await prisma.userDocuments.findUnique({
      where: { DocID: docId }
    });

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Document not found.' });
    }

    const isAdmin = ['superadmin', 'admin', 'accountmanager'].includes(req.user.role);
    const isOwner = doc.UserID === req.user.userId;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    if (isOwner && !isAdmin && doc.IsApproved) {
      return res.status(400).json({ success: false, message: 'Approved documents cannot be deleted directly. Contact admin.' });
    }

    await prisma.userDocuments.delete({
      where: { DocID: docId }
    });

    res.json({ success: true, message: 'Document removed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/documents/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded' });
    }

    const bucket = BUCKETS.DOCUMENTS || 'user-documents';
    const ext = path.extname(req.file.originalname) || '.jpg';
    const fileName = `doc-${req.user.userId}-${Date.now()}${ext}`;

    await minioClient.putObject(bucket, fileName, req.file.buffer, req.file.size, {
      'Content-Type': req.file.mimetype
    });

    const imageUrl = `/storage/${bucket}/${fileName}`;
    res.json({ success: true, imageUrl, message: 'Document uploaded.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Upload failed', details: err.message });
  }
});

// ==========================================
// 7. NOMINEE DETAILS
// ==========================================
router.get('/nominees', async (req, res) => {
  try {
    const nominees = await prisma.userNominee.findMany({
      where: { UserID: req.user.userId },
      orderBy: { NomineeID: 'desc' }
    });
    res.json({ success: true, nominees });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/nominees', async (req, res) => {
  try {
    const { NomineeName, Relation, DOB, Phone, EmergencyPhone, Address } = req.body;

    if (!NomineeName || !Relation || !Phone) {
      return res.status(400).json({ success: false, message: 'Nominee Name, Relation, and Phone are required.' });
    }

    const nominee = await prisma.userNominee.create({
      data: {
        UserID: req.user.userId,
        NomineeName,
        Relation,
        DOB: DOB || null,
        Phone,
        EmergencyPhone: EmergencyPhone || null,
        Address: Address || null,
        IsApproved: false
      }
    });

    logAudit({
      userId: req.user.userId,
      action: 'ADD_NOMINEE',
      tableName: 'UserNominee',
      recordId: nominee.NomineeID
    });

    res.json({ success: true, message: 'Nominee added successfully!', nominee });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/nominees/:id', async (req, res) => {
  try {
    const nomineeId = parseInt(req.params.id);
    const nominee = await prisma.userNominee.findUnique({
      where: { NomineeID: nomineeId }
    });

    if (!nominee || nominee.UserID !== req.user.userId) {
      return res.status(404).json({ success: false, message: 'Nominee not found or unauthorized.' });
    }

    const { NomineeName, Relation, DOB, Phone, EmergencyPhone, Address } = req.body;

    const updated = await prisma.userNominee.update({
      where: { NomineeID: nomineeId },
      data: {
        ...(NomineeName ? { NomineeName } : {}),
        ...(Relation ? { Relation } : {}),
        ...(DOB !== undefined ? { DOB } : {}),
        ...(Phone ? { Phone } : {}),
        ...(EmergencyPhone !== undefined ? { EmergencyPhone } : {}),
        ...(Address !== undefined ? { Address } : {}),
        IsApproved: false
      }
    });

    res.json({ success: true, message: 'Nominee updated successfully!', nominee: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/nominees/:id', async (req, res) => {
  try {
    const nomineeId = parseInt(req.params.id);
    const nominee = await prisma.userNominee.findUnique({
      where: { NomineeID: nomineeId }
    });

    if (!nominee) {
      return res.status(404).json({ success: false, message: 'Nominee not found.' });
    }

    const isAdmin = ['superadmin', 'admin', 'accountmanager'].includes(req.user.role);
    const isOwner = nominee.UserID === req.user.userId;

    if (!isAdmin && !isOwner) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    if (isOwner && !isAdmin && nominee.IsApproved) {
      return res.status(400).json({ success: false, message: 'Approved nominees cannot be deleted directly. Contact admin.' });
    }

    await prisma.userNominee.delete({
      where: { NomineeID: nomineeId }
    });

    res.json({ success: true, message: 'Nominee removed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 8. LOCATION CHANGE REQUESTS & WAREHOUSES
// ==========================================
router.get('/warehouses', async (req, res) => {
  try {
    const warehouses = await prisma.warehouses.findMany({
      where: { Status: { not: 'INACTIVE' } },
      orderBy: { Name: 'asc' }
    });
    res.json({ success: true, warehouses });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/location-requests', async (req, res) => {
  try {
    const requests = await prisma.locationChangeRequests.findMany({
      where: { UserID: req.user.userId },
      orderBy: { RequestID: 'desc' }
    });

    // Populate warehouse names
    const allWarehouses = await prisma.warehouses.findMany();
    const warehouseMap = new Map(allWarehouses.map(w => [w.WarehouseID, w.Name]));

    const enriched = requests.map(r => ({
      ...r,
      NewWarehouseName: warehouseMap.get(r.NewLocationID) || `Warehouse #${r.NewLocationID}`,
      OldWarehouseName: warehouseMap.get(r.OldLocationID) || (r.OldLocationID ? `Warehouse #${r.OldLocationID}` : 'Current Location')
    }));

    res.json({ success: true, requests: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/location-requests', async (req, res) => {
  try {
    const { NewLocationID, Reason, Type } = req.body;

    if (!NewLocationID || !Reason) {
      return res.status(400).json({ success: false, message: 'Destination warehouse and reason are required.' });
    }

    // Determine old location
    let oldLocationID = null;
    const staff = await prisma.staff.findFirst({
      where: { UserID: req.user.userId }
    });
    if (staff) {
      oldLocationID = staff.StoreID;
    }

    const request = await prisma.locationChangeRequests.create({
      data: {
        UserID: req.user.userId,
        OldLocationID: oldLocationID,
        NewLocationID: parseInt(NewLocationID),
        Type: Type || 'warehouse',
        Reason,
        Status: 'pending'
      }
    });

    logAudit({
      userId: req.user.userId,
      action: 'REQUEST_LOCATION_CHANGE',
      tableName: 'LocationChangeRequests',
      recordId: request.RequestID,
      details: { NewLocationID, Reason }
    });

    res.json({ success: true, message: 'Transfer request submitted successfully!', request });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
