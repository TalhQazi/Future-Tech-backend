import { withTransaction } from '../config/db.js';
import { MembershipPlan, ServiceRider, Membership, EntitlementUsage, Customer, Vehicle } from '../models/index.js';
import { audit } from './audit.js';
import { nextNumber } from './sequence.js';
import { assertCustomerScope, resolveLocationId } from '../security/access.js';
import { notFound, badRequest, conflict } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';
import { applyBps } from '../lib/money.js';

export const MEMBERSHIP_ENGINE_VERSION = 'membership-eval-1';

// ---------------------------------------------------------------------------
// Plans and riders (immutable versions)
// ---------------------------------------------------------------------------
const latestVersions = async (Model, idField, includeRetired) => {
  const docs = await Model.find(includeRetired ? {} : { status: 'active' }).sort({ version: -1 }).lean();
  const seen = new Set();
  return docs.filter(d => (seen.has(d[idField]) ? false : seen.add(d[idField])));
};

export const listPlans = async ({ includeRetired } = {}) => toDTO(await latestVersions(MembershipPlan, 'planId', includeRetired));
export const listRiders = async ({ includeRetired } = {}) => toDTO(await latestVersions(ServiceRider, 'riderId', includeRetired));

export const planVersions = async (planId) => toDTO(await MembershipPlan.find({ planId }).sort({ version: -1 }).lean());

const validateEntitlements = (entitlements = []) => {
  const keys = new Set();
  for (const e of entitlements) {
    if (keys.has(e.key)) throw badRequest(`Duplicate entitlement key ${e.key}`);
    keys.add(e.key);
    if (['labor_discount_bps', 'parts_discount_bps'].includes(e.kind) && !(e.valueBps > 0)) throw badRequest(`${e.key}: discount percentage is required`);
    if (e.kind === 'included_service' && !e.laborOpCode) throw badRequest(`${e.key}: included services need a labor operation code`);
    if (e.kind === 'waive_fee' && !e.feeCode) throw badRequest(`${e.key}: fee waivers need a fee code`);
    if (e.period !== 'unlimited' && !(e.quantityPerPeriod > 0)) throw badRequest(`${e.key}: limited entitlements need a quantity per period`);
  }
};

export const savePlanVersion = async (req, input) => {
  validateEntitlements(input.entitlements);
  const doc = await withTransaction(async (session) => {
    let planId = input.planId;
    let version = 1;
    if (planId) {
      const latest = await MembershipPlan.findOne({ planId }).sort({ version: -1 }).session(session).lean();
      if (!latest) throw notFound('Membership plan');
      version = latest.version + 1;
      await MembershipPlan.updateMany({ planId, status: 'active' }, { $set: { status: 'retired' } }, { session });
    } else {
      planId = uuid();
      if (await MembershipPlan.exists({ code: input.code.toUpperCase(), status: 'active' })) throw conflict('An active plan with this code exists');
    }
    const [created] = await MembershipPlan.create([{ ...input, planId, version, status: 'active', createdBy: req.auth.userId }], { session });
    await audit(req, { eventType: 'MEMBERSHIP_PLAN_VERSION_PUBLISHED', category: 'financial', entityType: 'MembershipPlan', entityId: planId, action: `Published ${created.name} v${version}` }, session);
    return created;
  });
  return toDTO(doc);
};

export const retirePlan = async (req, planId) => {
  const res = await MembershipPlan.updateMany({ planId, status: 'active' }, { $set: { status: 'retired' } });
  if (!res.matchedCount) throw notFound('Active plan');
  await audit(req, { eventType: 'MEMBERSHIP_PLAN_RETIRED', category: 'financial', entityType: 'MembershipPlan', entityId: planId, action: 'Retired membership plan (existing memberships keep their version)' });
};

