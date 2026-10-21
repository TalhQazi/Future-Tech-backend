import { withTransaction } from '../config/db.js';
import {
  TechnicalSource, Specification, DiagnosticProcedure, WiringDiagram, DiagnosticSession, Measurement,
  ConfirmedFix, Finding, Vehicle, RepairOrder, InstalledPart, CorporateSettings
} from '../models/index.js';
import { audit } from './audit.js';
import { timelineEvent } from './roService.js';
import { notifyRoles } from './notificationService.js';
import { findRoForAccess, can } from '../security/access.js';
import { notFound, badRequest, conflict, unprocessable, forbidden } from '../lib/errors.js';
import { toDTO, escapeRegex } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';

export const SPEC_ENGINE_VERSION = 'spec-eval-1';
export const CAUSE_ENGINE_VERSION = 'cause-rank-1';

// ---------------------------------------------------------------------------
// Applicability + technical data (sources, specifications, procedures, wiring)
// ---------------------------------------------------------------------------
const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
export const applies = (app = {}, v = {}) =>
  (!app.makes?.length || app.makes.some(m => eq(m, v.make)))
  && (!app.models?.length || app.models.some(m => eq(m, v.model) || String(v.model || '').toLowerCase().includes(String(m).toLowerCase())))
  && (!app.yearFrom || (v.year && v.year >= app.yearFrom))
  && (!app.yearTo || (v.year && v.year <= app.yearTo))
  && (!app.engines?.length || app.engines.some(e => String(v.engine || '').toLowerCase().includes(String(e).toLowerCase())));

const sourceUsable = (src, context = 'technician') =>
  src && src.status === 'active' && (!src.license?.expiresAt || new Date(src.license.expiresAt) > new Date())
  && (src.license?.permittedContexts || ['technician']).includes(context);

export const listSources = async () => toDTO(await TechnicalSource.find().sort({ name: 1 }).lean());

export const saveSource = async (req, id, input) => {
  const doc = id
    ? await TechnicalSource.findOneAndUpdate({ id }, { $set: input, $inc: { __v: 1 } }, { new: true }).lean()
    : (await TechnicalSource.create({ ...input, createdBy: req.auth.userId })).toObject();
  if (!doc) throw notFound('Technical source');
  await audit(req, { eventType: id ? 'TECH_SOURCE_UPDATED' : 'TECH_SOURCE_CREATED', category: 'data', entityType: 'TechnicalSource', entityId: doc.id, action: `${id ? 'Updated' : 'Registered'} source ${doc.name} ${doc.version} (${doc.kind})` });
  return toDTO(doc);
};

const assertSource = async (sourceId) => {
  const src = await TechnicalSource.findOne({ id: sourceId }).lean();
  if (!src) throw badRequest('Cite a registered technical source');
  if (src.status !== 'active') throw badRequest('The cited source is not active');
  return src;
};

export const listSpecifications = async (auth, { vehicleId, component, status }) => {
  const filter = {};
  if (component) filter.component = new RegExp(escapeRegex(component), 'i');
  filter.status = status || 'active';
  let specs = await Specification.find(filter).limit(500).lean();
  if (vehicleId) {
    const v = await Vehicle.findOne({ id: vehicleId }).lean();
    specs = specs.filter(s => applies(s.applicability, v));
  }
  const sources = await TechnicalSource.find({ id: { $in: specs.map(s => s.sourceId) } }).lean();
  return specs.map(s => ({ ...toDTO(s), source: toDTO(sources.find(x => x.id === s.sourceId)) }));
};

