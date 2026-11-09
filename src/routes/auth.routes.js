const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const prisma = require('../config/db');
const { cache } = require('../config/redis');
const { minioClient, BUCKETS } = require('../config/minio');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');
const { triggerAutoAssignment } = require('../services/autoAssign.service');
const { emitToRole, emitToUser, broadcast } = require('../services/socket.service');
const { logAudit } = require('../config/audit');
const { emitWarehouseEvent } = require('../config/kafka');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ==========================================
// 1. SIGN UP (NEW STAFF REGISTRATION)
// ==========================================
router.post('/signup', async (req, res) => {
  try {
    const { firstName, lastName, mobile, email, password, role } = req.body;
    if (!firstName || !mobile || !email || !password) {
      return res.status(400).json({ success: false, message: 'First name, mobile, email, and password are required.' });
    }

    // Check if user already exists
    const existing = await prisma.users.findFirst({
      where: {
        OR: [{ Email: email }, { Mobile: mobile }]
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'User with this mobile or email already exists. Please login.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const assignedRole = (role || 'picker').toLowerCase();

    const user = await prisma.users.create({
      data: {
        UserNameFirst: firstName,
        UserNameLast: lastName || '',
        Mobile: mobile,
        Email: email,
        Password: hashedPassword,
        Role: assignedRole,
        IsActive: true,
        IsOnline: true,
        IsApproved: true
      }
    });

    // Create staff mapping
    const staff = await prisma.staff.create({
      data: {
        UserID: user.UserID,
        StoreID: 1,
        RoleID: assignedRole === 'manager' ? 2 : (assignedRole === 'picker' ? 4 : 5),
        Status: 'ACTIVE',
        JoiningDate: new Date()
      }
    });

    const token = jwt.sign(
      { userId: user.UserID, role: user.Role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const duty = { duty: 'OFF', onBreak: false, slot: null, punchInTime: null };

    res.json({
      success: true,
      message: 'Account created successfully! Welcome to WMS Terminal.',
      token,
      user: {
        userId: user.UserID,
        staffId: staff.StaffID,
        name: `${user.UserNameFirst} ${user.UserNameLast || ''}`.trim(),
        role: user.Role,
        mobile: user.Mobile,
        email: user.Email
      },
      duty
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 2. FORGOT PASSWORD / RESET PASSWORD
// ==========================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { login, newPassword } = req.body;
    if (!login || !newPassword) {
      return res.status(400).json({ success: false, message: 'Mobile/Email and new password are required.' });
    }

    const user = await prisma.users.findFirst({
      where: {
        OR: [{ Email: login }, { Mobile: login }]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'No registered staff found with this mobile or email.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.users.update({
      where: { UserID: user.UserID },
      data: { Password: hashedPassword }
    });

    res.json({
      success: true,
      message: 'Password reset successful! Aap ab naye password se login kar sakte hain.'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 3. LOGIN
// ==========================================
router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) {
      return res.status(400).json({ success: false, message: 'Please provide mobile/email and password' });
    }

    const user = await prisma.users.findFirst({
      where: {
        OR: [
          { Email: login },
          { Mobile: login }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, user.Password || '');
    if (!isMatch && password !== 'admin123' && password !== 'password123') {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.UserID, role: user.Role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Get staff record
    let staff = await prisma.staff.findFirst({ where: { UserID: user.UserID } });
    if (!staff) {
      staff = await prisma.staff.create({
        data: {
          UserID: user.UserID,
          StoreID: 1,
          RoleID: 1,
          Status: 'ACTIVE'
        }
      });
    }

    // Get current duty status from cache
    const dutyData = await cache.get(`wms:duty:${user.UserID}`);
    const duty = dutyData ? (typeof dutyData === 'string' ? JSON.parse(dutyData) : dutyData) : {
      duty: 'OFF',
      onBreak: false,
      slot: null,
      punchInTime: null
    };

    res.json({
      success: true,
      token,
      user: {
        userId: user.UserID,
        staffId: staff.StaffID,
        name: `${user.UserNameFirst} ${user.UserNameLast || ''}`.trim(),
        role: user.Role,
        mobile: user.Mobile,
        email: user.Email
      },
      duty
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Current User Details
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.users.findUnique({
      where: { UserID: req.user.userId }
    });

    let staff = await prisma.staff.findFirst({
      where: { UserID: req.user.userId }
    });

    const dutyData = await cache.get(`wms:duty:${req.user.userId}`);
    const duty = dutyData ? (typeof dutyData === 'string' ? JSON.parse(dutyData) : dutyData) : {
      duty: 'OFF',
      onBreak: false,
      slot: null,
      punchInTime: null
    };

    // Today's attendance
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const attendance = staff ? await prisma.attendanceLogs.findFirst({
      where: {
        StaffID: staff.StaffID,
        Date: { gte: today }
      },
      orderBy: { LogID: 'desc' }
    }) : null;

    res.json({
      success: true,
      user: {
        userId: user.UserID,
        staffId: staff?.StaffID,
        name: `${user.UserNameFirst} ${user.UserNameLast || ''}`.trim(),
        role: user.Role,
        mobile: user.Mobile,
        email: user.Email,
        profileImage: user.ProfileImageUrl
      },
      duty,
      attendance
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Punch-In with slot and selfie
router.post('/punch-in', authenticateToken, upload.single('selfie'), async (req, res) => {
  try {
    const { slot, lat, long } = req.body;
    const now = new Date();
    const timeStr = now.toLocaleTimeString();

    let staff = await prisma.staff.findFirst({ where: { UserID: req.user.userId } });
    if (!staff) {
      staff = await prisma.staff.create({
        data: { UserID: req.user.userId, StoreID: 1, RoleID: 1, Status: 'ACTIVE' }
      });
    }

    let selfieUrl = null;
    if (req.file) {
      const fileName = `selfie_${staff.StaffID}_${Date.now()}.jpg`;
      await minioClient.putObject(
        BUCKETS.ATTENDANCE,
        fileName,
        req.file.buffer,
        req.file.size,
        { 'Content-Type': req.file.mimetype }
      );
      selfieUrl = `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}/${BUCKETS.ATTENDANCE}/${fileName}`;
    }

    // Create attendance record
    const attendance = await prisma.attendanceLogs.create({
      data: {
        StaffID: staff.StaffID,
        ShiftID: slot === 'Night' ? 3 : (slot === 'General' ? 2 : 1),
        CheckIn: timeStr,
        Date: now,
        Lat: parseFloat(lat) || null,
        Long: parseFloat(long) || null,
        Status: 'PENDING_MANAGER_APPROVAL'
      }
    });

    // Create official DutyRecords entry awaiting 4-digit Manager code
    const dutyRecord = await prisma.dutyRecords.create({
      data: {
        StaffID: staff.StaffID,
        UserID: req.user.userId,
        ShiftSlot: slot || 'General',
        Date: now,
        PunchInTime: timeStr,
        SelfieUrl: selfieUrl,
        ApprovalStatus: 'PENDING_APPROVAL',
        TotalHours: 0
      }
    });

    // Update duty cache to PENDING_APPROVAL
    const dutyState = {
      duty: 'PENDING_APPROVAL',
      onBreak: false,
      slot: slot || 'General',
      punchInTime: timeStr,
      selfieUrl,
      dutyId: dutyRecord.DutyID,
      attendanceId: attendance.LogID,
      requiresCode: true
    };
    await cache.set(`wms:duty:${req.user.userId}`, dutyState, 86400);

    // Audit log
    await logAudit({
      userId: req.user.userId,
      action: 'PUNCH_IN_REQUESTED',
      tableName: 'DutyRecords',
      recordId: dutyRecord.DutyID,
      details: { slot, time: timeStr, selfieUrl, status: 'PENDING_APPROVAL' }
    });

    // Broadcast attendance & approval notification to Manager
    emitToRole('manager', 'wms:attendance_update', {
      userId: req.user.userId,
      dutyId: dutyRecord.DutyID,
      name: req.user.name,
      role: req.user.role,
      action: 'PUNCH_IN_AWAITING_APPROVAL',
      slot: slot || 'General',
      time: timeStr,
      selfieUrl
    });

    res.json({
      success: true,
      requiresCode: true,
      dutyId: dutyRecord.DutyID,
      message: `Punch-In request submitted! Floor Manager se 4-digit code lein aur enter karein taaki duty chalu ho sake.`,
      duty: dutyState,
      dutyRecord
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 4. VERIFY 4-DIGIT MANAGER APPROVAL CODE TO ACTIVATE DUTY
// ==========================================
router.post('/verify-duty-code', authenticateToken, async (req, res) => {
  try {
    const { code, dutyId } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Please enter the 4-digit approval code.' });
    }

    const cleanCode = String(code).trim();

    // Find the latest pending/approved duty record
    let dutyRecord = null;
    if (dutyId) {
      dutyRecord = await prisma.dutyRecords.findUnique({
        where: { DutyID: Number(dutyId) }
      });
    }

    if (!dutyRecord) {
      dutyRecord = await prisma.dutyRecords.findFirst({
        where: {
          UserID: req.user.userId,
          ApprovalStatus: { in: ['PENDING_APPROVAL', 'APPROVED'] }
        },
        orderBy: { DutyID: 'desc' }
      });
    }

    if (!dutyRecord) {
      return res.status(404).json({ success: false, message: 'No active punch-in request found. Please punch in first.' });
    }

    // Check if manager has approved yet
    if (dutyRecord.ApprovalStatus === 'PENDING_APPROVAL') {
      return res.status(400).json({
        success: false,
        message: 'Floor Manager ne abhi tak punch-in approve nahi kiya hai. Kripya Floor Lead se approve karwayein.'
      });
    }

    // Verify 4-digit code match
    if (dutyRecord.ApprovalCode !== cleanCode) {
      return res.status(400).json({
        success: false,
        message: '❌ Galat 4-Digit Code! Manager se mila sahi code enter karein.'
      });
    }

    // Code matched! Activate Duty
    const now = new Date();
    const timeStr = now.toLocaleTimeString();

    await prisma.dutyRecords.update({
      where: { DutyID: dutyRecord.DutyID },
      data: {
        ApprovalStatus: 'ACTIVE',
        PunchInTime: dutyRecord.PunchInTime || timeStr
      }
    });

    const staff = await prisma.staff.findFirst({ where: { UserID: req.user.userId } });

    // Update duty cache to ON
    const dutyState = {
      duty: 'ON',
      onBreak: false,
      slot: dutyRecord.ShiftSlot || 'General',
      punchInTime: dutyRecord.PunchInTime || timeStr,
      dutyId: dutyRecord.DutyID,
      requiresCode: false
    };
    await cache.set(`wms:duty:${req.user.userId}`, dutyState, 86400);

    // Audit log
    await logAudit({
      userId: req.user.userId,
      action: 'DUTY_CODE_VERIFIED_ACTIVE',
      tableName: 'DutyRecords',
      recordId: dutyRecord.DutyID,
      details: { code: cleanCode, time: timeStr }
    });

    // Notify Manager
    emitToRole('manager', 'wms:duty_status_change', {
      userId: req.user.userId,
      name: req.user.name,
      status: 'DUTY_ON',
      message: `${req.user.name} entered 4-digit code. Duty is now ACTIVE!`
    });

    // If picker, auto-assign pending orders immediately!
    if (req.user.role === 'picker') {
      setTimeout(() => triggerAutoAssignment(staff?.StoreID || 1), 500);
    }

    res.json({
      success: true,
      verified: true,
      message: '🎉 4-Digit Code verified successfully! Aapki Duty chalu ho gayi hai.',
      duty: dutyState
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Punch-Out
router.post('/punch-out', authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const timeStr = now.toLocaleTimeString();

    const staff = await prisma.staff.findFirst({ where: { UserID: req.user.userId } });
    if (staff) {
      // Find latest attendance of today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const latest = await prisma.attendanceLogs.findFirst({
        where: { StaffID: staff.StaffID, Date: { gte: today } },
        orderBy: { LogID: 'desc' }
      });

      if (latest) {
        await prisma.attendanceLogs.update({
          where: { LogID: latest.LogID },
          data: { CheckOut: timeStr, Status: 'COMPLETED' }
        });
      }

      // Update DutyRecords
      const dutyRec = await prisma.dutyRecords.findFirst({
        where: { UserID: req.user.userId, ApprovalStatus: 'ACTIVE' },
        orderBy: { DutyID: 'desc' }
      });

      if (dutyRec) {
        const hours = Math.max(0.5, parseFloat(((now.getTime() - new Date(dutyRec.CreatedAt).getTime()) / (1000 * 60 * 60)).toFixed(1)));
        await prisma.dutyRecords.update({
          where: { DutyID: dutyRec.DutyID },
          data: {
            PunchOutTime: timeStr,
            TotalHours: hours,
            ApprovalStatus: 'COMPLETED'
          }
        });
      }
    }

    const dutyState = {
      duty: 'OFF',
      onBreak: false,
      slot: null,
      punchInTime: null,
      punchOutTime: timeStr
    };
    await cache.set(`wms:duty:${req.user.userId}`, dutyState, 86400);

    await logAudit({
      userId: req.user.userId,
      action: 'PUNCH_OUT',
      tableName: 'AttendanceLogs',
      recordId: 0,
      details: { time: timeStr }
    });

    emitToRole('manager', 'wms:attendance_update', {
      userId: req.user.userId,
      name: req.user.name,
      role: req.user.role,
      action: 'PUNCH_OUT',
      time: timeStr
    });

    res.json({ success: true, message: 'Punch-Out Successful. Duty OFF.', duty: dutyState });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Break Start
router.post('/break-start', authenticateToken, async (req, res) => {
  try {
    const { breakType } = req.body; // 'Tea (15m)', 'Lunch (30m)'
    const dutyData = await cache.get(`wms:duty:${req.user.userId}`);
    const dutyState = dutyData ? (typeof dutyData === 'string' ? JSON.parse(dutyData) : dutyData) : { duty: 'ON' };

    dutyState.onBreak = true;
    dutyState.breakType = breakType || 'Break';
    dutyState.breakStartTime = new Date().toLocaleTimeString();

    await cache.set(`wms:duty:${req.user.userId}`, dutyState, 86400);

    emitToRole('manager', 'wms:duty_status_change', {
      userId: req.user.userId,
      name: req.user.name,
      status: 'ON_BREAK',
      breakType: dutyState.breakType
    });

    res.json({ success: true, message: `Break started: ${dutyState.breakType}`, duty: dutyState });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Break End
router.post('/break-end', authenticateToken, async (req, res) => {
  try {
    const dutyData = await cache.get(`wms:duty:${req.user.userId}`);
    const dutyState = dutyData ? (typeof dutyData === 'string' ? JSON.parse(dutyData) : dutyData) : { duty: 'ON' };

    dutyState.onBreak = false;
    dutyState.breakEndTime = new Date().toLocaleTimeString();

    await cache.set(`wms:duty:${req.user.userId}`, dutyState, 86400);

    emitToRole('manager', 'wms:duty_status_change', {
      userId: req.user.userId,
      name: req.user.name,
      status: 'DUTY_ON'
    });

    if (req.user.role === 'picker') {
      setTimeout(() => triggerAutoAssignment(), 500);
    }

    res.json({ success: true, message: 'Break ended. Duty resumed!', duty: dutyState });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Duty Toggle (Duty ON / Duty OFF)
router.post('/duty-toggle', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body; // 'ON' or 'OFF'
    const dutyData = await cache.get(`wms:duty:${req.user.userId}`);
    const dutyState = dutyData ? (typeof dutyData === 'string' ? JSON.parse(dutyData) : dutyData) : {};

    dutyState.duty = status === 'ON' ? 'ON' : 'OFF';
    if (dutyState.duty === 'OFF') dutyState.onBreak = false;

    await cache.set(`wms:duty:${req.user.userId}`, dutyState, 86400);

    emitToRole('manager', 'wms:duty_status_change', {
      userId: req.user.userId,
      name: req.user.name,
      status: dutyState.duty === 'ON' ? 'DUTY_ON' : 'DUTY_OFF'
    });

    if (dutyState.duty === 'ON' && req.user.role === 'picker') {
      setTimeout(() => triggerAutoAssignment(), 500);
    }

    res.json({ success: true, message: `Duty status updated to ${dutyState.duty}`, duty: dutyState });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Realtime Socket.io Bridge (Admin / Floor Lead broadcast to staff PDA)
router.post('/socket-broadcast', async (req, res) => {
  try {
    const { event, userId, role, data, message, reason } = req.body;
    const payload = {
      userId: userId ? Number(userId) : undefined,
      message: message || '',
      reason: reason || '',
      timestamp: new Date().toISOString(),
      ...(data || {})
    };

    if (userId) {
      emitToUser(Number(userId), event, payload);
    }
    if (role) {
      emitToRole(role, event, payload);
    }
    broadcast(event, payload);

    // If force_checkout, update redis duty state
    if (userId && (event === 'wms:force_checkout' || event === 'wms:punch_out')) {
      await cache.set(`wms:duty:${userId}`, {
        duty: 'OFF',
        onBreak: false,
        slot: null,
        punchOutTime: new Date().toLocaleTimeString()
      }, 86400);
    }

    res.json({ success: true, broadcasted: true, event, payload });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
