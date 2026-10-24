import {
  RiskSnapshot, Intervention, IntelAlert, EconomicEvent, Vehicle, Membership, MembershipPlan, RepairOrder, Finding, EstimateVersion,
  PredictiveSignal, ConfirmedFix, DiagnosticSession, Measurement, MileageRecord, Payment, User
} from '../models/index.js';
import { audit } from './audit.js';
import { activeConfig } from './economicsService.js';
import { registerJobHandler, enqueueJob } from './jobService.js';
import { notifyRoles, notifyUsers } from './notificationService.js';
import { assertLocation, locationFilter, can, isCorporateScope } from '../security/access.js';
import { notFound, badRequest, conflict, forbidden } from '../lib/errors.js';
import { applyBps } from '../lib/money.js';
import { toDTO } from '../lib/http.js';

// Deterministic, explainable rules-based baseline. No trained model is
// involved; every number is derived from ledger events, repair and diagnostic
// history and the effective configuration (weights are configuration).
export const RISK_MODEL_VERSION = 'risk-baseline-2';
const DAY = 86400000;
const ORDER = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3 };
const round2 = (x) => Math.round(x * 100) / 100;
const bandFor = (score, bands) => [...bands].sort((a, b) => b.minScore - a.minScore).find(b => score >= b.minScore)?.band || 'GREEN';
const marginOf = (rows) => {
  const rev = rows.filter(r => r._id === 'revenue').reduce((s, r) => s + r.s, 0);
  const cost = rows.filter(r => ['direct_cost', 'overhead'].includes(r._id)).reduce((s, r) => s + r.s, 0);
  return { revenue: rev, cost, marginPct: rev > 0 ? round2(((rev - cost) / rev) * 100) : null };
};

