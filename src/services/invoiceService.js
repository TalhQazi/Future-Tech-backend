import { withTransaction } from '../config/db.js';
import { Invoice, Payment, Refund, FinancialAdjustment, RepairOrder, Location, Customer, Vehicle } from '../models/index.js';
import { audit } from './audit.js';
import { nextNumber, shortCode } from './sequence.js';
import { authorizedLinesForRo } from './estimateService.js';
import { recordEntitlementUsage } from './membershipService.js';
import { timelineEvent } from './roService.js';
import { queueEconomics } from './economicsService.js';
import { findRoForAccess, assertLocation, locationFilter, assertCustomerScope, projectCustomer } from '../security/access.js';
import { notFound, conflict, unprocessable, badRequest } from '../lib/errors.js';
import { roundDiv } from '../lib/money.js';
import { localDate } from '../lib/time.js';
import { toDTO, paginationMeta } from '../lib/http.js';

const allocate = (total, weights) => {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - floors[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => {
    if (rest > 0) { floors[i] += 1; rest -= 1; }
  });
  return floors;
};

/**
 * Recomputes balances from the underlying financial records. Balances are
 * derived data; payments, refunds and adjustments are the source of truth.
 */
export const recomputeBalance = async (invoiceId, session = null) => {
  const invoice = await Invoice.findOne({ id: invoiceId }).session(session).lean();
  if (!invoice || invoice.status !== 'posted') return invoice;
  const [payments, refunds, adjustments] = await Promise.all([
    Payment.find({ invoiceId, status: 'succeeded' }).session(session).lean(),
    Refund.find({ invoiceId, status: 'succeeded' }).session(session).lean(),
    FinancialAdjustment.find({ invoiceId }).session(session).lean()
  ]);
  const paidCents = payments.reduce((s, p) => s + p.amountCents, 0);
  const refundedCents = refunds.reduce((s, r) => s + r.amountCents, 0);
  const creditsCents = adjustments.filter(a => a.direction === 'credit').reduce((s, a) => s + a.amountCents, 0);
  const debitsCents = adjustments.filter(a => a.direction === 'debit').reduce((s, a) => s + a.amountCents, 0);
  const balanceCents = invoice.totals.totalCents + debitsCents - creditsCents - paidCents + refundedCents;
  const writtenOff = adjustments.some(a => a.type === 'write_off');
  const netPaid = paidCents - refundedCents;
  const paymentStatus = balanceCents < 0 ? 'overpaid'
    : balanceCents === 0 ? (writtenOff && netPaid < invoice.totals.totalCents ? 'written_off' : 'paid')
      : paidCents > 0 && refundedCents >= paidCents ? 'refunded'
        : netPaid > 0 ? 'partial' : 'unpaid';
  await Invoice.updateOne({ id: invoiceId }, { $set: { paidCents, refundedCents, creditsCents, debitsCents, balanceCents, paymentStatus }, $inc: { __v: 1 } }, { session });
  return { ...invoice, paidCents, refundedCents, creditsCents, debitsCents, balanceCents, paymentStatus };
};

const buildRoInvoiceContent = async (ro, session) => {
  const { version, lines } = await authorizedLinesForRo(ro.id, session);
  if (!version || !lines.length) throw unprocessable('There is no customer-approved work to invoice', undefined, 'NOTHING_TO_INVOICE');
  const location = await Location.findOne({ id: ro.locationId }).session(session).lean();
  const taxRateBps = version.pricingContext?.taxRateBps ?? location.taxRateBps ?? 0;
  const taxable = lines.filter(l => l.taxable && l.netCents > 0);
  const taxableCents = taxable.reduce((s, l) => s + l.netCents, 0);
  const taxCents = roundDiv(taxableCents * taxRateBps, 10_000);
  const shares = allocate(taxCents, taxable.map(l => l.netCents));
  const taxByLine = new Map(taxable.map((l, i) => [l.id, shares[i]]));
  const jobByLine = new Map(ro.jobs.flatMap(j => j.estimateLineIds.map(id => [id, j.id])));
  const lineItems = lines.map(l => {
    const tax = taxByLine.get(l.id) || 0;
    return {
      id: l.id, kind: l.kind, description: l.description, quantity: l.quantity, hours: l.hours,
      unitPriceCents: l.kind === 'labor' ? l.rateCents : l.unitPriceCents, extendedCents: l.extendedCents,
      discountCents: l.discountCents || 0, netCents: l.netCents, taxCents: tax, totalCents: l.netCents + tax,
      unitCostCents: l.unitCostCents, estimateVersionId: version.id, estimateLineId: l.id, approvalId: l.approvalId,
      jobId: jobByLine.get(l.id), partId: l.partId, laborOpCode: l.laborOpCode
    };
  });
  const sum = (kind) => lineItems.filter(l => l.kind === kind).reduce((s, l) => s + l.extendedCents, 0);
  const discountCents = lineItems.reduce((s, l) => s + l.discountCents, 0);
  const extended = lineItems.reduce((s, l) => s + l.extendedCents, 0);
  const approvedIds = new Set(lines.map(l => l.id));
  const evaluation = version.membershipEvaluation
    ? { ...version.membershipEvaluation, applied: (version.membershipEvaluation.applied || []).filter(a => approvedIds.has(a.lineId)) }
    : null;
  return {
    currency: version.currency || location.currency,
    lineItems,
    totals: {
      laborCents: sum('labor'), partsCents: sum('part'), feesCents: sum('fee'), subletCents: sum('sublet'),
      discountCents, subtotalCents: extended - discountCents, taxCents, totalCents: extended - discountCents + taxCents
    },
    sourceEstimateVersionIds: [version.id],
    approvalIds: [...new Set(lines.map(l => l.approvalId).filter(Boolean))],
    membershipEvaluation: evaluation
  };
};

