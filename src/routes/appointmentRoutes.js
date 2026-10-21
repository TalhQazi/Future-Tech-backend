import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/appointments
router.get('/', (req, res) => {
  const { date, status, customerId } = req.query;
  let apts = db.appointments.findEnriched();

  if (date) {
    apts = apts.filter(a => a.scheduledDate === date);
  }
  if (status) {
    apts = apts.filter(a => a.status === status);
  }
  if (customerId) {
    apts = apts.filter(a => a.customerId === customerId);
  }

  res.json({ success: true, count: apts.length, appointments: apts });
});

// GET /api/v1/appointments/capacity
router.get('/capacity', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const apts = db.appointments.find(a => a.scheduledDate === date && a.status !== 'cancelled');
  const location = db.locations.findById('loc_flagship') || { baysCount: 8 };

  const totalBays = location.baysCount || 8;
  const hoursPerDay = 8;
  const totalCapacityHours = totalBays * hoursPerDay;

  const bookedHours = apts.reduce((sum, a) => sum + (a.estimatedHours || 1.5), 0);
  const utilizationPercent = Math.min(100, Math.round((bookedHours / totalCapacityHours) * 100));

  res.json({
    success: true,
    date,
    totalBays,
    totalCapacityHours,
    bookedHours: parseFloat(bookedHours.toFixed(1)),
    availableHours: parseFloat(Math.max(0, totalCapacityHours - bookedHours).toFixed(1)),
    utilizationPercent,
    appointmentsCount: apts.length
  });
});

// POST /api/v1/appointments
router.post('/', (req, res) => {
  const { customerId, vehicleId, scheduledDate, scheduledTime, serviceRequested, customerNotes, assignedBay, assignedTechId } = req.body;

  if (!customerId || !vehicleId || !scheduledDate || !scheduledTime) {
    return res.status(400).json({ success: false, message: 'Customer, vehicle, date, and time are required' });
  }

  const newApt = db.appointments.create({
    customerId,
    vehicleId,
    scheduledDate,
    scheduledTime,
    serviceRequested: serviceRequested || 'Standard Diagnostic & Safety Inspection',
    customerNotes: customerNotes || '',
    assignedBay: assignedBay || 'Bay 2',
    assignedTechId: assignedTechId || 'usr_tech_1',
    estimatedHours: 1.5
  });

  db.audit.create({
    eventType: 'APPOINTMENT_SCHEDULED',
    entityType: 'Appointment',
    entityId: newApt.id,
    action: `Booked appointment ${newApt.appointmentNumber} for ${scheduledDate} at ${scheduledTime}`
  });

  const enriched = db.appointments.findEnriched().find(a => a.id === newApt.id);
  res.status(201).json({ success: true, appointment: enriched });
});

// PUT /api/v1/appointments/:id/status
router.put('/:id/status', (req, res) => {
  const { status, roId } = req.body;
  const updates = {};
  if (status) updates.status = status;
  if (roId) updates.roId = roId;

  const updated = db.appointments.update(req.params.id, updates);
  if (!updated) {
    return res.status(404).json({ success: false, message: 'Appointment not found' });
  }

  res.json({ success: true, appointment: updated });
});

export default router;
