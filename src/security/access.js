import { forbidden, notFound, badRequest } from '../lib/errors.js';
import { hasPermission } from './permissions.js';
import { RepairOrder } from '../models/index.js';

// Contextual authorization helpers. Every staff user is scoped to the
// locations they are assigned to; corporate admins see every location.

export const isAdmin = (auth) => auth?.role === 'admin';
// Corporate roles see every location.
export const isCorporateScope = (auth) => ['admin', 'executive'].includes(auth?.role);

export const can = (auth, permission) => Boolean(auth && hasPermission(auth.role, permission));

export const assertCan = (auth, permission) => {
  if (!can(auth, permission)) throw forbidden(`Missing permission: ${permission}`);
};

export const assertLocation = (auth, locationId) => {
  if (isCorporateScope(auth)) return;
  if (!locationId || !auth.locationIds.includes(locationId)) {
    throw forbidden('This record belongs to a location you are not assigned to');
  }
};

export const locationFilter = (auth, field = 'locationId') =>
  (isCorporateScope(auth) ? {} : { [field]: { $in: auth.locationIds } });

// Picks the requested location when permitted, otherwise the user's primary one.
export const resolveLocationId = (auth, requested) => {
  if (requested) {
    assertLocation(auth, requested);
    return requested;
  }
  const fallback = auth.primaryLocationId || auth.locationIds[0];
  if (!fallback) throw badRequest('locationId is required (your account is not assigned to a location)');
  return fallback;
};

export const assertCustomerScope = (auth, customerId) => {
  if (auth.role === 'customer' && auth.customerId !== customerId) {
    throw forbidden('You can only access your own records');
  }
};

export const findRoForAccess = async (auth, idOrNumber, { session = null } = {}) => {
  const ro = await RepairOrder.findOne({ $or: [{ id: idOrNumber }, { roNumber: idOrNumber }] }).session(session);
  if (!ro) throw notFound('Repair order');
  if (auth.role === 'customer') {
    assertCustomerScope(auth, ro.customerId);
  } else {
    assertLocation(auth, ro.locationId);
  }
  return ro;
};

// Data minimisation: roles without customers:pii receive no contact details.
export const projectCustomer = (auth, customer) => {
  if (!customer) return customer;
  if (can(auth, 'customers:pii') || (auth.role === 'customer' && auth.customerId === customer.id)) return customer;
  const { phone, email, address, consentEvents, ...rest } = customer;
  return { ...rest, contactRestricted: true };
};
