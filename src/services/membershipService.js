import { withTransaction } from '../config/db.js';
import { MembershipPlan, ServiceRider, Membership, EntitlementUsage, Customer, Vehicle, Invoice } from '../models/index.js';
import { audit } from './audit.js';
import { nextNumber } from './sequence.js';
import { assertCustomerScope, resolveLocationId, assertLocation } from '../security/access.js';
import { recordLifecycle, queueEconomics, activeConfig } from './economicsService.js';
import { registerJobHandler } from './jobService.js';
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
  await recordLifecycle(result.membership, 'enrolled', { key: 'initial', at: now, by: auth.userId, detail: { invoiceNumber: result.invoice?.invoiceNumber, amountCents } });
  if (result.invoice) await queueEconomics('invoice', { invoiceId: result.invoice.id }, result.invoice.id);
  return { membership: toDTO(result.membership.toObject()), invoice: result.invoice ? toDTO(result.invoice) : null };
};

export const activateFromPayment = async (membershipId, session = null) => {
  const m = await Membership.findOneAndUpdate({ id: membershipId, status: { $in: ['pending_payment', 'past_due'] } }, { $set: { status: 'active' } }, { session, new: true }).lean();
  if (m) await recordLifecycle(m, 'activated', { key: new Date(m.currentPeriodStart).toISOString(), detail: { trigger: 'payment' } });
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
  await recordLifecycle(updated, 'cancelled', { key: 'initial', at: updated.cancelledAt, by: req.auth.userId, detail: { reason } });
  return toDTO(updated);
};

// ---------------------------------------------------------------------------
// Lifecycle: renewal, plan change, suspension (each recorded in the ledger)
// ---------------------------------------------------------------------------
const DAY = 86400000;
const SYSTEM_REQ = { auth: { userId: 'system', role: 'system', locationIds: [] }, correlationId: 'membership-lifecycle', system: true };
const scopeCheck = (req, m) => { if (!req.system && m.locationId) assertLocation(req.auth, m.locationId); };

export const renewMembership = async (req, id) => {
  const m = await Membership.findOne({ id }).lean();
  if (!m) throw notFound('Membership');
  scopeCheck(req, m);
  if (!['active', 'past_due'].includes(m.status)) throw conflict('Only active or past-due memberships can renew');
  if (new Date(m.currentPeriodEnd) - Date.now() > 30 * DAY) throw badRequest('Renewal opens 30 days before the current period ends');
  const plan = await MembershipPlan.findOne({ planId: m.planId, status: 'active' }).sort({ version: -1 }).lean();
  if (!plan) throw conflict('This plan is retired; change the plan before renewing');
  const riders = (await Promise.all(m.riders.map(r => ServiceRider.findOne({ riderId: r.riderId, status: 'active' }).sort({ version: -1 }).lean()))).filter(r => r && plan.ridersAllowed.includes(r.riderId));
  const cycleMonths = m.billingCycle === 'monthly' ? 1 : plan.termMonths || 12;
  const amountCents = (m.billingCycle === 'monthly' ? plan.priceMonthlyCents : plan.priceAnnualCents) + riders.reduce((s, r) => s + (r.priceMonthlyCents || 0) * cycleMonths, 0);
  const start = new Date(m.currentPeriodEnd);
  const customer = await Customer.findOne({ id: m.customerId }).lean();
  const { createMembershipInvoice } = await import('./invoiceService.js');
  const result = await withTransaction(async (session) => {
    const updated = await Membership.findOneAndUpdate({ id, currentPeriodEnd: m.currentPeriodEnd }, { $set: { currentPeriodStart: start, currentPeriodEnd: addMonths(start, cycleMonths), planVersion: plan.version, riders: riders.map(r => ({ riderId: r.riderId, version: r.version, addedAt: new Date() })) } }, { new: true, session });
    if (!updated) throw conflict('Membership was already renewed');
    const invoice = amountCents > 0 ? await createMembershipInvoice(req, { membership: updated, customer, locationId: m.locationId, plan, riders, cycleMonths, amountCents, currency: plan.currency }, session) : null;
    await audit(req, { eventType: 'MEMBERSHIP_RENEWED', category: 'financial', entityType: 'Membership', entityId: id, locationId: m.locationId, action: `Renewed ${m.number} on ${plan.name} v${plan.version}${invoice ? `, invoice ${invoice.invoiceNumber}` : ''}` }, session);
    return { membership: updated, invoice };
  });
  await recordLifecycle(result.membership, 'renewed', { key: start.toISOString(), by: req.auth.userId, detail: { planVersion: plan.version, amountCents, invoiceNumber: result.invoice?.invoiceNumber } });
  if (result.invoice) await queueEconomics('invoice', { invoiceId: result.invoice.id }, result.invoice.id);
  return { membership: toDTO(result.membership.toObject()), invoice: result.invoice ? toDTO(result.invoice) : null };
};

