import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';

// Import Routes
import authRoutes from './routes/authRoutes.js';
import customerRoutes from './routes/customerRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import roRoutes from './routes/roRoutes.js';
import inspectionRoutes from './routes/inspectionRoutes.js';
import futuretechRoutes from './routes/futuretechRoutes.js';
import estimateRoutes from './routes/estimateRoutes.js';
import partsRoutes from './routes/partsRoutes.js';
import invoiceRoutes from './routes/invoiceRoutes.js';
import locationRoutes from './routes/locationRoutes.js';
import appointmentRoutes from './routes/appointmentRoutes.js';
import inventoryRoutes from './routes/inventoryRoutes.js';
import membershipRoutes from './routes/membershipRoutes.js';
import wiringRoutes from './routes/wiringRoutes.js';
import confirmedFixRoutes from './routes/confirmedFixRoutes.js';
import forumRoutes from './routes/forumRoutes.js';
import fuelRoutes from './routes/fuelRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import auditRoutes from './routes/auditRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to Database / Load Store
connectDB();

// Security Headers & Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging & correlation tracking
app.use((req, res, next) => {
  const start = Date.now();
  req.correlationId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  res.setHeader('X-Correlation-ID', req.correlationId);

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.originalUrl.startsWith('/api')) {
      console.log(`[${req.method}] ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Helper to mount routers simultaneously on /api/v1 and /api (backwards compatible)
const mountRoute = (path, router) => {
  app.use(`/api/v1${path}`, router);
  app.use(`/api${path}`, router);
};

// Mount API surfaces
mountRoute('/auth', authRoutes);
mountRoute('/customers', customerRoutes);
mountRoute('/vehicles', vehicleRoutes);
mountRoute('/repair-orders', roRoutes);
mountRoute('/inspections', inspectionRoutes);
mountRoute('/futuretech', futuretechRoutes);
mountRoute('/estimates', estimateRoutes);
mountRoute('/parts', partsRoutes);
mountRoute('/invoices', invoiceRoutes);
mountRoute('/locations', locationRoutes);
mountRoute('/appointments', appointmentRoutes);
mountRoute('/inventory', inventoryRoutes);
mountRoute('/memberships', membershipRoutes);
mountRoute('/wiring', wiringRoutes);
mountRoute('/confirmed-fixes', confirmedFixRoutes);
mountRoute('/forum', forumRoutes);
mountRoute('/fuel', fuelRoutes);
mountRoute('/messages', messageRoutes);
mountRoute('/ai', aiRoutes);
mountRoute('/analytics', analyticsRoutes);
mountRoute('/audit', auditRoutes);

// Health check endpoint
const healthHandler = (req, res) => {
  res.json({
    status: 'healthy',
    system: 'FutureTech 2.0 & Membership Auto API',
    apiVersion: 'v1',
    architecture: 'MERN Stack + Persistent Automotive Engine',
    modules: [
      'auth_mfa_jwt', 'customers', 'vehicles_vin_decoder', 'repair_orders',
      'inspections_dvi', 'automind_diagnostics', 'estimates_approvals',
      'parts_inventory_reliability', 'invoicing_payments', 'locations_corporate',
      'appointments_capacity', 'interactive_wiring', 'confirmed_fixes',
      'technician_forum', 'fuel_anomalies', 'two_way_messaging',
      'governed_ai_service_writer', 'corporate_analytics_profit_vin', 'append_only_audit'
    ],
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
};

app.get('/api/v1/health', healthHandler);
app.get('/api/health', healthHandler);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`⚡ FutureTech 2.0 API Server running on port ${PORT}`);
  console.log(`📍 API v1 Base: http://localhost:${PORT}/api/v1`);
  console.log(`📍 API Health: http://localhost:${PORT}/api/v1/health`);
  console.log(`======================================================\n`);
});
