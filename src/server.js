require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');

const { initSocket } = require('./services/socket.service');
const authRoutes = require('./routes/auth.routes');
const pickerRoutes = require('./routes/picker.routes');
const putawayRoutes = require('./routes/putaway.routes');
const inwardRoutes = require('./routes/inward.routes');
const packerRoutes = require('./routes/packer.routes');
const managerRoutes = require('./routes/manager.routes');
const auditRoutes = require('./routes/audit.routes');
const transferRoutes = require('./routes/transfer.routes');
const walletRoutes = require('./routes/wallet.routes');
const shiftRoutes = require('./routes/shift.routes');

const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
initSocket(io);

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/picker', pickerRoutes);
app.use('/api/putaway', putawayRoutes);
app.use('/api/inward', inwardRoutes);
app.use('/api/packer', packerRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/transfer', transferRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/shifts', shiftRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Warehouse Management System (WMS)',
    timestamp: new Date().toISOString()
  });
});

// Single Page Application Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WMS Pick & Pack Web-App running at http://0.0.0.0:${PORT}`);
  console.log(`📦 Roles supported: Picker, Put-away, Inward, Packer, Manager/Floor Lead`);
});

module.exports = { app, server };
