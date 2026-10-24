import { Router } from 'express';
import { z, h, ok, id, cents, reqText, text } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission, requireAnyPermission, requireRole } from '../../middleware/auth.js';
import * as econ from '../../services/economicsService.js';
import * as risk from '../../services/riskService.js';
import * as reports from '../../services/intelReportsService.js';
import * as intel from '../../services/vehicleIntelService.js';
import { Vehicle, Referral, Customer } from '../../models/index.js';
import { INTERVENTION_KINDS, OVERHEAD_METHODS, ECONOMIC_TYPES, DATA_QUALITY, BANDS } from '../../models/economics.js';
import { assertLocation, resolveLocationId } from '../../security/access.js';
import { notFound, badRequest, conflict } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { toDTO } from '../../lib/http.js';

const r = Router();
const P = '/membership-intelligence';
const econRead = requireAnyPermission('economics:location', 'economics:corporate');
const bps = z.number().int().min(-100000).max(100000);
const regex = z.string().max(120).refine(s => { try { new RegExp(s); return true; } catch { return false; } }, 'invalid pattern');
const laborRate = z.object({ techId: id.optional(), baseWageCents: cents.nullable().optional(), payrollBurdenBps: bps.optional(), benefitsPerHourCents: cents.optional(), laborOverheadBps: bps.optional(), loadedRateCents: cents.nullable().optional() });

// ---- portfolio & analytics ---------------------------------------------------------------
r.get(`${P}/portfolio`, econRead, h(async (req, res) => ok(res, await reports.portfolioSummary(req.auth, req.query))));
r.get(`${P}/portfolio/trends`, econRead, h(async (req, res) => ok(res, await econ.rollup(req.auth, { ...req.query, groupBy: 'period' }))));
r.get(`${P}/portfolio/breakdown`, econRead, h(async (req, res) => ok(res, await econ.rollup(req.auth, req.query))));
r.get(`${P}/portfolio/cohorts`, econRead, h(async (req, res) => ok(res, await reports.cohortAnalysis(req.auth, req.query))));
r.get(`${P}/portfolio/diagnostics`, requireAnyPermission('economics:location', 'economics:corporate', 'risk:read'), h(async (req, res) => ok(res, await reports.diagnosticTrends(req.auth, req.query))));
r.get(`${P}/portfolio/interventions`, requirePermission('interventions:read'), h(async (req, res) => ok(res, await reports.interventionResults(req.auth, req.query))));
r.get(`${P}/reconciliation`, econRead, h(async (req, res) => ok(res, await econ.reconcile(req.auth, req.query))));
r.get(`${P}/monitoring`, requireAnyPermission('economics:config', 'economics:corporate'), h(async (req, res) => ok(res, await reports.monitoring(req.auth))));
r.get(`${P}/ledger`, econRead, h(async (req, res) => ok(res, await econ.ledgerEvents(req.auth, req.query))));

// ---- member / VIN workspaces ------------------------------------------------------------------
r.get(`${P}/members/:membershipId`, requireAnyPermission('memberships:read', 'economics:location', 'economics:corporate'), h(async (req, res) => ok(res, await intel.membershipWorkspace(req.auth, req.params.membershipId))));
r.get(`${P}/vehicles/:vehicleId`, requirePermission('intelligence:vehicle'), h(async (req, res) => ok(res, await intel.vehicleWorkspace(req.auth, req.params.vehicleId))));
r.get(`${P}/vehicles/:vehicleId/customer-view`, requirePermission('intelligence:vehicle'), h(async (req, res) => {
  const v = await Vehicle.findOne({ id: req.params.vehicleId }).select('id customerId').lean();
  if (!v) throw notFound('Vehicle');
  ok(res, { preview: true, projection: await intel.customerProjection(v.customerId, { vehicleId: v.id }) });
}));
r.post(`${P}/recalculate/:membershipId`, requireAnyPermission('economics:config', 'economics:adjust'), h(async (req, res) => ok(res, { result: await econ.recalculateMembership(req, req.params.membershipId) })));

