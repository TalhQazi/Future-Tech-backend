import {
  Vehicle, Customer, Membership, MembershipPlan, RepairOrder, Invoice, Payment, Refund, MileageRecord, Appointment, DiagnosticSession,
  Measurement, ConfirmedFix, Finding, Inspection, Evidence, PredictiveSignal, Referral, EconomicEvent, EntitlementUsage, Location
} from '../models/index.js';
import { rollup, ledgerEvents, activeConfig } from './economicsService.js';
import { vehicleRisk } from './riskService.js';
import { assertVehicleAccess } from './vehicleService.js';
import { assertLocation, can } from '../security/access.js';
import { notFound, forbidden } from '../lib/errors.js';
import { toDTO } from '../lib/http.js';

const DAY = 86400000;
const UPCOMING = { $nin: ['completed', 'no_show', 'cancelled'] };
const DEFAULT_QUALIFICATION = /compression|leak.?down|voltage.?drop/i;
const isFinance = (auth) => can(auth, 'economics:location') || can(auth, 'economics:corporate');

const mileageView = (records, current) => {
  const good = records.filter(r => !r.flagged);
  let milesPerYear = null;
  if (good.length >= 2) {
    const days = (new Date(good.at(-1).recordedAt) - new Date(good[0].recordedAt)) / DAY;
    if (days >= 30) milesPerYear = Math.round(((good.at(-1).odometer - good[0].odometer) / days) * 365);
  }
  const now = Date.now();
  return {
    current, milesPerYear,
    projected: milesPerYear == null ? [] : [3, 6, 12].map(mo => ({ at: new Date(now + mo * 30.44 * DAY), odometer: Math.round(current + milesPerYear * mo / 12) })),
    basis: milesPerYear == null ? 'Not enough readings 30+ days apart to estimate mileage rate' : `${good.length} readings from ${new Date(good[0].recordedAt).toISOString().slice(0, 10)}`,
    history: records.map(r => ({ id: r.id, odometer: r.odometer, unit: r.unit, at: r.recordedAt, source: r.source, flagged: r.flagged }))
  };
};

const codeHistory = (sessions, fixes, ros) => {
  const roNo = new Map(ros.map(r => [r.id, r.roNumber]));
  const codes = new Map();
  for (const s of sessions) for (const d of s.dtcs || []) {
    const c = codes.get(d.code) || { code: d.code, description: d.descriptionSource !== 'none' ? d.description : '', occurrences: [] };
    c.occurrences.push({ at: d.capturedAt, status: d.status, source: d.source, deviceId: d.deviceId, sessionId: s.id, roId: s.roId, roNumber: roNo.get(s.roId) });
    codes.set(d.code, c);
  }
  return [...codes.values()].map(c => {
    const at = c.occurrences.map(o => new Date(o.at)).sort((a, b) => a - b);
    const linked = fixes.filter(f => f.dtcCodes?.includes(c.code));
    const sessionsSeen = new Set(c.occurrences.map(o => o.sessionId)).size;
    return {
      ...c, count: c.occurrences.length, sessions: sessionsSeen, firstSeen: at[0], lastSeen: at.at(-1), recurring: sessionsSeen >= 2,
      confirmedFixes: linked.map(f => ({ id: f.id, status: f.status, rootCause: f.rootCause, correction: f.correction, at: f.updatedAt || f.createdAt })),
      recurredAfterFix: linked.some(f => f.status === 'verified' && at.at(-1) > new Date(f.updatedAt || f.createdAt))
    };
  }).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
};

