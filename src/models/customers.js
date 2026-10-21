import { Schema, idField, baseOptions, immutablePlugin, model } from './common.js';

export const CONSENT_TYPES = [
  'sms_transactional', 'sms_marketing', 'email_transactional', 'email_marketing',
  'telematics_collection', 'ai_assisted_communication', 'data_processing'
];

const ConsentEventSchema = new Schema({
  id: { type: String, required: true },
  type: { type: String, enum: CONSENT_TYPES, required: true },
  granted: { type: Boolean, required: true },
  at: { type: Date, default: Date.now },
  source: { type: String, enum: ['in_person', 'portal', 'phone', 'paper_form', 'import'], required: true },
  capturedBy: String,
  textVersion: String,
  note: String
}, { _id: false });

const CustomerSchema = new Schema({
  id: idField,
  type: { type: String, enum: ['individual', 'fleet'], default: 'individual' },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  companyName: { type: String, trim: true },
  phone: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  address: { type: String, trim: true, default: '' },
  preferredContact: { type: String, enum: ['sms', 'email', 'phone', 'portal'], default: 'sms' },
  homeLocationId: { type: String, index: true },
  userId: { type: String, index: true }, // portal account
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  tags: { type: [String], default: [] },
  // Append-only consent history; the latest event per type is the current state.
  consentEvents: { type: [ConsentEventSchema], default: [] },
  // Legacy prototype fields kept for compatibility
  consent: Schema.Types.Mixed,
  membership: Schema.Types.Mixed,
  notes: String,
  createdBy: String
}, baseOptions());

CustomerSchema.index({ name: 1 });
CustomerSchema.index({ phone: 1 });
CustomerSchema.index({ email: 1 });

const VehicleSchema = new Schema({
  id: idField,
  customerId: { type: String, index: true }, // current owner (denormalised from ownership history)
  vin: { type: String, uppercase: true, trim: true },
  year: Number,
  make: { type: String, trim: true },
  model: { type: String, trim: true },
  trim: { type: String, trim: true },
  engine: { type: String, trim: true },
  fuelType: String,
  bodyClass: String,
  driveType: String,
  transmission: String,
  decode: {
    source: { type: String, enum: ['nhtsa_vpic', 'manual', 'none'], default: 'none' },
    decodedAt: Date,
    errorCode: String,
    errorText: String
  },
  licensePlate: { type: String, uppercase: true, trim: true, default: '' },
  plateState: { type: String, uppercase: true, trim: true, default: '' },
  color: { type: String, trim: true, default: '' },
  mileage: { type: Number, default: 0, min: 0 }, // latest accepted odometer
  mileageUnit: { type: String, enum: ['mi', 'km'], default: 'mi' },
  status: { type: String, enum: ['active', 'sold', 'scrapped', 'archived'], default: 'active' },
  notes: String,
  // legacy prototype fields
  healthScore: Number,
  lastServiceDate: String,
  ownershipHistory: Schema.Types.Mixed,
  mileageHistory: Schema.Types.Mixed
}, baseOptions());

VehicleSchema.index({ vin: 1 }, { unique: true, partialFilterExpression: { vin: { $type: 'string' } } });
VehicleSchema.index({ licensePlate: 1 });

// VIN identity is the vehicle; ownership is a separate time-bounded relation.
const VehicleOwnershipSchema = new Schema({
  id: idField,
  vehicleId: { type: String, required: true, index: true },
  customerId: { type: String, required: true, index: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: Date,
  reason: { type: String, enum: ['initial_registration', 'purchase', 'transfer', 'correction'], default: 'initial_registration' },
  recordedBy: String,
  note: String
}, baseOptions());

const MileageRecordSchema = new Schema({
  id: idField,
  vehicleId: { type: String, required: true, index: true },
  odometer: { type: Number, required: true, min: 0 },
  unit: { type: String, enum: ['mi', 'km'], default: 'mi' },
  recordedAt: { type: Date, default: Date.now },
  source: { type: String, enum: ['ro_check_in', 'ro_check_out', 'appointment', 'customer', 'fuel', 'telemetry', 'manual_correction'], required: true },
  sourceRef: String,
  recordedBy: String,
  flagged: { type: Boolean, default: false }, // lower than a previous reading
  note: String
}, baseOptions());
MileageRecordSchema.plugin(immutablePlugin);

export const Customer = model('Customer', CustomerSchema, 'customers');
export const Vehicle = model('Vehicle', VehicleSchema, 'vehicles');
export const VehicleOwnership = model('VehicleOwnership', VehicleOwnershipSchema, 'vehicleownerships');
export const MileageRecord = model('MileageRecord', MileageRecordSchema, 'mileagerecords');
