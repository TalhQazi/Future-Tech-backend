import { withTransaction } from '../config/db.js';
import {
  ConfirmedFix, InstalledPart, PartFailure, ForumThread, ForumReply, ForumVote, FuelEvent, PredictiveRule,
  PredictiveSignal, Vehicle, RepairOrder, Finding, DiagnosticSession, CorporateSettings, Supplier, Part
} from '../models/index.js';
import { audit } from './audit.js';
import { registerJobHandler, enqueueJob } from './jobService.js';
import { notifyRoles } from './notificationService.js';
import { assertVehicleAccess } from './vehicleService.js';
import { findRoForAccess, can } from '../security/access.js';
import { notFound, badRequest, conflict, forbidden } from '../lib/errors.js';
import { escapeRegex, toDTO } from '../lib/http.js';

// ---------------------------------------------------------------------------
// Confirmed Fix
// ---------------------------------------------------------------------------
export const searchFixes = async ({ dtc, make, model, q, status }) => {
  const filter = { status: status || 'verified' };
  if (dtc) filter.dtcCodes = dtc.toUpperCase();
  if (make) filter['vehicle.make'] = new RegExp(`^${escapeRegex(make)}$`, 'i');
  if (model) filter['vehicle.model'] = new RegExp(escapeRegex(model), 'i');
  if (q) filter.$or = [{ rootCause: new RegExp(escapeRegex(q), 'i') }, { correction: new RegExp(escapeRegex(q), 'i') }, { component: new RegExp(escapeRegex(q), 'i') }];
  const fixes = await ConfirmedFix.find(filter).sort({ verifiedAt: -1, createdAt: -1 }).limit(200).lean();
  // aggregate identical outcomes so counts reflect real verified repairs
  const groups = new Map();
  for (const f of fixes) {
    const key = `${f.dtcCodes.slice().sort().join('+')}|${(f.component || f.rootCause).toLowerCase()}|${f.vehicle.make}|${f.vehicle.model}`;
    const g = groups.get(key) || { ...toDTO(f), verifiedOccurrences: 0, sourceRepairOrders: [] };
    g.verifiedOccurrences += 1;
    g.sourceRepairOrders.push(f.source.roNumber);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.verifiedOccurrences - a.verifiedOccurrences);
};

export const reviewFix = async (req, id, { approve, reason }) => {
  const fix = await ConfirmedFix.findOne({ id }).lean();
  if (!fix) throw notFound('Confirmed fix');
  if (fix.status !== 'candidate') throw conflict(`Fix is ${fix.status}`);
  if (fix.technicianId === req.auth.userId) throw forbidden('A different person must verify this repair outcome');
  const set = approve ? { status: 'verified', verifiedBy: req.auth.userId, verifiedAt: new Date() } : { status: 'rejected', rejectedBy: req.auth.userId, rejectionReason: reason };
  const updated = await ConfirmedFix.findOneAndUpdate({ id, status: 'candidate' }, { $set: set }, { new: true }).lean();
  await audit(req, { eventType: approve ? 'CONFIRMED_FIX_VERIFIED' : 'CONFIRMED_FIX_REJECTED', category: 'approval', entityType: 'ConfirmedFix', entityId: id, locationId: fix.source.locationId, action: `${approve ? 'Verified' : 'Rejected'} fix for ${fix.dtcCodes.join(', ')} from ${fix.source.roNumber}`, reason });
  return toDTO(updated);
};

registerJobHandler('fix.comeback_check', async ({ vehicleId, roId, dtcCodes }) => {
  const settings = await CorporateSettings.findOne({ key: 'corporate' }).lean();
  const windowDays = settings?.comebackWindowDays || 90;
  const since = new Date(Date.now() - windowDays * 86400000);
  const prior = await ConfirmedFix.find({ 'vehicle.vehicleId': vehicleId, status: { $in: ['candidate', 'verified'] }, dtcCodes: { $in: dtcCodes }, createdAt: { $gte: since }, 'source.roId': { $ne: roId } }).lean();
  for (const fix of prior) {
    await ConfirmedFix.updateOne({ id: fix.id, status: { $ne: 'comeback' } }, { $set: { status: 'comeback', comebackRoId: roId, comebackDetectedAt: new Date() } });
    await notifyRoles(fix.source.locationId, ['manager'], { type: 'comeback', severity: 'warning', title: `Possible comeback: ${dtcCodes.join(', ')}`, body: `Vehicle returned within ${windowDays} days of ${fix.source.roNumber}`, link: `#/app/ro/${roId}`, dedupeKey: `comeback:${fix.id}:${roId}` });
  }
  return { flagged: prior.length };
});

