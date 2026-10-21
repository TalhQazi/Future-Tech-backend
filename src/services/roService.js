import { withTransaction } from '../config/db.js';
import {
  RepairOrder, Location, Customer, Vehicle, User, Inspection, InspectionTemplate, Estimate, EstimateVersion,
  Invoice, DiagnosticSession, PartRequest, Reservation, TimeEntry, Finding, Appointment
} from '../models/index.js';
import { RO_OPEN_STATUSES } from '../models/operations.js';
import { audit } from './audit.js';
import { nextNumber, shortCode } from './sequence.js';
import { recordMileage } from './vehicleService.js';
import { customerOwnsVehicle } from './customerService.js';
import { markCheckedIn } from './appointmentService.js';
import { notifyRoles, notifyUsers } from './notificationService.js';
import { assertLocation, locationFilter, findRoForAccess, projectCustomer, can } from '../security/access.js';
import { notFound, badRequest, conflict, unprocessable, forbidden } from '../lib/errors.js';
import { escapeRegex, toDTO, paginationMeta } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';

// Allowed manual status transitions. Some states are only reachable through
// their workflow (approval -> approved, QC pass -> ready_for_pickup, close).
const TRANSITIONS = {
  checked_in: ['inspecting', 'diagnosing', 'awaiting_approval', 'cancelled'],
  inspecting: ['diagnosing', 'awaiting_approval', 'cancelled'],
  diagnosing: ['inspecting', 'awaiting_approval', 'cancelled'],
  awaiting_approval: ['inspecting', 'diagnosing', 'cancelled'],
  approved: ['in_progress', 'waiting_parts', 'awaiting_approval'],
  in_progress: ['waiting_parts', 'quality_check', 'awaiting_approval'],
  waiting_parts: ['in_progress', 'awaiting_approval'],
  quality_check: ['in_progress'],
  ready_for_pickup: ['in_progress'],
  closed: [],
  cancelled: []
};

export const timelineEvent = (auth, type, summary, customerVisible = false) => ({
  at: new Date(), type, by: auth?.userId, byName: auth?.user?.name, summary, customerVisible
});

const pushTimeline = (roId, event, session) =>
  RepairOrder.updateOne({ id: roId }, { $push: { timeline: { $each: [event], $slice: -300 } } }, { session });

