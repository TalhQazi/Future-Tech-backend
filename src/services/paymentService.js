import { withTransaction } from '../config/db.js';
import { Invoice, Payment, Refund, FinancialAdjustment, Location, Reconciliation } from '../models/index.js';
import { audit } from './audit.js';
import { nextNumber, shortCode } from './sequence.js';
import { recomputeBalance } from './invoiceService.js';
import { activateFromPayment } from './membershipService.js';
import { stripeAdapter } from '../adapters/payments.js';
import { queueEconomics } from './economicsService.js';
import { assertLocation, assertCustomerScope } from '../security/access.js';
import { notFound, conflict, badRequest, forbidden, unprocessable } from '../lib/errors.js';
import { localDate, isDateString } from '../lib/time.js';
import { toDTO } from '../lib/http.js';

const loadPostedInvoice = async (auth, invoiceId, session = null) => {
  const inv = await Invoice.findOne({ id: invoiceId }).session(session).lean();
  if (!inv) throw notFound('Invoice');
  if (auth.role === 'customer') assertCustomerScope(auth, inv.customerId);
  else assertLocation(auth, inv.locationId);
  if (inv.status !== 'posted') throw conflict('Only posted invoices accept payments');
  return inv;
};

const afterPayment = async (invoice, session) => {
  const updated = await recomputeBalance(invoice.id, session);
  if (invoice.kind === 'membership' && updated.balanceCents <= 0) await activateFromPayment(invoice.membershipId, session);
};

// In-store payment recorded by staff. Card data is never accepted; for card
// terminals only the approval code and last four digits from the receipt.
export const recordManualPayment = async (req, invoiceId, { amountCents, method, reference, cardLast4, note }) => {
  if (['check', 'card_terminal', 'ach'].includes(method) && !reference) throw badRequest('A reference (check number / approval code / ACH trace) is required');
  const location = await Location.findOne({ id: (await Invoice.findOne({ id: invoiceId }).lean())?.locationId }).lean();
  const payment = await withTransaction(async (session) => {
    const inv = await loadPostedInvoice(req.auth, invoiceId, session);
    if (amountCents > inv.balanceCents) throw unprocessable(`Amount exceeds the balance due (${inv.balanceCents} cents)`, undefined, 'OVERPAYMENT');
    const now = new Date();
    const [p] = await Payment.create([{
      receiptNumber: await nextNumber('RCPT', shortCode(location.code), now.getUTCFullYear(), session),
      invoiceId, customerId: inv.customerId, locationId: inv.locationId, currency: inv.currency, amountCents, method,
      provider: 'manual', providerRef: reference, cardLast4: method === 'card_terminal' ? cardLast4 : undefined,
      status: 'succeeded', receivedBy: req.auth.userId, receivedByName: req.auth.user.name, receivedAt: now,
      businessDate: localDate(now, location.timezone), note
    }], { session });
    await afterPayment(inv, session);
    await audit(req, { eventType: 'PAYMENT_RECORDED', category: 'financial', entityType: 'Invoice', entityId: invoiceId, locationId: inv.locationId, action: `${p.receiptNumber}: ${amountCents} cents by ${method}${reference ? ` (ref ${reference})` : ''}` }, session);
    return p;
  });
  await queueEconomics('payment', { paymentId: payment.id }, payment.id);
  return toDTO(payment.toObject());
};