// ---------------------------------------------------------------------------
// Parts reliability, failures and warranty
// ---------------------------------------------------------------------------
export const recordPartFailure = async (req, { installedPartId, comebackRoId, failureMode, determination, odometer, evidenceIds }) => {
  const installed = await InstalledPart.findOne({ id: installedPartId }).lean();
  if (!installed) throw notFound('Installed part');
  if (comebackRoId) await findRoForAccess(req.auth, comebackRoId);
  const now = new Date();
  const days = Math.round((now - installed.installedAt) / 86400000);
  const miles = Number.isFinite(odometer) && Number.isFinite(installed.odometer) ? odometer - installed.odometer : null;
  const withinWarranty = (!installed.warrantyMonths || days <= installed.warrantyMonths * 30.44) && (!installed.warrantyMiles || miles === null || miles <= installed.warrantyMiles);
  const failure = await withTransaction(async (session) => {
    const [f] = await PartFailure.create([{
      installedPartId, partId: installed.partId, supplierId: installed.supplierId, lotNumber: installed.lotNumber, vehicleId: installed.vehicleId,
      originalRoId: installed.roId, comebackRoId, failedAt: now, odometer, daysInService: days, milesInService: miles,
      failureMode, determination, withinWarranty, recordedBy: req.auth.userId, evidenceIds
    }], { session });
    await InstalledPart.updateOne({ id: installedPartId }, { $set: { status: 'failed' } }, { session });
    await audit(req, { eventType: 'PART_FAILURE_RECORDED', category: 'data', entityType: 'InstalledPart', entityId: installedPartId, action: `${installed.partNumber} failed after ${days} days (${determination})` }, session);
    return f;
  });
  return toDTO(failure.toObject());
};

export const updateWarrantyClaim = async (req, failureId, claim) => {
  const updated = await PartFailure.findOneAndUpdate({ id: failureId }, { $set: Object.fromEntries(Object.entries(claim).map(([k, v]) => [`warrantyClaim.${k}`, v])) }, { new: true }).lean();
  if (!updated) throw notFound('Part failure');
  if (updated.warrantyClaim?.status === 'approved') {
    const { queueEconomics } = await import('./economicsService.js');
    await queueEconomics('warranty', { failureId }, failureId);
  }
  await audit(req, { eventType: 'WARRANTY_CLAIM_UPDATED', category: 'financial', entityType: 'PartFailure', entityId: failureId, action: `Warranty claim ${claim.status || 'updated'}${claim.creditCents ? ` credit ${claim.creditCents} cents` : ''}` });
  return toDTO(updated);
};

export const reliabilityReport = async ({ groupBy = 'part', from }) => {
  const since = from ? new Date(from) : new Date(Date.now() - 365 * 86400000);
  const key = groupBy === 'supplier' ? '$supplierId' : groupBy === 'lot' ? { partId: '$partId', lot: '$lotNumber' } : '$partId';
  const [installs, failures] = await Promise.all([
    InstalledPart.aggregate([{ $match: { installedAt: { $gte: since } } }, { $group: { _id: key, installed: { $sum: '$quantity' }, vehicles: { $addToSet: '$vehicleId' } } }]),
    PartFailure.aggregate([{ $match: { failedAt: { $gte: since } } }, { $group: { _id: key, failed: { $sum: 1 }, warranty: { $sum: { $cond: ['$withinWarranty', 1, 0] } }, defective: { $sum: { $cond: [{ $eq: ['$determination', 'defective_part'] }, 1, 0] } }, avgDays: { $avg: '$daysInService' } } }])
  ]);
  const fmap = new Map(failures.map(f => [JSON.stringify(f._id), f]));
  const partIds = installs.map(i => (groupBy === 'lot' ? i._id.partId : i._id)).filter(Boolean);
  const [parts, suppliers] = await Promise.all([Part.find({ id: { $in: partIds } }).select('id partNumber description brand').lean(), Supplier.find().select('id name').lean()]);
  return installs.map(i => {
    const f = fmap.get(JSON.stringify(i._id)) || {};
    const part = parts.find(p => p.id === (groupBy === 'lot' ? i._id?.partId : i._id));
    return {
      key: i._id,
      label: groupBy === 'supplier' ? suppliers.find(s => s.id === i._id)?.name || 'Unknown supplier' : `${part?.partNumber || 'Unknown'}${groupBy === 'lot' ? ` lot ${i._id.lot || 'n/a'}` : ''}`,
      description: part?.description,
      installed: i.installed,
      failed: f.failed || 0,
      defective: f.defective || 0,
      warrantyFailures: f.warranty || 0,
      failureRatePct: i.installed ? +(((f.failed || 0) / i.installed) * 100).toFixed(2) : 0,
      avgDaysToFailure: f.avgDays ? Math.round(f.avgDays) : null,
      sampleSizeNote: i.installed < 20 ? 'Small sample — interpret with caution' : null
    };
  }).sort((a, b) => b.failureRatePct - a.failureRatePct);
};

