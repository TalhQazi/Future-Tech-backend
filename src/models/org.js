import { Schema, idField, baseOptions, centsField, currencyField, model } from './common.js';

const dayHours = new Schema({
  closed: { type: Boolean, default: false },
  open: { type: String, default: '08:00' },
  close: { type: String, default: '17:00' }
}, { _id: false });

const BaySchema = new Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  type: { type: String, default: 'general' },
  active: { type: Boolean, default: true },
  occupiedRoId: String // legacy field, occupancy is now derived from open repair orders
}, { _id: false });

const LocationSchema = new Schema({
  id: idField,
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true, uppercase: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  address: String,
  city: String,
  state: String,
  zip: String,
  phone: String,
  email: String,
  timezone: { type: String, default: 'America/Los_Angeles' },
  currency: currencyField,
  taxRateBps: { type: Number, default: 0, min: 0, max: 5000 },
  laborTaxable: { type: Boolean, default: false },
  partsTaxable: { type: Boolean, default: true },
  feesTaxable: { type: Boolean, default: false },
  laborRates: {
    standardCents: centsField(),
    diagnosticCents: centsField(),
    evCents: centsField()
  },
  // parts matrix: first tier whose maxCostCents >= unit cost applies its markup
  partsMarkupMatrix: {
    type: [new Schema({ maxCostCents: { type: Number, default: null }, markupBps: { type: Number, required: true } }, { _id: false })],
    default: []
  },
  hours: {
    mon: { type: dayHours, default: () => ({}) },
    tue: { type: dayHours, default: () => ({}) },
    wed: { type: dayHours, default: () => ({}) },
    thu: { type: dayHours, default: () => ({}) },
    fri: { type: dayHours, default: () => ({}) },
    sat: { type: dayHours, default: () => ({ closed: true }) },
    sun: { type: dayHours, default: () => ({ closed: true }) }
  },
  bays: { type: [BaySchema], default: [] },
  baysCount: Number,
  appointmentSlotMinutes: { type: Number, default: 30 },
  // legacy prototype fields (dollars as floats / free text), kept for history
  salesTaxRate: Number,
  laborRateStandard: Number,
  laborRateDiagnostics: Number,
  laborRateEv: Number,
  operatingHours: String
}, baseOptions());

LocationSchema.index({ code: 1 }, { unique: true, sparse: true });

// Corporate-wide settings (single document, key = "corporate").
const CorporateSettingsSchema = new Schema({
  key: { type: String, default: 'corporate', unique: true },
  companyName: { type: String, default: 'Membership Auto' },
  brandName: { type: String, default: 'FutureTech 2.0' },
  defaultCurrency: currencyField,
  estimateValidityDays: { type: Number, default: 30 },
  comebackWindowDays: { type: Number, default: 90 },
  confirmedFixRequiresApproval: { type: Boolean, default: true },
  aiEnabled: { type: Boolean, default: false },
  aiAllowedTasks: { type: [String], default: ['service_writer', 'repair_explanation', 'summarize_findings', 'diagnostic_suggestion'] },
  maintenanceIntervals: {
    type: [new Schema({
      key: { type: String, required: true },
      name: { type: String, required: true },
      laborOpCode: String,
      intervalMiles: Number,
      intervalMonths: Number,
      source: { type: String, default: 'shop_policy' },
      active: { type: Boolean, default: true }
    }, { _id: false })],
    default: []
  },
  updatedBy: String
}, baseOptions());

export const Location = model('Location', LocationSchema, 'locations');
export const CorporateSettings = model('CorporateSettings', CorporateSettingsSchema, 'corporatesettings');