export const assessVehicle = async (vehicleId) => {
  const vehicle = await Vehicle.findOne({ id: vehicleId }).lean();
  if (!vehicle) throw notFound('Vehicle');
  const cfg = await activeConfig();
  const W = cfg.riskModel;
  const T = cfg.alertThresholds;
  const now = new Date();
  const windowStart = new Date(now - cfg.forecast.historyWindowDays * DAY);
  const membership = await Membership.findOne({ customerId: vehicle.customerId, status: { $in: ['active', 'past_due', 'suspended'] }, $or: [{ vehicleIds: { $size: 0 } }, { vehicleIds: vehicleId }] }).lean();
  const plan = membership ? await MembershipPlan.findOne({ planId: membership.planId, version: membership.planVersion }).lean() : null;
  const planEcon = membership ? cfg.plans.find(p => p.planId === membership.planId) : null;

  const [costs, ros, declined, signals, comebacks, sessions, fixes, failedMeasurements, mileage, paymentFailures, lifetime, membershipRevenue, preventive, laborEvents, soldLabor] = await Promise.all([
    EconomicEvent.find({ 'attribution.vehicleId': vehicleId, category: 'direct_cost', effectiveAt: { $gte: windowStart } }).select('type amountCents effectiveAt quality attribution.roId').lean(),
    RepairOrder.find({ vehicleId, status: { $ne: 'cancelled' }, createdAt: { $gte: windowStart } }).select('id roNumber appointmentId createdAt locationId').lean(),
    Finding.find({ vehicleId, status: 'active', customerDecision: 'declined', severity: { $in: ['safety', 'repair'] } }).select('id name severity roId').lean(),
    PredictiveSignal.find({ vehicleId, status: 'open' }).lean(),
    ConfirmedFix.countDocuments({ 'vehicle.vehicleId': vehicleId, status: 'comeback' }),
    DiagnosticSession.find({ vehicleId, createdAt: { $gte: windowStart } }).select('id roId dtcs createdAt').lean(),
    ConfirmedFix.find({ 'vehicle.vehicleId': vehicleId, status: 'verified' }).select('id dtcCodes updatedAt createdAt').lean(),
    Measurement.countDocuments({ vehicleId, 'evaluation.result': 'fail', capturedAt: { $gte: new Date(now - 365 * DAY) } }),
    MileageRecord.find({ vehicleId }).sort({ recordedAt: 1 }).select('id odometer recordedAt flagged source').lean(),
    EconomicEvent.countDocuments({ type: 'payment_failed', 'attribution.customerId': vehicle.customerId, effectiveAt: { $gte: new Date(now - 90 * DAY) } }),
    EconomicEvent.aggregate([{ $match: membership ? { 'attribution.membershipId': membership.id } : { 'attribution.vehicleId': vehicleId } }, { $group: { _id: '$category', s: { $sum: '$amountCents' } } }]),
    membership ? EconomicEvent.aggregate([{ $match: { 'attribution.membershipId': membership.id, type: { $in: ['membership_revenue', 'membership_refund'] }, effectiveAt: { $gte: new Date(now - 365 * DAY) } } }, { $group: { _id: null, s: { $sum: '$amountCents' } } }]) : [],
    EconomicEvent.findOne({ 'attribution.vehicleId': vehicleId, type: 'service_revenue', 'attribution.serviceCategory': { $in: cfg.preventiveCategories } }).sort({ effectiveAt: -1 }).select('effectiveAt').lean(),
    EconomicEvent.aggregate([{ $match: { 'attribution.vehicleId': vehicleId, type: 'labor_cost', effectiveAt: { $gte: windowStart } } }, { $group: { _id: '$attribution.roId', minutes: { $sum: '$calculationContext.minutes' } } }]),
    EconomicEvent.aggregate([{ $match: { 'attribution.vehicleId': vehicleId, type: 'service_revenue', 'calculationContext.kind': 'labor', effectiveAt: { $gte: windowStart } } }, { $group: { _id: '$attribution.roId', hours: { $sum: '$calculationContext.hours' } } }])
  ]);

  // --- features ---------------------------------------------------------------------
  const firstSeen = ros.length ? Math.min(...ros.map(r => r.createdAt.getTime())) : null;
  const observedDays = firstSeen ? Math.max(30, (now - firstSeen) / DAY) : 0;
  const visits = ros.length;
  const f = cfg.forecast;
  const confidence = visits >= f.minVisitsForHigh && observedDays >= f.minHistoryDaysForHigh ? 'high'
    : visits >= f.minVisitsForMedium && observedDays >= f.minHistoryDaysForMedium ? 'medium' : 'low';
  const confidenceBasis = `${visits} visit(s) over ${Math.round(observedDays)} day(s) of history (high ≥ ${f.minVisitsForHigh} visits & ${f.minHistoryDaysForHigh} days; medium ≥ ${f.minVisitsForMedium} & ${f.minHistoryDaysForMedium})`;
  const totalCost = costs.reduce((s, c) => s + c.amountCents, 0);
  const partsCost = costs.filter(c => ['parts_cost', 'parts_credit', 'warranty_recovery'].includes(c.type)).reduce((s, c) => s + c.amountCents, 0);
  const laborMinutes = laborEvents.reduce((s, r) => s + (r.minutes || 0), 0);
  const costByRo = new Map();
  for (const c of costs) costByRo.set(c.attribution?.roId, (costByRo.get(c.attribution?.roId) || 0) + c.amountCents);
  const majorRepairs = cfg.majorRepairThresholdCents != null ? [...costByRo.values()].filter(v => v >= cfg.majorRepairThresholdCents).length : null;
  let milesPerYear = null;
  const good = mileage.filter(m => !m.flagged);
  if (good.length >= 2) {
    const a = good[0]; const b = good.at(-1);
    const days = (new Date(b.recordedAt) - new Date(a.recordedAt)) / DAY;
    if (days >= 30) milesPerYear = Math.round(((b.odometer - a.odometer) / days) * 365);
  }
  const vehicleAgeYears = vehicle.year ? now.getUTCFullYear() - vehicle.year : null;
  const daysSincePreventive = preventive ? Math.round((now - preventive.effectiveAt) / DAY) : null;
  const tenureMonths = membership?.startedAt ? Math.floor((now - new Date(membership.startedAt)) / (30.44 * DAY)) : null;

  // DTC recurrence and recurrence after a verified fix
  const occurrences = new Map();
  for (const s of sessions) for (const d of s.dtcs || []) {
    const o = occurrences.get(d.code) || { sessions: new Set(), last: null };
    o.sessions.add(s.id); o.last = !o.last || d.capturedAt > o.last ? d.capturedAt : o.last;
    occurrences.set(d.code, o);
  }
  const repeatDtc = [...occurrences.entries()].filter(([, o]) => o.sessions.size >= 2).map(([code]) => code);
  const recurredAfterFix = [];
  for (const fx of fixes) for (const code of fx.dtcCodes || []) {
    const o = occurrences.get(code);
    if (o?.last && new Date(o.last) > new Date(fx.updatedAt || fx.createdAt)) recurredAfterFix.push({ code, fixId: fx.id });
  }

  // --- predictions --------------------------------------------------------------------
  const runRateDaily = observedDays ? totalCost / observedDays : null;
  const baselineDaily = planEcon?.expectedAnnualDirectCostCents != null ? planEcon.expectedAnnualDirectCostCents / 365 : null;
  const w = Math.min(1, observedDays / 365);
  const daily = runRateDaily != null && baselineDaily != null ? w * runRateDaily + (1 - w) * baselineDaily : runRateDaily ?? baselineDaily;
  const visitRate = observedDays ? visits / observedDays : null;
  const horizons = daily == null ? [] : f.horizonsDays.map(days => ({ days, expectedDirectCostCents: Math.round(daily * days), expectedVisits: visitRate != null ? round2(visitRate * days) : null }));
  const unscheduled = ros.filter(r => !r.appointmentId).length;
  const unscheduledLikelihood = observedDays ? round2(1 - Math.exp(-(unscheduled / observedDays) * 365)) : null;
  const majorRepairProbability = majorRepairs != null && observedDays ? round2(1 - Math.exp(-(majorRepairs / observedDays) * 365)) : null;
  const nextLikelyServices = signals.map(s => ({
    title: s.title, dueAt: s.dueAt, dueMileage: s.dueMileage, signalId: s.id,
    estimatedAt: s.dueAt || (s.dueMileage && milesPerYear > 0 ? new Date(now.getTime() + Math.max(0, (s.dueMileage - vehicle.mileage) / milesPerYear) * 365 * DAY) : undefined)
  })).sort((a, b) => (a.estimatedAt ? new Date(a.estimatedAt) : Infinity) - (b.estimatedAt ? new Date(b.estimatedAt) : Infinity)).slice(0, 5);
  const predictions = {
    majorRepairProbability,
    expectedAnnualLaborHours: observedDays && laborMinutes ? round2((laborMinutes / 60 / observedDays) * 365) : null,
    expectedAnnualPartsCostCents: observedDays ? Math.round((partsCost / observedDays) * 365) : null,
    projectedMileage12m: milesPerYear != null ? vehicle.mileage + milesPerYear : null,
    nextService: nextLikelyServices[0] ? { title: nextLikelyServices[0].title, estimatedAt: nextLikelyServices[0].estimatedAt, basis: nextLikelyServices[0].dueAt ? 'due date from maintenance rule' : 'due mileage ÷ observed mileage rate' } : null
  };

  // major-repair exposure: declined safety/repair work still outstanding
  const findingIds = declined.map(fd => fd.id);
  let exposure = 0;
  if (findingIds.length) {
    const seen = new Set();
    for (const v of await EstimateVersion.find({ 'lines.findingIds': { $in: findingIds } }).sort({ versionNumber: -1 }).lean()) for (const l of v.lines) {
      if (l.findingIds?.some(id => findingIds.includes(id)) && !seen.has(l.id)) { seen.add(l.id); exposure += l.netCents ?? l.totalCents ?? 0; }
    }
  }

  // projected 12-month membership margin; realized lifetime margin
  let projectedMarginPct = null;
  const forecast365 = horizons.find(h => h.days === 365)?.expectedDirectCostCents ?? (daily != null ? Math.round(daily * 365) : null);
  const annualRevenue = membership ? (membershipRevenue[0]?.s || (membership.billingCycle === 'monthly' ? (plan?.priceMonthlyCents || 0) * 12 : plan?.priceAnnualCents || 0)) : null;
  if (annualRevenue && forecast365 != null) {
    const overhead = cfg.overhead.method === 'percent_of_revenue' ? applyBps(annualRevenue, cfg.overhead.rateBps) : 0;
    projectedMarginPct = round2(((annualRevenue - forecast365 - overhead - applyBps(annualRevenue, cfg.reserveBps || 0)) / annualRevenue) * 100);
  }
  const realized = marginOf(lifetime);
  const utilization = runRateDaily != null && baselineDaily ? round2(runRateDaily / baselineDaily) : null;

  // --- explainable score ----------------------------------------------------------------
  const drivers = [];
  const addD = (factor, group, points, value, explanation) => { if (points > 0) drivers.push({ factor, group, points: Math.round(points), value, explanation }); };
  if (utilization != null) addD('utilization', 'usage', Math.min(W.utilizationMax, Math.max(0, (utilization - 1) * W.utilizationPerRatio)), utilization, `Direct cost run-rate is ${utilization}× the plan baseline`);
  addD('declined_repairs', 'repair', Math.min(W.declinedRepairMax, declined.length * W.declinedRepairEach), declined.length, `${declined.length} declined safety/repair finding(s): ${declined.map(d => d.name).join(', ')}`);
  addD('comebacks', 'repair', Math.min(W.comebackMax, comebacks * W.comebackEach), comebacks, `${comebacks} repair comeback(s) recorded`);
  addD('repeat_dtc', 'diagnostic', Math.min(W.repeatDtcMax, repeatDtc.length * W.repeatDtcEach), repeatDtc, `Codes seen in more than one visit: ${repeatDtc.join(', ')}`);
  addD('dtc_recurrence_after_fix', 'diagnostic', Math.min(W.recurrenceAfterFixMax, recurredAfterFix.length * W.recurrenceAfterFixEach), recurredAfterFix.map(r => r.code), `Code(s) returned after a verified fix: ${recurredAfterFix.map(r => r.code).join(', ')}`);
  addD('failed_measurements', 'diagnostic', Math.min(W.failedMeasurementMax, failedMeasurements * W.failedMeasurementEach), failedMeasurements, `${failedMeasurements} measurement(s) out of specification in the last year`);
  if (vehicle.mileage >= W.highMileage) addD('mileage', 'usage', W.highMileagePoints, vehicle.mileage, `Odometer above ${W.highMileage.toLocaleString()}`);
  else if (vehicle.mileage >= W.midMileage) addD('mileage', 'usage', W.midMileagePoints, vehicle.mileage, `Odometer above ${W.midMileage.toLocaleString()}`);
  if (vehicleAgeYears != null && vehicleAgeYears >= W.vehicleAgeYears) addD('vehicle_age', 'usage', W.vehicleAgePoints, vehicleAgeYears, `Vehicle is ${vehicleAgeYears} years old`);
  if (milesPerYear != null && milesPerYear >= W.milesPerYearHigh) addD('mileage_velocity', 'usage', W.milesPerYearPoints, milesPerYear, `Driven about ${milesPerYear.toLocaleString()} miles per year`);
  if (daysSincePreventive != null && daysSincePreventive > W.preventiveOverdueDays) addD('preventive_overdue', 'maintenance', W.preventiveOverduePoints, daysSincePreventive, `${daysSincePreventive} days since the last preventive service`);
  addD('payment_failures', 'payment', Math.min(W.paymentFailureMax, paymentFailures * W.paymentFailureEach), paymentFailures, `${paymentFailures} failed payment(s) in 90 days`);
  const target = (planEcon?.targetMarginBps ?? cfg.defaultTargetMarginBps) / 100;
  const warn = (planEcon?.warningMarginBps ?? cfg.defaultWarningMarginBps) / 100;
  const tolerance = (cfg.lossToleranceBps || 0) / 100;
  if (projectedMarginPct != null) {
    if (projectedMarginPct < 0) addD('projected_margin', 'margin', W.negativeMarginPoints, projectedMarginPct, `Projected membership margin ${projectedMarginPct}% is negative`);
    else if (projectedMarginPct < warn) addD('projected_margin', 'margin', W.lowMarginPoints, projectedMarginPct, `Projected membership margin ${projectedMarginPct}% is below the ${warn}% warning threshold`);
  }
  drivers.sort((a, b) => b.points - a.points);
  const score = Math.min(100, drivers.reduce((s, d) => s + d.points, 0));
  const band = bandFor(score, cfg.riskBands);
  const components = drivers.reduce((m, d) => ({ ...m, [d.group]: (m[d.group] || 0) + d.points }), {});

  // --- profitability state --------------------------------------------------------------
  let state = 'GREEN';
  const reasons = [];
  const bump = (s, why) => { reasons.push(why); if (ORDER[s] > ORDER[state]) state = s; };
  if (realized.marginPct != null) {
    if (realized.marginPct < -tolerance) bump('RED', `Realized margin ${realized.marginPct}% is beyond the ${tolerance}% loss tolerance`);
    else if (realized.marginPct < target) bump('YELLOW', `Realized margin ${realized.marginPct}% is below the ${target}% target`);
  }
  if (projectedMarginPct != null) {
    if (projectedMarginPct < -tolerance) bump('RED', `Projected 12-month margin ${projectedMarginPct}% is beyond the loss tolerance`);
    else if (projectedMarginPct < warn) bump('ORANGE', `Projected 12-month margin ${projectedMarginPct}% is below the ${warn}% warning threshold`);
    else if (projectedMarginPct < target) bump('YELLOW', `Projected 12-month margin ${projectedMarginPct}% is below the ${target}% target`);
  }
  if (ORDER[band] >= ORDER.ORANGE) bump('ORANGE', `Risk score ${score} (${band}) indicates material future cost risk`);
  else if (band === 'YELLOW') bump('YELLOW', `Risk score ${score} (${band})`);
  const recent = costs.filter(c => c.effectiveAt >= new Date(now - 90 * DAY)).reduce((s, c) => s + c.amountCents, 0) / 90;
  const prior = observedDays > 120 ? (totalCost - recent * 90) / (observedDays - 90) : null;
  if (prior > 0 && recent > prior * (1 + (cfg.adverseTrendBps || 0) / 10000)) bump('YELLOW', `Cost run-rate in the last 90 days is ${round2(recent / prior)}× the earlier rate`);
  if (!reasons.length) reasons.push(realized.marginPct == null && projectedMarginPct == null ? 'No membership revenue on record; state reflects risk score only' : 'Margins at or above target and risk acceptable');

  const limitations = [
    !planEcon?.expectedAnnualDirectCostCents && 'No plan cost baseline configured (forecast uses history only; utilization unavailable)',
    costs.some(c => c.quality === 'UNKNOWN') && `${costs.filter(c => c.quality === 'UNKNOWN').length} cost event(s) with unknown values`,
    observedDays < f.minHistoryDaysForMedium && 'Less history than the medium-confidence threshold',
    milesPerYear == null && 'Not enough mileage readings to estimate mileage velocity',
    cfg.majorRepairThresholdCents == null && 'Major-repair threshold not configured',
    !vehicle.year && 'Model year unknown'
  ].filter(Boolean);

  const snap = await RiskSnapshot.create({
    vehicleId, customerId: vehicle.customerId, membershipId: membership?.id, planId: membership?.planId,
    locationId: ros.at(-1)?.locationId || ros[0]?.locationId || membership?.locationId, score, band, profitabilityState: state, stateReasons: reasons, components,
    confidence, confidenceBasis, modelVersion: RISK_MODEL_VERSION, configVersion: cfg.version, horizons, majorRepairExposureCents: exposure,
    unscheduledVisitLikelihood: unscheduledLikelihood, projectedMarginPct, realizedMarginPct: realized.marginPct, predictions, nextLikelyServices, drivers,
    features: { vehicleAgeYears, mileage: vehicle.mileage, milesPerYear, observedDays: Math.round(observedDays), visits, unscheduledVisits: unscheduled, directCostWindowCents: totalCost, partsCostWindowCents: partsCost, laborMinutesWindow: laborMinutes, majorRepairs, declinedFindings: declined.length, openSignals: signals.length, repeatDtc, recurredAfterFix, comebacks, failedMeasurements, daysSincePreventive, tenureMonths, paymentFailures90d: paymentFailures, membershipStatus: membership?.status || null, utilization, lifetimeRevenueCents: realized.revenue, lifetimeCostCents: realized.cost },
    limitations,
    inputRefs: { repairOrders: ros.map(r => r.roNumber), declinedFindingIds: findingIds, openSignals: signals.map(s => s.id), diagnosticSessions: sessions.map(s => s.id), verifiedFixes: fixes.map(x => x.id), baselineSource: baselineDaily != null ? `config v${cfg.version} plan baseline` : 'none configured' }
  });
  await RiskSnapshot.updateMany({ vehicleId, isLatest: true, id: { $ne: snap.id } }, { $set: { isLatest: false } });

  // --- alerts ------------------------------------------------------------------------------
  const month = now.toISOString().slice(0, 7);
  const s = snap.toObject();
  const subject = { vehicleId, membershipId: membership?.id, customerId: vehicle.customerId, planId: membership?.planId, locationId: s.locationId, riskSnapshotId: s.id };
  const alerts = [];
  if (realized.marginPct != null && realized.marginPct < warn) alerts.push({ trigger: 'margin_below_warning', severity: realized.marginPct < -tolerance ? 'critical' : 'warning', title: `Realized margin ${realized.marginPct}% below ${warn}% warning`, recommendation: 'Review member economics and plan fit', key: membership?.id || vehicleId });
  if (projectedMarginPct != null && projectedMarginPct < target) alerts.push({ trigger: 'projected_margin_below_target', severity: projectedMarginPct < 0 ? 'critical' : 'warning', title: `Projected 12-month margin ${projectedMarginPct}% below ${target}% target`, recommendation: 'Manager case review of forecast drivers', key: membership?.id || vehicleId });
  if (majorRepairProbability != null && majorRepairProbability >= T.majorRepairProbability) alerts.push({ trigger: 'major_repair_probability', severity: 'warning', title: `Major-repair likelihood ${Math.round(majorRepairProbability * 100)}% (history-based)`, recommendation: 'Plan parts procurement and discuss upcoming work with the customer', key: vehicleId });
  if (utilization != null && utilization >= T.highUtilizationRatio) alerts.push({ trigger: 'high_utilization', severity: 'warning', title: `Service utilization ${utilization}× plan baseline`, recommendation: 'Review plan pricing or coverage fit', key: vehicleId });
  for (const r of recurredAfterFix) alerts.push({ trigger: 'dtc_recurrence_after_fix', severity: 'critical', title: `${r.code} returned after a verified fix`, recommendation: 'Schedule a diagnostic recheck', key: `${vehicleId}:${r.code}`, sourceRefs: [{ type: 'confirmed_fix', id: r.fixId }] });
  const dueSoon = nextLikelyServices.filter(n => n.estimatedAt && new Date(n.estimatedAt) - now <= T.preventiveDueWithinDays * DAY);
  if (dueSoon.length) alerts.push({ trigger: 'preventive_opportunity', severity: 'info', title: `Preventive service due: ${dueSoon.map(n => n.title).join(', ')}`, recommendation: 'Offer a preventive-service appointment', key: vehicleId, sourceRefs: dueSoon.map(n => ({ type: 'predictive_signal', id: n.signalId })) });
  const flagged = mileage.filter(m => m.flagged);
  const jumps = mileage.slice(1).filter((m, i) => { const d = (new Date(m.recordedAt) - new Date(mileage[i].recordedAt)) / DAY; return d > 0 && (m.odometer - mileage[i].odometer) / d > T.maxMilesPerDay; });
  if (flagged.length || jumps.length) alerts.push({ trigger: 'data_anomaly_mileage', severity: 'info', title: `Mileage timeline anomaly (${flagged.length} lower reading(s), ${jumps.length} implausible jump(s))`, recommendation: 'Verify odometer readings', key: vehicleId, sourceRefs: [...flagged, ...jumps].map(m => ({ type: 'mileage_record', id: m.id })) });
  const sold = new Map(soldLabor.map(r => [r._id, r.hours || 0]));
  const overruns = laborEvents.filter(r => sold.get(r._id) > 0 && r.minutes / 60 > sold.get(r._id) * T.laborOverrunRatio);
  if (overruns.length) alerts.push({ trigger: 'data_anomaly_cost', severity: 'info', title: `Clocked labor over ${T.laborOverrunRatio}× sold hours on ${overruns.length} repair order(s)`, recommendation: 'Review time entries for errors', key: vehicleId, sourceRefs: overruns.map(o => ({ type: 'repair_order', id: o._id })) });
  for (const a of alerts) await raiseAlert({ ...subject, ...a, dedupeKey: `${a.trigger}:${a.key}:${month}` });
  if (declined.length && ORDER[state] >= ORDER.ORANGE) {
    await proposeIntervention({ ...subject, subjectType: 'vehicle', subjectId: vehicleId, kind: 'customer_education', recommendedAction: `Explain declined work to the customer: ${declined.map(x => x.name).join(', ')}`, reason: drivers.find(d => d.factor === 'declined_repairs')?.explanation, estimatedImpactCents: exposure || null, priority: state === 'RED' ? 'high' : 'medium', dedupeKey: `risk:${vehicleId}:customer_education:${month}` });
  }
  return toDTO(s);
};

