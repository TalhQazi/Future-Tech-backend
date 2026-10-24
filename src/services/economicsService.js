import {
  EconomicEvent, EconomicsConfig, Invoice, Payment, Refund, FinancialAdjustment, RepairOrder, InstalledPart, TimeEntry,
  User, LaborOperation, Membership, MembershipPlan, Location, Vehicle, Customer
} from '../models/index.js';
import { audit } from './audit.js';
import { registerJobHandler, enqueueJob } from './jobService.js';
import { applyBps, roundDiv } from '../lib/money.js';
import { assertLocation, isCorporateScope, can } from '../security/access.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';

export const ECONOMICS_ENGINE_VERSION = 'economics-1';

// ---------------------------------------------------------------------------
// Effective-dated configuration
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  version: 0, effectiveFrom: new Date(0), currency: 'USD', defaultLoadedLaborRateCents: null,
  overhead: { method: 'none', rateBps: 0, flatCents: 0 }, reserveBps: 0,
  defaultTargetMarginBps: 2000, defaultWarningMarginBps: 1000, plans: [], retailValueSource: 'estimate_extended_price',
  forecast: { horizonsDays: [30, 90, 180, 365], historyWindowDays: 730, minHistoryDaysForMedium: 180, minVisitsForMedium: 2, minHistoryDaysForHigh: 365, minVisitsForHigh: 4 },
  riskBands: [{ band: 'GREEN', minScore: 0 }, { band: 'YELLOW', minScore: 35 }, { band: 'ORANGE', minScore: 55 }, { band: 'RED', minScore: 75 }],
  isDefault: true
};

export const activeConfig = async (at = new Date()) => {
  const cfg = await EconomicsConfig.findOne({ effectiveFrom: { $lte: at } }).sort({ effectiveFrom: -1, version: -1 }).lean();
  return cfg ? { ...DEFAULT_CONFIG, ...cfg, isDefault: false } : DEFAULT_CONFIG;
};

export const listConfigs = async () => toDTO(await EconomicsConfig.find().sort({ version: -1 }).limit(50).lean());

export const saveConfig = async (req, input) => {
  const latest = await EconomicsConfig.findOne().sort({ version: -1 }).lean();
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
  const bands = input.riskBands || DEFAULT_CONFIG.riskBands;
  if (bands.some((b, i) => i > 0 && b.minScore <= bands[i - 1].minScore)) throw badRequest('Risk band thresholds must increase');
  const cfg = await EconomicsConfig.create({ ...input, riskBands: bands, effectiveFrom, version: (latest?.version || 0) + 1, createdBy: req.auth.userId });
  await audit(req, {
    eventType: 'ECONOMICS_CONFIG_PUBLISHED', category: 'financial', entityType: 'EconomicsConfig', entityId: cfg.id,
    action: `Published economics configuration v${cfg.version} effective ${effectiveFrom.toISOString().slice(0, 10)}`,
    before: latest ? { version: latest.version, overhead: latest.overhead, defaultLoadedLaborRateCents: latest.defaultLoadedLaborRateCents } : undefined,
    after: { version: cfg.version, overhead: cfg.overhead, defaultLoadedLaborRateCents: cfg.defaultLoadedLaborRateCents },
    reason: input.notes
  });
  return toDTO(cfg.toObject());
};

// ---------------------------------------------------------------------------
// Ledger posting (idempotent: unique dedupeKey per source fact)
// ---------------------------------------------------------------------------
const CATEGORY_OF = {
  membership_revenue: 'revenue', membership_refund: 'revenue', service_revenue: 'revenue', service_credit: 'revenue', service_debit: 'revenue',
  customer_payment: 'customer_payment', customer_refund: 'customer_payment',
  parts_cost: 'direct_cost', labor_cost: 'direct_cost', sublet_cost: 'direct_cost', other_direct_cost: 'direct_cost',
  overhead_allocation: 'overhead', covered_retail_value: 'customer_value'
};

export const postEvents = async (events) => {
  if (!events.length) return 0;
  const docs = events.map(e => ({ ...e, category: e.category || CATEGORY_OF[e.type] }));
  try {
    const res = await EconomicEvent.insertMany(docs, { ordered: false });
    return res.length;
  } catch (err) {
    if (err?.code === 11000 || err?.writeErrors?.every?.(w => w.code === 11000 || w.err?.code === 11000)) {
      return err.insertedDocs?.length ?? err.result?.insertedCount ?? 0; // duplicates = already posted
    }
    throw err;
  }
};