// ---- risk & forecasting ------------------------------------------------------------------------
r.get(`${P}/risk-queue`, requirePermission('risk:read'), h(async (req, res) => ok(res, await reports.riskQueue(req.auth, req.query))));
r.get(`${P}/risk/breakdown`, requirePermission('risk:read'), h(async (req, res) => ok(res, await reports.riskBreakdown(req.auth, req.query))));
r.get(`${P}/risk/accuracy`, requirePermission('risk:read'), h(async (req, res) => ok(res, await reports.forecastAccuracy(req.auth, req.query))));
r.get(`${P}/risk/vehicles/:id`, requireAnyPermission('risk:read', 'risk:alerts'), h(async (req, res) => ok(res, await risk.vehicleRisk(req.auth, req.params.id))));
r.post(`${P}/risk/vehicles/:id/assess`, requirePermission('risk:read'), h(async (req, res) => ok(res, { snapshot: await risk.assessVehicle(req.params.id) })));
r.post(`${P}/risk/vehicles/:id/override`, requirePermission('interventions:manage'), validate({ body: z.object({ band: z.enum(BANDS).optional(), profitabilityState: z.enum(BANDS).optional(), reason: reqText(1000) }) }), h(async (req, res) => ok(res, { snapshot: await risk.overrideRisk(req, req.params.id, req.body) })));
r.post(`${P}/risk/refresh`, requirePermission('interventions:manage'), h(async (req, res) => ok(res, { job: (await risk.refreshAll(req))?.id, message: 'Risk refresh queued' })));

// ---- alerts & interventions --------------------------------------------------------------------
r.get(`${P}/alerts`, requirePermission('interventions:read'), h(async (req, res) => ok(res, await risk.listAlerts(req.auth, req.query))));
r.patch(`${P}/alerts/:id`, requirePermission('interventions:manage'), validate({ body: z.object({ status: z.enum(['open', 'acknowledged', 'resolved', 'dismissed']).optional(), ownerId: id.nullable().optional(), note: text(1000).optional(), falsePositive: z.boolean().optional() }) }), h(async (req, res) => ok(res, { alert: await risk.updateAlert(req, req.params.id, req.body) })));
r.get(`${P}/interventions`, requirePermission('interventions:read'), h(async (req, res) => ok(res, await risk.listInterventions(req.auth, req.query))));
r.post(`${P}/interventions`, requirePermission('interventions:manage'), validate({ body: z.object({
  alertId: id.optional(), subjectType: z.enum(['vehicle', 'membership', 'plan', 'location']).optional(), subjectId: id.optional(), vehicleId: id.optional(), membershipId: id.optional(), planId: id.optional(), locationId: id.optional(), customerId: id.optional(),
  kind: z.enum(INTERVENTION_KINDS), recommendedAction: reqText(500), reason: text(1000).optional(), priority: z.enum(['low', 'medium', 'high']).optional(), dueAt: z.string().optional(), ownerId: id.optional(), estimatedImpactCents: z.number().int().nullable().optional()
}) }), h(async (req, res) => ok(res, { intervention: await risk.createIntervention(req, req.body) }, 201)));
r.patch(`${P}/interventions/:id`, requirePermission('interventions:manage'), validate({ body: z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'dismissed']).optional(), ownerId: id.nullable().optional(), note: text(1000).optional(),
  resolutionNotes: text(2000).optional(), priority: z.enum(['low', 'medium', 'high']).optional(), dueAt: z.string().optional(),
  outcome: z.object({ result: z.enum(['completed', 'customer_declined', 'no_effect', 'not_applicable']), avoidedCostEstimateCents: cents.nullable().optional() }).optional()
}) }), h(async (req, res) => ok(res, { intervention: await risk.updateIntervention(req, req.params.id, req.body) })));

