import { Customer, Vehicle, VehicleOwnership, RepairOrder, Membership, Invoice, User } from '../models/index.js';
import { CONSENT_TYPES } from '../models/customers.js';
import { audit } from './audit.js';
import { projectCustomer, assertCustomerScope } from '../security/access.js';
import { notFound, conflict, versionConflict, badRequest } from '../lib/errors.js';
import { escapeRegex, toDTO, paginationMeta } from '../lib/http.js';
import { uuid } from '../lib/crypto.js';

export const currentConsents = (customer) => {
  const state = {};
  for (const type of CONSENT_TYPES) state[type] = { granted: false, at: null, source: null };
  for (const ev of [...(customer.consentEvents || [])].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    state[ev.type] = { granted: ev.granted, at: ev.at, source: ev.source, textVersion: ev.textVersion };
  }
  return state;
};

const normalizePhone = (p = '') => p.replace(/[^\d+]/g, '');

export const searchCustomers = async (auth, { q, page, limit, skip }) => {
  const filter = { status: { $ne: 'archived' } };
  if (q) {
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    const digits = q.replace(/\D/g, '');
    const or = [{ name: rx }, { email: rx }, { companyName: rx }];
    if (digits.length >= 3) or.push({ phone: new RegExp(escapeRegex(digits)) });
    // match by vehicle VIN / plate as well
    const vehicles = await Vehicle.find({ $or: [{ vin: rx }, { licensePlate: rx }] }).select('customerId').limit(50).lean();
    if (vehicles.length) or.push({ id: { $in: vehicles.map(v => v.customerId).filter(Boolean) } });
    filter.$or = or;
  }
  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Customer.countDocuments(filter)
  ]);
  const ids = items.map(c => c.id);
  const [vehicleCounts, memberships] = await Promise.all([
    Vehicle.aggregate([{ $match: { customerId: { $in: ids }, status: 'active' } }, { $group: { _id: '$customerId', n: { $sum: 1 } } }]),
    Membership.find({ customerId: { $in: ids }, status: { $in: ['active', 'past_due'] } }).select('customerId number status planId').lean()
  ]);
  const vc = new Map(vehicleCounts.map(v => [v._id, v.n]));
  const mm = new Map(memberships.map(m => [m.customerId, m]));
  return {
    customers: items.map(c => projectCustomer(auth, {
      ...toDTO(c),
      vehicleCount: vc.get(c.id) || 0,
      activeMembership: mm.get(c.id) ? { number: mm.get(c.id).number, status: mm.get(c.id).status } : null
    })),
    pagination: paginationMeta({ page, limit }, total)
  };
};

export const getCustomer = async (auth, id) => {
  assertCustomerScope(auth, id);
  const customer = await Customer.findOne({ id }).lean();
  if (!customer) throw notFound('Customer');
  const [vehicles, memberships, recentRos, openBalance, portalUser] = await Promise.all([
    Vehicle.find({ customerId: id, status: { $ne: 'archived' } }).sort({ year: -1 }).lean(),
    Membership.find({ customerId: id }).sort({ createdAt: -1 }).lean(),
    RepairOrder.find({ customerId: id }).sort({ createdAt: -1 }).limit(20)
      .select('id roNumber status vehicleId locationId createdAt closedAt promisedAt').lean(),
    Invoice.aggregate([{ $match: { customerId: id, status: 'posted' } }, { $group: { _id: null, balance: { $sum: '$balanceCents' } } }]),
    customer.userId ? User.findOne({ id: customer.userId }).select('status lastLoginAt').lean() : null
  ]);
  return projectCustomer(auth, {
    ...toDTO(customer),
    consents: currentConsents(customer),
    vehicles: toDTO(vehicles),
    memberships: toDTO(memberships),
    recentRepairOrders: toDTO(recentRos),
    openBalanceCents: openBalance[0]?.balance || 0,
    portalAccount: portalUser ? { status: portalUser.status, lastLoginAt: portalUser.lastLoginAt } : null
  });
};

export const findDuplicates = async ({ email, phone, excludeId }) => {
  const or = [];
  if (email) or.push({ email: email.toLowerCase().trim() });
  const digits = normalizePhone(phone || '');
  if (digits.length >= 7) or.push({ phone: new RegExp(`${escapeRegex(digits.slice(-7))}$`) });
  if (!or.length) return [];
  const filter = { $or: or, status: { $ne: 'archived' } };
  if (excludeId) filter.id = { $ne: excludeId };
  return Customer.find(filter).select('id name email phone').limit(5).lean();
};

