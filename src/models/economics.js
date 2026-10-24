import { Schema, idField, baseOptions, centsField, currencyField, immutablePlugin, model } from './common.js';

// ---------------------------------------------------------------------------
// Economic ledger: one immutable event per economic fact, traceable to its
// source record. Corrections are compensating events (reversals), never edits.
// amountCents is signed: refunds/credits/reversals are negative.
// ---------------------------------------------------------------------------
export const ECONOMIC_CATEGORIES = ['revenue', 'direct_cost', 'overhead', 'customer_payment', 'customer_value', 'lifecycle'];
export const ECONOMIC_TYPES = [
  'membership_revenue', 'membership_refund', 'service_revenue', 'service_credit', 'service_debit', 'other_revenue',
  'customer_payment', 'customer_refund', 'payment_failed',
  'parts_cost', 'parts_credit', 'warranty_recovery', 'labor_cost', 'sublet_cost', 'towing_cost', 'other_direct_cost', 'referral_reward',
  'overhead_allocation', 'covered_retail_value', 'membership_lifecycle', 'reversal'
];
// EXACT: copied from a source record; DERIVED: computed from exact inputs and a
// configured rule; ESTIMATED: allocation or assumption; UNKNOWN: input missing.
export const DATA_QUALITY = ['EXACT', 'DERIVED', 'ESTIMATED', 'UNKNOWN'];

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
  source: { type: { type: String, required: true }, id: { type: String, required: true }, system: { type: String, default: 'futuretech' } },
  dedupeKey: { type: String, required: true, unique: true },
  quality: { type: String, enum: DATA_QUALITY, default: 'EXACT', index: true },
  complete: { type: Boolean, default: true },          // false when an input was missing
  incompleteReason: String,
  standardCostCents: { type: Number, default: null },  // expected cost, for variance
  calculationContext: Schema.Types.Mixed,
  reversesEventId: String,
  adjustmentId: String,
  createdBy: { type: String, default: 'system' }
}, baseOptions({ timestamps: { createdAt: true, updatedAt: false } }));
EconomicEventSchema.index({ 'attribution.vehicleId': 1, effectiveAt: 1 });
EconomicEventSchema.index({ 'attribution.membershipId': 1, effectiveAt: 1 });
EconomicEventSchema.index({ 'attribution.locationId': 1, effectiveAt: 1 });
EconomicEventSchema.index({ 'attribution.planId': 1, effectiveAt: 1 });
EconomicEventSchema.index({ 'attribution.customerId': 1, type: 1 });
EconomicEventSchema.index({ 'attribution.roId': 1 });
EconomicEventSchema.index({ 'source.type': 1, 'source.id': 1 });
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

// loaded rate = base wage × (1 + payroll burden + labor overhead) + benefits per hour,
// unless loadedRateCents is set explicitly.
const LaborRateSchema = new Schema({
  techId: String,
  baseWageCents: { type: Number, default: null },
  payrollBurdenBps: { type: Number, default: 0 },
  benefitsPerHourCents: { type: Number, default: 0 },
  laborOverheadBps: { type: Number, default: 0 },
  loadedRateCents: { type: Number, default: null }
}, { _id: false });

export const OVERHEAD_METHODS = ['none', 'percent_of_revenue', 'flat_per_repair_order', 'per_labor_hour', 'per_bay_hour', 'per_member_month', 'location_revenue_share', 'hybrid'];

