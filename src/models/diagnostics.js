import { Schema, idField, baseOptions, immutablePlugin, model } from './common.js';

export const ApplicabilitySchema = new Schema({
  makes: { type: [String], default: [] },
  models: { type: [String], default: [] },
  yearFrom: Number,
  yearTo: Number,
  engines: { type: [String], default: [] },
  notes: String
}, { _id: false });

// ---------------------------------------------------------------------------
// Technical data provenance and licensing
// ---------------------------------------------------------------------------
export const SOURCE_KINDS = [
  'oem_service_information', 'technical_service_bulletin', 'recall_database', 'licensed_aggregator',
  'public_regulatory', 'shop_authored', 'technician_measurement'
];

const TechnicalSourceSchema = new Schema({
  id: idField,
  name: { type: String, required: true },
  publisher: { type: String, default: '' },
  kind: { type: String, enum: SOURCE_KINDS, required: true },
  version: { type: String, required: true },
  effectiveFrom: Date,
  effectiveTo: Date,
  retrievedAt: Date,
  url: String,
  documentRef: String, // manual title / page / section for shop-authored transcriptions
  license: {
    licensor: String,
    agreementRef: String,
    permittedContexts: { type: [String], enum: ['technician', 'advisor', 'customer'], default: ['technician'] },
    cacheTtlHours: { type: Number, default: null },
    aiUseAllowed: { type: Boolean, default: false },
    redistributionAllowed: { type: Boolean, default: false },
    attribution: String,
    expiresAt: Date
  },
  status: { type: String, enum: ['active', 'expired', 'revoked'], default: 'active' },
  createdBy: String
}, baseOptions());

const SpecificationSchema = new Schema({
  id: idField,
  sourceId: { type: String, required: true, index: true },
  sourceVersion: { type: String, required: true },
  applicability: { type: ApplicabilitySchema, default: () => ({}) },
  system: { type: String, default: '' },
  component: { type: String, required: true },
  parameter: { type: String, required: true },
  unit: { type: String, required: true },
  comparison: { type: String, enum: ['range', 'min', 'max', 'nominal_tolerance'], default: 'range' },
  minValue: Number,
  maxValue: Number,
  nominalValue: Number,
  tolerance: Number,
  conditions: { type: String, default: '' },
  notes: { type: String, default: '' },
  status: { type: String, enum: ['draft', 'active', 'retired'], default: 'draft', index: true },
  enteredBy: String,
  reviewedBy: String,
  reviewedAt: Date
}, baseOptions());
SpecificationSchema.index({ component: 1, parameter: 1 });

const ProcedureNodeSchema = new Schema({
  key: { type: String, required: true },
  type: { type: String, enum: ['test', 'inspection', 'question', 'repair', 'verify', 'end'], required: true },
  title: { type: String, required: true },
  instructions: { type: String, default: '' },
  safetyNotes: { type: String, default: '' },
  component: String,
  causeHint: String,
  specificationId: String,
  measurement: { parameter: String, unit: String },
  testPointId: String,
  wiringDiagramId: String,
  onPass: String,
  onFail: String,
  options: { type: [new Schema({ label: String, next: String }, { _id: false })], default: [] }
}, { _id: false });

