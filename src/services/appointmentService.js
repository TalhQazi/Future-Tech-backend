import { Appointment, Location, Customer, Vehicle, User } from '../models/index.js';
import { audit } from './audit.js';
import { nextNumber, shortCode } from './sequence.js';
import { assertLocation, locationFilter, can } from '../security/access.js';
import { customerOwnsVehicle } from './customerService.js';
import { notFound, badRequest, conflict, forbidden } from '../lib/errors.js';
import { localDate, localTime, zonedToUtc, localDayBounds, weekdayKey, isDateString, isTimeString } from '../lib/time.js';
import { toDTO } from '../lib/http.js';

const ACTIVE_STATUSES = ['scheduled', 'confirmed', 'arrived'];
const TRANSITIONS = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['arrived', 'cancelled', 'no_show'],
  arrived: ['cancelled'],
  checked_in: ['completed'],
  completed: [],
  no_show: ['scheduled'],
  cancelled: ['scheduled']
};

const loadLocation = async (locationId) => {
  const loc = await Location.findOne({ id: locationId, status: { $ne: 'inactive' } }).lean();
  if (!loc) throw notFound('Location');
  return loc;
};

const activeBays = (loc) => (loc.bays || []).filter(b => b.active !== false);

const openWindow = (loc, dateStr) => {
  const hours = loc.hours?.[weekdayKey(dateStr)];
  if (!hours || hours.closed) return null;
  return {
    start: zonedToUtc(dateStr, hours.open, loc.timezone),
    end: zonedToUtc(dateStr, hours.close, loc.timezone),
    open: hours.open,
    close: hours.close
  };
};

const overlapping = (locationId, start, end, extra = {}) =>
  Appointment.find({
    locationId,
    status: { $in: ACTIVE_STATUSES },
    startAt: { $lt: end },
    $expr: { $gt: [{ $add: ['$startAt', { $multiply: ['$durationMinutes', 60000] }] }, start] },
    ...extra
  }).lean();

export const getCapacity = async (auth, { locationId, date }) => {
  if (auth.role !== 'customer') assertLocation(auth, locationId);
  if (!isDateString(date)) throw badRequest('date must be YYYY-MM-DD');
  const loc = await loadLocation(locationId);
  const bays = activeBays(loc);
  const window = openWindow(loc, date);
  const { start, end } = localDayBounds(date, loc.timezone);
  const apts = await Appointment.find({ locationId, startAt: { $gte: start, $lt: end }, status: { $nin: ['cancelled', 'no_show'] } }).lean();
  const openMinutes = window ? (window.end - window.start) / 60000 : 0;
  const capacityMinutes = openMinutes * bays.length;
  const bookedMinutes = apts.reduce((s, a) => s + (a.durationMinutes || 0), 0);
  return {
    locationId,
    date,
    timezone: loc.timezone,
    open: Boolean(window),
    hours: window ? { open: window.open, close: window.close } : null,
    activeBays: bays.length,
    capacityHours: +(capacityMinutes / 60).toFixed(2),
    bookedHours: +(bookedMinutes / 60).toFixed(2),
    availableHours: +(Math.max(0, capacityMinutes - bookedMinutes) / 60).toFixed(2),
    utilizationPercent: capacityMinutes > 0 ? Math.min(100, Math.round((bookedMinutes / capacityMinutes) * 100)) : 0,
    appointmentsCount: apts.length
  };
};

export const getAvailability = async (auth, { locationId, date, durationMinutes = 60 }) => {
  const loc = await loadLocation(locationId);
  if (auth.role !== 'customer') assertLocation(auth, locationId);
  if (!isDateString(date)) throw badRequest('date must be YYYY-MM-DD');
  const window = openWindow(loc, date);
  if (!window) return { locationId, date, timezone: loc.timezone, open: false, slots: [] };
  const bays = activeBays(loc).length;
  const step = (loc.appointmentSlotMinutes || 30) * 60000;
  const apts = await overlapping(locationId, window.start, window.end);
  const slots = [];
  for (let t = window.start.getTime(); t + durationMinutes * 60000 <= window.end.getTime(); t += step) {
    const s = t;
    const e = t + durationMinutes * 60000;
    const concurrent = apts.filter(a => a.startAt.getTime() < e && a.startAt.getTime() + a.durationMinutes * 60000 > s).length;
    if (s > Date.now()) {
      slots.push({ startAt: new Date(s).toISOString(), time: localTime(new Date(s), loc.timezone), available: concurrent < bays, remainingBays: Math.max(0, bays - concurrent) });
    }
  }
  return { locationId, date, timezone: loc.timezone, open: true, slots };
};