const membershipAttribution = async (customerId, vehicleId, at, evaluation) => {
  const applied = evaluation?.memberships?.[0];
  const m = applied
    ? await Membership.findOne({ id: applied.membershipId }).lean()
    : await Membership.findOne({ customerId, status: { $in: ['active', 'past_due'] }, currentPeriodStart: { $lte: at }, $or: [{ vehicleIds: { $size: 0 } }, { vehicleIds: vehicleId }] }).lean();
  if (!m) return {};
  return { membershipId: m.id, planId: m.planId, cohort: m.startedAt ? new Date(m.startedAt).toISOString().slice(0, 7) : undefined };
};

const laborRateFor = (tech, cfg) => (Number.isSafeInteger(tech?.laborCostRateCents) ? tech.laborCostRateCents : cfg.defaultLoadedLaborRateCents);

export const postInvoiceEconomics = async (invoiceId) => {
  const inv = await Invoice.findOne({ id: invoiceId, status: 'posted' }).lean();
  if (!inv) return { skipped: 'not posted' };
  const at = inv.postedAt || inv.createdAt;
  const cfg = await activeConfig(at);
  const base = { currency: inv.currency, effectiveAt: at, createdBy: 'economics' };

  if (inv.kind === 'membership') {
    const m = await Membership.findOne({ id: inv.membershipId }).lean();
    const attribution = { customerId: inv.customerId, locationId: inv.locationId, invoiceId, membershipId: inv.membershipId, planId: m?.planId, cohort: m?.startedAt ? new Date(m.startedAt).toISOString().slice(0, 7) : undefined };
    return { posted: await postEvents([{ ...base, type: 'membership_revenue', amountCents: inv.totals.totalCents - inv.totals.taxCents, attribution, source: { type: 'invoice', id: invoiceId }, dedupeKey: `invoice:${invoiceId}:membership_revenue`, calculationContext: { engine: ECONOMICS_ENGINE_VERSION } }]) };
  }

  const ro = await RepairOrder.findOne({ id: inv.roId }).lean();
  const memberAttr = await membershipAttribution(inv.customerId, inv.vehicleId, at, inv.membershipEvaluation);
  const ops = await LaborOperation.find({ code: { $in: (ro?.jobs || []).map(j => j.laborOpCode).filter(Boolean) } }).lean();
  const categoryOfJob = new Map((ro?.jobs || []).map(j => [j.id, ops.find(o => o.code === j.laborOpCode)?.category || j.title || 'General']));
  const attr = (extra = {}) => ({ customerId: inv.customerId, vehicleId: inv.vehicleId, locationId: inv.locationId, roId: inv.roId, invoiceId, ...memberAttr, ...extra });
  const events = [];
  const techs = new Map((await User.find({ id: { $in: [...new Set((ro?.jobs || []).map(j => j.techId).filter(Boolean))] } }).select('id laborCostRateCents').lean()).map(u => [u.id, u]));

  // only membership-entitlement discounts count as covered value (not manual discounts)
  const covered = new Set((inv.membershipEvaluation?.applied || []).map(a => a.lineId));
  for (const line of inv.lineItems) {
    const serviceCategory = categoryOfJob.get(line.jobId) || (line.kind === 'fee' ? 'Fees' : 'General');
    let standardCostCents = null;
    if (line.kind === 'part' || line.kind === 'sublet') standardCostCents = roundDiv((line.unitCostCents || 0) * Math.round((line.quantity || 1) * 1000), 1000);
    if (line.kind === 'labor') {
      const job = ro?.jobs.find(j => j.id === line.jobId);
      const rate = laborRateFor(techs.get(job?.techId), cfg);
      standardCostCents = Number.isSafeInteger(rate) && line.hours ? roundDiv(rate * Math.round(line.hours * 100), 100) : null;
    }
    events.push({ ...base, type: 'service_revenue', amountCents: line.netCents, attribution: attr({ serviceCategory }), source: { type: 'invoice_line', id: `${invoiceId}:${line.id}` }, dedupeKey: `invoice:${invoiceId}:line:${line.id}:revenue`, standardCostCents, calculationContext: { kind: line.kind, extendedCents: line.extendedCents, discountCents: line.discountCents } });
    if (line.discountCents > 0 && covered.has(line.estimateLineId)) {
      events.push({ ...base, type: 'covered_retail_value', amountCents: line.extendedCents, attribution: attr({ serviceCategory }), source: { type: 'invoice_line', id: `${invoiceId}:${line.id}` }, dedupeKey: `invoice:${invoiceId}:line:${line.id}:retail_value`, calculationContext: { customerPaidCents: line.netCents, retailValueSource: cfg.retailValueSource } });
    }
    if (line.kind === 'sublet' && line.unitCostCents) {
      events.push({ ...base, type: 'sublet_cost', amountCents: standardCostCents, attribution: attr({ serviceCategory }), source: { type: 'invoice_line', id: `${invoiceId}:${line.id}` }, dedupeKey: `invoice:${invoiceId}:line:${line.id}:sublet_cost` });
    }
  }

  // actual parts cost from parts issued to the RO
  for (const ip of await InstalledPart.find({ roId: inv.roId }).lean()) {
    events.push({ ...base, effectiveAt: ip.installedAt || at, type: 'parts_cost', amountCents: (ip.unitCostCents || 0) * (ip.quantity || 1), attribution: attr({ serviceCategory: categoryOfJob.get(ip.jobId) || 'General', technicianId: ip.techId }), source: { type: 'installed_part', id: ip.id }, dedupeKey: `installed:${ip.id}:parts_cost`, complete: Number.isSafeInteger(ip.unitCostCents), incompleteReason: Number.isSafeInteger(ip.unitCostCents) ? undefined : 'Part cost unknown' });
  }

  // actual loaded labor cost from clocked time
  const entries = await TimeEntry.find({ roId: inv.roId, status: 'closed', type: { $in: ['job', 'diagnostic'] } }).lean();
  const entryTechs = new Map((await User.find({ id: { $in: [...new Set(entries.map(e => e.techId))] } }).select('id laborCostRateCents').lean()).map(u => [u.id, u]));
  for (const e of entries) {
    const rate = laborRateFor(entryTechs.get(e.techId), cfg);
    const known = Number.isSafeInteger(rate);
    events.push({ ...base, effectiveAt: e.endAt || at, type: 'labor_cost', amountCents: known ? roundDiv(rate * e.minutes, 60) : 0, attribution: attr({ serviceCategory: categoryOfJob.get(e.jobId) || 'General', technicianId: e.techId }), source: { type: 'time_entry', id: e.id }, dedupeKey: `time:${e.id}:labor_cost`, complete: known, incompleteReason: known ? undefined : 'No loaded labor rate for technician or default', calculationContext: { minutes: e.minutes, rateCents: rate ?? null, configVersion: cfg.version } });
  }

  // overhead allocation per policy in force at posting
  const revenue = inv.lineItems.reduce((s, l) => s + l.netCents, 0);
  const oh = cfg.overhead.method === 'percent_of_revenue' ? applyBps(revenue, cfg.overhead.rateBps) : cfg.overhead.method === 'flat_per_repair_order' ? cfg.overhead.flatCents : 0;
  if (oh > 0) events.push({ ...base, type: 'overhead_allocation', amountCents: oh, attribution: attr({ serviceCategory: 'Overhead' }), source: { type: 'invoice', id: invoiceId }, dedupeKey: `invoice:${invoiceId}:overhead`, calculationContext: { method: cfg.overhead.method, rateBps: cfg.overhead.rateBps, flatCents: cfg.overhead.flatCents, configVersion: cfg.version } });

  const posted = await postEvents(events);
  if (inv.vehicleId) await enqueueJob('economics.risk_vehicle', { vehicleId: inv.vehicleId }, `risk:${inv.vehicleId}:${invoiceId}`);
  return { posted };
};