export const changePlan = async (req, id, { planId, reason }) => {
  const m = await Membership.findOne({ id }).lean();
  if (!m) throw notFound('Membership');
  scopeCheck(req, m);
  if (!['active', 'past_due', 'suspended'].includes(m.status)) throw conflict('Only current memberships can change plan');
  const plan = await MembershipPlan.findOne({ planId, status: 'active' }).sort({ version: -1 }).lean();
  if (!plan) throw notFound('Active membership plan');
  if (plan.planId === m.planId && plan.version === m.planVersion) throw conflict('Already on this plan version');
  const kept = m.riders.filter(r => plan.ridersAllowed.includes(r.riderId));
  const updated = await Membership.findOneAndUpdate({ id, planId: m.planId, planVersion: m.planVersion }, { $set: { planId: plan.planId, planVersion: plan.version, riders: kept } }, { new: true }).lean();
  if (!updated) throw conflict('Membership changed; reload and try again');
  const detail = { fromPlanId: m.planId, fromVersion: m.planVersion, toPlanId: plan.planId, toVersion: plan.version, removedRiders: m.riders.filter(r => !kept.includes(r)).map(r => r.riderId), reason };
  await audit(req, { eventType: 'MEMBERSHIP_PLAN_CHANGED', category: 'financial', entityType: 'Membership', entityId: id, locationId: m.locationId, action: `${m.number}: plan ${m.planId}@${m.planVersion} -> ${plan.planId}@${plan.version}`, before: { planId: m.planId, planVersion: m.planVersion }, after: { planId: plan.planId, planVersion: plan.version }, reason });
  await recordLifecycle(updated, 'plan_changed', { by: req.auth.userId, detail });
  return { membership: toDTO(updated), note: 'Coverage follows the new plan now; the new price applies from the next renewal.' };
};

export const setSuspended = async (req, id, { suspend, reason }) => {
  const m = await Membership.findOne({ id }).lean();
  if (!m) throw notFound('Membership');
  scopeCheck(req, m);
  const updated = await Membership.findOneAndUpdate({ id, status: { $in: suspend ? ['active', 'past_due'] : ['suspended'] } }, { $set: { status: suspend ? 'suspended' : 'active' } }, { new: true }).lean();
  if (!updated) throw conflict(suspend ? 'Only active or past-due memberships can be suspended' : 'Membership is not suspended');
  await audit(req, { eventType: suspend ? 'MEMBERSHIP_SUSPENDED' : 'MEMBERSHIP_RESUMED', category: 'financial', entityType: 'Membership', entityId: id, locationId: m.locationId, action: `${suspend ? 'Suspended' : 'Resumed'} ${m.number}`, reason });
  await recordLifecycle(updated, suspend ? 'suspended' : 'resumed', { by: req.auth.userId, detail: { reason, fromStatus: m.status } });
  return toDTO(updated);
};

// Daily: auto-renewals, expiry of non-renewing memberships, past-due after the grace period.
registerJobHandler('membership.lifecycle_daily', async () => {
  const cfg = await activeConfig();
  const now = new Date();
  const out = { renewed: 0, expired: 0, pastDue: 0, errors: [] };
  for (const m of await Membership.find({ autoRenew: true, status: { $in: ['active', 'past_due'] }, currentPeriodEnd: { $lte: new Date(now.getTime() + DAY) } }).lean()) {
    try { await renewMembership(SYSTEM_REQ, m.id); out.renewed += 1; } catch (err) { out.errors.push(`${m.number}: ${err.message}`); }
  }
  for (const m of await Membership.find({ autoRenew: { $ne: true }, status: { $in: ['active', 'past_due'] }, currentPeriodEnd: { $lt: now } }).lean()) {
    const u = await Membership.findOneAndUpdate({ id: m.id, status: m.status }, { $set: { status: 'expired' } }, { new: true }).lean();
    if (u) { out.expired += 1; await recordLifecycle(u, 'expired', { key: new Date(m.currentPeriodEnd).toISOString() }); }
  }
  const unpaid = await Invoice.find({ kind: 'membership', status: 'posted', balanceCents: { $gt: 0 }, postedAt: { $lt: new Date(now - (cfg.membershipGraceDays ?? 15) * DAY) } }).select('id membershipId').lean();
  for (const inv of unpaid) {
    const u = await Membership.findOneAndUpdate({ id: inv.membershipId, status: 'active' }, { $set: { status: 'past_due' } }, { new: true }).lean();
    if (u) { out.pastDue += 1; await recordLifecycle(u, 'past_due', { key: inv.id, detail: { invoiceId: inv.id } }); }
  }
  return out;
});

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
