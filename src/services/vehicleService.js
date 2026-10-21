import { withTransaction } from '../config/db.js';
import {
  Vehicle, VehicleOwnership, MileageRecord, Customer, RepairOrder, Membership, Finding,
  InstalledPart, PredictiveSignal, Invoice, FuelEvent
} from '../models/index.js';
import { audit } from './audit.js';
import { decodeVin, lookupRecalls, validateVin } from '../adapters/vehicleData.js';
import { assertCustomerScope, projectCustomer } from '../security/access.js';
import { notFound, conflict, badRequest, versionConflict, forbidden } from '../lib/errors.js';
import { escapeRegex, toDTO, paginationMeta } from '../lib/http.js';

const IDENTITY_FIELDS = ['vin', 'year', 'make', 'model', 'trim', 'engine', 'fuelType', 'bodyClass', 'driveType', 'transmission'];

export const assertVehicleAccess = async (auth, vehicle) => {
  if (auth.role !== 'customer') return;
  const owns = vehicle.customerId === auth.customerId
    || await VehicleOwnership.exists({ vehicleId: vehicle.id, customerId: auth.customerId, endedAt: null });
  if (!owns) throw forbidden('You can only access your own vehicles');
};

export const searchVehicles = async (auth, { q, customerId, page, limit, skip }) => {
  const filter = { status: { $ne: 'archived' } };
  if (auth.role === 'customer') filter.customerId = auth.customerId;
  else if (customerId) filter.customerId = customerId;
  if (q) {
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    filter.$or = [{ vin: rx }, { licensePlate: rx }, { make: rx }, { model: rx }];
  }
  const [items, total] = await Promise.all([
    Vehicle.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Vehicle.countDocuments(filter)
  ]);
  const owners = await Customer.find({ id: { $in: [...new Set(items.map(v => v.customerId).filter(Boolean))] } }).select('id name').lean();
  const ownerMap = new Map(owners.map(o => [o.id, o]));
  return {
    vehicles: items.map(v => ({ ...toDTO(v), owner: ownerMap.get(v.customerId) ? { id: v.customerId, name: ownerMap.get(v.customerId).name } : null })),
    pagination: paginationMeta({ page, limit }, total)
  };
};

export const decode = async (vin) => decodeVin(vin);

export const createVehicle = async (req, input) => {
  const customer = await Customer.findOne({ id: input.customerId }).lean();
  if (!customer) throw notFound('Customer');
  let vin = null;
  if (input.vin) {
    const check = validateVin(input.vin);
    if (!check.valid) throw badRequest(check.reason);
    vin = check.vin;
    const existing = await Vehicle.findOne({ vin }).lean();
    if (existing) {
      throw conflict(
        existing.customerId === input.customerId
          ? 'This vehicle is already registered to this customer'
          : 'This VIN is already registered. Transfer ownership instead of creating a duplicate vehicle.',
        'VIN_ALREADY_REGISTERED',
        { vehicleId: existing.id, currentOwnerId: existing.customerId }
      );
    }
  }
  if (!vin && !input.allowMissingVin) throw badRequest('VIN is required (or explicitly mark it as unavailable)');

  let decoded = null;
  if (vin && input.decode !== false) {
    try {
      decoded = await decodeVin(vin);
    } catch {
      decoded = null; // decode service down: keep manually entered identity
    }
  }
  const pick = (field) => input[field] ?? decoded?.[field] ?? undefined;
  if (!pick('make') || !pick('model') || !pick('year')) {
    throw badRequest('Year, make and model are required when the VIN cannot be decoded');
  }

  const vehicle = await withTransaction(async (session) => {
    const [created] = await Vehicle.create([{
      customerId: input.customerId,
      vin,
      year: pick('year'),
      make: pick('make'),
      model: pick('model'),
      trim: pick('trim'),
      engine: pick('engine'),
      fuelType: pick('fuelType'),
      bodyClass: pick('bodyClass'),
      driveType: pick('driveType'),
      transmission: pick('transmission'),
      decode: decoded
        ? { source: 'nhtsa_vpic', decodedAt: new Date(), errorCode: decoded.errorCode, errorText: decoded.errorText }
        : { source: vin ? 'manual' : 'none' },
      licensePlate: input.licensePlate || '',
      plateState: input.plateState || '',
      color: input.color || '',
      mileage: input.mileage || 0,
      mileageUnit: input.mileageUnit || 'mi',
      notes: input.notes
    }], { session });
    await VehicleOwnership.create([{ vehicleId: created.id, customerId: input.customerId, reason: 'initial_registration', recordedBy: req.auth.userId }], { session });
    if (input.mileage) {
      await MileageRecord.create([{ vehicleId: created.id, odometer: input.mileage, unit: input.mileageUnit || 'mi', source: req.auth.role === 'customer' ? 'customer' : 'manual_correction', recordedBy: req.auth.userId, note: 'Initial registration' }], { session });
    }
    await audit(req, { eventType: 'VEHICLE_REGISTERED', category: 'data', entityType: 'Vehicle', entityId: created.id, action: `Registered ${created.year} ${created.make} ${created.model}${vin ? ` VIN ${vin}` : ' (no VIN)'}` }, session);
    return created;
  });
  return { vehicle: toDTO(vehicle), decoded };
};

