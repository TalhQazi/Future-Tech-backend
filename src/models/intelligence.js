import { Schema, idField, baseOptions, centsField, sourceRefSubdoc, model } from './common.js';

// ---------------------------------------------------------------------------
// Confirmed Fix: created only from a verified repair outcome on a real RO.
// ---------------------------------------------------------------------------
const ConfirmedFixSchema = new Schema({
  id: idField,
  status: { type: String, enum: ['candidate', 'verified', 'rejected', 'comeback'], default: 'candidate', index: true },
  dtcCodes: { type: [String], default: [], index: true },
  symptoms: { type: [String], default: [] },
  vehicle: {
    vehicleId: String,
    year: Number,
    make: String,
    model: String,
    engine: String
  },
  rootCause: { type: String, required: true },
  component: { type: String, default: '' },
  correction: { type: String, required: true },
  partsReplaced: { type: [new Schema({ partId: String, partNumber: String, description: String, installedPartId: String }, { _id: false })], default: [] },
  laborOpCodes: { type: [String], default: [] },
  laborHours: Number,
  source: {
    roId: { type: String, required: true },
    roNumber: String,
    sessionId: { type: String, required: true },
    locationId: String
  },
  evidence: {
    preRepairScanId: String,
    postRepairScanId: String,
    dtcsBefore: [String],
    dtcsAfter: [String],
    measurementIds: [String],
    evidenceIds: [String],
    roadTestPerformed: Boolean
  },
  technicianId: String,
  verifiedBy: String,
  verifiedAt: Date,
  rejectedBy: String,
  rejectionReason: String,
  comebackWindowDays: { type: Number, default: 90 },
  comebackRoId: String,
  comebackDetectedAt: Date
}, baseOptions());

// ---------------------------------------------------------------------------
// Parts intelligence: installed parts, failures, warranty
// ---------------------------------------------------------------------------
const InstalledPartSchema = new Schema({
  id: idField,
  partId: { type: String, required: true, index: true },
  partNumber: String,
  description: String,
  brand: String,
  supplierId: String,
  supplierName: String,
  lotNumber: String,
  serialNumber: String,
  roId: { type: String, index: true },
  jobId: String,
  vehicleId: { type: String, index: true },
  locationId: String,
  quantity: { type: Number, default: 1 },
  unitCostCents: centsField(),
  installedAt: { type: Date, default: Date.now },
  odometer: Number,
  techId: String,
  warrantyMonths: Number,
  warrantyMiles: Number,
  status: { type: String, enum: ['in_service', 'failed', 'removed'], default: 'in_service' },
  inventoryTransactionId: String
}, baseOptions());

const PartFailureSchema = new Schema({
  id: idField,
  installedPartId: { type: String, required: true, index: true },
  partId: { type: String, index: true },
  supplierId: String,
  lotNumber: String,
  vehicleId: String,
  originalRoId: String,
  comebackRoId: String,
  failedAt: { type: Date, default: Date.now },
  odometer: Number,
  daysInService: Number,
  milesInService: Number,
  failureMode: { type: String, required: true },
  determination: { type: String, enum: ['defective_part', 'installation_error', 'misdiagnosis', 'external_cause', 'undetermined'], default: 'undetermined' },
  withinWarranty: Boolean,
  warrantyClaim: {
    status: { type: String, enum: ['none', 'submitted', 'approved', 'denied'], default: 'none' },
    claimNumber: String,
    creditCents: centsField(),
    submittedAt: Date,
    resolvedAt: Date,
    notes: String
  },
  recordedBy: String,
  evidenceIds: { type: [String], default: [] }
}, baseOptions());

// ---------------------------------------------------------------------------
// Technician Forum
// ---------------------------------------------------------------------------
const ForumThreadSchema = new Schema({
  id: idField,
  title: { type: String, required: true, maxlength: 200 },
  body: { type: String, required: true, maxlength: 20000 },
  category: { type: String, default: 'Diagnostics' },
  tags: { type: [String], default: [] },
  context: {
    make: String,
    model: String,
    yearFrom: Number,
    yearTo: Number,
    engine: String,
    dtcCodes: { type: [String], default: [] },
    roId: String,       // internal link only; never shown with customer PII
    sessionId: String
  },
  authorId: { type: String, required: true },
  authorName: String,
  authorRole: String,
  status: { type: String, enum: ['open', 'solved', 'locked'], default: 'open' },
  acceptedReplyId: String,
  linkedConfirmedFixId: String,
  evidenceIds: { type: [String], default: [] },
  views: { type: Number, default: 0 },
  voteCount: { type: Number, default: 0 },
  replyCount: { type: Number, default: 0 },
  lastActivityAt: { type: Date, default: Date.now }
}, baseOptions());
ForumThreadSchema.index({ 'context.dtcCodes': 1 });
ForumThreadSchema.index({ title: 'text', body: 'text', tags: 'text' });

const ForumReplySchema = new Schema({
  id: idField,
  threadId: { type: String, required: true, index: true },
  body: { type: String, required: true, maxlength: 20000 },
  authorId: { type: String, required: true },
  authorName: String,
  authorRole: String,
  evidenceIds: { type: [String], default: [] },
  voteCount: { type: Number, default: 0 },
  isAccepted: { type: Boolean, default: false },
  editedAt: Date
}, baseOptions());

