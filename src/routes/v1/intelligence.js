import { Router } from 'express';
import { z, h, ok, id, cents, reqText, text } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission, requireAnyPermission, requireRole } from '../../middleware/auth.js';
import * as econ from '../../services/economicsService.js';
import * as risk from '../../services/riskService.js';
import { EconomicEvent, Membership, MembershipPlan, Vehicle, PredictiveSignal, RepairOrder, Customer } from '../../models/index.js';
import { INTERVENTION_KINDS } from '../../models/economics.js';
import { can, assertLocation } from '../../security/access.js';
import { notFound } from '../../lib/errors.js';
import { toDTO } from '../../lib/http.js';

const r = Router();
const econRead = requireAnyPermission('economics:location', 'economics:corporate');

// ---- economics ----------------------------------------------------------------------
r.get('/economics/rollup', econRead, h(async (req, res) => ok(res, await econ.rollup(req.auth, req.query))));
r.get('/economics/ledger', econRead, h(async (req, res) => ok(res, { events: await econ.ledgerEvents(req.auth, req.query) })));
r.get('/economics/config', requireAnyPermission('economics:config', 'economics:location'), h(async (_req, res) => ok(res, { active: await econ.activeConfig(), versions: await econ.listConfigs() })));
r.post('/economics/config', requirePermission('economics:config'), validate({ body: z.object({
  effectiveFrom: z.string().optional(), currency: z.string().length(3).optional(), defaultLoadedLaborRateCents: cents.nullable().optional(),
  overhead: z.object({ method: z.enum(['none', 'percent_of_revenue', 'flat_per_repair_order']), rateBps: z.number().int().min(0).max(10000).default(0), flatCents: cents.default(0) }).optional(),
  reserveBps: z.number().int().min(0).max(10000).optional(), defaultTargetMarginBps: z.number().int().min(-10000).max(10000).optional(), defaultWarningMarginBps: z.number().int().min(-10000).max(10000).optional(),
  plans: z.array(z.object({ planId: id, expectedAnnualDirectCostCents: cents.nullable().optional(), expectedAnnualVisits: z.number().min(0).nullable().optional(), targetMarginBps: z.number().int().nullable().optional(), warningMarginBps: z.number().int().nullable().optional(), minTenureMonthsForEligibility: z.number().int().min(0).optional() })).optional(),
  forecast: z.object({ horizonsDays: z.array(z.number().int().positive()).min(1), historyWindowDays: z.number().int().positive(), minHistoryDaysForMedium: z.number().int().min(0), minVisitsForMedium: z.number().int().min(0), minHistoryDaysForHigh: z.number().int().min(0), minVisitsForHigh: z.number().int().min(0) }).optional(),
  riskBands: z.array(z.object({ band: z.enum(['GREEN', 'YELLOW', 'ORANGE', 'RED']), minScore: z.number().min(0).max(100) })).length(4).optional(),
  notes: reqText(1000)
}) }), h(async (req, res) => ok(res, { config: await econ.saveConfig(req, req.body) }, 201)));
r.post('/economics/ledger/backfill', requirePermission('economics:config'), h(async (req, res) => ok(res, { result: await econ.backfillLedger(req) })));
r.post('/economics/ledger/events', requirePermission('economics:config'), validate({ body: z.object({
  type: z.enum(['other_direct_cost', 'overhead_allocation', 'reversal']), amountCents: z.number().int().optional(), effectiveAt: z.string().optional(), reversesEventId: id.optional(),
  attribution: z.object({ locationId: id.optional(), vehicleId: id.optional(), membershipId: id.optional(), planId: id.optional(), roId: id.optional(), serviceCategory: text(80).optional() }).optional(),
  reason: reqText(500)
}).refine(b => b.type === 'reversal' ? Boolean(b.reversesEventId) : Number.isSafeInteger(b.amountCents), 'amountCents or reversesEventId required') }),
h(async (req, res) => ok(res, { event: await econ.postManualEvent(req, req.body) }, 201)));

// Member / VIN workspace: full economics for economics readers; customer value only for advisors.
r.get('/economics/vehicles/:id', requireAnyPermission('economics:location', 'economics:customer_value', 'risk:alerts'), h(async (req, res) => {
  const vehicle = await Vehicle.findOne({ id: req.params.id }).lean();
  if (!vehicle) throw notFound('Vehicle');
  const full = can(req.auth, 'economics:location') || can(req.auth, 'economics:corporate');
  const lastRo = await RepairOrder.findOne({ vehicleId: vehicle.id }).sort({ createdAt: -1 }).select('locationId').lean();
  if (!full && lastRo) assertLocation(req.auth, lastRo.locationId);
  const riskView = await risk.vehicleRisk(req.auth, vehicle.id).catch(() => null);
  if (!full) {
    const value = await EconomicEvent.aggregate([{ $match: { 'attribution.vehicleId': vehicle.id, type: 'covered_retail_value' } }, { $group: { _id: null, retail: { $sum: '$amountCents' }, paid: { $sum: '$calculationContext.customerPaidCents' } } }]);
    return ok(res, { limited: true, customerValue: { eligibleRetailValueCents: value[0]?.retail || 0, customerSavingsCents: (value[0]?.retail || 0) - (value[0]?.paid || 0) }, risk: riskView });
  }
  const [economics, byPeriod, events] = await Promise.all([
    econ.rollup(req.auth, { groupBy: 'vehicle', vehicleId: vehicle.id, from: req.query.from || '2000-01-01' }),
    econ.rollup(req.auth, { groupBy: 'period', vehicleId: vehicle.id, from: req.query.from || new Date(Date.now() - 730 * 86400000).toISOString() }),
    econ.ledgerEvents(req.auth, { vehicleId: vehicle.id, limit: 100 })
  ]);
  ok(res, { vehicle: toDTO(vehicle), economics: economics.rows[0] || null, byPeriod: byPeriod.rows, definitions: economics.definitions, events, risk: riskView });
}));