// Online card payment (customer portal or staff) through Stripe, when configured.
export const createOnlinePayment = async (req, invoiceId, { amountCents }) => {
  const inv = await loadPostedInvoice(req.auth, invoiceId);
  const amount = amountCents || inv.balanceCents;
  if (amount <= 0 || amount > inv.balanceCents) throw badRequest('Invalid payment amount');
  const location = await Location.findOne({ id: inv.locationId }).lean();
  const now = new Date();
  const payment = await Payment.create({
    receiptNumber: await nextNumber('RCPT', shortCode(location.code), now.getUTCFullYear()),
    invoiceId, customerId: inv.customerId, locationId: inv.locationId, currency: inv.currency, amountCents: amount,
    method: 'card_online', provider: 'stripe', status: 'pending', receivedBy: req.auth.userId, businessDate: localDate(now, location.timezone)
  });
  try {
    const intent = await stripeAdapter.createPaymentIntent({
      amountCents: amount, currency: inv.currency, idempotencyKey: `pay-${payment.id}`,
      description: `Invoice ${inv.invoiceNumber}`, metadata: { invoiceId, paymentId: payment.id }
    });
    await Payment.updateOne({ id: payment.id }, { $set: { providerRef: intent.id, providerStatus: intent.status } });
    return { paymentId: payment.id, clientSecret: intent.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null };
  } catch (err) {
    await Payment.updateOne({ id: payment.id }, { $set: { status: 'failed', failureReason: err.message } });
    await queueEconomics('payment', { paymentId: payment.id }, `${payment.id}:failed`);
    throw err;
  }
};

const applyIntent = async (payment, intent) => {
  const card = intent.latest_charge?.payment_method_details?.card;
  const status = intent.status === 'succeeded' ? 'succeeded' : ['canceled', 'requires_payment_method'].includes(intent.status) ? 'failed' : 'pending';
  if (status === payment.status) return payment;
  await withTransaction(async (session) => {
    const res = await Payment.updateOne({ id: payment.id, status: 'pending' }, {
      $set: { status, providerStatus: intent.status, receivedAt: status === 'succeeded' ? new Date() : undefined, cardBrand: card?.brand, cardLast4: card?.last4 }
    }, { session });
    if (res.modifiedCount && status === 'succeeded') {
      const inv = await Invoice.findOne({ id: payment.invoiceId }).session(session).lean();
      await afterPayment(inv, session);
      await audit(null, { eventType: 'PAYMENT_RECORDED', category: 'financial', entityType: 'Invoice', entityId: payment.invoiceId, locationId: payment.locationId, actorId: 'stripe', actorRole: 'payment_provider', action: `${payment.receiptNumber}: ${payment.amountCents} cents online card (${intent.id})` }, session);
    }
  });
  if (status === 'succeeded') await queueEconomics('payment', { paymentId: payment.id }, payment.id);
  if (status === 'failed') await queueEconomics('payment', { paymentId: payment.id }, `${payment.id}:failed`);
  return Payment.findOne({ id: payment.id }).lean();
};

export const syncOnlinePayment = async (req, paymentId) => {
  const payment = await Payment.findOne({ id: paymentId, provider: 'stripe' }).lean();
  if (!payment) throw notFound('Payment');
  if (req.auth.role === 'customer') assertCustomerScope(req.auth, payment.customerId);
  else assertLocation(req.auth, payment.locationId);
  if (!payment.providerRef) throw conflict('Payment was not started with the provider');
  return toDTO(await applyIntent(payment, await stripeAdapter.retrievePaymentIntent(payment.providerRef)));
};

export const handleStripeWebhook = async (rawBody, signature) => {
  if (!stripeAdapter.verifyWebhook(rawBody, signature)) throw forbidden('Invalid webhook signature');
  const event = JSON.parse(rawBody);
  if (!['payment_intent.succeeded', 'payment_intent.payment_failed'].includes(event.type)) return { ignored: true };
  const payment = await Payment.findOne({ provider: 'stripe', providerRef: event.data.object.id }).lean();
  if (!payment) return { ignored: true };
  await applyIntent(payment, await stripeAdapter.retrievePaymentIntent(payment.providerRef));
  return { processed: true };
};

