let ioInstance = null;

function initSocket(io) {
  ioInstance = io;

  io.on('connection', (socket) => {
    // Staff joining their personal channel and role room
    socket.on('join', (data) => {
      const { userId, role } = data || {};
      if (userId) {
        socket.join(`user:${userId}`);
        socket.userId = userId;
      }
      if (role) {
        socket.join(`role:${role.toLowerCase()}`);
        socket.role = role.toLowerCase();
      }
      console.log(`🔌 Socket connected: User #${userId} (${role})`);
    });

    socket.on('disconnect', () => {
      // Disconnect handling
    });
  });

  return io;
}

function getIO() {
  return ioInstance;
}

/**
 * Emit event to specific user
 */
function emitToUser(userId, event, data) {
  if (ioInstance) {
    ioInstance.to(`user:${userId}`).emit(event, data);
  }
}

/**
 * Emit event to a role room (e.g., 'role:picker', 'role:manager', 'role:packer')
 */
function emitToRole(role, event, data) {
  if (ioInstance) {
    ioInstance.to(`role:${role.toLowerCase()}`).emit(event, data);
  }
}

/**
 * Broadcast event to all connected clients
 */
function broadcast(event, data) {
  if (ioInstance) {
    ioInstance.emit(event, data);
  }
}

module.exports = { initSocket, getIO, emitToUser, emitToRole, broadcast };