const ALERT_INTERVENTION = {
  margin_below_warning: ['manager_case_review', 'Review member economics and plan fit'],
  projected_margin_below_target: ['manager_case_review', 'Review forecast drivers with the location manager'],
  major_repair_probability: ['parts_preorder', 'Check parts availability and plan the likely repair'],
  high_utilization: ['pricing_review', 'Review plan pricing and coverage for this utilization'],
  dtc_recurrence_after_fix: ['diagnostic_recheck', 'Schedule a diagnostic recheck of the repeated code'],
  preventive_opportunity: ['preventive_service', 'Schedule the preventive service'],
  payment_past_due: ['billing_remediation', 'Contact the member about the past-due balance'],
  payment_failures: ['billing_remediation', 'Update the payment method with the member'],
  data_anomaly_mileage: ['location_process_review', 'Correct the mileage record and review check-in practice'],
  data_anomaly_cost: ['location_process_review', 'Review time-entry practice'],
  data_anomaly_duplicate: ['billing_remediation', 'Verify the possible duplicate payment']
};

const proposeIntervention = async (data) => {
  try {
    const created = await Intervention.create({ createdBy: 'system', ...data, dueAt: data.dueAt || new Date(Date.now() + (data.priority === 'high' ? 7 : 21) * DAY), history: [{ at: new Date(), by: 'system', to: 'open', note: 'Proposed automatically; requires human action' }] });
    return created;
  } catch (err) {
    if (err.code !== 11000) throw err;
    return null;
  }
};

