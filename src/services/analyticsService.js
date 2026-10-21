import { Invoice, Payment, Refund, RepairOrder, TimeEntry, Approval, EstimateVersion, ConfirmedFix, InstalledPart, User, Vehicle, Location } from '../models/index.js';
import { RO_OPEN_STATUSES } from '../models/operations.js';
import { assertLocation, isAdmin } from '../security/access.js';
import { badRequest } from '../lib/errors.js';

// All analytics are derived from transactional records at query time; nothing
// here is stored as a source of truth.

const range = ({ from, to }) => {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) throw badRequest('Invalid date range');
  return { start, end };
};

const scope = (auth, locationId) => {
  if (locationId) {
    assertLocation(auth, locationId);
    return [locationId];
  }
  return isAdmin(auth) ? null : auth.locationIds;
};

const locMatch = (ids, field = 'locationId') => (ids ? { [field]: { $in: ids } } : {});

export const dashboard = async (auth, query) => {
  const { start, end } = range(query);
  const ids = scope(auth, query.locationId);
  const lm = locMatch(ids);
  const [invoices, payments, refunds, openRos, closedRos, time, approvals, comebacks] = await Promise.all([
    Invoice.find({ ...lm, kind: 'repair_order', status: 'posted', postedAt: { $gte: start, $lt: end } }).lean(),
    Payment.find({ ...lm, status: 'succeeded', receivedAt: { $gte: start, $lt: end } }).select('amountCents method').lean(),
    Refund.find({ ...lm, status: 'succeeded', processedAt: { $gte: start, $lt: end } }).select('amountCents').lean(),
    RepairOrder.aggregate([{ $match: { ...lm, status: { $in: RO_OPEN_STATUSES } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    RepairOrder.find({ ...lm, status: 'closed', closedAt: { $gte: start, $lt: end } }).select('jobs').lean(),
    TimeEntry.aggregate([{ $match: { ...lm, status: 'closed', startAt: { $gte: start, $lt: end }, type: { $in: ['job', 'diagnostic'] } } }, { $group: { _id: null, minutes: { $sum: '$minutes' } } }]),
    Approval.find({ at: { $gte: start, $lt: end } }).select('estimateVersionId decisions roId').lean(),
    ConfirmedFix.countDocuments({ ...locMatch(ids, 'source.locationId'), status: 'comeback', comebackDetectedAt: { $gte: start, $lt: end } })
  ]);
  const revenue = invoices.reduce((s, i) => s + i.totals.totalCents - i.totals.taxCents, 0);
  const partsLines = invoices.flatMap(i => i.lineItems.filter(l => l.kind === 'part'));
  const partsRevenue = partsLines.reduce((s, l) => s + l.netCents, 0);
  const partsCost = partsLines.reduce((s, l) => s + Math.round((l.unitCostCents || 0) * (l.quantity || 1)), 0);
  const soldHours = closedRos.flatMap(r => r.jobs.filter(j => ['completed', 'verified'].includes(j.status))).reduce((s, j) => s + (j.soldHours || 0), 0);
  const clockedHours = (time[0]?.minutes || 0) / 60;

  // approval rate by value over decisions made in range
  const versions = await EstimateVersion.find({ id: { $in: [...new Set(approvals.map(a => a.estimateVersionId))] } }).select('id lines.id lines.totalCents').lean();
  let decided = 0;
  let approved = 0;
  for (const a of approvals) {
    const v = versions.find(x => x.id === a.estimateVersionId);
    for (const d of a.decisions) {
      const value = v?.lines.find(l => l.id === d.lineId)?.totalCents || 0;
      decided += value;
      if (d.decision === 'approved') approved += value;
    }
  }
  return {
    range: { from: start, to: end },
    locationIds: ids,
    kpis: {
      revenueCents: revenue,
      collectedCents: payments.reduce((s, p) => s + p.amountCents, 0) - refunds.reduce((s, r) => s + r.amountCents, 0),
      invoicesPosted: invoices.length,
      averageRepairOrderCents: invoices.length ? Math.round(revenue / invoices.length) : null,
      carCount: closedRos.length,
      partsGrossMarginPct: partsRevenue ? +(((partsRevenue - partsCost) / partsRevenue) * 100).toFixed(1) : null,
      laborHoursSold: +soldHours.toFixed(2),
      laborHoursClocked: +clockedHours.toFixed(2),
      laborEfficiencyPct: clockedHours ? +((soldHours / clockedHours) * 100).toFixed(1) : null,
      approvalRateByValuePct: decided ? +((approved / decided) * 100).toFixed(1) : null,
      comebacks
    },
    openRepairOrdersByStatus: Object.fromEntries(openRos.map(r => [r._id, r.n])),
    paymentsByMethod: payments.reduce((acc, p) => ({ ...acc, [p.method]: (acc[p.method] || 0) + p.amountCents }), {})
  };
};

export const corporateRollup = async (auth, query) => {
  const locations = await Location.find(isAdmin(auth) ? {} : { id: { $in: auth.locationIds } }).select('id name code').lean();
  const rows = [];
  for (const loc of locations) {
    const d = await dashboard(auth, { ...query, locationId: loc.id });
    rows.push({ location: { id: loc.id, name: loc.name, code: loc.code }, ...d.kpis, openRepairOrders: Object.values(d.openRepairOrdersByStatus).reduce((a, b) => a + b, 0) });
  }
  return rows;
};

// Profit per VIN: invoice revenue (ex tax) minus issued part cost minus
// technician labor cost (clocked time x configured cost rate).
export const profitPerVin = async (auth, query) => {
  const { start, end } = range(query);
  const ids = scope(auth, query.locationId);
  const invoices = await Invoice.find({ ...locMatch(ids), kind: 'repair_order', status: 'posted', postedAt: { $gte: start, $lt: end } }).select('vehicleId roId totals').lean();
  const roIds = invoices.map(i => i.roId);
  const [parts, time, techs] = await Promise.all([
    InstalledPart.aggregate([{ $match: { roId: { $in: roIds } } }, { $group: { _id: '$roId', cost: { $sum: { $multiply: ['$unitCostCents', '$quantity'] } } } }]),
    TimeEntry.aggregate([{ $match: { roId: { $in: roIds }, status: 'closed' } }, { $group: { _id: { roId: '$roId', techId: '$techId' }, minutes: { $sum: '$minutes' } } }]),
    User.find({ role: { $in: ['technician', 'manager'] } }).select('id laborCostRateCents').lean()
  ]);
  const rate = new Map(techs.map(t => [t.id, t.laborCostRateCents]));
  const partCost = new Map(parts.map(p => [p._id, p.cost]));
  const byVehicle = new Map();
  for (const inv of invoices) {
    const v = byVehicle.get(inv.vehicleId) || { vehicleId: inv.vehicleId, visits: 0, revenueCents: 0, partsCostCents: 0, laborCostCents: 0, laborCostComplete: true };
    v.visits += 1;
    v.revenueCents += inv.totals.totalCents - inv.totals.taxCents;
    v.partsCostCents += partCost.get(inv.roId) || 0;
    for (const t of time.filter(x => x._id.roId === inv.roId)) {
      const r = rate.get(t._id.techId);
      if (r == null) v.laborCostComplete = false;
      else v.laborCostCents += Math.round((r * t.minutes) / 60);
    }
    byVehicle.set(inv.vehicleId, v);
  }
  const vehicles = await Vehicle.find({ id: { $in: [...byVehicle.keys()] } }).select('id vin year make model licensePlate').lean();
  return [...byVehicle.values()].map(v => {
    const veh = vehicles.find(x => x.id === v.vehicleId);
    const gross = v.revenueCents - v.partsCostCents - v.laborCostCents;
    return {
      ...v,
      vin: veh?.vin, vehicle: veh ? `${veh.year} ${veh.make} ${veh.model}` : null, licensePlate: veh?.licensePlate,
      grossProfitCents: gross,
      marginPct: v.revenueCents ? +((gross / v.revenueCents) * 100).toFixed(1) : null,
      note: v.laborCostComplete ? null : 'Labor cost incomplete: set technician cost rates in user settings'
    };
  }).sort((a, b) => b.grossProfitCents - a.grossProfitCents);
};
