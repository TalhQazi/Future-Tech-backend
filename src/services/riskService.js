import {
  RiskSnapshot, Intervention, EconomicEvent, Vehicle, Membership, MembershipPlan, RepairOrder, Finding, EstimateVersion,
  PredictiveSignal, ConfirmedFix, User
} from '../models/index.js';
import { audit } from './audit.js';
import { activeConfig } from './economicsService.js';
import { registerJobHandler, enqueueJob } from './jobService.js';
import { notifyRoles, notifyUsers } from './notificationService.js';
import { assertLocation, locationFilter, can, isCorporateScope } from '../security/access.js';
import { notFound, badRequest, conflict, forbidden } from '../lib/errors.js';
import { applyBps } from '../lib/money.js';
import { toDTO } from '../lib/http.js';

// Deterministic, explainable baseline. No trained model is involved; every
// number is derived from ledger events, repair history and configuration.
export const RISK_MODEL_VERSION = 'risk-baseline-1';
const DAY = 86400000;

const bandFor = (score, bands) => [...bands].sort((a, b) => b.minScore - a.minScore).find(b => score >= b.minScore)?.band || 'GREEN';

export const assessVehicle = async (vehicleId) => {
  const vehicle = await Vehicle.findOne({ id: vehicleId }).lean();
  if (!vehicle) throw notFound('Vehicle');
  const cfg = await activeConfig();
  const now = new Date();
  const windowStart = new Date(now - cfg.forecast.historyWindowDays * DAY);
  const membership = await Membership.findOne({ customerId: vehicle.customerId, status: { $in: ['active', 'past_due'] }, $or: [{ vehicleIds: { $size: 0 } }, { vehicleIds: vehicleId }] }).lean();
  const plan = membership ? await MembershipPlan.findOne({ planId: membership.planId, version: membership.planVersion }).lean() : null;
  const planEcon = membership ? cfg.plans.find(p => p.planId === membership.planId) : null;

  const [costs, ros, declined, signals, comebacks, membershipRevenue] = await Promise.all([
    EconomicEvent.find({ 'attribution.vehicleId': vehicleId, category: 'direct_cost', effectiveAt: { $gte: windowStart } }).select('amountCents effectiveAt complete').lean(),
    RepairOrder.find({ vehicleId, status: { $ne: 'cancelled' }, createdAt: { $gte: windowStart } }).select('id roNumber appointmentId createdAt locationId').lean(),
    Finding.find({ vehicleId, status: 'active', customerDecision: 'declined', severity: { $in: ['safety', 'repair'] } }).select('id name severity roId').lean(),
    PredictiveSignal.find({ vehicleId, status: 'open' }).lean(),
    ConfirmedFix.countDocuments({ 'vehicle.vehicleId': vehicleId, status: 'comeback' }),
    membership ? EconomicEvent.aggregate([{ $match: { 'attribution.membershipId': membership.id, type: { $in: ['membership_revenue', 'membership_refund'] }, effectiveAt: { $gte: new Date(now - 365 * DAY) } } }, { $group: { _id: null, s: { $sum: '$amountCents' } } }]) : []
  ]);

  // history depth -> confidence (data sufficiency, not a statistical claim)
  const firstSeen = ros.length ? Math.min(...ros.map(r => r.createdAt.getTime())) : null;
  const observedDays = firstSeen ? Math.max(30, (now - firstSeen) / DAY) : 0;
  const visits = ros.length;
  const f = cfg.forecast;
  const confidence = visits >= f.minVisitsForHigh && observedDays >= f.minHistoryDaysForHigh ? 'high'
    : visits >= f.minVisitsForMedium && observedDays >= f.minHistoryDaysForMedium ? 'medium' : 'low';
  const confidenceBasis = `${visits} visit(s) over ${Math.round(observedDays)} day(s) of history (high ≥ ${f.minVisitsForHigh} visits & ${f.minHistoryDaysForHigh} days; medium ≥ ${f.minVisitsForMedium} & ${f.minHistoryDaysForMedium})`;

  // expected direct cost: own run-rate blended with the plan baseline
  const totalCost = costs.reduce((s, c) => s + c.amountCents, 0);
  const runRateDaily = observedDays ? totalCost / observedDays : null;
  const baselineDaily = planEcon?.expectedAnnualDirectCostCents != null ? planEcon.expectedAnnualDirectCostCents / 365 : null;
  const w = Math.min(1, observedDays / 365);
  const daily = runRateDaily != null && baselineDaily != null ? w * runRateDaily + (1 - w) * baselineDaily : runRateDaily ?? baselineDaily;
  const visitRate = observedDays ? visits / observedDays : null;
  const horizons = daily == null ? [] : f.horizonsDays.map(days => ({
    days, expectedDirectCostCents: Math.round(daily * days), expectedVisits: visitRate != null ? Math.round(visitRate * days * 100) / 100 : null
  }));

  // unscheduled-visit likelihood over the next year (Poisson on observed rate)
  const unscheduled = ros.filter(r => !r.appointmentId).length;
  const unscheduledLikelihood = observedDays ? Math.round((1 - Math.exp(-(unscheduled / observedDays) * 365)) * 100) / 100 : null;

  // major-repair exposure: declined safety/repair work still outstanding
  const findingIds = declined.map(fd => fd.id);
  let exposure = 0;
  if (findingIds.length) {
    const versions = await EstimateVersion.find({ 'lines.findingIds': { $in: findingIds } }).sort({ versionNumber: -1 }).lean();
    const seen = new Set();
    for (const v of versions) for (const l of v.lines) {
      if (l.findingIds?.some(id => findingIds.includes(id)) && !seen.has(l.id)) { seen.add(l.id); exposure += l.netCents ?? l.totalCents ?? 0; }
    }
  }

  // projected membership margin over 12 months
  let projectedMarginPct = null;
  const forecast365 = horizons.find(h => h.days === 365)?.expectedDirectCostCents;
  const annualRevenue = membership ? (membershipRevenue[0]?.s || (membership.billingCycle === 'monthly' ? (plan?.priceMonthlyCents || 0) * 12 : plan?.priceAnnualCents || 0)) : null;
  if (annualRevenue && forecast365 != null) {
    const overhead = cfg.overhead.method === 'percent_of_revenue' ? applyBps(annualRevenue, cfg.overhead.rateBps) : 0;
    const reserve = applyBps(annualRevenue, cfg.reserveBps || 0);
    projectedMarginPct = Math.round(((annualRevenue - forecast365 - overhead - reserve) / annualRevenue) * 10000) / 100;
  }

  // explainable score
  const drivers = [];
  const add = (factor, points, value, explanation) => { if (points > 0) drivers.push({ factor, points: Math.round(points), value, explanation }); };
  if (runRateDaily != null && baselineDaily) {
    const ratio = runRateDaily / baselineDaily;
    add('utilization', Math.min(30, Math.max(0, (ratio - 1) * 40)), Math.round(ratio * 100) / 100, `Direct cost run-rate is ${ratio.toFixed(2)}× the plan baseline`);
  }
  add('declined_repairs', Math.min(30, declined.length * 10), declined.length, `${declined.length} declined safety/repair finding(s): ${declined.map(d => d.name).join(', ')}`);
  const repeat = signals.filter(s => s.ruleKey && s.title?.startsWith('Recurring'));
  add('repeat_dtc', Math.min(20, repeat.length * 10), repeat.length, `${repeat.length} recurring trouble code signal(s)`);
  add('comebacks', Math.min(20, comebacks * 10), comebacks, `${comebacks} repair comeback(s) recorded`);
  if (vehicle.mileage >= 150000) add('mileage', 10, vehicle.mileage, 'Odometer above 150,000');
  else if (vehicle.mileage >= 100000) add('mileage', 5, vehicle.mileage, 'Odometer above 100,000');
  if (projectedMarginPct != null) {
    const warn = (planEcon?.warningMarginBps ?? cfg.defaultWarningMarginBps) / 100;
    if (projectedMarginPct < 0) add('projected_margin', 25, projectedMarginPct, `Projected membership margin ${projectedMarginPct}% is negative`);
    else if (projectedMarginPct < warn) add('projected_margin', 15, projectedMarginPct, `Projected membership margin ${projectedMarginPct}% is below the ${warn}% warning threshold`);
  }
  const score = Math.min(100, drivers.reduce((s, d) => s + d.points, 0));
  const band = bandFor(score, cfg.riskBands);

  await RiskSnapshot.updateMany({ vehicleId, isLatest: true }, { $set: { isLatest: false } });
  const snap = await RiskSnapshot.create({
    vehicleId, customerId: vehicle.customerId, membershipId: membership?.id, planId: membership?.planId,
    locationId: ros[0]?.locationId || membership?.locationId, score, band, confidence, confidenceBasis,
    modelVersion: RISK_MODEL_VERSION, configVersion: cfg.version, horizons, majorRepairExposureCents: exposure,
    unscheduledVisitLikelihood: unscheduledLikelihood, projectedMarginPct,
    nextLikelyServices: signals.slice(0, 5).map(s => ({ title: s.title, dueAt: s.dueAt, dueMileage: s.dueMileage, signalId: s.id })),
    drivers: drivers.sort((a, b) => b.points - a.points),
    inputRefs: {
      costEvents: costs.length, incompleteCostEvents: costs.filter(c => !c.complete).length, repairOrders: ros.map(r => r.roNumber),
      declinedFindingIds: findingIds, openSignals: signals.map(s => s.id), baselineSource: baselineDaily != null ? `config v${cfg.version} plan baseline` : 'none configured'
    }
  });
  await proposeInterventions(snap.toObject(), declined);
  return toDTO(snap.toObject());
};

