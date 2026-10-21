import { Router } from 'express';
import { z, h, ok, id, cents, reqText, text } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as ft from '../../services/futuretechService.js';
import * as am from '../../services/automindService.js';
import * as intel from '../../services/intelligenceService.js';
import { SOURCE_KINDS } from '../../models/diagnostics.js';
import { aiStatus } from '../../adapters/ai/index.js';
import { technicalData } from '../../adapters/technicalData.js';

const r = Router();

// Device push (HMAC-signed, no user session); raw body captured in app.js
r.post('/automind/ingest', h(async (req, res) => ok(res, await am.ingest(req.rawBody?.toString('utf8') || '{}', req.headers))));

const staffOr = (perm) => requireAnyPermission(perm, 'portal:access');

r.get('/ai/status', h(async (_req, res) => ok(res, { ai: aiStatus() })));

// ---- technical data ------------------------------------------------------------------
const applicability = z.object({ makes: z.array(text(60)).default([]), models: z.array(text(80)).default([]), yearFrom: z.number().int().optional(), yearTo: z.number().int().optional(), engines: z.array(text(80)).default([]), notes: text(300).optional() });
r.get('/techdata/status', requirePermission('techdata:read'), h(async (_req, res) => ok(res, { provider: technicalData.status() })));
r.get('/techdata/sources', requirePermission('techdata:read'), h(async (_req, res) => ok(res, { sources: await ft.listSources() })));
const sourceBody = z.object({
  name: reqText(160), publisher: text(160).optional(), kind: z.enum(SOURCE_KINDS), version: reqText(60), effectiveFrom: z.string().optional(), effectiveTo: z.string().optional(),
  url: text(500).optional(), documentRef: text(300).optional(), status: z.enum(['active', 'expired', 'revoked']).optional(),
  license: z.object({ licensor: text(160).optional(), agreementRef: text(120).optional(), permittedContexts: z.array(z.enum(['technician', 'advisor', 'customer'])).default(['technician']), cacheTtlHours: z.number().int().positive().nullable().optional(), aiUseAllowed: z.boolean().default(false), redistributionAllowed: z.boolean().default(false), attribution: text(300).optional(), expiresAt: z.string().optional() }).optional()
});
r.post('/techdata/sources', requirePermission('techdata:manage'), validate({ body: sourceBody }), h(async (req, res) => ok(res, { source: await ft.saveSource(req, null, req.body) }, 201)));
r.patch('/techdata/sources/:id', requirePermission('techdata:manage'), validate({ body: sourceBody.partial() }), h(async (req, res) => ok(res, { source: await ft.saveSource(req, req.params.id, req.body) })));
r.get('/techdata/specifications', requirePermission('techdata:read'), h(async (req, res) => ok(res, { specifications: await ft.listSpecifications(req.auth, req.query) })));
const specBody = z.object({
  sourceId: id, sourceVersion: reqText(60), applicability: applicability.optional(), system: text(80).optional(), component: reqText(120), parameter: reqText(120), unit: reqText(20),
  comparison: z.enum(['range', 'min', 'max', 'nominal_tolerance']), minValue: z.number().optional(), maxValue: z.number().optional(), nominalValue: z.number().optional(), tolerance: z.number().min(0).optional(),
  conditions: text(300).optional(), notes: text(1000).optional()
});
r.post('/techdata/specifications', requirePermission('techdata:manage'), validate({ body: specBody }), h(async (req, res) => ok(res, { specification: await ft.saveSpecification(req, null, req.body) }, 201)));
r.patch('/techdata/specifications/:id', requirePermission('techdata:manage'), validate({ body: specBody }), h(async (req, res) => ok(res, { specification: await ft.saveSpecification(req, req.params.id, req.body) })));
r.post('/techdata/specifications/:id/review', requirePermission('techdata:review'), validate({ body: z.object({ approve: z.boolean(), note: text(500).optional() }) }), h(async (req, res) => ok(res, { specification: await ft.reviewSpecification(req, req.params.id, req.body) })));

