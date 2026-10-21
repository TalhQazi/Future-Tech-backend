import { Router } from 'express';
import { z, h, ok, id, cents, reqText, text, expectedVersion } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission, requireStaff } from '../../middleware/auth.js';
import * as users from '../../services/userService.js';
import * as org from '../../services/orgService.js';
import * as catalog from '../../services/catalogService.js';
import * as inspections from '../../services/inspectionService.js';
import * as memberships from '../../services/membershipService.js';
import { jobStats, processDueJobs } from '../../services/jobService.js';
import { AuditEvent } from '../../models/index.js';
import { STAFF_ROLES } from '../../models/identity.js';
import { ENTITLEMENT_KINDS } from '../../models/commercial.js';
import { locationFilter } from '../../security/access.js';
import { storage } from '../../adapters/storage.js';
import { paymentProvidersStatus } from '../../adapters/payments.js';
import { notificationStatus } from '../../adapters/notifications.js';
import { automind } from '../../adapters/automind.js';
import { technicalData } from '../../adapters/technicalData.js';
import { vehicleDataStatus } from '../../adapters/vehicleData.js';
import { aiStatus } from '../../adapters/ai/index.js';
import { toDTO } from '../../lib/http.js';

const r = Router();

// ---- users -------------------------------------------------------------------
const staffRole = z.enum(STAFF_ROLES);
r.get('/users', requirePermission('users:read'), h(async (req, res) => ok(res, { users: await users.listUsers(req.auth, req.query) })));
r.post('/users', requirePermission('users:manage'), validate({ body: z.object({
  name: reqText(120), email: z.string().email(), role: staffRole, phone: text(30).optional(), specialty: text(120).optional(),
  locationIds: z.array(id).default([]), laborCostRateCents: cents.nullable().optional(), certifications: z.array(text(80)).optional()
}) }), h(async (req, res) => ok(res, await users.inviteStaff(req, req.body), 201)));
r.patch('/users/:id', requirePermission('users:manage'), validate({ body: z.object({
  name: reqText(120).optional(), role: staffRole.optional(), status: z.enum(['active', 'disabled']).optional(), phone: text(30).optional(),
  specialty: text(120).optional(), locationIds: z.array(id).optional(), laborCostRateCents: cents.nullable().optional(),
  certifications: z.array(text(80)).optional(), reason: text(500).optional()
}) }), h(async (req, res) => ok(res, { user: await users.updateUser(req, req.params.id, req.body) })));
r.post('/users/:id/resend-invite', requirePermission('users:manage'), h(async (req, res) => ok(res, await users.resendInvite(req, req.params.id))));
r.post('/users/:id/reset-mfa', requirePermission('users:manage'), validate({ body: z.object({ reason: reqText(500) }) }), h(async (req, res) => ok(res, await users.resetUserMfa(req, req.params.id, req.body.reason))));
r.post('/users/:id/revoke-sessions', requirePermission('users:manage'), h(async (req, res) => ok(res, await users.revokeUserSessions(req, req.params.id))));

