import { Schema, idField, baseOptions, centsField, currencyField, immutablePlugin, model } from './common.js';

// ---------------------------------------------------------------------------
// Catalog: labor operations and fees
// ---------------------------------------------------------------------------
const LaborOperationSchema = new Schema({
  id: idField,
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  category: { type: String, default: 'General' },
  defaultHours: { type: Number, default: 1, min: 0 },
  rateType: { type: String, enum: ['standard', 'diagnostic', 'ev'], default: 'standard' },
  hoursSource: { type: String, enum: ['shop_policy', 'licensed_labor_guide'], default: 'shop_policy' },
  hoursSourceRef: String,
  active: { type: Boolean, default: true },
  createdBy: String
}, baseOptions());

const FeeSchema = new Schema({
  id: idField,
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  kind: { type: String, enum: ['flat', 'percent_of_labor', 'percent_of_parts'], required: true },
  amountCents: centsField(),
  rateBps: { type: Number, default: 0, min: 0, max: 10000 },
  minCents: centsField({ default: null }),
  maxCents: centsField({ default: null }),
  taxable: { type: Boolean, default: false },
  autoApply: { type: Boolean, default: false },
  locationIds: { type: [String], default: [] }, // empty = all locations
  active: { type: Boolean, default: true },
  createdBy: String
}, baseOptions());

// ---------------------------------------------------------------------------
// Memberships: plans and riders are immutable versions so every evaluation
// can be reproduced from the exact plan/rider version used at the time.
// ---------------------------------------------------------------------------
export const ENTITLEMENT_KINDS = ['labor_discount_bps', 'parts_discount_bps', 'free_diagnostic', 'included_service', 'waive_fee'];

const EntitlementSchema = new Schema({
  key: { type: String, required: true },
  kind: { type: String, enum: ENTITLEMENT_KINDS, required: true },
  description: { type: String, default: '' },
  valueBps: { type: Number, default: 0, min: 0, max: 10000 },
  laborOpCode: String,
  feeCode: String,
  period: { type: String, enum: ['per_visit', 'per_term', 'unlimited'], default: 'unlimited' },
  quantityPerPeriod: { type: Number, default: null },
  maxDiscountCents: { type: Number, default: null }
}, { _id: false });

const MembershipPlanSchema = new Schema({
  id: idField,              // id of this version document
  planId: { type: String, required: true, index: true },
  code: { type: String, required: true, uppercase: true },
  version: { type: Number, required: true },
  status: { type: String, enum: ['active', 'retired'], default: 'active' },
  name: { type: String, required: true },
  tier: { type: String, required: true },
  currency: currencyField,
  priceMonthlyCents: centsField(),
  priceAnnualCents: centsField(),
  termMonths: { type: Number, default: 12 },
  benefitsText: { type: [String], default: [] },
  entitlements: { type: [EntitlementSchema], default: [] },
  ridersAllowed: { type: [String], default: [] },
  effectiveFrom: { type: Date, default: Date.now },
  createdBy: String
}, baseOptions());
MembershipPlanSchema.index({ planId: 1, version: 1 }, { unique: true });
MembershipPlanSchema.plugin(immutablePlugin, { allowFields: ['status', 'updatedAt'] });

const ServiceRiderSchema = new Schema({
  id: idField,
  riderId: { type: String, required: true, index: true },
  code: { type: String, required: true, uppercase: true },
  version: { type: Number, required: true },
  status: { type: String, enum: ['active', 'retired'], default: 'active' },
  name: { type: String, required: true },
  currency: currencyField,
  priceMonthlyCents: centsField(),
  coverageText: { type: String, default: '' },
  entitlements: { type: [EntitlementSchema], default: [] },
  createdBy: String
}, baseOptions());
ServiceRiderSchema.index({ riderId: 1, version: 1 }, { unique: true });
ServiceRiderSchema.plugin(immutablePlugin, { allowFields: ['status', 'updatedAt'] });

const MembershipSchema = new Schema({
  id: idField,
  number: { type: String, required: true, unique: true },
  customerId: { type: String, required: true, index: true },
  vehicleIds: { type: [String], default: [] }, // empty = all vehicles owned by the customer
  planId: { type: String, required: true },
  planVersion: { type: Number, required: true },
  riders: { type: [new Schema({ riderId: String, version: Number, addedAt: Date }, { _id: false })], default: [] },
  status: { type: String, enum: ['pending_payment', 'active', 'past_due', 'cancelled', 'expired'], default: 'pending_payment', index: true },
  billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'annual' },
  startedAt: Date,
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  autoRenew: { type: Boolean, default: false },
  cancelledAt: Date,
  cancelReason: String,
  locationId: String,
  soldBy: String
}, baseOptions());

const EntitlementUsageSchema = new Schema({
  id: idField,
  membershipId: { type: String, required: true, index: true },
  entitlementKey: { type: String, required: true },
  periodKey: { type: String, required: true },
  quantity: { type: Number, default: 1 },
  valueCents: centsField(),
  roId: String,
  invoiceId: { type: String, index: true },
  estimateVersionId: String,
  status: { type: String, enum: ['consumed', 'reversed'], default: 'consumed' },
  reversedBy: String,
  reversedAt: Date
}, baseOptions());
EntitlementUsageSchema.index({ membershipId: 1, entitlementKey: 1, periodKey: 1 });

