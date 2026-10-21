import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/wiring
router.get('/', (req, res) => {
  const { make, model } = req.query;
  let diagrams;
  if (make || model) {
    diagrams = db.wiring.findByVehicle(make, model);
  } else {
    diagrams = db.wiring.find();
  }
  res.json({ success: true, count: diagrams.length, diagrams });
});

// GET /api/v1/wiring/:id
router.get('/:id', (req, res) => {
  const diagram = db.wiring.findById(req.params.id);
  if (!diagram) {
    return res.status(404).json({ success: false, message: 'Wiring diagram not found' });
  }
  res.json({ success: true, diagram });
});

// GET /api/v1/wiring/subsystem/:subsystem
router.get('/subsystem/:subsystem', (req, res) => {
  const diagrams = db.wiring.find(d => d.subsystem.toLowerCase().includes(req.params.subsystem.toLowerCase()));
  res.json({ success: true, count: diagrams.length, diagrams });
});

export default router;
