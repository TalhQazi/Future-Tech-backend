import {
  EconomicEvent, RiskSnapshot, IntelAlert, Intervention, Membership, MembershipPlan, Location, Vehicle, Customer, DiagnosticSession,
  Measurement, Job, AuditEvent
} from '../models/index.js';
import { rollup, reconcile } from './economicsService.js';
import { assertLocation, locationFilter, can } from '../security/access.js';
import { forbidden } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';

// Executive and corporate analytics, computed from the ledger and operational
// collections with aggregation pipelines (no cached figure is authoritative).
const DAY = 86400000;
const range = (q) => {
  const end = q.to ? new Date(q.to) : new Date(Date.now() + DAY);
  return { start: q.from ? new Date(q.from) : new Date(end - 366 * DAY), end };
};
const loc = (auth, locationId, field = 'locationId') => {
  if (locationId) { assertLocation(auth, locationId); return { [field]: locationId }; }
  return locationFilter(auth, field);
};
const needRisk = (auth) => { if (!can(auth, 'risk:read')) throw forbidden('No access to risk details'); };
const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);

export const portfolioSummary = async (auth, q) => {
  const { start, end } = range(q);
  const scope = { ...loc(auth, q.locationId), ...(q.planId ? { planId: q.planId } : {}) };
  const activeAt = (t) => ({ startedAt: { $lt: t }, status: { $ne: 'pending_payment' }, $nor: [{ cancelledAt: { $lt: t } }, { status: 'expired', currentPeriodEnd: { $lt: t } }] });
  const [economics, activeMembers, atStart, stillActive, exposure, ivs, openAlerts] = await Promise.all([
    rollup(auth, { ...q, groupBy: 'portfolio' }),
    Membership.countDocuments({ ...scope, status: 'active' }),
    Membership.countDocuments({ ...scope, ...activeAt(start) }),
    Membership.countDocuments({ ...scope, $and: [activeAt(start), activeAt(end)] }),
    can(auth, 'risk:read') ? RiskSnapshot.aggregate([{ $match: { isLatest: true, ...scope } }, { $unwind: '$horizons' }, { $group: { _id: '$horizons.days', cost: { $sum: '$horizons.expectedDirectCostCents' }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]) : [],
    Intervention.aggregate([{ $match: { ...loc(auth, q.locationId), createdAt: { $gte: start, $lt: end } } }, { $group: { _id: '$status', n: { $sum: 1 }, avoided: { $sum: { $ifNull: ['$outcome.avoidedCostEstimateCents', 0] } } } }]),
    IntelAlert.countDocuments({ ...loc(auth, q.locationId), status: { $in: ['open', 'acknowledged'] } })
  ]);
  const ivTotal = ivs.reduce((s, x) => s + x.n, 0);
  const ivResolved = ivs.find(x => x._id === 'resolved')?.n || 0;
  return {
    ...economics, totals: economics.rows[0] || null,
    activeMembers, retention: { activeAtStart: atStart, stillActiveAtEnd: stillActive, ratePct: ratio(stillActive, atStart) },
    forecastExposure: exposure.map(e => ({ days: e._id, expectedDirectCostCents: e.cost, vehicles: e.n })),
    interventions: { total: ivTotal, resolved: ivResolved, completionPct: ratio(ivResolved, ivTotal), avoidedCostEstimateCents: ivs.reduce((s, x) => s + x.avoided, 0) },
    openAlerts
  };
};

export const riskQueue = async (auth, q) => {
  needRisk(auth);
  const match = { isLatest: true, ...loc(auth, q.locationId) };
  if (q.band) match.band = { $in: String(q.band).split(',') };
  if (q.profitabilityState) match.profitabilityState = { $in: String(q.profitabilityState).split(',') };
  if (q.planId) match.planId = q.planId;
  const p = Math.max(1, Number(q.page) || 1);
  const l = Math.min(Number(q.limit) || 25, 100);
  const [items, total] = await Promise.all([RiskSnapshot.find(match).sort({ score: -1, generatedAt: -1 }).skip((p - 1) * l).limit(l).lean(), RiskSnapshot.countDocuments(match)]);
  const [vehicles, customers, alerts] = await Promise.all([
    Vehicle.find({ id: { $in: items.map(i => i.vehicleId) } }).select('id year make model vin').lean(),
    Customer.find({ id: { $in: items.map(i => i.customerId).filter(Boolean) } }).select('id name').lean(),
    IntelAlert.aggregate([{ $match: { vehicleId: { $in: items.map(i => i.vehicleId) }, status: { $in: ['open', 'acknowledged'] } } }, { $group: { _id: '$vehicleId', n: { $sum: 1 } } }])
  ]);
  return {
    total, page: p, limit: l,
    items: items.map(i => ({ ...toDTO(i), vehicle: vehicles.find(v => v.id === i.vehicleId), customer: customers.find(c => c.id === i.customerId), openAlerts: alerts.find(a => a._id === i.vehicleId)?.n || 0 }))
  };
};

export const riskBreakdown = async (auth, q) => {
  needRisk(auth);
  const match = { isLatest: true, ...loc(auth, q.locationId) };
  const by = (field) => RiskSnapshot.aggregate([{ $match: match }, { $group: { _id: { key: `$${field}`, band: '$band' }, n: { $sum: 1 } } }]);
  const [byLocation, byPlan, byState] = await Promise.all([by('locationId'), by('planId'), RiskSnapshot.aggregate([{ $match: match }, { $group: { _id: '$profitabilityState', n: { $sum: 1 } } }])]);
  const shape = (rows, labels) => Object.values(rows.reduce((m, r) => {
    const k = r._id.key || 'none';
    m[k] = m[k] || { key: k, label: labels.get(k) || (k === 'none' ? 'Not a member' : k), GREEN: 0, YELLOW: 0, ORANGE: 0, RED: 0 };
    m[k][r._id.band] += r.n;
    return m;
  }, {}));
  const locs = new Map((await Location.find().select('id name').lean()).map(l => [l.id, l.name]));
  const plans = new Map((await MembershipPlan.find().sort({ version: 1 }).select('planId name').lean()).map(p => [p.planId, p.name]));
  return { byLocation: shape(byLocation, locs), byPlan: shape(byPlan, plans), profitabilityStates: Object.fromEntries(['GREEN', 'YELLOW', 'ORANGE', 'RED'].map(s => [s, byState.find(x => x._id === s)?.n || 0])) };
};

export const diagnosticTrends = async (auth, q) => {
  const { start, end } = range(q);
  const match = { createdAt: { $gte: start, $lt: end }, ...loc(auth, q.locationId) };
  const [codes, statuses, monthly, sessionIds, recurrenceAlerts] = await Promise.all([
    DiagnosticSession.aggregate([{ $match: match }, { $unwind: '$dtcs' }, { $group: { _id: '$dtcs.code', n: { $sum: 1 }, vehicles: { $addToSet: '$vehicleId' } } }, { $sort: { n: -1 } }, { $limit: 25 }]),
    DiagnosticSession.aggregate([{ $match: match }, { $unwind: '$dtcs' }, { $group: { _id: '$dtcs.status', n: { $sum: 1 } } }]),
    DiagnosticSession.aggregate([{ $match: match }, { $unwind: '$dtcs' }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    DiagnosticSession.distinct('id', match),
    IntelAlert.countDocuments({ trigger: 'dtc_recurrence_after_fix', createdAt: { $gte: start, $lt: end }, ...loc(auth, q.locationId) })
  ]);
  const measurements = await Measurement.aggregate([
    { $match: { sessionId: { $in: sessionIds }, capturedAt: { $gte: start, $lt: end } } },
    { $group: { _id: '$parameter', n: { $sum: 1 }, fail: { $sum: { $cond: [{ $eq: ['$evaluation.result', 'fail'] }, 1, 0] } }, pass: { $sum: { $cond: [{ $eq: ['$evaluation.result', 'pass'] }, 1, 0] } } } },
    { $sort: { n: -1 } }, { $limit: 20 }
  ]);
  return {
    topCodes: codes.map(c => ({ code: c._id, occurrences: c.n, vehicles: c.vehicles.length, repeatOnSameVehicle: c.n > c.vehicles.length })),
    statusDistribution: statuses.map(s => ({ status: s._id, n: s.n })),
    monthly: monthly.map(m => ({ month: m._id, codes: m.n })),
    measurements: measurements.map(m => ({ parameter: m._id, readings: m.n, fail: m.fail, pass: m.pass, failRatePct: ratio(m.fail, m.pass + m.fail) })),
    recurrenceAfterFixAlerts: recurrenceAlerts
  };
};

export const interventionResults = async (auth, q) => {
  const { start, end } = range(q);
  const match = { createdAt: { $gte: start, $lt: end }, ...loc(auth, q.locationId) };
  const [byKind, alerts] = await Promise.all([
    Intervention.aggregate([{ $match: match }, { $group: {
      _id: '$kind', total: { $sum: 1 },
      resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } }, dismissed: { $sum: { $cond: [{ $eq: ['$status', 'dismissed'] }, 1, 0] } },
      open: { $sum: { $cond: [{ $in: ['$status', ['open', 'in_progress']] }, 1, 0] } },
      completed: { $sum: { $cond: [{ $eq: ['$outcome.result', 'completed'] }, 1, 0] } }, declined: { $sum: { $cond: [{ $eq: ['$outcome.result', 'customer_declined'] }, 1, 0] } },
      avoided: { $sum: { $ifNull: ['$outcome.avoidedCostEstimateCents', 0] } },
      days: { $avg: { $cond: [{ $ifNull: ['$resolvedAt', false] }, { $divide: [{ $subtract: ['$resolvedAt', '$createdAt'] }, DAY] }, null] } }
    } }, { $sort: { total: -1 } }]),
    IntelAlert.aggregate([{ $match: match }, { $group: { _id: '$trigger', total: { $sum: 1 }, resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } }, dismissed: { $sum: { $cond: [{ $eq: ['$status', 'dismissed'] }, 1, 0] } }, falsePositive: { $sum: { $cond: ['$falsePositive', 1, 0] } } } }, { $sort: { total: -1 } }])
  ]);
  return {
    interventions: byKind.map(k => ({ kind: k._id, total: k.total, open: k.open, resolved: k.resolved, dismissed: k.dismissed, completed: k.completed, customerDeclined: k.declined, completionPct: ratio(k.resolved, k.total), avgDaysToClose: k.days != null ? Math.round(k.days * 10) / 10 : null, avoidedCostEstimateCents: k.avoided })),
    alerts: alerts.map(a => ({ trigger: a._id, total: a.total, resolved: a.resolved, dismissed: a.dismissed, falsePositive: a.falsePositive, falsePositivePct: ratio(a.falsePositive, a.resolved + a.dismissed) })),
    note: 'Avoided-cost figures are estimates entered at resolution, not realized savings.'
  };
};

