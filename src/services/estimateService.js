import { withTransaction } from '../config/db.js';
import {
  Estimate, EstimateVersion, Approval, RepairOrder, Location, Customer, Finding, PredictiveSignal, Reservation, Evidence
} from '../models/index.js';
import { RO_OPEN_STATUSES } from '../models/operations.js';
import { audit } from './audit.js';
import { nextNumber, shortCode } from './sequence.js';
import { priceLines, lineHash } from './pricingService.js';
import { timelineEvent } from './roService.js';
import { notifyRoles, notifyUsers } from './notificationService.js';
import { findRoForAccess, can } from '../security/access.js';
import { notFound, badRequest, conflict, unprocessable, versionConflict, forbidden } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';
import { uuid, hashCanonical } from '../lib/crypto.js';

const PRE_APPROVAL_STATUSES = ['checked_in', 'inspecting', 'diagnosing', 'awaiting_approval'];

const ensureEstimate = async (ro, location, session) => {
  const existing = await Estimate.findOne({ roId: ro.id }).session(session);
  if (existing) return existing;
  const number = await nextNumber('EST', shortCode(location.code), new Date().getUTCFullYear(), session);
  const [created] = await Estimate.create([{
    estimateNumber: number, roId: ro.id, customerId: ro.customerId, vehicleId: ro.vehicleId,
    locationId: ro.locationId, currency: location.currency || 'USD'
  }], { session });
  await RepairOrder.updateOne({ id: ro.id }, { $set: { estimateId: created.id } }, { session });
  return created;
};

/**
 * Effective decision per line of a version: the most recent approval decision
 * whose recorded line hash matches the line's current content. A line whose
 * content changed since it was approved is "pending" again.
 */
export const lineAuthorization = async (estimateId, version, session = null) => {
  const approvals = await Approval.find({ estimateId }).sort({ at: 1 }).session(session).lean();
  const hashes = version.lineHashes instanceof Map ? Object.fromEntries(version.lineHashes) : (version.lineHashes || {});
  const result = new Map();
  for (const line of version.lines) {
    result.set(line.id, { status: 'pending', lineHash: hashes[line.id] });
  }
  for (const approval of approvals) {
    for (const d of approval.decisions) {
      const current = result.get(d.lineId);
      if (current && d.lineHash === current.lineHash) {
        result.set(d.lineId, { status: d.decision, lineHash: d.lineHash, approvalId: approval.id, decidedAt: approval.at, method: approval.method, approverName: approval.approverName, declineReason: d.declineReason });
      }
    }
  }
  return result;
};

export const authorizedLinesForRo = async (roId, session = null) => {
  const estimate = await Estimate.findOne({ roId }).session(session).lean();
  if (!estimate?.currentVersionId) return { estimate, version: null, lines: [] };
  const version = await EstimateVersion.findOne({ id: estimate.currentVersionId }).session(session).lean();
  const auth = await lineAuthorization(estimate.id, version, session);
  return {
    estimate,
    version,
    authorization: auth,
    lines: version.lines.filter(l => auth.get(l.id)?.status === 'approved').map(l => ({ ...l, approvalId: auth.get(l.id).approvalId }))
  };
};

const summarizeVersion = (v) => ({
  id: v.id, versionNumber: v.versionNumber, reason: v.reason, changeSummary: v.changeSummary,
  totals: v.totals, createdAt: v.createdAt, createdByName: v.createdByName, contentHash: v.contentHash
});