const ForumVoteSchema = new Schema({
  userId: { type: String, required: true },
  targetType: { type: String, enum: ['thread', 'reply'], required: true },
  targetId: { type: String, required: true }
}, { timestamps: true, versionKey: false });
ForumVoteSchema.index({ userId: 1, targetType: 1, targetId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// Fuel economy
// ---------------------------------------------------------------------------
const FuelEventSchema = new Schema({
  id: idField,
  vehicleId: { type: String, required: true, index: true },
  customerId: String,
  at: { type: Date, required: true },
  odometer: { type: Number, required: true, min: 0 },
  volume: { type: Number, required: true, min: 0 },
  volumeUnit: { type: String, enum: ['gal', 'L'], default: 'gal' },
  fullTank: { type: Boolean, default: true },
  costCents: centsField({ default: null }),
  currency: { type: String, default: 'USD' },
  source: { type: String, enum: ['customer_portal', 'staff', 'telemetry'], default: 'staff' },
  recordedBy: String,
  economy: {
    milesSinceLastFull: Number,
    volumeSinceLastFull: Number,
    mpg: Number
  },
  anomaly: {
    flagged: { type: Boolean, default: false },
    baselineMpg: Number,
    baselineSamples: Number,
    deviationPct: Number,
    ruleVersion: String,
    explanation: String
  }
}, baseOptions());
FuelEventSchema.index({ vehicleId: 1, odometer: 1 });

// ---------------------------------------------------------------------------
// Predictive maintenance: versioned deterministic rules and their signals
// ---------------------------------------------------------------------------
const PredictiveRuleSchema = new Schema({
  id: idField,
  key: { type: String, required: true },
  version: { type: Number, required: true },
  name: { type: String, required: true },
  kind: { type: String, enum: ['maintenance_interval', 'declined_finding_followup', 'repeat_dtc', 'fuel_economy_anomaly', 'part_warranty_expiry'], required: true },
  parameters: { type: Schema.Types.Mixed, default: {} },
  active: { type: Boolean, default: true },
  createdBy: String
}, baseOptions());
PredictiveRuleSchema.index({ key: 1, version: 1 }, { unique: true });

const PredictiveSignalSchema = new Schema({
  id: idField,
  vehicleId: { type: String, required: true, index: true },
  customerId: String,
  ruleKey: { type: String, required: true },
  ruleVersion: { type: Number, required: true },
  dedupeKey: { type: String, unique: true },
  title: { type: String, required: true },
  recommendation: { type: String, required: true },
  reason: { type: String, required: true },
  evidence: { type: [new Schema({ type: { type: String }, ref: { type: String }, summary: { type: String } }, { _id: false })], default: [] },
  confidence: { type: String, enum: ['low', 'medium', 'high'], required: true },
  uncertainty: { type: String, default: '' },
  dueAt: Date,
  dueMileage: Number,
  status: { type: String, enum: ['open', 'added_to_estimate', 'dismissed', 'expired'], default: 'open', index: true },
  decidedBy: String,
  decidedAt: Date,
  decisionNote: String,
  estimateLineId: String
}, baseOptions());

// ---------------------------------------------------------------------------
// AI governance: every model invocation is recorded with its provenance
// ---------------------------------------------------------------------------
const AiExecutionSchema = new Schema({
  id: idField,
  task: { type: String, enum: ['service_writer', 'repair_explanation', 'summarize_findings', 'diagnostic_suggestion'], required: true, index: true },
  status: { type: String, enum: ['succeeded', 'blocked_by_policy', 'provider_unavailable', 'failed'], required: true },
  provider: String,
  model: String,
  modelVersion: String,
  promptVersion: { type: String, required: true },
  inputHash: { type: String, required: true },
  sourceRefs: { type: [sourceRefSubdoc], default: [] },
  roId: { type: String, index: true },
  vehicleId: String,
  locationId: String,
  structuredOutput: Schema.Types.Mixed,
  confidence: { type: String, enum: ['low', 'medium', 'high', null], default: null },
  policyDecision: {
    allowed: Boolean,
    violations: { type: [String], default: [] },
    checks: { type: [String], default: [] }
  },
  review: {
    status: { type: String, enum: ['pending', 'approved', 'edited', 'rejected'], default: 'pending' },
    reviewerId: String,
    reviewerName: String,
    editedOutput: Schema.Types.Mixed,
    notes: String,
    at: Date
  },
  usage: { inputTokens: Number, outputTokens: Number, latencyMs: Number },
  error: String,
  requestedBy: String
}, baseOptions());

export const ConfirmedFix = model('ConfirmedFix', ConfirmedFixSchema, 'confirmedfixes');
export const InstalledPart = model('InstalledPart', InstalledPartSchema, 'installedparts');
export const PartFailure = model('PartFailure', PartFailureSchema, 'partfailures');
export const ForumThread = model('ForumThread', ForumThreadSchema, 'forumthreads');
export const ForumReply = model('ForumReply', ForumReplySchema, 'forumreplies');
export const ForumVote = model('ForumVote', ForumVoteSchema, 'forumvotes');
export const FuelEvent = model('FuelEvent', FuelEventSchema, 'fuelevents');
export const PredictiveRule = model('PredictiveRule', PredictiveRuleSchema, 'predictiverules');
export const PredictiveSignal = model('PredictiveSignal', PredictiveSignalSchema, 'predictivesignals');
export const AiExecution = model('AiExecution', AiExecutionSchema, 'aiexecutions');