const DiagnosticProcedureSchema = new Schema({
  id: idField,
  procedureId: { type: String, required: true, index: true },
  version: { type: Number, required: true },
  title: { type: String, required: true },
  summary: { type: String, default: '' },
  applicability: { type: ApplicabilitySchema, default: () => ({}) },
  dtcCodes: { type: [String], default: [], index: true },
  symptoms: { type: [String], default: [] },
  sourceId: { type: String, required: true },
  sourceVersion: String,
  startNodeKey: { type: String, required: true },
  nodes: { type: [ProcedureNodeSchema], default: [] },
  status: { type: String, enum: ['draft', 'published', 'retired'], default: 'draft' },
  authoredBy: String,
  reviewedBy: String,
  publishedAt: Date
}, baseOptions());
DiagnosticProcedureSchema.index({ procedureId: 1, version: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// Diagnostic sessions (shares the original `diagnosticsessions` collection)
// ---------------------------------------------------------------------------
const FreezeFrameValueSchema = new Schema({ pid: String, name: String, value: Schema.Types.Mixed, unit: String }, { _id: false });

const DtcRecordSchema = new Schema({
  id: { type: String, required: true },
  code: { type: String, required: true, uppercase: true },
  description: { type: String, default: '' },
  descriptionSource: { type: String, enum: ['device', 'technician', 'licensed_source', 'none'], default: 'none' },
  module: { type: String, default: '' },
  status: { type: String, enum: ['active', 'pending', 'permanent', 'history', 'cleared'], default: 'active' },
  source: { type: String, enum: ['device_scan', 'manual_entry', 'scan_report'], required: true },
  deviceId: String,
  scanId: String,
  freezeFrame: { type: [FreezeFrameValueSchema], default: [] },
  freezeFrameSource: { type: String, enum: ['device', 'manual_entry', 'scan_report', 'none'], default: 'none' },
  capturedAt: { type: Date, default: Date.now },
  capturedBy: String
}, { _id: false });

const ScanSchema = new Schema({
  id: { type: String, required: true },
  phase: { type: String, enum: ['pre_repair', 'post_repair', 'other'], default: 'pre_repair' },
  source: { type: String, enum: ['device', 'manual_entry', 'scan_report'], required: true },
  deviceId: String,
  commandId: String,
  at: { type: Date, default: Date.now },
  by: String,
  dtcCodes: { type: [String], default: [] },
  modulesScanned: { type: [String], default: [] },
  evidenceId: String,
  notes: String
}, { _id: false });

const ProcedureRunSchema = new Schema({
  id: { type: String, required: true },
  procedureId: String,
  procedureVersion: Number,
  procedureDocId: String,
  status: { type: String, enum: ['active', 'completed', 'abandoned'], default: 'active' },
  currentNodeKey: String,
  startedAt: { type: Date, default: Date.now },
  startedBy: String,
  path: {
    type: [new Schema({
      nodeKey: String,
      at: Date,
      by: String,
      result: { type: String, enum: ['pass', 'fail', 'option', 'done', 'skipped', 'escalated'] },
      optionLabel: String,
      measurementId: String,
      notes: String
    }, { _id: false })],
    default: []
  }
}, { _id: false });

const DiagnosticSessionSchema = new Schema({
  id: idField,
  roId: { type: String, required: true, index: true },
  vehicleId: { type: String, index: true },
  locationId: String,
  techId: String,
  status: { type: String, enum: ['open', 'concluded', 'verified', 'abandoned'], default: 'open' },
  concernIds: { type: [String], default: [] },
  deviceId: String,
  dtcs: { type: [DtcRecordSchema], default: [] },
  scans: { type: [ScanSchema], default: [] },
  procedureRuns: { type: [ProcedureRunSchema], default: [] },
  escalations: {
    type: [new Schema({ id: String, at: Date, by: String, to: String, reason: String, status: { type: String, default: 'open' } }, { _id: false })],
    default: []
  },
  conclusion: {
    rootCause: String,
    component: String,
    correction: String,
    dtcCodes: [String],
    confirmedBy: String,
    at: Date,
    measurementIds: [String],
    evidenceIds: [String]
  },
  verification: {
    postRepairScanId: String,
    dtcsRemaining: [String],
    roadTestPerformed: Boolean,
    roadTestNotes: String,
    result: { type: String, enum: ['passed', 'failed'] },
    verifiedBy: String,
    at: Date
  },
  notes: { type: String, default: '' },
  // legacy prototype fields
  scanToolConnected: Boolean,
  protocol: String,
  ecuDetected: String,
  healthScore: Number,
  liveTelemetry: Schema.Types.Mixed,
  dtcCodes: Schema.Types.Mixed,
  guidedChecks: Schema.Types.Mixed,
  techDiagnosticNotes: String
}, baseOptions());

// Authoritative, comparative or observational measurement. Immutable.
const MeasurementSchema = new Schema({
  id: idField,
  sessionId: { type: String, index: true },
  roId: { type: String, index: true },
  vehicleId: { type: String, index: true },
  findingId: String,
  procedureRunId: String,
  nodeKey: String,
  wiringDiagramId: String,
  testPointId: String,
  component: { type: String, default: '' },
  parameter: { type: String, required: true },
  value: { type: Number, required: true },
  unit: { type: String, required: true },
  method: { type: String, enum: ['manual_meter', 'oscilloscope', 'scan_tool_pid', 'device_reading', 'pressure_gauge', 'precision_gauge', 'visual', 'other'], required: true },
  classification: { type: String, enum: ['authoritative', 'comparative', 'observation'], required: true },
  conditions: { type: String, default: '' },
  specificationId: String,
  specSnapshot: Schema.Types.Mixed,
  evaluation: {
    result: { type: String, enum: ['pass', 'fail', 'not_evaluated'], default: 'not_evaluated' },
    reason: String,
    engineVersion: String
  },
  deviceId: String,
  deviceCommandId: String,
  capturedBy: String,
  capturedByName: String,
  capturedAt: { type: Date, default: Date.now },
  evidenceIds: { type: [String], default: [] },
  clientId: { type: String, unique: true, sparse: true }
}, baseOptions());
MeasurementSchema.plugin(immutablePlugin);

// ---------------------------------------------------------------------------
// AutoMind devices, commands and telemetry
// ---------------------------------------------------------------------------
const DeviceSchema = new Schema({
  id: idField,
  serialNumber: { type: String, required: true, unique: true, trim: true },
  manufacturer: { type: String, default: 'AutoMind' },
  model: { type: String, default: '' },
  firmwareVersion: { type: String, default: '' },
  label: { type: String, default: '' },
  locationId: { type: String, index: true },
  status: { type: String, enum: ['registered', 'online', 'offline', 'disabled'], default: 'registered' },
  lastSeenAt: Date,
  ingestKeyEnc: { type: String, select: false }, // encrypted; devices HMAC-sign pushes with it
  capabilities: {
    discoveredAt: Date,
    protocols: { type: [String], default: [] },
    modules: { type: [String], default: [] },
    supportedPids: { type: [new Schema({ pid: String, name: String, unit: String }, { _id: false })], default: [] },
    commands: { type: [new Schema({ code: String, name: String, privileged: Boolean, description: String }, { _id: false })], default: [] }
  },
  registeredBy: String
}, baseOptions());

const DeviceCommandSchema = new Schema({
  id: idField,
  deviceId: { type: String, required: true, index: true },
  sessionId: { type: String, index: true },
  roId: String,
  vehicleId: String,
  command: { type: String, required: true },
  params: { type: Schema.Types.Mixed, default: {} },
  privileged: { type: Boolean, default: false },
  requestedBy: String,
  authorizedBy: String,
  authorizationReason: String,
  status: { type: String, enum: ['queued', 'sent', 'succeeded', 'failed', 'timeout', 'rejected', 'unavailable'], default: 'queued' },
  gatewayRef: String,
  result: Schema.Types.Mixed,
  error: String,
  requestedAt: { type: Date, default: Date.now },
  sentAt: Date,
  completedAt: Date
}, baseOptions());

const TelemetrySampleSchema = new Schema({
  deviceId: { type: String, required: true },
  sessionId: { type: String, index: true },
  vehicleId: { type: String, index: true },
  at: { type: Date, required: true },
  pid: { type: String, required: true },
  name: String,
  value: Schema.Types.Mixed,
  unit: String,
  expireAt: { type: Date, index: { expireAfterSeconds: 0 } }
}, { versionKey: false });
TelemetrySampleSchema.index({ sessionId: 1, pid: 1, at: 1 });
TelemetrySampleSchema.plugin(immutablePlugin);

// ---------------------------------------------------------------------------
// Interactive wiring diagrams (licensed or reviewed shop-authored tracings)
// ---------------------------------------------------------------------------
const PinSchema = new Schema({ id: String, number: String, label: String, circuitId: String }, { _id: false });
const ConnectorSchema = new Schema({ id: String, label: String, pins: [PinSchema] }, { _id: false });
const EndpointSchema = new Schema({ componentId: String, connectorId: String, pinId: String }, { _id: false });

const WiringDiagramSchema = new Schema({
  id: idField,
  diagramId: { type: String, required: true, index: true },
  version: { type: Number, required: true },
  title: { type: String, required: true },
  system: { type: String, default: '' },
  applicability: { type: ApplicabilitySchema, default: () => ({}) },
  sourceId: { type: String, required: true },
  sourceVersion: String,
  canvas: { width: { type: Number, default: 1200 }, height: { type: Number, default: 800 } },
  components: {
    type: [new Schema({
      id: String, label: String, type: { type: String },
      x: Number, y: Number, width: { type: Number, default: 140 }, height: { type: Number, default: 70 },
      connectors: [ConnectorSchema]
    }, { _id: false })],
    default: []
  },
  circuits: {
    type: [new Schema({
      id: String, name: String, function: String, wireColor: String, gauge: String,
      from: EndpointSchema, to: EndpointSchema,
      points: [new Schema({ x: Number, y: Number }, { _id: false })]
    }, { _id: false })],
    default: []
  },
  testPoints: {
    type: [new Schema({
      id: String, label: String, circuitId: String, componentId: String, connectorId: String, pinId: String,
      specificationId: String, instructions: String, x: Number, y: Number
    }, { _id: false })],
    default: []
  },
  status: { type: String, enum: ['draft', 'published', 'retired'], default: 'draft' },
  authoredBy: String,
  reviewedBy: String,
  publishedAt: Date,
  // legacy prototype fields
  vehicleMake: String,
  vehicleModel: String,
  nodes: Schema.Types.Mixed
}, baseOptions());
WiringDiagramSchema.index({ diagramId: 1, version: 1 }, { unique: true });

export const TechnicalSource = model('TechnicalSource', TechnicalSourceSchema, 'technicalsources');
export const Specification = model('Specification', SpecificationSchema, 'specifications');
export const DiagnosticProcedure = model('DiagnosticProcedure', DiagnosticProcedureSchema, 'diagnosticprocedures');
export const DiagnosticSession = model('DiagnosticSession', DiagnosticSessionSchema, 'diagnosticsessions');
export const Measurement = model('Measurement', MeasurementSchema, 'measurements');
export const Device = model('Device', DeviceSchema, 'devices');
export const DeviceCommand = model('DeviceCommand', DeviceCommandSchema, 'devicecommands');
export const TelemetrySample = model('TelemetrySample', TelemetrySampleSchema, 'telemetrysamples');
export const WiringDiagram = model('WiringDiagram', WiringDiagramSchema, 'wiringdiagrams');
