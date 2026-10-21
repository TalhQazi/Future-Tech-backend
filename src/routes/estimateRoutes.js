import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/estimates/ro/:roId
router.get('/ro/:roId', (req, res) => {
  const est = db.estimates.findByRoId(req.params.roId);
  if (!est) {
    return res.status(404).json({ success: false, message: 'Estimate not found for this RO' });
  }
  res.json({ success: true, estimate: est });
});

// POST /api/estimates/ro/:roId (Create or replace estimate lines)
router.post('/ro/:roId', (req, res) => {
  const { lines, status } = req.body;
  if (!lines || !Array.isArray(lines)) {
    return res.status(400).json({ success: false, message: 'Lines array is required' });
  }

  // Calculate lines with lineTotal
  const processedLines = lines.map(line => {
    let lineTotal = 0;
    if (line.type === 'part') {
      lineTotal = (parseFloat(line.quantity) || 1) * (parseFloat(line.unitPrice) || 0);
    } else {
      lineTotal = (parseFloat(line.laborHours) || 1) * (parseFloat(line.laborRate) || 160);
    }
    return {
      id: line.id || `line_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      type: line.type || 'labor',
      description: line.description,
      partNumber: line.partNumber || '',
      quantity: parseFloat(line.quantity) || 1,
      unitPrice: parseFloat(line.unitPrice) || 0,
      laborHours: parseFloat(line.laborHours) || 0,
      laborRate: parseFloat(line.laborRate) || 0,
      approved: line.approved !== undefined ? line.approved : null,
      lineTotal: parseFloat(lineTotal.toFixed(2)),
      notes: line.notes || ''
    };
  });

  const subtotal = processedLines.reduce((sum, l) => sum + l.lineTotal, 0);
  const tax = parseFloat((subtotal * 0.0825).toFixed(2));
  const fee = subtotal > 0 ? 25.00 : 0;
  const total = parseFloat((subtotal + tax + fee).toFixed(2));

  const estimate = db.estimates.createOrUpdate(req.params.roId, {
    lines: processedLines,
    status: status || 'sent',
    summary: {
      subtotal,
      memberDiscount: 0,
      tax,
      shopSuppliesFee: fee,
      total
    }
  });

  // Update RO status
  db.repairOrders.update(req.params.roId, { status: 'estimate_pending' });

  res.status(201).json({ success: true, estimate });
});

// PUT /api/estimates/ro/:roId/line-approval (Customer approves/declines a specific line)
router.put('/ro/:roId/line-approval', (req, res) => {
  const { lineId, approved, signature } = req.body;

  if (!lineId || approved === undefined) {
    return res.status(400).json({ success: false, message: 'lineId and approved (true/false) are required' });
  }

  const updatedEst = db.estimates.updateLineApproval(req.params.roId, lineId, approved);
  if (!updatedEst) {
    return res.status(404).json({ success: false, message: 'Estimate or line not found' });
  }

  if (signature) {
    updatedEst.customerSignature = signature;
    updatedEst.customerApprovedAt = new Date().toISOString();
  }

  // If at least one item is approved, update RO to 'work_authorized' so technician can proceed!
  const hasApprovedWork = updatedEst.lines.some(l => l.approved === true);
  if (hasApprovedWork) {
    db.repairOrders.update(req.params.roId, { status: 'work_authorized' });
  }

  res.json({ success: true, estimate: updatedEst });
});

// POST /api/estimates/ro/:roId/approve-all (Quick approve all lines)
router.post('/ro/:roId/approve-all', (req, res) => {
  const { signature } = req.body;
  const est = db.estimates.findByRoId(req.params.roId);
  if (!est) {
    return res.status(404).json({ success: false, message: 'Estimate not found' });
  }

  est.lines.forEach(l => {
    l.approved = true;
  });
  est.status = 'approved';
  est.customerSignature = signature || 'Digital Authorization on Tablet/Phone';
  est.customerApprovedAt = new Date().toISOString();

  const subtotal = est.lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const discount = parseFloat((subtotal * 0.1).toFixed(2));
  const tax = parseFloat(((subtotal - discount) * 0.0825).toFixed(2));
  const fee = 25.00;
  est.summary = {
    subtotal,
    memberDiscount: discount,
    tax,
    shopSuppliesFee: fee,
    total: parseFloat((subtotal - discount + tax + fee).toFixed(2))
  };

  db.repairOrders.update(req.params.roId, { status: 'work_authorized' });
  db.estimates.createOrUpdate(req.params.roId, est);

  res.json({ success: true, estimate: est });
});

export default router;