// Specs enter as draft; a second reviewer activates them before they are used.
export const saveSpecification = async (req, id, input) => {
  await assertSource(input.sourceId);
  if (input.comparison === 'range' && !(Number.isFinite(input.minValue) && Number.isFinite(input.maxValue))) throw badRequest('Range specs need min and max');
  if (input.comparison === 'min' && !Number.isFinite(input.minValue)) throw badRequest('Minimum specs need minValue');
  if (input.comparison === 'max' && !Number.isFinite(input.maxValue)) throw badRequest('Maximum specs need maxValue');
  if (input.comparison === 'nominal_tolerance' && !(Number.isFinite(input.nominalValue) && Number.isFinite(input.tolerance))) throw badRequest('Nominal specs need nominal value and tolerance');
  const doc = id
    ? await Specification.findOneAndUpdate({ id, status: 'draft' }, { $set: input }, { new: true }).lean()
    : (await Specification.create({ ...input, status: 'draft', enteredBy: req.auth.userId })).toObject();
  if (!doc) throw conflict('Only draft specifications can be edited; retire and re-enter active ones');
  await audit(req, { eventType: 'SPECIFICATION_SAVED', category: 'data', entityType: 'Specification', entityId: doc.id, action: `Saved draft spec ${doc.component} / ${doc.parameter}` });
  return toDTO(doc);
};

export const reviewSpecification = async (req, id, { approve, note }) => {
  const spec = await Specification.findOne({ id }).lean();
  if (!spec) throw notFound('Specification');
  if (spec.enteredBy === req.auth.userId) throw forbidden('A different person must review this specification');
  const status = approve ? 'active' : 'retired';
  const doc = await Specification.findOneAndUpdate({ id, status: spec.status === 'active' && !approve ? 'active' : 'draft' }, { $set: { status, reviewedBy: req.auth.userId, reviewedAt: new Date(), notes: note ? `${spec.notes}\n${note}`.trim() : spec.notes } }, { new: true }).lean();
  if (!doc) throw conflict('Specification is not awaiting review');
  await audit(req, { eventType: approve ? 'SPECIFICATION_ACTIVATED' : 'SPECIFICATION_RETIRED', category: 'data', entityType: 'Specification', entityId: id, action: `${approve ? 'Activated' : 'Retired'} spec ${spec.component} / ${spec.parameter}`, reason: note });
  return toDTO(doc);
};

// Deterministic pass/fail; only for an active, reviewed, applicable spec from a usable source.
export const evaluateMeasurement = async ({ specificationId, value, unit, vehicle }) => {
  if (!specificationId) return { result: 'not_evaluated', reason: 'No specification selected', engineVersion: SPEC_ENGINE_VERSION };
  const spec = await Specification.findOne({ id: specificationId }).lean();
  const src = spec ? await TechnicalSource.findOne({ id: spec.sourceId }).lean() : null;
  const out = (result, reason) => ({ evaluation: { result, reason, engineVersion: SPEC_ENGINE_VERSION }, spec, src });
  if (!spec) return out('not_evaluated', 'Specification not found');
  if (spec.status !== 'active') return out('not_evaluated', 'Specification has not been reviewed');
  if (!sourceUsable(src)) return out('not_evaluated', 'Specification source is inactive, expired or not licensed for technician use');
  if (!applies(spec.applicability, vehicle)) return out('not_evaluated', 'Specification does not apply to this vehicle');
  if (!eq(spec.unit, unit)) return out('not_evaluated', `Unit mismatch: spec is in ${spec.unit}`);
  const { comparison: c, minValue: min, maxValue: max, nominalValue: nom, tolerance: tol } = spec;
  const pass = c === 'range' ? value >= min && value <= max
    : c === 'min' ? value >= min
      : c === 'max' ? value <= max
        : Math.abs(value - nom) <= tol;
  const limits = c === 'range' ? `${min}–${max}` : c === 'min' ? `≥ ${min}` : c === 'max' ? `≤ ${max}` : `${nom} ± ${tol}`;
  return out(pass ? 'pass' : 'fail', `${value} ${unit} ${pass ? 'within' : 'outside'} ${limits} ${spec.unit} (${src.name} ${spec.sourceVersion})`);
};

export const listProcedures = async (auth, { dtc, vehicleId, status }) => {
  const filter = { status: status || 'published' };
  if (dtc) filter.dtcCodes = dtc.toUpperCase();
  let docs = await DiagnosticProcedure.find(filter).sort({ title: 1, version: -1 }).limit(300).lean();
  if (vehicleId) {
    const v = await Vehicle.findOne({ id: vehicleId }).lean();
    docs = docs.filter(p => applies(p.applicability, v));
  }
  return toDTO(docs);
};

