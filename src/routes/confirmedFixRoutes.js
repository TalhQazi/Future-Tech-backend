import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/confirmed-fixes?q=...
router.get('/', (req, res) => {
  const { q, dtc, make } = req.query;
  let fixes = db.confirmedFixes.find();

  if (q) {
    fixes = db.confirmedFixes.search(q);
  }
  if (dtc) {
    fixes = fixes.filter(f => f.dtcCode.toUpperCase() === dtc.toUpperCase());
  }
  if (make) {
    fixes = fixes.filter(f => f.make.toLowerCase() === make.toLowerCase());
  }

  res.json({ success: true, count: fixes.length, confirmedFixes: fixes });
});

// GET /api/v1/confirmed-fixes/:id
router.get('/:id', (req, res) => {
  const fix = db.confirmedFixes.findById(req.params.id);
  if (!fix) {
    return res.status(404).json({ success: false, message: 'Confirmed fix not found' });
  }
  res.json({ success: true, confirmedFix: fix });
});

// POST /api/v1/confirmed-fixes (Submit newly verified shop repair outcome)
router.post('/', (req, res) => {
  const { dtcCode, make, model, yearRange, symptom, verifiedFix, partsReplaced, laborHours, verifiedByShopMaster } = req.body;

  if (!dtcCode || !verifiedFix) {
    return res.status(400).json({ success: false, message: 'DTC code and verified fix description are required' });
  }

  const newFix = db.confirmedFixes.create({
    dtcCode: dtcCode.toUpperCase().trim(),
    make: make || 'All Makes',
    model: model || 'All Models',
    yearRange: yearRange || 'Recent Models',
    symptom: symptom || 'Check Engine Light / Driveability concern',
    verifiedFix,
    partsReplaced: Array.isArray(partsReplaced) ? partsReplaced : [partsReplaced || 'OEM Replacement Component'],
    laborHours: parseFloat(laborHours) || 1.0,
    verifiedByShopMaster: verifiedByShopMaster || 'Marcus Vance, ASE Master Diagnostic Tech'
  });

  db.audit.create({
    eventType: 'CONFIRMED_FIX_CONTRIBUTED',
    entityType: 'ConfirmedFix',
    entityId: newFix.id,
    action: `Published verified repair outcome for DTC ${newFix.dtcCode} on ${newFix.make} ${newFix.model}`
  });

  res.status(201).json({ success: true, confirmedFix: newFix });
});

export default router;