export const getEstimate = async (auth, roIdOrNumber) => {
  const ro = await findRoForAccess(auth, roIdOrNumber);
  const estimate = await Estimate.findOne({ roId: ro.id }).lean();
  if (!estimate) return { estimate: null, currentVersion: null, versions: [], approvals: [], authorization: {} };
  const isCustomer = auth.role === 'customer';
  if (isCustomer && !estimate.presentedVersionId) return { estimate: null, currentVersion: null, versions: [], approvals: [], authorization: {} };

  const [versions, approvals] = await Promise.all([
    EstimateVersion.find({ estimateId: estimate.id }).sort({ versionNumber: -1 }).lean(),
    Approval.find({ estimateId: estimate.id }).sort({ at: -1 }).lean()
  ]);
  const visibleVersionId = isCustomer ? estimate.presentedVersionId : estimate.currentVersionId;
  const current = versions.find(v => v.id === visibleVersionId) || null;
  const authorization = current ? Object.fromEntries(await lineAuthorization(estimate.id, current)) : {};

  let draftPreview = null;
  if (!isCustomer && estimate.draftLines.length && estimate.draftDirty) {
    const location = await Location.findOne({ id: ro.locationId }).lean();
    try {
      const priced = await priceLines({ location, ro, lines: estimate.draftLines });
      draftPreview = { lines: priced.lines, totals: priced.totals, membershipEvaluation: priced.membershipEvaluation };
    } catch (err) {
      draftPreview = { error: err.message };
    }
  }

  // Customer-facing finding context (only locked, active findings)
  const findingIds = [...new Set((current?.lines || []).flatMap(l => l.findingIds || []))];
  const findings = findingIds.length
    ? await Finding.find({ id: { $in: findingIds }, ...(isCustomer ? { locked: true } : {}) }).select('id name condition severity notes recommendation evidenceIds status supersededById').lean()
    : [];

  return {
    estimate: { ...toDTO(estimate), draftLines: isCustomer ? undefined : estimate.draftLines, lines: undefined, summary: undefined },
    currentVersion: current ? toDTO(current) : null,
    canApprove: Boolean(current) && estimate.presentedVersionId === estimate.currentVersionId,
    versions: versions.map(summarizeVersion),
    approvals: toDTO(approvals).map(a => (isCustomer ? { ...a, ip: undefined, userAgent: undefined } : a)),
    authorization,
    findings: toDTO(findings),
    draftPreview
  };
};

const normalizeDraftLine = (line, index) => ({
  id: line.id || uuid(),
  kind: line.kind,
  jobGroup: (line.jobGroup || '').trim(),
  description: line.description?.trim() || '',
  laborOpCode: line.laborOpCode ? line.laborOpCode.toUpperCase() : undefined,
  hours: line.hours,
  laborRateType: line.laborRateType,
  rateCents: line.rateCents,
  partId: line.partId,
  partNumber: line.partNumber,
  quantity: line.quantity,
  unitPriceCents: line.unitPriceCents,
  unitCostCents: line.unitCostCents,
  feeCode: line.feeCode ? line.feeCode.toUpperCase() : undefined,
  findingIds: line.findingIds || [],
  predictiveSignalId: line.predictiveSignalId,
  safetyCritical: Boolean(line.safetyCritical),
  recommendationReason: line.recommendationReason || '',
  sortOrder: line.sortOrder ?? index
});

export const saveDraft = async (req, roIdOrNumber, { lines }, expected) => {
  const ro = await findRoForAccess(req.auth, roIdOrNumber);
  if (!RO_OPEN_STATUSES.includes(ro.status) || ['ready_for_pickup'].includes(ro.status)) throw conflict('Estimate can no longer be changed for this repair order');
  const location = await Location.findOne({ id: ro.locationId }).lean();
  const normalized = lines.map(normalizeDraftLine);
  const ids = new Set();
  for (const l of normalized) {
    if (ids.has(l.id)) throw badRequest('Duplicate line id');
    ids.add(l.id);
    if (!l.description && l.kind !== 'fee') throw badRequest('Every line needs a description');
  }
  const findingIds = [...new Set(normalized.flatMap(l => l.findingIds))];
  if (findingIds.length && (await Finding.countDocuments({ id: { $in: findingIds }, roId: ro.id })) !== findingIds.length) {
    throw badRequest('Lines may only reference findings from this repair order');
  }
  // Pricing must succeed before the draft is accepted (catches missing rates/prices early).
  await priceLines({ location, ro, lines: normalized });

  const estimate = await withTransaction(async (session) => {
    const est = await ensureEstimate(ro, location, session);
    const filter = { id: est.id };
    if (expected !== undefined) filter.__v = expected;
    const updated = await Estimate.findOneAndUpdate(filter, { $set: { draftLines: normalized, draftDirty: true }, $inc: { __v: 1 } }, { new: true, session });
    if (!updated) throw versionConflict('Estimate');
    return updated;
  });
  await audit(req, { eventType: 'ESTIMATE_DRAFT_SAVED', entityType: 'Estimate', entityId: estimate.id, locationId: ro.locationId, action: `Saved estimate draft (${normalized.length} lines) for ${ro.roNumber}` });
  return getEstimate(req.auth, ro.id);
};