// Recommendations only: they are assigned and resolved by people.
const proposeInterventions = async (snap, declined) => {
  if (!['ORANGE', 'RED'].includes(snap.band)) return;
  const month = new Date().toISOString().slice(0, 7);
  const base = { subjectType: 'vehicle', subjectId: snap.vehicleId, vehicleId: snap.vehicleId, customerId: snap.customerId, membershipId: snap.membershipId, planId: snap.planId, locationId: snap.locationId, riskSnapshotId: snap.id, priority: snap.band === 'RED' ? 'high' : 'medium', dueAt: new Date(Date.now() + (snap.band === 'RED' ? 7 : 21) * DAY), createdBy: 'system' };
  const proposals = [];
  for (const d of snap.drivers) {
    if (d.factor === 'declined_repairs') proposals.push({ kind: 'customer_outreach', recommendedAction: `Contact the customer about declined work: ${declined.map(x => x.name).join(', ')}`, reason: d.explanation, estimatedImpactCents: snap.majorRepairExposureCents || null });
    if (d.factor === 'repeat_dtc' || d.factor === 'comebacks') proposals.push({ kind: 'diagnostic_followup', recommendedAction: 'Schedule a root-cause diagnostic review', reason: d.explanation });
    if (d.factor === 'utilization' || d.factor === 'projected_margin') proposals.push({ kind: 'management_review', recommendedAction: 'Review membership economics for this vehicle', reason: d.explanation });
  }
  for (const p of proposals) {
    try {
      const created = await Intervention.create({ ...base, ...p, dedupeKey: `risk:${snap.vehicleId}:${p.kind}:${month}`, history: [{ at: new Date(), by: 'system', to: 'open', note: `Proposed from ${snap.band} risk snapshot` }] });
      await notifyRoles(snap.locationId, ['manager'], { type: 'intervention', severity: snap.band === 'RED' ? 'critical' : 'warning', title: `Intervention suggested (${snap.band})`, body: created.recommendedAction, link: '#/app/intelligence', dedupeKey: `intervention:${created.id}` });
    } catch (err) {
      if (err.code !== 11000) throw err; // already proposed this month
    }
  }
};