export const cohortAnalysis = async (auth, q) => {
  const [economics, members] = await Promise.all([
    rollup(auth, { ...q, groupBy: 'cohort', from: q.from || '2000-01-01' }),
    Membership.aggregate([{ $match: { ...loc(auth, q.locationId), startedAt: { $ne: null } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$startedAt' } }, started: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }, cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } }, expired: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } } } }, { $sort: { _id: 1 } }])
  ]);
  return {
    definitions: economics.definitions,
    cohorts: members.map(m => ({ cohort: m._id, started: m.started, active: m.active, cancelled: m.cancelled, expired: m.expired, retentionPct: ratio(m.active, m.started), economics: economics.rows.find(r => r.key === m._id) || null }))
  };
};

// Forecast monitoring: compares matured forecasts with what the ledger later recorded.
export const forecastAccuracy = async (auth, { horizon = 90, locationId } = {}) => {
  needRisk(auth);
  const h = Number(horizon);
  const cutoff = new Date(Date.now() - h * DAY);
  const snaps = await RiskSnapshot.find({ generatedAt: { $lte: cutoff, $gte: new Date(cutoff - 365 * DAY) }, ...loc(auth, locationId) }).sort({ generatedAt: -1 }).limit(200).lean();
  const samples = [];
  for (const s of snaps) {
    const expected = s.horizons?.find(x => x.days === h)?.expectedDirectCostCents;
    if (expected == null) continue;
    const actual = (await EconomicEvent.aggregate([{ $match: { 'attribution.vehicleId': s.vehicleId, category: 'direct_cost', effectiveAt: { $gte: s.generatedAt, $lt: new Date(s.generatedAt.getTime() + h * DAY) } } }, { $group: { _id: null, s: { $sum: '$amountCents' } } }]))[0]?.s || 0;
    samples.push({ modelVersion: s.modelVersion, confidence: s.confidence, expected, actual });
  }
  const summarize = (key) => Object.values(samples.reduce((m, x) => {
    const g = (m[x[key]] ||= { [key]: x[key], n: 0, absError: 0, bias: 0 });
    g.n += 1; g.absError += Math.abs(x.actual - x.expected); g.bias += x.actual - x.expected;
    return m;
  }, {})).map(g => ({ [key]: g[key], samples: g.n, meanAbsErrorCents: Math.round(g.absError / g.n), meanBiasCents: Math.round(g.bias / g.n) }));
  return {
    horizonDays: h, samples: samples.length,
    note: samples.length ? 'Error = actual direct cost recorded in the ledger − forecast; positive bias means costs were under-forecast.' : 'No forecasts are old enough to evaluate yet.',
    byModel: summarize('modelVersion'), byConfidence: summarize('confidence')
  };
};

export const monitoring = async (auth) => {
  const since = new Date(Date.now() - 30 * DAY);
  const type = { $regex: /^economics\./ };
  const [jobs, oldestPending, recent, dupes, stale, unknown, alerts, recalcs, reconciliation, accuracy] = await Promise.all([
    Job.aggregate([{ $match: { type, createdAt: { $gte: since } } }, { $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } }]),
    Job.findOne({ type, status: 'pending', runAt: { $lte: new Date() } }).sort({ runAt: 1 }).select('type runAt').lean(),
    Job.find({ type, status: 'completed', completedAt: { $ne: null } }).sort({ completedAt: -1 }).limit(200).select('type createdAt completedAt').lean(),
    Job.aggregate([{ $match: { type, status: 'completed', completedAt: { $gte: since } } }, { $group: { _id: null, duplicates: { $sum: { $ifNull: ['$result.duplicates', 0] } }, inserted: { $sum: { $ifNull: ['$result.inserted', 0] } } } }]),
    can(auth, 'risk:read') ? RiskSnapshot.countDocuments({ isLatest: true, generatedAt: { $lt: new Date(Date.now() - 2 * DAY) }, ...locationFilter(auth) }) : null,
    EconomicEvent.countDocuments({ quality: 'UNKNOWN', effectiveAt: { $gte: new Date(Date.now() - 365 * DAY) }, ...locationFilter(auth, 'attribution.locationId') }),
    IntelAlert.aggregate([{ $match: { ...locationFilter(auth), status: { $in: ['resolved', 'dismissed'] } } }, { $group: { _id: null, closed: { $sum: 1 }, fp: { $sum: { $cond: ['$falsePositive', 1, 0] } } } }]),
    AuditEvent.find({ eventType: 'ECONOMICS_RECALCULATED' }).sort({ createdAt: -1 }).limit(10).select('createdAt action entityId').lean(),
    reconcile(auth, { from: new Date(Date.now() - 90 * DAY).toISOString() }),
    can(auth, 'risk:read') ? forecastAccuracy(auth, { horizon: 90 }) : null
  ]);
  const lat = recent.map(j => j.completedAt - j.createdAt).sort((a, b) => a - b);
  const failed = await Job.find({ type, status: { $in: ['dead', 'pending'] }, lastError: { $ne: null } }).sort({ updatedAt: -1 }).limit(10).select('type status attempts lastError updatedAt').lean();
  return {
    jobs: jobs.map(j => ({ type: j._id.type, status: j._id.status, count: j.n })),
    processingDelaySeconds: oldestPending ? Math.round((Date.now() - oldestPending.runAt) / 1000) : 0,
    latencyMs: lat.length ? { median: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)] } : null,
    eventsLast30Days: { inserted: dupes[0]?.inserted || 0, duplicatesRejected: dupes[0]?.duplicates || 0 },
    failedJobs: toDTO(failed), staleSnapshots: stale, unknownQualityEvents: unknown,
    falseAlertRatePct: alerts[0] ? ratio(alerts[0].fp, alerts[0].closed) : null,
    recentRecalculations: toDTO(recalcs), reconciliation, forecastAccuracy: accuracy
  };
};
