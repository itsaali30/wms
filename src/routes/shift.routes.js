const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const { logAudit } = require('../config/audit');

router.use(authenticateToken);

// 1. Get Available Shift Slots
router.get('/slots', async (req, res) => {
  try {
    const slots = [
      {
        shiftId: 1,
        name: 'Morning Slot',
        code: 'Morning',
        time: '06:00 AM – 02:00 PM',
        hours: 8,
        capacity: 25,
        availableSlots: 8,
        incentive: 'Standard + Early Bird ₹50',
        active: true
      },
      {
        shiftId: 2,
        name: 'Afternoon / General Slot',
        code: 'General',
        time: '09:00 AM – 06:00 PM',
        hours: 9,
        capacity: 35,
        availableSlots: 14,
        incentive: 'Standard Rates',
        active: true
      },
      {
        shiftId: 3,
        name: 'Evening Slot',
        code: 'Afternoon',
        time: '02:00 PM – 10:00 PM',
        hours: 8,
        capacity: 30,
        availableSlots: 11,
        incentive: 'Peak Order Rush Bonus ₹80',
        active: true
      },
      {
        shiftId: 4,
        name: 'Night Dark Store Shift',
        code: 'Night',
        time: '10:00 PM – 06:00 AM',
        hours: 8,
        capacity: 15,
        availableSlots: 6,
        incentive: 'Night Allowance + ₹120/shift',
        active: true
      }
    ];

    res.json({ success: true, slots });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Book a Shift Slot
router.post('/book', async (req, res) => {
  try {
    const { slotCode, date } = req.body;
    if (!slotCode) {
      return res.status(400).json({ success: false, message: 'Please select a shift slot code.' });
    }

    const staff = await prisma.staff.findFirst({ where: { UserID: req.user.userId } });
    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff profile not found.' });
    }

    const bookingDate = date ? new Date(date) : new Date();

    const assignment = await prisma.shiftAssignments.create({
      data: {
        StaffID: staff.StaffID,
        ShiftID: slotCode === 'Night' ? 4 : (slotCode === 'Morning' ? 1 : 2),
        SlotName: slotCode,
        Date: bookingDate,
        Status: 'BOOKED'
      }
    });

    await logAudit({
      userId: req.user.userId,
      action: 'SHIFT_SLOT_BOOKED',
      tableName: 'ShiftAssignments',
      recordId: assignment.AssignmentID,
      details: { slotCode, date: bookingDate }
    });

    res.json({
      success: true,
      message: `🎉 Slot booked successfully for ${slotCode} shift!`,
      assignment
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Worker Attendance & Duty History
router.get('/my-history', async (req, res) => {
  try {
    const userId = req.user.userId;
    const records = await prisma.dutyRecords.findMany({
      where: { UserID: userId },
      orderBy: { DutyID: 'desc' },
      take: 30
    });

    const enriched = records.map(r => ({
      dutyId: r.DutyID,
      date: r.Date,
      shiftSlot: r.ShiftSlot || 'General',
      punchInTime: r.PunchInTime || '09:00 AM',
      punchOutTime: r.PunchOutTime || (r.ApprovalStatus === 'COMPLETED' ? '06:00 PM' : 'Active'),
      totalHours: r.TotalHours || (r.ApprovalStatus === 'COMPLETED' ? 8.0 : 4.5),
      approvalStatus: r.ApprovalStatus,
      approvalCode: r.ApprovalCode || '—',
      selfieUrl: r.SelfieUrl,
      notes: r.Notes
    }));

    res.json({ success: true, history: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