const node = z.object({
  key: reqText(60), type: z.enum(['test', 'inspection', 'question', 'repair', 'verify', 'end']), title: reqText(200), instructions: text(4000).optional(), safetyNotes: text(1000).optional(),
  component: text(120).optional(), causeHint: text(200).optional(), specificationId: id.optional(), measurement: z.object({ parameter: text(120), unit: text(20) }).optional(),
  testPointId: text(60).optional(), wiringDiagramId: id.optional(), onPass: text(60).optional(), onFail: text(60).optional(), options: z.array(z.object({ label: reqText(120), next: reqText(60) })).optional()
});
r.get('/techdata/procedures', requirePermission('techdata:read'), h(async (req, res) => ok(res, { procedures: await ft.listProcedures(req.auth, req.query) })));
r.post('/techdata/procedures', requirePermission('techdata:manage'), validate({ body: z.object({ procedureId: id.optional(), title: reqText(200), summary: text(2000).optional(), applicability: applicability.optional(), dtcCodes: z.array(text(10)).default([]), symptoms: z.array(text(200)).default([]), sourceId: id, sourceVersion: text(60).optional(), startNodeKey: reqText(60), nodes: z.array(node).min(1).max(200) }) }),
  h(async (req, res) => ok(res, { procedure: await ft.saveProcedure(req, req.body) }, 201)));
r.post('/techdata/procedures/:id/publish', requirePermission('techdata:review'), h(async (req, res) => ok(res, { procedure: await ft.publishProcedure(req, req.params.id) })));

const point = z.object({ x: z.number(), y: z.number() });
const endpoint = z.object({ componentId: text(60), connectorId: text(60).optional(), pinId: text(60).optional() });
r.get('/wiring', requirePermission('techdata:read'), h(async (req, res) => ok(res, { diagrams: await ft.listWiring(req.auth, req.query) })));
r.get('/wiring/:id', requirePermission('techdata:read'), h(async (req, res) => ok(res, { diagram: await ft.getWiring(req.auth, req.params.id, req.query) })));
r.post('/wiring', requirePermission('techdata:manage'), validate({ body: z.object({
  diagramId: id.optional(), title: reqText(200), system: text(120).optional(), applicability: applicability.optional(), sourceId: id, sourceVersion: text(60).optional(),
  canvas: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
  components: z.array(z.object({ id: text(60), label: reqText(120), type: text(40).optional(), x: z.number(), y: z.number(), width: z.number().positive().optional(), height: z.number().positive().optional(), connectors: z.array(z.object({ id: text(60), label: text(80), pins: z.array(z.object({ id: text(60), number: text(20), label: text(120).optional(), circuitId: text(60).optional() })) })).default([]) })).min(1),
  circuits: z.array(z.object({ id: text(60), name: text(160), function: text(200).optional(), wireColor: text(40).optional(), gauge: text(20).optional(), from: endpoint, to: endpoint, points: z.array(point).default([]) })).default([]),
  testPoints: z.array(z.object({ id: text(60), label: text(120), circuitId: text(60).optional(), componentId: text(60).optional(), connectorId: text(60).optional(), pinId: text(60).optional(), specificationId: id.optional(), instructions: text(1000).optional(), x: z.number().optional(), y: z.number().optional() })).default([])
}) }), h(async (req, res) => ok(res, { diagram: await ft.saveWiring(req, req.body) }, 201)));
r.post('/wiring/:id/publish', requirePermission('techdata:review'), h(async (req, res) => ok(res, { diagram: await ft.publishWiring(req, req.params.id) })));