// Freezes the draft into an immutable, hashed commercial snapshot.
export const createVersion = async (req, roIdOrNumber, { changeSummary }) => {
  const ro = await findRoForAccess(req.auth, roIdOrNumber);
  const estimate = await Estimate.findOne({ roId: ro.id }).lean();
  if (!estimate || !estimate.draftLines.length) throw unprocessable('Add estimate lines before creating a version');
  const location = await Location.findOne({ id: ro.locationId }).lean();
  const priced = await priceLines({ location, ro, lines: estimate.draftLines });
  const lineHashes = Object.fromEntries(priced.lines.map(l => [l.id, lineHash(l)]));
  const contentHash = hashCanonical({ lines: priced.lines, totals: priced.totals, pricingContext: priced.pricingContext });

  const current = estimate.currentVersionId ? await EstimateVersion.findOne({ id: estimate.currentVersionId }).lean() : null;
  if (current && current.contentHash === contentHash) throw conflict('The draft is identical to the current version', 'NO_CHANGES');
  const hasApprovals = current ? await Approval.exists({ estimateId: estimate.id }) : false;

  const version = await withTransaction(async (session) => {
    const versionNumber = (estimate.currentVersionNumber || 0) + 1;
    const [created] = await EstimateVersion.create([{
      estimateId: estimate.id,
      roId: ro.id,
      versionNumber,
      reason: !current ? 'initial' : hasApprovals ? 'change_order' : 'revision',
      changeSummary: changeSummary || '',
      previousVersionId: current?.id,
      currency: priced.currency,
      lines: priced.lines,
      totals: priced.totals,
      pricingContext: priced.pricingContext,
      membershipEvaluation: priced.membershipEvaluation,
      lineHashes,
      contentHash,
      createdBy: req.auth.userId,
      createdByName: req.auth.user.name
    }], { session });
    const res = await Estimate.updateOne(
      { id: estimate.id, currentVersionNumber: estimate.currentVersionNumber || 0 },
      { $set: { currentVersionId: created.id, currentVersionNumber: versionNumber, draftDirty: false }, $inc: { __v: 1 } },
      { session }
    );
    if (res.modifiedCount !== 1) throw versionConflict('Estimate');
    await syncAuthorizationEffects(req, ro.id, session);
    await audit(req, {
      eventType: 'ESTIMATE_VERSION_CREATED', category: 'approval', entityType: 'Estimate', entityId: estimate.id, locationId: ro.locationId,
      action: `${estimate.estimateNumber} v${versionNumber} (${created.reason}) total ${priced.totals.totalCents} cents`, metadata: { contentHash }
    }, session);
    return created;
  });
  return { ...(await getEstimate(req.auth, ro.id)), createdVersionId: version.id };
};

export const presentEstimate = async (req, roIdOrNumber, { notifyCustomer = true } = {}) => {
  const ro = await findRoForAccess(req.auth, roIdOrNumber);
  const estimate = await Estimate.findOne({ roId: ro.id }).lean();
  if (!estimate?.currentVersionId) throw unprocessable('Create an estimate version before presenting it');
  if (estimate.draftDirty) throw unprocessable('The draft has unsaved changes. Create a new version before presenting.', undefined, 'DRAFT_NOT_VERSIONED');
  const version = await EstimateVersion.findOne({ id: estimate.currentVersionId }).lean();
  await withTransaction(async (session) => {
    await Estimate.updateOne({ id: estimate.id }, { $set: { presentedVersionId: version.id, presentedAt: new Date(), status: estimate.status === 'draft' ? 'presented' : estimate.status }, $inc: { __v: 1 } }, { session });
    const set = PRE_APPROVAL_STATUSES.includes(ro.status) ? { status: 'awaiting_approval' } : {};
    await RepairOrder.updateOne({ id: ro.id }, {
      $set: set, $inc: { __v: 1 },
      $push: { timeline: timelineEvent(req.auth, 'estimate', `Estimate v${version.versionNumber} sent for approval`, true) }
    }, { session });
    await audit(req, { eventType: 'ESTIMATE_PRESENTED', category: 'approval', entityType: 'Estimate', entityId: estimate.id, locationId: ro.locationId, action: `Presented ${estimate.estimateNumber} v${version.versionNumber} to customer` }, session);
  });
  let delivery = null;
  if (notifyCustomer) {
    const { notifyCustomerOfEstimate } = await import('./messageService.js');
    delivery = await notifyCustomerOfEstimate(req, ro, estimate, version);
  }
  return { ...(await getEstimate(req.auth, ro.id)), delivery };
};