const EconomicsConfigSchema = new Schema({
  id: idField,
  version: { type: Number, required: true, unique: true },
  effectiveFrom: { type: Date, required: true },
  currency: currencyField,
  defaultLoadedLaborRateCents: { type: Number, default: null }, // legacy single default
  labor: {
    default: { type: LaborRateSchema, default: () => ({}) },
    technicians: { type: [LaborRateSchema], default: [] }
  },
  overhead: {
    method: { type: String, enum: OVERHEAD_METHODS, default: 'none' },
    rateBps: { type: Number, default: 0 },
    flatCents: { type: Number, default: 0 },
    perLaborHourCents: { type: Number, default: 0 },
    perBayHourCents: { type: Number, default: 0 },
    perMemberMonthCents: { type: Number, default: 0 },
    locationMonthlyPools: { type: [new Schema({ locationId: String, monthlyCents: Number }, { _id: false })], default: [] },
    hybrid: { type: [new Schema({ method: { type: String, enum: OVERHEAD_METHODS }, weightBps: Number }, { _id: false })], default: [] }
  },
  reserveBps: { type: Number, default: 0 },
  defaultTargetMarginBps: { type: Number, default: 2000 },
  defaultWarningMarginBps: { type: Number, default: 1000 },
  lossToleranceBps: { type: Number, default: 0 },       // RED when margin < −tolerance
  adverseTrendBps: { type: Number, default: 2500 },     // YELLOW when recent cost run-rate rises this much
  majorRepairThresholdCents: { type: Number, default: null },
  preventiveCategories: { type: [String], default: ['Maintenance'] },
  referralRewardCents: { type: Number, default: null },
  membershipGraceDays: { type: Number, default: 15 },      // unpaid renewal -> past_due after this many days
  plans: { type: [PlanEconomicsSchema], default: [] },
  retailValueSource: { type: String, enum: ['estimate_extended_price'], default: 'estimate_extended_price' },
  qualificationRules: { type: [new Schema({ key: String, label: String, parameterPattern: String, unit: String, min: Number, max: Number }, { _id: false })], default: [] },
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
  riskModel: Schema.Types.Mixed,      // driver weights (merged over code defaults)
  alertThresholds: Schema.Types.Mixed,
  customerSeverity: Schema.Types.Mixed, // finding severity -> customer label/urgency/plain text
  rolledBackFromVersion: Number,
  notes: String,
  createdBy: String
}, baseOptions());
EconomicsConfigSchema.plugin(immutablePlugin);

// ---------------------------------------------------------------------------
// Risk snapshots (append-only history), alerts and interventions
// ---------------------------------------------------------------------------
export const BANDS = ['GREEN', 'YELLOW', 'ORANGE', 'RED'];

const RiskSnapshotSchema = new Schema({
  id: idField,
  subjectType: { type: String, enum: ['vehicle'], default: 'vehicle' },
  vehicleId: { type: String, required: true, index: true },
  customerId: String,
  membershipId: String,
  planId: String,
  locationId: { type: String, index: true },
  score: { type: Number, min: 0, max: 100, required: true },
  band: { type: String, enum: BANDS, required: true, index: true },
  profitabilityState: { type: String, enum: BANDS, index: true },
  stateReasons: { type: [String], default: [] },
  components: Schema.Types.Mixed,  // points per driver group
  confidence: { type: String, enum: ['low', 'medium', 'high'], required: true },
  confidenceBasis: String,
  modelVersion: { type: String, required: true },
  configVersion: Number,
  generatedAt: { type: Date, default: Date.now, index: true },
  horizons: { type: [new Schema({ days: Number, expectedDirectCostCents: Number, expectedVisits: Number }, { _id: false })], default: [] },
  majorRepairExposureCents: { type: Number, default: 0 },
  unscheduledVisitLikelihood: Number, // 0..1 from observed visit history
  projectedMarginPct: { type: Number, default: null },
  realizedMarginPct: { type: Number, default: null },
  predictions: Schema.Types.Mixed,    // majorRepairProbability, expectedAnnualLaborHours, expectedAnnualPartsCostCents, nextService
  nextLikelyServices: { type: [new Schema({ title: String, dueAt: Date, dueMileage: Number, estimatedAt: Date, signalId: String }, { _id: false })], default: [] },
  drivers: { type: [new Schema({ factor: String, group: String, points: Number, value: Schema.Types.Mixed, explanation: String }, { _id: false })], default: [] },
  features: Schema.Types.Mixed,       // feature snapshot used for this score
  limitations: { type: [String], default: [] },
  inputRefs: Schema.Types.Mixed,
  override: { band: String, profitabilityState: String, reason: String, by: String, at: Date },
  isLatest: { type: Boolean, default: true, index: true }
}, baseOptions());
RiskSnapshotSchema.plugin(immutablePlugin, { allowFields: ['isLatest', 'override', 'updatedAt'] });
RiskSnapshotSchema.index({ vehicleId: 1, isLatest: 1 });
RiskSnapshotSchema.index({ isLatest: 1, score: -1 });