// ---------------------------------------------------------------------------
// Refunds (requester and approver must be different people)
// ---------------------------------------------------------------------------
export const requestRefund = async (req, paymentId, { amountCents, reason }) => {
  const payment = await Payment.findOne({ id: paymentId, status: 'succeeded' }).lean();
  if (!payment) throw notFound('Succeeded payment');
  assertLocation(req.auth, payment.locationId);
  const pending = await Refund.find({ paymentId, status: { $in: ['pending_approval', 'approved', 'processing', 'succeeded'] } }).lean();
  const committed = pending.reduce((s, r) => s + r.amountCents, 0);
  if (amountCents > payment.amountCents - committed) throw unprocessable(`At most ${payment.amountCents - committed} cents can still be refunded`);
  const location = await Location.findOne({ id: payment.locationId }).lean();
  const refund = await Refund.create({
    refundNumber: await nextNumber('RFD', shortCode(location.code), new Date().getUTCFullYear()),
    paymentId, invoiceId: payment.invoiceId, locationId: payment.locationId, currency: payment.currency, amountCents, reason,
    method: payment.method, provider: payment.provider, requestedBy: req.auth.userId, requestedByName: req.auth.user.name
  });
  await audit(req, { eventType: 'REFUND_REQUESTED', category: 'financial', entityType: 'Refund', entityId: refund.id, locationId: payment.locationId, action: `Refund ${refund.refundNumber} of ${amountCents} cents requested on ${payment.receiptNumber}`, reason });
  return toDTO(refund);
};

export const decideRefund = async (req, refundId, { approve, note }) => {
  const refund = await Refund.findOne({ id: refundId }).lean();
  if (!refund) throw notFound('Refund');
  assertLocation(req.auth, refund.locationId);
  if (refund.status !== 'pending_approval') throw conflict(`Refund is ${refund.status}`);
  if (refund.requestedBy === req.auth.userId) throw forbidden('A different person must approve this refund');
  if (!approve) {
    const r = await Refund.findOneAndUpdate({ id: refundId, status: 'pending_approval' }, { $set: { status: 'rejected', rejectedBy: req.auth.userId, rejectionReason: note } }, { new: true }).lean();
    await audit(req, { eventType: 'REFUND_REJECTED', category: 'financial', entityType: 'Refund', entityId: refundId, locationId: refund.locationId, action: `Rejected ${refund.refundNumber}`, reason: note });
    return toDTO(r);
  }
  const claimed = await Refund.findOneAndUpdate({ id: refundId, status: 'pending_approval' }, { $set: { status: 'processing', approvedBy: req.auth.userId, approvedAt: new Date() } }, { new: true }).lean();
  if (!claimed) throw conflict('Refund already decided');
  let providerRef;
  if (refund.provider === 'stripe') {
    const payment = await Payment.findOne({ id: refund.paymentId }).lean();
    try {
      providerRef = (await stripeAdapter.createRefund({ paymentIntentId: payment.providerRef, amountCents: refund.amountCents, idempotencyKey: `refund-${refund.id}`, reason: refund.reason })).id;
    } catch (err) {
      await Refund.updateOne({ id: refundId }, { $set: { status: 'failed', failureReason: err.message } });
      throw err;
    }
  }
  const location = await Location.findOne({ id: refund.locationId }).lean();
  await withTransaction(async (session) => {
    const now = new Date();
    await Refund.updateOne({ id: refundId }, { $set: { status: 'succeeded', providerRef, processedAt: now, businessDate: localDate(now, location.timezone) } }, { session });
    await Payment.updateOne({ id: refund.paymentId }, { $inc: { refundedCents: refund.amountCents } }, { session });
    await recomputeBalance(refund.invoiceId, session);
    await audit(req, { eventType: 'REFUND_APPROVED', category: 'financial', entityType: 'Refund', entityId: refundId, locationId: refund.locationId, action: `Approved and processed ${refund.refundNumber} (${refund.amountCents} cents via ${refund.provider})`, reason: note }, session);
  });
  await queueEconomics('refund', { refundId }, refundId);
  return toDTO(await Refund.findOne({ id: refundId }).lean());
};