const observationsOf = (vehicle, sessions, measurements, ros) => {
  const odo = new Map(ros.map(r => [r.id, r.odometerIn]));
  return [
    ...sessions.flatMap(s => (s.dtcs || []).map(d => ({ kind: 'dtc', vin: vehicle.vin, code: d.code, description: d.descriptionSource !== 'none' ? d.description : '', descriptionSource: d.descriptionSource, status: d.status, source: d.source, deviceId: d.deviceId, at: d.capturedAt, odometer: odo.get(s.roId) ?? null, sessionId: s.id, roId: s.roId }))),
    ...measurements.map(m => ({ kind: 'measurement', vin: vehicle.vin, parameter: m.parameter, component: m.component, value: m.value, unit: m.unit, method: m.method, classification: m.classification, spec: m.specSnapshot ? { min: m.specSnapshot.min, max: m.specSnapshot.max, nominal: m.specSnapshot.nominal, unit: m.specSnapshot.unit, sourceId: m.specSnapshot.sourceId } : null, result: m.evaluation?.result, deviceId: m.deviceId, at: m.capturedAt, odometer: odo.get(m.roId) ?? null, sessionId: m.sessionId, roId: m.roId }))
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
};

const qualificationOf = (measurements, rules) => {
  const groups = [];
  const matchers = rules.length ? rules.map(r => ({ ...r, rx: new RegExp(r.parameterPattern, 'i') })) : [{ key: 'qualification', label: 'Qualification readings', rx: DEFAULT_QUALIFICATION }];
  for (const r of matchers) {
    const ms = measurements.filter(m => r.rx.test(m.parameter) && (!r.unit || r.unit === m.unit));
    if (!ms.length) continue;
    const latestByComponent = new Map();
    for (const m of ms) if (!latestByComponent.has(m.component || m.parameter)) latestByComponent.set(m.component || m.parameter, m);
    const readings = [...latestByComponent.values()].map(m => ({
      component: m.component || m.parameter, parameter: m.parameter, value: m.value, unit: m.unit, at: m.capturedAt, specResult: m.evaluation?.result,
      ruleResult: r.min == null && r.max == null ? null : (r.min == null || m.value >= r.min) && (r.max == null || m.value <= r.max) ? 'meets' : 'outside'
    })).sort((a, b) => String(a.component).localeCompare(String(b.component), undefined, { numeric: true }));
    groups.push({ key: r.key, label: r.label, unit: r.unit, min: r.min, max: r.max, readings, qualifies: readings.some(x => x.ruleResult) ? readings.every(x => x.ruleResult !== 'outside') : null });
  }
  return groups;
};

// Internal workspace. Sections are included only for roles allowed to see them.
export const vehicleWorkspace = async (auth, vehicleId) => {
  const vehicle = await Vehicle.findOne({ id: vehicleId }).lean();
  if (!vehicle) throw notFound('Vehicle');
  const cfg = await activeConfig();
  const [customer, memberships, ros, invoices, mileage, appointments, sessions, measurements, fixes, signals, evidence] = await Promise.all([
    Customer.findOne({ id: vehicle.customerId }).select('id name phone email homeLocationId').lean(),
    Membership.find({ customerId: vehicle.customerId, $or: [{ vehicleIds: { $size: 0 } }, { vehicleIds: vehicleId }] }).sort({ createdAt: -1 }).lean(),
    RepairOrder.find({ vehicleId }).sort({ createdAt: -1 }).limit(100).select('id roNumber status createdAt closedAt appointmentId odometerIn odometerOut jobs.id jobs.title jobs.status jobs.laborOpCode concerns locationId').lean(),
    Invoice.find({ vehicleId, status: 'posted' }).select('id invoiceNumber roId totals postedAt balanceCents').lean(),
    MileageRecord.find({ vehicleId }).sort({ recordedAt: 1 }).lean(),
    Appointment.find({ vehicleId, startAt: { $gte: new Date() }, status: UPCOMING }).sort({ startAt: 1 }).limit(5).lean(),
    DiagnosticSession.find({ vehicleId }).sort({ createdAt: -1 }).limit(60).select('id roId dtcs createdAt status conclusion').lean(),
    Measurement.find({ vehicleId }).sort({ capturedAt: -1 }).limit(400).lean(),
    ConfirmedFix.find({ 'vehicle.vehicleId': vehicleId }).select('id status dtcCodes rootCause correction createdAt updatedAt').lean(),
    PredictiveSignal.find({ vehicleId, status: 'open' }).lean(),
    Evidence.find({ vehicleId, status: 'current' }).sort({ capturedAt: -1 }).limit(200).select('id kind contentType caption roId capturedAt visibility originalName').lean()
  ]);
  const lastRo = ros[0];
  if (!can(auth, 'intelligence:vehicle')) throw forbidden();
  if (lastRo && !memberships.length) assertLocation(auth, lastRo.locationId);
  const plans = await MembershipPlan.find({ planId: { $in: memberships.map(m => m.planId) } }).lean();
  const inspections = await Inspection.find({ vehicleId, status: 'completed' }).sort({ completedAt: -1 }).limit(1).lean();
  const findings = inspections[0] ? await Finding.find({ inspectionId: inspections[0].id, status: 'active', severity: { $ne: null } }).select('id name severity condition recommendation customerDecision').lean() : [];
  const invByRo = new Map(invoices.map(i => [i.roId, i]));
  const codes = codeHistory(sessions, fixes, ros);
  const latestSession = sessions[0];
  const riskView = await vehicleRisk(auth, vehicleId).catch(() => null);

  const out = {
    vehicle: toDTO(vehicle),
    customer,
    memberships: memberships.map(m => ({ id: m.id, number: m.number, status: m.status, planId: m.planId, planName: plans.find(p => p.planId === m.planId && p.version === m.planVersion)?.name, planVersion: m.planVersion, billingCycle: m.billingCycle, startedAt: m.startedAt, currentPeriodEnd: m.currentPeriodEnd })),
    health: {
      basis: inspections[0] ? `Latest completed inspection ${new Date(inspections[0].completedAt).toISOString().slice(0, 10)} and diagnostic sessions` : 'No completed inspection on record',
      findingsBySeverity: findings.reduce((m, f) => ({ ...m, [f.severity]: (m[f.severity] || 0) + 1 }), {}),
      activeCodes: (latestSession?.dtcs || []).filter(d => ['active', 'pending', 'permanent'].includes(d.status)).map(d => d.code),
      failedMeasurements365: measurements.filter(m => m.evaluation?.result === 'fail' && new Date(m.capturedAt) > new Date(Date.now() - 365 * DAY)).length,
      findings
    },
    mileage: { ...mileageView(mileage, vehicle.mileage), serviceMarkers: ros.filter(r => r.odometerIn).map(r => ({ at: r.createdAt, odometer: r.odometerIn, roNumber: r.roNumber, scheduled: Boolean(r.appointmentId) })) },
    nextAppointment: appointments[0] ? { id: appointments[0].id, startAt: appointments[0].startAt, serviceRequested: appointments[0].serviceRequested, status: appointments[0].status } : null,
    upcomingAppointments: appointments.map(a => ({ id: a.id, number: a.appointmentNumber, startAt: a.startAt, serviceRequested: a.serviceRequested, status: a.status })),
    recommendedMaintenance: signals.map(s => ({ id: s.id, title: s.title, recommendation: s.recommendation, dueAt: s.dueAt, dueMileage: s.dueMileage, confidence: s.confidence })),
    diagnostics: { observations: observationsOf(vehicle, sessions, measurements, ros).slice(0, 300), qualification: qualificationOf(measurements, cfg.qualificationRules || []) },
    codeHistory: codes,
    serviceHistory: ros.map(r => ({
      id: r.id, roNumber: r.roNumber, status: r.status, date: r.createdAt, closedAt: r.closedAt, scheduled: Boolean(r.appointmentId), odometerIn: r.odometerIn,
      work: r.jobs.map(j => j.title), concerns: (r.concerns || []).map(c => c.text),
      invoice: invByRo.get(r.id) ? { id: invByRo.get(r.id).id, number: invByRo.get(r.id).invoiceNumber, totalCents: invByRo.get(r.id).totals.totalCents, laborCents: invByRo.get(r.id).totals.laborCents, partsCents: invByRo.get(r.id).totals.partsCents, discountCents: invByRo.get(r.id).totals.discountCents, balanceCents: invByRo.get(r.id).balanceCents } : null
    })),
    photos: evidence.filter(e => ['photo', 'video'].includes(e.kind)).map(toDTO),
    documents: evidence.filter(e => ['document', 'scan_report', 'audio', 'signature'].includes(e.kind)).map(toDTO),
    risk: riskView
  };

  // customer value (advisors and above): no costs or margins
  if (can(auth, 'economics:customer_value') || isFinance(auth)) {
    const v = await EconomicEvent.aggregate([{ $match: { 'attribution.vehicleId': vehicleId, type: 'covered_retail_value' } }, { $group: { _id: null, retail: { $sum: '$amountCents' }, paid: { $sum: '$calculationContext.customerPaidCents' } } }]);
    out.customerValue = { eligibleRetailValueCents: v[0]?.retail || 0, customerSavingsCents: (v[0]?.retail || 0) - (v[0]?.paid || 0) };
  }
  // membership & payments (billing, advisors, managers)
  if (can(auth, 'invoices:read') || can(auth, 'memberships:read')) {
    const membershipInvoices = await Invoice.find({ membershipId: { $in: memberships.map(m => m.id) }, status: 'posted' }).select('id invoiceNumber membershipId totals postedAt balanceCents').lean();
    const invIds = [...invoices, ...membershipInvoices].map(i => i.id);
    const [payments, refunds, usage] = await Promise.all([
      Payment.find({ invoiceId: { $in: invIds } }).sort({ createdAt: -1 }).select('id receiptNumber invoiceId amountCents method status receivedAt failureReason createdAt').lean(),
      Refund.find({ invoiceId: { $in: invIds } }).sort({ createdAt: -1 }).select('id refundNumber invoiceId amountCents status processedAt reason').lean(),
      EntitlementUsage.find({ membershipId: { $in: memberships.map(m => m.id) }, status: 'consumed' }).sort({ createdAt: -1 }).limit(100).lean()
    ]);
    const lifecycle = await EconomicEvent.find({ type: 'membership_lifecycle', 'attribution.membershipId': { $in: memberships.map(m => m.id) } }).sort({ effectiveAt: -1 }).limit(50).lean();
    out.membershipPayments = {
      membershipInvoices: toDTO(membershipInvoices), payments: toDTO(payments), refunds: toDTO(refunds), entitlementUsage: toDTO(usage),
      lifecycle: lifecycle.map(e => ({ at: e.effectiveAt, action: e.calculationContext?.action, detail: e.calculationContext, by: e.createdBy })),
      totalMembershipPaymentsCents: payments.filter(p => p.status === 'succeeded' && membershipInvoices.some(i => i.id === p.invoiceId)).reduce((s, p) => s + p.amountCents, 0)
    };
    const refs = await Referral.find({ referrerCustomerId: vehicle.customerId }).sort({ createdAt: -1 }).lean();
    out.referrals = toDTO(refs);
  }
  // internal finance (location managers, executives, admins)
  if (isFinance(auth)) {
    const member = memberships.find(m => ['active', 'past_due', 'suspended'].includes(m.status)) || memberships[0];
    const [life, byPeriod, byCategory, events, memberLife] = await Promise.all([
      rollup(auth, { groupBy: 'vehicle', vehicleId, from: '2000-01-01' }),
      rollup(auth, { groupBy: 'period', vehicleId, from: new Date(Date.now() - 730 * DAY).toISOString() }),
      rollup(auth, { groupBy: 'serviceCategory', vehicleId, from: '2000-01-01' }),
      ledgerEvents(auth, { vehicleId, limit: 100 }),
      member ? rollup(auth, { groupBy: 'membership', membershipId: member.id, from: '2000-01-01' }) : null
    ]);
    out.finance = { vehicle: life.rows[0] || null, membership: memberLife?.rows[0] || null, byPeriod: byPeriod.rows, byCategory: byCategory.rows, events: events.events, eventsTotal: events.total, definitions: life.definitions };
  }
  return out;
};

export const membershipWorkspace = async (auth, id) => {
  const m = await Membership.findOne({ $or: [{ id }, { number: id }] }).lean();
  if (!m) throw notFound('Membership');
  if (m.locationId) assertLocation(auth, m.locationId);
  const [plan, customer, vehicles, invoices, lifecycle] = await Promise.all([
    MembershipPlan.findOne({ planId: m.planId, version: m.planVersion }).lean(),
    Customer.findOne({ id: m.customerId }).select('id name phone email').lean(),
    Vehicle.find(m.vehicleIds.length ? { id: { $in: m.vehicleIds } } : { customerId: m.customerId }).select('id year make model vin mileage').lean(),
    Invoice.find({ membershipId: m.id }).sort({ createdAt: -1 }).select('id invoiceNumber totals postedAt balanceCents status').lean(),
    EconomicEvent.find({ type: 'membership_lifecycle', 'attribution.membershipId': m.id }).sort({ effectiveAt: -1 }).lean()
  ]);
  const payments = await Payment.find({ invoiceId: { $in: invoices.map(i => i.id) } }).sort({ createdAt: -1 }).lean();
  const out = {
    membership: toDTO(m), plan: toDTO(plan), customer, vehicles: toDTO(vehicles), invoices: toDTO(invoices), payments: toDTO(payments),
    lifecycle: lifecycle.map(e => ({ at: e.effectiveAt, action: e.calculationContext?.action, detail: e.calculationContext, by: e.createdBy }))
  };
  if (isFinance(auth)) {
    const [life, byCategory, byPeriod] = await Promise.all([
      rollup(auth, { groupBy: 'membership', membershipId: m.id, from: '2000-01-01' }),
      rollup(auth, { groupBy: 'serviceCategory', membershipId: m.id, from: '2000-01-01' }),
      rollup(auth, { groupBy: 'period', membershipId: m.id, from: '2000-01-01' })
    ]);
    // initial ticket: service revenue on the first repair order after enrollment
    const first = await EconomicEvent.findOne({ 'attribution.membershipId': m.id, type: 'service_revenue' }).sort({ effectiveAt: 1 }).lean();
    const initialTicket = first ? (await EconomicEvent.aggregate([{ $match: { 'attribution.roId': first.attribution.roId, type: 'service_revenue' } }, { $group: { _id: null, s: { $sum: '$amountCents' } } }]))[0]?.s : null;
    out.finance = { economics: life.rows[0] || null, byServiceCategory: byCategory.rows, byPeriod: byPeriod.rows, initialTicketRevenueCents: initialTicket ?? null, definitions: life.definitions };
  }
  return out;
};

// ---------------------------------------------------------------------------
// Customer projection: explicit allowlist built on the server. No cost, margin,
// profitability state, risk score, model driver, threshold or internal note.
// ---------------------------------------------------------------------------
const DTC_STATUS_TEXT = { active: 'Currently active', pending: 'Detected, waiting to confirm', permanent: 'Stored by the vehicle', history: 'Seen before, not active now', cleared: 'Cleared' };

export const customerProjection = async (customerId, { vehicleId } = {}) => {
  const cfg = await activeConfig();
  const sev = cfg.customerSeverity;
  const vehicleFilter = { customerId, status: { $ne: 'archived' }, ...(vehicleId ? { id: vehicleId } : {}) };
  const [vehicles, memberships, valueRows, referrals] = await Promise.all([
    Vehicle.find(vehicleFilter).select('id year make model trim licensePlate mileage mileageUnit').lean(),
    Membership.find({ customerId }).sort({ createdAt: -1 }).lean(),
    EconomicEvent.aggregate([{ $match: { 'attribution.customerId': customerId, type: 'covered_retail_value' } }, { $group: { _id: '$attribution.vehicleId', retail: { $sum: '$amountCents' }, paid: { $sum: '$calculationContext.customerPaidCents' } } }]),
    Referral.find({ referrerCustomerId: customerId }).sort({ createdAt: -1 }).lean()
  ]);
  const vIds = vehicles.map(v => v.id);
  // only this customer's own visits (never a previous owner's history)
  const ros = await RepairOrder.find({ customerId, vehicleId: { $in: vIds }, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).limit(50).select('id roNumber vehicleId createdAt odometerIn jobs.title jobs.status locationId').lean();
  const roIds = ros.map(r => r.id);
  const [plans, invoices, appointments, signals, inspections, sessions, photos] = await Promise.all([
    MembershipPlan.find({ planId: { $in: memberships.map(m => m.planId) } }).lean(),
    Invoice.find({ customerId, status: 'posted' }).sort({ postedAt: -1 }).limit(100).select('id invoiceNumber kind roId vehicleId membershipId totals postedAt balanceCents').lean(),
    Appointment.find({ customerId, startAt: { $gte: new Date() }, status: UPCOMING, ...(vehicleId ? { vehicleId } : {}) }).sort({ startAt: 1 }).limit(10).lean(),
    PredictiveSignal.find({ vehicleId: { $in: vIds }, status: 'open' }).lean(),
    Inspection.find({ roId: { $in: roIds }, status: 'completed' }).sort({ completedAt: -1 }).lean(),
    DiagnosticSession.find({ roId: { $in: roIds } }).sort({ createdAt: -1 }).select('vehicleId dtcs createdAt').lean(),
    Evidence.find({ roId: { $in: roIds }, visibility: 'customer', status: 'current', kind: 'photo' }).sort({ capturedAt: -1 }).limit(60).select('id vehicleId findingId caption capturedAt').lean()
  ]);
  const latestInspection = new Map();
  for (const i of inspections) if (!latestInspection.has(i.vehicleId)) latestInspection.set(i.vehicleId, i);
  const findings = await Finding.find({ inspectionId: { $in: [...latestInspection.values()].map(i => i.id) }, status: 'active', severity: { $ne: null } }).select('vehicleId name severity recommendation customerDecision').lean();
  const payments = await Payment.find({ invoiceId: { $in: invoices.map(i => i.id) }, status: 'succeeded' }).sort({ receivedAt: -1 }).select('receiptNumber invoiceId amountCents method receivedAt').lean();
  const membershipInvoiceIds = new Set(invoices.filter(i => i.kind === 'membership').map(i => i.id));
  const locations = new Map((await Location.find({ id: { $in: [...new Set(ros.map(r => r.locationId))] } }).select('id name').lean()).map(l => [l.id, l.name]));
  const totalSavings = valueRows.filter(x => !vehicleId || x._id === vehicleId).reduce((s, x) => s + x.retail - x.paid, 0);
  const totalRetail = valueRows.filter(x => !vehicleId || x._id === vehicleId).reduce((s, x) => s + x.retail, 0);

  return {
    memberships: memberships.map(m => {
      const p = plans.find(x => x.planId === m.planId && x.version === m.planVersion);
      return { number: m.number, status: m.status, planName: p?.name, tier: p?.code, benefits: p?.benefitsText || [], billingCycle: m.billingCycle, periodStart: m.currentPeriodStart, periodEnd: m.currentPeriodEnd, autoRenew: m.autoRenew };
    }),
    membershipPaymentsCents: payments.filter(p => membershipInvoiceIds.has(p.invoiceId)).reduce((s, p) => s + p.amountCents, 0),
    totalSavingsCents: totalSavings,
    totalCoveredRetailValueCents: totalRetail,
    savingsDefinition: 'Retail value of membership-covered services minus what you paid for those services. Membership fees are shown separately.',
    vehicles: vehicles.map(v => {
      const vv = valueRows.find(x => x._id === v.id);
      const session = sessions.find(s => s.vehicleId === v.id);
      return {
        id: v.id, name: `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ''}`, licensePlate: v.licensePlate, mileage: v.mileage, mileageUnit: v.mileageUnit,
        retailValueCents: vv?.retail || 0, savingsCents: vv ? vv.retail - vv.paid : 0,
        health: {
          inspectedAt: latestInspection.get(v.id)?.completedAt || null,
          items: findings.filter(f => f.vehicleId === v.id).map(f => ({ item: f.name, label: sev[f.severity]?.label || f.severity, urgency: sev[f.severity]?.urgency || 'info', explanation: sev[f.severity]?.text || '', recommendation: f.recommendation || '', decision: f.customerDecision }))
        },
        diagnosticCodes: (session?.dtcs || []).filter(d => d.status !== 'cleared').map(d => ({
          code: d.code, description: d.descriptionSource !== 'none' ? d.description : '', status: DTC_STATUS_TEXT[d.status] || d.status,
          explanation: 'A trouble code is a message stored by your vehicle\'s computer. It points us to a system to check; on its own it does not confirm that a part has failed.'
        })),
        maintenanceAlerts: signals.filter(s => s.vehicleId === v.id).map(s => ({ title: s.title, recommendation: s.recommendation, dueAt: s.dueAt, dueMileage: s.dueMileage })),
        photos: photos.filter(p => p.vehicleId === v.id).map(p => ({ id: p.id, caption: p.caption, at: p.capturedAt }))
      };
    }),
    serviceHistory: ros.map(r => {
      const inv = invoices.find(i => i.roId === r.id);
      return { roNumber: r.roNumber, vehicleId: r.vehicleId, date: r.createdAt, location: locations.get(r.locationId), odometer: r.odometerIn, work: r.jobs.filter(j => j.status !== 'cancelled').map(j => j.title), invoiceNumber: inv?.invoiceNumber, totalCents: inv?.totals.totalCents ?? null, balanceCents: inv?.balanceCents ?? null };
    }),
    upcomingAppointments: appointments.map(a => ({ number: a.appointmentNumber, vehicleId: a.vehicleId, startAt: a.startAt, serviceRequested: a.serviceRequested, status: a.status })),
    payments: payments.map(p => ({ receiptNumber: p.receiptNumber, invoiceNumber: invoices.find(i => i.id === p.invoiceId)?.invoiceNumber, amountCents: p.amountCents, method: p.method, receivedAt: p.receivedAt })),
    referrals: referrals.map(r => ({ referredName: r.referredName, status: r.status, rewardCents: r.status === 'rewarded' ? r.rewardCents : null, at: r.createdAt }))
  };
};

export const customerVehicleHealth = async (auth, vehicleId) => {
  const vehicle = await Vehicle.findOne({ id: vehicleId }).lean();
  if (!vehicle) throw notFound('Vehicle');
  await assertVehicleAccess(auth, vehicle);
  const p = await customerProjection(auth.customerId, { vehicleId });
  const v = p.vehicles[0];
  if (!v) throw notFound('Vehicle');
  return { vehicle: v, serviceHistory: p.serviceHistory, upcomingAppointments: p.upcomingAppointments };
};
