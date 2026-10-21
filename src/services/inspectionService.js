import { withTransaction } from '../config/db.js';
import { Inspection, InspectionTemplate, Finding, RepairOrder, Evidence } from '../models/index.js';
import { RO_OPEN_STATUSES } from '../models/operations.js';
import { audit } from './audit.js';
import { timelineEvent } from './roService.js';
import { notifyUsers } from './notificationService.js';
import { findRoForAccess, isAdmin } from '../security/access.js';
import { notFound, badRequest, conflict, unprocessable, versionConflict, forbidden } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';

// ---------------------------------------------------------------------------
// Templates (versioned; editing creates a new version and retires the old one)
// ---------------------------------------------------------------------------
export const listTemplates = async ({ includeRetired } = {}) =>
  toDTO(await InspectionTemplate.find(includeRetired ? {} : { status: 'active' }).sort({ name: 1, version: -1 }).lean());

export const saveTemplate = async (req, { templateId, name, sections }) => {
  const normalized = sections.map(s => ({
    key: s.key || uuid(),
    name: s.name,
    items: s.items.map(i => ({ key: i.key || uuid(), name: i.name, measurementHints: i.measurementHints || [] }))
  }));
  const created = await withTransaction(async (session) => {
    let version = 1;
    if (templateId) {
      const current = await InspectionTemplate.findOne({ id: templateId }).session(session);
      if (!current) throw notFound('Inspection template');
      version = current.version + 1;
      await InspectionTemplate.updateMany({ name: current.name, status: 'active' }, { $set: { status: 'retired' } }, { session });
    }
    const [tpl] = await InspectionTemplate.create([{ name, version, sections: normalized, createdBy: req.auth.userId }], { session });
    await audit(req, { eventType: 'INSPECTION_TEMPLATE_SAVED', category: 'data', entityType: 'InspectionTemplate', entityId: tpl.id, action: `Saved inspection template ${name} v${version}` }, session);
    return tpl;
  });
  return toDTO(created);
};

// ---------------------------------------------------------------------------
// Inspection + findings
// ---------------------------------------------------------------------------
const loadInspection = async (roId, session = null) => {
  const insp = await Inspection.findOne({ roId }).sort({ createdAt: -1 }).session(session);
  if (!insp) throw notFound('Inspection');
  return insp;
};

export const getInspection = async (auth, roIdOrNumber) => {
  const ro = await findRoForAccess(auth, roIdOrNumber);
  const insp = await loadInspection(ro.id);
  const isCustomer = auth.role === 'customer';
  const [template, findings, evidence] = await Promise.all([
    insp.templateId ? InspectionTemplate.findOne({ id: insp.templateId }).lean() : null,
    Finding.find({ inspectionId: insp.id, ...(isCustomer ? { status: 'active', locked: true } : {}) }).sort({ createdAt: 1 }).lean(),
    Evidence.find({ roId: ro.id, ...(isCustomer ? { visibility: 'customer', status: 'current' } : {}) })
      .select('id kind contentType caption findingId capturedAt capturedByName status supersededById visibility').lean()
  ]);
  if (isCustomer && insp.status !== 'completed') {
    return { inspection: { id: insp.id, status: insp.status }, findings: [], evidence: [] };
  }
  return {
    inspection: toDTO(insp.toObject()),
    template: template ? toDTO(template) : null,
    findings: toDTO(findings),
    evidence: toDTO(evidence)
  };
};

export const startInspection = async (req, roIdOrNumber) => {
  const ro = await findRoForAccess(req.auth, roIdOrNumber);
  if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Repair order is closed');
  const insp = await loadInspection(ro.id);
  if (insp.status === 'completed') throw conflict('Inspection is already completed');
  await withTransaction(async (session) => {
    await Inspection.updateOne({ id: insp.id, status: { $ne: 'completed' } }, {
      $set: { status: 'in_progress', startedAt: insp.startedAt || new Date(), techId: insp.techId || req.auth.userId }
    }, { session });
    if (ro.status === 'checked_in') {
      await RepairOrder.updateOne({ id: ro.id, status: 'checked_in' }, {
        $set: { status: 'inspecting' }, $inc: { __v: 1 },
        $push: { timeline: timelineEvent(req.auth, 'inspection', 'Inspection started', true) }
      }, { session });
    }
  });
  return getInspection(req.auth, ro.id);
};