registerJobHandler('economics.risk_vehicle', ({ vehicleId }) => assessVehicle(vehicleId));
registerJobHandler('economics.risk_refresh_all', async () => {
  const since = new Date(Date.now() - 730 * DAY);
  const vehicleIds = new Set([
    ...(await RepairOrder.distinct('vehicleId', { createdAt: { $gte: since } })),
    ...(await Membership.find({ status: { $in: ['active', 'past_due'] } }).select('customerId').lean().then(async ms => (await Vehicle.find({ customerId: { $in: ms.map(m => m.customerId) } }).select('id').lean()).map(v => v.id)))
  ]);
  for (const id of vehicleIds) await assessVehicle(id);
  return { assessed: vehicleIds.size };
});

export const refreshAll = (req) => enqueueJob('economics.risk_refresh_all', { by: req.auth.userId }, `risk-all:${new Date().toISOString().slice(0, 13)}`);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const assertRiskRead = (auth) => { if (!can(auth, 'risk:read')) throw forbidden('No access to risk details'); };

export const riskDistribution = async (auth, { locationId }) => {
  assertRiskRead(auth);
  const match = { isLatest: true, ...locationFilter(auth) };
  if (locationId) { assertLocation(auth, locationId); match.locationId = locationId; }
  const [bands, exposure] = await Promise.all([
    RiskSnapshot.aggregate([{ $match: match }, { $group: { _id: '$band', n: { $sum: 1 } } }]),
    RiskSnapshot.aggregate([{ $match: match }, { $unwind: '$horizons' }, { $group: { _id: '$horizons.days', cost: { $sum: '$horizons.expectedDirectCostCents' }, visits: { $sum: { $ifNull: ['$horizons.expectedVisits', 0] } } } }, { $sort: { _id: 1 } }])
  ]);
  const top = await RiskSnapshot.find(match).sort({ score: -1 }).limit(25).lean();
  const vehicles = await Vehicle.find({ id: { $in: top.map(t => t.vehicleId) } }).select('id year make model vin').lean();
  return {
    modelVersion: RISK_MODEL_VERSION,
    distribution: Object.fromEntries(['GREEN', 'YELLOW', 'ORANGE', 'RED'].map(b => [b, bands.find(x => x._id === b)?.n || 0])),
    forecastExposure: exposure.map(e => ({ days: e._id, expectedDirectCostCents: e.cost, expectedVisits: Math.round(e.visits * 100) / 100 })),
    highestRisk: top.map(t => ({ ...toDTO(t), vehicle: vehicles.find(v => v.id === t.vehicleId) }))
  };
};

