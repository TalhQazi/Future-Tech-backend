import { withTransaction } from '../config/db.js';
import { RepairOrder, TimeEntry, Reservation, Evidence, User } from '../models/index.js';
import { RO_OPEN_STATUSES } from '../models/operations.js';
import { audit } from './audit.js';
import { timelineEvent, getRepairOrder } from './roService.js';
import { notifyUsers, notifyRoles } from './notificationService.js';
import { findRoForAccess, assertLocation, locationFilter, can } from '../security/access.js';
import { notFound, badRequest, conflict, unprocessable, forbidden } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';

const minutesBetween = (a, b) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));

const closeOpenEntry = async (techId, session, note) => {
  const open = await TimeEntry.findOne({ techId, status: 'open' }).session(session);
  if (!open) return null;
  const endAt = new Date();
  await TimeEntry.updateOne({ id: open.id, status: 'open' }, { $set: { status: 'closed', endAt, minutes: minutesBetween(open.startAt, endAt), note: note || open.note } }, { session });
  return open;
};

const openEntry = async ({ techId, locationId, roId, jobId, type }, session) => {
  await closeOpenEntry(techId, session);
  const [entry] = await TimeEntry.create([{ techId, locationId, roId, jobId, type, status: 'open', startAt: new Date() }], { session });
  return entry;
};

const assertJobActor = (auth, job) => {
  if (job.techId && job.techId !== auth.userId && !can(auth, 'ros:override')) {
    throw forbidden('This job is assigned to another technician');
  }
};

export const startJob = async (req, roId, jobId) => {
  const ro = await findRoForAccess(req.auth, roId);
  if (!['approved', 'in_progress', 'waiting_parts'].includes(ro.status)) throw conflict(`Work cannot start while the repair order is ${ro.status}`);
  const job = ro.jobs.find(j => j.id === jobId);
  if (!job) throw notFound('Job');
  assertJobActor(req.auth, job);
  if (!['authorized', 'paused'].includes(job.status)) throw conflict(`Job is ${job.status}`);
  await withTransaction(async (session) => {
    const res = await RepairOrder.updateOne({ id: ro.id, jobs: { $elemMatch: { id: jobId, status: job.status } } }, {
      $set: {
        'jobs.$.status': 'in_progress',
        'jobs.$.techId': job.techId || req.auth.userId,
        'jobs.$.startedAt': job.startedAt || new Date(),
        status: 'in_progress'
      },
      $addToSet: { techIds: req.auth.userId },
      $inc: { __v: 1 },
      $push: { timeline: timelineEvent(req.auth, 'job', `Started: ${job.title}`, true) }
    }, { session });
    if (res.modifiedCount !== 1) throw conflict('Job changed; reload and try again');
    await openEntry({ techId: req.auth.userId, locationId: ro.locationId, roId: ro.id, jobId, type: 'job' }, session);
  });
  return getRepairOrder(req.auth, ro.id);
};

export const pauseJob = async (req, roId, jobId, { reason }) => {
  const ro = await findRoForAccess(req.auth, roId);
  const job = ro.jobs.find(j => j.id === jobId);
  if (!job) throw notFound('Job');
  assertJobActor(req.auth, job);
  if (job.status !== 'in_progress') throw conflict('Only running jobs can be paused');
  await withTransaction(async (session) => {
    await RepairOrder.updateOne({ id: ro.id, 'jobs.id': jobId }, {
      $set: { 'jobs.$.status': 'paused', ...(reason === 'waiting_parts' ? { status: 'waiting_parts' } : {}) },
      $inc: { __v: 1 },
      $push: { timeline: timelineEvent(req.auth, 'job', `Paused: ${job.title}${reason ? ` (${reason.replace('_', ' ')})` : ''}`, reason === 'waiting_parts') }
    }, { session });
    await closeOpenEntry(req.auth.userId, session, reason);
  });
  return getRepairOrder(req.auth, ro.id);
};