// ---- locations & corporate -----------------------------------------------------
const hours = z.object({ closed: z.boolean().default(false), open: z.string().default('08:00'), close: z.string().default('17:00') });
const locationBody = z.object({
  name: reqText(120), code: text(20).optional(), status: z.enum(['active', 'inactive']).optional(),
  address: text(200).optional(), city: text(80).optional(), state: text(40).optional(), zip: text(20).optional(),
  phone: text(30).optional(), email: z.string().email().optional().or(z.literal('')),
  timezone: text(64).optional(), currency: z.string().length(3).optional(),
  taxRateBps: z.number().int().min(0).max(5000).optional(), laborTaxable: z.boolean().optional(), partsTaxable: z.boolean().optional(), feesTaxable: z.boolean().optional(),
  laborRates: z.object({ standardCents: cents, diagnosticCents: cents, evCents: cents }).optional(),
  partsMarkupMatrix: z.array(z.object({ maxCostCents: cents.nullable(), markupBps: z.number().int().min(0).max(100000) })).optional(),
  hours: z.object({ mon: hours, tue: hours, wed: hours, thu: hours, fri: hours, sat: hours, sun: hours }).partial().optional(),
  bays: z.array(z.object({ id: id.optional(), name: reqText(80), type: text(40).default('general'), active: z.boolean().default(true) })).optional(),
  appointmentSlotMinutes: z.number().int().min(10).max(240).optional()
});
r.get('/locations', h(async (req, res) => ok(res, { locations: await org.listLocations(req.auth) })));
r.get('/locations/:id', h(async (req, res) => ok(res, { location: await org.getLocation(req.auth, req.params.id) })));
r.get('/locations/:id/bays', requireStaff, h(async (req, res) => ok(res, { bays: await org.getBayBoard(req.auth, req.params.id) })));
r.post('/locations', requirePermission('corporate:manage'), validate({ body: locationBody }), h(async (req, res) => ok(res, { location: await org.createLocation(req, req.body) }, 201)));
r.patch('/locations/:id', requirePermission('locations:manage'), validate({ body: locationBody.partial() }), h(async (req, res) => ok(res, { location: await org.updateLocation(req, req.params.id, req.body, expectedVersion(req)) })));
r.get('/corporate-settings', requireStaff, h(async (_req, res) => ok(res, { settings: await org.getCorporateSettings() })));
r.patch('/corporate-settings', requirePermission('corporate:manage'), validate({ body: z.object({
  companyName: text(120).optional(), brandName: text(120).optional(), estimateValidityDays: z.number().int().min(1).max(365).optional(),
  comebackWindowDays: z.number().int().min(7).max(730).optional(), confirmedFixRequiresApproval: z.boolean().optional(),
  maintenanceIntervals: z.array(z.object({ key: reqText(60), name: reqText(120), laborOpCode: text(40).optional(), intervalMiles: z.number().int().positive().optional(), intervalMonths: z.number().int().positive().optional(), active: z.boolean().default(true) })).optional()
}) }), h(async (req, res) => ok(res, { settings: await org.updateCorporateSettings(req, req.body) })));

// ---- catalog ---------------------------------------------------------------------
r.get('/labor-operations', requireStaff, h(async (req, res) => ok(res, { laborOperations: await catalog.listLaborOperations(req.query) })));
const laborOp = z.object({ code: reqText(40), name: reqText(160), description: text(1000).optional(), category: text(80).optional(), defaultHours: z.number().min(0).max(100), rateType: z.enum(['standard', 'diagnostic', 'ev']), hoursSource: z.enum(['shop_policy', 'licensed_labor_guide']).optional(), hoursSourceRef: text(200).optional(), active: z.boolean().optional() });
r.post('/labor-operations', requirePermission('catalog:manage'), validate({ body: laborOp }), h(async (req, res) => ok(res, { laborOperation: await catalog.saveLaborOperation(req, null, req.body) }, 201)));
r.patch('/labor-operations/:id', requirePermission('catalog:manage'), validate({ body: laborOp.partial() }), h(async (req, res) => ok(res, { laborOperation: await catalog.saveLaborOperation(req, req.params.id, req.body) })));
r.get('/fees', requireStaff, h(async (req, res) => ok(res, { fees: await catalog.listFees(req.query) })));
const fee = z.object({ code: reqText(40), name: reqText(120), kind: z.enum(['flat', 'percent_of_labor', 'percent_of_parts']), amountCents: cents.optional(), rateBps: z.number().int().min(0).max(10000).optional(), minCents: cents.nullable().optional(), maxCents: cents.nullable().optional(), taxable: z.boolean().optional(), autoApply: z.boolean().optional(), locationIds: z.array(id).optional(), active: z.boolean().optional() });
r.post('/fees', requirePermission('catalog:manage'), validate({ body: fee }), h(async (req, res) => ok(res, { fee: await catalog.saveFee(req, null, req.body) }, 201)));
r.patch('/fees/:id', requirePermission('catalog:manage'), validate({ body: fee.partial() }), h(async (req, res) => ok(res, { fee: await catalog.saveFee(req, req.params.id, req.body) })));

