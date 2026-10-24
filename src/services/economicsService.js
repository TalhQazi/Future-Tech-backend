import {
  EconomicEvent, EconomicsConfig, EconomicAdjustment, Invoice, Payment, Refund, FinancialAdjustment, RepairOrder, InstalledPart,
  TimeEntry, User, LaborOperation, Membership, MembershipPlan, Location, Vehicle, Customer, VendorReturn, PartFailure, Referral,
  MileageRecord, Job
} from '../models/index.js';
import { ECONOMIC_TYPES, DATA_QUALITY } from '../models/economics.js';
import { audit } from './audit.js';
import { registerJobHandler, enqueueJob } from './jobService.js';
import { applyBps, roundDiv } from '../lib/money.js';
import { assertLocation, isCorporateScope, can } from '../security/access.js';
import { badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';

export const ECONOMICS_ENGINE_VERSION = 'economics-2';
const DAY = 86400000;
const monthOf = (d) => new Date(d).toISOString().slice(0, 7);
const cohortOf = (m) => (m?.startedAt ? monthOf(m.startedAt) : undefined);

// ---------------------------------------------------------------------------
// Effective-dated configuration
// ---------------------------------------------------------------------------
// Model parameters for the rules-based risk baseline (not business prices).
export const DEFAULT_RISK_WEIGHTS = {
  utilizationPerRatio: 40, utilizationMax: 30,
  declinedRepairEach: 10, declinedRepairMax: 30,
  repeatDtcEach: 10, repeatDtcMax: 20,
  recurrenceAfterFixEach: 15, recurrenceAfterFixMax: 30,
  comebackEach: 10, comebackMax: 20,
  failedMeasurementEach: 5, failedMeasurementMax: 15,
  highMileage: 150000, highMileagePoints: 10, midMileage: 100000, midMileagePoints: 5,
  vehicleAgeYears: 12, vehicleAgePoints: 5,
  milesPerYearHigh: 20000, milesPerYearPoints: 5,
  preventiveOverdueDays: 240, preventiveOverduePoints: 10,
  paymentFailureEach: 5, paymentFailureMax: 15,
  negativeMarginPoints: 25, lowMarginPoints: 15
};
export const DEFAULT_ALERT_THRESHOLDS = {
  highUtilizationRatio: 1.5, majorRepairProbability: 0.3, paymentFailuresIn90Days: 2,
  preventiveDueWithinDays: 30, laborOverrunRatio: 3, maxMilesPerDay: 400
};
export const DEFAULT_CUSTOMER_SEVERITY = {
  safety: { label: 'Needs attention now', urgency: 'high', text: 'Our technician found a condition that can affect safe operation. We recommend taking care of it before long trips.' },
  repair: { label: 'Repair recommended', urgency: 'medium', text: 'This item is worn or not working as designed. Repairing it soon can help avoid further wear.' },
  maintenance: { label: 'Maintenance due', urgency: 'low', text: 'Routine maintenance that keeps your vehicle running well.' },
  monitor: { label: 'Keep an eye on it', urgency: 'info', text: 'No action is needed now. We will check it again at your next visit.' }
};

const DEFAULT_CONFIG = {
  version: 0, effectiveFrom: new Date(0), currency: 'USD', defaultLoadedLaborRateCents: null,
  labor: { default: {}, technicians: [] },
  overhead: { method: 'none', rateBps: 0, flatCents: 0, perLaborHourCents: 0, perBayHourCents: 0, perMemberMonthCents: 0, locationMonthlyPools: [], hybrid: [] },
  reserveBps: 0, defaultTargetMarginBps: 2000, defaultWarningMarginBps: 1000, lossToleranceBps: 0, adverseTrendBps: 2500,
  majorRepairThresholdCents: null, preventiveCategories: ['Maintenance'], referralRewardCents: null, membershipGraceDays: 15,
  plans: [], retailValueSource: 'estimate_extended_price', qualificationRules: [],
  forecast: { horizonsDays: [30, 90, 180, 365], historyWindowDays: 730, minHistoryDaysForMedium: 180, minVisitsForMedium: 2, minHistoryDaysForHigh: 365, minVisitsForHigh: 4 },
  riskBands: [{ band: 'GREEN', minScore: 0 }, { band: 'YELLOW', minScore: 35 }, { band: 'ORANGE', minScore: 55 }, { band: 'RED', minScore: 75 }]
};

const withDefaults = (c) => ({
  ...DEFAULT_CONFIG, ...(c || {}),
  labor: { ...DEFAULT_CONFIG.labor, ...(c?.labor || {}) },
  overhead: { ...DEFAULT_CONFIG.overhead, ...(c?.overhead || {}) },
  forecast: { ...DEFAULT_CONFIG.forecast, ...(c?.forecast || {}) },
  riskModel: { ...DEFAULT_RISK_WEIGHTS, ...(c?.riskModel || {}) },
  alertThresholds: { ...DEFAULT_ALERT_THRESHOLDS, ...(c?.alertThresholds || {}) },
  customerSeverity: { ...DEFAULT_CUSTOMER_SEVERITY, ...(c?.customerSeverity || {}) },
  isDefault: !c
});

let cache = { at: 0, list: null };
const allConfigs = async () => {
  if (!cache.list || Date.now() - cache.at > 60000) cache = { at: Date.now(), list: await EconomicsConfig.find().sort({ effectiveFrom: 1, version: 1 }).lean() };
  return cache.list;
};
export const configAt = (list, at = new Date()) => {
  let pick = null;
  for (const c of list) if (new Date(c.effectiveFrom) <= new Date(at)) pick = c;
  return withDefaults(pick);
};
export const activeConfig = async (at = new Date()) => configAt(await allConfigs(), at);
export const listConfigs = async () => toDTO(await EconomicsConfig.find().sort({ version: -1 }).limit(100).lean());

const CONFIG_FIELDS = ['currency', 'defaultLoadedLaborRateCents', 'labor', 'overhead', 'reserveBps', 'defaultTargetMarginBps', 'defaultWarningMarginBps', 'lossToleranceBps', 'adverseTrendBps', 'majorRepairThresholdCents', 'preventiveCategories', 'referralRewardCents', 'membershipGraceDays', 'plans', 'retailValueSource', 'qualificationRules', 'forecast', 'riskBands', 'riskModel', 'alertThresholds', 'customerSeverity'];

const publish = async (req, body, eventType, action) => {
  const latest = await EconomicsConfig.findOne().sort({ version: -1 }).lean();
  const bands = body.riskBands || DEFAULT_CONFIG.riskBands;
  if (bands.some((b, i) => i > 0 && b.minScore <= bands[i - 1].minScore)) throw badRequest('Risk band thresholds must increase');
  if (body.overhead?.method === 'hybrid' && !body.overhead.hybrid?.length) throw badRequest('Hybrid overhead needs weighted components');
  const cfg = await EconomicsConfig.create({ ...body, riskBands: bands, version: (latest?.version || 0) + 1, createdBy: req.auth.userId });
  cache.list = null;
  const changed = CONFIG_FIELDS.filter(k => JSON.stringify(latest?.[k] ?? null) !== JSON.stringify(cfg.toObject()[k] ?? null));
  await audit(req, {
    eventType, category: 'financial', entityType: 'EconomicsConfig', entityId: cfg.id,
    action: `${action(cfg)}; changed: ${changed.join(', ') || 'none'}`,
    before: latest ? Object.fromEntries(changed.map(k => [k, latest[k]])) : undefined,
    after: Object.fromEntries(changed.map(k => [k, cfg[k]])), reason: body.notes
  });
  return toDTO(cfg.toObject());
};

export const saveConfig = (req, input) => publish(req, { ...input, effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date() },
  'ECONOMICS_CONFIG_PUBLISHED', c => `Published economics configuration v${c.version} effective ${c.effectiveFrom.toISOString().slice(0, 10)}`);

// Rollback = a new version that copies an earlier one; history is never rewritten.
export const rollbackConfig = async (req, { toVersion, reason }) => {
  const old = await EconomicsConfig.findOne({ version: toVersion }).lean();
  if (!old) throw notFound('Configuration version');
  const body = Object.fromEntries(CONFIG_FIELDS.map(k => [k, old[k]]));
  return publish(req, { ...body, effectiveFrom: new Date(), rolledBackFromVersion: toVersion, notes: reason },
    'ECONOMICS_CONFIG_ROLLBACK', c => `Rolled back to settings of v${toVersion} as v${c.version}`);
};

// ---------------------------------------------------------------------------
// Ledger posting (idempotent: unique dedupeKey per source fact)
// ---------------------------------------------------------------------------
const CATEGORY_OF = {
  membership_revenue: 'revenue', membership_refund: 'revenue', service_revenue: 'revenue', service_credit: 'revenue', service_debit: 'revenue', other_revenue: 'revenue',
  customer_payment: 'customer_payment', customer_refund: 'customer_payment', payment_failed: 'lifecycle', membership_lifecycle: 'lifecycle',
  parts_cost: 'direct_cost', parts_credit: 'direct_cost', warranty_recovery: 'direct_cost', labor_cost: 'direct_cost', sublet_cost: 'direct_cost',
  towing_cost: 'direct_cost', other_direct_cost: 'direct_cost', referral_reward: 'direct_cost',
  overhead_allocation: 'overhead', covered_retail_value: 'customer_value'
};

export const postEvents = async (events) => {
  if (!events.length) return { inserted: 0, duplicates: 0 };
  const docs = events.map(e => ({ createdBy: 'economics', ...e, category: e.category || CATEGORY_OF[e.type], complete: e.quality !== 'UNKNOWN' }));
  try {
    const res = await EconomicEvent.insertMany(docs, { ordered: false });
    return { inserted: res.length, duplicates: 0 };
  } catch (err) {
    const writeErrors = err.writeErrors || (err.code === 11000 ? [err] : []);
    if (writeErrors.length && writeErrors.every(w => (w.code ?? w.err?.code) === 11000)) {
      const inserted = err.insertedDocs?.length ?? Math.max(0, docs.length - writeErrors.length);
      return { inserted, duplicates: docs.length - inserted }; // duplicates = already posted
    }
    throw err;
  }
};
const add = (a, b) => ({ inserted: (a.inserted || 0) + (b.inserted || 0), duplicates: (a.duplicates || 0) + (b.duplicates || 0) });

const membershipAttribution = async (customerId, vehicleId, at, evaluation) => {
  const applied = evaluation?.memberships?.[0];
  const m = applied
    ? await Membership.findOne({ id: applied.membershipId }).lean()
    : await Membership.findOne({ customerId, status: { $in: ['active', 'past_due'] }, currentPeriodStart: { $lte: at }, $or: [{ vehicleIds: { $size: 0 } }, { vehicleIds: vehicleId }] }).lean();
  return m ? { membershipId: m.id, planId: m.planId, cohort: cohortOf(m) } : {};
};

// Loaded labor rate effective in `cfg` (the configuration in force on the work date).
const loaded = (r, basis) => {
  if (!r) return null;
  if (Number.isSafeInteger(r.loadedRateCents)) return { rate: r.loadedRateCents, basis: `${basis} loaded rate`, quality: 'DERIVED' };
  if (!Number.isSafeInteger(r.baseWageCents)) return null;
  return {
    rate: r.baseWageCents + applyBps(r.baseWageCents, (r.payrollBurdenBps || 0) + (r.laborOverheadBps || 0)) + (r.benefitsPerHourCents || 0),
    basis: `${basis}: wage ${r.baseWageCents} + burden ${r.payrollBurdenBps || 0}bps + labor overhead ${r.laborOverheadBps || 0}bps + benefits ${r.benefitsPerHourCents || 0}/h`,
    quality: 'DERIVED'
  };
};
export const laborRateAt = (cfg, tech) =>
  loaded(cfg.labor?.technicians?.find(t => t.techId && t.techId === tech?.id), `config v${cfg.version} technician`)
  || (Number.isSafeInteger(tech?.laborCostRateCents) ? { rate: tech.laborCostRateCents, basis: 'technician profile rate (not effective-dated)', quality: 'ESTIMATED' } : null)
  || loaded(cfg.labor?.default, `config v${cfg.version} default`)
  || (Number.isSafeInteger(cfg.defaultLoadedLaborRateCents) ? { rate: cfg.defaultLoadedLaborRateCents, basis: `config v${cfg.version} default loaded rate`, quality: 'DERIVED' } : null);

// Overhead: per-RO methods are allocated when the invoice posts; per-member-month
// and location revenue share are allocated by the monthly close.
const RO_METHODS = {
  percent_of_revenue: (o, c) => applyBps(c.revenue, o.rateBps || 0),
  flat_per_repair_order: (o) => o.flatCents || 0,
  per_labor_hour: (o, c) => roundDiv((o.perLaborHourCents || 0) * c.laborMinutes, 60),
  per_bay_hour: (o, c) => roundDiv((o.perBayHourCents || 0) * c.bayMinutes, 60)
};
const overheadComponents = (o) => (o.method === 'hybrid' ? o.hybrid || [] : o.method === 'none' ? [] : [{ method: o.method, weightBps: 10000 }]);

export const postInvoiceEconomics = async (invoiceId, { skipRisk } = {}) => {
  const inv = await Invoice.findOne({ id: invoiceId, status: 'posted' }).lean();
  if (!inv) return { skipped: 'not posted', inserted: 0, duplicates: 0 };
  const at = inv.postedAt || inv.createdAt;
  const configs = await allConfigs();
  const cfg = configAt(configs, at);
  const base = { currency: inv.currency, effectiveAt: at };

  if (inv.kind === 'membership') {
    const m = await Membership.findOne({ id: inv.membershipId }).lean();
    return postEvents([{
      ...base, type: 'membership_revenue', amountCents: inv.totals.totalCents - inv.totals.taxCents,
      attribution: { customerId: inv.customerId, locationId: inv.locationId, invoiceId, membershipId: inv.membershipId, planId: m?.planId, cohort: cohortOf(m) },
      source: { type: 'invoice', id: invoiceId }, dedupeKey: `invoice:${invoiceId}:membership_revenue`,
      calculationContext: { engine: ECONOMICS_ENGINE_VERSION, invoiceNumber: inv.invoiceNumber }
    }]);
  }

  const ro = await RepairOrder.findOne({ id: inv.roId }).lean();
  const memberAttr = await membershipAttribution(inv.customerId, inv.vehicleId, at, inv.membershipEvaluation);
  const jobs = ro?.jobs || [];
  const opCodes = [...new Set([...jobs.map(j => j.laborOpCode), ...inv.lineItems.map(l => l.laborOpCode)].filter(Boolean))];
  const ops = new Map((await LaborOperation.find({ code: { $in: opCodes } }).select('code category').lean()).map(o => [o.code, o.category]));
  const jobCategory = new Map(jobs.map(j => [j.id, ops.get(j.laborOpCode) || 'General']));
  const catOf = (jobId, opCode, kind) => jobCategory.get(jobId) || ops.get(opCode) || (kind === 'fee' ? 'Fees' : 'General');
  const attr = (extra = {}) => ({ customerId: inv.customerId, vehicleId: inv.vehicleId, locationId: inv.locationId, roId: inv.roId, invoiceId, ...memberAttr, ...extra });
  const entries = await TimeEntry.find({ roId: inv.roId, status: 'closed', type: { $in: ['job', 'diagnostic'] } }).lean();
  const techIds = [...new Set([...jobs.map(j => j.techId), ...entries.map(e => e.techId)].filter(Boolean))];
  const techs = new Map((await User.find({ id: { $in: techIds } }).select('id laborCostRateCents').lean()).map(u => [u.id, u]));
  const covered = new Set((inv.membershipEvaluation?.applied || []).map(a => a.lineId)); // membership entitlements only
  const events = [];

  for (const line of inv.lineItems) {
    const serviceCategory = catOf(line.jobId, line.laborOpCode, line.kind);
    const src = { type: 'invoice_line', id: `${invoiceId}:${line.id}` };
    let standardCostCents = null;
    if ((line.kind === 'part' || line.kind === 'sublet') && Number.isSafeInteger(line.unitCostCents)) standardCostCents = roundDiv(line.unitCostCents * Math.round((line.quantity || 1) * 1000), 1000);
    if (line.kind === 'labor' && line.hours) {
      const r = laborRateAt(cfg, techs.get(jobs.find(j => j.id === line.jobId)?.techId));
      standardCostCents = r ? roundDiv(r.rate * Math.round(line.hours * 100), 100) : null;
    }
    events.push({ ...base, type: 'service_revenue', amountCents: line.netCents, quality: 'EXACT', attribution: attr({ serviceCategory }), source: src, dedupeKey: `invoice:${invoiceId}:line:${line.id}:revenue`, standardCostCents, calculationContext: { kind: line.kind, hours: line.hours || null, extendedCents: line.extendedCents, discountCents: line.discountCents } });
    if (line.discountCents > 0 && covered.has(line.estimateLineId)) {
      events.push({ ...base, type: 'covered_retail_value', amountCents: line.extendedCents, quality: 'DERIVED', attribution: attr({ serviceCategory }), source: src, dedupeKey: `invoice:${invoiceId}:line:${line.id}:retail_value`, calculationContext: { customerPaidCents: line.netCents, retailValueSource: cfg.retailValueSource } });
    }
    if (line.kind === 'sublet') {
      const known = standardCostCents != null;
      events.push({ ...base, type: /tow/i.test(line.description || '') ? 'towing_cost' : 'sublet_cost', amountCents: known ? standardCostCents : 0, quality: known ? 'EXACT' : 'UNKNOWN', incompleteReason: known ? undefined : 'Sublet cost not recorded', attribution: attr({ serviceCategory }), source: src, dedupeKey: `invoice:${invoiceId}:line:${line.id}:sublet_cost` });
    }
  }

  // actual parts cost (inventory cost at issue, from purchase-order receipts)
  for (const ip of await InstalledPart.find({ roId: inv.roId }).lean()) {
    const known = Number.isSafeInteger(ip.unitCostCents);
    events.push({ ...base, effectiveAt: ip.installedAt || at, type: 'parts_cost', amountCents: known ? roundDiv(ip.unitCostCents * Math.round((ip.quantity || 1) * 1000), 1000) : 0, quality: known ? 'EXACT' : 'UNKNOWN', incompleteReason: known ? undefined : 'Part cost unknown', attribution: attr({ serviceCategory: catOf(ip.jobId), technicianId: ip.techId }), source: { type: 'installed_part', id: ip.id }, dedupeKey: `installed:${ip.id}:parts_cost`, calculationContext: { partNumber: ip.partNumber, quantity: ip.quantity, unitCostCents: ip.unitCostCents } });
  }

  // actual loaded labor cost: clocked time × rate effective on the date of work
  let laborMinutes = 0;
  for (const e of entries) {
    laborMinutes += e.minutes || 0;
    const workCfg = configAt(configs, e.endAt || at);
    const r = laborRateAt(workCfg, techs.get(e.techId));
    events.push({ ...base, effectiveAt: e.endAt || at, type: 'labor_cost', amountCents: r ? roundDiv(r.rate * (e.minutes || 0), 60) : 0, quality: r ? r.quality : 'UNKNOWN', incompleteReason: r ? undefined : 'No loaded labor rate for technician or default', attribution: attr({ serviceCategory: e.type === 'diagnostic' ? 'Diagnostics' : catOf(e.jobId), technicianId: e.techId }), source: { type: 'time_entry', id: e.id }, dedupeKey: `time:${e.id}:labor_cost`, calculationContext: { minutes: e.minutes, rateCents: r?.rate ?? null, basis: r?.basis, configVersion: workCfg.version, jobId: e.jobId } });
  }

  // overhead allocation per policy in force at posting
  const ctx = { revenue: inv.lineItems.reduce((s, l) => s + l.netCents, 0), laborMinutes, bayMinutes: laborMinutes };
  const parts = overheadComponents(cfg.overhead).filter(p => RO_METHODS[p.method])
    .map(p => ({ method: p.method, weightBps: p.weightBps ?? 10000, cents: applyBps(RO_METHODS[p.method](cfg.overhead, ctx), p.weightBps ?? 10000) }));
  const oh = parts.reduce((s, p) => s + p.cents, 0);
  if (oh > 0) events.push({ ...base, type: 'overhead_allocation', amountCents: oh, quality: 'ESTIMATED', attribution: attr({ serviceCategory: 'Overhead' }), source: { type: 'invoice', id: invoiceId }, dedupeKey: `invoice:${invoiceId}:overhead`, calculationContext: { components: parts, configVersion: cfg.version, bayMinutesBasis: 'clocked technician time' } });

  const result = await postEvents(events);
  if (inv.vehicleId && !skipRisk) await enqueueJob('economics.risk_vehicle', { vehicleId: inv.vehicleId }, `risk:${inv.vehicleId}:${invoiceId}`);
  return result;
};

const invoiceAttribution = async (invoiceId) => {
  const inv = await Invoice.findOne({ id: invoiceId }).lean();
  if (!inv) return null;
  const m = inv.membershipId ? await Membership.findOne({ id: inv.membershipId }).lean() : null;
  const memberAttr = m ? { membershipId: m.id, planId: m.planId, cohort: cohortOf(m) } : await membershipAttribution(inv.customerId, inv.vehicleId, inv.postedAt || new Date(), inv.membershipEvaluation);
  return { inv, attribution: { customerId: inv.customerId, vehicleId: inv.vehicleId, locationId: inv.locationId, roId: inv.roId, invoiceId: inv.id, ...memberAttr } };
};

export const postPaymentEconomics = async (paymentId) => {
  const p = await Payment.findOne({ id: paymentId, status: { $in: ['succeeded', 'failed'] } }).lean();
  const ia = p && await invoiceAttribution(p.invoiceId);
  if (!ia) return { skipped: true };
  if (p.status === 'failed') {
    return postEvents([{ type: 'payment_failed', amountCents: 0, currency: p.currency, effectiveAt: p.updatedAt || p.createdAt, attribution: ia.attribution, source: { type: 'payment', id: p.id }, dedupeKey: `payment:${p.id}:failed`, calculationContext: { attemptedCents: p.amountCents, reason: p.failureReason, invoiceKind: ia.inv.kind } }]);
  }
  return postEvents([{ type: 'customer_payment', amountCents: p.amountCents, currency: p.currency, effectiveAt: p.receivedAt || p.createdAt, attribution: ia.attribution, source: { type: 'payment', id: p.id }, dedupeKey: `payment:${p.id}`, calculationContext: { method: p.method, invoiceKind: ia.inv.kind } }]);
};

export const postRefundEconomics = async (refundId) => {
  const r = await Refund.findOne({ id: refundId, status: 'succeeded' }).lean();
  const ia = r && await invoiceAttribution(r.invoiceId);
  if (!ia) return { skipped: true };
  return postEvents([{ type: 'customer_refund', amountCents: -r.amountCents, currency: r.currency, effectiveAt: r.processedAt || r.updatedAt, attribution: ia.attribution, source: { type: 'refund', id: r.id }, dedupeKey: `refund:${r.id}`, calculationContext: { reason: r.reason, invoiceKind: ia.inv.kind } }]);
};

export const postAdjustmentEconomics = async (adjustmentId) => {
  const a = await FinancialAdjustment.findOne({ id: adjustmentId }).lean();
  const ia = a && await invoiceAttribution(a.invoiceId);
  if (!ia) return { skipped: true };
  const isMembership = ia.inv.kind === 'membership';
  const type = a.direction === 'credit' ? (isMembership ? 'membership_refund' : 'service_credit') : (isMembership ? 'membership_revenue' : 'service_debit');
  return postEvents([{ type, amountCents: a.direction === 'credit' ? -a.amountCents : a.amountCents, currency: a.currency, effectiveAt: a.at, attribution: ia.attribution, source: { type: 'financial_adjustment', id: a.id }, dedupeKey: `adjustment:${a.id}`, calculationContext: { adjustmentType: a.type, reason: a.reason } }]);
};

// Attribution of a repair order from its already-posted revenue events.
const roAttribution = async (roId) => {
  const ev = roId && await EconomicEvent.findOne({ 'attribution.roId': roId, type: 'service_revenue' }).lean();
  if (ev) return { ...ev.attribution, serviceCategory: 'Parts credits', invoiceId: undefined };
  const ro = roId && await RepairOrder.findOne({ id: roId }).select('id customerId vehicleId locationId').lean();
  return ro ? { roId: ro.id, customerId: ro.customerId, vehicleId: ro.vehicleId, locationId: ro.locationId, serviceCategory: 'Parts credits' } : null;
};

// Supplier credits on returned installed parts reduce that repair order's parts cost.
export const postVendorReturnEconomics = async (returnId) => {
  const vr = await VendorReturn.findOne({ id: returnId, status: 'credited' }).lean();
  if (!vr?.creditCents) return { skipped: true };
  const lines = vr.lines.filter(l => l.installedPartId);
  if (!lines.length) return { skipped: 'stock return (inventory, not repair-order cost)' };
  const weight = (l) => (l.unitCostCents || 0) * (l.quantity || 1);
  const totalWeight = vr.lines.reduce((s, l) => s + weight(l), 0) || vr.lines.length;
  const events = [];
  for (const l of lines) {
    const ip = await InstalledPart.findOne({ id: l.installedPartId }).lean();
    const attribution = ip && await roAttribution(ip.roId);
    if (!attribution) continue;
    const share = totalWeight ? Math.floor(vr.creditCents * (weight(l) || 1) / totalWeight) : 0;
    events.push({ type: 'parts_credit', amountCents: -share, currency: 'USD', effectiveAt: vr.creditedAt || new Date(), quality: vr.lines.length > 1 ? 'DERIVED' : 'EXACT', attribution: { ...attribution, locationId: vr.locationId }, source: { type: 'vendor_return', id: vr.id }, dedupeKey: `vendor_return:${vr.id}:${l.installedPartId}`, calculationContext: { returnNumber: vr.returnNumber, creditCents: vr.creditCents, allocation: 'by line cost' } });
  }
  return postEvents(events);
};

export const postWarrantyEconomics = async (failureId) => {
  const f = await PartFailure.findOne({ id: failureId, 'warrantyClaim.status': 'approved' }).lean();
  if (!f?.warrantyClaim?.creditCents) return { skipped: true };
  const attribution = await roAttribution(f.comebackRoId || f.originalRoId);
  if (!attribution) return { skipped: 'repair order not found' };
  return postEvents([{ type: 'warranty_recovery', amountCents: -f.warrantyClaim.creditCents, effectiveAt: f.warrantyClaim.resolvedAt || new Date(), quality: 'EXACT', attribution: { ...attribution, serviceCategory: 'Warranty recovery' }, source: { type: 'part_failure', id: f.id }, dedupeKey: `warranty:${f.id}`, calculationContext: { claimNumber: f.warrantyClaim.claimNumber } }]);
};

export const postReferralEconomics = async (referralId) => {
  const r = await Referral.findOne({ id: referralId, status: 'rewarded' }).lean();
  if (!r?.rewardCents) return { skipped: true };
  const m = await Membership.findOne({ customerId: r.referrerCustomerId, status: { $in: ['active', 'past_due'] } }).lean();
  return postEvents([{ type: 'referral_reward', amountCents: r.rewardCents, effectiveAt: r.rewardedAt || new Date(), quality: 'EXACT', attribution: { customerId: r.referrerCustomerId, membershipId: m?.id, planId: m?.planId, cohort: cohortOf(m), locationId: r.locationId || m?.locationId, serviceCategory: 'Referrals' }, source: { type: 'referral', id: r.id }, dedupeKey: `referral:${r.id}` }]);
};

// Membership lifecycle (non-monetary; keeps status history in the same ledger).
export const recordLifecycle = (m, action, { at = new Date(), by = 'system', key, detail } = {}) => postEvents([{
  type: 'membership_lifecycle', amountCents: 0, effectiveAt: at, createdBy: by,
  attribution: { customerId: m.customerId, membershipId: m.id, planId: m.planId, locationId: m.locationId, cohort: cohortOf(m) },
  source: { type: 'membership', id: m.id }, dedupeKey: `lifecycle:${m.id}:${action}:${key || new Date(at).toISOString()}`,
  calculationContext: { action, status: m.status, planVersion: m.planVersion, ...detail }
}]).catch(() => ({ inserted: 0 }));

const backfillLifecycle = async (m) => {
  let r = await recordLifecycle(m, 'enrolled', { at: m.startedAt || m.createdAt, key: 'initial' });
  if (m.cancelledAt) r = add(r, await recordLifecycle(m, 'cancelled', { at: m.cancelledAt, key: 'initial', detail: { reason: m.cancelReason } }));
  return r;
};

registerJobHandler('economics.invoice', ({ invoiceId }) => postInvoiceEconomics(invoiceId));
registerJobHandler('economics.payment', ({ paymentId }) => postPaymentEconomics(paymentId));
registerJobHandler('economics.refund', ({ refundId }) => postRefundEconomics(refundId));
registerJobHandler('economics.adjustment', ({ adjustmentId }) => postAdjustmentEconomics(adjustmentId));
registerJobHandler('economics.vendor_return', ({ returnId }) => postVendorReturnEconomics(returnId));
registerJobHandler('economics.warranty', ({ failureId }) => postWarrantyEconomics(failureId));
registerJobHandler('economics.referral', ({ referralId }) => postReferralEconomics(referralId));

export const queueEconomics = (type, payload, key) => enqueueJob(`economics.${type}`, payload, `econ:${type}:${key}`).catch(() => {});

// ---------------------------------------------------------------------------
// Monthly close: per-member-month and location revenue-share overhead
// ---------------------------------------------------------------------------
export const monthlyClose = async (month) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('month must be YYYY-MM');
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  if (end > new Date()) throw badRequest('Only completed months can be closed');
  const cfg = await activeConfig(new Date(end - 1));
  const comps = overheadComponents(cfg.overhead);
  const at = new Date(end - 1);
  const ctx = { configVersion: cfg.version, month };
  const events = [];
  const perMember = comps.find(c => c.method === 'per_member_month');
  if (perMember && cfg.overhead.perMemberMonthCents) {
    const cents = applyBps(cfg.overhead.perMemberMonthCents, perMember.weightBps ?? 10000);
    const ms = await Membership.find({ startedAt: { $lt: end }, status: { $ne: 'pending_payment' }, $or: [{ cancelledAt: null }, { cancelledAt: { $gte: start } }] }).lean();
    for (const m of ms.filter(x => !(x.status === 'expired' && x.currentPeriodEnd < start))) {
      events.push({ type: 'overhead_allocation', amountCents: cents, effectiveAt: at, quality: 'ESTIMATED', attribution: { customerId: m.customerId, membershipId: m.id, planId: m.planId, locationId: m.locationId, cohort: cohortOf(m), serviceCategory: 'Overhead' }, source: { type: 'monthly_close', id: month }, dedupeKey: `overhead:member:${m.id}:${month}`, calculationContext: { ...ctx, method: 'per_member_month', weightBps: perMember.weightBps ?? 10000 } });
    }
  }
  const share = comps.find(c => c.method === 'location_revenue_share');
  for (const pool of share ? cfg.overhead.locationMonthlyPools || [] : []) {
    const poolCents = applyBps(pool.monthlyCents || 0, share.weightBps ?? 10000);
    if (!poolCents) continue;
    const rows = (await EconomicEvent.aggregate([
      { $match: { type: 'service_revenue', 'attribution.locationId': pool.locationId, effectiveAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$attribution.roId', rev: { $sum: '$amountCents' }, attr: { $first: '$attribution' } } }
    ])).filter(r => r.rev > 0);
    const total = rows.reduce((s, r) => s + r.rev, 0);
    const base = { type: 'overhead_allocation', effectiveAt: at, quality: 'ESTIMATED', source: { type: 'monthly_close', id: month }, calculationContext: { ...ctx, method: 'location_revenue_share', poolCents } };
    if (!total) { events.push({ ...base, amountCents: poolCents, attribution: { locationId: pool.locationId, serviceCategory: 'Overhead' }, dedupeKey: `overhead:share:loc:${pool.locationId}:${month}` }); continue; }
    // largest-remainder allocation so the shares add up to the pool exactly
    const alloc = rows.map(r => ({ r, cents: Math.floor(poolCents * r.rev / total), rem: (poolCents * r.rev) % total }));
    let left = poolCents - alloc.reduce((s, a) => s + a.cents, 0);
    for (const a of [...alloc].sort((x, y) => y.rem - x.rem)) { if (left <= 0) break; a.cents += 1; left -= 1; }
    for (const a of alloc) events.push({ ...base, amountCents: a.cents, attribution: { ...a.r.attr, invoiceId: undefined, serviceCategory: 'Overhead' }, dedupeKey: `overhead:share:${a.r._id}:${month}`, calculationContext: { ...base.calculationContext, roRevenueCents: a.r.rev, locationRevenueCents: total } });
  }
  return postEvents(events);
};
registerJobHandler('economics.monthly_close', ({ month }) => monthlyClose(month));

// ---------------------------------------------------------------------------
// Manual adjustments: requested by one person, approved by another
// ---------------------------------------------------------------------------
const MANUAL_TYPES = ['other_revenue', 'parts_credit', 'warranty_recovery', 'towing_cost', 'sublet_cost', 'other_direct_cost', 'overhead_allocation', 'reversal'];
const CREDIT_TYPES = ['parts_credit', 'warranty_recovery'];

export const requestAdjustment = async (req, input) => {
  if (!MANUAL_TYPES.includes(input.type)) throw badRequest(`Manual entries must be one of ${MANUAL_TYPES.join(', ')}`);
  let doc = { ...input, effectiveAt: new Date(input.effectiveAt || Date.now()), requestedBy: req.auth.userId };
  if (input.type === 'reversal') {
    const original = await EconomicEvent.findOne({ id: input.reversesEventId }).lean();
    if (!original) throw notFound('Ledger event');
    if (await EconomicEvent.exists({ reversesEventId: original.id }) || await EconomicAdjustment.exists({ reversesEventId: original.id, status: 'pending' })) throw conflict('Event already reversed or reversal pending');
    doc = { ...doc, attribution: original.attribution, amountCents: -original.amountCents, currency: original.currency, quality: original.quality };
  } else {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents === 0) throw badRequest('amountCents must be a non-zero integer');
    doc.amountCents = CREDIT_TYPES.includes(input.type) ? -Math.abs(input.amountCents) : Math.abs(input.amountCents);
  }
  if (doc.attribution?.locationId) assertLocation(req.auth, doc.attribution.locationId);
  else if (!isCorporateScope(req.auth)) throw badRequest('A location is required');
  const created = await EconomicAdjustment.create(doc);
  await audit(req, { eventType: 'ECONOMIC_ADJUSTMENT_REQUESTED', category: 'financial', entityType: 'EconomicAdjustment', entityId: created.id, locationId: doc.attribution?.locationId, action: `Requested ${doc.type} of ${doc.amountCents} cents`, reason: doc.reason });
  return toDTO(created.toObject());
};

export const listAdjustments = async (auth, { status = 'pending' }) => {
  const filter = { status };
  if (!isCorporateScope(auth)) filter['attribution.locationId'] = { $in: auth.locationIds };
  return toDTO(await EconomicAdjustment.find(filter).sort({ createdAt: -1 }).limit(200).lean());
};

export const decideAdjustment = async (req, id, { approve, note }) => {
  const adj = await EconomicAdjustment.findOne({ id, status: 'pending' }).lean();
  if (!adj) throw notFound('Pending adjustment');
  if (adj.requestedBy === req.auth.userId) throw forbidden('A different person must approve this adjustment');
  if (adj.attribution?.locationId) assertLocation(req.auth, adj.attribution.locationId);
  let eventId;
  if (approve) {
    // a reversal is a compensating entry of the original type with the opposite sign
    const original = adj.type === 'reversal' ? await EconomicEvent.findOne({ id: adj.reversesEventId }).lean() : null;
    if (adj.type === 'reversal' && (!original || await EconomicEvent.exists({ reversesEventId: original.id }))) throw conflict('Original event missing or already reversed');
    const type = original ? original.type : adj.type;
    const [ev] = await EconomicEvent.create([{
      type, category: CATEGORY_OF[type],
      amountCents: adj.amountCents, currency: adj.currency, effectiveAt: adj.effectiveAt, attribution: adj.attribution, quality: adj.quality,
      reversesEventId: adj.reversesEventId, adjustmentId: adj.id, source: { type: 'manual_adjustment', id: adj.id }, dedupeKey: `manual:${adj.id}`,
      calculationContext: { reason: adj.reason, requestedBy: adj.requestedBy, approvedBy: req.auth.userId }, createdBy: req.auth.userId
    }]);
    eventId = ev.id;
  }
  const updated = await EconomicAdjustment.findOneAndUpdate({ id, status: 'pending' }, { $set: { status: approve ? 'approved' : 'rejected', decidedBy: req.auth.userId, decidedAt: new Date(), decisionNote: note, eventId } }, { new: true }).lean();
  await audit(req, { eventType: approve ? 'ECONOMIC_ADJUSTMENT_APPROVED' : 'ECONOMIC_ADJUSTMENT_REJECTED', category: 'financial', entityType: 'EconomicAdjustment', entityId: id, locationId: adj.attribution?.locationId, action: `${approve ? 'Approved' : 'Rejected'} ${adj.type} of ${adj.amountCents} cents`, reason: note });
  return toDTO(updated);
};

// ---------------------------------------------------------------------------
// Resumable historical backfill (chunked background job; safe to re-run)
// ---------------------------------------------------------------------------
const CHUNK = 150;
const BACKFILL = [
  ['invoices', () => Invoice, { status: 'posted' }, (d) => postInvoiceEconomics(d.id, { skipRisk: true })],
  ['payments', () => Payment, { status: { $in: ['succeeded', 'failed'] } }, (d) => postPaymentEconomics(d.id)],
  ['refunds', () => Refund, { status: 'succeeded' }, (d) => postRefundEconomics(d.id)],
  ['adjustments', () => FinancialAdjustment, {}, (d) => postAdjustmentEconomics(d.id)],
  ['vendor_returns', () => VendorReturn, { status: 'credited' }, (d) => postVendorReturnEconomics(d.id)],
  ['warranty', () => PartFailure, { 'warrantyClaim.status': 'approved' }, (d) => postWarrantyEconomics(d.id)],
  ['referrals', () => Referral, { status: 'rewarded' }, (d) => postReferralEconomics(d.id)],
  ['memberships', () => Membership, {}, (d) => backfillLifecycle(d)]
];

registerJobHandler('economics.backfill', async ({ runId, phase = 'invoices', after = '' }) => {
  const i = BACKFILL.findIndex(p => p[0] === phase);
  const [, Model, filter, fn] = BACKFILL[i];
  const docs = await Model().find({ ...filter, ...(after ? { id: { $gt: after } } : {}) }).sort({ id: 1 }).limit(CHUNK).lean();
  let counts = { inserted: 0, duplicates: 0 };
  for (const d of docs) counts = add(counts, await fn(d));
  const next = docs.length === CHUNK ? { phase, after: docs.at(-1).id } : BACKFILL[i + 1] ? { phase: BACKFILL[i + 1][0], after: '' } : null;
  if (next) await enqueueJob('economics.backfill', { runId, ...next }, `backfill:${runId}:${next.phase}:${next.after}`);
  else {
    // close every completed month that has ledger activity
    const first = await EconomicEvent.findOne().sort({ effectiveAt: 1 }).lean();
    const cur = first ? new Date(`${monthOf(first.effectiveAt)}-01T00:00:00Z`) : null;
    while (cur && monthOf(cur) < monthOf(new Date())) { await enqueueJob('economics.monthly_close', { month: monthOf(cur) }, `close:${monthOf(cur)}:${runId}`); cur.setUTCMonth(cur.getUTCMonth() + 1); }
  }
  return { runId, phase, processed: docs.length, ...counts, done: !next };
});

export const startBackfill = async (req) => {
  const runId = `${Date.now().toString(36)}`;
  await enqueueJob('economics.backfill', { runId, phase: 'invoices', after: '' }, `backfill:${runId}:invoices:`);
  await audit(req, { eventType: 'ECONOMIC_LEDGER_BACKFILL', category: 'financial', entityType: 'EconomicEvent', entityId: runId, action: `Started ledger backfill run ${runId}` });
  return { runId };
};

export const backfillStatus = async (runId) => {
  const jobs = await Job.find({ type: 'economics.backfill', ...(runId ? { 'payload.runId': runId } : {}) }).sort({ createdAt: -1 }).limit(runId ? 500 : 50).lean();
  const id = runId || jobs[0]?.payload?.runId;
  const mine = jobs.filter(j => j.payload?.runId === id);
  const phases = {};
  for (const j of mine) {
    const p = (phases[j.payload.phase] ||= { processed: 0, inserted: 0, duplicates: 0, pending: 0, failed: 0 });
    if (j.status === 'completed') { p.processed += j.result?.processed || 0; p.inserted += j.result?.inserted || 0; p.duplicates += j.result?.duplicates || 0; }
    else if (['failed', 'dead'].includes(j.status) || j.lastError) p.failed += 1;
    else p.pending += 1;
  }
  return { runId: id || null, done: mine.some(j => j.result?.done), phases, errors: mine.filter(j => j.lastError).map(j => ({ phase: j.payload.phase, error: j.lastError, status: j.status })) };
};

// Historical import from an earlier system, with provenance and data quality.
const IMPORT_TYPES = ECONOMIC_TYPES.filter(t => !['membership_lifecycle', 'reversal', 'covered_retail_value'].includes(t));
export const importHistorical = async (req, { sourceSystem, rows }) => {
  const result = { imported: 0, duplicates: 0, rejected: [] };
  const reject = (row, reason) => result.rejected.push({ externalId: row.externalId, reason });
  for (const row of rows) {
    if (!row.externalId) { reject(row, 'externalId required'); continue; }
    const vehicle = row.vin ? await Vehicle.findOne({ vin: row.vin.toUpperCase() }).lean() : null;
    if (row.vin && !vehicle) { reject(row, `VIN ${row.vin} not found`); continue; }
    const membership = row.membershipNumber ? await Membership.findOne({ number: row.membershipNumber }).lean() : null;
    if (row.membershipNumber && !membership) { reject(row, `Membership ${row.membershipNumber} not found`); continue; }
    const ro = row.roNumber ? await RepairOrder.findOne({ roNumber: row.roNumber }).select('id locationId').lean() : null;
    const locationId = row.locationId || ro?.locationId || membership?.locationId;
    if (locationId && !isCorporateScope(req.auth) && !req.auth.locationIds.includes(locationId)) { reject(row, 'Location not in your scope'); continue; }
    const at = new Date(row.effectiveAt);
    if (Number.isNaN(at.getTime())) { reject(row, 'effectiveAt invalid'); continue; }
    if (row.kind === 'mileage') {
      if (!vehicle || !Number.isSafeInteger(row.odometer)) { reject(row, 'mileage rows need a known VIN and integer odometer'); continue; }
      const sourceRef = `${sourceSystem}:${row.externalId}`;
      if (await MileageRecord.exists({ sourceRef })) { result.duplicates += 1; continue; }
      await MileageRecord.create({ vehicleId: vehicle.id, odometer: row.odometer, unit: row.unit || 'mi', recordedAt: at, source: 'import', sourceRef, recordedBy: req.auth.userId, note: row.note });
      result.imported += 1;
      continue;
    }
    if (!IMPORT_TYPES.includes(row.type)) { reject(row, 'unsupported type'); continue; }
    if (!DATA_QUALITY.includes(row.quality)) { reject(row, 'quality must be EXACT, DERIVED, ESTIMATED or UNKNOWN'); continue; }
    if (!Number.isSafeInteger(row.amountCents)) { reject(row, 'amountCents must be integer cents'); continue; }
    const r = await postEvents([{
      type: row.type, amountCents: row.amountCents, currency: row.currency || 'USD', effectiveAt: at, quality: row.quality,
      incompleteReason: row.quality === 'UNKNOWN' ? 'Imported without a known value' : undefined,
      attribution: { customerId: vehicle?.customerId || membership?.customerId, vehicleId: vehicle?.id, membershipId: membership?.id, planId: membership?.planId, cohort: cohortOf(membership), locationId, roId: ro?.id, serviceCategory: row.serviceCategory },
      source: { type: 'import', id: row.externalId, system: sourceSystem }, dedupeKey: `import:${sourceSystem}:${row.externalId}`,
      calculationContext: { note: row.note, roNumber: row.roNumber }, createdBy: req.auth.userId
    }]);
    result.imported += r.inserted; result.duplicates += r.duplicates;
  }
  await audit(req, { eventType: 'ECONOMIC_HISTORY_IMPORTED', category: 'financial', entityType: 'EconomicEvent', entityId: sourceSystem, action: `Imported ${result.imported} rows from ${sourceSystem} (${result.duplicates} already present, ${result.rejected.length} rejected)` });
  return result;
};

// ---------------------------------------------------------------------------
// Roll-ups (live from the ledger; nothing cached is authoritative)
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
  for (const k of ['planId', 'membershipId', 'vehicleId', 'customerId', 'roId', 'serviceCategory', 'cohort']) if (filters[k]) match[`attribution.${k}`] = String(filters[k]);
  return match;
};

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : null);

