import { Router } from 'express';
import { z, h, ok, id, reqText } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission, requireAnyPermission, requireRole } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import * as messages from '../../services/messageService.js';
import * as notifications from '../../services/notificationService.js';
import * as memberships from '../../services/membershipService.js';
import * as analytics from '../../services/analyticsService.js';
import { handleStripeWebhook } from '../../services/paymentService.js';
import { processDueJobs, enqueueDailyJobs } from '../../services/jobService.js';
import { RepairOrder, Vehicle, Invoice, Estimate, Appointment, PredictiveSignal } from '../../models/index.js';
import { RO_OPEN_STATUSES } from '../../models/operations.js';
import { env } from '../../config/env.js';
import { forbidden } from '../../lib/errors.js';
import { timingSafeEqualStr } from '../../lib/crypto.js';
import { toDTO } from '../../lib/http.js';

const r = Router();

// ---- unauthenticated system endpoints ----------------------------------------------------
r.post('/payments/stripe/webhook', h(async (req, res) => ok(res, await handleStripeWebhook(req.rawBody?.toString('utf8') || '', req.get('Stripe-Signature')))));
// Serverless deployments trigger the job worker on a schedule (e.g. Vercel Cron)
r.post('/internal/jobs/run', h(async (req, res) => {
  const token = (req.get('Authorization') || '').replace(/^Bearer /, '');
  if (!env.cronSecret || !timingSafeEqualStr(token, env.cronSecret)) throw forbidden('Invalid cron credentials');
  await enqueueDailyJobs().catch(() => {});
  ok(res, { result: await processDueJobs({ limit: 50 }) });
}));

const staffOr = (perm) => requireAnyPermission(perm, 'portal:access');

// ---- messages & notifications -----------------------------------------------------------------
r.get('/conversations', staffOr('messages:read'), h(async (req, res) => ok(res, { conversations: await messages.listConversations(req.auth, req.query) })));
r.get('/conversations/:id', staffOr('messages:read'), h(async (req, res) => ok(res, await messages.getThread(req.auth, req.params.id))));
r.post('/messages', staffOr('messages:internal'), idempotent(), validate({ body: z.object({ customerId: id.optional(), roId: id.optional(), channel: z.enum(['portal', 'sms', 'email', 'internal_note']).default('portal'), body: reqText(5000) }) }),
  h(async (req, res) => ok(res, { messageRecord: await messages.sendMessage(req, req.body) }, 201)));
r.get('/notifications', h(async (req, res) => ok(res, await notifications.listNotifications(req.auth, { unreadOnly: req.query.unreadOnly === 'true', limit: Number(req.query.limit) || 50 }))));
r.post('/notifications/:id/read', h(async (req, res) => { await notifications.markRead(req.auth, req.params.id); ok(res); }));
r.post('/notifications/read-all', h(async (req, res) => { await notifications.markAllRead(req.auth); ok(res); }));

// ---- memberships ----------------------------------------------------------------------------
r.get('/membership-plans', h(async (req, res) => ok(res, { plans: await memberships.listPlans({ includeRetired: req.query.includeRetired === 'true' && req.auth.role !== 'customer' }) })));
r.get('/membership-plans/:planId/versions', requirePermission('memberships:read'), h(async (req, res) => ok(res, { versions: await memberships.planVersions(req.params.planId) })));
r.get('/service-riders', h(async (req, res) => ok(res, { riders: await memberships.listRiders({ includeRetired: req.query.includeRetired === 'true' && req.auth.role !== 'customer' }) })));
r.get('/memberships', staffOr('memberships:read'), h(async (req, res) => ok(res, { memberships: await memberships.listMemberships(req.auth, req.query) })));
r.get('/memberships/:id', staffOr('memberships:read'), h(async (req, res) => ok(res, { membership: await memberships.getMembership(req.auth, req.params.id) })));
r.post('/memberships', requirePermission('memberships:sell'), idempotent({ required: true }), validate({ body: z.object({ customerId: id, planId: id, billingCycle: z.enum(['monthly', 'annual']).default('annual'), vehicleIds: z.array(id).default([]), riderIds: z.array(id).default([]), locationId: id.optional(), autoRenew: z.boolean().optional() }) }),
  h(async (req, res) => ok(res, await memberships.enroll(req, req.body), 201)));
