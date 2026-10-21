import express from 'express';
import { db } from '../data/store.js';
import { protect, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// GET /api/v1/inventory (Search and list catalog)
router.get('/', (req, res) => {
  const { q, category } = req.query;
  let items;
  if (q) {
    items = db.inventory.search(q);
  } else {
    items = db.inventory.find();
  }

  if (category) {
    items = items.filter(i => i.category.toLowerCase().includes(category.toLowerCase()));
  }

  res.json({ success: true, count: items.length, inventory: items });
});

// GET /api/v1/inventory/low-stock (Alerts on parts below minStockLevel)
router.get('/low-stock', (req, res) => {
  const lowStock = db.inventory.find(i => i.stockQuantity <= i.minStockLevel);
  res.json({ success: true, count: lowStock.length, lowStock });
});

// GET /api/v1/inventory/failure-intelligence (Parts reliability and repeat failure comeback rates)
router.get('/failure-intelligence', (req, res) => {
  const parts = db.inventory.find();
  const ranked = parts.map(p => ({
    partNumber: p.partNumber,
    description: p.description,
    brand: p.brand,
    supplier: p.supplier,
    warrantyMonths: p.warrantyMonths,
    totalInstalled: p.failureStats?.totalInstalled || 0,
    totalFailed: p.failureStats?.totalFailed || 0,
    comebackRate: p.failureStats?.comebackRate || '0.0%',
    reliabilityGrade: (p.failureStats?.totalFailed || 0) === 0 ? 'A+' : (p.failureStats?.totalFailed || 0) <= 2 ? 'A' : 'B-'
  })).sort((a, b) => (b.totalFailed) - (a.totalFailed));

  res.json({ success: true, count: ranked.length, reliabilityReport: ranked });
});

// GET /api/v1/inventory/:id
router.get('/:id', (req, res) => {
  const item = db.inventory.findById(req.params.id);
  if (!item) {
    return res.status(404).json({ success: false, message: 'Part not found in inventory' });
  }
  res.json({ success: true, part: item });
});

// POST /api/v1/inventory (Add new catalog part)
router.post('/', (req, res) => {
  const { partNumber, description, category, brand, supplier, costPrice, retailPrice, stockQuantity, minStockLevel, binLocation, warrantyMonths } = req.body;

  if (!partNumber || !description) {
    return res.status(400).json({ success: false, message: 'Part number and description are required' });
  }

  const existing = db.inventory.findById(partNumber);
  if (existing) {
    return res.status(400).json({ success: false, message: 'Part number already exists in warehouse catalog' });
  }

  const newPart = db.inventory.create({
    partNumber: partNumber.toUpperCase().trim(),
    description,
    category: category || 'General Mechanical',
    brand: brand || 'OEM Direct',
    supplier: supplier || 'WorldPac Parts',
    costPrice: parseFloat(costPrice) || 0,
    retailPrice: parseFloat(retailPrice) || 0,
    stockQuantity: parseInt(stockQuantity) || 0,
    minStockLevel: parseInt(minStockLevel) || 2,
    binLocation: binLocation || 'Main Staging',
    warrantyMonths: parseInt(warrantyMonths) || 12
  });

  res.status(201).json({ success: true, part: newPart });
});

// POST /api/v1/inventory/:id/adjust (Manual stock adjustment or cycle count)
router.post('/:id/adjust', (req, res) => {
  const { delta, reason } = req.body;
  if (delta === undefined) {
    return res.status(400).json({ success: false, message: 'Adjustment delta (integer) is required' });
  }

  const updated = db.inventory.adjustStock(req.params.id, parseInt(delta), reason || 'manual_adjustment');
  if (!updated) {
    return res.status(404).json({ success: false, message: 'Part not found' });
  }

  res.json({ success: true, part: updated, message: `Stock adjusted by ${delta}. Current balance: ${updated.stockQuantity}` });
});

export default router;