export const saveRiderVersion = async (req, input) => {
  validateEntitlements(input.entitlements);
  const doc = await withTransaction(async (session) => {
    let riderId = input.riderId;
    let version = 1;
    if (riderId) {
      const latest = await ServiceRider.findOne({ riderId }).sort({ version: -1 }).session(session).lean();
      if (!latest) throw notFound('Service rider');
      version = latest.version + 1;
      await ServiceRider.updateMany({ riderId, status: 'active' }, { $set: { status: 'retired' } }, { session });
    } else {
      riderId = uuid();
    }
    const [created] = await ServiceRider.create([{ ...input, riderId, version, status: 'active', createdBy: req.auth.userId }], { session });
    await audit(req, { eventType: 'SERVICE_RIDER_VERSION_PUBLISHED', category: 'financial', entityType: 'ServiceRider', entityId: riderId, action: `Published rider ${created.name} v${version}` }, session);
    return created;
  });
  return toDTO(doc);
};

// ---------------------------------------------------------------------------
// Customer memberships
// ---------------------------------------------------------------------------
const addMonths = (date, months) => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

export const enroll = async (req, input) => {
  const { auth } = req;
  const customer = await Customer.findOne({ id: input.customerId }).lean();
  if (!customer) throw notFound('Customer');
  const plan = await MembershipPlan.findOne({ planId: input.planId, status: 'active' }).sort({ version: -1 }).lean();
  if (!plan) throw notFound('Active membership plan');
  if (input.vehicleIds?.length) {
    const owned = await Vehicle.countDocuments({ id: { $in: input.vehicleIds }, customerId: customer.id });
    if (owned !== input.vehicleIds.length) throw badRequest('All covered vehicles must belong to the customer');
  }
  const riders = [];
  for (const riderId of input.riderIds || []) {
    if (!plan.ridersAllowed.includes(riderId)) throw badRequest('Rider is not available on this plan');
    const rider = await ServiceRider.findOne({ riderId, status: 'active' }).sort({ version: -1 }).lean();
    if (!rider) throw notFound('Service rider');
    riders.push(rider);
  }
  const existing = await Membership.findOne({ customerId: customer.id, planId: plan.planId, status: { $in: ['active', 'pending_payment', 'past_due'] } }).lean();
  if (existing) throw conflict('The customer already has this membership', 'ALREADY_ENROLLED');

  const locationId = resolveLocationId(auth, input.locationId);
  const cycleMonths = input.billingCycle === 'monthly' ? 1 : plan.termMonths || 12;
  const planPrice = input.billingCycle === 'monthly' ? plan.priceMonthlyCents : plan.priceAnnualCents;
  const riderPrice = riders.reduce((s, r) => s + (r.priceMonthlyCents || 0) * cycleMonths, 0);
  const amountCents = planPrice + riderPrice;
  const now = new Date();

  const { createMembershipInvoice } = await import('./invoiceService.js');
  const result = await withTransaction(async (session) => {
    const number = await nextNumber('MBR', 'MA', now.getUTCFullYear(), session);
    const [membership] = await Membership.create([{
      number,
      customerId: customer.id,
      vehicleIds: input.vehicleIds || [],
      planId: plan.planId,
      planVersion: plan.version,
      riders: riders.map(r => ({ riderId: r.riderId, version: r.version, addedAt: now })),
      status: amountCents === 0 ? 'active' : 'pending_payment',
      billingCycle: input.billingCycle || 'annual',
      startedAt: now,
      currentPeriodStart: now,
      currentPeriodEnd: addMonths(now, cycleMonths),
      autoRenew: Boolean(input.autoRenew),
      locationId,
      soldBy: auth.userId
    }], { session });
    let invoice = null;
    if (amountCents > 0) {
      invoice = await createMembershipInvoice(req, {
        membership, customer, locationId, plan, riders, cycleMonths, amountCents, currency: plan.currency
      }, session);
    }
    await audit(req, {
      eventType: 'MEMBERSHIP_ENROLLED', category: 'financial', entityType: 'Membership', entityId: membership.id, locationId,
      action: `Enrolled ${customer.name} in ${plan.name} v${plan.version} (${membership.number})${invoice ? `, invoice ${invoice.invoiceNumber}` : ''}`
    }, session);
    return { membership, invoice };
  });
  return { membership: toDTO(result.membership.toObject()), invoice: result.invoice ? toDTO(result.invoice) : null };
};