r.post('/memberships/:id/renew', requirePermission('memberships:sell'), h(async (req, res) => ok(res, await memberships.renewMembership(req, req.params.id))));
r.post('/memberships/:id/change-plan', requirePermission('memberships:sell'), validate({ body: z.object({ planId: id, reason: reqText(500) }) }), h(async (req, res) => ok(res, await memberships.changePlan(req, req.params.id, req.body))));
r.post('/memberships/:id/suspend', requirePermission('memberships:sell'), validate({ body: z.object({ reason: reqText(500) }) }), h(async (req, res) => ok(res, { membership: await memberships.setSuspended(req, req.params.id, { suspend: true, reason: req.body.reason }) })));
r.post('/memberships/:id/resume', requirePermission('memberships:sell'), validate({ body: z.object({ reason: reqText(500) }) }), h(async (req, res) => ok(res, { membership: await memberships.setSuspended(req, req.params.id, { suspend: false, reason: req.body.reason }) })));
r.post('/memberships/:id/cancel', requirePermission('memberships:sell'), validate({ body: z.object({ reason: reqText(500) }) }), h(async (req, res) => ok(res, { membership: await memberships.cancelMembership(req, req.params.id, req.body) })));

// ---- analytics ---------------------------------------------------------------------------------
r.get('/analytics/dashboard', requirePermission('analytics:location'), h(async (req, res) => ok(res, await analytics.dashboard(req.auth, req.query))));
r.get('/analytics/locations', requirePermission('analytics:location'), h(async (req, res) => ok(res, { locations: await analytics.corporateRollup(req.auth, req.query) })));
r.get('/analytics/profit-per-vin', requirePermission('analytics:location'), h(async (req, res) => ok(res, { vehicles: await analytics.profitPerVin(req.auth, req.query) })));

// ---- customer portal summary ("My Garage") -------------------------------------------------------
r.get('/portal/summary', requireRole('customer'), h(async (req, res) => {
  const customerId = req.auth.customerId;
  const [vehicles, ros, invoices, appointments, memberList, signals] = await Promise.all([
    Vehicle.find({ customerId, status: { $ne: 'archived' } }).lean(),
    RepairOrder.find({ customerId }).sort({ createdAt: -1 }).limit(20).select('id roNumber status vehicleId createdAt promisedAt closedAt').lean(),
    Invoice.find({ customerId, status: 'posted' }).sort({ postedAt: -1 }).limit(20).select('id invoiceNumber roId kind totals balanceCents paymentStatus postedAt currency').lean(),
    Appointment.find({ customerId, status: { $in: ['scheduled', 'confirmed'] }, startAt: { $gte: new Date() } }).sort({ startAt: 1 }).lean(),
    memberships.listMemberships(req.auth, {}),
    PredictiveSignal.find({ customerId, status: 'open' }).sort({ createdAt: -1 }).limit(20).lean()
  ]);
  const openRoIds = ros.filter(x => RO_OPEN_STATUSES.includes(x.status)).map(x => x.id);
  const pendingEstimates = await Estimate.find({ roId: { $in: openRoIds }, presentedVersionId: { $ne: null }, status: { $in: ['presented', 'partially_approved'] } }).select('roId estimateNumber status').lean();
  ok(res, {
    vehicles: toDTO(vehicles), repairOrders: toDTO(ros), invoices: toDTO(invoices), upcomingAppointments: toDTO(appointments),
    memberships: memberList, pendingEstimates: toDTO(pendingEstimates),
    recommendations: toDTO(signals).map(s => ({ id: s.id, vehicleId: s.vehicleId, title: s.title, recommendation: s.recommendation, reason: s.reason, dueAt: s.dueAt, dueMileage: s.dueMileage }))
  });
}));

export default r;