export const repeatFailures = async () => {
  const rows = await PartFailure.aggregate([{ $group: { _id: { vehicleId: '$vehicleId', partId: '$partId' }, n: { $sum: 1 }, last: { $max: '$failedAt' } } }, { $match: { n: { $gte: 2 } } }, { $sort: { n: -1 } }, { $limit: 100 }]);
  return rows.map(r => ({ vehicleId: r._id.vehicleId, partId: r._id.partId, failures: r.n, lastFailedAt: r.last }));
};

// ---------------------------------------------------------------------------
// Technician Forum
// ---------------------------------------------------------------------------
export const listThreads = async ({ q, dtc, make, status, page = 1, limit = 25 }) => {
  const filter = {};
  if (q) filter.$text = { $search: q };
  if (dtc) filter['context.dtcCodes'] = dtc.toUpperCase();
  if (make) filter['context.make'] = new RegExp(`^${escapeRegex(make)}$`, 'i');
  if (status) filter.status = status;
  const items = await ForumThread.find(filter).sort({ lastActivityAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
  return toDTO(items);
};

export const getThread = async (auth, id) => {
  const thread = await ForumThread.findOneAndUpdate({ id }, { $inc: { views: 1 } }, { new: true }).lean();
  if (!thread) throw notFound('Thread');
  const [replies, myVotes, fix] = await Promise.all([
    ForumReply.find({ threadId: id }).sort({ isAccepted: -1, voteCount: -1, createdAt: 1 }).lean(),
    ForumVote.find({ userId: auth.userId }).select('targetId').lean(),
    thread.linkedConfirmedFixId ? ConfirmedFix.findOne({ id: thread.linkedConfirmedFixId, status: 'verified' }).lean() : null
  ]);
  const voted = new Set(myVotes.map(v => v.targetId));
  return { thread: { ...toDTO(thread), votedByMe: voted.has(id) }, replies: toDTO(replies).map(r => ({ ...r, votedByMe: voted.has(r.id) })), verifiedFix: fix ? toDTO(fix) : null };
};

export const createThread = async (req, input) => {
  if (input.context?.roId) await findRoForAccess(req.auth, input.context.roId);
  const t = await ForumThread.create({ ...input, authorId: req.auth.userId, authorName: req.auth.user.name, authorRole: req.auth.role });
  return toDTO(t);
};

export const reply = async (req, threadId, { body, evidenceIds }) => {
  const thread = await ForumThread.findOne({ id: threadId }).lean();
  if (!thread) throw notFound('Thread');
  if (thread.status === 'locked') throw conflict('Thread is locked');
  const r = await ForumReply.create({ threadId, body, evidenceIds, authorId: req.auth.userId, authorName: req.auth.user.name, authorRole: req.auth.role });
  await ForumThread.updateOne({ id: threadId }, { $inc: { replyCount: 1 }, $set: { lastActivityAt: new Date() } });
  return toDTO(r);
};

export const vote = async (req, targetType, targetId) => {
  const Model = targetType === 'thread' ? ForumThread : ForumReply;
  if (!(await Model.exists({ id: targetId }))) throw notFound('Post');
  try {
    await ForumVote.create({ userId: req.auth.userId, targetType, targetId });
  } catch (err) {
    if (err.code === 11000) throw conflict('You already voted');
    throw err;
  }
  await Model.updateOne({ id: targetId }, { $inc: { voteCount: 1 } });
  return { success: true };
};

export const acceptReply = async (req, threadId, replyId) => {
  const thread = await ForumThread.findOne({ id: threadId }).lean();
  if (!thread) throw notFound('Thread');
  if (thread.authorId !== req.auth.userId && !can(req.auth, 'forum:moderate')) throw forbidden('Only the author or a moderator can accept a solution');
  if (!(await ForumReply.exists({ id: replyId, threadId }))) throw notFound('Reply');
  await ForumReply.updateMany({ threadId }, { $set: { isAccepted: false } });
  await ForumReply.updateOne({ id: replyId }, { $set: { isAccepted: true } });
  await ForumThread.updateOne({ id: threadId }, { $set: { acceptedReplyId: replyId, status: 'solved' } });
  return getThread(req.auth, threadId);
};

export const moderateThread = async (req, threadId, { status, linkedConfirmedFixId }) => {
  const set = {};
  if (status) set.status = status;
  if (linkedConfirmedFixId !== undefined) {
    if (linkedConfirmedFixId && !(await ConfirmedFix.exists({ id: linkedConfirmedFixId, status: 'verified' }))) throw badRequest('Only verified fixes can be linked');
    set.linkedConfirmedFixId = linkedConfirmedFixId || null;
  }
  const t = await ForumThread.findOneAndUpdate({ id: threadId }, { $set: set }, { new: true }).lean();
  if (!t) throw notFound('Thread');
  return toDTO(t);
};

// ---------------------------------------------------------------------------
// Fuel economy (baseline = the vehicle's own history, never a guessed figure)
// ---------------------------------------------------------------------------
export const FUEL_RULE_VERSION = 'fuel-anomaly-1';
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export const addFuelEvent = async (req, { vehicleId, at, odometer, volume, volumeUnit = 'gal', fullTank = true, costCents }) => {
  const vehicle = await Vehicle.findOne({ id: vehicleId }).lean();
  if (!vehicle) throw notFound('Vehicle');
  await assertVehicleAccess(req.auth, vehicle);
  const gallons = volumeUnit === 'L' ? volume / 3.785411784 : volume;
  const prior = await FuelEvent.find({ vehicleId, odometer: { $lt: odometer } }).sort({ odometer: -1 }).limit(30).lean();
  let economy;
  const lastFull = prior.find(p => p.fullTank);
  if (fullTank && lastFull) {
    const between = prior.filter(p => p.odometer > lastFull.odometer);
    const vol = gallons + between.reduce((s, p) => s + (p.volumeUnit === 'L' ? p.volume / 3.785411784 : p.volume), 0);
    const miles = odometer - lastFull.odometer;
    if (miles > 0 && vol > 0) economy = { milesSinceLastFull: miles, volumeSinceLastFull: +vol.toFixed(3), mpg: +(miles / vol).toFixed(2) };
  }
  let anomaly = { flagged: false, ruleVersion: FUEL_RULE_VERSION };
  const history = prior.map(p => p.economy?.mpg).filter(Number.isFinite).slice(0, 8);
  if (economy && history.length >= 3) {
    const base = median(history);
    const dev = ((economy.mpg - base) / base) * 100;
    anomaly = {
      flagged: dev <= -15, baselineMpg: +base.toFixed(2), baselineSamples: history.length, deviationPct: +dev.toFixed(1), ruleVersion: FUEL_RULE_VERSION,
      explanation: `${economy.mpg} MPG vs median ${base.toFixed(1)} MPG of the last ${history.length} fill-ups (${dev.toFixed(1)}%). Threshold: -15%.`
    };
  } else if (economy) {
    anomaly.explanation = 'Not enough fill-up history (3 needed) to establish a baseline';
  }
  const ev = await FuelEvent.create({ vehicleId, customerId: vehicle.customerId, at: at ? new Date(at) : new Date(), odometer, volume, volumeUnit, fullTank, costCents, source: req.auth.role === 'customer' ? 'customer_portal' : 'staff', recordedBy: req.auth.userId, economy, anomaly });
  const { recordMileage } = await import('./vehicleService.js');
  await recordMileage(req, vehicleId, { odometer, source: 'fuel', sourceRef: ev.id });
  if (anomaly.flagged) await enqueueJob('predictive.evaluate_vehicle', { vehicleId }, `pred:${vehicleId}:${ev.id}`);
  return toDTO(ev);
};

export const fuelHistory = async (auth, vehicleId) => {
  const vehicle = await Vehicle.findOne({ id: vehicleId }).lean();
  if (!vehicle) throw notFound('Vehicle');
  await assertVehicleAccess(auth, vehicle);
  const events = await FuelEvent.find({ vehicleId }).sort({ odometer: -1 }).limit(200).lean();
  const mpgs = events.map(e => e.economy?.mpg).filter(Number.isFinite);
  return { events: toDTO(events), averageMpg: mpgs.length ? +(mpgs.reduce((a, b) => a + b, 0) / mpgs.length).toFixed(2) : null, anomalies: events.filter(e => e.anomaly?.flagged).length };
};

// ---------------------------------------------------------------------------
// Predictive maintenance (versioned deterministic rules)
// ---------------------------------------------------------------------------
export const listRules = async () => toDTO(await PredictiveRule.find().sort({ key: 1, version: -1 }).lean());

export const saveRule = async (req, { key, name, kind, parameters, active = true }) => {
  const latest = await PredictiveRule.findOne({ key }).sort({ version: -1 }).lean();
  if (latest) await PredictiveRule.updateMany({ key, active: true }, { $set: { active: false } });
  const rule = await PredictiveRule.create({ key, name, kind, parameters, active, version: (latest?.version || 0) + 1, createdBy: req.auth.userId });
  await audit(req, { eventType: 'PREDICTIVE_RULE_PUBLISHED', category: 'data', entityType: 'PredictiveRule', entityId: key, action: `Published rule ${key} v${rule.version}` });
  return toDTO(rule);
};

const signal = async (vehicle, rule, data) => {
  try {
    await PredictiveSignal.create({ vehicleId: vehicle.id, customerId: vehicle.customerId, ruleKey: rule.key, ruleVersion: rule.version, ...data });
    return 1;
  } catch (err) {
    if (err.code === 11000) return 0; // already raised for this evidence
    throw err;
  }
};

export const evaluateVehicle = async (vehicleId) => {
  const vehicle = await Vehicle.findOne({ id: vehicleId }).lean();
  if (!vehicle) return { created: 0 };
  const [rules, settings, ros] = await Promise.all([
    PredictiveRule.find({ active: true }).lean(),
    CorporateSettings.findOne({ key: 'corporate' }).lean(),
    RepairOrder.find({ vehicleId, status: 'closed' }).sort({ closedAt: -1 }).lean()
  ]);
  let created = 0;
  for (const rule of rules) {
    const p = rule.parameters || {};
    if (rule.kind === 'maintenance_interval') {
      const interval = (settings?.maintenanceIntervals || []).find(i => i.key === p.intervalKey && i.active);
      if (!interval) continue;
      const lastRo = ros.find(r => r.jobs.some(j => j.laborOpCode === interval.laborOpCode && ['completed', 'verified'].includes(j.status)));
      if (!lastRo) continue; // no recorded service -> no basis for a due date
      const dueMileage = interval.intervalMiles && lastRo.odometerOut ? lastRo.odometerOut + interval.intervalMiles : null;
      const dueAt = interval.intervalMonths ? new Date(new Date(lastRo.closedAt).getTime() + interval.intervalMonths * 30.44 * 86400000) : null;
      const due = (dueMileage && vehicle.mileage >= dueMileage - (p.leadMiles || 500)) || (dueAt && dueAt <= new Date(Date.now() + (p.leadDays || 14) * 86400000));
      if (due) {
        created += await signal(vehicle, rule, {
          dedupeKey: `${rule.key}:${vehicle.id}:${lastRo.id}`, title: `${interval.name} due`, dueAt, dueMileage,
          recommendation: `Schedule ${interval.name}`, reason: `Last performed on ${lastRo.roNumber} at ${lastRo.odometerOut ?? 'unrecorded'} miles; shop interval ${interval.intervalMiles || '-'} mi / ${interval.intervalMonths || '-'} months`,
          evidence: [{ type: 'repair_order', ref: lastRo.id, summary: lastRo.roNumber }, { type: 'mileage', ref: vehicle.id, summary: `${vehicle.mileage} mi current` }],
          confidence: dueMileage && lastRo.odometerOut ? 'high' : 'medium', uncertainty: 'Based on shop policy intervals and recorded mileage; driving conditions may change the actual need.'
        });
      }
    } else if (rule.kind === 'declined_finding_followup') {
      const declined = await Finding.find({ vehicleId, status: 'active', customerDecision: 'declined', severity: { $in: p.severities || ['safety', 'repair'] } }).lean();
      for (const f of declined) {
        created += await signal(vehicle, rule, {
          dedupeKey: `${rule.key}:${f.id}`, title: `Re-check: ${f.name}`, recommendation: `Re-inspect ${f.name} (previously declined)`,
          reason: `Customer declined "${f.recommendation || f.name}" (${f.severity}) on a previous visit`,
          evidence: [{ type: 'finding', ref: f.id, summary: f.notes || f.name }], confidence: f.severity === 'safety' ? 'high' : 'medium',
          uncertainty: 'Condition may have changed since the inspection.'
        });
      }
    } else if (rule.kind === 'repeat_dtc') {
      const sessions = await DiagnosticSession.find({ vehicleId }).select('roId dtcs').lean();
      const counts = new Map();
      for (const s of sessions) for (const c of new Set(s.dtcs.map(d => d.code))) counts.set(c, [...(counts.get(c) || []), s.roId]);
      for (const [code, roIds] of counts) {
        if (roIds.length < (p.minOccurrences || 2)) continue;
        created += await signal(vehicle, rule, {
          dedupeKey: `${rule.key}:${vehicle.id}:${code}:${roIds.length}`, title: `Recurring ${code}`, recommendation: `Root-cause review for repeat ${code}`,
          reason: `${code} recorded on ${roIds.length} separate repair orders`, evidence: roIds.map(r => ({ type: 'repair_order', ref: r, summary: code })),
          confidence: 'medium', uncertainty: 'Repeat codes can have different causes on each visit.'
        });
      }
    } else if (rule.kind === 'fuel_economy_anomaly') {
      const last = await FuelEvent.findOne({ vehicleId, 'anomaly.flagged': true }).sort({ at: -1 }).lean();
      if (last) {
        created += await signal(vehicle, rule, {
          dedupeKey: `${rule.key}:${last.id}`, title: 'Fuel economy drop', recommendation: 'Inspect for causes of reduced fuel economy',
          reason: last.anomaly.explanation, evidence: [{ type: 'fuel_event', ref: last.id, summary: `${last.economy?.mpg} MPG` }],
          confidence: last.anomaly.baselineSamples >= 6 ? 'medium' : 'low', uncertainty: 'Driving pattern, season and fuel blend also affect economy.'
        });
      }
    } else if (rule.kind === 'part_warranty_expiry') {
      const soon = new Date(Date.now() + (p.leadDays || 30) * 86400000);
      const parts = await InstalledPart.find({ vehicleId, status: 'in_service', warrantyMonths: { $gt: 0 } }).lean();
      for (const ip of parts) {
        const expires = new Date(ip.installedAt.getTime() + ip.warrantyMonths * 30.44 * 86400000);
        if (expires > new Date() && expires <= soon) {
          created += await signal(vehicle, rule, {
            dedupeKey: `${rule.key}:${ip.id}`, title: `Warranty ending: ${ip.description}`, dueAt: expires,
            recommendation: `Check ${ip.description} before warranty ends`, reason: `${ip.warrantyMonths}-month warranty from ${ip.installedAt.toISOString().slice(0, 10)}`,
            evidence: [{ type: 'installed_part', ref: ip.id, summary: ip.partNumber }], confidence: 'high', uncertainty: 'Informational; does not indicate a fault.'
          });
        }
      }
    }
  }
  return { created };
};

registerJobHandler('predictive.evaluate_vehicle', ({ vehicleId }) => evaluateVehicle(vehicleId));
registerJobHandler('ro.closed', async ({ roId }) => {
  const ro = await RepairOrder.findOne({ id: roId }).lean();
  return ro ? evaluateVehicle(ro.vehicleId) : null;
});

export const listSignals = async (auth, { vehicleId, status }) => {
  const filter = { status: status || 'open' };
  if (vehicleId) {
    const v = await Vehicle.findOne({ id: vehicleId }).lean();
    if (!v) throw notFound('Vehicle');
    await assertVehicleAccess(auth, v);
    filter.vehicleId = vehicleId;
  } else if (auth.role === 'customer') filter.customerId = auth.customerId;
  return toDTO(await PredictiveSignal.find(filter).sort({ createdAt: -1 }).limit(300).lean());
};

// Signals never create paid work; staff decide, and estimates still need approval.
export const decideSignal = async (req, id, { status, note }) => {
  if (!['dismissed', 'open'].includes(status)) throw badRequest('Signals are dismissed here; add them to an estimate from the repair order');
  const s = await PredictiveSignal.findOneAndUpdate({ id }, { $set: { status, decidedBy: req.auth.userId, decidedAt: new Date(), decisionNote: note } }, { new: true }).lean();
  if (!s) throw notFound('Signal');
  return toDTO(s);
};