const invoiceAttribution = async (invoiceId) => {
  const inv = await Invoice.findOne({ id: invoiceId }).lean();
  if (!inv) return null;
  const m = inv.membershipId ? await Membership.findOne({ id: inv.membershipId }).lean() : null;
  const memberAttr = m ? { membershipId: m.id, planId: m.planId } : await membershipAttribution(inv.customerId, inv.vehicleId, inv.postedAt || new Date(), inv.membershipEvaluation);
  return { inv, attribution: { customerId: inv.customerId, vehicleId: inv.vehicleId, locationId: inv.locationId, roId: inv.roId, invoiceId: inv.id, ...memberAttr } };
};

export const postPaymentEconomics = async (paymentId) => {
  const p = await Payment.findOne({ id: paymentId, status: 'succeeded' }).lean();
  if (!p) return { skipped: true };
  const ia = await invoiceAttribution(p.invoiceId);
  return { posted: await postEvents([{ type: 'customer_payment', amountCents: p.amountCents, currency: p.currency, effectiveAt: p.receivedAt || p.createdAt, attribution: ia.attribution, source: { type: 'payment', id: p.id }, dedupeKey: `payment:${p.id}`, calculationContext: { method: p.method } }]) };
};

export const postRefundEconomics = async (refundId) => {
  const r = await Refund.findOne({ id: refundId, status: 'succeeded' }).lean();
  if (!r) return { skipped: true };
  const ia = await invoiceAttribution(r.invoiceId);
  return { posted: await postEvents([{ type: 'customer_refund', amountCents: -r.amountCents, currency: r.currency, effectiveAt: r.processedAt || r.updatedAt, attribution: ia.attribution, source: { type: 'refund', id: r.id }, dedupeKey: `refund:${r.id}`, calculationContext: { reason: r.reason } }]) };
};