export const rollup = async (auth, { groupBy = 'portfolio', from, to, page, limit, ...filters }) => {
  if (!(groupBy in GROUP_FIELDS)) throw badRequest(`groupBy must be one of ${Object.keys(GROUP_FIELDS).join(', ')}`);
  const end = to ? new Date(to) : new Date(Date.now() + DAY);
  const start = from ? new Date(from) : new Date(end.getTime() - 366 * DAY);
  const match = { ...scopeMatch(auth, filters), effectiveAt: { $gte: start, $lt: end } };
  const rows = await EconomicEvent.aggregate([
    { $match: match },
    { $group: {
      _id: { key: GROUP_FIELDS[groupBy], type: '$type' },
      amount: { $sum: '$amountCents' },
      n: { $sum: 1 },
      standard: { $sum: { $ifNull: ['$standardCostCents', 0] } },
      customerPaid: { $sum: { $ifNull: ['$calculationContext.customerPaidCents', 0] } },
      membershipPay: { $sum: { $cond: [{ $eq: ['$calculationContext.invoiceKind', 'membership'] }, '$amountCents', 0] } },
      exact: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$quality', 'EXACT'] }, 'EXACT'] }, 1, 0] } },
      derived: { $sum: { $cond: [{ $eq: ['$quality', 'DERIVED'] }, 1, 0] } },
      estimated: { $sum: { $cond: [{ $eq: ['$quality', 'ESTIMATED'] }, 1, 0] } },
      unknown: { $sum: { $cond: [{ $eq: ['$quality', 'UNKNOWN'] }, 1, 0] } },
      reasons: { $addToSet: '$incompleteReason' },
      memberships: { $addToSet: '$attribution.membershipId' }
    } }
  ]);
  const cfg = await activeConfig(end);
  const groups = new Map();
  const allMemberships = new Set();
  for (const r of rows) {
    const key = r._id.key ?? (groupBy === 'portfolio' ? 'all' : null);
    const g = groups.get(key) || { key, t: {}, standard: 0, coveredPaid: 0, membershipPay: 0, q: { EXACT: 0, DERIVED: 0, ESTIMATED: 0, UNKNOWN: 0 }, reasons: new Set(), memberships: new Set() };
    g.t[r._id.type] = (g.t[r._id.type] || 0) + r.amount;
    g.standard += r.standard;
    if (r._id.type === 'covered_retail_value') g.coveredPaid += r.customerPaid;
    if (r._id.type === 'customer_payment' || r._id.type === 'customer_refund') g.membershipPay += r.membershipPay;
    g.q.EXACT += r.exact; g.q.DERIVED += r.derived; g.q.ESTIMATED += r.estimated; g.q.UNKNOWN += r.unknown;
    r.reasons.filter(Boolean).forEach(x => g.reasons.add(x));
    r.memberships.filter(Boolean).forEach(x => { g.memberships.add(x); allMemberships.add(x); });
    groups.set(key, g);
  }
  const planOf = new Map((await Membership.find({ id: { $in: [...allMemberships] } }).select('id planId').lean()).map(m => [m.id, m.planId]));
  const days = Math.max(1, (Math.min(end, Date.now()) - start) / DAY);
  let out = [...groups.values()].map((g) => {
    const t = (k) => g.t[k] || 0;
    const membershipRevenue = t('membership_revenue');
    const serviceRevenue = t('service_revenue') + t('service_debit');
    const otherRevenue = t('other_revenue');
    const creditsRefunds = t('membership_refund') + t('service_credit');
    const revenue = membershipRevenue + serviceRevenue + otherRevenue + creditsRefunds;
    const partsCost = t('parts_cost') + t('parts_credit') + t('warranty_recovery');
    const laborCost = t('labor_cost');
    const otherDirect = t('sublet_cost') + t('towing_cost') + t('other_direct_cost') + t('referral_reward');
    const directCost = partsCost + laborCost + otherDirect;
    const overhead = t('overhead_allocation');
    const netProfit = revenue - directCost - overhead;
    const retailValue = t('covered_retail_value');
    let expected = 0; let known = 0;
    for (const mid of g.memberships) {
      const pe = cfg.plans.find(p => p.planId === planOf.get(mid));
      if (pe?.expectedAnnualDirectCostCents != null) { expected += Math.round(pe.expectedAnnualDirectCostCents * days / 365); known += 1; }
    }
    const customerPayments = t('customer_payment') + t('customer_refund');
    return {
      key: g.key,
      membershipRevenueCents: membershipRevenue, serviceRevenueCents: serviceRevenue, otherRevenueCents: otherRevenue, creditsRefundsCents: creditsRefunds,
      revenueCents: revenue, partsCostCents: partsCost, laborCostCents: laborCost, otherDirectCostCents: otherDirect, directCostCents: directCost,
      overheadCents: overhead, totalCostCents: directCost + overhead, netProfitCents: netProfit, realizedMarginPct: pct(netProfit, revenue),
      membershipPaymentsCents: g.membershipPay, servicePaymentsCents: customerPayments - g.membershipPay, customerPaymentsCents: customerPayments,
      eligibleRetailValueCents: retailValue, customerSavingsCents: retailValue ? retailValue - g.coveredPaid : 0,
      netValueAfterMembershipFeesCents: retailValue ? retailValue - g.coveredPaid - g.membershipPay : null,
      standardDirectCostCents: g.standard || null, costVarianceCents: g.standard ? directCost - g.standard : null,
      expectedDirectCostCents: known ? expected : null, utilizationIndex: known && expected ? Math.round((directCost / expected) * 100) / 100 : null,
      dataQuality: g.q, incompleteEvents: g.q.UNKNOWN, incompleteReasons: [...g.reasons], verified: g.q.UNKNOWN === 0
    };
  });
  out.sort((a, b) => (groupBy === 'period' ? String(a.key).localeCompare(String(b.key)) : b.revenueCents - a.revenueCents));
  const total = out.length;
  if (limit) { const l = Math.min(Number(limit), 200); out = out.slice((Math.max(1, Number(page) || 1) - 1) * l, Math.max(1, Number(page) || 1) * l); }
  await attachLabels(groupBy, out);
  return {
    groupBy, from: start, to: end, engineVersion: ECONOMICS_ENGINE_VERSION, configVersion: cfg.version, configIsDefault: Boolean(cfg.isDefault), total,
    definitions: {
      netProfitCents: 'membership revenue + customer-pay service revenue + other revenue − credits/refunds − parts (net of supplier credits and warranty recoveries) − loaded labor − sublet/towing/other direct − allocated overhead',
      realizedMarginPct: 'net profit / net revenue × 100 (null when revenue is 0)',
      customerSavingsCents: 'retail value of membership-covered services − what the customer paid for those services (membership fees shown separately)',
      netValueAfterMembershipFeesCents: 'customer savings − membership payments (optional view, labeled separately)',
      utilizationIndex: 'actual direct cost / plan expected direct cost prorated to the period (null without a configured baseline)',
      costVarianceCents: 'actual direct cost − standard cost (invoice part cost + sold hours × loaded rate)',
      dataQuality: 'event counts: EXACT (source record), DERIVED (computed by a configured rule), ESTIMATED (allocation), UNKNOWN (input missing)'
    },
    rows: out
  };
};