export const raiseAlert = async ({ key, ...a }) => {
  try {
    const alert = await IntelAlert.create({ ...a, history: [{ at: new Date(), by: 'system', to: 'open', note: `Raised by ${RISK_MODEL_VERSION}` }] });
    if (alert.severity !== 'info' && (alert.vehicleId || alert.membershipId)) {
      const [kind, action] = ALERT_INTERVENTION[alert.trigger];
      const iv = await proposeIntervention({ subjectType: alert.vehicleId ? 'vehicle' : 'membership', subjectId: alert.vehicleId || alert.membershipId, vehicleId: alert.vehicleId, membershipId: alert.membershipId, customerId: alert.customerId, planId: alert.planId, locationId: alert.locationId, riskSnapshotId: alert.riskSnapshotId, alertId: alert.id, kind, recommendedAction: action, reason: alert.title, priority: alert.severity === 'critical' ? 'high' : 'medium', dedupeKey: `alert:${alert.id}` });
      if (iv) await IntelAlert.updateOne({ id: alert.id }, { $set: { interventionId: iv.id } });
    }
    if (alert.severity !== 'info' && alert.locationId) {
      await notifyRoles(alert.locationId, ['manager'], { type: 'intel_alert', severity: alert.severity === 'critical' ? 'critical' : 'warning', title: alert.title, body: alert.recommendation, link: '#/app/intelligence', dedupeKey: `alert:${alert.id}` });
    }
    return alert;
  } catch (err) {
    if (err.code !== 11000) throw err; // already raised this period
    return null;
  }
};