// Full workspace for risk:read; advisors (risk:alerts) receive band + recommended actions only.
export const vehicleRisk = async (auth, vehicleId) => {
  const snap = await RiskSnapshot.findOne({ vehicleId, isLatest: true }).lean();
  if (snap?.locationId && !isCorporateScope(auth) && !auth.locationIds.includes(snap.locationId)) throw forbidden();
  const interventions = await Intervention.find({ vehicleId, status: { $in: ['open', 'in_progress'] } }).sort({ createdAt: -1 }).lean();
  if (can(auth, 'risk:read')) {
    const history = await RiskSnapshot.find({ vehicleId }).sort({ generatedAt: -1 }).limit(12).select('generatedAt score band confidence modelVersion').lean();
    return { snapshot: snap ? toDTO(snap) : null, history: toDTO(history), interventions: toDTO(interventions) };
  }
  if (!can(auth, 'risk:alerts')) throw forbidden();
  return {
    limited: true,
    snapshot: snap ? { band: snap.band, generatedAt: snap.generatedAt, nextLikelyServices: snap.nextLikelyServices } : null,
    interventions: interventions.map(i => ({ id: i.id, kind: i.kind, recommendedAction: i.recommendedAction, status: i.status, dueAt: i.dueAt }))
  };
};

// ---------------------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------------------
export const listInterventions = async (auth, { status, locationId, ownerId, vehicleId }) => {
  if (!can(auth, 'interventions:read')) throw forbidden();
  const filter = { ...locationFilter(auth) };
  if (locationId) { assertLocation(auth, locationId); filter.locationId = locationId; }
  if (status) filter.status = { $in: status.split(',') };
  if (ownerId) filter.ownerId = ownerId;
  if (vehicleId) filter.vehicleId = vehicleId;
  const items = await Intervention.find(filter).sort({ priority: 1, dueAt: 1 }).limit(300).lean();
  const vehicles = await Vehicle.find({ id: { $in: items.map(i => i.vehicleId).filter(Boolean) } }).select('id year make model vin').lean();
  const owners = await User.find({ id: { $in: items.map(i => i.ownerId).filter(Boolean) } }).select('id name').lean();
  return items.map(i => ({ ...toDTO(i), vehicle: vehicles.find(v => v.id === i.vehicleId), owner: owners.find(o => o.id === i.ownerId) }));
};