// ---- diagnostic sessions ---------------------------------------------------------------------
const ff = z.array(z.object({ pid: text(20).optional(), name: reqText(80), value: z.union([z.number(), z.string().max(60)]), unit: text(20).optional() }));
r.get('/repair-orders/:id/diagnostics', requirePermission('diagnostics:read'), h(async (req, res) => {
  const { session, measurements } = await ft.getSession(req.auth, req.params.id);
  ok(res, { session, measurements });
}));
r.post('/repair-orders/:id/diagnostics', requirePermission('diagnostics:write'), h(async (req, res) => {
  const { session, measurements } = await ft.getSession(req.auth, req.params.id, { create: true });
  ok(res, { session, measurements }, 201);
}));
r.post('/diagnostics/:sessionId/scans', requirePermission('diagnostics:write'), idempotent(), validate({ body: z.object({
  phase: z.enum(['pre_repair', 'post_repair', 'other']).default('pre_repair'), source: z.enum(['manual_entry', 'scan_report']),
  dtcs: z.array(z.object({ code: z.string().regex(/^[PBCU][0-9A-F]{4}$/i, 'DTC format like P0302'), description: text(300).optional(), module: text(60).optional(), status: z.enum(['active', 'pending', 'permanent', 'history']).optional(), freezeFrame: ff.optional() })).default([]),
  modulesScanned: z.array(text(60)).default([]), evidenceId: id.optional(), notes: text(2000).optional()
}) }), h(async (req, res) => ok(res, { session: await ft.recordScan(req, req.params.sessionId, req.body) }, 201)));
r.post('/diagnostics/:sessionId/measurements', requirePermission('diagnostics:write'), idempotent(), validate({ body: z.object({
  findingId: id.optional(), procedureRunId: id.optional(), nodeKey: text(60).optional(), wiringDiagramId: id.optional(), testPointId: text(60).optional(),
  component: text(120).optional(), parameter: reqText(120), value: z.number(), unit: reqText(20),
  method: z.enum(['manual_meter', 'oscilloscope', 'scan_tool_pid', 'device_reading', 'pressure_gauge', 'precision_gauge', 'visual', 'other']),
  classification: z.enum(['authoritative', 'comparative', 'observation']), conditions: text(300).optional(), specificationId: id.optional(),
  deviceId: id.optional(), deviceCommandId: id.optional(), evidenceIds: z.array(id).optional(), clientId: text(100).optional()
}) }), h(async (req, res) => ok(res, { measurement: await ft.recordMeasurement(req, req.params.sessionId, req.body) }, 201)));
r.post('/diagnostics/:sessionId/procedures', requirePermission('diagnostics:write'), validate({ body: z.object({ procedureDocId: id }) }), h(async (req, res) => ok(res, { session: await ft.startProcedure(req, req.params.sessionId, req.body) }, 201)));
r.post('/diagnostics/:sessionId/procedures/:runId/advance', requirePermission('diagnostics:write'), validate({ body: z.object({ result: z.enum(['pass', 'fail', 'done', 'escalated']).optional(), optionLabel: text(120).optional(), measurementId: id.optional(), notes: text(2000).optional() }) }),
  h(async (req, res) => ok(res, { session: await ft.advanceProcedure(req, req.params.sessionId, req.params.runId, req.body) })));
r.post('/diagnostics/:sessionId/escalate', requirePermission('diagnostics:write'), validate({ body: z.object({ to: text(80).optional(), reason: reqText(1000) }) }), h(async (req, res) => ok(res, { session: await ft.escalate(req, req.params.sessionId, req.body) })));
r.post('/diagnostics/:sessionId/conclude', requirePermission('diagnostics:write'), validate({ body: z.object({ rootCause: reqText(1000), component: text(120).optional(), correction: reqText(2000), measurementIds: z.array(id).optional(), evidenceIds: z.array(id).optional() }) }),
  h(async (req, res) => ok(res, { session: await ft.conclude(req, req.params.sessionId, req.body) })));
r.post('/diagnostics/:sessionId/verify', requirePermission('diagnostics:write'), validate({ body: z.object({ postRepairScanId: id, roadTestPerformed: z.boolean().default(false), roadTestNotes: text(1000).optional() }) }),
  h(async (req, res) => ok(res, { session: await ft.verifyRepair(req, req.params.sessionId, req.body) })));