export const generateInvoice = async (req, roIdOrNumber) => {
  const ro = await findRoForAccess(req.auth, roIdOrNumber);
  if (['cancelled', 'closed'].includes(ro.status)) throw conflict(`Repair order is ${ro.status}`);
  const location = await Location.findOne({ id: ro.locationId }).lean();
  const invoice = await withTransaction(async (session) => {
    const content = await buildRoInvoiceContent(ro, session);
    const existing = await Invoice.findOne({ roId: ro.id, kind: 'repair_order', status: { $ne: 'voided' } }).session(session);
    if (existing?.status === 'posted') throw conflict('The invoice is already posted. Use an adjustment to correct it.', 'INVOICE_POSTED');
    let doc;
    if (existing) {
      doc = await Invoice.findOneAndUpdate({ id: existing.id, status: 'draft' }, { $set: { ...content, balanceCents: content.totals.totalCents }, $inc: { __v: 1 } }, { new: true, session });
    } else {
      [doc] = await Invoice.create([{
        invoiceNumber: await nextNumber('INV', shortCode(location.code), new Date().getUTCFullYear(), session),
        kind: 'repair_order', roId: ro.id, customerId: ro.customerId, vehicleId: ro.vehicleId, locationId: ro.locationId,
        status: 'draft', ...content, balanceCents: content.totals.totalCents, createdBy: req.auth.userId
      }], { session });
      await RepairOrder.updateOne({ id: ro.id }, { $set: { invoiceId: doc.id } }, { session });
    }
    await audit(req, { eventType: existing ? 'INVOICE_DRAFT_REFRESHED' : 'INVOICE_DRAFTED', category: 'financial', entityType: 'Invoice', entityId: doc.id, locationId: ro.locationId, action: `${existing ? 'Refreshed' : 'Drafted'} invoice ${doc.invoiceNumber} for ${ro.roNumber}: ${content.totals.totalCents} cents` }, session);
    return doc;
  });
  return getInvoice(req.auth, invoice.id);
};