export const activateFromPayment = async (membershipId, session = null) => {
  await Membership.updateOne({ id: membershipId, status: { $in: ['pending_payment', 'past_due'] } }, { $set: { status: 'active' } }, { session });
};

export const cancelMembership = async (req, id, { reason }) => {
  if (!reason) throw badRequest('A cancellation reason is required');
  const updated = await Membership.findOneAndUpdate(
    { id, status: { $in: ['active', 'pending_payment', 'past_due'] } },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, autoRenew: false } },
    { new: true }
  ).lean();
  if (!updated) throw conflict('Membership is not active');
  await audit(req, { eventType: 'MEMBERSHIP_CANCELLED', category: 'financial', entityType: 'Membership', entityId: id, action: `Cancelled membership ${updated.number}`, reason });
  return toDTO(updated);
};

export const getMembership = async (auth, id) => {
  const m = await Membership.findOne({ $or: [{ id }, { number: id }] }).lean();
  if (!m) throw notFound('Membership');
  assertCustomerScope(auth, m.customerId);
  const [plan, riders, usage] = await Promise.all([
    MembershipPlan.findOne({ planId: m.planId, version: m.planVersion }).lean(),
    Promise.all(m.riders.map(r => ServiceRider.findOne({ riderId: r.riderId, version: r.version }).lean())),
    EntitlementUsage.find({ membershipId: m.id, status: 'consumed' }).sort({ createdAt: -1 }).lean()
  ]);
  return { ...toDTO(m), plan: toDTO(plan), riders: toDTO(riders.filter(Boolean)), usage: toDTO(usage) };
};

export const listMemberships = async (auth, { customerId, status }) => {
  const filter = {};
  if (auth.role === 'customer') filter.customerId = auth.customerId;
  else if (customerId) filter.customerId = customerId;
  if (status) filter.status = status;
  const items = await Membership.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const plans = await MembershipPlan.find({ planId: { $in: [...new Set(items.map(m => m.planId))] } }).select('planId version name tier').lean();
  const customers = auth.role === 'customer' ? [] : await Customer.find({ id: { $in: items.map(m => m.customerId) } }).select('id name').lean();
  const planName = (m) => plans.find(p => p.planId === m.planId && p.version === m.planVersion);
  return items.map(m => ({ ...toDTO(m), plan: planName(m) ? { name: planName(m).name, tier: planName(m).tier, version: m.planVersion } : null, customerName: customers.find(c => c.id === m.customerId)?.name }));
};

// ---------------------------------------------------------------------------
// Entitlement evaluation (deterministic, reproducible from the stored snapshot)
// ---------------------------------------------------------------------------
const periodKeyFor = (membership, entitlement, roId) => {
  if (entitlement.period === 'per_visit') return `visit:${roId}`;
  if (entitlement.period === 'per_term') return `term:${new Date(membership.currentPeriodStart).toISOString().slice(0, 10)}`;
  return 'unlimited';
};

/**
 * Applies at most one entitlement per line (the largest discount).
 * lines: priced lines with { id, kind, extendedCents, laborOpCode, laborRateType, feeCode }
 * Returns { evaluation, discountsByLine }.
 */