export const recordApproval = async (req, roIdOrNumber, input) => {
  const { auth } = req;
  const ro = await findRoForAccess(auth, roIdOrNumber);
  if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Repair order is closed');
  const isCustomer = auth.role === 'customer';
  if (!isCustomer && !can(auth, 'approvals:record')) throw forbidden('You cannot record customer approvals');

  const estimate = await Estimate.findOne({ roId: ro.id }).lean();
  if (!estimate?.currentVersionId) throw notFound('Estimate');
  if (input.versionId !== estimate.currentVersionId) {
    throw conflict('This estimate was revised. Review the latest version before approving.', 'ESTIMATE_VERSION_SUPERSEDED', { currentVersionId: estimate.currentVersionId });
  }
  if (estimate.presentedVersionId !== estimate.currentVersionId) throw unprocessable('The current version has not been presented to the customer yet', undefined, 'NOT_PRESENTED');
  const version = await EstimateVersion.findOne({ id: input.versionId }).lean();
  const hashes = version.lineHashes instanceof Map ? Object.fromEntries(version.lineHashes) : version.lineHashes;
  if (!input.decisions?.length) throw badRequest('At least one line decision is required');

  const lineMap = new Map(version.lines.map(l => [l.id, l]));
  const decisions = input.decisions.map(d => {
    const line = lineMap.get(d.lineId);
    if (!line) throw badRequest(`Line ${d.lineId} is not part of this estimate version`);
    if (d.decision === 'declined' && line.safetyCritical && !d.declineReason) {
      throw badRequest(`Declining the safety-critical item "${line.description}" requires a reason`);
    }
    return { lineId: d.lineId, lineHash: hashes[d.lineId], decision: d.decision, declineReason: d.declineReason };
  });
  if (new Set(decisions.map(d => d.lineId)).size !== decisions.length) throw badRequest('Duplicate decisions for a line');

  let method = input.method;
  let approverName = input.approverName;
  if (isCustomer) {
    const customer = await Customer.findOne({ id: auth.customerId }).lean();
    method = 'portal';
    approverName = customer.name;
  } else {
    if (!method || method === 'portal') throw badRequest('Record how the customer authorized the work');
    if (!approverName) throw badRequest('Record who authorized the work');
    if (method === 'in_person_signature') {
      if (!input.signatureEvidenceId) throw badRequest('Attach the customer signature');
      const sig = await Evidence.findOne({ id: input.signatureEvidenceId, roId: ro.id }).lean();
      if (!sig) throw badRequest('Signature evidence not found on this repair order');
    }
    if (['phone', 'email'].includes(method) && !input.authorizationStatement) throw badRequest('Document the authorization (who, when, what was said)');
  }
  const approvedTotalCents = decisions.filter(d => d.decision === 'approved').reduce((s, d) => s + (lineMap.get(d.lineId).totalCents || 0), 0);

  const approval = await withTransaction(async (session) => {
    const [created] = await Approval.create([{
      estimateId: estimate.id, estimateVersionId: version.id, versionNumber: version.versionNumber, versionHash: version.contentHash,
      roId: ro.id, customerId: ro.customerId, decisions, approvedTotalCents, currency: version.currency,
      method, approverName, approverRelation: input.approverRelation || 'owner',
      recordedBy: isCustomer ? undefined : auth.userId, recordedByName: isCustomer ? undefined : auth.user.name,
      customerUserId: isCustomer ? auth.userId : undefined,
      signatureEvidenceId: input.signatureEvidenceId, authorizationStatement: input.authorizationStatement,
      ip: req.ip, userAgent: (req.get('User-Agent') || '').slice(0, 300)
    }], { session });
    // concurrency guard: the version must still be current when we commit
    const still = await Estimate.updateOne({ id: estimate.id, currentVersionId: version.id }, { $inc: { __v: 1 } }, { session });
    if (still.modifiedCount !== 1) throw conflict('The estimate changed while approving. Review the latest version.', 'ESTIMATE_VERSION_SUPERSEDED');
    await syncAuthorizationEffects(req, ro.id, session);
    const approvedCount = decisions.filter(d => d.decision === 'approved').length;
    await RepairOrder.updateOne({ id: ro.id }, { $push: { timeline: timelineEvent(auth, 'approval', `Customer ${approvedCount ? `approved ${approvedCount}` : 'declined'} item(s) on estimate v${version.versionNumber} (${method})`, true) } }, { session });
    await audit(req, {
      eventType: 'ESTIMATE_APPROVAL_RECORDED', category: 'approval', entityType: 'Estimate', entityId: estimate.id, locationId: ro.locationId,
      action: `${approverName} ${method === 'portal' ? 'approved online' : `authorized via ${method}`}: ${approvedCount} approved, ${decisions.length - approvedCount} declined on v${version.versionNumber} (approved total ${approvedTotalCents} cents)`,
      metadata: { approvalId: created.id, versionHash: version.contentHash }
    }, session);
    return created;
  });

  if (ro.advisorId && isCustomer) {
    await notifyUsers([ro.advisorId], { type: 'estimate_decision', title: `${ro.roNumber}: customer responded to the estimate`, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
  }
  if (ro.assignedTechId && decisions.some(d => d.decision === 'approved')) {
    await notifyUsers([ro.assignedTechId], { type: 'work_authorized', title: `${ro.roNumber}: work authorized`, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
  }
  return { approval: toDTO(approval.toObject()), ...(await getEstimate(auth, ro.id)) };
};

/**
 * Applies the effective authorization of the current version:
 *  - estimate status, RO jobs (create / extend / cancel unstarted), RO status
 *  - finding customer decisions and predictive-signal links
 *  - part reservations for approved lines; releases for lines no longer approved
 */
const syncAuthorizationEffects = async (req, roId, session) => {
  const { estimate, version, authorization, lines: approvedLines } = await authorizedLinesForRo(roId, session);
  if (!version) return;
  const statuses = version.lines.map(l => authorization.get(l.id)?.status);
  const estStatus = statuses.every(s => s === 'approved') ? 'approved'
    : statuses.some(s => s === 'approved') ? 'partially_approved'
      : statuses.every(s => s === 'declined') ? 'declined'
        : (estimate.presentedVersionId ? 'presented' : 'draft');
  await Estimate.updateOne({ id: estimate.id }, { $set: { status: estStatus } }, { session });

  const ro = await RepairOrder.findOne({ id: roId }).session(session);
  const approvedIds = new Set(approvedLines.map(l => l.id));
  const jobs = ro.jobs.map(j => j.toObject ? j.toObject() : { ...j });
  for (const job of jobs) {
    if (job.status === 'cancelled') continue;
    const still = job.estimateLineIds.filter(id => approvedIds.has(id));
    if (!still.length && job.status === 'authorized') job.status = 'cancelled';
    else if (still.length) job.estimateLineIds = still;
  }
  const covered = new Set(jobs.filter(j => j.status !== 'cancelled').flatMap(j => j.estimateLineIds));
  const groups = new Map();
  for (const line of approvedLines) {
    if (covered.has(line.id)) continue;
    const key = line.jobGroup || line.id;
    const existingJob = jobs.find(j => j.status !== 'cancelled' && j.groupKey === key);
    if (existingJob) {
      existingJob.estimateLineIds.push(line.id);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  for (const [key, lines] of groups) {
    const labor = lines.find(l => l.kind === 'labor');
    jobs.push({
      id: uuid(),
      groupKey: key,
      title: lines[0].jobGroup || labor?.description || lines[0].description,
      estimateLineIds: lines.map(l => l.id),
      laborOpCode: labor?.laborOpCode,
      soldHours: lines.filter(l => l.kind === 'labor').reduce((s, l) => s + (l.hours || 0), 0),
      status: 'authorized',
      techId: ro.assignedTechId,
      authorizedByApprovalId: lines[0].approvalId,
      authorizedVersionId: version.id
    });
  }
  const set = { jobs };
  if (approvedLines.length && PRE_APPROVAL_STATUSES.includes(ro.status)) set.status = 'approved';
  await RepairOrder.updateOne({ id: roId }, { $set: set, $inc: { __v: 1 } }, { session });

  // Findings: customer decision follows the lines that reference them.
  for (const line of version.lines) {
    const decision = authorization.get(line.id)?.status;
    if (!line.findingIds?.length || decision === 'pending') continue;
    await Finding.updateMany({ id: { $in: line.findingIds } }, { $set: { customerDecision: decision } }, { session });
  }
  const signalIds = approvedLines.map(l => l.predictiveSignalId).filter(Boolean);
  if (signalIds.length) {
    await PredictiveSignal.updateMany({ id: { $in: signalIds }, status: 'open' }, { $set: { status: 'added_to_estimate', decidedAt: new Date(), decidedBy: req.auth.userId } }, { session });
  }

  const { reserveForApprovedLine, releaseReservation } = await import('./inventoryService.js');
  for (const line of approvedLines.filter(l => l.kind === 'part' && l.partId)) {
    await reserveForApprovedLine(req, { ro, line }, session);
  }
  const stale = await Reservation.find({ roId, status: 'active', estimateLineId: { $nin: [...approvedIds] } }).session(session).lean();
  for (const r of stale) await releaseReservation(req, r.id, 'estimate_line_not_authorized', session);
};

export const notifyAdvisorsOfPendingApproval = async (ro) =>
  notifyRoles(ro.locationId, ['advisor'], { type: 'approval_pending', title: `${ro.roNumber} awaiting approval`, link: `#/app/ro/${ro.id}` });
