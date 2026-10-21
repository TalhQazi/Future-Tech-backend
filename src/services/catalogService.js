import { LaborOperation, Fee } from '../models/index.js';
import { audit } from './audit.js';
import { notFound, conflict } from '../lib/errors.js';
import { escapeRegex, toDTO } from '../lib/http.js';

export const listLaborOperations = async ({ q, includeInactive }) => {
  const filter = includeInactive ? {} : { active: true };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ code: rx }, { name: rx }, { category: rx }];
  }
  return toDTO(await LaborOperation.find(filter).sort({ category: 1, name: 1 }).limit(500).lean());
};

export const saveLaborOperation = async (req, id, input) => {
  if (id) {
    const updated = await LaborOperation.findOneAndUpdate({ id }, { $set: input, $inc: { __v: 1 } }, { new: true }).lean();
    if (!updated) throw notFound('Labor operation');
    await audit(req, { eventType: 'LABOR_OPERATION_UPDATED', category: 'financial', entityType: 'LaborOperation', entityId: id, action: `Updated labor operation ${updated.code}` });
    return toDTO(updated);
  }
  if (await LaborOperation.exists({ code: input.code.toUpperCase() })) throw conflict('Labor operation code already exists');
  const created = await LaborOperation.create({ ...input, createdBy: req.auth.userId });
  await audit(req, { eventType: 'LABOR_OPERATION_CREATED', category: 'financial', entityType: 'LaborOperation', entityId: created.id, action: `Created labor operation ${created.code}` });
  return toDTO(created);
};

export const listFees = async ({ includeInactive, locationId }) => {
  const filter = includeInactive ? {} : { active: true };
  if (locationId) filter.$or = [{ locationIds: { $size: 0 } }, { locationIds: locationId }];
  return toDTO(await Fee.find(filter).sort({ name: 1 }).lean());
};

export const saveFee = async (req, id, input) => {
  if (id) {
    const updated = await Fee.findOneAndUpdate({ id }, { $set: input, $inc: { __v: 1 } }, { new: true }).lean();
    if (!updated) throw notFound('Fee');
    await audit(req, { eventType: 'FEE_UPDATED', category: 'financial', entityType: 'Fee', entityId: id, action: `Updated fee ${updated.code}` });
    return toDTO(updated);
  }
  if (await Fee.exists({ code: input.code.toUpperCase() })) throw conflict('Fee code already exists');
  const created = await Fee.create({ ...input, createdBy: req.auth.userId });
  await audit(req, { eventType: 'FEE_CREATED', category: 'financial', entityType: 'Fee', entityId: created.id, action: `Created fee ${created.code}` });
  return toDTO(created);
};
