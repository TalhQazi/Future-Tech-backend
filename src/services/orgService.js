import { Location, CorporateSettings, RepairOrder } from '../models/index.js';
import { RO_OPEN_STATUSES } from '../models/operations.js';
import { audit } from './audit.js';
import { isAdmin, assertLocation, locationFilter } from '../security/access.js';
import { notFound, badRequest, versionConflict, forbidden } from '../lib/errors.js';
import { isValidTimeZone, isTimeString } from '../lib/time.js';
import { uuid } from '../lib/crypto.js';
import { toDTO } from '../lib/http.js';

export const listLocations = async (auth) => {
  const filter = auth.role === 'customer' ? { status: 'active' } : locationFilter(auth, 'id');
  const locations = await Location.find(filter).sort({ name: 1 }).lean();
  return toDTO(locations);
};

export const getLocation = async (auth, id) => {
  const loc = await Location.findOne({ $or: [{ id }, { code: id }] }).lean();
  if (!loc) throw notFound('Location');
  if (auth.role !== 'customer') assertLocation(auth, loc.id);
  return toDTO(loc);
};

const validateLocationInput = (input) => {
  if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) throw badRequest('timezone must be an IANA zone such as America/Chicago');
  if (input.hours) {
    for (const [day, h] of Object.entries(input.hours)) {
      if (h.closed) continue;
      if (!isTimeString(h.open) || !isTimeString(h.close) || h.open >= h.close) throw badRequest(`Opening hours for ${day} are invalid`);
    }
  }
  if (input.bays) {
    const ids = new Set();
    for (const bay of input.bays) {
      if (ids.has(bay.id)) throw badRequest(`Duplicate bay id ${bay.id}`);
      ids.add(bay.id);
    }
  }
};

export const createLocation = async (req, input) => {
  if (!isAdmin(req.auth)) throw forbidden('Only corporate administrators can open locations');
  validateLocationInput(input);
  const location = await Location.create({
    ...input,
    bays: (input.bays || []).map(b => ({ ...b, id: b.id || uuid() })),
    baysCount: (input.bays || []).length
  });
  await audit(req, { eventType: 'LOCATION_CREATED', category: 'data', entityType: 'Location', entityId: location.id, locationId: location.id, action: `Created location ${location.name}` });
  return toDTO(location);
};

export const updateLocation = async (req, id, input, expected) => {
  const loc = await Location.findOne({ id });
  if (!loc) throw notFound('Location');
  assertLocation(req.auth, loc.id);
  if (!isAdmin(req.auth) && (input.status !== undefined || input.code !== undefined)) {
    throw forbidden('Only corporate administrators can change location status or code');
  }
  validateLocationInput(input);
  const set = { ...input };
  if (input.bays) {
    // Bays with open repair orders cannot be removed or deactivated.
    const openBays = await RepairOrder.distinct('bayId', { locationId: id, status: { $in: RO_OPEN_STATUSES }, bayId: { $ne: null } });
    const nextActive = new Set(input.bays.filter(b => b.active !== false).map(b => b.id));
    const blocked = openBays.filter(b => b && !nextActive.has(b));
    if (blocked.length) throw badRequest(`Bays with open repair orders cannot be removed: ${blocked.join(', ')}`);
    set.bays = input.bays.map(b => ({ ...b, id: b.id || uuid() }));
    set.baysCount = set.bays.filter(b => b.active !== false).length;
  }
  const filter = { id };
  if (expected !== undefined) filter.__v = expected;
  const updated = await Location.findOneAndUpdate(filter, { $set: set, $inc: { __v: 1 } }, { new: true });
  if (!updated) throw versionConflict('Location');
  const pricingKeys = ['taxRateBps', 'laborRates', 'laborTaxable', 'partsTaxable', 'feesTaxable', 'partsMarkupMatrix'];
  const pricingChanged = pricingKeys.some(k => input[k] !== undefined);
  await audit(req, {
    eventType: 'LOCATION_SETTINGS_UPDATED', category: pricingChanged ? 'financial' : 'data', entityType: 'Location', entityId: id, locationId: id,
    action: `Updated settings for ${updated.name}${pricingChanged ? ' (pricing/tax)' : ''}`,
    before: pricingChanged ? { taxRateBps: loc.taxRateBps, laborRates: loc.laborRates } : undefined,
    after: pricingChanged ? { taxRateBps: updated.taxRateBps, laborRates: updated.laborRates } : undefined
  });
  return toDTO(updated);
};

export const getBayBoard = async (auth, id) => {
  const loc = await Location.findOne({ id }).lean();
  if (!loc) throw notFound('Location');
  assertLocation(auth, id);
  const ros = await RepairOrder.find({ locationId: id, status: { $in: RO_OPEN_STATUSES }, bayId: { $ne: null } })
    .select('id roNumber status bayId vehicleId customerId assignedTechId promisedAt').lean();
  const byBay = new Map(ros.map(r => [r.bayId, r]));
  return (loc.bays || []).map(bay => ({ ...bay, occupiedRoId: undefined, activeRo: byBay.has(bay.id) ? toDTO(byBay.get(bay.id)) : null }));
};

export const getCorporateSettings = async () => {
  const settings = await CorporateSettings.findOneAndUpdate(
    { key: 'corporate' },
    { $setOnInsert: { key: 'corporate' } },
    { upsert: true, new: true }
  ).lean();
  return toDTO(settings);
};

export const updateCorporateSettings = async (req, input) => {
  if (!isAdmin(req.auth)) throw forbidden('Only corporate administrators can change corporate settings');
  const before = await getCorporateSettings();
  const updated = await CorporateSettings.findOneAndUpdate(
    { key: 'corporate' },
    { $set: { ...input, updatedBy: req.auth.userId } },
    { upsert: true, new: true }
  ).lean();
  await audit(req, {
    eventType: 'CORPORATE_SETTINGS_UPDATED', category: 'override', entityType: 'CorporateSettings', entityId: 'corporate',
    action: `Updated corporate settings (${Object.keys(input).join(', ')})`,
    before: Object.fromEntries(Object.keys(input).map(k => [k, before[k]])),
    after: input
  });
  return toDTO(updated);
};