export const updateVehicle = async (req, id, input, expected) => {
  const vehicle = await Vehicle.findOne({ id }).lean();
  if (!vehicle) throw notFound('Vehicle');
  await assertVehicleAccess(req.auth, vehicle);
  const set = {};
  const editable = req.auth.role === 'customer' ? ['licensePlate', 'plateState', 'color', 'notes'] : ['licensePlate', 'plateState', 'color', 'notes', 'status', 'mileageUnit', ...IDENTITY_FIELDS];
  for (const key of editable) if (input[key] !== undefined) set[key] = input[key];

  const identityChanged = IDENTITY_FIELDS.filter(k => set[k] !== undefined && set[k] !== vehicle[k]);
  if (identityChanged.length) {
    if (!input.reason) throw badRequest('A reason is required to correct vehicle identity fields');
    if (set.vin) {
      const check = validateVin(set.vin);
      if (!check.valid) throw badRequest(check.reason);
      set.vin = check.vin;
      if (await Vehicle.exists({ vin: set.vin, id: { $ne: id } })) throw conflict('This VIN belongs to another vehicle record', 'VIN_ALREADY_REGISTERED');
    }
  }
  const filter = { id };
  if (expected !== undefined) filter.__v = expected;
  const updated = await Vehicle.findOneAndUpdate(filter, { $set: set, $inc: { __v: 1 } }, { new: true }).lean();
  if (!updated) throw versionConflict('Vehicle');
  await audit(req, {
    eventType: identityChanged.length ? 'VEHICLE_IDENTITY_CORRECTED' : 'VEHICLE_UPDATED',
    category: identityChanged.length ? 'override' : 'data',
    entityType: 'Vehicle', entityId: id,
    action: identityChanged.length ? `Corrected identity fields: ${identityChanged.join(', ')}` : `Updated ${Object.keys(set).join(', ')}`,
    reason: input.reason,
    before: identityChanged.length ? Object.fromEntries(identityChanged.map(k => [k, vehicle[k]])) : undefined,
    after: identityChanged.length ? Object.fromEntries(identityChanged.map(k => [k, updated[k]])) : undefined
  });
  return toDTO(updated);
};

export const transferOwnership = async (req, id, { toCustomerId, reason, note }) => {
  const [vehicle, newOwner] = await Promise.all([Vehicle.findOne({ id }).lean(), Customer.findOne({ id: toCustomerId }).lean()]);
  if (!vehicle) throw notFound('Vehicle');
  if (!newOwner) throw notFound('New owner');
  if (vehicle.customerId === toCustomerId) throw badRequest('The vehicle already belongs to this customer');
  const now = new Date();
  await withTransaction(async (session) => {
    await VehicleOwnership.updateMany({ vehicleId: id, endedAt: null }, { $set: { endedAt: now } }, { session });
    await VehicleOwnership.create([{ vehicleId: id, customerId: toCustomerId, startedAt: now, reason: reason || 'transfer', recordedBy: req.auth.userId, note }], { session });
    await Vehicle.updateOne({ id }, { $set: { customerId: toCustomerId, status: 'active' }, $inc: { __v: 1 } }, { session });
    // memberships covering this vehicle do not transfer with it
    await Membership.updateMany({ customerId: vehicle.customerId, vehicleIds: id }, { $pull: { vehicleIds: id } }, { session });
    await audit(req, {
      eventType: 'VEHICLE_OWNERSHIP_TRANSFERRED', category: 'data', entityType: 'Vehicle', entityId: id,
      action: `Ownership transferred to customer ${toCustomerId}`, before: { customerId: vehicle.customerId }, after: { customerId: toCustomerId }, reason: note
    }, session);
  });
  return getVehicle(req.auth, id);
};

/**
 * Appends a mileage reading. Readings lower than the latest are kept but
 * flagged (possible odometer rollback or typo) and do not lower vehicle.mileage.
 */
export const recordMileage = async (req, vehicleId, { odometer, unit, source, sourceRef, note }, session = null) => {
  const vehicle = await Vehicle.findOne({ id: vehicleId }).session(session).lean();
  if (!vehicle) throw notFound('Vehicle');
  if (!Number.isFinite(odometer) || odometer < 0) throw badRequest('Odometer must be a non-negative number');
  const latest = vehicle.mileage || 0;
  const flagged = odometer < latest;
  const [record] = await MileageRecord.create([{
    vehicleId, odometer, unit: unit || vehicle.mileageUnit || 'mi', source, sourceRef,
    recordedBy: req?.auth?.userId, flagged, note: flagged ? `${note ? `${note}. ` : ''}Lower than previous reading ${latest}` : note
  }], { session });
  if (!flagged) await Vehicle.updateOne({ id: vehicleId, mileage: { $lte: odometer } }, { $set: { mileage: odometer } }, { session });
  if (flagged && req) {
    await audit(req, { eventType: 'MILEAGE_DISCREPANCY', category: 'data', entityType: 'Vehicle', entityId: vehicleId, action: `Odometer ${odometer} is lower than previous reading ${latest}` }, session);
  }
  return record;
};