// ---- configuration, ledger maintenance and adjustments --------------------------------------------
r.get(`${P}/config`, requireAnyPermission('economics:config', 'economics:location'), h(async (_req, res) => ok(res, { active: await econ.activeConfig(), versions: await econ.listConfigs() })));
r.post(`${P}/config`, requirePermission('economics:config'), validate({ body: z.object({
  effectiveFrom: z.string().optional(), currency: z.string().length(3).optional(), defaultLoadedLaborRateCents: cents.nullable().optional(),
  labor: z.object({ default: laborRate.optional(), technicians: z.array(laborRate.extend({ techId: id })).optional() }).optional(),
  overhead: z.object({
    method: z.enum(OVERHEAD_METHODS), rateBps: bps.default(0), flatCents: cents.default(0), perLaborHourCents: cents.default(0), perBayHourCents: cents.default(0), perMemberMonthCents: cents.default(0),
    locationMonthlyPools: z.array(z.object({ locationId: id, monthlyCents: cents })).default([]),
    hybrid: z.array(z.object({ method: z.enum(OVERHEAD_METHODS.filter(m => !['none', 'hybrid'].includes(m))), weightBps: z.number().int().min(0).max(10000) })).default([])
  }).optional(),
  reserveBps: bps.optional(), defaultTargetMarginBps: bps.optional(), defaultWarningMarginBps: bps.optional(), lossToleranceBps: bps.optional(), adverseTrendBps: bps.optional(),
  majorRepairThresholdCents: cents.nullable().optional(), preventiveCategories: z.array(text(80)).optional(), referralRewardCents: cents.nullable().optional(), membershipGraceDays: z.number().int().min(0).max(365).optional(),
  plans: z.array(z.object({ planId: id, expectedAnnualDirectCostCents: cents.nullable().optional(), expectedAnnualVisits: z.number().min(0).nullable().optional(), targetMarginBps: bps.nullable().optional(), warningMarginBps: bps.nullable().optional(), minTenureMonthsForEligibility: z.number().int().min(0).optional() })).optional(),
  qualificationRules: z.array(z.object({ key: text(40), label: text(80), parameterPattern: regex, unit: text(20).optional(), min: z.number().nullable().optional(), max: z.number().nullable().optional() })).optional(),
  forecast: z.object({ horizonsDays: z.array(z.number().int().positive()).min(1), historyWindowDays: z.number().int().positive(), minHistoryDaysForMedium: z.number().int().min(0), minVisitsForMedium: z.number().int().min(0), minHistoryDaysForHigh: z.number().int().min(0), minVisitsForHigh: z.number().int().min(0) }).optional(),
  riskBands: z.array(z.object({ band: z.enum(BANDS), minScore: z.number().min(0).max(100) })).length(4).optional(),
  riskModel: z.record(z.number()).optional(), alertThresholds: z.record(z.number()).optional(),
  customerSeverity: z.record(z.object({ label: text(80), urgency: z.enum(['high', 'medium', 'low', 'info']), text: text(500) })).optional(),
  notes: reqText(1000)
}) }), h(async (req, res) => ok(res, { config: await econ.saveConfig(req, req.body) }, 201)));
r.post(`${P}/config/rollback`, requirePermission('economics:config'), validate({ body: z.object({ toVersion: z.number().int().positive(), reason: reqText(1000) }) }), h(async (req, res) => ok(res, { config: await econ.rollbackConfig(req, req.body) }, 201)));
r.post(`${P}/ledger/backfill`, requirePermission('economics:config'), h(async (req, res) => ok(res, await econ.startBackfill(req), 202)));
r.get(`${P}/ledger/backfill`, requirePermission('economics:config'), h(async (req, res) => ok(res, await econ.backfillStatus(req.query.runId))));
r.post(`${P}/ledger/import`, requirePermission('economics:config'), validate({ body: z.object({
  sourceSystem: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/i),
  rows: z.array(z.object({
    externalId: z.string().trim().min(1).max(128), kind: z.enum(['economic', 'mileage']).default('economic'), type: z.enum(ECONOMIC_TYPES).optional(), quality: z.enum(DATA_QUALITY).optional(),
    amountCents: z.number().int().optional(), currency: z.string().length(3).optional(), effectiveAt: z.string(), vin: z.string().trim().max(17).optional(), membershipNumber: text(40).optional(),
    roNumber: text(40).optional(), locationId: id.optional(), serviceCategory: text(80).optional(), odometer: z.number().int().min(0).optional(), unit: z.enum(['mi', 'km']).optional(), note: text(500).optional()
  })).min(1).max(1000)
}) }), h(async (req, res) => ok(res, { result: await econ.importHistorical(req, req.body) })));
r.post(`${P}/close-month`, requirePermission('economics:config'), validate({ body: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }) }), h(async (req, res) => {
  const result = await econ.monthlyClose(req.body.month);
  await audit(req, { eventType: 'ECONOMICS_MONTH_CLOSED', category: 'financial', entityType: 'EconomicEvent', entityId: req.body.month, action: `Monthly overhead close ${req.body.month}: ${result.inserted} new, ${result.duplicates} already posted` });
  ok(res, { result });
}));
r.get(`${P}/adjustments`, requireAnyPermission('economics:adjust', 'economics:approve'), h(async (req, res) => ok(res, { adjustments: await econ.listAdjustments(req.auth, req.query) })));
r.post(`${P}/adjustments`, requirePermission('economics:adjust'), validate({ body: z.object({
  type: z.enum(['other_revenue', 'parts_credit', 'warranty_recovery', 'towing_cost', 'sublet_cost', 'other_direct_cost', 'overhead_allocation', 'reversal']),
  amountCents: z.number().int().optional(), effectiveAt: z.string().optional(), reversesEventId: id.optional(), quality: z.enum(DATA_QUALITY).optional(),
  attribution: z.object({ locationId: id.optional(), vehicleId: id.optional(), membershipId: id.optional(), planId: id.optional(), roId: id.optional(), customerId: id.optional(), serviceCategory: text(80).optional() }).optional(),
  reason: reqText(1000)
}).refine(b => (b.type === 'reversal' ? Boolean(b.reversesEventId) : Number.isSafeInteger(b.amountCents)), 'amountCents or reversesEventId required') }),
h(async (req, res) => ok(res, { adjustment: await econ.requestAdjustment(req, req.body) }, 201)));
r.post(`${P}/adjustments/:id/decision`, requirePermission('economics:approve'), validate({ body: z.object({ approve: z.boolean(), note: reqText(1000) }) }), h(async (req, res) => ok(res, { adjustment: await econ.decideAdjustment(req, req.params.id, req.body) })));