r.get('/diagnostics/:sessionId/causes', requirePermission('diagnostics:read'), h(async (req, res) => ok(res, await ft.rankCauses(req.auth, req.params.sessionId))));
r.post('/diagnostics/:sessionId/device', requirePermission('devices:command'), validate({ body: z.object({ deviceId: id }) }), h(async (req, res) => ok(res, await am.attachDevice(req, req.params.sessionId, req.body.deviceId))));
r.get('/diagnostics/:sessionId/telemetry', requirePermission('diagnostics:read'), h(async (req, res) => ok(res, { samples: await am.telemetry(req.auth, { sessionId: req.params.sessionId, pid: req.query.pid, limit: Number(req.query.limit) || 500 }) })));

// ---- AutoMind devices ---------------------------------------------------------------------
r.get('/automind/status', requirePermission('diagnostics:read'), h(async (_req, res) => ok(res, { status: am.status() })));
r.get('/automind/devices', requirePermission('diagnostics:read'), h(async (req, res) => ok(res, { devices: await am.listDevices(req.auth) })));
r.post('/automind/devices', requirePermission('devices:manage'), validate({ body: z.object({ serialNumber: reqText(80), label: text(80).optional(), locationId: id, model: text(80).optional() }) }), h(async (req, res) => ok(res, await am.registerDevice(req, req.body), 201)));
r.post('/automind/devices/:id/discover', requirePermission('devices:manage'), h(async (req, res) => ok(res, { device: await am.discover(req, req.params.id) })));
r.post('/automind/devices/:id/commands', requirePermission('devices:command'), idempotent({ required: true }), validate({ body: z.object({ sessionId: id.optional(), command: reqText(60), params: z.record(z.any()).default({}), authorizationReason: text(500).optional() }) }),
  h(async (req, res) => ok(res, { command: await am.sendCommand(req, req.params.id, req.body) }, 201)));
r.get('/automind/commands', requirePermission('diagnostics:read'), h(async (req, res) => ok(res, { commands: await am.listCommands(req.auth, req.query) })));
r.post('/automind/commands/:id/refresh', requirePermission('devices:command'), h(async (req, res) => ok(res, { command: await am.refreshCommand(req, req.params.id) })));

// ---- Confirmed Fix, parts intelligence ------------------------------------------------------
r.get('/confirmed-fixes', requirePermission('fixes:read'), h(async (req, res) => ok(res, { confirmedFixes: await intel.searchFixes(req.query) })));
r.post('/confirmed-fixes/:id/review', requirePermission('fixes:verify'), validate({ body: z.object({ approve: z.boolean(), reason: text(500).optional() }) }), h(async (req, res) => ok(res, { confirmedFix: await intel.reviewFix(req, req.params.id, req.body) })));
r.get('/parts-intelligence/reliability', requirePermission('parts_intel:read'), h(async (req, res) => ok(res, { report: await intel.reliabilityReport(req.query) })));
r.get('/parts-intelligence/repeat-failures', requirePermission('parts_intel:read'), h(async (_req, res) => ok(res, { repeatFailures: await intel.repeatFailures() })));
r.post('/parts-intelligence/failures', requirePermission('parts_intel:write'), validate({ body: z.object({ installedPartId: id, comebackRoId: id.optional(), failureMode: reqText(500), determination: z.enum(['defective_part', 'installation_error', 'misdiagnosis', 'external_cause', 'undetermined']), odometer: z.number().int().min(0).optional(), evidenceIds: z.array(id).optional() }) }),
  h(async (req, res) => ok(res, { failure: await intel.recordPartFailure(req, req.body) }, 201)));
r.patch('/parts-intelligence/failures/:id/warranty', requirePermission('parts_intel:write'), validate({ body: z.object({ status: z.enum(['none', 'submitted', 'approved', 'denied']).optional(), claimNumber: text(60).optional(), creditCents: cents.optional(), notes: text(1000).optional() }) }),
  h(async (req, res) => ok(res, { failure: await intel.updateWarrantyClaim(req, req.params.id, req.body) })));

