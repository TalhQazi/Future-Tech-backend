import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/inspections/ro/:roId
router.get('/ro/:roId', (req, res) => {
  let insp = db.inspections.findByRoId(req.params.roId);
  if (!insp) {
    return res.status(404).json({ success: false, message: 'Inspection not found for this RO' });
  }
  res.json({ success: true, inspection: insp });
});

// PUT /api/v1/inspections/ro/:roId/items/:itemId (Update inspection checklist item)
router.put('/ro/:roId/items/:itemId', (req, res) => {
  const { status, finding, recommendation, photoUrl, measurements } = req.body;
  const current = db.inspections.findByRoId(req.params.roId);

  // Check if findings are locked
  const item = current?.items?.find(it => it.id === req.params.itemId);
  if (item && item.locked && current.status === 'completed') {
    return res.status(403).json({
      success: false,
      message: 'This finding is locked after inspection sign-off. Correction requires creating an addendum.'
    });
  }

  const insp = db.inspections.updateItemStatus(
    req.params.roId,
    req.params.itemId,
    status,
    finding,
    recommendation,
    photoUrl
  );

  if (!insp) {
    return res.status(404).json({ success: false, message: 'Inspection or item not found' });
  }

  if (measurements && item) {
    item.measurements = measurements;
  }

  // Auto transition RO to 'in_inspection' if it was 'checked_in'
  const ro = db.repairOrders.findById(req.params.roId);
  if (ro && (ro.status === 'checked_in' || ro.status === 'inspection')) {
    db.repairOrders.update(req.params.roId, { status: 'in_inspection' });
  }

  res.json({ success: true, inspection: insp });
});

// POST /api/v1/inspections/ro/:roId/items (Add custom inspection item)
router.post('/ro/:roId/items', (req, res) => {
  const { category, name, status, finding, recommendation, photoUrl } = req.body;
  if (!category || !name) {
    return res.status(400).json({ success: false, message: 'Category and item name are required' });
  }

  const insp = db.inspections.addItem(req.params.roId, {
    category,
    name,
    status: status || 'pass',
    finding: finding || '',
    recommendation: recommendation || '',
    photoUrl: photoUrl || '',
    locked: false
  });

  if (!insp) {
    return res.status(404).json({ success: false, message: 'Inspection not found' });
  }

  res.status(201).json({ success: true, inspection: insp });
});

// POST /api/v1/inspections/ro/:roId/complete (Finalize and lock DVI inspection)
router.post('/ro/:roId/complete', (req, res) => {
  const insp = db.inspections.complete(req.params.roId);
  if (!insp) {
    return res.status(404).json({ success: false, message: 'Inspection not found' });
  }

  // Lock all items immutably
  insp.items.forEach(it => {
    it.locked = true;
  });

  // Update RO to 'estimate_pending' so advisor can build or send estimate
  db.repairOrders.update(req.params.roId, { status: 'estimate_pending' });

  db.audit.create({
    eventType: 'INSPECTION_LOCKED',
    entityType: 'Inspection',
    entityId: insp.id,
    action: `DVI finalized and locked for RO ${req.params.roId}. Summary: ${insp.summary.pass} Pass, ${insp.summary.attention} Attention, ${insp.summary.fail} Fail.`
  });

  res.json({ success: true, inspection: insp });
});

export default router;
