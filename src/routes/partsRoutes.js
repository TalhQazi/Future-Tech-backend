import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/parts/ro/:roId
router.get('/ro/:roId', (req, res) => {
  const parts = db.parts.findByRoId(req.params.roId);
  res.json({ success: true, count: parts.length, parts });
});

// POST /api/parts
router.post('/', (req, res) => {
  const { roId, techId, partName, partNumber, quantity, urgency, vendor, cost, retail } = req.body;
  if (!roId || !partName) {
    return res.status(400).json({ success: false, message: 'roId and partName are required' });
  }

  const part = db.parts.create({
    roId,
    techId: techId || 'usr_tech_1',
    partName,
    partNumber: partNumber || 'GEN-PART',
    quantity: parseInt(quantity) || 1,
    urgency: urgency || 'normal',
    vendor: vendor || 'Shop Inventory / WorldPac',
    cost: parseFloat(cost) || 0,
    retail: parseFloat(retail) || 0
  });

  res.status(201).json({ success: true, part });
});

// PUT /api/parts/:id/status (requested -> ordered -> received -> installed)
router.put('/:id/status', (req, res) => {
  const { status } = req.body;
  const part = db.parts.updateStatus(req.params.id, status);
  if (!part) {
    return res.status(404).json({ success: false, message: 'Part request not found' });
  }
  res.json({ success: true, part });
});

export default router;