export const postAdjustmentEconomics = async (adjustmentId) => {
  const a = await FinancialAdjustment.findOne({ id: adjustmentId }).lean();
  if (!a) return { skipped: true };
  const ia = await invoiceAttribution(a.invoiceId);
  const isMembership = ia.inv.kind === 'membership';
  const type = a.direction === 'credit' ? (isMembership ? 'membership_refund' : 'service_credit') : (isMembership ? 'membership_revenue' : 'service_debit');
  return { posted: await postEvents([{ type, amountCents: a.direction === 'credit' ? -a.amountCents : a.amountCents, currency: a.currency, effectiveAt: a.at, attribution: ia.attribution, source: { type: 'financial_adjustment', id: a.id }, dedupeKey: `adjustment:${a.id}`, calculationContext: { adjustmentType: a.type, reason: a.reason } }]) };
};

registerJobHandler('economics.invoice', ({ invoiceId }) => postInvoiceEconomics(invoiceId));
registerJobHandler('economics.payment', ({ paymentId }) => postPaymentEconomics(paymentId));
registerJobHandler('economics.refund', ({ refundId }) => postRefundEconomics(refundId));
registerJobHandler('economics.adjustment', ({ adjustmentId }) => postAdjustmentEconomics(adjustmentId));

export const queueEconomics = (type, payload, key) => enqueueJob(`economics.${type}`, payload, `econ:${type}:${key}`).catch(() => {});

// Backfill: posts any source facts not yet in the ledger (idempotent).
export const backfillLedger = async (req) => {
  const counts = { invoices: 0, payments: 0, refunds: 0, adjustments: 0, events: 0 };
  for (const inv of await Invoice.find({ status: 'posted' }).select('id').lean()) { counts.invoices += 1; counts.events += (await postInvoiceEconomics(inv.id)).posted || 0; }
  for (const p of await Payment.find({ status: 'succeeded' }).select('id').lean()) { counts.payments += 1; counts.events += (await postPaymentEconomics(p.id)).posted || 0; }
  for (const r of await Refund.find({ status: 'succeeded' }).select('id').lean()) { counts.refunds += 1; counts.events += (await postRefundEconomics(r.id)).posted || 0; }
  for (const a of await FinancialAdjustment.find().select('id').lean()) { counts.adjustments += 1; counts.events += (await postAdjustmentEconomics(a.id)).posted || 0; }
  await audit(req, { eventType: 'ECONOMIC_LEDGER_BACKFILL', category: 'financial', entityType: 'EconomicEvent', entityId: 'ledger', action: `Ledger backfill: ${counts.events} new events from ${counts.invoices} invoices, ${counts.payments} payments, ${counts.refunds} refunds, ${counts.adjustments} adjustments` });
  return counts;
};

