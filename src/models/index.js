import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// User Schema (with roles, MFA, session security)
export const UserSchema = new Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  role: { 
    type: String, 
    enum: ['advisor', 'technician', 'manager', 'parts', 'accounting', 'admin', 'customer'], 
    default: 'advisor' 
  },
  phone: String,
  specialty: String,
  avatar: String,
  mfaEnabled: { type: Boolean, default: false },
  mfaSecret: String,
  recoveryCodes: [String],
  createdAt: { type: Date, default: Date.now }
});

// Customer Schema (consent, membership, preferences)
export const CustomerSchema = new Schema({
  id: { type: String, required: true, unique: true },
  userId: String,
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  address: String,
  consent: {
    marketingSms: { type: Boolean, default: true },
    telematicsDataCollection: { type: Boolean, default: true },
    gdprConsentDate: { type: Date, default: Date.now }
  },
  membership: {
    tier: { type: String, default: 'Standard' },
    status: { type: String, default: 'active' },
    number: String,
    renewDate: String,
    benefits: [String],
    activeRiders: [String]
  },
  notes: String,
  createdAt: { type: Date, default: Date.now }
});

// Vehicle Schema (VIN, ownership, mileage log)
export const VehicleSchema = new Schema({
  id: { type: String, required: true, unique: true },
  customerId: { type: String, required: true },
  vin: { type: String, required: true, uppercase: true },
  make: { type: String, required: true },
  model: { type: String, required: true },
  year: { type: Number, required: true },
  trim: String,
  licensePlate: String,
  mileage: { type: Number, default: 0 },
  color: String,
  engine: String,
  healthScore: { type: Number, default: 100 },
  status: { type: String, default: 'active' },
  lastServiceDate: String,
  ownershipHistory: [{
    ownerCustomerId: String,
    ownerName: String,
    dateTransferred: Date
  }],
  mileageHistory: [{
    date: Date,
    odometer: Number,
    recordedSource: String
  }],
  createdAt: { type: Date, default: Date.now }
});

// Location Schema (multi-location, bays, tax rates)
export const LocationSchema = new Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  code: String,
  address: String,
  city: String,
  state: String,
  zip: String,
  phone: String,
  email: String,
  baysCount: Number,
  bays: [{
    id: String,
    name: String,
    type: String,
    occupiedRoId: String
  }],
  salesTaxRate: { type: Number, default: 0.0825 },
  laborRateStandard: { type: Number, default: 175.00 },
  laborRateDiagnostics: { type: Number, default: 195.00 },
  operatingHours: String
});

// Appointment Schema
export const AppointmentSchema = new Schema({
  id: { type: String, required: true, unique: true },
  appointmentNumber: { type: String, required: true },
  customerId: { type: String, required: true },
  vehicleId: { type: String, required: true },
  scheduledDate: { type: String, required: true },
  scheduledTime: { type: String, required: true },
  serviceRequested: String,
  status: { 
    type: String, 
    enum: ['scheduled', 'confirmed', 'checked_in', 'completed', 'cancelled'], 
    default: 'scheduled' 
  },
  assignedBay: String,
  assignedTechId: String,
  estimatedHours: Number,
  customerNotes: String,
  roId: String,
  createdAt: { type: Date, default: Date.now }
});

