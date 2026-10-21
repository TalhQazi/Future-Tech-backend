import { Schema, idField, baseOptions, immutablePlugin, model } from './common.js';

const TemplateItemSchema = new Schema({
  key: { type: String, required: true },
  name: { type: String, required: true },
  measurementHints: { type: [new Schema({ label: String, unit: String }, { _id: false })], default: [] }
}, { _id: false });

const InspectionTemplateSchema = new Schema({
  id: idField,
  name: { type: String, required: true },
  version: { type: Number, default: 1 },
  status: { type: String, enum: ['active', 'retired'], default: 'active' },
  sections: {
    type: [new Schema({ key: String, name: String, items: [TemplateItemSchema] }, { _id: false })],
    default: []
  },
  createdBy: String
}, baseOptions());

const InspectionSchema = new Schema({
  id: idField,
  roId: { type: String, required: true, index: true },
  vehicleId: String,
  locationId: String,
  templateId: String,
  templateVersion: Number,
  techId: String,
  status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
  startedAt: Date,
  completedAt: Date,
  completedBy: String,
  summary: {
    pass: { type: Number, default: 0 },
    attention: { type: Number, default: 0 },
    fail: { type: Number, default: 0 },
    notInspected: { type: Number, default: 0 }
  },
  items: Schema.Types.Mixed // legacy embedded items from the prototype
}, baseOptions());

export const FINDING_CONDITIONS = ['ok', 'attention', 'fail', 'not_inspected'];
export const FINDING_SEVERITIES = ['safety', 'repair', 'maintenance', 'monitor'];

const FindingMeasurementSchema = new Schema({
  label: String,
  value: Number,
  unit: String,
  measurementId: String // authoritative Measurement document, when captured as one
}, { _id: false });

const FindingSchema = new Schema({
  id: idField,
  inspectionId: { type: String, required: true, index: true },
  roId: { type: String, required: true, index: true },
  vehicleId: { type: String, index: true },
  locationId: String,
  itemKey: String,
  category: { type: String, default: 'General' },
  name: { type: String, required: true },
  condition: { type: String, enum: FINDING_CONDITIONS, default: 'not_inspected' },
  severity: { type: String, enum: [...FINDING_SEVERITIES, null], default: null },
  notes: { type: String, default: '' },
  recommendation: { type: String, default: '' },
  measurements: { type: [FindingMeasurementSchema], default: [] },
  evidenceIds: { type: [String], default: [] },
  locked: { type: Boolean, default: false },
  lockedAt: Date,
  lockedBy: String,
  status: { type: String, enum: ['active', 'superseded'], default: 'active' },
  supersedesId: String,
  supersededById: String,
  correctionReason: String,
  customerDecision: { type: String, enum: ['none', 'approved', 'declined', 'deferred'], default: 'none' },
  createdBy: String,
  updatedBy: String
}, baseOptions());
FindingSchema.index({ roId: 1, status: 1 });

// Evidence objects are immutable. A correction is a new object that supersedes
// the old one; only the supersession pointer may be written afterwards.
const EvidenceSchema = new Schema({
  id: idField,
  kind: { type: String, enum: ['photo', 'video', 'audio', 'document', 'scan_report', 'signature'], required: true },
  contentType: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  sha256: { type: String, required: true, index: true },
  storage: {
    driver: { type: String, required: true },
    key: { type: String, required: true }
  },
  originalName: String,
  caption: { type: String, default: '' },
  roId: { type: String, index: true },
  vehicleId: { type: String, index: true },
  findingId: { type: String, index: true },
  inspectionId: String,
  sessionId: String,
  forumThreadId: String,
  locationId: String,
  visibility: { type: String, enum: ['internal', 'customer'], default: 'customer' },
  capturedAt: { type: Date, default: Date.now },
  capturedBy: String,
  capturedByName: String,
  clientId: { type: String, unique: true, sparse: true }, // offline queue de-duplication
  supersedesId: String,
  supersededById: String,
  status: { type: String, enum: ['current', 'superseded'], default: 'current' }
}, baseOptions());
EvidenceSchema.plugin(immutablePlugin, { allowFields: ['status', 'supersededById', 'updatedAt'] });

export const InspectionTemplate = model('InspectionTemplate', InspectionTemplateSchema, 'inspectiontemplates');
export const Inspection = model('Inspection', InspectionSchema, 'inspections');
export const Finding = model('Finding', FindingSchema, 'findings');
export const Evidence = model('Evidence', EvidenceSchema, 'evidence');