const validateGraph = ({ startNodeKey, nodes }) => {
  const keys = new Set(nodes.map(n => n.key));
  if (keys.size !== nodes.length) throw badRequest('Node keys must be unique');
  if (!keys.has(startNodeKey)) throw badRequest('Start node does not exist');
  for (const n of nodes) {
    for (const next of [n.onPass, n.onFail, ...(n.options || []).map(o => o.next)].filter(Boolean)) {
      if (!keys.has(next)) throw badRequest(`Node ${n.key} points to missing node ${next}`);
    }
  }
};

export const saveProcedure = async (req, input) => {
  await assertSource(input.sourceId);
  validateGraph(input);
  const procedureId = input.procedureId || uuid();
  const latest = await DiagnosticProcedure.findOne({ procedureId }).sort({ version: -1 }).lean();
  if (latest?.status === 'draft') {
    const doc = await DiagnosticProcedure.findOneAndUpdate({ id: latest.id }, { $set: { ...input, procedureId } }, { new: true }).lean();
    return toDTO(doc);
  }
  const doc = await DiagnosticProcedure.create({ ...input, procedureId, version: (latest?.version || 0) + 1, status: 'draft', authoredBy: req.auth.userId });
  await audit(req, { eventType: 'PROCEDURE_DRAFTED', category: 'data', entityType: 'DiagnosticProcedure', entityId: procedureId, action: `Drafted procedure ${doc.title} v${doc.version}` });
  return toDTO(doc);
};

export const publishProcedure = async (req, id) => {
  const doc = await DiagnosticProcedure.findOne({ id, status: 'draft' }).lean();
  if (!doc) throw notFound('Draft procedure');
  if (doc.authoredBy === req.auth.userId && !can(req.auth, 'techdata:review')) throw forbidden('Another reviewer must publish this procedure');
  await DiagnosticProcedure.updateMany({ procedureId: doc.procedureId, status: 'published' }, { $set: { status: 'retired' } });
  const published = await DiagnosticProcedure.findOneAndUpdate({ id }, { $set: { status: 'published', reviewedBy: req.auth.userId, publishedAt: new Date() } }, { new: true }).lean();
  await audit(req, { eventType: 'PROCEDURE_PUBLISHED', category: 'data', entityType: 'DiagnosticProcedure', entityId: doc.procedureId, action: `Published ${doc.title} v${doc.version}` });
  return toDTO(published);
};

export const listWiring = async (auth, { vehicleId, system }) => {
  const filter = { status: 'published' };
  if (system) filter.system = new RegExp(escapeRegex(system), 'i');
  let docs = await WiringDiagram.find(filter).select('id diagramId version title system applicability sourceId sourceVersion').lean();
  if (vehicleId) {
    const v = await Vehicle.findOne({ id: vehicleId }).lean();
    docs = docs.filter(d => applies(d.applicability, v));
  }
  return toDTO(docs);
};

export const getWiring = async (auth, id, { sessionId } = {}) => {
  const doc = await WiringDiagram.findOne({ id }).lean();
  if (!doc) throw notFound('Wiring diagram');
  const src = await TechnicalSource.findOne({ id: doc.sourceId }).lean();
  if (!sourceUsable(src, auth.role === 'customer' ? 'customer' : 'technician')) throw forbidden('This diagram is not licensed for your use');
  const overlays = sessionId
    ? await Measurement.find({ sessionId, wiringDiagramId: id }).sort({ capturedAt: -1 }).lean()
    : [];
  return { ...toDTO(doc), source: toDTO(src), measurementOverlays: toDTO(overlays) };
};