// Manual economic adjustment (e.g. a direct cost not captured elsewhere).
export const postManualEvent = async (req, input) => {
  if (!['other_direct_cost', 'overhead_allocation', 'reversal'].includes(input.type)) throw badRequest('Only other direct costs, overhead allocations and reversals can be entered manually');
  if (input.attribution?.locationId) assertLocation(req.auth, input.attribution.locationId);
  let doc = { ...input, effectiveAt: new Date(input.effectiveAt || Date.now()), createdBy: req.auth.userId };
  if (input.type === 'reversal') {
    const original = await EconomicEvent.findOne({ id: input.reversesEventId }).lean();
    if (!original) throw badRequest('Event to reverse not found');
    if (await EconomicEvent.exists({ reversesEventId: original.id })) throw badRequest('Event already reversed');
    if (original.attribution?.locationId) assertLocation(req.auth, original.attribution.locationId);
    doc = { ...doc, category: original.category, amountCents: -original.amountCents, attribution: original.attribution, currency: original.currency, standardCostCents: original.standardCostCents != null ? -original.standardCostCents : null };
  }
  const [created] = await EconomicEvent.create([{ ...doc, category: doc.category || CATEGORY_OF[doc.type], source: { type: 'manual', id: req.correlationId }, dedupeKey: `manual:${req.correlationId}:${Date.now()}` }]);
  await audit(req, { eventType: 'ECONOMIC_ADJUSTMENT_POSTED', category: 'financial', entityType: 'EconomicEvent', entityId: created.id, locationId: created.attribution?.locationId, action: `Manual ${created.type} of ${created.amountCents} cents`, reason: input.reason });
  return toDTO(created.toObject());
};

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------
const GROUP_FIELDS = {
  portfolio: null, membership: '$attribution.membershipId', vehicle: '$attribution.vehicleId', ro: '$attribution.roId',
  serviceCategory: '$attribution.serviceCategory', plan: '$attribution.planId', location: '$attribution.locationId',
  cohort: '$attribution.cohort', period: { $dateToString: { format: '%Y-%m', date: '$effectiveAt' } }
};

export const scopeMatch = (auth, filters = {}) => {
  if (!can(auth, 'economics:location') && !can(auth, 'economics:corporate')) throw forbidden('No access to economics');
  const match = {};
  if (!isCorporateScope(auth)) match['attribution.locationId'] = { $in: auth.locationIds };
  if (filters.locationId) { assertLocation(auth, filters.locationId); match['attribution.locationId'] = filters.locationId; }
  for (const k of ['planId', 'membershipId', 'vehicleId', 'customerId', 'roId', 'serviceCategory', 'cohort']) if (filters[k]) match[`attribution.${k}`] = filters[k];
  return match;
};

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : null);

