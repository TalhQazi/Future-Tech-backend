import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/fuel/vehicle/:vehicleId
router.get('/vehicle/:vehicleId', (req, res) => {
  const logs = db.fuel.findByVehicleId(req.params.vehicleId);
  const avgMpg = logs.length > 0 
    ? +(logs.reduce((sum, l) => sum + l.calculatedMpg, 0) / logs.length).toFixed(1)
    : null;
  const anomaliesCount = logs.filter(l => l.anomalyDetected).length;

  res.json({
    success: true,
    vehicleId: req.params.vehicleId,
    averageMpg: avgMpg,
    anomaliesCount,
    fuelLogs: logs
  });
});

// POST /api/v1/fuel
router.post('/', (req, res) => {
  const { vehicleId, odometer, gallons, totalCost, expectedMpg } = req.body;

  if (!vehicleId || !odometer || !gallons) {
    return res.status(400).json({ success: false, message: 'VehicleId, odometer, and gallons are required' });
  }

  const newLog = db.fuel.create({
    vehicleId,
    odometer: parseInt(odometer),
    gallons: parseFloat(gallons),
    totalCost: parseFloat(totalCost) || 0,
    expectedMpg: parseFloat(expectedMpg) || 22.0
  });

  res.status(201).json({ success: true, fuelLog: newLog });
});

export default router;