// ---------------------------------------------------------------------------
// Adjustments: the only way to correct a posted invoice
// ---------------------------------------------------------------------------
export const createAdjustment = async (req, invoiceId, { type, amountCents, reason, reversesAdjustmentId }) => {
  const result = await withTransaction(async (session) => {
    const inv = await loadPostedInvoice(req.auth, invoiceId, session);
    let direction = type === 'debit_memo' ? 'debit' : 'credit';
    if (type === 'reversal') {
      const original = await FinancialAdjustment.findOne({ id: reversesAdjustmentId, invoiceId }).session(session).lean();
      if (!original) throw notFound('Adjustment to reverse');
      if (await FinancialAdjustment.exists({ reversesAdjustmentId }).session(session)) throw conflict('Adjustment already reversed');
      direction = original.direction === 'credit' ? 'debit' : 'credit';
      amountCents = original.amountCents;
    }
    if (type === 'write_off' && amountCents > inv.balanceCents) throw unprocessable('Write-off cannot exceed the balance due');
    const location = await Location.findOne({ id: inv.locationId }).session(session).lean();
    const [adj] = await FinancialAdjustment.create([{
      invoiceId, locationId: inv.locationId, type, direction, amountCents, currency: inv.currency, reason, reversesAdjustmentId,
      createdBy: req.auth.userId, createdByName: req.auth.user.name, approvedBy: req.auth.userId, businessDate: localDate(new Date(), location.timezone)
    }], { session });
    await recomputeBalance(invoiceId, session);
    await audit(req, { eventType: 'FINANCIAL_ADJUSTMENT_POSTED', category: 'financial', entityType: 'Invoice', entityId: invoiceId, locationId: inv.locationId, action: `${type} (${direction}) of ${amountCents} cents on ${inv.invoiceNumber}`, reason }, session);
    return adj;
  });
  await queueEconomics('adjustment', { adjustmentId: result.id }, result.id);
  return toDTO(result.toObject());
};

// ---------------------------------------------------------------------------
// Daily reconciliation per location business day
// ---------------------------------------------------------------------------
export const dailySummary = async (auth, { locationId, businessDate }) => {
  assertLocation(auth, locationId);
  if (!isDateString(businessDate)) throw badRequest('businessDate must be YYYY-MM-DD');
  const [payments, refunds, existing] = await Promise.all([
    Payment.find({ locationId, businessDate, status: 'succeeded' }).lean(),
    Refund.find({ locationId, businessDate, status: 'succeeded' }).lean(),
    Reconciliation.findOne({ locationId, businessDate }).lean()
  ]);
  const expected = {};
  for (const p of payments) expected[p.method] = (expected[p.method] || 0) + p.amountCents;
  for (const r of refunds) expected[r.method] = (expected[r.method] || 0) - r.amountCents;
  return { locationId, businessDate, expected, payments: toDTO(payments), refunds: toDTO(refunds), reconciliation: existing ? toDTO(existing) : null };
};

export const closeReconciliation = async (req, { locationId, businessDate, counted, notes }) => {
  const summary = await dailySummary(req.auth, { locationId, businessDate });
  if (summary.reconciliation?.status === 'closed') throw conflict('This business day is already reconciled');
  const methods = new Set([...Object.keys(summary.expected), ...Object.keys(counted)]);
  const variance = Object.fromEntries([...methods].map(m => [m, (counted[m] || 0) - (summary.expected[m] || 0)]));
  const doc = await Reconciliation.findOneAndUpdate({ locationId, businessDate, status: { $ne: 'closed' } }, {
    $set: {
      status: 'closed', expected: summary.expected, counted, variance, notes, closedBy: req.auth.userId, closedAt: new Date(),
      paymentIds: summary.payments.map(p => p.id), refundIds: summary.refunds.map(r => r.id)
    }
  }, { upsert: true, new: true }).lean();
  const hasVariance = Object.values(variance).some(v => v !== 0);
  await audit(req, { eventType: 'DAY_RECONCILED', category: 'financial', entityType: 'Reconciliation', entityId: doc.id, locationId, action: `Reconciled ${businessDate}${hasVariance ? ` with variance ${JSON.stringify(variance)}` : ' (balanced)'}`, reason: notes });
  return toDTO(doc);
};