// Member-level payment checks and duplicate-payment detection.
const paymentAlerts = async () => {
  const cfg = await activeConfig();
  const month = new Date().toISOString().slice(0, 7);
  for (const m of await Membership.find({ status: 'past_due' }).lean()) {
    await raiseAlert({ trigger: 'payment_past_due', severity: 'warning', membershipId: m.id, customerId: m.customerId, planId: m.planId, locationId: m.locationId, title: `Membership ${m.number} is past due`, recommendation: 'Contact the member about the balance', sourceRefs: [{ type: 'membership', id: m.id }], dedupeKey: `payment_past_due:${m.id}:${month}` });
  }
  const failures = await EconomicEvent.aggregate([{ $match: { type: 'payment_failed', effectiveAt: { $gte: new Date(Date.now() - 90 * DAY) } } }, { $group: { _id: '$attribution.customerId', n: { $sum: 1 }, attr: { $first: '$attribution' }, ids: { $push: '$source.id' } } }, { $match: { n: { $gte: cfg.alertThresholds.paymentFailuresIn90Days } } }]);
  for (const f of failures) await raiseAlert({ trigger: 'payment_failures', severity: 'warning', customerId: f._id, membershipId: f.attr.membershipId, planId: f.attr.planId, locationId: f.attr.locationId, title: `${f.n} failed payments in 90 days`, recommendation: 'Update the payment method', sourceRefs: f.ids.map(id => ({ type: 'payment', id })), dedupeKey: `payment_failures:${f._id}:${month}` });
  const dupes = await Payment.aggregate([
    { $match: { status: 'succeeded', receivedAt: { $gte: new Date(Date.now() - 30 * DAY) } } },
    { $group: { _id: { invoiceId: '$invoiceId', amount: '$amountCents', minute: { $dateTrunc: { date: '$receivedAt', unit: 'minute', binSize: 10 } } }, n: { $sum: 1 }, ids: { $push: '$id' }, loc: { $first: '$locationId' }, customerId: { $first: '$customerId' } } },
    { $match: { n: { $gt: 1 } } }
  ]);
  for (const d of dupes) await raiseAlert({ trigger: 'data_anomaly_duplicate', severity: 'warning', customerId: d.customerId, locationId: d.loc, title: `Possible duplicate payments (${d.n} × ${d._id.amount} cents)`, recommendation: 'Verify and refund if duplicated', sourceRefs: d.ids.map(id => ({ type: 'payment', id })), dedupeKey: `dup:${d.ids.sort().join(',')}` });
};

