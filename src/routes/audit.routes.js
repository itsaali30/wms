const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Search & list audit logs
router.get('/logs', async (req, res) => {
  try {
    const { action, limit = 50 } = req.query;
    const where = {};
    if (action) {
      where.Action = { contains: action, mode: 'insensitive' };
    }

    const logs = await prisma.auditLogs.findMany({
      where,
      orderBy: { LogID: 'desc' },
      take: Math.min(Number(limit) || 50, 100)
    });

    const enrichedLogs = await Promise.all(
      logs.map(async (l) => {
        let details = null;
        try {
          details = JSON.parse(l.NewValue || '{}');
        } catch (e) {
          details = l.NewValue;
        }

        const user = await prisma.users.findUnique({
          where: { UserID: l.UserID },
          select: { UserNameFirst: true, UserNameLast: true, Role: true, Mobile: true }
        });

        return {
          logId: l.LogID,
          action: l.Action,
          tableName: l.TableName,
          recordId: l.RecordID,
          details,
          time: l.Time,
          user: user ? {
            name: `${user.UserNameFirst} ${user.UserNameLast || ''}`.trim(),
            role: user.Role,
            mobile: user.Mobile
          } : { name: `User #${l.UserID}`, role: 'staff' }
        };
      })
    );

    res.json({ success: true, count: enrichedLogs.length, logs: enrichedLogs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Audit stats
router.get('/stats', async (req, res) => {
  try {
    const totalLogs = await prisma.auditLogs.count();
    const pickLogs = await prisma.auditLogs.count({ where: { Action: { contains: 'PICK' } } });
    const putawayLogs = await prisma.auditLogs.count({ where: { Action: { contains: 'PUTAWAY' } } });
    const packLogs = await prisma.auditLogs.count({ where: { Action: { contains: 'SEAL' } } });
    const damageLogs = await prisma.auditLogs.count({ where: { Action: { contains: 'DAMAGE' } } });
    const gatepassLogs = await prisma.auditLogs.count({ where: { Action: { contains: 'GATEPASS' } } });

    res.json({
      success: true,
      stats: {
        total: totalLogs,
        picks: pickLogs,
        putaways: putawayLogs,
        packs: packLogs,
        damages: damageLogs,
        gatepasses: gatepassLogs
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
