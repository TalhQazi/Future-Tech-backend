import { Router } from 'express';
import { z, h, ok, id, page, reqText, text, dateStr, timeStr, expectedVersion } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import * as customers from '../../services/customerService.js';
import * as vehicles from '../../services/vehicleService.js';
import * as appointments from '../../services/appointmentService.js';
import { inviteCustomerToPortal } from '../../services/userService.js';
import { CONSENT_TYPES } from '../../models/customers.js';

const r = Router();
const staffOr = (perm) => requireAnyPermission(perm, 'portal:access');

// ---- customers ------------------------------------------------------------------
const consent = z.object({ type: z.enum(CONSENT_TYPES), granted: z.boolean(), source: z.enum(['in_person', 'portal', 'phone', 'paper_form', 'import']).optional(), textVersion: text(40).optional(), note: text(500).optional() });
const customerBody = z.object({
  type: z.enum(['individual', 'fleet']).optional(), name: reqText(160), companyName: text(160).optional(),
  phone: text(30).optional(), email: z.string().trim().email().optional().or(z.literal('')), address: text(300).optional(),
  preferredContact: z.enum(['sms', 'email', 'phone', 'portal']).optional(), homeLocationId: id.optional(),
  tags: z.array(text(40)).optional(), consents: z.array(consent).optional(), allowDuplicate: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional()
});
r.get('/customers', requirePermission('customers:read'), h(async (req, res) => ok(res, await customers.searchCustomers(req.auth, { q: req.query.q, ...page(req) }))));
r.get('/customers/:id', staffOr('customers:read'), h(async (req, res) => ok(res, { customer: await customers.getCustomer(req.auth, req.params.id) })));
r.post('/customers', requirePermission('customers:write'), validate({ body: customerBody }), h(async (req, res) => ok(res, { customer: await customers.createCustomer(req, req.body) }, 201)));
r.patch('/customers/:id', staffOr('customers:write'), validate({ body: customerBody.partial() }), h(async (req, res) => ok(res, { customer: await customers.updateCustomer(req, req.params.id, req.body, expectedVersion(req)) })));
r.post('/customers/:id/consents', staffOr('customers:write'), validate({ body: consent }), h(async (req, res) => ok(res, await customers.recordConsent(req, req.params.id, req.body), 201)));
r.post('/customers/:id/portal-invite', requirePermission('customers:write'), h(async (req, res) => ok(res, await inviteCustomerToPortal(req, req.params.id))));

// ---- vehicles -------------------------------------------------------------------
const vehicleBody = z.object({
  customerId: id, vin: text(17).optional(), allowMissingVin: z.boolean().optional(), decode: z.boolean().optional(),
  year: z.number().int().min(1900).max(2100).optional(), make: text(60).optional(), model: text(80).optional(), trim: text(80).optional(), engine: text(120).optional(),
  fuelType: text(40).optional(), bodyClass: text(60).optional(), driveType: text(40).optional(), transmission: text(60).optional(),
  licensePlate: text(15).optional(), plateState: text(5).optional(), color: text(40).optional(),
  mileage: z.number().int().min(0).max(5_000_000).optional(), mileageUnit: z.enum(['mi', 'km']).optional(), notes: text(1000).optional()
});
r.get('/vehicles/decode-vin/:vin', requirePermission('vehicles:read'), h(async (req, res) => ok(res, { decoded: await vehicles.decode(req.params.vin) })));
r.get('/vehicles', staffOr('vehicles:read'), h(async (req, res) => ok(res, await vehicles.searchVehicles(req.auth, { q: req.query.q, customerId: req.query.customerId, ...page(req) }))));
r.get('/vehicles/:id', staffOr('vehicles:read'), h(async (req, res) => ok(res, { vehicle: await vehicles.getVehicle(req.auth, req.params.id) })));
r.get('/vehicles/:id/history', staffOr('vehicles:read'), h(async (req, res) => ok(res, await vehicles.getServiceHistory(req.auth, req.params.id))));
r.get('/vehicles/:id/recalls', staffOr('vehicles:read'), h(async (req, res) => ok(res, { recalls: await vehicles.getRecalls(req.auth, req.params.id) })));
r.post('/vehicles', staffOr('vehicles:write'), validate({ body: vehicleBody }), h(async (req, res) => {
  if (req.auth.role === 'customer') req.body.customerId = req.auth.customerId;
  ok(res, await vehicles.createVehicle(req, req.body), 201);
}));
r.patch('/vehicles/:id', staffOr('vehicles:write'), validate({ body: vehicleBody.omit({ customerId: true }).partial().extend({ status: z.enum(['active', 'sold', 'scrapped', 'archived']).optional(), reason: text(500).optional() }) }),
  h(async (req, res) => ok(res, { vehicle: await vehicles.updateVehicle(req, req.params.id, req.body, expectedVersion(req)) })));