registerJobHandler('economics.risk_vehicle', ({ vehicleId }) => assessVehicle(vehicleId));
// Chunked so serverless time limits are respected; each chunk re-enqueues the next.
registerJobHandler('economics.risk_refresh_all', async ({ after = '', runKey = Date.now().toString(36) } = {}) => {
  const since = new Date(Date.now() - 730 * DAY);
  const ids = new Set(await RepairOrder.distinct('vehicleId', { createdAt: { $gte: since } }));
  const members = await Membership.find({ status: { $in: ['active', 'past_due', 'suspended'] } }).select('customerId vehicleIds').lean();
  (await Vehicle.find({ customerId: { $in: members.map(m => m.customerId) } }).select('id').lean()).forEach(v => ids.add(v.id));
  const batch = [...ids].filter(Boolean).sort().filter(id => id > after).slice(0, 60);
  for (const id of batch) await assessVehicle(id).catch(err => console.error('[risk] assess failed', id, err.message));
  if (batch.length === 60) await enqueueJob('economics.risk_refresh_all', { after: batch.at(-1), runKey }, `risk-all:${runKey}:${batch.at(-1)}`);
  else await paymentAlerts();
  return { assessed: batch.length, done: batch.length < 60 };
});

export const refreshAll = (req) => enqueueJob('economics.risk_refresh_all', { by: req.auth.userId }, `risk-all:${new Date().toISOString().slice(0, 13)}`);

