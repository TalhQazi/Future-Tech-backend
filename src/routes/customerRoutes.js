import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/customers?q=...
router.get('/', (req, res) => {
  const { q } = req.query;
  const customers = db.customers.search(q);
  res.json({ success: true, count: customers.length, customers });
});

// GET /api/customers/:id
router.get('/:id', (req, res) => {
  const customer = db.customers.findById(req.params.id);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }
  const vehicles = db.vehicles.findByCustomerId(customer.id);
  res.json({ success: true, customer: { ...customer, vehicles } });
});

// POST /api/customers
router.post('/', (req, res) => {
  const { name, phone, email, address, membershipTier } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ success: false, message: 'Customer name and phone are required' });
  }

  const newCustomer = db.customers.create({
    name,
    phone,
    email: email || '',
    address: address || '',
    membership: {
      tier: membershipTier || 'Standard',
      status: 'active',
      number: `MBR-${Math.floor(10000 + Math.random() * 90000)}`,
      renewDate: new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0],
      benefits: membershipTier === 'VIP Gold Care'
        ? ['Free Diagnostics', '15% Off Labor', 'Complimentary Loaner Vehicle']
        : ['Standard Shop Warranty']
    }
  });

  res.status(201).json({ success: true, customer: newCustomer });
});

// PUT /api/customers/:id/membership
router.put('/:id/membership', (req, res) => {
  const { tier, status } = req.body;
  const customer = db.customers.findById(req.params.id);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  const updatedMembership = {
    ...customer.membership,
    tier: tier || customer.membership.tier,
    status: status || customer.membership.status
  };

  const updated = db.customers.update(req.params.id, { membership: updatedMembership });
  res.json({ success: true, customer: updated });
});

export default router;
