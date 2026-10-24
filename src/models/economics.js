import { Schema, idField, baseOptions, centsField, currencyField, immutablePlugin, model } from './common.js';

// ---------------------------------------------------------------------------
// Economic ledger: one immutable event per economic fact, traceable to its
// source record. Corrections are compensating events (reversals), never edits.
// amountCents is signed: refunds/credits/reversals are negative.
// ---------------------------------------------------------------------------
export const ECONOMIC_CATEGORIES = ['revenue', 'direct_cost', 'overhead', 'customer_payment', 'customer_value'];
export const ECONOMIC_TYPES = [
  'membership_revenue', 'membership_refund',
  'service_revenue', 'service_credit', 'service_debit',
  'customer_payment', 'customer_refund',
  'parts_cost', 'labor_cost', 'sublet_cost', 'other_direct_cost',
  'overhead_allocation', 'covered_retail_value', 'reversal'
];

const EconomicEventSchema = new Schema({
  id: idField,
  type: { type: String, enum: ECONOMIC_TYPES, required: true, index: true },
  category: { type: String, enum: ECONOMIC_CATEGORIES, required: true, index: true },
  amountCents: { type: Number, required: true, validate: { validator: Number.isSafeInteger, message: 'integer cents' } },
  currency: currencyField,
  effectiveAt: { type: Date, required: true, index: true },
  attribution: {
    customerId: String,
    vehicleId: String,
    membershipId: String,
    planId: String,
    locationId: String,
    roId: String,
    invoiceId: String,
    serviceCategory: String,
    technicianId: String,
    cohort: String // membership start month (YYYY-MM)
  },
  source: { type: { type: String, required: true }, id: { type: String, required: true } },
  dedupeKey: { type: String, required: true, unique: true },
  complete: { type: Boolean, default: true },          // false when an input was missing
  incompleteReason: String,
  standardCostCents: { type: Number, default: null },  // expected cost, for variance
  calculationContext: Schema.Types.Mixed,
  reversesEventId: String,
  createdBy: { type: String, default: 'system' }
}, baseOptions({ timestamps: { createdAt: true, updatedAt: false } }));
EconomicEventSchema.index({ 'attribution.vehicleId': 1, effectiveAt: 1 });
EconomicEventSchema.index({ 'attribution.membershipId': 1, effectiveAt: 1 });
EconomicEventSchema.index({ 'attribution.locationId': 1, effectiveAt: 1 });
EconomicEventSchema.index({ 'attribution.planId': 1, effectiveAt: 1 });
EconomicEventSchema.index({ 'attribution.roId': 1 });
EconomicEventSchema.plugin(immutablePlugin);

// ---------------------------------------------------------------------------
// Effective-dated economics configuration (immutable versions)
// ---------------------------------------------------------------------------
const PlanEconomicsSchema = new Schema({
  planId: { type: String, required: true },
  expectedAnnualDirectCostCents: { type: Number, default: null }, // utilization baseline
  expectedAnnualVisits: { type: Number, default: null },
  targetMarginBps: { type: Number, default: null },
  warningMarginBps: { type: Number, default: null },
  minTenureMonthsForEligibility: { type: Number, default: 0 }
}, { _id: false });

const EconomicsConfigSchema = new Schema({
  id: idField,
  version: { type: Number, required: true, unique: true },
  effectiveFrom: { type: Date, required: true },
  currency: currencyField,
  defaultLoadedLaborRateCents: { type: Number, default: null }, // used when a technician has no rate
  overhead: {
    method: { type: String, enum: ['none', 'percent_of_revenue', 'flat_per_repair_order'], default: 'none' },
    rateBps: { type: Number, default: 0 },
    flatCents: { type: Number, default: 0 }
  },
  reserveBps: { type: Number, default: 0 },
  defaultTargetMarginBps: { type: Number, default: 2000 },
  defaultWarningMarginBps: { type: Number, default: 1000 },
  plans: { type: [PlanEconomicsSchema], default: [] },
  retailValueSource: { type: String, enum: ['estimate_extended_price'], default: 'estimate_extended_price' },
  forecast: {
    horizonsDays: { type: [Number], default: [30, 90, 180, 365] },
    historyWindowDays: { type: Number, default: 730 },
    minHistoryDaysForMedium: { type: Number, default: 180 },
    minVisitsForMedium: { type: Number, default: 2 },
    minHistoryDaysForHigh: { type: Number, default: 365 },
    minVisitsForHigh: { type: Number, default: 4 }
  },
  riskBands: {
    type: [new Schema({ band: { type: String, enum: ['GREEN', 'YELLOW', 'ORANGE', 'RED'] }, minScore: Number }, { _id: false })],
    default: [{ band: 'GREEN', minScore: 0 }, { band: 'YELLOW', minScore: 35 }, { band: 'ORANGE', minScore: 55 }, { band: 'RED', minScore: 75 }]
  },
  notes: String,
  createdBy: String
}, baseOptions());
EconomicsConfigSchema.plugin(immutablePlugin);