// Authorized human override of the displayed band/state; never changes coverage.
export const overrideRisk = async (req, vehicleId, { band, profitabilityState, reason }) => {
  const snap = await RiskSnapshot.findOne({ vehicleId, isLatest: true }).lean();
  if (!snap) throw notFound('Risk assessment');
  if (snap.locationId) assertLocation(req.auth, snap.locationId);
  const override = band || profitabilityState ? { band, profitabilityState, reason, by: req.auth.userId, at: new Date() } : null;
  await RiskSnapshot.updateOne({ id: snap.id }, { $set: { override } });
  await audit(req, { eventType: 'RISK_OVERRIDE', category: 'operational', entityType: 'RiskSnapshot', entityId: snap.id, locationId: snap.locationId, action: override ? `Override: band ${snap.band}→${band || snap.band}, state ${snap.profitabilityState}→${profitabilityState || snap.profitabilityState}` : 'Override cleared', before: { band: snap.band, profitabilityState: snap.profitabilityState, override: snap.override }, after: { override }, reason });
  return toDTO({ ...snap, override });
};

// Full detail for risk:read; advisors (risk:alerts) receive band + recommended actions only.
export const vehicleRisk = async (auth, vehicleId) => {
  const snap = await RiskSnapshot.findOne({ vehicleId, isLatest: true }).lean();
  if (snap?.locationId && !isCorporateScope(auth) && !auth.locationIds.includes(snap.locationId)) throw forbidden();
  const interventions = await Intervention.find({ vehicleId, status: { $in: ['open', 'in_progress'] } }).sort({ createdAt: -1 }).lean();
  if (can(auth, 'risk:read')) {
    const [history, alerts] = await Promise.all([
      RiskSnapshot.find({ vehicleId }).sort({ generatedAt: -1 }).limit(24).select('generatedAt score band profitabilityState confidence modelVersion configVersion').lean(),
      IntelAlert.find({ vehicleId }).sort({ createdAt: -1 }).limit(50).lean()
    ]);
    return { snapshot: snap ? toDTO(snap) : null, history: toDTO(history), interventions: toDTO(interventions), alerts: toDTO(alerts) };
  }
  if (!can(auth, 'risk:alerts')) return null;
  return {
    limited: true,
    snapshot: snap ? { band: snap.override?.band || snap.band, generatedAt: snap.generatedAt, nextLikelyServices: snap.nextLikelyServices } : null,
    interventions: interventions.map(i => ({ id: i.id, kind: i.kind, recommendedAction: i.recommendedAction, status: i.status, dueAt: i.dueAt }))
  };
};

// ---------------------------------------------------------------------------
// Alerts and interventions (human-owned workflows)
// ---------------------------------------------------------------------------
const pageOf = (q) => ({ p: Math.max(1, Number(q.page) || 1), l: Math.min(Number(q.limit) || 50, 200) });
const scoped = (auth, q) => {
  const filter = { ...locationFilter(auth) };
  if (q.locationId) { assertLocation(auth, q.locationId); filter.locationId = q.locationId; }
  for (const k of ['vehicleId', 'membershipId', 'ownerId', 'planId']) if (q[k]) filter[k] = String(q[k]);
  if (q.status) filter.status = { $in: String(q.status).split(',') };
  return filter;
};
const withNames = async (items) => {
  const vehicles = await Vehicle.find({ id: { $in: items.map(i => i.vehicleId).filter(Boolean) } }).select('id year make model vin').lean();
  const owners = await User.find({ id: { $in: items.map(i => i.ownerId).filter(Boolean) } }).select('id name').lean();
  return items.map(i => ({ ...toDTO(i), vehicle: vehicles.find(v => v.id === i.vehicleId), owner: owners.find(o => o.id === i.ownerId) }));
};

export const listAlerts = async (auth, q) => {
  const filter = scoped(auth, q);
  if (q.trigger) filter.trigger = q.trigger;
  if (q.severity) filter.severity = q.severity;
  const { p, l } = pageOf(q);
  const [items, total] = await Promise.all([IntelAlert.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(), IntelAlert.countDocuments(filter)]);
  return { alerts: await withNames(items), total, page: p, limit: l };
};

const ALERT_NEXT = { open: ['acknowledged', 'resolved', 'dismissed'], acknowledged: ['resolved', 'dismissed', 'open'], resolved: ['open'], dismissed: ['open'] };
export const updateAlert = async (req, id, { status, ownerId, note, falsePositive }) => {
  const a = await IntelAlert.findOne({ id }).lean();
  if (!a) throw notFound('Alert');
  if (a.locationId) assertLocation(req.auth, a.locationId);
  const set = {};
  const history = [];
  if (status && status !== a.status) {
    if (!ALERT_NEXT[a.status].includes(status)) throw conflict(`Cannot move from ${a.status} to ${status}`);
    if (['resolved', 'dismissed'].includes(status) && !note) throw badRequest('Record a note before closing');
    set.status = status;
    if (status === 'dismissed') set.falsePositive = Boolean(falsePositive);
    history.push({ at: new Date(), by: req.auth.userId, from: a.status, to: status, note });
  } else if (note) history.push({ at: new Date(), by: req.auth.userId, note });
  if (ownerId !== undefined) set.ownerId = ownerId || null;
  const updated = await IntelAlert.findOneAndUpdate({ id, status: a.status }, { $set: set, $push: { history: { $each: history } } }, { new: true }).lean();
  if (!updated) throw conflict('Alert changed; reload and try again');
  await audit(req, { eventType: 'INTEL_ALERT_UPDATED', category: 'operational', entityType: 'IntelAlert', entityId: id, locationId: a.locationId, action: `Alert ${a.trigger} ${status ? `${a.status} -> ${status}` : 'updated'}${falsePositive ? ' (false positive)' : ''}`, reason: note });
  return toDTO(updated);
};

