const prisma = require('./db');
const { emitWarehouseEvent } = require('./kafka');

/**
 * Log warehouse action to AuditLogs table and emit event
 */
async function logAudit({ userId, action, tableName, recordId = 0, oldValue = null, newValue = null, details = {} }) {
  try {
    const oldStr = oldValue ? (typeof oldValue === 'object' ? JSON.stringify(oldValue) : String(oldValue)) : null;
    const newStr = newValue ? (typeof newValue === 'object' ? JSON.stringify(newValue) : String(newValue)) : (details ? JSON.stringify(details) : null);

    const auditEntry = await prisma.auditLogs.create({
      data: {
        UserID: userId || 1,
        Action: action,
        TableName: tableName,
        RecordID: Number(recordId) || 0,
        OldValue: oldStr,
        NewValue: newStr,
        Time: new Date()
      }
    });

    await emitWarehouseEvent('wms.audit', {
      action,
      tableName,
      recordId,
      userId,
      details,
      summary: `User #${userId} performed ${action} on ${tableName} #${recordId}`
    });

    return auditEntry;
  } catch (err) {
    console.error('❌ Audit logging error:', err.message);
  }
}

module.exports = { logAudit };