r.get('/economics/memberships/:id', econRead, h(async (req, res) => {
  const m = await Membership.findOne({ $or: [{ id: req.params.id }, { number: req.params.id }] }).lean();
  if (!m) throw notFound('Membership');
  if (m.locationId) assertLocation(req.auth, m.locationId);
  const [plan, customer, economics, byCategory, vehicles] = await Promise.all([
    MembershipPlan.findOne({ planId: m.planId, version: m.planVersion }).lean(),
    Customer.findOne({ id: m.customerId }).select('id name').lean(),
    econ.rollup(req.auth, { groupBy: 'membership', membershipId: m.id, from: '2000-01-01' }),
    econ.rollup(req.auth, { groupBy: 'serviceCategory', membershipId: m.id, from: '2000-01-01' }),
    Vehicle.find(m.vehicleIds.length ? { id: { $in: m.vehicleIds } } : { customerId: m.customerId }).select('id year make model vin').lean()
  ]);
  ok(res, { membership: toDTO(m), plan: toDTO(plan), customer, economics: economics.rows[0] || null, byServiceCategory: byCategory.rows, vehicles: toDTO(vehicles), definitions: economics.definitions });
}));

// ---- risk & forecasting -----------------------------------------------------------------
r.get('/risk/distribution', requirePermission('risk:read'), h(async (req, res) => ok(res, await risk.riskDistribution(req.auth, req.query))));
r.get('/risk/vehicles/:id', requireAnyPermission('risk:read', 'risk:alerts'), h(async (req, res) => ok(res, await risk.vehicleRisk(req.auth, req.params.id))));
r.post('/risk/vehicles/:id/assess', requirePermission('risk:read'), h(async (req, res) => ok(res, { snapshot: await risk.assessVehicle(req.params.id) })));
r.post('/risk/refresh', requirePermission('interventions:manage'), h(async (req, res) => ok(res, { job: (await risk.refreshAll(req))?.id, message: 'Risk refresh queued' })));

// ---- interventions -----------------------------------------------------------------------
r.get('/interventions', requirePermission('interventions:read'), h(async (req, res) => ok(res, { interventions: await risk.listInterventions(req.auth, req.query) })));
r.post('/interventions', requirePermission('interventions:manage'), validate({ body: z.object({
  subjectType: z.enum(['vehicle', 'membership', 'plan', 'location']), subjectId: id.optional(), vehicleId: id.optional(), membershipId: id.optional(), planId: id.optional(), locationId: id.optional(), customerId: id.optional(),
  kind: z.enum(INTERVENTION_KINDS), recommendedAction: reqText(500), reason: reqText(1000), priority: z.enum(['low', 'medium', 'high']).optional(), dueAt: z.string().optional(), ownerId: id.optional(), estimatedImpactCents: z.number().int().nullable().optional()
}) }), h(async (req, res) => ok(res, { intervention: await risk.createIntervention(req, req.body) }, 201)));
r.patch('/interventions/:id', requirePermission('interventions:manage'), validate({ body: z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'dismissed']).optional(), ownerId: id.nullable().optional(), note: text(1000).optional(),
  resolutionNotes: text(2000).optional(), priority: z.enum(['low', 'medium', 'high']).optional(), dueAt: z.string().optional()
}) }), h(async (req, res) => ok(res, { intervention: await risk.updateIntervention(req, req.params.id, req.body) })));

// ---- customer projection (explicit allowlist; no cost, margin or risk internals) ---------
r.get('/portal/value', requireRole('customer'), h(async (req, res) => {
  const customerId = req.auth.customerId;
  if (!customerId) throw notFound("Customer profile");
  const [value, memberships, vehicles] = await Promise.all([
    EconomicEvent.aggregate([{ $match: { 'attribution.customerId': customerId, type: 'covered_retail_value' } }, { $group: { _id: '$attribution.vehicleId', retail: { $sum: '$amountCents' }, paid: { $sum: '$calculationContext.customerPaidCents' } } }]),
    Membership.find({ customerId }).sort({ createdAt: -1 }).lean(),
    Vehicle.find({ customerId, status: { $ne: 'archived' } }).select('id year make model licensePlate mileage').lean()
  ]);
  const plans = await MembershipPlan.find({ planId: { $in: memberships.map(m => m.planId) } }).lean();
  const signals = await PredictiveSignal.find({ vehicleId: { $in: vehicles.map(v => v.id) }, status: 'open' }).lean();
  ok(res, {
    memberships: memberships.map(m => {
      const p = plans.find(x => x.planId === m.planId && x.version === m.planVersion);
      return { number: m.number, status: m.status, planName: p?.name, benefits: p?.benefitsText || [], periodStart: m.currentPeriodStart, periodEnd: m.currentPeriodEnd };
    }),
    totalSavingsCents: value.reduce((s, x) => s + x.retail - x.paid, 0),
    totalCoveredRetailValueCents: value.reduce((s, x) => s + x.retail, 0),
    savingsDefinition: 'Retail value of membership-covered services minus what you paid for them.',
    vehicles: vehicles.map(v => {
      const vv = value.find(x => x._id === v.id);
      return {
        id: v.id, name: `${v.year} ${v.make} ${v.model}`, licensePlate: v.licensePlate, mileage: v.mileage,
        savingsCents: vv ? vv.retail - vv.paid : 0,
        maintenanceAlerts: signals.filter(s => s.vehicleId === v.id).map(s => ({ title: s.title, recommendation: s.recommendation, dueAt: s.dueAt, dueMileage: s.dueMileage }))
      };
    })
  });
}));

export default r;