export const listInterventions = async (auth, q) => {
  if (!can(auth, 'interventions:read')) throw forbidden();
  const filter = scoped(auth, q);
  if (q.kind) filter.kind = q.kind;
  const { p, l } = pageOf(q);
  const [items, total] = await Promise.all([Intervention.find(filter).sort({ status: 1, dueAt: 1 }).skip((p - 1) * l).limit(l).lean(), Intervention.countDocuments(filter)]);
  return { interventions: await withNames(items), total, page: p, limit: l };
};

export const createIntervention = async (req, input) => {
  let base = {};
  if (input.alertId) {
    const a = await IntelAlert.findOne({ id: input.alertId }).lean();
    if (!a) throw notFound('Alert');
    base = { vehicleId: a.vehicleId, membershipId: a.membershipId, customerId: a.customerId, planId: a.planId, locationId: a.locationId, riskSnapshotId: a.riskSnapshotId, subjectType: a.vehicleId ? 'vehicle' : 'membership', reason: a.title };
  }
  const data = { ...base, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  if (data.locationId) assertLocation(req.auth, data.locationId);
  else if (!isCorporateScope(req.auth)) throw badRequest('A location is required');
  if (data.vehicleId && !(await Vehicle.exists({ id: data.vehicleId }))) throw notFound('Vehicle');
  if (!data.reason) throw badRequest('A reason is required');
  const created = await Intervention.create({ ...data, subjectType: data.subjectType || 'vehicle', subjectId: data.subjectId || data.vehicleId || data.membershipId || data.planId || data.locationId, createdBy: req.auth.userId, history: [{ at: new Date(), by: req.auth.userId, to: 'open', note: 'Created manually' }] });
  if (input.alertId) await IntelAlert.updateOne({ id: input.alertId }, { $set: { interventionId: created.id } });
  await audit(req, { eventType: 'INTERVENTION_CREATED', category: 'operational', entityType: 'Intervention', entityId: created.id, locationId: created.locationId, action: `Intervention: ${created.recommendedAction}` });
  return toDTO(created.toObject());
};

const NEXT = { open: ['in_progress', 'resolved', 'dismissed'], in_progress: ['resolved', 'dismissed', 'open'], resolved: [], dismissed: ['open'] };

export const updateIntervention = async (req, id, { status, ownerId, note, resolutionNotes, priority, dueAt, outcome }) => {
  const item = await Intervention.findOne({ id }).lean();
  if (!item) throw notFound('Intervention');
  if (item.locationId) assertLocation(req.auth, item.locationId);
  const set = {};
  const history = [];
  if (status && status !== item.status) {
    if (!NEXT[item.status].includes(status)) throw conflict(`Cannot move from ${item.status} to ${status}`);
    if (['resolved', 'dismissed'].includes(status) && !(resolutionNotes || note)) throw badRequest('Record the outcome before closing');
    if (status === 'resolved' && !outcome?.result) throw badRequest('Choose an outcome result before resolving');
    set.status = status;
    if (['resolved', 'dismissed'].includes(status)) set.resolvedAt = new Date();
    history.push({ at: new Date(), by: req.auth.userId, from: item.status, to: status, note: resolutionNotes || note });
  }
  if (ownerId !== undefined) {
    if (ownerId && !(await User.exists({ id: ownerId, status: 'active' }))) throw badRequest('Owner not found');
    set.ownerId = ownerId || null;
    history.push({ at: new Date(), by: req.auth.userId, note: `Owner set to ${ownerId || 'none'}` });
  }
  if (outcome) set.outcome = { ...outcome, at: new Date() };
  if (resolutionNotes) set.resolutionNotes = resolutionNotes;
  if (priority) set.priority = priority;
  if (dueAt) set.dueAt = new Date(dueAt);
  if (note && !status) history.push({ at: new Date(), by: req.auth.userId, note });
  const updated = await Intervention.findOneAndUpdate({ id, status: item.status }, { $set: set, $push: { history: { $each: history } }, $inc: { __v: 1 } }, { new: true }).lean();
  if (!updated) throw conflict('Intervention changed; reload and try again');
  if (set.ownerId) await notifyUsers([set.ownerId], { type: 'intervention_assigned', title: 'Intervention assigned to you', body: updated.recommendedAction, link: '#/app/intelligence' });
  if (set.status === 'resolved' && item.alertId) await IntelAlert.updateOne({ id: item.alertId, status: { $in: ['open', 'acknowledged'] } }, { $set: { status: 'resolved' }, $push: { history: { at: new Date(), by: req.auth.userId, from: 'open', to: 'resolved', note: 'Intervention resolved' } } });
  await audit(req, { eventType: 'INTERVENTION_UPDATED', category: 'operational', entityType: 'Intervention', entityId: id, locationId: item.locationId, action: `Intervention ${status ? `${item.status} -> ${status}` : 'updated'}${outcome?.result ? ` (${outcome.result})` : ''}`, reason: resolutionNotes || note });
  return toDTO(updated);
};