export const evaluateMembership = async ({ customerId, vehicleId, roId, lines, at = new Date() }) => {
  const memberships = await Membership.find({
    customerId,
    status: 'active',
    currentPeriodStart: { $lte: at },
    currentPeriodEnd: { $gt: at },
    $or: [{ vehicleIds: { $size: 0 } }, { vehicleIds: vehicleId }]
  }).lean();
  const evaluation = { engineVersion: MEMBERSHIP_ENGINE_VERSION, evaluatedAt: at.toISOString(), memberships: [], applied: [], notApplied: [] };
  const discountsByLine = new Map();
  if (!memberships.length) return { evaluation, discountsByLine };

  const candidates = [];
  for (const m of memberships) {
    const plan = await MembershipPlan.findOne({ planId: m.planId, version: m.planVersion }).lean();
    const riders = (await Promise.all(m.riders.map(r => ServiceRider.findOne({ riderId: r.riderId, version: r.version }).lean()))).filter(Boolean);
    evaluation.memberships.push({
      membershipId: m.id, number: m.number, planId: m.planId, planVersion: m.planVersion, planName: plan?.name,
      riders: riders.map(r => ({ riderId: r.riderId, version: r.version, name: r.name })),
      periodStart: m.currentPeriodStart, periodEnd: m.currentPeriodEnd
    });
    const ents = [...(plan?.entitlements || []).map(e => ({ ...e, source: `plan:${plan.planId}@${plan.version}` })),
      ...riders.flatMap(r => r.entitlements.map(e => ({ ...e, source: `rider:${r.riderId}@${r.version}` })))];
    for (const e of ents) candidates.push({ membership: m, entitlement: e });
  }

  // remaining quantities for limited entitlements
  const remaining = new Map();
  for (const { membership, entitlement } of candidates) {
    if (entitlement.period === 'unlimited') continue;
    const key = `${membership.id}|${entitlement.key}|${periodKeyFor(membership, entitlement, roId)}`;
    if (remaining.has(key)) continue;
    const used = await EntitlementUsage.aggregate([
      { $match: { membershipId: membership.id, entitlementKey: entitlement.key, periodKey: periodKeyFor(membership, entitlement, roId), status: 'consumed', roId: { $ne: roId } } },
      { $group: { _id: null, q: { $sum: '$quantity' } } }
    ]);
    remaining.set(key, Math.max(0, (entitlement.quantityPerPeriod || 0) - (used[0]?.q || 0)));
  }

  for (const line of lines) {
    let best = null;
    for (const { membership, entitlement: e } of candidates) {
      let discount = 0;
      if (e.kind === 'labor_discount_bps' && line.kind === 'labor') discount = applyBps(line.extendedCents, e.valueBps);
      else if (e.kind === 'parts_discount_bps' && line.kind === 'part') discount = applyBps(line.extendedCents, e.valueBps);
      else if (e.kind === 'free_diagnostic' && line.kind === 'labor' && line.laborRateType === 'diagnostic') discount = line.extendedCents;
      else if (e.kind === 'included_service' && line.kind === 'labor' && line.laborOpCode && line.laborOpCode === e.laborOpCode) discount = line.extendedCents;
      else if (e.kind === 'waive_fee' && line.kind === 'fee' && line.feeCode === e.feeCode) discount = line.extendedCents;
      if (discount <= 0) continue;
      if (e.maxDiscountCents) discount = Math.min(discount, e.maxDiscountCents);
      const qtyKey = e.period === 'unlimited' ? null : `${membership.id}|${e.key}|${periodKeyFor(membership, e, roId)}`;
      if (qtyKey && (remaining.get(qtyKey) || 0) < 1) {
        evaluation.notApplied.push({ lineId: line.id, entitlementKey: e.key, reason: 'Entitlement quantity used up for this period' });
        continue;
      }
      if (!best || discount > best.discount) best = { membership, entitlement: e, discount, qtyKey };
    }
    if (best) {
      if (best.qtyKey) remaining.set(best.qtyKey, remaining.get(best.qtyKey) - 1);
      discountsByLine.set(line.id, best.discount);
      evaluation.applied.push({
        lineId: line.id,
        membershipId: best.membership.id,
        entitlementKey: best.entitlement.key,
        kind: best.entitlement.kind,
        source: best.entitlement.source,
        periodKey: periodKeyFor(best.membership, best.entitlement, roId),
        quantity: 1,
        discountCents: best.discount
      });
    }
  }
  return { evaluation, discountsByLine };
};

export const recordEntitlementUsage = async ({ evaluation, roId, invoiceId, estimateVersionId }, session) => {
  if (!evaluation?.applied?.length) return;
  await EntitlementUsage.insertMany(evaluation.applied.map(a => ({
    membershipId: a.membershipId, entitlementKey: a.entitlementKey, periodKey: a.periodKey,
    quantity: a.quantity, valueCents: a.discountCents, roId, invoiceId, estimateVersionId, status: 'consumed'
  })), { session });
};
