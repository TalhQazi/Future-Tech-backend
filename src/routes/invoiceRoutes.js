import express from 'express';
import { db } from '../data/store.js';

const router = express.Router();

// GET /api/v1/invoices (All invoices for accounting & payments board)
router.get('/', (req, res) => {
  const { status, customerId } = req.query;
  const ros = db.repairOrders.find();
  const allInvoices = [];

  ros.forEach(r => {
    let inv = db.invoices.findByRoId(r.id);
    if (!inv) {
      inv = db.invoices.createFromEstimate(r.id);
    }
    if (inv) {
      const cust = db.customers.findById(inv.customerId || r.customerId);
      const veh = db.vehicles.findById(inv.vehicleId || r.vehicleId);
      allInvoices.push({
        ...inv,
        roNumber: r.roNumber,
        customerName: cust?.name || 'Customer',
        customerPhone: cust?.phone || '',
        vehicleName: veh ? `${veh.year} ${veh.make} ${veh.model}` : 'Vehicle'
      });
    }
  });

  let filtered = allInvoices;
  if (status) {
    filtered = filtered.filter(i => i.paymentStatus === status);
  }
  if (customerId) {
    filtered = filtered.filter(i => i.customerId === customerId);
  }

  res.json({ success: true, count: filtered.length, invoices: filtered });
});

// GET /api/v1/invoices/ro/:roId
router.get('/ro/:roId', (req, res) => {
  let invoice = db.invoices.findByRoId(req.params.roId);
  if (!invoice) {
    // Generate invoice on demand from approved estimate
    invoice = db.invoices.createFromEstimate(req.params.roId);
  }
  if (!invoice) {
    return res.status(404).json({ success: false, message: 'No estimate or invoice available for this RO' });
  }
  res.json({ success: true, invoice });
});

// POST /api/v1/invoices/ro/:roId/pay (Process PCI-compliant simulated card / fleet / cash payment)
router.post('/ro/:roId/pay', (req, res) => {
  const { paymentMethod, cardLast4, customerNotes, amount } = req.body;

  // Enforce security rule: NEVER store raw card numbers
  if (req.body.cardNumber) {
    console.warn('⚠️ Raw card number intercepted and sanitized. Never stored in database!');
    delete req.body.cardNumber;
    delete req.body.cvv;
  }

  const invoice = db.invoices.processPayment(req.params.roId, {
    paymentMethod: paymentMethod || 'credit_card',
    cardLast4: cardLast4 || '4242',
    amount: amount ? parseFloat(amount) : null
  });

  if (!invoice) {
    return res.status(400).json({ success: false, message: 'Could not process payment for this repair order' });
  }

  // Record audit log
  db.audit.create({
    eventType: 'FINANCIAL_PAYMENT_PROCESSED',
    entityType: 'Invoice',
    entityId: invoice.id,
    action: `Processed payment of $${invoice.amountPaid} via ${paymentMethod || 'card'} (auth: ${invoice.paymentProviderTxId})`
  });

  // Update vehicle status to ready_for_pickup
  const ro = db.repairOrders.findById(req.params.roId);
  if (ro && ro.vehicleId) {
    db.vehicles.update(ro.vehicleId, { status: 'ready_for_pickup' });
  }

  res.json({
    success: true,
    message: 'Payment confirmed by payment gateway.',
    invoice
  });
});

// POST /api/v1/invoices/ro/:roId/adjustment (Controlled refund or goodwill adjustment)
router.post('/ro/:roId/adjustment', (req, res) => {
  const { amount, reason, type } = req.body;
  const invoice = db.invoices.findByRoId(req.params.roId);
  if (!invoice) {
    return res.status(404).json({ success: false, message: 'Invoice not found' });
  }

  const adjAmount = parseFloat(amount) || 0;
  if (!invoice.financialAdjustments) invoice.financialAdjustments = [];
  invoice.financialAdjustments.push({
    type: type || 'refund',
    amount: adjAmount,
    reason: reason || 'Customer satisfaction policy',
    authorizedBy: 'Shop Manager',
    date: new Date().toISOString()
  });

  if (type === 'refund') {
    invoice.amountPaid = Math.max(0, invoice.amountPaid - adjAmount);
    if (invoice.amountPaid === 0) invoice.paymentStatus = 'refunded';
  }

  db.audit.create({
    eventType: 'FINANCIAL_ADJUSTMENT_POSTED',
    entityType: 'Invoice',
    entityId: invoice.id,
    action: `Financial adjustment ${type} of $${adjAmount} authorized for ${invoice.invoiceNumber}. Reason: ${reason}`
  });

  res.json({ success: true, invoice, message: `Financial adjustment of $${adjAmount} posted.` });
});

export default router;
