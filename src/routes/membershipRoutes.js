import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/memberships/plans
router.get('/plans', (req, res) => {
  const plans = db.memberships.getPlans();
  res.json({ success: true, count: plans.length, plans });
});

// GET /api/v1/memberships/riders
router.get('/riders', (req, res) => {
  const riders = db.memberships.getRiders();
  res.json({ success: true, count: riders.length, riders });
});

// GET /api/v1/memberships/customer/:customerId/entitlements
router.get('/customer/:customerId/entitlements', (req, res) => {
  const entitlements = db.memberships.getCustomerEntitlements(req.params.customerId);
  if (!entitlements) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }
  res.json({ success: true, entitlements });
});

// POST /api/v1/memberships/customer/:customerId/upgrade
router.post('/customer/:customerId/upgrade', (req, res) => {
  const { tier, riderIds } = req.body;
  const customer = db.customers.findById(req.params.customerId);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  const plans = db.memberships.getPlans();
  const targetPlan = plans.find(p => p.tier === tier);
  if (!targetPlan) {
    return res.status(400).json({ success: false, message: 'Invalid membership tier' });
  }

  const updatedMembership = {
    ...customer.membership,
    tier: targetPlan.tier,
    status: 'active',
    renewDate: new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0],
    benefits: targetPlan.benefits,
    activeRiders: riderIds || customer.membership?.activeRiders || []
  };

  const updatedCustomer = db.customers.update(customer.id, { membership: updatedMembership });

  db.audit.create({
    eventType: 'MEMBERSHIP_UPGRADED',
    entityType: 'Customer',
    entityId: customer.id,
    action: `Upgraded customer ${customer.name} to tier ${targetPlan.tier}`
  });

  res.json({ success: true, customer: updatedCustomer, message: `Successfully upgraded to ${targetPlan.tier}` });
});

export default router;