const validateCondition = ({ condition, severity }) => {
  if (condition === 'fail' && !['safety', 'repair'].includes(severity)) throw badRequest('Failed items need a severity of safety or repair');
  if (condition === 'attention' && !['repair', 'maintenance', 'monitor'].includes(severity)) throw badRequest('Attention items need a severity of repair, maintenance or monitor');
  if (['ok', 'not_inspected'].includes(condition) && severity) throw badRequest('Only failed or attention items carry a severity');
};

export const saveFinding = async (req, roIdOrNumber, input, expected) => {
  const ro = await findRoForAccess(req.auth, roIdOrNumber);
  const insp = await loadInspection(ro.id);
  if (insp.status === 'completed') throw conflict('Inspection is completed and findings are locked. Submit a correction instead.', 'FINDINGS_LOCKED');
  validateCondition(input);
  const fields = {
    category: input.category || 'General',
    name: input.name,
    condition: input.condition,
    severity: input.severity || null,
    notes: input.notes || '',
    recommendation: input.recommendation || '',
    measurements: input.measurements || [],
    updatedBy: req.auth.userId
  };

  let finding;
  if (input.findingId) {
    const filter = { id: input.findingId, inspectionId: insp.id, locked: false, status: 'active' };
    if (expected !== undefined) filter.__v = expected;
    finding = await Finding.findOneAndUpdate(filter, { $set: fields, $inc: { __v: 1 } }, { new: true }).lean();
    if (!finding) {
      const exists = await Finding.findOne({ id: input.findingId }).lean();
      if (!exists) throw notFound('Finding');
      if (exists.locked) throw conflict('Finding is locked', 'FINDINGS_LOCKED');
      throw versionConflict('Finding');
    }
  } else {
    if (input.itemKey && await Finding.exists({ inspectionId: insp.id, itemKey: input.itemKey, status: 'active' })) {
      throw conflict('This checklist item already has a finding; update it instead', 'DUPLICATE_FINDING');
    }
    finding = (await Finding.create({
      ...fields, inspectionId: insp.id, roId: ro.id, vehicleId: ro.vehicleId, locationId: ro.locationId,
      itemKey: input.itemKey, createdBy: req.auth.userId
    })).toObject();
  }
  if (insp.status === 'pending') {
    await Inspection.updateOne({ id: insp.id, status: 'pending' }, { $set: { status: 'in_progress', startedAt: new Date(), techId: insp.techId || req.auth.userId } });
  }
  if (input.condition === 'fail' && input.severity === 'safety' && input.raiseEscalation) {
    const { raiseSafetyEscalation } = await import('./roService.js');
    await raiseSafetyEscalation(req, ro.id, { severity: 'critical', description: `${finding.name}: ${finding.notes || 'safety failure'}`, findingId: finding.id });
  }
  return toDTO(finding);
};