r.post('/vehicles/:id/transfer', requirePermission('vehicles:transfer'), validate({ body: z.object({ toCustomerId: id, reason: z.enum(['purchase', 'transfer', 'correction']).default('transfer'), note: text(500).optional() }) }),
  h(async (req, res) => ok(res, { vehicle: await vehicles.transferOwnership(req, req.params.id, req.body) })));
r.post('/vehicles/:id/mileage', staffOr('vehicles:write'), validate({ body: z.object({ odometer: z.number().int().min(0), note: text(300).optional() }) }), h(async (req, res) => {
  const v = await vehicles.getVehicle(req.auth, req.params.id);
  ok(res, { record: await vehicles.recordMileage(req, v.id, { ...req.body, source: req.auth.role === 'customer' ? 'customer' : 'manual_correction' }) }, 201);
}));

// ---- appointments ------------------------------------------------------------------
r.get('/appointments/capacity', staffOr('appointments:read'), h(async (req, res) => ok(res, await appointments.getCapacity(req.auth, req.query))));
r.get('/appointments/availability', staffOr('appointments:read'), h(async (req, res) => ok(res, await appointments.getAvailability(req.auth, { ...req.query, durationMinutes: Number(req.query.durationMinutes) || 60 }))));
r.get('/appointments', staffOr('appointments:read'), h(async (req, res) => ok(res, { appointments: await appointments.listAppointments(req.auth, req.query) })));
r.get('/appointments/:id', staffOr('appointments:read'), h(async (req, res) => ok(res, { appointment: await appointments.getAppointment(req.auth, req.params.id) })));
const aptBody = z.object({
  locationId: id, customerId: id.optional(), vehicleId: id, date: dateStr, time: timeStr, durationMinutes: z.number().int().min(15).max(1440).optional(),
  serviceRequested: text(300).optional(), laborOpCodes: z.array(text(40)).optional(), concerns: z.array(text(500)).optional(), customerNotes: text(1000).optional(),
  transportation: z.enum(['wait', 'drop_off', 'loaner', 'shuttle', 'unknown']).optional(), assignedBay: id.optional(), assignedTechId: id.optional(),
  source: z.enum(['staff', 'phone']).optional(), overrideCapacity: z.boolean().optional(), overrideReason: text(300).optional()
});
r.post('/appointments', staffOr('appointments:write'), validate({ body: aptBody }), h(async (req, res) => ok(res, { appointment: await appointments.createAppointment(req, req.body) }, 201)));
r.patch('/appointments/:id', staffOr('appointments:write'), validate({ body: aptBody.omit({ locationId: true, customerId: true, vehicleId: true }).partial() }),
  h(async (req, res) => ok(res, { appointment: await appointments.rescheduleAppointment(req, req.params.id, req.body) })));
r.post('/appointments/:id/status', staffOr('appointments:write'), validate({ body: z.object({ status: z.enum(['scheduled', 'confirmed', 'arrived', 'cancelled', 'no_show']), reason: text(300).optional() }) }),
  h(async (req, res) => ok(res, { appointment: await appointments.changeAppointmentStatus(req, req.params.id, req.body) })));

export default r;