// ---- forum ---------------------------------------------------------------------------------
r.get('/forum', requirePermission('forum:read'), h(async (req, res) => ok(res, { threads: await intel.listThreads({ ...req.query, page: Number(req.query.page) || 1 }) })));
r.get('/forum/:id', requirePermission('forum:read'), h(async (req, res) => ok(res, await intel.getThread(req.auth, req.params.id))));
r.post('/forum', requirePermission('forum:write'), validate({ body: z.object({ title: reqText(200), body: reqText(20000), category: text(80).optional(), tags: z.array(text(40)).max(10).optional(), context: z.object({ make: text(60).optional(), model: text(80).optional(), yearFrom: z.number().int().optional(), yearTo: z.number().int().optional(), engine: text(80).optional(), dtcCodes: z.array(text(10)).default([]), roId: id.optional(), sessionId: id.optional() }).optional() }) }),
  h(async (req, res) => ok(res, { thread: await intel.createThread(req, req.body) }, 201)));
r.post('/forum/:id/replies', requirePermission('forum:write'), validate({ body: z.object({ body: reqText(20000), evidenceIds: z.array(id).optional() }) }), h(async (req, res) => ok(res, { reply: await intel.reply(req, req.params.id, req.body) }, 201)));
r.post('/forum/:id/vote', requirePermission('forum:write'), h(async (req, res) => ok(res, await intel.vote(req, 'thread', req.params.id))));
r.post('/forum/replies/:id/vote', requirePermission('forum:write'), h(async (req, res) => ok(res, await intel.vote(req, 'reply', req.params.id))));
r.post('/forum/:id/accept/:replyId', requirePermission('forum:write'), h(async (req, res) => ok(res, await intel.acceptReply(req, req.params.id, req.params.replyId))));
r.patch('/forum/:id', requirePermission('forum:moderate'), validate({ body: z.object({ status: z.enum(['open', 'solved', 'locked']).optional(), linkedConfirmedFixId: id.nullable().optional() }) }), h(async (req, res) => ok(res, { thread: await intel.moderateThread(req, req.params.id, req.body) })));

// ---- fuel & predictive -----------------------------------------------------------------------
r.get('/fuel/:vehicleId', staffOr('fuel:read'), h(async (req, res) => ok(res, await intel.fuelHistory(req.auth, req.params.vehicleId))));
r.post('/fuel', staffOr('fuel:write'), idempotent(), validate({ body: z.object({ vehicleId: id, at: z.string().optional(), odometer: z.number().int().min(0), volume: z.number().positive().max(500), volumeUnit: z.enum(['gal', 'L']).optional(), fullTank: z.boolean().optional(), costCents: cents.optional() }) }),
  h(async (req, res) => ok(res, { fuelEvent: await intel.addFuelEvent(req, req.body) }, 201)));
r.get('/predictive/rules', requirePermission('predictive:read'), h(async (_req, res) => ok(res, { rules: await intel.listRules() })));
r.post('/predictive/rules', requirePermission('predictive:manage'), validate({ body: z.object({ key: reqText(60), name: reqText(160), kind: z.enum(['maintenance_interval', 'declined_finding_followup', 'repeat_dtc', 'fuel_economy_anomaly', 'part_warranty_expiry']), parameters: z.record(z.any()).default({}), active: z.boolean().optional() }) }),
  h(async (req, res) => ok(res, { rule: await intel.saveRule(req, req.body) }, 201)));
r.get('/predictive/signals', staffOr('predictive:read'), h(async (req, res) => ok(res, { signals: await intel.listSignals(req.auth, req.query) })));
r.post('/predictive/vehicles/:vehicleId/evaluate', requirePermission('predictive:read'), h(async (req, res) => ok(res, await intel.evaluateVehicle(req.params.vehicleId))));
r.patch('/predictive/signals/:id', requirePermission('predictive:read'), validate({ body: z.object({ status: z.enum(['dismissed', 'open']), note: text(500).optional() }) }), h(async (req, res) => ok(res, { signal: await intel.decideSignal(req, req.params.id, req.body) })));

export default r;
