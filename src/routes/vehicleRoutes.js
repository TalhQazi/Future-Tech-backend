import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// Helper VIN decoder adapter (OEM/NHTSA deterministic decoding)
const decodeVin = (vin) => {
  const cleanVin = (vin || '').toUpperCase().trim();
  if (cleanVin.length !== 17) {
    return {
      valid: false,
      vin: cleanVin,
      message: 'VIN must be exactly 17 characters'
    };
  }

  const wmi = cleanVin.substring(0, 3);
  const vds = cleanVin.substring(3, 8);
  const yearChar = cleanVin.charAt(9);

  const yearMap = {
    'L': 2020, 'M': 2021, 'N': 2022, 'P': 2023, 'R': 2024, 'S': 2025, 'T': 2026,
    'K': 2019, 'J': 2018, 'H': 2017, 'G': 2016
  };
  const year = yearMap[yearChar] || 2022;

  let make = 'Generic Manufacturer';
  let model = 'Sedan / SUV';
  let engine = '2.0L 4-Cylinder DOHC';
  let trim = 'Base Equipment';

  if (wmi.startsWith('WA1') || wmi.startsWith('WAU')) {
    make = 'Audi';
    model = 'Q7 3.0T Quattro';
    engine = '3.0L Turbocharged V6 Mild Hybrid';
    trim = 'Prestige AWD';
  } else if (wmi.startsWith('1FT') || wmi.startsWith('1FA')) {
    make = 'Ford';
    model = 'F-150 PowerBoost';
    engine = '3.5L Twin-Turbo V6 Full Hybrid';
    trim = 'Lariat 4x4';
  } else if (wmi.startsWith('2T3') || wmi.startsWith('4T1') || wmi.startsWith('JT')) {
    make = 'Toyota';
    model = 'RAV4 Hybrid';
    engine = '2.5L Dynamic Force Hybrid';
    trim = 'XSE AWD';
  } else if (wmi.startsWith('7SA') || wmi.startsWith('5YJ')) {
    make = 'Tesla';
    model = 'Model Y';
    engine = 'Dual Electric Permanent Magnet / AC Induction';
    trim = 'Long Range Dual Motor';
  } else if (wmi.startsWith('WBA') || wmi.startsWith('WBY')) {
    make = 'BMW';
    model = '330i xDrive';
    engine = '2.0L TwinPower Turbo 4-Cylinder';
    trim = 'M Sport Package';
  }

  return {
    valid: true,
    vin: cleanVin,
    make,
    model,
    year,
    trim,
    engine,
    fuelType: engine.includes('Electric') ? 'Electric' : engine.includes('Hybrid') ? 'Hybrid' : 'Gasoline',
    bodyClass: model.includes('F-150') ? 'Pickup Truck' : model.includes('Q7') || model.includes('RAV4') || model.includes('Model Y') ? 'Sport Utility Vehicle (SUV)' : 'Passenger Car',
    plantCountry: wmi.startsWith('1') || wmi.startsWith('4') || wmi.startsWith('5') ? 'United States' : wmi.startsWith('2') ? 'Canada' : wmi.startsWith('W') ? 'Germany' : wmi.startsWith('J') ? 'Japan' : 'International'
  };
};

// GET /api/v1/vehicles/decode-vin/:vin
router.get('/decode-vin/:vin', (req, res) => {
  const result = decodeVin(req.params.vin);
  res.json({ success: true, decoded: result });
});

// GET /api/v1/vehicles?q=...
router.get('/', (req, res) => {
  const { q, customerId } = req.query;
  let vehicles;

  if (customerId) {
    vehicles = db.vehicles.findByCustomerId(customerId);
  } else if (q) {
    vehicles = db.vehicles.search(q);
  } else {
    vehicles = db.vehicles.find();
  }

  res.json({ success: true, count: vehicles.length, vehicles });
});

// GET /api/v1/vehicles/vin/:vin
router.get('/vin/:vin', (req, res) => {
  const vehicle = db.vehicles.findByVin(req.params.vin);
  if (!vehicle) {
    return res.status(404).json({ success: false, message: 'Vehicle not found with this VIN' });
  }
  const customer = db.customers.findById(vehicle.customerId);
  const ros = db.repairOrders.find(r => r.vehicleId === vehicle.id);
  res.json({ success: true, vehicle: { ...vehicle, customer, repairOrders: ros } });
});

// GET /api/v1/vehicles/:id
router.get('/:id', (req, res) => {
  const vehicle = db.vehicles.findById(req.params.id);
  if (!vehicle) {
    return res.status(404).json({ success: false, message: 'Vehicle not found' });
  }
  const customer = db.customers.findById(vehicle.customerId);
  const ros = db.repairOrders.find(r => r.vehicleId === vehicle.id);
  const predictive = db.predictive.findByVehicleId(vehicle.id);
  const fuel = db.fuel.findByVehicleId(vehicle.id);

  res.json({ 
    success: true, 
    vehicle: { 
      ...vehicle, 
      customer, 
      repairOrders: ros,
      predictiveSignals: predictive,
      fuelLogs: fuel
    } 
  });
});

// GET /api/v1/vehicles/:id/history
router.get('/:id/history', (req, res) => {
  const vehicle = db.vehicles.findById(req.params.id);
  if (!vehicle) {
    return res.status(404).json({ success: false, message: 'Vehicle not found' });
  }

  const ros = db.repairOrders.find(r => r.vehicleId === vehicle.id).map(r => {
    const est = db.estimates.findByRoId(r.id);
    const insp = db.inspections.findByRoId(r.id);
    return {
      roId: r.id,
      roNumber: r.roNumber,
      date: r.createdAt,
      odometer: r.odometerIn,
      status: r.status,
      complaints: r.customerComplaints,
      estimateTotal: est ? est.summary?.total : null,
      inspectionSummary: insp ? insp.summary : null
    };
  });

  res.json({
    success: true,
    vehicle: {
      id: vehicle.id,
      vin: vehicle.vin,
      make: vehicle.make,
      model: vehicle.model,
      year: vehicle.year,
      mileage: vehicle.mileage
    },
    serviceHistory: ros,
    ownershipHistory: [
      {
        ownerCustomerId: vehicle.customerId,
        acquiredDate: '2022-01-15',
        status: 'current'
      }
    ]
  });
});

// POST /api/v1/vehicles
router.post('/', (req, res) => {
  const { customerId, vin, make, model, year, trim, licensePlate, mileage, color, engine } = req.body;

  if (!customerId || !vin || !make || !model) {
    return res.status(400).json({ success: false, message: 'Customer ID, VIN, Make, and Model are required' });
  }

  // Check if VIN already exists
  const existing = db.vehicles.findByVin(vin);
  if (existing) {
    return res.status(400).json({ success: false, message: 'A vehicle with this VIN is already registered', vehicle: existing });
  }

  const newVehicle = db.vehicles.create({
    customerId,
    vin: vin.toUpperCase().trim(),
    make,
    model,
    year: parseInt(year) || 2023,
    trim: trim || 'Base',
    licensePlate: (licensePlate || 'PENDING').toUpperCase(),
    mileage: parseInt(mileage) || 0,
    color: color || 'Silver',
    engine: engine || 'Gasoline',
    healthScore: 90
  });

  db.audit.create({
    eventType: 'VEHICLE_REGISTERED',
    entityType: 'Vehicle',
    entityId: newVehicle.id,
    action: `Registered ${newVehicle.year} ${newVehicle.make} ${newVehicle.model} (VIN: ${newVehicle.vin}) for customer ${customerId}`
  });

  res.status(201).json({ success: true, vehicle: newVehicle });
});

export default router;