const attachLabels = async (groupBy, rows) => {
  const ids = rows.map(r => r.key).filter(k => k && k !== 'all');
  let labels = new Map();
  if (groupBy === 'plan') labels = new Map((await MembershipPlan.find({ planId: { $in: ids } }).sort({ version: 1 }).lean()).map(p => [p.planId, p.name]));
  if (groupBy === 'location') labels = new Map((await Location.find({ id: { $in: ids } }).lean()).map(l => [l.id, l.name]));
  if (groupBy === 'vehicle') labels = new Map((await Vehicle.find({ id: { $in: ids } }).lean()).map(v => [v.id, `${v.year} ${v.make} ${v.model}${v.vin ? ` · ${v.vin}` : ''}`]));
  if (groupBy === 'membership') {
    const ms = await Membership.find({ id: { $in: ids } }).lean();
    const cs = await Customer.find({ id: { $in: ms.map(m => m.customerId) } }).select('id name').lean();
    labels = new Map(ms.map(m => [m.id, `${m.number} · ${cs.find(c => c.id === m.customerId)?.name || ''}`]));
  }
  if (groupBy === 'ro') labels = new Map((await RepairOrder.find({ id: { $in: ids } }).select('id roNumber').lean()).map(r => [r.id, r.roNumber]));
  for (const r of rows) r.label = r.key === 'all' ? 'Portfolio' : labels.get(r.key) || r.key || 'Unattributed';
};