export const saveWiring = async (req, input) => {
  await assertSource(input.sourceId);
  const ids = new Set(input.components.map(c => c.id));
  for (const c of input.circuits) {
    if (!ids.has(c.from?.componentId) || !ids.has(c.to?.componentId)) throw badRequest(`Circuit ${c.name || c.id} references a missing component`);
  }
  const diagramId = input.diagramId || uuid();
  const latest = await WiringDiagram.findOne({ diagramId }).sort({ version: -1 }).lean();
  const doc = await WiringDiagram.create({ ...input, diagramId, version: (latest?.version || 0) + 1, status: 'draft', authoredBy: req.auth.userId });
  await audit(req, { eventType: 'WIRING_DRAFTED', category: 'data', entityType: 'WiringDiagram', entityId: diagramId, action: `Saved wiring diagram ${doc.title} v${doc.version}` });
  return toDTO(doc);
};

export const publishWiring = async (req, id) => {
  const doc = await WiringDiagram.findOne({ id, status: 'draft' }).lean();
  if (!doc) throw notFound('Draft diagram');
  if (doc.authoredBy === req.auth.userId) throw forbidden('Another reviewer must publish this diagram');
  await WiringDiagram.updateMany({ diagramId: doc.diagramId, status: 'published' }, { $set: { status: 'retired' } });
  const out = await WiringDiagram.findOneAndUpdate({ id }, { $set: { status: 'published', reviewedBy: req.auth.userId, publishedAt: new Date() } }, { new: true }).lean();
  await audit(req, { eventType: 'WIRING_PUBLISHED', category: 'data', entityType: 'WiringDiagram', entityId: doc.diagramId, action: `Published ${doc.title} v${doc.version}` });
  return toDTO(out);
};

// ---------------------------------------------------------------------------
// Diagnostic sessions
// ---------------------------------------------------------------------------
export const getSession = async (auth, roIdOrNumber, { create = false } = {}) => {
  const ro = await findRoForAccess(auth, roIdOrNumber);
  let session = await DiagnosticSession.findOne({ roId: ro.id }).sort({ createdAt: -1 }).lean();
  if (!session && create) {
    session = (await DiagnosticSession.create({ roId: ro.id, vehicleId: ro.vehicleId, locationId: ro.locationId, techId: auth.userId, concernIds: ro.concerns.map(c => c.id) })).toObject();
    if (['checked_in', 'inspecting'].includes(ro.status)) {
      await RepairOrder.updateOne({ id: ro.id }, { $set: { status: 'diagnosing' }, $inc: { __v: 1 }, $push: { timeline: timelineEvent(auth, 'diagnosis', 'Diagnosis started', true) } });
    }
  }
  if (!session) return { ro, session: null, measurements: [] };
  const measurements = await Measurement.find({ sessionId: session.id }).sort({ capturedAt: -1 }).lean();
  return { ro, session: toDTO(session), measurements: toDTO(measurements) };
};

const loadOpenSession = async (auth, sessionId) => {
  const s = await DiagnosticSession.findOne({ id: sessionId }).lean();
  if (!s) throw notFound('Diagnostic session');
  const ro = await findRoForAccess(auth, s.roId);
  return { s, ro };
};

