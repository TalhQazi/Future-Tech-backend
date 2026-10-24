import { Router } from 'express';
import { z, h, ok, id, page, cents, reqText, text, expectedVersion } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as ros from '../../services/roService.js';
import * as insp from '../../services/inspectionService.js';
import * as est from '../../services/estimateService.js';
import * as work from '../../services/workService.js';
import * as inv from '../../services/invoiceService.js';
import { RO_STATUSES } from '../../models/operations.js';
import { FINDING_CONDITIONS, FINDING_SEVERITIES } from '../../models/inspections.js';

const r = Router();
const staffOr = (perm) => requireAnyPermission(perm, 'portal:access');

// ---- repair orders -----------------------------------------------------------------
r.get('/repair-orders', staffOr('ros:read'), h(async (req, res) => ok(res, await ros.listRepairOrders(req.auth, { ...req.query, ...page(req) }))));
r.get('/repair-orders/:id', staffOr('ros:read'), h(async (req, res) => ok(res, { repairOrder: await ros.getRepairOrder(req.auth, req.params.id) })));
r.post('/repair-orders', requirePermission('ros:write'), idempotent(), validate({ body: z.object({
  locationId: id, customerId: id, vehicleId: id, appointmentId: id.optional(), concerns: z.array(text(2000)).min(1),
  odometerIn: z.number().int().min(0).max(5_000_000).optional(), fuelLevel: text(20).optional(), keyTag: text(20).optional(),
  waiter: z.boolean().optional(), transportation: z.enum(['wait', 'drop_off', 'loaner', 'shuttle', 'unknown']).optional(),
  promisedAt: z.string().datetime({ offset: true }).optional(), preauthorizedCents: cents.optional(), advisorNotes: text(2000).optional(),
  assignedTechId: id.optional(), bayId: id.optional(), priority: z.enum(['normal', 'high', 'urgent']).optional(), allowConcurrent: z.boolean().optional()
}) }), h(async (req, res) => ok(res, { repairOrder: await ros.createRepairOrder(req, req.body) }, 201)));
r.post('/repair-orders/:id/status', requirePermission('ros:write'), validate({ body: z.object({ status: z.enum(RO_STATUSES), reason: text(500).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.changeStatus(req, req.params.id, req.body, expectedVersion(req)) })));
r.post('/repair-orders/:id/dispatch', requirePermission('ros:dispatch'), validate({ body: z.object({ assignedTechId: id.nullable().optional(), bayId: id.nullable().optional(), promisedAt: z.string().datetime({ offset: true }).nullable().optional(), priority: z.enum(['normal', 'high', 'urgent']).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.dispatch(req, req.params.id, req.body) })));
r.patch('/repair-orders/:id/notes', requirePermission('ros:write'), validate({ body: z.object({ advisorNotes: text(4000).optional(), customerNotes: text(4000).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.updateNotes(req, req.params.id, req.body) })));
r.post('/repair-orders/:id/concerns', requireAnyPermission('ros:write', 'jobs:execute'), validate({ body: z.object({ text: reqText(2000), source: z.enum(['customer', 'advisor', 'technician']).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.addConcern(req, req.params.id, req.body) })));
r.patch('/repair-orders/:id/concerns/:concernId', requireAnyPermission('ros:write', 'jobs:execute'), validate({ body: z.object({ cause: text(2000).optional(), correction: text(2000).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.updateConcern(req, req.params.id, req.params.concernId, req.body) })));
r.post('/repair-orders/:id/safety-escalations', requirePermission('ros:safety'), validate({ body: z.object({ severity: z.enum(['critical', 'high']), description: reqText(2000), findingId: id.optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.raiseSafetyEscalation(req, req.params.id, req.body) }, 201)));
r.post('/repair-orders/:id/safety-escalations/:escId', requirePermission('ros:write'), validate({ body: z.object({
  action: z.enum(['acknowledge', 'customer_notified', 'customer_decision', 'resolve']), method: text(40).optional(), decision: z.enum(['repair', 'declined']).optional(),
  signatureEvidenceId: id.optional(), note: text(1000).optional(), resolution: text(1000).optional()
}) }), h(async (req, res) => ok(res, { repairOrder: await ros.updateSafetyEscalation(req, req.params.id, req.params.escId, req.body) })));
r.post('/repair-orders/:id/qc', requirePermission('ros:qc'), validate({ body: z.object({ checklist: z.array(z.object({ item: reqText(200), passed: z.boolean(), note: text(500).optional() })).min(1), roadTestPerformed: z.boolean().optional(), passed: z.boolean(), notes: text(1000).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.recordQualityControl(req, req.params.id, req.body) })));
r.post('/repair-orders/:id/close', requirePermission('ros:close'), idempotent(), validate({ body: z.object({ odometerOut: z.number().int().min(0).optional(), overrideReason: text(500).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.closeRepairOrder(req, req.params.id, req.body) })));
r.post('/repair-orders/:id/cancel', requirePermission('ros:write'), validate({ body: z.object({ reason: reqText(500) }) }),
  h(async (req, res) => ok(res, { repairOrder: await ros.cancelRepairOrder(req, req.params.id, req.body) })));

// ---- jobs & time -----------------------------------------------------------------------
r.post('/repair-orders/:id/jobs/:jobId/start', requirePermission('jobs:execute'), h(async (req, res) => ok(res, { repairOrder: await work.startJob(req, req.params.id, req.params.jobId) })));
r.post('/repair-orders/:id/jobs/:jobId/pause', requirePermission('jobs:execute'), validate({ body: z.object({ reason: z.enum(['waiting_parts', 'break', 'reassigned', 'other']).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await work.pauseJob(req, req.params.id, req.params.jobId, req.body) })));
r.post('/repair-orders/:id/jobs/:jobId/complete', requirePermission('jobs:execute'), idempotent(), validate({ body: z.object({ completionNotes: reqText(4000), evidenceIds: z.array(id).optional() }) }),
  h(async (req, res) => ok(res, { repairOrder: await work.completeJob(req, req.params.id, req.params.jobId, req.body) })));
r.post('/repair-orders/:id/jobs/:jobId/assign', requirePermission('ros:dispatch'), validate({ body: z.object({ techId: id }) }),
  h(async (req, res) => ok(res, { repairOrder: await work.reassignJob(req, req.params.id, req.params.jobId, req.body) })));
r.get('/time/me', requirePermission('time:clock'), h(async (req, res) => ok(res, await work.myTime(req.auth, req.query))));
r.post('/time/clock-in', requirePermission('time:clock'), validate({ body: z.object({ roId: id.optional(), jobId: id.optional(), type: z.enum(['job', 'diagnostic', 'shop', 'training']).optional() }) }), h(async (req, res) => ok(res, { entry: await work.clockIn(req, req.body) }, 201)));
r.post('/time/clock-out', requirePermission('time:clock'), validate({ body: z.object({ note: text(300).optional() }) }), h(async (req, res) => ok(res, { entry: await work.clockOut(req, req.body) })));
r.get('/time', requirePermission('time:correct'), h(async (req, res) => ok(res, { entries: await work.listTimeEntries(req.auth, req.query) })));
r.patch('/time/:id', requirePermission('time:correct'), validate({ body: z.object({ startAt: z.string().datetime({ offset: true }).optional(), endAt: z.string().datetime({ offset: true }).optional(), reason: reqText(500) }) }),
  h(async (req, res) => ok(res, { entry: await work.correctTimeEntry(req, req.params.id, req.body) })));
r.get('/workload', requirePermission('ros:dispatch'), h(async (req, res) => ok(res, { technicians: await work.technicianWorkload(req.auth, req.query) })));

// ---- inspections ------------------------------------------------------------------------
const measurements = z.array(z.object({ label: reqText(60), value: z.number(), unit: text(20), measurementId: id.optional() })).optional();
r.get('/repair-orders/:id/inspection', staffOr('inspections:read'), h(async (req, res) => ok(res, await insp.getInspection(req.auth, req.params.id))));
r.post('/repair-orders/:id/inspection/start', requirePermission('inspections:write'), h(async (req, res) => ok(res, await insp.startInspection(req, req.params.id))));
r.post('/repair-orders/:id/inspection/findings', requirePermission('inspections:write'), idempotent(), validate({ body: z.object({
  findingId: id.optional(), itemKey: text(60).optional(), category: text(80).optional(), name: reqText(160),
  condition: z.enum(FINDING_CONDITIONS), severity: z.enum(FINDING_SEVERITIES).nullable().optional(),
  notes: text(4000).optional(), recommendation: text(2000).optional(), measurements, raiseEscalation: z.boolean().optional()
}) }), h(async (req, res) => ok(res, { finding: await insp.saveFinding(req, req.params.id, req.body, expectedVersion(req)) })));
r.post('/repair-orders/:id/inspection/complete', requirePermission('inspections:complete'), h(async (req, res) => ok(res, await insp.completeInspection(req, req.params.id))));
r.post('/findings/:id/corrections', requirePermission('findings:correct'), validate({ body: z.object({
  reason: reqText(1000), condition: z.enum(FINDING_CONDITIONS).optional(), severity: z.enum(FINDING_SEVERITIES).nullable().optional(),
  notes: text(4000).optional(), recommendation: text(2000).optional(), measurements
}) }), h(async (req, res) => ok(res, { finding: await insp.correctFinding(req, req.params.id, req.body) }, 201)));
r.get('/findings/:id/history', requirePermission('inspections:read'), h(async (req, res) => ok(res, { history: await insp.findingHistory(req.auth, req.params.id) })));

// ---- estimates & approvals -------------------------------------------------------------------
const line = z.object({
  id: id.optional(), kind: z.enum(['labor', 'part', 'fee', 'sublet']), jobGroup: text(120).optional(), description: text(500).optional(),
  laborOpCode: text(40).optional(), hours: z.number().min(0).max(200).optional(), laborRateType: z.enum(['standard', 'diagnostic', 'ev']).optional(), rateCents: cents.optional(),
  partId: id.optional(), partNumber: text(60).optional(), quantity: z.number().positive().max(10000).optional(), unitPriceCents: cents.optional(), unitCostCents: cents.optional(),
  feeCode: text(40).optional(), findingIds: z.array(id).optional(), predictiveSignalId: id.optional(), safetyCritical: z.boolean().optional(),
  recommendationReason: text(1000).optional(), sortOrder: z.number().int().optional()
});
r.get('/repair-orders/:id/estimate', staffOr('estimates:read'), h(async (req, res) => ok(res, await est.getEstimate(req.auth, req.params.id))));
r.put('/repair-orders/:id/estimate/draft', requirePermission('estimates:write'), validate({ body: z.object({ lines: z.array(line).max(300) }) }),
  h(async (req, res) => ok(res, await est.saveDraft(req, req.params.id, req.body, expectedVersion(req)))));
r.post('/repair-orders/:id/estimate/versions', requirePermission('estimates:write'), idempotent(), validate({ body: z.object({ changeSummary: text(1000).optional() }) }),
  h(async (req, res) => ok(res, await est.createVersion(req, req.params.id, req.body), 201)));
r.post('/repair-orders/:id/estimate/present', requirePermission('estimates:present'), validate({ body: z.object({ notifyCustomer: z.boolean().optional() }) }),
  h(async (req, res) => ok(res, await est.presentEstimate(req, req.params.id, req.body))));
r.post('/repair-orders/:id/estimate/approvals', staffOr('approvals:record'), idempotent({ required: true }), validate({ body: z.object({
  versionId: id, decisions: z.array(z.object({ lineId: id, decision: z.enum(['approved', 'declined']), declineReason: text(500).optional() })).min(1),
  method: z.enum(['in_person_signature', 'phone', 'email', 'sms_link', 'portal']).optional(), approverName: text(160).optional(),
  approverRelation: z.enum(['owner', 'authorized_agent', 'fleet_manager']).optional(), signatureEvidenceId: id.optional(), authorizationStatement: text(2000).optional()
}) }), h(async (req, res) => ok(res, await est.recordApproval(req, req.params.id, req.body), 201)));

// ---- invoices on a repair order ---------------------------------------------------------------
r.get('/repair-orders/:id/invoice', staffOr('invoices:read'), h(async (req, res) => ok(res, { invoice: await inv.getInvoiceForRo(req.auth, req.params.id) })));
r.post('/repair-orders/:id/invoice', requirePermission('invoices:write'), idempotent(), h(async (req, res) => ok(res, { invoice: await inv.generateInvoice(req, req.params.id) }, 201)));

export default r;