export const createIntervention = async (req, input) => {
  if (input.locationId) assertLocation(req.auth, input.locationId);
  if (input.vehicleId && !(await Vehicle.exists({ id: input.vehicleId }))) throw notFound('Vehicle');
  const created = await Intervention.create({ ...input, subjectId: input.subjectId || input.vehicleId || input.membershipId || input.planId || input.locationId, createdBy: req.auth.userId, history: [{ at: new Date(), by: req.auth.userId, to: 'open', note: 'Created manually' }] });
  await audit(req, { eventType: 'INTERVENTION_CREATED', category: 'operational', entityType: 'Intervention', entityId: created.id, locationId: created.locationId, action: `Intervention: ${created.recommendedAction}` });
  return toDTO(created.toObject());
};

const NEXT = { open: ['in_progress', 'resolved', 'dismissed'], in_progress: ['resolved', 'dismissed', 'open'], resolved: [], dismissed: ['open'] };

export const updateIntervention = async (req, id, { status, ownerId, note, resolutionNotes, priority, dueAt }) => {
  const item = await Intervention.findOne({ id }).lean();
  if (!item) throw notFound('Intervention');
  if (item.locationId) assertLocation(req.auth, item.locationId);
  const set = {};
  const history = [];
  if (status && status !== item.status) {
    if (!NEXT[item.status].includes(status)) throw conflict(`Cannot move from ${item.status} to ${status}`);
    if (['resolved', 'dismissed'].includes(status) && !(resolutionNotes || note)) throw badRequest('Record the outcome before closing');
    set.status = status;
    history.push({ at: new Date(), by: req.auth.userId, from: item.status, to: status, note: resolutionNotes || note });
  }
  if (ownerId !== undefined) {
    if (ownerId && !(await User.exists({ id: ownerId, status: 'active' }))) throw badRequest('Owner not found');
    set.ownerId = ownerId || null;
    history.push({ at: new Date(), by: req.auth.userId, note: `Owner set to ${ownerId || 'none'}` });
  }
  if (resolutionNotes) set.resolutionNotes = resolutionNotes;
  if (priority) set.priority = priority;
  if (dueAt) set.dueAt = new Date(dueAt);
  if (note && !status) history.push({ at: new Date(), by: req.auth.userId, note });
  const updated = await Intervention.findOneAndUpdate({ id, status: item.status }, { $set: set, $push: { history: { $each: history } }, $inc: { __v: 1 } }, { new: true }).lean();
  if (!updated) throw conflict('Intervention changed; reload and try again');
  if (set.ownerId) await notifyUsers([set.ownerId], { type: 'intervention_assigned', title: 'Intervention assigned to you', body: updated.recommendedAction, link: '#/app/intelligence' });
  await audit(req, { eventType: 'INTERVENTION_UPDATED', category: 'operational', entityType: 'Intervention', entityId: id, locationId: item.locationId, action: `Intervention ${status ? `${item.status} -> ${status}` : 'updated'}`, reason: resolutionNotes || note });
  return toDTO(updated);
};