const enrich = async (apts) => {
  const customers = await Customer.find({ id: { $in: [...new Set(apts.map(a => a.customerId))] } }).select('id name phone').lean();
  const vehicles = await Vehicle.find({ id: { $in: [...new Set(apts.map(a => a.vehicleId))] } }).select('id year make model vin licensePlate').lean();
  const techs = await User.find({ id: { $in: [...new Set(apts.map(a => a.assignedTechId).filter(Boolean))] } }).select('id name').lean();
  const cm = new Map(customers.map(c => [c.id, c]));
  const vm = new Map(vehicles.map(v => [v.id, v]));
  const tm = new Map(techs.map(t => [t.id, t]));
  return apts.map(a => ({
    ...toDTO(a),
    customer: cm.get(a.customerId) ? toDTO(cm.get(a.customerId)) : null,
    vehicle: vm.get(a.vehicleId) ? toDTO(vm.get(a.vehicleId)) : null,
    assignedTech: tm.get(a.assignedTechId) ? { id: a.assignedTechId, name: tm.get(a.assignedTechId).name } : null
  }));
};

export const listAppointments = async (auth, { locationId, date, from, to, status, customerId }) => {
  const filter = {};
  if (auth.role === 'customer') {
    filter.customerId = auth.customerId;
  } else {
    Object.assign(filter, locationFilter(auth));
    if (locationId) {
      assertLocation(auth, locationId);
      filter.locationId = locationId;
    }
    if (customerId) filter.customerId = customerId;
  }
  if (status) filter.status = status;
  if (date && filter.locationId) {
    const loc = await loadLocation(filter.locationId);
    const { start, end } = localDayBounds(date, loc.timezone);
    filter.startAt = { $gte: start, $lt: end };
  } else if (from || to) {
    filter.startAt = {};
    if (from) filter.startAt.$gte = new Date(from);
    if (to) filter.startAt.$lt = new Date(to);
  }
  const apts = await Appointment.find(filter).sort({ startAt: 1 }).limit(500).lean();
  return enrich(apts);
};

export const getAppointment = async (auth, id) => {
  const apt = await Appointment.findOne({ $or: [{ id }, { appointmentNumber: id }] }).lean();
  if (!apt) throw notFound('Appointment');
  if (auth.role === 'customer') {
    if (apt.customerId !== auth.customerId) throw forbidden();
  } else {
    assertLocation(auth, apt.locationId);
  }
  return (await enrich([apt]))[0];
};

export const createAppointment = async (req, input) => {
  const { auth } = req;
  const isCustomer = auth.role === 'customer';
  const customerId = isCustomer ? auth.customerId : input.customerId;
  if (!isCustomer) assertLocation(auth, input.locationId);
  if (!isDateString(input.date) || !isTimeString(input.time)) throw badRequest('date (YYYY-MM-DD) and time (HH:mm) are required');
  const loc = await loadLocation(input.locationId);
  if (!(await customerOwnsVehicle(customerId, input.vehicleId))) throw badRequest('The vehicle does not belong to this customer');

  const startAt = zonedToUtc(input.date, input.time, loc.timezone);
  const durationMinutes = input.durationMinutes || 60;
  const endAt = new Date(startAt.getTime() + durationMinutes * 60000);
  if (startAt.getTime() < Date.now() - 5 * 60000) throw badRequest('Appointments cannot be booked in the past');

  const override = Boolean(input.overrideCapacity) && !isCustomer && can(auth, 'ros:override');
  const window = openWindow(loc, input.date);
  if (!window || startAt < window.start || endAt > window.end) {
    if (!override) throw conflict('The requested time is outside opening hours', 'OUTSIDE_HOURS');
  }
  const concurrent = await overlapping(loc.id, startAt, endAt);
  if (concurrent.length >= activeBays(loc).length && !override) {
    throw conflict('No bay capacity at the requested time. Choose another slot.', 'NO_CAPACITY');
  }
  if (input.assignedBay) {
    if (!activeBays(loc).some(b => b.id === input.assignedBay)) throw badRequest('Unknown or inactive bay');
    if (concurrent.some(a => a.assignedBay === input.assignedBay) && !override) throw conflict('That bay is already booked at this time', 'BAY_CONFLICT');
  }
  if (input.assignedTechId) {
    const tech = await User.findOne({ id: input.assignedTechId, role: 'technician', status: 'active', locationIds: loc.id }).lean();
    if (!tech) throw badRequest('Technician is not active at this location');
    if (concurrent.some(a => a.assignedTechId === input.assignedTechId) && !override) throw conflict('That technician is already booked at this time', 'TECH_CONFLICT');
  }

  const apt = await Appointment.create({
    appointmentNumber: await nextNumber('APT', shortCode(loc.code), input.date.slice(0, 4)),
    locationId: loc.id,
    customerId,
    vehicleId: input.vehicleId,
    startAt,
    durationMinutes,
    scheduledDate: input.date,
    scheduledTime: input.time,
    serviceRequested: input.serviceRequested || '',
    laborOpCodes: input.laborOpCodes || [],
    concerns: input.concerns || [],
    customerNotes: input.customerNotes || '',
    transportation: input.transportation || 'unknown',
    source: isCustomer ? 'portal' : (input.source || 'staff'),
    assignedBay: isCustomer ? undefined : input.assignedBay,
    assignedTechId: isCustomer ? undefined : input.assignedTechId,
    estimatedHours: +(durationMinutes / 60).toFixed(2),
    createdBy: auth.userId
  });
  await audit(req, {
    eventType: 'APPOINTMENT_SCHEDULED', category: override ? 'override' : 'operational', entityType: 'Appointment', entityId: apt.id, locationId: loc.id,
    action: `Booked ${apt.appointmentNumber} for ${input.date} ${input.time}${override ? ' (capacity/hours override)' : ''}`,
    reason: override ? input.overrideReason : undefined
  });
  return getAppointment(auth, apt.id);
};