export const recordScan = async (req, sessionId, { phase, source, dtcs = [], modulesScanned = [], evidenceId, notes, deviceId, commandId }) => {
  const { s, ro } = await loadOpenSession(req.auth, sessionId);
  if (source === 'device' && !commandId) throw badRequest('Device scans are recorded from AutoMind command results');
  const scanId = uuid();
  const records = dtcs.map(d => ({
    id: uuid(), code: d.code.toUpperCase().trim(), description: d.description || '',
    descriptionSource: d.description ? (source === 'device' ? 'device' : 'technician') : 'none',
    module: d.module || '', status: d.status || 'active',
    source: source === 'device' ? 'device_scan' : source === 'scan_report' ? 'scan_report' : 'manual_entry',
    deviceId, scanId, freezeFrame: d.freezeFrame || [],
    freezeFrameSource: d.freezeFrame?.length ? (source === 'device' ? 'device' : source === 'scan_report' ? 'scan_report' : 'manual_entry') : 'none',
    capturedBy: req.auth.userId
  }));
  await DiagnosticSession.updateOne({ id: s.id }, {
    $push: {
      scans: { id: scanId, phase: phase || 'pre_repair', source, deviceId, commandId, by: req.auth.userId, dtcCodes: records.map(r => r.code), modulesScanned, evidenceId, notes },
      ...(phase === 'post_repair' ? {} : { dtcs: { $each: records } })
    },
    $inc: { __v: 1 }
  });
  await audit(req, { eventType: 'DIAGNOSTIC_SCAN_RECORDED', entityType: 'DiagnosticSession', entityId: s.id, locationId: ro.locationId, action: `${phase || 'pre_repair'} scan (${source}): ${records.map(r => r.code).join(', ') || 'no codes'}` });
  if (phase !== 'post_repair' && records.length) {
    const { enqueueJob } = await import('./jobService.js');
    await enqueueJob('fix.comeback_check', { vehicleId: ro.vehicleId, roId: ro.id, dtcCodes: records.map(r => r.code) }, `comeback:${ro.id}:${scanId}`);
  }
  return (await getSession(req.auth, ro.id)).session;
};

export const recordMeasurement = async (req, sessionId, input) => {
  const { s, ro } = await loadOpenSession(req.auth, sessionId);
  if (input.clientId) {
    const dup = await Measurement.findOne({ clientId: input.clientId }).lean();
    if (dup) return toDTO(dup);
  }
  if (input.method === 'visual' && input.classification !== 'observation') throw badRequest('Visual checks are recorded as observations');
  if (input.method === 'device_reading' && !input.deviceCommandId) throw badRequest('Device readings must come from an AutoMind command result');
  const vehicle = await Vehicle.findOne({ id: ro.vehicleId }).lean();
  let evaluation = { result: 'not_evaluated', reason: 'Only authoritative measurements are evaluated against specifications', engineVersion: SPEC_ENGINE_VERSION };
  let specSnapshot;
  if (input.classification === 'authoritative') {
    const r = await evaluateMeasurement({ specificationId: input.specificationId, value: input.value, unit: input.unit, vehicle });
    evaluation = r.evaluation;
    if (r.spec) specSnapshot = { min: r.spec.minValue, max: r.spec.maxValue, nominal: r.spec.nominalValue, tolerance: r.spec.tolerance, unit: r.spec.unit, comparison: r.spec.comparison, sourceId: r.spec.sourceId, sourceVersion: r.spec.sourceVersion };
  }
  const m = await Measurement.create({ ...input, sessionId: s.id, roId: ro.id, vehicleId: ro.vehicleId, specSnapshot, evaluation, capturedBy: req.auth.userId, capturedByName: req.auth.user.name });
  return toDTO(m.toObject());
};

export const startProcedure = async (req, sessionId, { procedureDocId }) => {
  const { s, ro } = await loadOpenSession(req.auth, sessionId);
  const proc = await DiagnosticProcedure.findOne({ id: procedureDocId, status: 'published' }).lean();
  if (!proc) throw notFound('Published procedure');
  const vehicle = await Vehicle.findOne({ id: ro.vehicleId }).lean();
  if (!applies(proc.applicability, vehicle)) throw unprocessable('This procedure does not apply to the vehicle');
  if (s.procedureRuns.some(r => r.procedureId === proc.procedureId && r.status === 'active')) throw conflict('This procedure is already running');
  const run = { id: uuid(), procedureId: proc.procedureId, procedureVersion: proc.version, procedureDocId: proc.id, status: 'active', currentNodeKey: proc.startNodeKey, startedBy: req.auth.userId };
  await DiagnosticSession.updateOne({ id: s.id }, { $push: { procedureRuns: run }, $inc: { __v: 1 } });
  return (await getSession(req.auth, ro.id)).session;
};