// ---------------------------------------------------------------------------
// Estimates, immutable versions and approvals
// ---------------------------------------------------------------------------
const EstimateLineSchema = new Schema({
  id: { type: String, required: true },
  kind: { type: String, enum: ['labor', 'part', 'fee', 'sublet'], required: true },
  jobGroup: { type: String, default: '' },
  description: { type: String, required: true, maxlength: 500 },
  laborOpCode: String,
  hours: Number,
  laborRateType: { type: String, enum: ['standard', 'diagnostic', 'ev'] },
  rateCents: Number,
  partId: String,
  partNumber: String,
  quantity: Number,
  unitPriceCents: Number,
  unitCostCents: Number,
  feeCode: String,
  taxable: Boolean,
  findingIds: { type: [String], default: [] },
  predictiveSignalId: String,
  safetyCritical: { type: Boolean, default: false },
  recommendationReason: { type: String, default: '' },
  sortOrder: { type: Number, default: 0 },
  // computed in versions
  extendedCents: Number,
  discountCents: Number,
  netCents: Number,
  taxCents: Number,
  totalCents: Number
}, { _id: false });

const EstimateSchema = new Schema({
  id: idField,
  estimateNumber: { type: String, required: true, unique: true },
  roId: { type: String, required: true, unique: true },
  customerId: String,
  vehicleId: String,
  locationId: { type: String, index: true },
  currency: currencyField,
  status: { type: String, enum: ['draft', 'presented', 'approved', 'partially_approved', 'declined'], default: 'draft' },
  draftLines: { type: [EstimateLineSchema], default: [] },
  draftDirty: { type: Boolean, default: false }, // draft differs from the current version
  currentVersionId: String,
  currentVersionNumber: { type: Number, default: 0 },
  presentedVersionId: String,
  presentedAt: Date,
  validUntil: Date,
  createdBy: String,
  // legacy prototype fields
  lines: Schema.Types.Mixed,
  summary: Schema.Types.Mixed
}, baseOptions());

const EstimateVersionSchema = new Schema({
  id: idField,
  estimateId: { type: String, required: true, index: true },
  roId: { type: String, required: true, index: true },
  versionNumber: { type: Number, required: true },
  reason: { type: String, enum: ['initial', 'revision', 'change_order'], default: 'initial' },
  changeSummary: { type: String, default: '' },
  previousVersionId: String,
  currency: currencyField,
  lines: { type: [EstimateLineSchema], default: [] },
  totals: {
    laborCents: Number,
    partsCents: Number,
    feesCents: Number,
    subletCents: Number,
    discountCents: Number,
    subtotalCents: Number,
    taxableCents: Number,
    taxCents: Number,
    totalCents: Number
  },
  pricingContext: Schema.Types.Mixed,
  membershipEvaluation: Schema.Types.Mixed,
  lineHashes: { type: Map, of: String },
  contentHash: { type: String, required: true },
  createdBy: String,
  createdByName: String
}, baseOptions());
EstimateVersionSchema.index({ estimateId: 1, versionNumber: 1 }, { unique: true });
EstimateVersionSchema.plugin(immutablePlugin);

const ApprovalSchema = new Schema({
  id: idField,
  estimateId: { type: String, required: true, index: true },
  estimateVersionId: { type: String, required: true, index: true },
  versionNumber: Number,
  versionHash: { type: String, required: true },
  roId: { type: String, required: true, index: true },
  customerId: String,
  decisions: {
    type: [new Schema({
      lineId: { type: String, required: true },
      lineHash: { type: String, required: true },
      decision: { type: String, enum: ['approved', 'declined'], required: true },
      declineReason: String
    }, { _id: false })],
    required: true
  },
  approvedTotalCents: centsField(),
  currency: currencyField,
  method: { type: String, enum: ['in_person_signature', 'portal', 'phone', 'email', 'sms_link'], required: true },
  approverName: { type: String, required: true },
  approverRelation: { type: String, enum: ['owner', 'authorized_agent', 'fleet_manager'], default: 'owner' },
  recordedBy: String,
  recordedByName: String,
  customerUserId: String,
  signatureEvidenceId: String,
  authorizationStatement: String,
  ip: String,
  userAgent: String,
  at: { type: Date, default: Date.now }
}, baseOptions());
ApprovalSchema.plugin(immutablePlugin);

export const LaborOperation = model('LaborOperation', LaborOperationSchema, 'laboroperations');
export const Fee = model('Fee', FeeSchema, 'fees');
export const MembershipPlan = model('MembershipPlan', MembershipPlanSchema, 'membershipplans');
export const ServiceRider = model('ServiceRider', ServiceRiderSchema, 'serviceriders');
export const Membership = model('Membership', MembershipSchema, 'memberships');
export const EntitlementUsage = model('EntitlementUsage', EntitlementUsageSchema, 'entitlementusages');
export const Estimate = model('Estimate', EstimateSchema, 'estimates');
export const EstimateVersion = model('EstimateVersion', EstimateVersionSchema, 'estimateversions');
export const Approval = model('Approval', ApprovalSchema, 'approvals');