export const completeInspection = async (req, roIdOrNumber) => {
  const ro = await findRoForAccess(req.auth, roIdOrNumber);
  const insp = await loadInspection(ro.id);
  if (insp.status === 'completed') throw conflict('Inspection already completed');
  const findings = await Finding.find({ inspectionId: insp.id, status: 'active' }).lean();
  if (!findings.length) throw unprocessable('Record at least one finding before completing the inspection');
  const unexplained = findings.filter(f => f.condition === 'not_inspected' && !f.notes);
  if (unexplained.length) throw unprocessable(`Explain why ${unexplained.length} item(s) were not inspected`, { items: unexplained.map(f => f.name) });

  const summary = {
    pass: findings.filter(f => f.condition === 'ok').length,
    attention: findings.filter(f => f.condition === 'attention').length,
    fail: findings.filter(f => f.condition === 'fail').length,
    notInspected: findings.filter(f => f.condition === 'not_inspected').length
  };
  const now = new Date();
  await withTransaction(async (session) => {
    const res = await Inspection.updateOne({ id: insp.id, status: { $ne: 'completed' } }, { $set: { status: 'completed', completedAt: now, completedBy: req.auth.userId, summary } }, { session });
    if (res.modifiedCount !== 1) throw conflict('Inspection was completed concurrently');
    await Finding.updateMany({ inspectionId: insp.id, status: 'active', locked: false }, { $set: { locked: true, lockedAt: now, lockedBy: req.auth.userId } }, { session });
    await RepairOrder.updateOne({ id: ro.id }, {
      $inc: { __v: 1 },
      $push: { timeline: timelineEvent(req.auth, 'inspection', `Inspection completed: ${summary.fail} fail, ${summary.attention} attention, ${summary.pass} ok`, true) }
    }, { session });
    await audit(req, {
      eventType: 'INSPECTION_LOCKED', category: 'data', entityType: 'Inspection', entityId: insp.id, locationId: ro.locationId,
      action: `Inspection for ${ro.roNumber} completed and ${findings.length} findings locked (${summary.fail} fail / ${summary.attention} attention / ${summary.pass} ok)`
    }, session);
  });
  if (ro.advisorId) {
    await notifyUsers([ro.advisorId], { type: 'inspection_complete', title: `Inspection complete on ${ro.roNumber}`, body: `${summary.fail} failed, ${summary.attention} need attention`, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
  }
  return getInspection(req.auth, ro.id);
};

// Locked findings are never edited. A correction is a new locked finding that
// supersedes the original, with the reason recorded in the audit history.
export const correctFinding = async (req, findingId, input) => {
  const original = await Finding.findOne({ id: findingId }).lean();
  if (!original) throw notFound('Finding');
  await findRoForAccess(req.auth, original.roId);
  if (!original.locked) throw badRequest('Unlocked findings can be edited directly');
  if (original.status === 'superseded') throw conflict('This finding was already corrected; correct the latest version', 'ALREADY_SUPERSEDED');
  if (!input.reason) throw badRequest('A correction reason is required');
  const next = {
    condition: input.condition ?? original.condition,
    severity: input.severity !== undefined ? input.severity : original.severity,
    notes: input.notes ?? original.notes,
    recommendation: input.recommendation ?? original.recommendation,
    measurements: input.measurements ?? original.measurements
  };
  validateCondition(next);
  const created = await withTransaction(async (session) => {
    const [correction] = await Finding.create([{
      inspectionId: original.inspectionId, roId: original.roId, vehicleId: original.vehicleId, locationId: original.locationId,
      itemKey: original.itemKey, category: original.category, name: original.name, ...next,
      evidenceIds: original.evidenceIds, customerDecision: original.customerDecision,
      locked: true, lockedAt: new Date(), lockedBy: req.auth.userId,
      supersedesId: original.id, correctionReason: input.reason, createdBy: req.auth.userId
    }], { session });
    const res = await Finding.updateOne({ id: original.id, status: 'active' }, { $set: { status: 'superseded', supersededById: correction.id } }, { session });
    if (res.modifiedCount !== 1) throw conflict('Finding was corrected concurrently');
    await audit(req, {
      eventType: 'FINDING_CORRECTED', category: 'override', entityType: 'Finding', entityId: original.id, locationId: original.locationId,
      action: `Correction addendum for "${original.name}" on locked inspection`, reason: input.reason,
      before: { condition: original.condition, severity: original.severity, notes: original.notes },
      after: { condition: next.condition, severity: next.severity, notes: next.notes }
    }, session);
    return correction;
  });
  return toDTO(created.toObject());
};

export const findingHistory = async (auth, findingId) => {
  const finding = await Finding.findOne({ id: findingId }).lean();
  if (!finding) throw notFound('Finding');
  await findRoForAccess(auth, finding.roId);
  const chain = [finding];
  let cursor = finding;
  while (cursor?.supersedesId) {
    cursor = await Finding.findOne({ id: cursor.supersedesId }).lean();
    if (cursor) chain.push(cursor);
  }
  cursor = finding;
  while (cursor?.supersededById) {
    cursor = await Finding.findOne({ id: cursor.supersededById }).lean();
    if (cursor) chain.unshift(cursor);
  }
  return toDTO(chain);
};

export const assertCanManageTemplates = (auth) => {
  if (!isAdmin(auth) && auth.role !== 'manager') throw forbidden();
};