export const getVehicle = async (auth, id) => {
  const vehicle = await Vehicle.findOne({ $or: [{ id }, { vin: String(id).toUpperCase() }] }).lean();
  if (!vehicle) throw notFound('Vehicle');
  await assertVehicleAccess(auth, vehicle);
  const isCustomer = auth.role === 'customer';
  const [owner, ownership, mileage, ros, memberships, signals] = await Promise.all([
    vehicle.customerId ? Customer.findOne({ id: vehicle.customerId }).lean() : null,
    isCustomer ? [] : VehicleOwnership.find({ vehicleId: vehicle.id }).sort({ startedAt: -1 }).lean(),
    MileageRecord.find({ vehicleId: vehicle.id }).sort({ recordedAt: -1 }).limit(50).lean(),
    RepairOrder.find(isCustomer ? { vehicleId: vehicle.id, customerId: auth.customerId } : { vehicleId: vehicle.id })
      .sort({ createdAt: -1 }).limit(25).select('id roNumber status locationId createdAt closedAt odometerIn concerns').lean(),
    Membership.find({ customerId: vehicle.customerId, status: { $in: ['active', 'past_due'] }, $or: [{ vehicleIds: { $size: 0 } }, { vehicleIds: vehicle.id }] }).lean(),
    PredictiveSignal.find({ vehicleId: vehicle.id, status: 'open' }).sort({ createdAt: -1 }).lean()
  ]);
  return {
    ...toDTO(vehicle),
    owner: owner ? projectCustomer(auth, { id: owner.id, name: owner.name, phone: owner.phone, email: owner.email }) : null,
    ownershipHistory: toDTO(ownership),
    mileageHistory: toDTO(mileage),
    repairOrders: toDTO(ros),
    memberships: toDTO(memberships),
    predictiveSignals: toDTO(signals)
  };
};

// Consolidated service history from transactional records (no fabricated entries).
export const getServiceHistory = async (auth, id) => {
  const vehicle = await Vehicle.findOne({ id }).lean();
  if (!vehicle) throw notFound('Vehicle');
  await assertVehicleAccess(auth, vehicle);
  const roFilter = { vehicleId: id, status: { $ne: 'cancelled' } };
  if (auth.role === 'customer') roFilter.customerId = auth.customerId;
  const ros = await RepairOrder.find(roFilter).sort({ createdAt: -1 }).lean();
  const roIds = ros.map(r => r.id);
  const [invoices, declined, installed, fuel] = await Promise.all([
    Invoice.find({ roId: { $in: roIds }, status: 'posted' }).select('roId invoiceNumber totals postedAt paymentStatus').lean(),
    Finding.find({ roId: { $in: roIds }, status: 'active', customerDecision: 'declined' }).select('roId name condition severity recommendation createdAt').lean(),
    auth.role === 'customer' ? [] : InstalledPart.find({ vehicleId: id }).sort({ installedAt: -1 }).lean(),
    FuelEvent.find({ vehicleId: id }).sort({ at: -1 }).limit(20).lean()
  ]);
  const invByRo = new Map(invoices.map(i => [i.roId, i]));
  return {
    vehicle: toDTO(vehicle),
    visits: ros.map(r => ({
      roId: r.id,
      roNumber: r.roNumber,
      status: r.status,
      date: r.createdAt,
      closedAt: r.closedAt,
      odometerIn: r.odometerIn,
      concerns: (r.concerns || []).map(c => ({ text: c.text, cause: c.cause, correction: c.correction })),
      jobs: (r.jobs || []).filter(j => ['completed', 'verified'].includes(j.status)).map(j => ({ title: j.title, completedAt: j.completedAt })),
      invoice: invByRo.has(r.id) ? { number: invByRo.get(r.id).invoiceNumber, totalCents: invByRo.get(r.id).totals?.totalCents, paymentStatus: invByRo.get(r.id).paymentStatus } : null
    })),
    declinedRecommendations: toDTO(declined),
    installedParts: toDTO(installed),
    fuelEvents: toDTO(fuel)
  };
};

export const getRecalls = async (auth, id) => {
  const vehicle = await Vehicle.findOne({ id }).lean();
  if (!vehicle) throw notFound('Vehicle');
  await assertVehicleAccess(auth, vehicle);
  return lookupRecalls({ make: vehicle.make, model: vehicle.model, year: vehicle.year });
};

export { assertCustomerScope };