export const createCustomer = async (req, input) => {
  if (!input.allowDuplicate) {
    const dupes = await findDuplicates(input);
    if (dupes.length) {
      throw conflict('A customer with this email or phone already exists', 'POSSIBLE_DUPLICATE', { matches: toDTO(dupes) });
    }
  }
  const consentEvents = (input.consents || []).map(c => ({
    id: uuid(), type: c.type, granted: c.granted, at: new Date(), source: c.source || 'in_person',
    capturedBy: req.auth.userId, textVersion: c.textVersion, note: c.note
  }));
  const customer = await Customer.create({
    type: input.type,
    name: input.name.trim(),
    companyName: input.companyName,
    phone: input.phone || '',
    email: (input.email || '').toLowerCase().trim(),
    address: input.address || '',
    preferredContact: input.preferredContact,
    homeLocationId: input.homeLocationId || req.auth.primaryLocationId,
    tags: input.tags || [],
    consentEvents,
    createdBy: req.auth.userId
  });
  await audit(req, { eventType: 'CUSTOMER_CREATED', category: 'data', entityType: 'Customer', entityId: customer.id, locationId: customer.homeLocationId, action: 'Created customer record' });
  if (consentEvents.length) {
    await audit(req, { eventType: 'CONSENT_RECORDED', category: 'data', entityType: 'Customer', entityId: customer.id, action: `Recorded consent: ${consentEvents.map(c => `${c.type}=${c.granted}`).join(', ')}` });
  }
  return projectCustomer(req.auth, { ...toDTO(customer), consents: currentConsents(customer) });
};

export const updateCustomer = async (req, id, input, expected) => {
  assertCustomerScope(req.auth, id);
  const current = await Customer.findOne({ id }).lean();
  if (!current) throw notFound('Customer');
  if (input.email || input.phone) {
    const dupes = await findDuplicates({ email: input.email, phone: input.phone, excludeId: id });
    if (dupes.length && !input.allowDuplicate) throw conflict('Another customer already uses this email or phone', 'POSSIBLE_DUPLICATE', { matches: toDTO(dupes) });
  }
  const allowed = req.auth.role === 'customer'
    ? ['phone', 'address', 'preferredContact']
    : ['type', 'name', 'companyName', 'phone', 'email', 'address', 'preferredContact', 'homeLocationId', 'tags', 'status'];
  const set = {};
  for (const key of allowed) if (input[key] !== undefined) set[key] = key === 'email' ? input[key].toLowerCase().trim() : input[key];
  if (!Object.keys(set).length) throw badRequest('No editable fields supplied');
  const filter = { id };
  if (expected !== undefined) filter.__v = expected;
  const updated = await Customer.findOneAndUpdate(filter, { $set: set, $inc: { __v: 1 } }, { new: true }).lean();
  if (!updated) throw versionConflict('Customer');
  if (set.email && updated.userId) await User.updateOne({ id: updated.userId, role: 'customer' }, { $set: { email: set.email } });
  await audit(req, { eventType: 'CUSTOMER_UPDATED', category: 'data', entityType: 'Customer', entityId: id, action: `Updated customer fields: ${Object.keys(set).join(', ')}` });
  return projectCustomer(req.auth, { ...toDTO(updated), consents: currentConsents(updated) });
};

export const recordConsent = async (req, id, input) => {
  assertCustomerScope(req.auth, id);
  const event = {
    id: uuid(), type: input.type, granted: input.granted, at: new Date(),
    source: req.auth.role === 'customer' ? 'portal' : (input.source || 'in_person'),
    capturedBy: req.auth.userId, textVersion: input.textVersion, note: input.note
  };
  const updated = await Customer.findOneAndUpdate({ id }, { $push: { consentEvents: event }, $inc: { __v: 1 } }, { new: true }).lean();
  if (!updated) throw notFound('Customer');
  await audit(req, { eventType: 'CONSENT_RECORDED', category: 'data', entityType: 'Customer', entityId: id, action: `${input.granted ? 'Granted' : 'Withdrew'} consent ${input.type} via ${event.source}` });
  return { consents: currentConsents(updated), consentEvents: updated.consentEvents };
};

export const hasConsent = (customer, type) => Boolean(currentConsents(customer)[type]?.granted);

export const customerOwnsVehicle = async (customerId, vehicleId) =>
  Boolean(await VehicleOwnership.exists({ customerId, vehicleId, endedAt: null }) || await Vehicle.exists({ id: vehicleId, customerId }));