// Repair Order Schema
export const RepairOrderSchema = new Schema({
  id: { type: String, required: true, unique: true },
  roNumber: { type: String, required: true, unique: true },
  customerId: { type: String, required: true },
  vehicleId: { type: String, required: true },
  advisorId: String,
  assignedTechId: String,
  bayNumber: String,
  status: {
    type: String,
    enum: ['checked_in', 'in_inspection', 'estimate_pending', 'work_authorized', 'qc_review', 'ready_for_pickup', 'completed'],
    default: 'checked_in'
  },
  odometerIn: Number,
  fuelLevel: String,
  customerComplaints: [String],
  advisorNotes: String,
  targetCompletion: String,
  qcChecklist: [{ task: String, passed: Boolean, inspectedBy: String }],
  safetyEscalation: {
    flagged: { type: Boolean, default: false },
    reason: String,
    resolvedBy: String
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Inspection Schema (DVI with evidence & locked findings)
export const InspectionSchema = new Schema({
  id: { type: String, required: true, unique: true },
  roId: { type: String, required: true },
  vehicleId: String,
  techId: String,
  status: { type: String, enum: ['pending', 'in_progress', 'completed'], default: 'pending' },
  completedAt: Date,
  summary: {
    pass: { type: Number, default: 0 },
    attention: { type: Number, default: 0 },
    fail: { type: Number, default: 0 }
  },
  items: [{
    id: String,
    category: String,
    name: String,
    status: { type: String, enum: ['pass', 'attention', 'fail'] },
    finding: String,
    recommendation: String,
    photoUrl: String,
    measurements: [{
      label: String,
      value: Number,
      unit: String,
      minSpec: Number,
      maxSpec: Number,
      passed: Boolean
    }],
    locked: { type: Boolean, default: false }
  }]
});

// Estimate Schema (Versioned immutable snapshots)
export const EstimateSchema = new Schema({
  id: { type: String, required: true, unique: true },
  roId: { type: String, required: true },
  estimateNumber: { type: String, required: true },
  version: { type: Number, default: 1 },
  isLocked: { type: Boolean, default: false },
  status: { type: String, enum: ['draft', 'sent', 'approved', 'partially_approved', 'declined'], default: 'draft' },
  createdAt: { type: Date, default: Date.now },
  customerApprovedAt: Date,
  customerSignature: String,
  lines: [{
    id: String,
    type: { type: String, enum: ['labor', 'part'] },
    description: String,
    partNumber: String,
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number, default: 0 },
    laborHours: { type: Number, default: 0 },
    laborRate: { type: Number, default: 175.00 },
    approved: { type: Boolean, default: null },
    lineTotal: Number,
    notes: String
  }],
  summary: {
    subtotal: Number,
    memberDiscount: Number,
    tax: Number,
    shopSuppliesFee: Number,
    total: Number
  }
});

// Inventory Part Schema
export const InventorySchema = new Schema({
  id: { type: String, required: true, unique: true },
  partNumber: { type: String, required: true, unique: true },
  description: { type: String, required: true },
  category: String,
  brand: String,
  supplier: String,
  costPrice: Number,
  retailPrice: Number,
  stockQuantity: { type: Number, default: 0 },
  minStockLevel: { type: Number, default: 2 },
  binLocation: String,
  warrantyMonths: Number,
  failureStats: {
    totalInstalled: { type: Number, default: 0 },
    totalFailed: { type: Number, default: 0 },
    comebackRate: { type: String, default: '0.0%' }
  }
});

// Invoices & Payments Schema
export const InvoiceSchema = new Schema({
  id: { type: String, required: true, unique: true },
  invoiceNumber: { type: String, required: true, unique: true },
  roId: { type: String, required: true },
  customerId: String,
  vehicleId: String,
  lines: [{ description: String, amount: Number, note: String }],
  subtotal: Number,
  memberDiscount: Number,
  tax: Number,
  shopFee: Number,
  total: Number,
  amountPaid: { type: Number, default: 0 },
  paymentStatus: { type: String, enum: ['unpaid', 'partial', 'paid', 'refunded'], default: 'unpaid' },
  paymentMethod: String,
  paymentProviderTxId: String,
  paidAt: Date,
  financialAdjustments: [{
    type: { type: String, enum: ['discount', 'refund', 'credit'] },
    amount: Number,
    reason: String,
    authorizedBy: String,
    date: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

// Diagnostic Session Schema (FutureTech + AutoMind hardware)
export const DiagnosticSessionSchema = new Schema({
  id: { type: String, required: true, unique: true },
  roId: { type: String, required: true },
  vehicleId: String,
  scanToolConnected: { type: Boolean, default: true },
  protocol: String,
  ecuDetected: String,
  healthScore: Number,
  liveTelemetry: {
    batteryVoltage: Number,
    coolantTempF: Number,
    rpm: Number,
    oilPressurePsi: Number,
    fuelRailPsi: Number,
    shortTermFuelTrimPercent: String,
    ambientTempF: Number
  },
  dtcCodes: [{
    code: String,
    system: String,
    description: String,
    severity: { type: String, enum: ['critical', 'warning', 'advisory'] },
    status: { type: String, enum: ['active', 'pending', 'history'] },
    milTriggered: Boolean,
    freezeFrame: Schema.Types.Mixed,
    possibleCauses: [String]
  }],
  guidedChecks: [{
    id: String,
    stepNumber: Number,
    title: String,
    instructions: String,
    status: { type: String, enum: ['pending', 'passed', 'failed'] },
    technicianFindings: String,
    completedAt: Date
  }],
  techDiagnosticNotes: String
});

// Audit Log Schema (Append-Only)
export const AuditLogSchema = new Schema({
  id: { type: String, required: true, unique: true },
  timestamp: { type: Date, default: Date.now },
  eventType: { type: String, required: true },
  entityType: String,
  entityId: String,
  actorId: String,
  actorRole: String,
  action: { type: String, required: true },
  ipAddress: String
});

// Models export
export const User = mongoose.models?.User || model('User', UserSchema);
export const Customer = mongoose.models?.Customer || model('Customer', CustomerSchema);
export const Vehicle = mongoose.models?.Vehicle || model('Vehicle', VehicleSchema);
export const Location = mongoose.models?.Location || model('Location', LocationSchema);
export const Appointment = mongoose.models?.Appointment || model('Appointment', AppointmentSchema);
export const RepairOrder = mongoose.models?.RepairOrder || model('RepairOrder', RepairOrderSchema);
export const Inspection = mongoose.models?.Inspection || model('Inspection', InspectionSchema);
export const Estimate = mongoose.models?.Estimate || model('Estimate', EstimateSchema);
export const Inventory = mongoose.models?.Inventory || model('Inventory', InventorySchema);
export const Invoice = mongoose.models?.Invoice || model('Invoice', InvoiceSchema);
export const DiagnosticSession = mongoose.models?.DiagnosticSession || model('DiagnosticSession', DiagnosticSessionSchema);
export const AuditLog = mongoose.models?.AuditLog || model('AuditLog', AuditLogSchema);