// Advances a procedure run. Pass/fail on test nodes with a spec is taken from
// the linked authoritative measurement, never from free choice.
export const advanceProcedure = async (req, sessionId, runId, { result, optionLabel, measurementId, notes }) => {
  const { s, ro } = await loadOpenSession(req.auth, sessionId);
  const run = s.procedureRuns.find(r => r.id === runId && r.status === 'active');
  if (!run) throw notFound('Active procedure run');
  const proc = await DiagnosticProcedure.findOne({ id: run.procedureDocId }).lean();
  const node = proc.nodes.find(n => n.key === run.currentNodeKey);
  let outcome = result;
  if (node.specificationId && ['test', 'verify'].includes(node.type)) {
    if (!measurementId) throw badRequest('Record the measurement for this test step');
    const m = await Measurement.findOne({ id: measurementId, sessionId: s.id }).lean();
    if (!m) throw notFound('Measurement');
    if (m.specificationId !== node.specificationId || m.evaluation.result === 'not_evaluated') throw unprocessable(`Measurement could not be evaluated against this step's specification: ${m.evaluation.reason}`);
    outcome = m.evaluation.result;
  }
  let next;
  if (node.type === 'question') {
    const opt = node.options.find(o => o.label === optionLabel);
    if (!opt) throw badRequest('Choose one of the step options');
    next = opt.next;
    outcome = 'option';
  } else if (['test', 'inspection', 'verify'].includes(node.type)) {
    if (!['pass', 'fail'].includes(outcome)) throw badRequest('Result must be pass or fail');
    next = outcome === 'pass' ? node.onPass : node.onFail;
  } else {
    outcome = outcome === 'escalated' ? 'escalated' : 'done';
    next = node.onPass;
  }
  const done = !next || node.type === 'end' || outcome === 'escalated';
  await DiagnosticSession.updateOne({ id: s.id, 'procedureRuns.id': runId }, {
    $push: { 'procedureRuns.$.path': { nodeKey: node.key, at: new Date(), by: req.auth.userId, result: outcome, optionLabel, measurementId, notes } },
    $set: { 'procedureRuns.$.currentNodeKey': done ? null : next, 'procedureRuns.$.status': done ? 'completed' : 'active' },
    $inc: { __v: 1 }
  });
  return (await getSession(req.auth, ro.id)).session;
};

export const escalate = async (req, sessionId, { to, reason }) => {
  const { s, ro } = await loadOpenSession(req.auth, sessionId);
  await DiagnosticSession.updateOne({ id: s.id }, { $push: { escalations: { id: uuid(), at: new Date(), by: req.auth.userId, to, reason, status: 'open' } }, $inc: { __v: 1 } });
  await notifyRoles(ro.locationId, ['manager'], { type: 'diagnostic_escalation', severity: 'warning', title: `Diagnostic help requested on ${ro.roNumber}`, body: reason, link: `#/app/ro/${ro.id}` });
  await audit(req, { eventType: 'DIAGNOSTIC_ESCALATED', entityType: 'DiagnosticSession', entityId: s.id, locationId: ro.locationId, action: `Escalated to ${to || 'manager'}`, reason });
  return (await getSession(req.auth, ro.id)).session;
};

export const conclude = async (req, sessionId, { rootCause, component, correction, measurementIds = [], evidenceIds = [] }) => {
  const { s, ro } = await loadOpenSession(req.auth, sessionId);
  if (!rootCause || !correction) throw badRequest('Root cause and correction are required');
  await DiagnosticSession.updateOne({ id: s.id }, {
    $set: { status: 'concluded', conclusion: { rootCause, component, correction, dtcCodes: s.dtcs.filter(d => d.status !== 'history').map(d => d.code), confirmedBy: req.auth.userId, at: new Date(), measurementIds, evidenceIds } },
    $inc: { __v: 1 }
  });
  await audit(req, { eventType: 'DIAGNOSIS_CONCLUDED', entityType: 'DiagnosticSession', entityId: s.id, locationId: ro.locationId, action: `Root cause: ${rootCause}` });
  return (await getSession(req.auth, ro.id)).session;
};

