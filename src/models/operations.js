import { Schema, idField, baseOptions, centsField, model } from './common.js';

export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'arrived', 'checked_in', 'completed', 'no_show', 'cancelled'];

const AppointmentSchema = new Schema({
  id: idField,
  appointmentNumber: { type: String, required: true, unique: true },
  locationId: { type: String, required: true, index: true },
  customerId: { type: String, required: true, index: true },
  vehicleId: { type: String, required: true, index: true },
  startAt: { type: Date, required: true, index: true },
  durationMinutes: { type: Number, default: 60, min: 15, max: 24 * 60 },
  scheduledDate: String, // location-local YYYY-MM-DD (derived, kept for compatibility)
  scheduledTime: String, // location-local HH:mm
  serviceRequested: { type: String, default: '' },
  laborOpCodes: { type: [String], default: [] },
  concerns: { type: [String], default: [] },
  customerNotes: { type: String, default: '' },
  status: { type: String, enum: APPOINTMENT_STATUSES, default: 'scheduled', index: true },
  source: { type: String, enum: ['staff', 'portal', 'phone'], default: 'staff' },
  transportation: { type: String, enum: ['wait', 'drop_off', 'loaner', 'shuttle', 'unknown'], default: 'unknown' },
  assignedBay: String, // bay id
  assignedTechId: String,
  estimatedHours: Number,
  roId: String,
  cancelledReason: String,
  cancelledBy: String,
  createdBy: String
}, baseOptions());
AppointmentSchema.index({ locationId: 1, startAt: 1 });

export const RO_STATUSES = [
  'checked_in', 'inspecting', 'diagnosing', 'awaiting_approval', 'approved',
  'in_progress', 'waiting_parts', 'quality_check', 'ready_for_pickup', 'closed', 'cancelled'
];
export const RO_OPEN_STATUSES = RO_STATUSES.filter(s => !['closed', 'cancelled'].includes(s));

const ConcernSchema = new Schema({
  id: { type: String, required: true },
  text: { type: String, required: true, maxlength: 2000 },
  source: { type: String, enum: ['customer', 'advisor', 'technician', 'inspection'], default: 'customer' },
  cause: { type: String, default: '' },
  correction: { type: String, default: '' },
  createdBy: String,
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const JobSchema = new Schema({
  id: { type: String, required: true },
  title: { type: String, required: true },
  groupKey: String,
  estimateLineIds: { type: [String], default: [] },
  laborOpCode: String,
  soldHours: { type: Number, default: 0 },
  status: { type: String, enum: ['authorized', 'in_progress', 'paused', 'completed', 'verified', 'cancelled'], default: 'authorized' },
  techId: String,
  authorizedByApprovalId: String,
  authorizedVersionId: String,
  startedAt: Date,
  completedAt: Date,
  completedBy: String,
  completionNotes: { type: String, default: '' },
  completionEvidenceIds: { type: [String], default: [] },
  verifiedBy: String,
  verifiedAt: Date
}, { _id: false });

const SafetyEscalationSchema = new Schema({
  id: { type: String, required: true },
  severity: { type: String, enum: ['critical', 'high'], required: true },
  description: { type: String, required: true },
  findingId: String,
  raisedBy: String,
  raisedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['open', 'acknowledged', 'customer_notified', 'customer_declined', 'repair_authorized', 'resolved'], default: 'open' },
  acknowledgedBy: String,
  acknowledgedAt: Date,
  customerNotifiedBy: String,
  customerNotifiedAt: Date,
  customerNotificationMethod: String,
  customerDecision: {
    decision: { type: String, enum: ['repair', 'declined'] },
    recordedBy: String,
    at: Date,
    signatureEvidenceId: String,
    note: String
  },
  resolution: String,
  resolvedBy: String,
  resolvedAt: Date
}, { _id: false });

const TimelineEventSchema = new Schema({
  at: { type: Date, default: Date.now },
  type: { type: String, required: true },
  by: String,
  byName: String,
  summary: { type: String, required: true },
  customerVisible: { type: Boolean, default: false }
}, { _id: false });

const RepairOrderSchema = new Schema({
  id: idField,
  roNumber: { type: String, required: true, unique: true },
  locationId: { type: String, required: true, index: true },
  customerId: { type: String, required: true, index: true },
  vehicleId: { type: String, required: true, index: true },
  appointmentId: String,
  advisorId: String,
  assignedTechId: { type: String, index: true },
  techIds: { type: [String], default: [] },
  bayId: String,
  status: { type: String, enum: RO_STATUSES, default: 'checked_in', index: true },
  priority: { type: String, enum: ['normal', 'high', 'urgent'], default: 'normal' },
  odometerIn: Number,
  odometerOut: Number,
  fuelLevel: String,
  keyTag: String,
  waiter: { type: Boolean, default: false },
  transportation: { type: String, default: 'unknown' },
  promisedAt: Date,
  preauthorizedCents: centsField(), // customer pre-authorised spend (e.g. diagnostic time)
  concerns: { type: [ConcernSchema], default: [] },
  advisorNotes: { type: String, default: '' },
  jobs: { type: [JobSchema], default: [] },
  safetyEscalations: { type: [SafetyEscalationSchema], default: [] },
  qc: {
    status: { type: String, enum: ['not_started', 'passed', 'failed'], default: 'not_started' },
    checklist: { type: [new Schema({ item: String, passed: Boolean, note: String }, { _id: false })], default: [] },
    roadTestPerformed: Boolean,
    inspectedBy: String,
    at: Date,
    notes: String
  },
  timeline: { type: [TimelineEventSchema], default: [] },
  estimateId: String,
  invoiceId: String,
  closedAt: Date,
  closedBy: String,
  cancelledReason: String,
  createdBy: String
}, baseOptions());
RepairOrderSchema.index({ locationId: 1, status: 1, updatedAt: -1 });

const TimeEntrySchema = new Schema({
  id: idField,
  techId: { type: String, required: true, index: true },
  locationId: { type: String, required: true },
  roId: { type: String, index: true },
  jobId: String,
  type: { type: String, enum: ['job', 'diagnostic', 'shop', 'training'], default: 'job' },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  startAt: { type: Date, required: true },
  endAt: Date,
  minutes: { type: Number, default: 0 },
  note: String,
  correctedBy: String,
  correctionReason: String
}, baseOptions());
TimeEntrySchema.index({ techId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });

export const Appointment = model('Appointment', AppointmentSchema, 'appointments');
export const RepairOrder = model('RepairOrder', RepairOrderSchema, 'repairorders');
export const TimeEntry = model('TimeEntry', TimeEntrySchema, 'timeentries');