export const postInvoice = async (req, invoiceId) => {
  const invoice = await Invoice.findOne({ id: invoiceId }).lean();
  if (!invoice) throw notFound('Invoice');
  assertLocation(req.auth, invoice.locationId);
  if (invoice.status !== 'draft') throw conflict(`Invoice is ${invoice.status}`);
  const location = await Location.findOne({ id: invoice.locationId }).lean();
  await withTransaction(async (session) => {
    if (invoice.kind === 'repair_order') {
      const ro = await RepairOrder.findOne({ id: invoice.roId }).session(session).lean();
      const unfinished = ro.jobs.filter(j => ['authorized', 'in_progress', 'paused'].includes(j.status));
      if (unfinished.length) throw unprocessable(`Finish all authorized work before posting (${unfinished.length} job(s) open)`, undefined, 'JOBS_INCOMPLETE');
      // the approved content must not have changed since the draft was built
      const content = await buildRoInvoiceContent(ro, session);
      if (content.totals.totalCents !== invoice.totals.totalCents || content.lineItems.length !== invoice.lineItems.length) {
        throw conflict('Approved work changed since this draft was created. Refresh the invoice first.', 'INVOICE_STALE');
      }
      await RepairOrder.updateOne({ id: ro.id }, { $push: { timeline: timelineEvent(req.auth, 'invoice', `Invoice ${invoice.invoiceNumber} issued`, true) } }, { session });
    }
    const now = new Date();
    const res = await Invoice.updateOne({ id: invoiceId, status: 'draft', __v: invoice.__v }, {
      $set: { status: 'posted', postedAt: now, postedBy: req.auth.userId, businessDate: localDate(now, location.timezone), balanceCents: invoice.totals.totalCents },
      $inc: { __v: 1 }
    }, { session });
    if (res.modifiedCount !== 1) throw conflict('Invoice changed; reload and try again');
    await recordEntitlementUsage({ evaluation: invoice.membershipEvaluation, roId: invoice.roId, invoiceId, estimateVersionId: invoice.sourceEstimateVersionIds?.[0] }, session);
    await recomputeBalance(invoiceId, session);
    await audit(req, { eventType: 'INVOICE_POSTED', category: 'financial', entityType: 'Invoice', entityId: invoiceId, locationId: invoice.locationId, action: `Posted ${invoice.invoiceNumber}: total ${invoice.totals.totalCents} ${invoice.currency} cents` }, session);
  });
  await queueEconomics('invoice', { invoiceId }, invoiceId);
  return getInvoice(req.auth, invoiceId);
};

export const voidDraftInvoice = async (req, invoiceId, { reason }) => {
  if (!reason) throw badRequest('A reason is required');
  const invoice = await Invoice.findOne({ id: invoiceId }).lean();
  if (!invoice) throw notFound('Invoice');
  assertLocation(req.auth, invoice.locationId);
  const updated = await Invoice.findOneAndUpdate({ id: invoiceId, status: 'draft' }, { $set: { status: 'voided', voidedAt: new Date(), voidedBy: req.auth.userId, voidReason: reason } }, { new: true }).lean();
  if (!updated) throw conflict('Only draft invoices can be voided. Posted invoices are corrected with credit memos.');
  if (invoice.roId) await RepairOrder.updateOne({ id: invoice.roId, invoiceId }, { $unset: { invoiceId: 1 } });
  await audit(req, { eventType: 'INVOICE_DRAFT_VOIDED', category: 'financial', entityType: 'Invoice', entityId: invoiceId, locationId: invoice.locationId, action: `Voided draft ${invoice.invoiceNumber}`, reason });
  return toDTO(updated);
};

export const createMembershipInvoice = async (req, { membership, customer, locationId, plan, riders, cycleMonths, amountCents, currency }, session) => {
  const location = await Location.findOne({ id: locationId }).session(session).lean();
  const now = new Date();
  const lineItems = [
    { id: `${membership.id}:plan`, kind: 'membership', description: `${plan.name} v${plan.version} (${cycleMonths} month${cycleMonths > 1 ? 's' : ''})`, quantity: 1, unitPriceCents: amountCents - riders.reduce((s, r) => s + r.priceMonthlyCents * cycleMonths, 0) },
    ...riders.map(r => ({ id: `${membership.id}:rider:${r.riderId}`, kind: 'membership', description: `${r.name} rider (${cycleMonths} month${cycleMonths > 1 ? 's' : ''})`, quantity: 1, unitPriceCents: r.priceMonthlyCents * cycleMonths }))
  ].map(l => ({ ...l, extendedCents: l.unitPriceCents, discountCents: 0, netCents: l.unitPriceCents, taxCents: 0, totalCents: l.unitPriceCents }));
  const [invoice] = await Invoice.create([{
    invoiceNumber: await nextNumber('INV', shortCode(location.code), now.getUTCFullYear(), session),
    kind: 'membership', membershipId: membership.id, customerId: customer.id, locationId, currency: currency || location.currency,
    status: 'posted', postedAt: now, postedBy: req.auth.userId, businessDate: localDate(now, location.timezone),
    lineItems, totals: { subtotalCents: amountCents, totalCents: amountCents, taxCents: 0, discountCents: 0, laborCents: 0, partsCents: 0, feesCents: 0, subletCents: 0 },
    balanceCents: amountCents, createdBy: req.auth.userId
  }], { session });
  return invoice.toObject();
};