export const ledgerEvents = async (auth, { page, limit, ...filters }) => {
  const match = scopeMatch(auth, filters);
  if (filters.type) match.type = filters.type;
  if (filters.quality) match.quality = filters.quality;
  if (filters.sourceType) match['source.type'] = filters.sourceType;
  const l = Math.min(Number(limit) || 100, 500);
  const p = Math.max(1, Number(page) || 1);
  const [events, total] = await Promise.all([EconomicEvent.find(match).sort({ effectiveAt: -1 }).skip((p - 1) * l).limit(l).lean(), EconomicEvent.countDocuments(match)]);
  return { events: toDTO(events), total, page: p, limit: l };
};

// ---------------------------------------------------------------------------
// Reconciliation and recalculation
// ---------------------------------------------------------------------------
const sumBy = async (Model, match, field) => (await Model.aggregate([{ $match: match }, { $group: { _id: null, s: { $sum: field } } }]))[0]?.s || 0;

export const reconcile = async (auth, { from, to, locationId, membershipId } = {}) => {
  const end = to ? new Date(to) : new Date(Date.now() + DAY);
  const start = from ? new Date(from) : new Date(end - 366 * DAY);
  const ledger = { ...scopeMatch(auth, { locationId, membershipId }), effectiveAt: { $gte: start, $lt: end } };
  const loc = ledger['attribution.locationId'] ? { locationId: ledger['attribution.locationId'] } : {};
  const invFilter = { status: 'posted', postedAt: { $gte: start, $lt: end }, ...loc, ...(membershipId ? { $or: [{ membershipId }, { id: { $in: await EconomicEvent.distinct('attribution.invoiceId', { 'attribution.membershipId': membershipId }) } }] } : {}) };
  const invoices = await Invoice.find(invFilter).select('id invoiceNumber kind totals lineItems').lean();
  const ledgerByInvoice = new Map((await EconomicEvent.aggregate([{ $match: { 'attribution.invoiceId': { $in: invoices.map(i => i.id) }, type: { $in: ['service_revenue', 'membership_revenue'] }, 'source.type': { $in: ['invoice', 'invoice_line'] } } }, { $group: { _id: '$attribution.invoiceId', s: { $sum: '$amountCents' } } }])).map(r => [r._id, r.s]));
  const sourceRevenue = invoices.reduce((s, i) => s + (i.kind === 'membership' ? i.totals.totalCents - i.totals.taxCents : i.lineItems.reduce((x, l) => x + l.netCents, 0)), 0);
  const missing = invoices.filter(i => !ledgerByInvoice.has(i.id)).map(i => ({ id: i.id, invoiceNumber: i.invoiceNumber }));
  const mismatched = invoices.filter(i => ledgerByInvoice.has(i.id) && ledgerByInvoice.get(i.id) !== (i.kind === 'membership' ? i.totals.totalCents - i.totals.taxCents : i.lineItems.reduce((x, l) => x + l.netCents, 0))).map(i => ({ id: i.id, invoiceNumber: i.invoiceNumber }));
  const ids = invoices.map(i => i.id);
  const paySource = await sumBy(Payment, { status: 'succeeded', invoiceId: { $in: ids } }, '$amountCents');
  const payLedger = await sumBy(EconomicEvent, { type: 'customer_payment', 'attribution.invoiceId': { $in: ids } }, '$amountCents');
  const refundSource = await sumBy(Refund, { status: 'succeeded', invoiceId: { $in: ids } }, '$amountCents');
  const refundLedger = -(await sumBy(EconomicEvent, { type: 'customer_refund', 'attribution.invoiceId': { $in: ids } }, '$amountCents'));
  const check = (name, sourceCents, ledgerCents) => ({ check: name, sourceCents, ledgerCents, differenceCents: ledgerCents - sourceCents, ok: ledgerCents === sourceCents });
  const ledgerRevenue = [...ledgerByInvoice.values()].reduce((s, v) => s + v, 0);
  const source = [check('Invoice revenue (ex tax)', sourceRevenue, ledgerRevenue), check('Payments on these invoices', paySource, payLedger), check('Refunds on these invoices', refundSource, refundLedger)];
  // detail vs aggregate: every grouping must add up to the same portfolio totals
  const q = { from: start.toISOString(), to: end.toISOString(), locationId, membershipId };
  const portfolio = (await rollup(auth, { ...q, groupBy: 'portfolio' })).rows[0] || { netProfitCents: 0, revenueCents: 0 };
  const detail = await sumBy(EconomicEvent, { ...ledger, category: { $in: ['revenue', 'direct_cost', 'overhead'] } }, { $cond: [{ $eq: ['$category', 'revenue'] }, '$amountCents', { $multiply: ['$amountCents', -1] }] });
  const aggregates = [check('Ledger detail vs portfolio net profit', detail, portfolio.netProfitCents)];
  for (const g of ['location', 'plan', 'membership', 'vehicle', 'period']) {
    const rows = (await rollup(auth, { ...q, groupBy: g })).rows;
    aggregates.push(check(`Σ ${g} rows vs portfolio net profit`, portfolio.netProfitCents, rows.reduce((s, r) => s + r.netProfitCents, 0)));
  }
  const unknown = await EconomicEvent.countDocuments({ ...ledger, quality: 'UNKNOWN' });
  return { from: start, to: end, source, aggregates, missingInvoices: missing, mismatchedInvoices: mismatched, unknownQualityEvents: unknown, ok: [...source, ...aggregates].every(c => c.ok) && !missing.length && !mismatched.length };
};