export const rollup = async (auth, { groupBy = 'portfolio', from, to, ...filters }) => {
  if (!(groupBy in GROUP_FIELDS)) throw badRequest(`groupBy must be one of ${Object.keys(GROUP_FIELDS).join(', ')}`);
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 365 * 86400000);
  const match = { ...scopeMatch(auth, filters), effectiveAt: { $gte: start, $lt: end } };
  const rows = await EconomicEvent.aggregate([
    { $match: match },
    { $group: {
      _id: { key: GROUP_FIELDS[groupBy], type: '$type' },
      amount: { $sum: '$amountCents' },
      standard: { $sum: { $ifNull: ['$standardCostCents', 0] } },
      customerPaid: { $sum: { $ifNull: ['$calculationContext.customerPaidCents', 0] } },
      incomplete: { $sum: { $cond: ['$complete', 0, 1] } },
      reasons: { $addToSet: '$incompleteReason' },
      memberships: { $addToSet: '$attribution.membershipId' }
    } }
  ]);
  const cfg = await activeConfig(end);
  const groups = new Map();
  for (const r of rows) {
    const key = r._id.key ?? 'all';
    const g = groups.get(key) || { key, byType: {}, standard: 0, customerPaidCovered: 0, incomplete: 0, reasons: new Set(), memberships: new Set() };
    g.byType[r._id.type] = (g.byType[r._id.type] || 0) + r.amount;
    g.standard += r.standard;
    if (r._id.type === 'covered_retail_value') g.customerPaidCovered += r.customerPaid;
    g.incomplete += r.incomplete;
    r.reasons.filter(Boolean).forEach(x => g.reasons.add(x));
    r.memberships.filter(Boolean).forEach(x => g.memberships.add(x));
    groups.set(key, g);
  }
  const days = Math.max(1, (end - start) / 86400000);
  const out = [];
  for (const g of groups.values()) {
    const t = g.byType;
    const revenue = (t.membership_revenue || 0) + (t.membership_refund || 0) + (t.service_revenue || 0) + (t.service_credit || 0) + (t.service_debit || 0);
    const partsCost = t.parts_cost || 0;
    const laborCost = t.labor_cost || 0;
    const otherDirect = (t.sublet_cost || 0) + (t.other_direct_cost || 0);
    const directCost = partsCost + laborCost + otherDirect;
    const overhead = t.overhead_allocation || 0;
    const netProfit = revenue - directCost - overhead;
    const retailValue = t.covered_retail_value || 0;
    // utilization: actual direct cost vs plan baseline prorated for the period
    let expectedCost = null;
    if (['membership', 'plan'].includes(groupBy) || g.memberships.size) {
      let sum = 0; let known = 0;
      for (const mid of g.memberships) {
        const m = await Membership.findOne({ id: mid }).select('planId').lean();
        const pe = cfg.plans.find(p => p.planId === m?.planId);
        if (pe?.expectedAnnualDirectCostCents != null) { sum += Math.round(pe.expectedAnnualDirectCostCents * days / 365); known += 1; }
      }
      expectedCost = known ? sum : null;
    }
    out.push({
      key: g.key,
      revenueCents: revenue,
      partsCostCents: partsCost,
      laborCostCents: laborCost,
      otherDirectCostCents: otherDirect,
      directCostCents: directCost,
      overheadCents: overhead,
      netProfitCents: netProfit,
      realizedMarginPct: pct(netProfit, revenue),
      customerPaymentsCents: (t.customer_payment || 0) + (t.customer_refund || 0),
      eligibleRetailValueCents: retailValue,
      customerSavingsCents: retailValue ? retailValue - g.customerPaidCovered : 0,
      standardDirectCostCents: g.standard || null,
      costVarianceCents: g.standard ? directCost - g.standard : null,
      expectedDirectCostCents: expectedCost,
      utilizationIndex: expectedCost ? Math.round((directCost / expectedCost) * 100) / 100 : null,
      incompleteEvents: g.incomplete,
      incompleteReasons: [...g.reasons],
      verified: g.incomplete === 0
    });
  }
  await attachLabels(groupBy, out);
  return {
    groupBy, from: start, to: end, engineVersion: ECONOMICS_ENGINE_VERSION, configVersion: cfg.version, configIsDefault: Boolean(cfg.isDefault),
    definitions: {
      realizedMarginPct: 'net profit / attributable revenue × 100 (null when revenue is 0)',
      utilizationIndex: 'actual direct cost / plan expected direct cost prorated to the period (null without a configured baseline)',
      costVarianceCents: 'actual direct cost − standard expected direct cost (estimate part cost + sold hours × loaded rate)',
      customerSavingsCents: 'eligible retail value of covered services − customer payments for those services'
    },
    rows: out.sort((a, b) => b.revenueCents - a.revenueCents)
  };
};

const attachLabels = async (groupBy, rows) => {
  const ids = rows.map(r => r.key).filter(k => k && k !== 'all');
  let labels = new Map();
  if (groupBy === 'plan') labels = new Map((await MembershipPlan.find({ planId: { $in: ids } }).sort({ version: -1 }).lean()).reverse().map(p => [p.planId, p.name]));
  if (groupBy === 'location') labels = new Map((await Location.find({ id: { $in: ids } }).lean()).map(l => [l.id, l.name]));
  if (groupBy === 'vehicle') labels = new Map((await Vehicle.find({ id: { $in: ids } }).lean()).map(v => [v.id, `${v.year} ${v.make} ${v.model}${v.vin ? ` · ${v.vin}` : ''}`]));
  if (groupBy === 'membership') {
    const ms = await Membership.find({ id: { $in: ids } }).lean();
    const cs = await Customer.find({ id: { $in: ms.map(m => m.customerId) } }).select('id name').lean();
    labels = new Map(ms.map(m => [m.id, `${m.number} · ${cs.find(c => c.id === m.customerId)?.name || ''}`]));
  }
  if (groupBy === 'ro') labels = new Map((await RepairOrder.find({ id: { $in: ids } }).select('id roNumber').lean()).map(r => [r.id, r.roNumber]));
  for (const r of rows) r.label = r.key === 'all' ? 'Portfolio' : labels.get(r.key) || (r.key ?? 'Unattributed');
};

export const ledgerEvents = async (auth, filters) => {
  const match = scopeMatch(auth, filters);
  if (filters.type) match.type = filters.type;
  return toDTO(await EconomicEvent.find(match).sort({ effectiveAt: -1 }).limit(Math.min(Number(filters.limit) || 200, 1000)).lean());
};