// ---- inspection templates ---------------------------------------------------------
r.get('/inspection-templates', requireStaff, h(async (req, res) => ok(res, { templates: await inspections.listTemplates(req.query) })));
r.post('/inspection-templates', requirePermission('catalog:manage'), validate({ body: z.object({
  templateId: id.optional(), name: reqText(120),
  sections: z.array(z.object({ key: text(60).optional(), name: reqText(120), items: z.array(z.object({ key: text(60).optional(), name: reqText(160), measurementHints: z.array(z.object({ label: reqText(60), unit: text(20) })).optional() })).min(1) })).min(1)
}) }), h(async (req, res) => ok(res, { template: await inspections.saveTemplate(req, req.body) }, 201)));

// ---- membership plans & riders ------------------------------------------------------
const entitlement = z.object({ key: reqText(60), kind: z.enum(ENTITLEMENT_KINDS), description: text(300).optional(), valueBps: z.number().int().min(0).max(10000).optional(), laborOpCode: text(40).optional(), feeCode: text(40).optional(), period: z.enum(['per_visit', 'per_term', 'unlimited']).default('unlimited'), quantityPerPeriod: z.number().int().positive().nullable().optional(), maxDiscountCents: cents.nullable().optional() });
r.post('/membership-plans', requirePermission('memberships:plans'), validate({ body: z.object({
  planId: id.optional(), code: reqText(30), name: reqText(120), tier: reqText(60), currency: z.string().length(3).optional(),
  priceMonthlyCents: cents, priceAnnualCents: cents, termMonths: z.number().int().min(1).max(60).default(12),
  benefitsText: z.array(text(300)).default([]), entitlements: z.array(entitlement).default([]), ridersAllowed: z.array(id).default([])
}) }), h(async (req, res) => ok(res, { plan: await memberships.savePlanVersion(req, req.body) }, 201)));
r.post('/membership-plans/:planId/retire', requirePermission('memberships:plans'), h(async (req, res) => {
  await memberships.retirePlan(req, req.params.planId);
  ok(res);
}));
r.post('/service-riders', requirePermission('memberships:plans'), validate({ body: z.object({
  riderId: id.optional(), code: reqText(30), name: reqText(120), currency: z.string().length(3).optional(), priceMonthlyCents: cents,
  coverageText: text(2000).default(''), entitlements: z.array(entitlement).default([])
}) }), h(async (req, res) => ok(res, { rider: await memberships.saveRiderVersion(req, req.body) }, 201)));

// ---- audit, integrations, jobs ---------------------------------------------------------
r.get('/audit', requirePermission('audit:read'), h(async (req, res) => {
  const filter = { ...locationFilter(req.auth) };
  if (req.auth.role === 'admin') delete filter.locationId;
  for (const k of ['eventType', 'category', 'entityType', 'entityId', 'actorId']) if (req.query[k]) filter[k] = req.query[k];
  if (req.query.from || req.query.to) filter.timestamp = { ...(req.query.from && { $gte: new Date(req.query.from) }), ...(req.query.to && { $lt: new Date(req.query.to) }) };
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const events = await AuditEvent.find(filter).sort({ timestamp: -1 }).limit(limit).lean();
  ok(res, { auditLogs: toDTO(events) });
}));

r.get('/integrations', requireStaff, h(async (_req, res) => ok(res, {
  integrations: {
    storage: storage.status(), payments: paymentProvidersStatus(), notifications: notificationStatus(),
    automind: automind.status(), technicalData: technicalData.status(), vehicleData: vehicleDataStatus(), ai: aiStatus()
  }
})));

r.get('/jobs', requirePermission('corporate:manage'), h(async (_req, res) => ok(res, { jobs: await jobStats() })));
r.post('/jobs/run', requirePermission('corporate:manage'), h(async (_req, res) => ok(res, { result: await processDueJobs({ limit: 50 }) })));

export default r;