export const recalculateMembership = async (req, membershipId) => {
  const t0 = Date.now();
  const m = await Membership.findOne({ $or: [{ id: membershipId }, { number: membershipId }] }).lean();
  if (!m) throw notFound('Membership');
  if (m.locationId) assertLocation(req.auth, m.locationId);
  const vehicleIds = m.vehicleIds.length ? m.vehicleIds : await Vehicle.distinct('id', { customerId: m.customerId });
  const invoices = await Invoice.find({ status: 'posted', $or: [{ membershipId: m.id }, { customerId: m.customerId, vehicleId: { $in: vehicleIds } }] }).select('id').lean();
  const invIds = invoices.map(i => i.id);
  let counts = await backfillLifecycle(m);
  for (const id of invIds) counts = add(counts, await postInvoiceEconomics(id, { skipRisk: true }));
  for (const p of await Payment.find({ invoiceId: { $in: invIds }, status: { $in: ['succeeded', 'failed'] } }).select('id').lean()) counts = add(counts, await postPaymentEconomics(p.id));
  for (const r of await Refund.find({ invoiceId: { $in: invIds }, status: 'succeeded' }).select('id').lean()) counts = add(counts, await postRefundEconomics(r.id));
  for (const a of await FinancialAdjustment.find({ invoiceId: { $in: invIds } }).select('id').lean()) counts = add(counts, await postAdjustmentEconomics(a.id));
  const { assessVehicle } = await import('./riskService.js');
  const risk = [];
  for (const v of vehicleIds) risk.push(await assessVehicle(v).then(s => ({ vehicleId: v, band: s.band, profitabilityState: s.profitabilityState })).catch(e => ({ vehicleId: v, error: e.message })));
  const reconciliation = await reconcile(req.auth, { membershipId: m.id, from: '2000-01-01' });
  const ms = Date.now() - t0;
  await audit(req, { eventType: 'ECONOMICS_RECALCULATED', category: 'financial', entityType: 'Membership', entityId: m.id, locationId: m.locationId, action: `Recalculated ${m.number}: ${counts.inserted} new events, ${counts.duplicates} already posted, ${ms} ms, reconciled ${reconciliation.ok ? 'OK' : 'with differences'}` });
  return { membershipId: m.id, ...counts, invoices: invIds.length, risk, reconciliation, ms };
};
