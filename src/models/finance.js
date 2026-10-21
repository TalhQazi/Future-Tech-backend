import { Schema, idField, baseOptions, centsField, currencyField, immutablePlugin, model } from './common.js';

const InvoiceLineSchema = new Schema({
  id: { type: String, required: true },
  kind: { type: String, enum: ['labor', 'part', 'fee', 'sublet', 'membership'], required: true },
  description: { type: String, required: true },
  quantity: Number,
  hours: Number,
  unitPriceCents: Number,
  extendedCents: Number,
  discountCents: Number,
  netCents: Number,
  taxCents: Number,
  totalCents: Number,
  unitCostCents: Number,
  estimateVersionId: String,
  estimateLineId: String,
  approvalId: String,
  jobId: String,
  partId: String,
  laborOpCode: String
}, { _id: false });

export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'overpaid', 'refunded', 'written_off'];

// Posted invoices are never edited or deleted. Balances move only through
// payments, refunds and financial adjustments, each its own record.
const InvoiceSchema = new Schema({
  id: idField,
  invoiceNumber: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['repair_order', 'membership'], default: 'repair_order' },
  roId: { type: String, index: true },
  membershipId: String,
  customerId: { type: String, index: true },
  vehicleId: String,
  locationId: { type: String, index: true },
  currency: currencyField,
  status: { type: String, enum: ['draft', 'posted', 'voided'], default: 'draft', index: true },
  lineItems: { type: [InvoiceLineSchema], default: [] },
  totals: {
    laborCents: centsField(),
    partsCents: centsField(),
    feesCents: centsField(),
    subletCents: centsField(),
    discountCents: centsField(),
    subtotalCents: centsField(),
    taxCents: centsField(),
    totalCents: centsField()
  },
  sourceEstimateVersionIds: { type: [String], default: [] },
  approvalIds: { type: [String], default: [] },
  membershipEvaluation: Schema.Types.Mixed,
  paidCents: centsField(),
  refundedCents: centsField(),
  creditsCents: centsField(),
  debitsCents: centsField(),
  balanceCents: centsField(),
  paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid', index: true },
  postedAt: Date,
  postedBy: String,
  businessDate: String,
  voidedAt: Date,
  voidedBy: String,
  voidReason: String,
  createdBy: String,
  // legacy prototype fields
  lines: Schema.Types.Mixed,
  subtotal: Number,
  memberDiscount: Number,
  tax: Number,
  shopFee: Number,
  total: Number,
  amountPaid: Number,
  paymentMethod: String,
  paymentProviderTxId: String,
  paidAt: Date,
  financialAdjustments: Schema.Types.Mixed
}, baseOptions());

export const PAYMENT_METHODS = ['cash', 'check', 'card_terminal', 'card_online', 'ach', 'fleet_account'];

const PaymentSchema = new Schema({
  id: idField,
  receiptNumber: { type: String, required: true, unique: true },
  invoiceId: { type: String, required: true, index: true },
  customerId: String,
  locationId: { type: String, index: true },
  currency: currencyField,
  amountCents: centsField({ required: true, min: 1 }),
  refundedCents: centsField(),
  method: { type: String, enum: PAYMENT_METHODS, required: true },
  provider: { type: String, enum: ['manual', 'stripe'], default: 'manual' },
  providerRef: String,       // check number, terminal approval code, PaymentIntent id
  providerStatus: String,
  cardBrand: String,
  cardLast4: String,          // only ever from the provider, never typed card data
  status: { type: String, enum: ['pending', 'succeeded', 'failed', 'cancelled'], default: 'pending', index: true },
  receivedBy: String,
  receivedByName: String,
  receivedAt: Date,
  businessDate: { type: String, index: true },
  note: String,
  failureReason: String
}, baseOptions());

const RefundSchema = new Schema({
  id: idField,
  refundNumber: { type: String, required: true, unique: true },
  paymentId: { type: String, required: true, index: true },
  invoiceId: { type: String, required: true, index: true },
  locationId: String,
  currency: currencyField,
  amountCents: centsField({ required: true, min: 1 }),
  reason: { type: String, required: true },
  method: String,
  provider: { type: String, enum: ['manual', 'stripe'], default: 'manual' },
  providerRef: String,
  status: { type: String, enum: ['pending_approval', 'approved', 'processing', 'succeeded', 'failed', 'rejected'], default: 'pending_approval', index: true },
  requestedBy: String,
  requestedByName: String,
  approvedBy: String,
  approvedAt: Date,
  rejectedBy: String,
  rejectionReason: String,
  processedAt: Date,
  businessDate: String,
  failureReason: String
}, baseOptions());

const FinancialAdjustmentSchema = new Schema({
  id: idField,
  invoiceId: { type: String, required: true, index: true },
  locationId: String,
  type: { type: String, enum: ['credit_memo', 'debit_memo', 'write_off', 'goodwill', 'reversal'], required: true },
  direction: { type: String, enum: ['credit', 'debit'], required: true }, // credit lowers the balance
  amountCents: centsField({ required: true, min: 1 }),
  currency: currencyField,
  reason: { type: String, required: true },
  reversesAdjustmentId: String,
  createdBy: String,
  createdByName: String,
  approvedBy: String,
  businessDate: String,
  at: { type: Date, default: Date.now }
}, baseOptions());
FinancialAdjustmentSchema.plugin(immutablePlugin);

const ReconciliationSchema = new Schema({
  id: idField,
  locationId: { type: String, required: true },
  businessDate: { type: String, required: true },
  currency: currencyField,
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  expected: { type: Map, of: Number, default: {} },   // method -> cents from payments - refunds
  counted: { type: Map, of: Number, default: {} },    // method -> cents counted / settled
  variance: { type: Map, of: Number, default: {} },
  paymentIds: { type: [String], default: [] },
  refundIds: { type: [String], default: [] },
  notes: String,
  closedBy: String,
  closedAt: Date
}, baseOptions());
ReconciliationSchema.index({ locationId: 1, businessDate: 1 }, { unique: true });

export const Invoice = model('Invoice', InvoiceSchema, 'invoices');
export const Payment = model('Payment', PaymentSchema, 'payments');
export const Refund = model('Refund', RefundSchema, 'refunds');
export const FinancialAdjustment = model('FinancialAdjustment', FinancialAdjustmentSchema, 'financialadjustments');
export const Reconciliation = model('Reconciliation', ReconciliationSchema, 'reconciliations');
