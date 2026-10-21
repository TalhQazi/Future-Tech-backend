import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/repair-orders (All enriched ROs for shop boards)
router.get('/', (req, res) => {
  const { status, techId, customerId } = req.query;
  let ros = db.repairOrders.findEnriched();

  if (status) {
    ros = ros.filter(r => r.status === status);
  }
  if (techId) {
    ros = ros.filter(r => r.assignedTechId === techId);
  }
  if (customerId) {
    ros = ros.filter(r => r.customerId === customerId);
  }

  res.json({ success: true, count: ros.length, repairOrders: ros });
});

// GET /api/v1/repair-orders/:id (Full 360 degree RO details)
router.get('/:id', (req, res) => {
  const ro = db.repairOrders.findEnrichedById(req.params.id);
  if (!ro) {
    return res.status(404).json({ success: false, message: 'Repair Order not found' });
  }
  res.json({ success: true, repairOrder: ro });
});

// POST /api/v1/repair-orders (Check-in new job)
router.post('/', (req, res) => {
  const {
    customerId,
    vehicleId,
    odometerIn,
    customerComplaints,
    advisorNotes,
    assignedTechId,
    bayNumber,
    targetCompletion
  } = req.body;

  if (!customerId || !vehicleId) {
    return res.status(400).json({ success: false, message: 'Customer ID and Vehicle ID are required to open a Repair Order' });
  }

  // Update vehicle odometer if provided
  if (odometerIn) {
    db.vehicles.update(vehicleId, { mileage: parseInt(odometerIn) });
  }

  const newRO = db.repairOrders.create({
    customerId,
    vehicleId,
    odometerIn: parseInt(odometerIn) || 0,
    customerComplaints: Array.isArray(customerComplaints) ? customerComplaints : [customerComplaints || 'General Inspection'],
    advisorNotes: advisorNotes || '',
    assignedTechId: assignedTechId || 'usr_tech_1',
    bayNumber: bayNumber || 'Bay 1',
    targetCompletion: targetCompletion || new Date(Date.now() + 8*60*60*1000).toISOString()
  });

  db.audit.create({
    eventType: 'RO_CHECKED_IN',
    entityType: 'RepairOrder',
    entityId: newRO.id,
    action: `Opened Repair Order ${newRO.roNumber} for Vehicle ${vehicleId}. Assigned: ${assignedTechId || 'usr_tech_1'}`
  });

  const enriched = db.repairOrders.findEnrichedById(newRO.id);
  res.status(201).json({ success: true, repairOrder: enriched });
});

// PUT /api/v1/repair-orders/:id/status (Transition RO status)
router.put('/:id/status', (req, res) => {
  const { status, bayNumber, assignedTechId } = req.body;
  const updates = {};
  if (status) updates.status = status;
  if (bayNumber) updates.bayNumber = bayNumber;
  if (assignedTechId) updates.assignedTechId = assignedTechId;

  const updated = db.repairOrders.update(req.params.id, updates);
  if (!updated) {
    return res.status(404).json({ success: false, message: 'Repair Order not found' });
  }

  db.audit.create({
    eventType: 'RO_STATUS_CHANGED',
    entityType: 'RepairOrder',
    entityId: updated.id,
    action: `RO ${updated.roNumber} transitioned to '${status || updated.status}' in ${bayNumber || updated.bayNumber}`
  });

  const enriched = db.repairOrders.findEnrichedById(req.params.id);
  res.json({ success: true, repairOrder: enriched });
});

// PUT /api/v1/repair-orders/:id/assign (Assign technician)
router.put('/:id/assign', (req, res) => {
  const { techId, bayNumber } = req.body;
  const updates = { assignedTechId: techId };
  if (bayNumber) updates.bayNumber = bayNumber;

  const updated = db.repairOrders.update(req.params.id, updates);
  if (!updated) {
    return res.status(404).json({ success: false, message: 'Repair Order not found' });
  }

  const enriched = db.repairOrders.findEnrichedById(req.params.id);
  res.json({ success: true, repairOrder: enriched });
});

// POST /api/v1/repair-orders/:id/qc-signoff (Quality Control completion sign-off)
router.post('/:id/qc-signoff', (req, res) => {
  const { checklist, roadTested, signedBy } = req.body;
  const ro = db.repairOrders.findById(req.params.id);
  if (!ro) {
    return res.status(404).json({ success: false, message: 'Repair Order not found' });
  }

  ro.qcChecklist = checklist || [
    { task: 'All customer complaints verified resolved', passed: true },
    { task: 'Wheels torqued to manufacturer spec', passed: true },
    { task: 'Fluid levels checked and filled', passed: true },
    { task: 'DTC scan clear / readiness monitors set', passed: true },
    { task: 'Road test validation complete', passed: roadTested !== undefined ? roadTested : true }
  ];
  ro.status = 'ready_for_pickup';
  ro.qcSignedBy = signedBy || 'Shop Foreman';
  ro.qcSignedAt = new Date().toISOString();

  db.audit.create({
    eventType: 'QC_SIGN_OFF',
    entityType: 'RepairOrder',
    entityId: ro.id,
    action: `Quality Control signed off by ${ro.qcSignedBy}. Vehicle moved to ready_for_pickup.`
  });

  const enriched = db.repairOrders.findEnrichedById(ro.id);
  res.json({ success: true, repairOrder: enriched, message: 'Quality control sign-off completed.' });
});

// POST /api/v1/repair-orders/:id/safety-escalation
router.post('/:id/safety-escalation', (req, res) => {
  const { reason, flaggedBy } = req.body;
  const ro = db.repairOrders.findById(req.params.id);
  if (!ro) {
    return res.status(404).json({ success: false, message: 'Repair Order not found' });
  }

  ro.safetyEscalation = {
    flagged: true,
    reason: reason || 'Critical safety defect detected (brake hydraulic or steering component failure)',
    flaggedBy: flaggedBy || 'Master Technician',
    flaggedAt: new Date().toISOString()
  };

  db.audit.create({
    eventType: 'SAFETY_ESCALATION_FLAGGED',
    entityType: 'RepairOrder',
    entityId: ro.id,
    action: `SAFETY ESCALATION on RO ${ro.roNumber}: ${reason}`
  });

  const enriched = db.repairOrders.findEnrichedById(ro.id);
  res.json({ success: true, repairOrder: enriched, message: 'Safety escalation logged and broadcast to Shop Management.' });
});

export default router;