// ---------------------------------------------------------------------------
// Risk snapshots (append-only history) and interventions
// ---------------------------------------------------------------------------
const RiskSnapshotSchema = new Schema({
  id: idField,
  subjectType: { type: String, enum: ['vehicle'], default: 'vehicle' },
  vehicleId: { type: String, required: true, index: true },
  customerId: String,
  membershipId: String,
  planId: String,
  locationId: { type: String, index: true },
  score: { type: Number, min: 0, max: 100, required: true },
  band: { type: String, enum: ['GREEN', 'YELLOW', 'ORANGE', 'RED'], required: true, index: true },
  confidence: { type: String, enum: ['low', 'medium', 'high'], required: true },
  confidenceBasis: String,
  modelVersion: { type: String, required: true },
  configVersion: Number,
  generatedAt: { type: Date, default: Date.now, index: true },
  horizons: { type: [new Schema({ days: Number, expectedDirectCostCents: Number, expectedVisits: Number }, { _id: false })], default: [] },
  majorRepairExposureCents: { type: Number, default: 0 },
  unscheduledVisitLikelihood: Number, // 0..1 from observed visit history
  projectedMarginPct: { type: Number, default: null },
  nextLikelyServices: { type: [new Schema({ title: String, dueAt: Date, dueMileage: Number, signalId: String }, { _id: false })], default: [] },
  drivers: { type: [new Schema({ factor: String, points: Number, value: Schema.Types.Mixed, explanation: String }, { _id: false })], default: [] },
  inputRefs: Schema.Types.Mixed,
  isLatest: { type: Boolean, default: true, index: true }
}, baseOptions());
RiskSnapshotSchema.plugin(immutablePlugin, { allowFields: ['isLatest', 'updatedAt'] });
RiskSnapshotSchema.index({ vehicleId: 1, isLatest: 1 });

export const INTERVENTION_KINDS = ['preventive_maintenance', 'diagnostic_followup', 'scheduling', 'procurement', 'management_review', 'customer_outreach'];

const InterventionSchema = new Schema({
  id: idField,
  subjectType: { type: String, enum: ['vehicle', 'membership', 'plan', 'location'], required: true },
  subjectId: { type: String, required: true },
  customerId: String,
  vehicleId: { type: String, index: true },
  membershipId: String,
  planId: String,
  locationId: { type: String, index: true },
  kind: { type: String, enum: INTERVENTION_KINDS, required: true },
  recommendedAction: { type: String, required: true },
  reason: { type: String, required: true },
  riskSnapshotId: String,
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  dueAt: Date,
  ownerId: String,
  status: { type: String, enum: ['open', 'in_progress', 'resolved', 'dismissed'], default: 'open', index: true },
  resolutionNotes: String,
  estimatedImpactCents: { type: Number, default: null }, // labeled estimate, never booked
  dedupeKey: { type: String, unique: true, sparse: true },
  history: { type: [new Schema({ at: Date, by: String, from: String, to: String, note: String }, { _id: false })], default: [] },
  createdBy: String
}, baseOptions());

export const EconomicEvent = model('EconomicEvent', EconomicEventSchema, 'economicevents');
export const EconomicsConfig = model('EconomicsConfig', EconomicsConfigSchema, 'economicsconfigs');
export const RiskSnapshot = model('RiskSnapshot', RiskSnapshotSchema, 'risksnapshots');
export const Intervention = model('Intervention', InterventionSchema, 'interventions');