export const createRepairOrder = async (req, input) => {
  const { auth } = req;
  assertLocation(auth, input.locationId);
  const [location, customer, vehicle] = await Promise.all([
    Location.findOne({ id: input.locationId, status: { $ne: 'inactive' } }).lean(),
    Customer.findOne({ id: input.customerId }).lean(),
    Vehicle.findOne({ id: input.vehicleId }).lean()
  ]);
  if (!location) throw notFound('Location');
  if (!customer) throw notFound('Customer');
  if (!vehicle) throw notFound('Vehicle');
  if (!(await customerOwnsVehicle(customer.id, vehicle.id))) throw badRequest('The vehicle is not owned by this customer. Transfer ownership first.');
  if (!input.allowConcurrent) {
    const open = await RepairOrder.findOne({ vehicleId: vehicle.id, status: { $in: RO_OPEN_STATUSES } }).select('roNumber').lean();
    if (open) throw conflict(`Vehicle already has an open repair order (${open.roNumber})`, 'OPEN_RO_EXISTS', { roNumber: open.roNumber });
  }
  if (input.assignedTechId) await assertTechAtLocation(input.assignedTechId, location.id);
  if (input.bayId) await assertBayFree(location, input.bayId);
  const concerns = (input.concerns || []).filter(c => c && c.trim()).map(text => ({ id: uuid(), text: text.trim(), source: 'customer', createdBy: auth.userId }));
  if (!concerns.length) throw badRequest('Record at least one customer concern');

  const year = new Date().getUTCFullYear();
  const ro = await withTransaction(async (session) => {
    const roNumber = await nextNumber('RO', shortCode(location.code), year, session);
    const [created] = await RepairOrder.create([{
      roNumber,
      locationId: location.id,
      customerId: customer.id,
      vehicleId: vehicle.id,
      appointmentId: input.appointmentId,
      advisorId: auth.role === 'advisor' || auth.role === 'manager' ? auth.userId : input.advisorId,
      assignedTechId: input.assignedTechId,
      techIds: input.assignedTechId ? [input.assignedTechId] : [],
      bayId: input.bayId,
      priority: input.priority || 'normal',
      odometerIn: input.odometerIn,
      fuelLevel: input.fuelLevel,
      keyTag: input.keyTag,
      waiter: Boolean(input.waiter),
      transportation: input.transportation || 'unknown',
      promisedAt: input.promisedAt ? new Date(input.promisedAt) : undefined,
      preauthorizedCents: input.preauthorizedCents || 0,
      concerns,
      advisorNotes: input.advisorNotes || '',
      timeline: [timelineEvent(auth, 'checked_in', 'Vehicle checked in', true)],
      createdBy: auth.userId
    }], { session });

    const template = await InspectionTemplate.findOne({ status: 'active' }).sort({ updatedAt: -1 }).session(session).lean();
    await Inspection.create([{
      roId: created.id, vehicleId: vehicle.id, locationId: location.id,
      templateId: template?.id, templateVersion: template?.version, techId: input.assignedTechId, status: 'pending'
    }], { session });

    if (Number.isFinite(input.odometerIn)) {
      await recordMileage(req, vehicle.id, { odometer: input.odometerIn, source: 'ro_check_in', sourceRef: created.id }, session);
    }
    if (input.appointmentId) await markCheckedIn(input.appointmentId, created.id, session);

    await audit(req, {
      eventType: 'RO_CHECKED_IN', entityType: 'RepairOrder', entityId: created.id, locationId: location.id,
      action: `Opened ${roNumber} for ${vehicle.year} ${vehicle.make} ${vehicle.model}`
    }, session);
    return created;
  });

  if (input.assignedTechId) {
    await notifyUsers([input.assignedTechId], { type: 'ro_assigned', title: `Assigned ${ro.roNumber}`, body: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
  }
  return getRepairOrder(auth, ro.id);
};

const assertTechAtLocation = async (techId, locationId) => {
  const tech = await User.findOne({ id: techId, role: { $in: ['technician', 'manager'] }, status: 'active', locationIds: locationId }).lean();
  if (!tech) throw badRequest('Technician is not active at this location');
  return tech;
};

const assertBayFree = async (location, bayId, exceptRoId) => {
  if (!(location.bays || []).some(b => b.id === bayId && b.active !== false)) throw badRequest('Unknown or inactive bay');
  const filter = { locationId: location.id, bayId, status: { $in: RO_OPEN_STATUSES } };
  if (exceptRoId) filter.id = { $ne: exceptRoId };
  const occupied = await RepairOrder.findOne(filter).select('roNumber').lean();
  if (occupied) throw conflict(`Bay is occupied by ${occupied.roNumber}`, 'BAY_OCCUPIED');
};

const summarizeEstimate = async (roId) => {
  const est = await Estimate.findOne({ roId }).lean();
  if (!est) return null;
  const version = est.currentVersionId ? await EstimateVersion.findOne({ id: est.currentVersionId }).select('versionNumber totals').lean() : null;
  return {
    id: est.id, estimateNumber: est.estimateNumber, status: est.status, draftDirty: est.draftDirty,
    currentVersionNumber: est.currentVersionNumber, totals: version?.totals || null, presentedAt: est.presentedAt
  };
};

const enrichList = async (auth, ros) => {
  const ids = (key) => [...new Set(ros.map(r => r[key]).filter(Boolean))];
  const [customers, vehicles, users, estimates, invoices] = await Promise.all([
    Customer.find({ id: { $in: ids('customerId') } }).select('id name phone email').lean(),
    Vehicle.find({ id: { $in: ids('vehicleId') } }).select('id year make model vin licensePlate color mileage').lean(),
    User.find({ id: { $in: [...ids('assignedTechId'), ...ids('advisorId')] } }).select('id name role specialty').lean(),
    Estimate.find({ roId: { $in: ros.map(r => r.id) } }).select('roId status currentVersionNumber').lean(),
    Invoice.find({ roId: { $in: ros.map(r => r.id) }, status: { $ne: 'voided' } }).select('roId status paymentStatus totals balanceCents invoiceNumber').lean()
  ]);
  const by = (arr, key = 'id') => new Map(arr.map(x => [x[key], x]));
  const cm = by(customers); const vm = by(vehicles); const um = by(users); const em = by(estimates, 'roId'); const im = by(invoices, 'roId');
  return ros.map(r => ({
    ...toDTO(r),
    timeline: undefined,
    customer: cm.get(r.customerId) ? projectCustomer(auth, toDTO(cm.get(r.customerId))) : null,
    vehicle: vm.get(r.vehicleId) ? toDTO(vm.get(r.vehicleId)) : null,
    assignedTech: um.get(r.assignedTechId) ? { id: r.assignedTechId, name: um.get(r.assignedTechId).name, specialty: um.get(r.assignedTechId).specialty } : null,
    advisor: um.get(r.advisorId) ? { id: r.advisorId, name: um.get(r.advisorId).name } : null,
    estimateStatus: em.get(r.id)?.status || null,
    invoice: im.get(r.id) ? { number: im.get(r.id).invoiceNumber, status: im.get(r.id).status, paymentStatus: im.get(r.id).paymentStatus, totalCents: im.get(r.id).totals?.totalCents, balanceCents: im.get(r.id).balanceCents } : null,
    openSafetyEscalations: (r.safetyEscalations || []).filter(s => !['resolved', 'customer_declined'].includes(s.status)).length
  }));
};

export const listRepairOrders = async (auth, query) => {
  const { status, locationId, techId, customerId, vehicleId, q, open, page, limit, skip } = query;
  const filter = {};
  if (auth.role === 'customer') {
    filter.customerId = auth.customerId;
  } else {
    Object.assign(filter, locationFilter(auth));
    if (locationId) {
      assertLocation(auth, locationId);
      filter.locationId = locationId;
    }
    if (customerId) filter.customerId = customerId;
  }
  if (vehicleId) filter.vehicleId = vehicleId;
  if (status) filter.status = { $in: status.split(',') };
  else if (open === 'true') filter.status = { $in: RO_OPEN_STATUSES };
  if (techId) filter.$or = [{ assignedTechId: techId }, { techIds: techId }, { 'jobs.techId': techId }];
  if (q) filter.roNumber = new RegExp(escapeRegex(q), 'i');
  const [items, total] = await Promise.all([
    RepairOrder.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    RepairOrder.countDocuments(filter)
  ]);
  return { repairOrders: await enrichList(auth, items), pagination: paginationMeta({ page, limit }, total) };
};

export const getRepairOrder = async (auth, idOrNumber) => {
  const roDoc = await findRoForAccess(auth, idOrNumber);
  const ro = roDoc.toObject();
  const [enriched] = await enrichList(auth, [ro]);
  if (auth.role === 'customer') {
    return {
      id: ro.id, roNumber: ro.roNumber, status: ro.status, locationId: ro.locationId, vehicle: enriched.vehicle,
      concerns: ro.concerns.map(c => ({ id: c.id, text: c.text, cause: c.cause, correction: c.correction })),
      promisedAt: ro.promisedAt, createdAt: ro.createdAt, closedAt: ro.closedAt,
      timeline: ro.timeline.filter(t => t.customerVisible).map(t => ({ at: t.at, summary: t.summary })),
      jobs: ro.jobs.map(j => ({ title: j.title, status: j.status })),
      estimate: await summarizeEstimate(ro.id),
      invoice: enriched.invoice,
      safetyEscalations: ro.safetyEscalations.filter(s => s.customerNotifiedAt).map(s => ({ id: s.id, severity: s.severity, description: s.description, status: s.status }))
    };
  }
  const [inspection, findingsSummary, diagnostic, partRequests, reservations, timeAgg, estimate] = await Promise.all([
    Inspection.findOne({ roId: ro.id }).sort({ createdAt: -1 }).lean(),
    Finding.aggregate([{ $match: { roId: ro.id, status: 'active' } }, { $group: { _id: '$condition', n: { $sum: 1 } } }]),
    DiagnosticSession.findOne({ roId: ro.id }).sort({ createdAt: -1 }).select('id status dtcs scans conclusion verification').lean(),
    PartRequest.find({ roId: ro.id }).sort({ createdAt: -1 }).lean(),
    Reservation.find({ roId: ro.id, status: { $ne: 'released' } }).lean(),
    TimeEntry.aggregate([{ $match: { roId: ro.id, status: 'closed' } }, { $group: { _id: '$techId', minutes: { $sum: '$minutes' } } }]),
    summarizeEstimate(ro.id)
  ]);
  const findingCounts = Object.fromEntries(findingsSummary.map(f => [f._id, f.n]));
  return {
    ...enriched,
    timeline: ro.timeline,
    inspection: inspection ? { ...toDTO(inspection), findingCounts } : null,
    diagnostic: diagnostic ? {
      id: diagnostic.id, status: diagnostic.status,
      activeDtcs: (diagnostic.dtcs || []).filter(d => d.status !== 'cleared').map(d => ({ code: d.code, description: d.description, source: d.source })),
      scans: (diagnostic.scans || []).length, conclusion: diagnostic.conclusion, verification: diagnostic.verification
    } : null,
    estimate,
    partRequests: toDTO(partRequests),
    reservations: toDTO(reservations),
    clockedMinutesByTech: Object.fromEntries(timeAgg.map(t => [t._id, t.minutes]))
  };
};

const guardTransition = async (ro, to) => {
  if (to === 'in_progress') {
    if (!ro.jobs.some(j => ['authorized', 'in_progress', 'paused'].includes(j.status))) {
      throw unprocessable('No authorized work. Get customer approval before starting work.', undefined, 'NO_AUTHORIZED_WORK');
    }
  }
  if (to === 'quality_check') {
    const pending = ro.jobs.filter(j => !['completed', 'verified', 'cancelled'].includes(j.status));
    if (pending.length) throw unprocessable(`Complete all jobs before QC (${pending.length} remaining)`, undefined, 'JOBS_INCOMPLETE');
  }
};

export const changeStatus = async (req, idOrNumber, { status, reason }, expected) => {
  const ro = await findRoForAccess(req.auth, idOrNumber);
  if (status === 'cancelled') return cancelRepairOrder(req, ro.id, { reason });
  const allowed = TRANSITIONS[ro.status] || [];
  if (!allowed.includes(status)) throw conflict(`Cannot move ${ro.roNumber} from ${ro.status} to ${status}`, 'INVALID_TRANSITION', { allowed });
  if (ro.status === 'ready_for_pickup' && status === 'in_progress') {
    if (!can(req.auth, 'ros:override')) throw forbidden('Reopening work after QC requires a manager');
    if (!reason) throw badRequest('A reason is required to reopen work');
  }
  await guardTransition(ro, status);
  const filter = { id: ro.id, status: ro.status };
  if (expected !== undefined) filter.__v = expected;
  const updated = await RepairOrder.findOneAndUpdate(filter, {
    $set: { status, ...(status === 'in_progress' && ro.status === 'quality_check' ? { 'qc.status': 'failed' } : {}) },
    $inc: { __v: 1 },
    $push: { timeline: timelineEvent(req.auth, 'status', `Status: ${ro.status} → ${status}${reason ? ` (${reason})` : ''}`, ['in_progress', 'waiting_parts', 'quality_check'].includes(status)) }
  }, { new: true });
  if (!updated) throw conflict('The repair order changed while you were editing. Reload and try again.', 'VERSION_CONFLICT');
  await audit(req, { eventType: 'RO_STATUS_CHANGED', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId, action: `${ro.roNumber}: ${ro.status} -> ${status}`, reason });
  return getRepairOrder(req.auth, ro.id);
};

export const dispatch = async (req, idOrNumber, { assignedTechId, bayId, promisedAt, priority }) => {
  const ro = await findRoForAccess(req.auth, idOrNumber);
  if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Closed or cancelled repair orders cannot be dispatched');
  const location = await Location.findOne({ id: ro.locationId }).lean();
  const set = {};
  const notes = [];
  if (assignedTechId !== undefined) {
    if (assignedTechId) {
      const tech = await assertTechAtLocation(assignedTechId, ro.locationId);
      set.assignedTechId = assignedTechId;
      notes.push(`technician ${tech.name}`);
    } else {
      set.assignedTechId = null;
      notes.push('technician unassigned');
    }
  }
  if (bayId !== undefined) {
    if (bayId) await assertBayFree(location, bayId, ro.id);
    set.bayId = bayId || null;
    notes.push(bayId ? `bay ${(location.bays.find(b => b.id === bayId) || {}).name || bayId}` : 'bay released');
  }
  if (promisedAt !== undefined) {
    set.promisedAt = promisedAt ? new Date(promisedAt) : null;
    notes.push('promise time updated');
  }
  if (priority) set.priority = priority;
  const update = { $set: set, $inc: { __v: 1 }, $push: { timeline: timelineEvent(req.auth, 'dispatch', `Dispatch: ${notes.join(', ')}`) } };
  if (set.assignedTechId) update.$addToSet = { techIds: set.assignedTechId };
  await RepairOrder.updateOne({ id: ro.id }, update);
  if (set.assignedTechId) {
    await Inspection.updateMany({ roId: ro.id, status: { $ne: 'completed' }, techId: null }, { $set: { techId: set.assignedTechId } });
    await notifyUsers([set.assignedTechId], { type: 'ro_assigned', title: `Assigned ${ro.roNumber}`, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
  }
  await audit(req, { eventType: 'RO_DISPATCHED', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId, action: `${ro.roNumber} dispatch: ${notes.join(', ')}` });
  return getRepairOrder(req.auth, ro.id);
};

export const addConcern = async (req, idOrNumber, { text, source }) => {
  const ro = await findRoForAccess(req.auth, idOrNumber);
  if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Repair order is closed');
  const concern = { id: uuid(), text: text.trim(), source: source || (req.auth.role === 'technician' ? 'technician' : 'advisor'), createdBy: req.auth.userId };
  await RepairOrder.updateOne({ id: ro.id }, { $push: { concerns: concern, timeline: timelineEvent(req.auth, 'concern', `Concern added: ${concern.text}`) }, $inc: { __v: 1 } });
  return getRepairOrder(req.auth, ro.id);
};

export const updateConcern = async (req, idOrNumber, concernId, { cause, correction }) => {
  const ro = await findRoForAccess(req.auth, idOrNumber);
  if (!ro.concerns.some(c => c.id === concernId)) throw notFound('Concern');
  const set = {};
  if (cause !== undefined) set['concerns.$.cause'] = cause;
  if (correction !== undefined) set['concerns.$.correction'] = correction;
  await RepairOrder.updateOne({ id: ro.id, 'concerns.id': concernId }, { $set: set, $inc: { __v: 1 } });
  return getRepairOrder(req.auth, ro.id);
};

// ---------------------------------------------------------------------------
// Safety escalation
// ---------------------------------------------------------------------------
export const raiseSafetyEscalation = async (req, idOrNumber, { severity, description, findingId }) => {
  const ro = await findRoForAccess(req.auth, idOrNumber);
  if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Repair order is closed');
  if (findingId && !(await Finding.exists({ id: findingId, roId: ro.id }))) throw badRequest('Finding does not belong to this repair order');
  const esc = { id: uuid(), severity, description, findingId, raisedBy: req.auth.userId, raisedAt: new Date(), status: 'open' };
  await RepairOrder.updateOne({ id: ro.id }, { $push: { safetyEscalations: esc, timeline: timelineEvent(req.auth, 'safety', `Safety escalation (${severity}): ${description}`) }, $inc: { __v: 1 } });
  await audit(req, { eventType: 'SAFETY_ESCALATION_RAISED', category: 'safety', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId, action: `${severity.toUpperCase()} safety escalation on ${ro.roNumber}: ${description}` });
  await notifyRoles(ro.locationId, ['manager', 'advisor'], {
    type: 'safety_escalation', severity: 'critical', title: `Safety escalation on ${ro.roNumber}`, body: description,
    link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id, dedupeKey: `safety:${esc.id}`
  });
  return getRepairOrder(req.auth, ro.id);
};

export const updateSafetyEscalation = async (req, idOrNumber, escalationId, input) => {
  const ro = await findRoForAccess(req.auth, idOrNumber);
  const esc = ro.safetyEscalations.find(s => s.id === escalationId);
  if (!esc) throw notFound('Safety escalation');
  if (esc.status === 'resolved') throw conflict('This escalation is already resolved');
  const set = {};
  let summary;
  switch (input.action) {
    case 'acknowledge':
      Object.assign(set, { 'safetyEscalations.$.status': 'acknowledged', 'safetyEscalations.$.acknowledgedBy': req.auth.userId, 'safetyEscalations.$.acknowledgedAt': new Date() });
      summary = 'acknowledged';
      break;
    case 'customer_notified':
      if (!input.method) throw badRequest('Record how the customer was notified');
      Object.assign(set, { 'safetyEscalations.$.status': 'customer_notified', 'safetyEscalations.$.customerNotifiedBy': req.auth.userId, 'safetyEscalations.$.customerNotifiedAt': new Date(), 'safetyEscalations.$.customerNotificationMethod': input.method });
      summary = `customer notified by ${input.method}`;
      break;
    case 'customer_decision':
      if (!esc.customerNotifiedAt) throw unprocessable('Record the customer notification before their decision');
      if (!['repair', 'declined'].includes(input.decision)) throw badRequest('decision must be repair or declined');
      if (input.decision === 'declined' && !input.signatureEvidenceId && !input.note) {
        throw badRequest('A declined safety repair needs a signed waiver or a documented note of the conversation');
      }
      Object.assign(set, {
        'safetyEscalations.$.status': input.decision === 'repair' ? 'repair_authorized' : 'customer_declined',
        'safetyEscalations.$.customerDecision': { decision: input.decision, recordedBy: req.auth.userId, at: new Date(), signatureEvidenceId: input.signatureEvidenceId, note: input.note }
      });
      summary = `customer ${input.decision === 'repair' ? 'chose repair' : 'DECLINED the safety repair'}`;
      break;
    case 'resolve':
      if (!input.resolution) throw badRequest('Describe how the escalation was resolved');
      Object.assign(set, { 'safetyEscalations.$.status': 'resolved', 'safetyEscalations.$.resolution': input.resolution, 'safetyEscalations.$.resolvedBy': req.auth.userId, 'safetyEscalations.$.resolvedAt': new Date() });
      summary = `resolved: ${input.resolution}`;
      break;
    default:
      throw badRequest('Unknown action');
  }
  await RepairOrder.updateOne({ id: ro.id, 'safetyEscalations.id': escalationId }, {
    $set: set, $inc: { __v: 1 },
    $push: { timeline: timelineEvent(req.auth, 'safety', `Safety escalation ${summary}`) }
  });
  await audit(req, { eventType: 'SAFETY_ESCALATION_UPDATED', category: 'safety', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId, action: `${ro.roNumber} safety escalation ${summary}`, reason: input.note });
  return getRepairOrder(req.auth, ro.id);
};

// ---------------------------------------------------------------------------
// Quality control, closing, cancelling
// ---------------------------------------------------------------------------
export const recordQualityControl = async (req, idOrNumber, { checklist, roadTestPerformed, passed, notes }) => {
  const ro = await findRoForAccess(req.auth, idOrNumber);
  if (ro.status !== 'quality_check') throw conflict('Move the repair order to quality check first', 'INVALID_STATE');
  if (!checklist?.length) throw badRequest('QC checklist results are required');
  const allPassed = checklist.every(c => c.passed);
  if (passed && !allPassed) throw badRequest('QC cannot pass while checklist items failed');
  const openSafety = ro.safetyEscalations.filter(s => !['resolved', 'customer_declined', 'repair_authorized'].includes(s.status));
  if (passed && openSafety.length) throw unprocessable('Resolve or document all safety escalations before releasing the vehicle', undefined, 'OPEN_SAFETY_ESCALATION');
  const selfInspected = ro.jobs.length > 0 && ro.jobs.every(j => j.techId === req.auth.userId);
  const nextStatus = passed ? 'ready_for_pickup' : 'in_progress';
  const updated = await RepairOrder.findOneAndUpdate({ id: ro.id, status: 'quality_check' }, {
    $set: {
      status: nextStatus,
      qc: { status: passed ? 'passed' : 'failed', checklist, roadTestPerformed: Boolean(roadTestPerformed), inspectedBy: req.auth.userId, at: new Date(), notes },
      ...(passed ? Object.fromEntries(ro.jobs.map((j, i) => [`jobs.${i}.status`, j.status === 'completed' ? 'verified' : j.status])) : {})
    },
    $inc: { __v: 1 },
    $push: { timeline: timelineEvent(req.auth, 'qc', passed ? 'Quality check passed — ready for pickup' : `Quality check failed: ${notes || 'see checklist'}`, passed) }
  }, { new: true });
  if (!updated) throw conflict('Repair order changed; reload and try again');
  await audit(req, {
    eventType: passed ? 'QC_PASSED' : 'QC_FAILED', category: selfInspected ? 'override' : 'operational', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId,
    action: `QC ${passed ? 'passed' : 'failed'} on ${ro.roNumber}${selfInspected ? ' (inspected by the technician who performed the work)' : ''}`
  });
  if (passed && ro.advisorId) {
    await notifyUsers([ro.advisorId], { type: 'ro_ready', title: `${ro.roNumber} ready for pickup`, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
  }
  return getRepairOrder(req.auth, ro.id);
};

export const closeRepairOrder = async (req, idOrNumber, { odometerOut, overrideReason }) => {
  const ro = await findRoForAccess(req.auth, idOrNumber);
  if (ro.status !== 'ready_for_pickup') throw conflict('Only vehicles that passed QC can be closed', 'INVALID_STATE');
  const invoice = await Invoice.findOne({ roId: ro.id, status: 'posted' }).lean();
  if (!invoice) throw unprocessable('Post the invoice before closing the repair order', undefined, 'INVOICE_NOT_POSTED');
  const settled = ['paid', 'overpaid', 'written_off'].includes(invoice.paymentStatus) || invoice.balanceCents <= 0;
  if (!settled) {
    if (!overrideReason || !can(req.auth, 'ros:override')) {
      throw unprocessable('The invoice has an open balance. A manager can release the vehicle on account with a reason.', undefined, 'BALANCE_DUE');
    }
  }
  await withTransaction(async (session) => {
    if (Number.isFinite(odometerOut)) await recordMileage(req, ro.vehicleId, { odometer: odometerOut, source: 'ro_check_out', sourceRef: ro.id }, session);
    const res = await RepairOrder.updateOne({ id: ro.id, status: 'ready_for_pickup' }, {
      $set: { status: 'closed', closedAt: new Date(), closedBy: req.auth.userId, odometerOut, bayId: null },
      $inc: { __v: 1 },
      $push: { timeline: timelineEvent(req.auth, 'closed', 'Vehicle released to customer', true) }
    }, { session });
    if (res.modifiedCount !== 1) throw conflict('Repair order changed; reload and try again');
    if (ro.appointmentId) {
      await Appointment.updateOne({ id: ro.appointmentId, status: 'checked_in' }, { $set: { status: 'completed' } }, { session });
    }
    await audit(req, {
      eventType: 'RO_CLOSED', category: settled ? 'operational' : 'override', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId,
      action: `Closed ${ro.roNumber}${settled ? '' : ` with open balance ${invoice.balanceCents} cents`}`, reason: overrideReason
    }, session);
  });
  const { enqueueJob } = await import('./jobService.js');
  await enqueueJob('ro.closed', { roId: ro.id }, `ro.closed:${ro.id}`);
  return getRepairOrder(req.auth, ro.id);
};

export const cancelRepairOrder = async (req, roId, { reason }) => {
  const ro = await findRoForAccess(req.auth, roId);
  if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Repair order is already closed or cancelled');
  if (!reason) throw badRequest('A cancellation reason is required');
  if (await Invoice.exists({ roId: ro.id, status: 'posted' })) throw unprocessable('A posted invoice exists. Issue a credit memo instead of cancelling.', undefined, 'INVOICE_POSTED');
  if (ro.jobs.some(j => ['in_progress', 'completed', 'verified'].includes(j.status)) && !can(req.auth, 'ros:override')) {
    throw forbidden('Work has been performed; only a manager can cancel this repair order');
  }
  const { releaseReservationsForRo } = await import('./inventoryService.js');
  await withTransaction(async (session) => {
    await releaseReservationsForRo(req, ro.id, 'repair_order_cancelled', session);
    await PartRequest.updateMany({ roId: ro.id, status: { $in: ['requested', 'sourcing'] } }, { $set: { status: 'cancelled' } }, { session });
    await TimeEntry.updateMany({ roId: ro.id, status: 'open' }, [{ $set: { status: 'closed', endAt: '$$NOW', minutes: { $round: [{ $divide: [{ $subtract: ['$$NOW', '$startAt'] }, 60000] }, 0] } } }], { session });
    await RepairOrder.updateOne({ id: ro.id }, {
      $set: { status: 'cancelled', cancelledReason: reason, closedAt: new Date(), closedBy: req.auth.userId, bayId: null },
      $inc: { __v: 1 },
      $push: { timeline: timelineEvent(req.auth, 'cancelled', `Cancelled: ${reason}`, true) }
    }, { session });
    await audit(req, { eventType: 'RO_CANCELLED', category: 'operational', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId, action: `Cancelled ${ro.roNumber}`, reason }, session);
  });
  return getRepairOrder(req.auth, ro.id);
};

export { pushTimeline };