// Post-repair verification. A passed verification with codes cleared becomes
// a Confirmed Fix candidate (verified repair evidence, not opinion).
export const verifyRepair = async (req, sessionId, { postRepairScanId, roadTestPerformed, roadTestNotes }) => {
  const { s, ro } = await loadOpenSession(req.auth, sessionId);
  if (s.status !== 'concluded') throw unprocessable('Record the diagnosis conclusion before verification');
  const scan = s.scans.find(x => x.id === postRepairScanId && x.phase === 'post_repair');
  if (!scan) throw badRequest('Select a post-repair scan');
  const original = s.conclusion.dtcCodes || [];
  const remaining = original.filter(c => scan.dtcCodes.includes(c));
  const passed = remaining.length === 0;
  const settings = await CorporateSettings.findOne({ key: 'corporate' }).lean();
  await withTransaction(async (session) => {
    await DiagnosticSession.updateOne({ id: s.id }, {
      $set: { status: passed ? 'verified' : 'concluded', verification: { postRepairScanId, dtcsRemaining: remaining, roadTestPerformed, roadTestNotes, result: passed ? 'passed' : 'failed', verifiedBy: req.auth.userId, at: new Date() } },
      $inc: { __v: 1 }
    }, { session });
    if (passed && original.length) {
      const vehicle = await Vehicle.findOne({ id: ro.vehicleId }).session(session).lean();
      const parts = await InstalledPart.find({ roId: ro.id }).session(session).lean();
      const pre = s.scans.find(x => x.phase === 'pre_repair');
      await ConfirmedFix.create([{
        dtcCodes: original,
        symptoms: ro.concerns.map(c => c.text),
        vehicle: { vehicleId: vehicle.id, year: vehicle.year, make: vehicle.make, model: vehicle.model, engine: vehicle.engine },
        rootCause: s.conclusion.rootCause, component: s.conclusion.component, correction: s.conclusion.correction,
        partsReplaced: parts.map(p => ({ partId: p.partId, partNumber: p.partNumber, description: p.description, installedPartId: p.id })),
        laborOpCodes: ro.jobs.filter(j => j.laborOpCode).map(j => j.laborOpCode),
        source: { roId: ro.id, roNumber: ro.roNumber, sessionId: s.id, locationId: ro.locationId },
        evidence: { preRepairScanId: pre?.id, postRepairScanId, dtcsBefore: original, dtcsAfter: scan.dtcCodes, measurementIds: s.conclusion.measurementIds, evidenceIds: s.conclusion.evidenceIds, roadTestPerformed },
        technicianId: s.conclusion.confirmedBy,
        status: settings?.confirmedFixRequiresApproval === false ? 'verified' : 'candidate',
        comebackWindowDays: settings?.comebackWindowDays || 90
      }], { session });
    }
    await audit(req, { eventType: 'REPAIR_VERIFIED', entityType: 'DiagnosticSession', entityId: s.id, locationId: ro.locationId, action: `Post-repair verification ${passed ? 'passed' : `failed (${remaining.join(', ')} still present)`}` }, session);
  });
  return (await getSession(req.auth, ro.id)).session;
};