export const ALERT_TRIGGERS = [
  'margin_below_warning', 'projected_margin_below_target', 'major_repair_probability', 'high_utilization',
  'dtc_recurrence_after_fix', 'preventive_opportunity', 'payment_past_due', 'payment_failures',
  'data_anomaly_mileage', 'data_anomaly_cost', 'data_anomaly_duplicate'
];

const HistorySchema = new Schema({ at: Date, by: String, from: String, to: String, note: String }, { _id: false });

const IntelAlertSchema = new Schema({
  id: idField,
  trigger: { type: String, enum: ALERT_TRIGGERS, required: true, index: true },
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'warning' },
  vehicleId: { type: String, index: true },
  membershipId: { type: String, index: true },
  customerId: String,
  planId: String,
  locationId: { type: String, index: true },
  title: { type: String, required: true },
  detail: String,
  recommendation: String,
  sourceRefs: { type: [new Schema({ type: String, id: String }, { _id: false })], default: [] },
  riskSnapshotId: String,
  status: { type: String, enum: ['open', 'acknowledged', 'resolved', 'dismissed'], default: 'open', index: true },
  falsePositive: { type: Boolean, default: false },
  ownerId: String,
  interventionId: String,
  dedupeKey: { type: String, unique: true, sparse: true },
  history: { type: [HistorySchema], default: [] }
}, baseOptions());

export const INTERVENTION_KINDS = [
  'preventive_service', 'diagnostic_recheck', 'parts_preorder', 'manager_case_review', 'billing_remediation',
  'customer_education', 'pricing_review', 'location_process_review',
  // earlier values kept for existing records
  'preventive_maintenance', 'diagnostic_followup', 'scheduling', 'procurement', 'management_review', 'customer_outreach'
];

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
  alertId: String,
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  dueAt: Date,
  ownerId: String,
  status: { type: String, enum: ['open', 'in_progress', 'resolved', 'dismissed'], default: 'open', index: true },
  resolutionNotes: String,
  estimatedImpactCents: { type: Number, default: null }, // labeled estimate, never booked
  outcome: {
    result: { type: String, enum: ['completed', 'customer_declined', 'no_effect', 'not_applicable'] },
    avoidedCostEstimateCents: Number, // estimate only, never reported as realized savings
    at: Date
  },
  resolvedAt: Date,
  dedupeKey: { type: String, unique: true, sparse: true },
  history: { type: [HistorySchema], default: [] },
  createdBy: String
}, baseOptions());

// Manual economic adjustments need a second person's approval before posting.
const EconomicAdjustmentSchema = new Schema({
  id: idField,
  type: { type: String, enum: ECONOMIC_TYPES, required: true },
  amountCents: Number,
  currency: currencyField,
  effectiveAt: Date,
  attribution: Schema.Types.Mixed,
  reversesEventId: String,
  quality: { type: String, enum: DATA_QUALITY, default: 'EXACT' },
  reason: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  requestedBy: { type: String, required: true },
  decidedBy: String,
  decidedAt: Date,
  decisionNote: String,
  eventId: String
}, baseOptions());

const ReferralSchema = new Schema({
  id: idField,
  referrerCustomerId: { type: String, required: true, index: true },
  referredCustomerId: String,
  referredName: { type: String, required: true },
  referredContact: String,
  locationId: String,
  status: { type: String, enum: ['pending', 'qualified', 'rewarded', 'declined'], default: 'pending', index: true },
  qualifyingMembershipId: String,
  rewardCents: centsField(),
  rewardedAt: Date,
  notes: String,
  createdBy: String
}, baseOptions());

export const EconomicEvent = model('EconomicEvent', EconomicEventSchema, 'economicevents');
export const EconomicsConfig = model('EconomicsConfig', EconomicsConfigSchema, 'economicsconfigs');
export const RiskSnapshot = model('RiskSnapshot', RiskSnapshotSchema, 'risksnapshots');
export const IntelAlert = model('IntelAlert', IntelAlertSchema, 'intelalerts');
export const Intervention = model('Intervention', InterventionSchema, 'interventions');
export const EconomicAdjustment = model('EconomicAdjustment', EconomicAdjustmentSchema, 'economicadjustments');
export const Referral = model('Referral', ReferralSchema, 'referrals');