export const completeJob = async (req, roId, jobId, { completionNotes, evidenceIds = [] }) => {
  const ro = await findRoForAccess(req.auth, roId);
  const job = ro.jobs.find(j => j.id === jobId);
  if (!job) throw notFound('Job');
  assertJobActor(req.auth, job);
  if (!['in_progress', 'paused'].includes(job.status)) throw conflict('Start the job before completing it');
  if (!completionNotes?.trim()) throw badRequest('Describe the work performed (correction) before completing the job');
  if (evidenceIds.length) {
    const found = await Evidence.countDocuments({ id: { $in: evidenceIds }, roId: ro.id });
    if (found !== evidenceIds.length) throw badRequest('Completion evidence must belong to this repair order');
  }
  const unissued = await Reservation.find({ roId: ro.id, estimateLineId: { $in: job.estimateLineIds }, status: 'active' }).lean();
  if (unissued.length) {
    throw unprocessable('Issue or release the parts reserved for this job before completing it', { reservations: unissued.map(r => ({ id: r.id, partId: r.partId, quantity: r.quantity - r.issuedQuantity })) }, 'PARTS_NOT_ISSUED');
  }
  const remaining = ro.jobs.filter(j => j.id !== jobId && !['completed', 'verified', 'cancelled'].includes(j.status));
  await withTransaction(async (session) => {
    const res = await RepairOrder.updateOne({ id: ro.id, jobs: { $elemMatch: { id: jobId, status: { $in: ['in_progress', 'paused'] } } } }, {
      $set: {
        'jobs.$.status': 'completed',
        'jobs.$.completedAt': new Date(),
        'jobs.$.completedBy': req.auth.userId,
        'jobs.$.completionNotes': completionNotes.trim(),
        'jobs.$.completionEvidenceIds': evidenceIds
      },
      $inc: { __v: 1 },
      $push: { timeline: timelineEvent(req.auth, 'job', `Completed: ${job.title}`, true) }
    }, { session });
    if (res.modifiedCount !== 1) throw conflict('Job changed; reload and try again');
    const open = await TimeEntry.findOne({ techId: req.auth.userId, status: 'open', jobId }).session(session);
    if (open) await closeOpenEntry(req.auth.userId, session);
    await audit(req, { eventType: 'JOB_COMPLETED', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId, action: `${ro.roNumber}: completed "${job.title}"` }, session);
  });
  if (!remaining.length) {
    const targets = [ro.advisorId].filter(Boolean);
    await notifyUsers(targets, { type: 'jobs_complete', title: `${ro.roNumber}: all work complete`, body: 'Ready for quality check', link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
    await notifyRoles(ro.locationId, ['manager'], { type: 'qc_needed', title: `${ro.roNumber} ready for QC`, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id, dedupeKey: `qc:${ro.id}:${ro.__v}` });
  }
  return getRepairOrder(req.auth, ro.id);
};

export const reassignJob = async (req, roId, jobId, { techId }) => {
  const ro = await findRoForAccess(req.auth, roId);
  const job = ro.jobs.find(j => j.id === jobId);
  if (!job) throw notFound('Job');
  if (['completed', 'verified', 'cancelled'].includes(job.status)) throw conflict('Finished jobs cannot be reassigned');
  const tech = await User.findOne({ id: techId, role: { $in: ['technician', 'manager'] }, status: 'active', locationIds: ro.locationId }).lean();
  if (!tech) throw badRequest('Technician is not active at this location');
  await RepairOrder.updateOne({ id: ro.id, 'jobs.id': jobId }, {
    $set: { 'jobs.$.techId': techId }, $addToSet: { techIds: techId }, $inc: { __v: 1 },
    $push: { timeline: timelineEvent(req.auth, 'dispatch', `"${job.title}" assigned to ${tech.name}`) }
  });
  await notifyUsers([techId], { type: 'job_assigned', title: `${ro.roNumber}: ${job.title}`, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
  return getRepairOrder(req.auth, ro.id);
};

// ---------------------------------------------------------------------------
// Time clock
// ---------------------------------------------------------------------------
export const clockIn = async (req, { roId, jobId, type = 'shop' }) => {
  let locationId = req.auth.primaryLocationId;
  if (roId) {
    const ro = await findRoForAccess(req.auth, roId);
    if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Repair order is closed');
    locationId = ro.locationId;
    roId = ro.id;
  }
  if (!locationId) throw badRequest('No location to clock in to');
  const entry = await withTransaction((session) => openEntry({ techId: req.auth.userId, locationId, roId, jobId, type }, session));
  return toDTO(entry.toObject());
};

export const clockOut = async (req, { note }) => {
  const closed = await withTransaction((session) => closeOpenEntry(req.auth.userId, session, note));
  if (!closed) throw conflict('You are not clocked in');
  return toDTO(await TimeEntry.findOne({ id: closed.id }).lean());
};

export const myTime = async (auth, { from, to }) => {
  const filter = { techId: auth.userId };
  if (from || to) {
    filter.startAt = {};
    if (from) filter.startAt.$gte = new Date(from);
    if (to) filter.startAt.$lt = new Date(to);
  }
  const entries = await TimeEntry.find(filter).sort({ startAt: -1 }).limit(300).lean();
  const open = entries.find(e => e.status === 'open') || null;
  return { entries: toDTO(entries), open: open ? toDTO(open) : null };
};

export const listTimeEntries = async (auth, { locationId, techId, roId, from, to }) => {
  const filter = { ...locationFilter(auth) };
  if (locationId) {
    assertLocation(auth, locationId);
    filter.locationId = locationId;
  }
  if (techId) filter.techId = techId;
  if (roId) filter.roId = roId;
  if (from || to) {
    filter.startAt = {};
    if (from) filter.startAt.$gte = new Date(from);
    if (to) filter.startAt.$lt = new Date(to);
  }
  return toDTO(await TimeEntry.find(filter).sort({ startAt: -1 }).limit(1000).lean());
};

export const correctTimeEntry = async (req, id, { startAt, endAt, reason }) => {
  if (!reason) throw badRequest('A correction reason is required');
  const entry = await TimeEntry.findOne({ id }).lean();
  if (!entry) throw notFound('Time entry');
  assertLocation(req.auth, entry.locationId);
  const start = startAt ? new Date(startAt) : entry.startAt;
  const end = endAt ? new Date(endAt) : entry.endAt;
  if (!end || end <= start) throw badRequest('End time must be after start time');
  const updated = await TimeEntry.findOneAndUpdate({ id }, {
    $set: { startAt: start, endAt: end, status: 'closed', minutes: minutesBetween(start, end), correctedBy: req.auth.userId, correctionReason: reason }
  }, { new: true }).lean();
  await audit(req, {
    eventType: 'TIME_ENTRY_CORRECTED', category: 'override', entityType: 'TimeEntry', entityId: id, locationId: entry.locationId,
    action: `Corrected time entry for technician ${entry.techId}`, reason,
    before: { startAt: entry.startAt, endAt: entry.endAt, minutes: entry.minutes }, after: { startAt: start, endAt: end, minutes: updated.minutes }
  });
  return toDTO(updated);
};

// Dispatch board: open work per technician at a location.
export const technicianWorkload = async (auth, { locationId }) => {
  assertLocation(auth, locationId);
  const [techs, ros, open] = await Promise.all([
    User.find({ role: 'technician', status: 'active', locationIds: locationId }).select('id name specialty certifications').lean(),
    RepairOrder.find({ locationId, status: { $in: RO_OPEN_STATUSES } }).select('id roNumber status assignedTechId jobs vehicleId promisedAt priority').lean(),
    TimeEntry.find({ locationId, status: 'open' }).lean()
  ]);
  return techs.map(t => {
    const jobs = ros.flatMap(r => r.jobs.filter(j => j.techId === t.id && !['completed', 'verified', 'cancelled'].includes(j.status)).map(j => ({ roId: r.id, roNumber: r.roNumber, jobId: j.id, title: j.title, status: j.status, soldHours: j.soldHours })));
    const assignedRos = ros.filter(r => r.assignedTechId === t.id).map(r => ({ id: r.id, roNumber: r.roNumber, status: r.status, priority: r.priority, promisedAt: r.promisedAt }));
    const clock = open.find(e => e.techId === t.id);
    return {
      ...t, _id: undefined,
      clockedIn: Boolean(clock),
      currentEntry: clock ? toDTO(clock) : null,
      openJobs: jobs,
      assignedRepairOrders: assignedRos,
      queuedHours: +jobs.reduce((s, j) => s + (j.soldHours || 0), 0).toFixed(2)
    };
  });
};