export const rescheduleAppointment = async (req, id, input) => {
  const apt = await Appointment.findOne({ id }).lean();
  if (!apt) throw notFound('Appointment');
  if (req.auth.role === 'customer' ? apt.customerId !== req.auth.customerId : false) throw forbidden();
  if (req.auth.role !== 'customer') assertLocation(req.auth, apt.locationId);
  if (!ACTIVE_STATUSES.includes(apt.status)) throw conflict(`A ${apt.status} appointment cannot be rescheduled`);
  const loc = await loadLocation(apt.locationId);
  const date = input.date || apt.scheduledDate;
  const time = input.time || apt.scheduledTime;
  const startAt = zonedToUtc(date, time, loc.timezone);
  const durationMinutes = input.durationMinutes || apt.durationMinutes;
  const endAt = new Date(startAt.getTime() + durationMinutes * 60000);
  const override = Boolean(input.overrideCapacity) && can(req.auth, 'ros:override');
  const window = openWindow(loc, date);
  if ((!window || startAt < window.start || endAt > window.end) && !override) throw conflict('The requested time is outside opening hours', 'OUTSIDE_HOURS');
  const concurrent = (await overlapping(loc.id, startAt, endAt)).filter(a => a.id !== id);
  if (concurrent.length >= activeBays(loc).length && !override) throw conflict('No bay capacity at the requested time', 'NO_CAPACITY');
  const set = { startAt, durationMinutes, scheduledDate: date, scheduledTime: time, estimatedHours: +(durationMinutes / 60).toFixed(2) };
  if (req.auth.role !== 'customer') {
    for (const k of ['assignedBay', 'assignedTechId', 'serviceRequested', 'customerNotes', 'transportation']) if (input[k] !== undefined) set[k] = input[k];
  }
  const updated = await Appointment.findOneAndUpdate({ id, status: { $in: ACTIVE_STATUSES } }, { $set: set, $inc: { __v: 1 } }, { new: true }).lean();
  if (!updated) throw conflict('Appointment status changed; reload and try again');
  await audit(req, { eventType: 'APPOINTMENT_RESCHEDULED', category: override ? 'override' : 'operational', entityType: 'Appointment', entityId: id, locationId: apt.locationId, action: `Rescheduled ${apt.appointmentNumber} to ${date} ${time}` });
  return getAppointment(req.auth, id);
};

export const changeAppointmentStatus = async (req, id, { status, reason }) => {
  const apt = await Appointment.findOne({ id }).lean();
  if (!apt) throw notFound('Appointment');
  if (req.auth.role === 'customer') {
    if (apt.customerId !== req.auth.customerId) throw forbidden();
    if (status !== 'cancelled') throw forbidden('Customers can only cancel appointments');
  } else {
    assertLocation(req.auth, apt.locationId);
  }
  if (status === 'checked_in') throw badRequest('Use check-in to open a repair order');
  if (!(TRANSITIONS[apt.status] || []).includes(status)) throw conflict(`Cannot change appointment from ${apt.status} to ${status}`, 'INVALID_TRANSITION');
  if (status === 'cancelled' && !reason) throw badRequest('A cancellation reason is required');
  const set = { status };
  if (status === 'cancelled') Object.assign(set, { cancelledReason: reason, cancelledBy: req.auth.userId });
  const updated = await Appointment.findOneAndUpdate({ id, status: apt.status }, { $set: set, $inc: { __v: 1 } }, { new: true }).lean();
  if (!updated) throw conflict('Appointment changed concurrently; reload and try again');
  await audit(req, { eventType: 'APPOINTMENT_STATUS_CHANGED', entityType: 'Appointment', entityId: id, locationId: apt.locationId, action: `${apt.appointmentNumber}: ${apt.status} -> ${status}`, reason });
  return getAppointment(req.auth, id);
};

export const markCheckedIn = async (appointmentId, roId, session) => {
  const res = await Appointment.updateOne(
    { id: appointmentId, status: { $in: ACTIVE_STATUSES }, roId: null },
    { $set: { status: 'checked_in', roId }, $inc: { __v: 1 } },
    { session }
  );
  if (res.modifiedCount !== 1) throw conflict('This appointment was already checked in or is no longer active', 'ALREADY_CHECKED_IN');
};

export const localDateFor = (date, tz) => localDate(date, tz);
