const jwt = require('jsonwebtoken');
const prisma = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'wms-super-secret-jwt-key';
const MAJOR_JWT_SECRET = process.env.MAJOR_JWT_SECRET || 'supersecretjwtkey123';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required. Token missing.' });
  }

  let decoded = null;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err1) {
    try {
      decoded = jwt.verify(token, MAJOR_JWT_SECRET);
    } catch (err2) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }
  }

  const targetUserId = decoded.userId || decoded.UserID;
  if (!targetUserId) {
    return res.status(403).json({ success: false, message: 'Malformed token payload.' });
  }

  prisma.users.findUnique({
    where: { UserID: parseInt(targetUserId) }
  }).then(user => {
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    req.user = {
      userId: user.UserID,
      name: `${user.UserNameFirst || ''} ${user.UserNameLast || ''}`.trim() || user.Name || 'Staff Member',
      role: (user.Role || '').toLowerCase(),
      mobile: user.Mobile,
      email: user.Email,
      isOnline: user.IsOnline
    };

    next();
  }).catch(dbErr => {
    return res.status(500).json({ success: false, message: 'Auth database error: ' + dbErr.message });
  });
}

function requireRoles(...allowedRoles) {
  const flatRoles = allowedRoles.flat().map(r => r.toLowerCase());
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const userRole = (req.user.role || '').toLowerCase();
    // Superadmin and admin have all access
    if (['superadmin', 'admin'].includes(userRole)) {
      return next();
    }

    // Role mapping aliases
    const aliases = {
      'manager': ['manager', 'floorlead', 'supervisor', 'incharge'],
      'picker': ['picker'],
      'packer': ['packer', 'sorter'],
      'putter': ['putter', 'putaway', 'staging'],
      'inward': ['inward', 'receiving', 'incharge', 'manager']
    };

    let permitted = flatRoles.includes(userRole);
    if (!permitted) {
      for (const [key, list] of Object.entries(aliases)) {
        if (flatRoles.includes(key) && list.includes(userRole)) {
          permitted = true;
          break;
        }
      }
    }

    if (!permitted) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Access restricted to roles [${flatRoles.join(', ')}]. Your role is '${userRole}'.`
      });
    }

    next();
  };
}

module.exports = { authenticateToken, requireRoles, JWT_SECRET };
