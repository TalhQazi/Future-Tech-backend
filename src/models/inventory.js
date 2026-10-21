import { Schema, idField, baseOptions, centsField, currencyField, immutablePlugin, model } from './common.js';

const isInt = { validator: Number.isSafeInteger, message: 'Quantities are whole units' };

// Part catalog. Shares the original `inventories` collection; the prototype's
// float dollar fields and location-less stock count are kept as legacy fields.
const PartSchema = new Schema({
  id: idField,
  partNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
  description: { type: String, required: true, trim: true },
  category: { type: String, default: 'General' },
  brand: { type: String, default: '' },
  manufacturerPartNumber: { type: String, default: '' },
  supplierId: String,
  supplier: { type: String, default: '' },
  unitOfMeasure: { type: String, default: 'each' },
  unitCostCents: centsField(),
  listPriceCents: centsField(),
  coreChargeCents: centsField(),
  taxable: { type: Boolean, default: true },
  warrantyMonths: { type: Number, default: null },
  warrantyMiles: { type: Number, default: null },
  active: { type: Boolean, default: true },
  // legacy prototype fields
  costPrice: Number,
  retailPrice: Number,
  stockQuantity: Number,
  minStockLevel: Number,
  binLocation: String,
  warrantyMonthsLegacy: Number,
  failureStats: Schema.Types.Mixed,
  legacyStockAssignedAt: Date,
  legacyStockAssignedTo: String
}, baseOptions());

const SupplierSchema = new Schema({
  id: idField,
  name: { type: String, required: true, trim: true },
  accountNumber: String,
  contactName: String,
  phone: String,
  email: String,
  website: String,
  notes: String,
  active: { type: Boolean, default: true }
}, baseOptions());

const StockLevelSchema = new Schema({
  id: idField,
  partId: { type: String, required: true },
  locationId: { type: String, required: true },
  onHand: { type: Number, default: 0, min: 0, validate: isInt },
  reserved: { type: Number, default: 0, min: 0, validate: isInt },
  minLevel: { type: Number, default: 0, min: 0 },
  maxLevel: { type: Number, default: null },
  binLocation: { type: String, default: '' },
  avgCostCents: centsField(),
  lastCountedAt: Date
}, baseOptions());
StockLevelSchema.index({ partId: 1, locationId: 1 }, { unique: true });
StockLevelSchema.index({ locationId: 1 });

export const INVENTORY_TXN_TYPES = [
  'opening_balance', 'receive', 'issue', 'return_from_ro', 'return_to_vendor', 'adjustment',
  'cycle_count', 'transfer_out', 'transfer_in', 'reserve', 'release'
];

// Immutable stock ledger: every change to on-hand or reserved quantity.
const InventoryTransactionSchema = new Schema({
  id: idField,
  type: { type: String, enum: INVENTORY_TXN_TYPES, required: true },
  partId: { type: String, required: true, index: true },
  locationId: { type: String, required: true, index: true },
  quantity: { type: Number, default: 0, validate: isInt },       // delta on hand
  reservedDelta: { type: Number, default: 0, validate: isInt },  // delta reserved
  unitCostCents: centsField(),
  totalCostCents: centsField(),
  onHandAfter: Number,
  reservedAfter: Number,
  refs: {
    purchaseOrderId: String,
    roId: String,
    jobId: String,
    reservationId: String,
    transferId: String,
    vendorReturnId: String,
    installedPartId: String
  },
  reason: String,
  by: String,
  byName: String,
  at: { type: Date, default: Date.now, index: true }
}, baseOptions());
InventoryTransactionSchema.plugin(immutablePlugin);

const ReservationSchema = new Schema({
  id: idField,
  partId: { type: String, required: true, index: true },
  locationId: { type: String, required: true },
  roId: { type: String, required: true, index: true },
  estimateLineId: String,
  jobId: String,
  partRequestId: String,
  quantity: { type: Number, required: true, min: 1, validate: isInt },
  issuedQuantity: { type: Number, default: 0, validate: isInt },
  status: { type: String, enum: ['active', 'issued', 'released'], default: 'active', index: true },
  createdBy: String,
  releasedReason: String
}, baseOptions());