// ---- referrals -------------------------------------------------------------------------------
r.get(`${P}/referrals`, requirePermission('referrals:read'), h(async (req, res) => {
  const filter = req.query.customerId ? { referrerCustomerId: String(req.query.customerId) } : {};
  if (req.query.status) filter.status = String(req.query.status);
  ok(res, { referrals: toDTO(await Referral.find(filter).sort({ createdAt: -1 }).limit(200).lean()) });
}));
r.post(`${P}/referrals`, requirePermission('referrals:manage'), validate({ body: z.object({ referrerCustomerId: id, referredName: reqText(160), referredContact: text(160).optional(), locationId: id.optional(), notes: text(1000).optional() }) }), h(async (req, res) => {
  if (!(await Customer.exists({ id: req.body.referrerCustomerId }))) throw notFound('Referring customer');
  const created = await Referral.create({ ...req.body, locationId: resolveLocationId(req.auth, req.body.locationId), createdBy: req.auth.userId });
  await audit(req, { eventType: 'REFERRAL_RECORDED', category: 'operational', entityType: 'Referral', entityId: created.id, locationId: created.locationId, action: `Referral of ${created.referredName}` });
  ok(res, { referral: toDTO(created.toObject()) }, 201);
}));
const REFERRAL_NEXT = { pending: ['qualified', 'declined'], qualified: ['rewarded', 'declined'], rewarded: [], declined: [] };
r.patch(`${P}/referrals/:id`, requirePermission('referrals:manage'), validate({ body: z.object({ status: z.enum(['qualified', 'rewarded', 'declined']), referredCustomerId: id.optional(), qualifyingMembershipId: id.optional(), notes: text(1000).optional() }) }), h(async (req, res) => {
  const ref = await Referral.findOne({ id: req.params.id }).lean();
  if (!ref) throw notFound('Referral');
  if (ref.locationId) assertLocation(req.auth, ref.locationId);
  if (!REFERRAL_NEXT[ref.status].includes(req.body.status)) throw conflict(`Cannot move from ${ref.status} to ${req.body.status}`);
  const set = { ...req.body };
  if (req.body.status === 'rewarded') {
    const cfg = await econ.activeConfig();
    if (cfg.referralRewardCents == null) throw badRequest('Set referralRewardCents in the economics configuration first');
    Object.assign(set, { rewardCents: cfg.referralRewardCents, rewardedAt: new Date() });
  }
  const updated = await Referral.findOneAndUpdate({ id: ref.id, status: ref.status }, { $set: set }, { new: true }).lean();
  if (!updated) throw conflict('Referral changed; reload and try again');
  if (updated.status === 'rewarded') await econ.queueEconomics('referral', { referralId: updated.id }, updated.id);
  await audit(req, { eventType: 'REFERRAL_UPDATED', category: 'financial', entityType: 'Referral', entityId: ref.id, locationId: ref.locationId, action: `Referral ${ref.status} -> ${updated.status}${updated.rewardCents ? ` (reward ${updated.rewardCents} cents)` : ''}` });
  ok(res, { referral: toDTO(updated) });
}));

// ---- customer projection (server-side allowlist) -------------------------------------------------
r.get('/customer/membership-value', requireRole('customer'), h(async (req, res) => {
  if (!req.auth.customerId) throw notFound('Customer profile');
  ok(res, await intel.customerProjection(req.auth.customerId));
}));
r.get('/customer/vehicle-health/:vehicleId', requireRole('customer'), h(async (req, res) => ok(res, await intel.customerVehicleHealth(req.auth, req.params.vehicleId))));

export default r;