// ---------------------------------------------------------------------------
// Evidence-ranked causes (deterministic, explainable)
// ---------------------------------------------------------------------------
export const rankCauses = async (auth, sessionId) => {
  const { s, ro } = await loadOpenSession(auth, sessionId);
  const vehicle = await Vehicle.findOne({ id: ro.vehicleId }).lean();
  const codes = [...new Set(s.dtcs.filter(d => d.status !== 'cleared').map(d => d.code))];
  const [fixes, measurements, findings, procedures] = await Promise.all([
    codes.length ? ConfirmedFix.find({ status: 'verified', dtcCodes: { $in: codes } }).lean() : [],
    Measurement.find({ sessionId: s.id, classification: 'authoritative', 'evaluation.result': 'fail' }).lean(),
    Finding.find({ roId: ro.id, status: 'active', condition: 'fail' }).lean(),
    codes.length ? DiagnosticProcedure.find({ status: 'published', dtcCodes: { $in: codes } }).lean() : []
  ]);
  const candidates = new Map();
  const add = (key, label, points, evidence) => {
    const k = (key || label || 'unknown').toLowerCase().trim();
    const c = candidates.get(k) || { component: key || label, cause: label, score: 0, evidence: [] };
    c.score += points;
    c.evidence.push(evidence);
    candidates.set(k, c);
  };
  for (const f of fixes) {
    const sameModel = eq(f.vehicle.make, vehicle.make) && eq(f.vehicle.model, vehicle.model);
    const overlap = f.dtcCodes.filter(c => codes.includes(c)).length;
    add(f.component || f.rootCause, f.rootCause, 2 * overlap + (sameModel ? 2 : 0), {
      type: 'confirmed_fix', ref: f.id,
      summary: `Verified repair on ${f.vehicle.year} ${f.vehicle.make} ${f.vehicle.model} (${f.source.roNumber}) with ${f.dtcCodes.join(', ')}${sameModel ? ' — same make/model' : ''}`
    });
  }
  for (const m of measurements) {
    add(m.component || m.parameter, `${m.component || m.parameter} out of specification`, 4, { type: 'measurement', ref: m.id, summary: m.evaluation.reason });
  }
  for (const f of findings) add(f.name, `${f.name} failed inspection`, 1, { type: 'finding', ref: f.id, summary: f.notes || f.name });
  for (const run of s.procedureRuns) {
    const proc = procedures.find(p => p.id === run.procedureDocId) || await DiagnosticProcedure.findOne({ id: run.procedureDocId }).lean();
    for (const step of run.path.filter(p => p.result === 'fail')) {
      const node = proc?.nodes.find(n => n.key === step.nodeKey);
      if (node?.component || node?.causeHint) add(node.component || node.causeHint, node.causeHint || `${node.component} failed test`, 3, { type: 'procedure_step', ref: `${run.id}:${step.nodeKey}`, summary: `${node.title}: failed` });
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score).map(c => ({
    ...c,
    confidence: c.score >= 8 && c.evidence.length >= 2 ? 'high' : c.score >= 4 ? 'medium' : 'low',
    basis: `Score ${c.score} from ${c.evidence.length} evidence item(s): verified fix match 2/DTC +2 same model, failed authoritative measurement 4, failed procedure step 3, failed inspection finding 1`
  }));

  // Next test: first untested step of an applicable published procedure that
  // targets a top candidate, or the active run's current step.
  let nextTest = null;
  const active = s.procedureRuns.find(r => r.status === 'active');
  if (active) {
    const proc = await DiagnosticProcedure.findOne({ id: active.procedureDocId }).lean();
    const node = proc?.nodes.find(n => n.key === active.currentNodeKey);
    if (node) nextTest = { procedureId: proc.id, nodeKey: node.key, title: node.title, reason: `Continue the active procedure "${proc.title}"` };
  } else {
    const top = ranked.slice(0, 2).map(r => r.component?.toLowerCase());
    for (const proc of procedures.filter(p => applies(p.applicability, vehicle))) {
      const node = proc.nodes.find(n => n.component && top.includes(n.component.toLowerCase()) && ['test', 'inspection'].includes(n.type));
      if (node) {
        nextTest = {
          procedureId: proc.id, nodeKey: node.key, title: node.title,
          reason: ranked.length > 1 ? `Tests "${node.component}", separating the top candidates (${ranked[0].component} vs ${ranked[1].component})` : `Confirms the leading candidate "${node.component}" before parts are replaced`
        };
        break;
      }
    }
    if (!nextTest && procedures.length) nextTest = { procedureId: procedures[0].id, nodeKey: procedures[0].startNodeKey, title: procedures[0].title, reason: `Published procedure for ${codes.join(', ')}` };
  }
  return {
    engineVersion: CAUSE_ENGINE_VERSION,
    dtcCodes: codes,
    candidates: ranked,
    nextTest,
    note: ranked.length ? 'Ranking reflects recorded evidence only; confirm with testing before replacing parts.' : 'Not enough recorded evidence to rank causes. Capture DTCs, measurements or run a procedure.'
  };
};