const PoLineSchema = new Schema({
  id: { type: String, required: true },
  partId: { type: String, required: true },
  partNumber: String,
  description: String,
  quantityOrdered: { type: Number, required: true, min: 1, validate: isInt },
  quantityReceived: { type: Number, default: 0, validate: isInt },
  unitCostCents: centsField()
}, { _id: false });

const PurchaseOrderSchema = new Schema({
  id: idField,
  poNumber: { type: String, required: true, unique: true },
  locationId: { type: String, required: true, index: true },
  supplierId: String,
  supplierName: String,
  currency: currencyField,
  status: { type: String, enum: ['draft', 'ordered', 'partially_received', 'received', 'cancelled'], default: 'draft', index: true },
  lines: { type: [PoLineSchema], default: [] },
  totalCents: centsField(),
  orderedAt: Date,
  orderedBy: String,
  expectedAt: Date,
  supplierReference: String,
  receipts: {
    type: [new Schema({
      id: String,
      at: Date,
      by: String,
      packingSlip: String,
      lines: [new Schema({ lineId: String, quantity: Number, unitCostCents: Number }, { _id: false })]
    }, { _id: false })],
    default: []
  },
  notes: String,
  createdBy: String
}, baseOptions());

const TransferSchema = new Schema({
  id: idField,
  transferNumber: { type: String, required: true, unique: true },
  fromLocationId: { type: String, required: true, index: true },
  toLocationId: { type: String, required: true, index: true },
  status: { type: String, enum: ['requested', 'in_transit', 'received', 'cancelled'], default: 'requested' },
  lines: {
    type: [new Schema({ partId: String, partNumber: String, quantity: Number, quantityReceived: { type: Number, default: 0 }, unitCostCents: Number }, { _id: false })],
    default: []
  },
  requestedBy: String,
  shippedBy: String,
  shippedAt: Date,
  receivedBy: String,
  receivedAt: Date,
  notes: String
}, baseOptions());

const VendorReturnSchema = new Schema({
  id: idField,
  returnNumber: { type: String, required: true, unique: true },
  locationId: { type: String, required: true },
  supplierId: String,
  supplierName: String,
  status: { type: String, enum: ['draft', 'shipped', 'credited', 'cancelled'], default: 'draft' },
  lines: {
    type: [new Schema({ partId: String, partNumber: String, quantity: Number, unitCostCents: Number, reason: String, installedPartId: String, fromStock: { type: Boolean, default: true } }, { _id: false })],
    default: []
  },
  rmaNumber: String,
  creditCents: centsField(),
  shippedAt: Date,
  creditedAt: Date,
  createdBy: String
}, baseOptions());

const PartRequestSchema = new Schema({
  id: idField,
  roId: { type: String, required: true, index: true },
  locationId: { type: String, required: true, index: true },
  jobId: String,
  estimateLineId: String,
  partId: String,
  partNumber: String,
  description: { type: String, required: true },
  quantity: { type: Number, default: 1, min: 1 },
  urgency: { type: String, enum: ['normal', 'urgent'], default: 'normal' },
  status: { type: String, enum: ['requested', 'sourcing', 'reserved', 'ordered', 'received', 'issued', 'cancelled'], default: 'requested', index: true },
  requestedBy: String,
  handledBy: String,
  notes: String,
  purchaseOrderId: String,
  reservationId: String
}, baseOptions());

export const Part = model('Part', PartSchema, 'inventories');
export const Supplier = model('Supplier', SupplierSchema, 'suppliers');
export const StockLevel = model('StockLevel', StockLevelSchema, 'stocklevels');
export const InventoryTransaction = model('InventoryTransaction', InventoryTransactionSchema, 'inventorytransactions');
export const Reservation = model('Reservation', ReservationSchema, 'reservations');
export const PurchaseOrder = model('PurchaseOrder', PurchaseOrderSchema, 'purchaseorders');
export const Transfer = model('Transfer', TransferSchema, 'transfers');
export const VendorReturn = model('VendorReturn', VendorReturnSchema, 'vendorreturns');
export const PartRequest = model('PartRequest', PartRequestSchema, 'partrequests');