export const listInvoices = async (auth, query) => {
  const { status, paymentStatus, locationId, customerId, from, to, kind, page, limit, skip } = query;
  const filter = {};
  if (auth.role === 'customer') {
    filter.customerId = auth.customerId;
    filter.status = 'posted';
  } else {
    Object.assign(filter, locationFilter(auth));
    if (locationId) {
      assertLocation(auth, locationId);
      filter.locationId = locationId;
    }
    if (customerId) filter.customerId = customerId;
    if (status) filter.status = status;
  }
  if (paymentStatus) filter.paymentStatus = { $in: paymentStatus.split(',') };
  if (kind) filter.kind = kind;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lt = new Date(to);
  }
  const [items, total] = await Promise.all([Invoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), Invoice.countDocuments(filter)]);
  const [customers, vehicles, ros] = await Promise.all([
    Customer.find({ id: { $in: items.map(i => i.customerId) } }).select('id name phone').lean(),
    Vehicle.find({ id: { $in: items.map(i => i.vehicleId).filter(Boolean) } }).select('id year make model').lean(),
    RepairOrder.find({ id: { $in: items.map(i => i.roId).filter(Boolean) } }).select('id roNumber status').lean()
  ]);
  return {
    invoices: items.map(i => ({
      ...toDTO(i), lineItems: undefined, lines: undefined,
      customerName: customers.find(c => c.id === i.customerId)?.name,
      vehicleName: (v => (v ? `${v.year} ${v.make} ${v.model}` : null))(vehicles.find(v => v.id === i.vehicleId)),
      roNumber: ros.find(r => r.id === i.roId)?.roNumber,
      roStatus: ros.find(r => r.id === i.roId)?.status
    })),
    pagination: paginationMeta({ page, limit }, total)
  };
};

export const getInvoice = async (auth, id) => {
  const invoice = await Invoice.findOne({ $or: [{ id }, { invoiceNumber: id }] }).lean();
  if (!invoice) throw notFound('Invoice');
  if (auth.role === 'customer') {
    assertCustomerScope(auth, invoice.customerId);
    if (invoice.status !== 'posted') throw notFound('Invoice');
  } else {
    assertLocation(auth, invoice.locationId);
  }
  const [payments, refunds, adjustments, customer, vehicle, ro, location] = await Promise.all([
    Payment.find({ invoiceId: invoice.id }).sort({ createdAt: 1 }).lean(),
    Refund.find({ invoiceId: invoice.id }).sort({ createdAt: 1 }).lean(),
    FinancialAdjustment.find({ invoiceId: invoice.id }).sort({ at: 1 }).lean(),
    Customer.findOne({ id: invoice.customerId }).lean(),
    invoice.vehicleId ? Vehicle.findOne({ id: invoice.vehicleId }).lean() : null,
    invoice.roId ? RepairOrder.findOne({ id: invoice.roId }).select('id roNumber odometerIn odometerOut concerns').lean() : null,
    Location.findOne({ id: invoice.locationId }).select('id name address city state zip phone timezone').lean()
  ]);
  const unitCostVisible = auth.role !== 'customer';
  return {
    ...toDTO(invoice),
    lineItems: invoice.lineItems.map(l => (unitCostVisible ? l : { ...l, unitCostCents: undefined })),
    payments: toDTO(payments).map(p => (auth.role === 'customer' ? { ...p, receivedBy: undefined, note: undefined } : p)),
    refunds: toDTO(refunds).filter(r => auth.role !== 'customer' || r.status === 'succeeded'),
    adjustments: toDTO(adjustments).filter(() => true),
    customer: customer ? projectCustomer(auth, { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, address: customer.address }) : null,
    vehicle: vehicle ? { id: vehicle.id, year: vehicle.year, make: vehicle.make, model: vehicle.model, vin: vehicle.vin, licensePlate: vehicle.licensePlate } : null,
    repairOrder: ro ? { id: ro.id, roNumber: ro.roNumber, odometerIn: ro.odometerIn, odometerOut: ro.odometerOut, concerns: ro.concerns?.map(c => ({ text: c.text, cause: c.cause, correction: c.correction })) } : null,
    location: toDTO(location)
  };
};

export const getInvoiceForRo = async (auth, roIdOrNumber) => {
  const ro = await findRoForAccess(auth, roIdOrNumber);
  const invoice = await Invoice.findOne({ roId: ro.id, status: auth.role === 'customer' ? 'posted' : { $ne: 'voided' } }).lean();
  if (!invoice) return null;
  return getInvoice(auth, invoice.id);
};
