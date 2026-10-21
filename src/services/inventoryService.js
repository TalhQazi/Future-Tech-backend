import { withTransaction } from '../config/db.js';
import {
  Part, StockLevel, InventoryTransaction, Reservation, PurchaseOrder, Transfer, VendorReturn, PartRequest,
  Location, RepairOrder, InstalledPart, Supplier, Vehicle
} from '../models/index.js';
import { RO_OPEN_STATUSES } from '../models/operations.js';
import { audit } from './audit.js';
import { nextNumber, shortCode } from './sequence.js';
import { notifyRoles } from './notificationService.js';
import { assertLocation, locationFilter, findRoForAccess } from '../security/access.js';
import { notFound, badRequest, conflict, unprocessable } from '../lib/errors.js';
import { escapeRegex, toDTO, paginationMeta } from '../lib/http.js';
import { legacyDollarsToCents } from '../lib/money.js';
import { uuid } from '../lib/crypto.js';

// ---------------------------------------------------------------------------
// Core stock movement: one conditional atomic update + one ledger entry
// ---------------------------------------------------------------------------
const ensureStock = (partId, locationId, session) =>
  StockLevel.findOneAndUpdate(
    { partId, locationId },
    { $setOnInsert: { partId, locationId, onHand: 0, reserved: 0, avgCostCents: 0, id: uuid() } },
    { upsert: true, new: true, session }
  );

export const moveStock = async (req, { partId, locationId, type, quantity = 0, reservedDelta = 0, unitCostCents, refs = {}, reason }, session) => {
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(reservedDelta)) throw badRequest('Quantities must be whole units');
  const current = await ensureStock(partId, locationId, session);
  const isInbound = quantity > 0 && ['receive', 'opening_balance', 'transfer_in', 'return_from_ro'].includes(type);
  const inboundCost = Number.isSafeInteger(unitCostCents) ? unitCostCents : current.avgCostCents;
  const updated = await StockLevel.findOneAndUpdate(
    {
      partId,
      locationId,
      $expr: {
        $and: [
          { $gte: [{ $add: ['$onHand', quantity] }, 0] },
          { $gte: [{ $add: ['$reserved', reservedDelta] }, 0] },
          { $gte: [{ $add: ['$onHand', quantity] }, { $add: ['$reserved', reservedDelta] }] }
        ]
      }
    },
    [{
      $set: {
        avgCostCents: isInbound
          ? { $round: [{ $divide: [{ $add: [{ $multiply: ['$onHand', '$avgCostCents'] }, quantity * inboundCost] }, { $add: ['$onHand', quantity] }] }, 0] }
          : '$avgCostCents',
        onHand: { $add: ['$onHand', quantity] },
        reserved: { $add: ['$reserved', reservedDelta] },
        __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] }
      }
    }],
    { new: true, session }
  );
  if (!updated) {
    throw unprocessable(
      `Insufficient stock: ${current.onHand} on hand, ${current.reserved} reserved`,
      { partId, locationId, onHand: current.onHand, reserved: current.reserved },
      'INSUFFICIENT_STOCK'
    );
  }
  const cost = quantity > 0 ? inboundCost : updated.avgCostCents;
  const [txn] = await InventoryTransaction.create([{
    type, partId, locationId, quantity, reservedDelta,
    unitCostCents: cost, totalCostCents: cost * Math.abs(quantity),
    onHandAfter: updated.onHand, reservedAfter: updated.reserved,
    refs, reason, by: req?.auth?.userId || 'system', byName: req?.auth?.user?.name
  }], { session });
  return { stock: updated, transaction: txn };
};

// ---------------------------------------------------------------------------
// Parts catalog
// ---------------------------------------------------------------------------
export const listParts = async (auth, { q, category, locationId, lowStock, page, limit, skip }) => {
  const filter = { active: { $ne: false } };
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ partNumber: rx }, { description: rx }, { brand: rx }, { category: rx }, { manufacturerPartNumber: rx }];
  }
  if (category) filter.category = category;
  const [items, total] = await Promise.all([Part.find(filter).sort({ partNumber: 1 }).skip(skip).limit(limit).lean(), Part.countDocuments(filter)]);
  const stockFilter = { partId: { $in: items.map(p => p.id) }, ...locationFilter(auth) };
  if (locationId) {
    assertLocation(auth, locationId);
    stockFilter.locationId = locationId;
  }
  const stocks = await StockLevel.find(stockFilter).lean();
  let parts = items.map(p => {
    const levels = stocks.filter(s => s.partId === p.id).map(s => ({ ...toDTO(s), available: s.onHand - s.reserved, belowMin: s.onHand - s.reserved <= (s.minLevel || 0) }));
    return {
      ...toDTO(p),
      stock: levels,
      legacyStockUnassigned: Number.isFinite(p.stockQuantity) && p.stockQuantity > 0 && !p.legacyStockAssignedAt ? p.stockQuantity : 0
    };
  });
  if (lowStock === 'true') parts = parts.filter(p => p.stock.some(s => s.belowMin));
  return { parts, pagination: paginationMeta({ page, limit }, total) };
};

export const getPart = async (auth, id) => {
  const part = await Part.findOne({ $or: [{ id }, { partNumber: String(id).toUpperCase() }] }).lean();
  if (!part) throw notFound('Part');
  const stocks = await StockLevel.find({ partId: part.id, ...locationFilter(auth) }).lean();
  return { ...toDTO(part), stock: stocks.map(s => ({ ...toDTO(s), available: s.onHand - s.reserved })) };
};

export const savePart = async (req, id, input) => {
  if (id) {
    const before = await Part.findOne({ id }).lean();
    if (!before) throw notFound('Part');
    const updated = await Part.findOneAndUpdate({ id }, { $set: input, $inc: { __v: 1 } }, { new: true }).lean();
    const priceChanged = ['unitCostCents', 'listPriceCents'].some(k => input[k] !== undefined && input[k] !== before[k]);
    await audit(req, {
      eventType: 'PART_UPDATED', category: priceChanged ? 'financial' : 'inventory', entityType: 'Part', entityId: id,
      action: `Updated part ${updated.partNumber}${priceChanged ? ' pricing' : ''}`,
      before: priceChanged ? { unitCostCents: before.unitCostCents, listPriceCents: before.listPriceCents } : undefined,
      after: priceChanged ? { unitCostCents: updated.unitCostCents, listPriceCents: updated.listPriceCents } : undefined
    });
    return toDTO(updated);
  }
  if (await Part.exists({ partNumber: input.partNumber.toUpperCase() })) throw conflict('Part number already exists');
  const created = await Part.create(input);
  await audit(req, { eventType: 'PART_CREATED', category: 'inventory', entityType: 'Part', entityId: created.id, action: `Created part ${created.partNumber}` });
  return toDTO(created);
};

export const updateStockSettings = async (req, { partId, locationId, minLevel, maxLevel, binLocation }) => {
  assertLocation(req.auth, locationId);
  await ensureStock(partId, locationId);
  const set = {};
  if (minLevel !== undefined) set.minLevel = minLevel;
  if (maxLevel !== undefined) set.maxLevel = maxLevel;
  if (binLocation !== undefined) set.binLocation = binLocation;
  return toDTO(await StockLevel.findOneAndUpdate({ partId, locationId }, { $set: set }, { new: true }).lean());
};

// Prototype stock counts had no location. Parts staff assign them explicitly.
export const assignLegacyStock = async (req, partId, { locationId, binLocation }) => {
  assertLocation(req.auth, locationId);
  const part = await Part.findOne({ id: partId }).lean();
  if (!part) throw notFound('Part');
  if (part.legacyStockAssignedAt) throw conflict('Legacy stock was already assigned');
  const qty = Math.trunc(part.stockQuantity || 0);
  if (qty <= 0) throw badRequest('This part has no legacy stock quantity');
  await withTransaction(async (session) => {
    const claimed = await Part.updateOne({ id: partId, legacyStockAssignedAt: null }, { $set: { legacyStockAssignedAt: new Date(), legacyStockAssignedTo: locationId } }, { session });
    if (claimed.modifiedCount !== 1) throw conflict('Legacy stock was already assigned');
    await moveStock(req, {
      partId, locationId, type: 'opening_balance', quantity: qty,
      unitCostCents: part.unitCostCents || legacyDollarsToCents(part.costPrice), reason: 'Opening balance from legacy stock count'
    }, session);
    await StockLevel.updateOne({ partId, locationId }, { $set: { binLocation: binLocation || part.binLocation || '', minLevel: part.minStockLevel || 0 } }, { session });
    await audit(req, { eventType: 'LEGACY_STOCK_ASSIGNED', category: 'inventory', entityType: 'Part', entityId: partId, locationId, action: `Assigned legacy stock of ${qty} units of ${part.partNumber} to location` }, session);
  });
  return getPart(req.auth, partId);
};

export const adjustStock = async (req, { partId, locationId, quantityDelta, reason }) => {
  assertLocation(req.auth, locationId);
  if (!reason) throw badRequest('An adjustment reason is required');
  if (!(await Part.exists({ id: partId }))) throw notFound('Part');
  const result = await withTransaction(async (session) => {
    const r = await moveStock(req, { partId, locationId, type: 'adjustment', quantity: quantityDelta, reason }, session);
    await audit(req, { eventType: 'STOCK_ADJUSTED', category: 'inventory', entityType: 'Part', entityId: partId, locationId, action: `Adjusted stock by ${quantityDelta > 0 ? '+' : ''}${quantityDelta} (now ${r.stock.onHand})`, reason }, session);
    return r;
  });
  return { stock: toDTO(result.stock.toObject()), transaction: toDTO(result.transaction.toObject()) };
};

export const cycleCount = async (req, { partId, locationId, countedQuantity, reason }) => {
  assertLocation(req.auth, locationId);
  const stock = await ensureStock(partId, locationId);
  const delta = countedQuantity - stock.onHand;
  if (countedQuantity < stock.reserved) throw unprocessable(`Counted quantity is below the ${stock.reserved} units reserved for repair orders. Release reservations first.`);
  const result = await withTransaction(async (session) => {
    const r = delta === 0
      ? { stock, transaction: (await InventoryTransaction.create([{ type: 'cycle_count', partId, locationId, quantity: 0, onHandAfter: stock.onHand, reservedAfter: stock.reserved, reason: reason || 'Count matched', by: req.auth.userId, byName: req.auth.user.name }], { session }))[0] }
      : await moveStock(req, { partId, locationId, type: 'cycle_count', quantity: delta, reason: reason || 'Cycle count' }, session);
    await StockLevel.updateOne({ partId, locationId }, { $set: { lastCountedAt: new Date() } }, { session });
    await audit(req, { eventType: 'CYCLE_COUNT', category: 'inventory', entityType: 'Part', entityId: partId, locationId, action: `Cycle count ${countedQuantity} (variance ${delta})`, reason }, session);
    return r;
  });
  return { variance: delta, stock: toDTO(result.stock.toObject ? result.stock.toObject() : result.stock) };
};

export const ledger = async (auth, { partId, locationId, roId, limit = 200 }) => {
  const filter = { ...locationFilter(auth) };
  if (partId) filter.partId = partId;
  if (locationId) {
    assertLocation(auth, locationId);
    filter.locationId = locationId;
  }
  if (roId) filter['refs.roId'] = roId;
  return toDTO(await InventoryTransaction.find(filter).sort({ at: -1 }).limit(Math.min(limit, 1000)).lean());
};

// ---------------------------------------------------------------------------
// Reservations and repair-order usage
// ---------------------------------------------------------------------------
export const reserveForApprovedLine = async (req, { ro, line }, session) => {
  const qty = Math.ceil(line.quantity || 1);
  const existing = await Reservation.findOne({ roId: ro.id, estimateLineId: line.id, status: { $in: ['active', 'issued'] } }).session(session);
  if (existing) {
    if (existing.status === 'issued' || existing.quantity === qty) return existing;
    await releaseReservation(req, existing.id, 'quantity_changed', session);
  }
  const stock = await ensureStock(line.partId, ro.locationId, session);
  if (stock.onHand - stock.reserved >= qty) {
    const [reservation] = await Reservation.create([{ partId: line.partId, locationId: ro.locationId, roId: ro.id, estimateLineId: line.id, quantity: qty, createdBy: req.auth.userId }], { session });
    await moveStock(req, { partId: line.partId, locationId: ro.locationId, type: 'reserve', reservedDelta: qty, refs: { roId: ro.id, reservationId: reservation.id }, reason: `Reserved for ${ro.roNumber}` }, session);
    await PartRequest.updateMany({ roId: ro.id, estimateLineId: line.id, status: { $in: ['requested', 'sourcing', 'ordered', 'received'] } }, { $set: { status: 'reserved', reservationId: reservation.id } }, { session });
    return reservation;
  }
  const open = await PartRequest.findOne({ roId: ro.id, estimateLineId: line.id, status: { $nin: ['cancelled', 'issued'] } }).session(session);
  if (!open) {
    await PartRequest.create([{
      roId: ro.id, locationId: ro.locationId, estimateLineId: line.id, partId: line.partId, partNumber: line.partNumber,
      description: line.description, quantity: qty, urgency: ro.waiter ? 'urgent' : 'normal', requestedBy: req.auth.userId,
      notes: `Insufficient stock (${stock.onHand - stock.reserved} available) when work was approved`
    }], { session });
    await notifyRoles(ro.locationId, ['parts'], { type: 'part_request', title: `Part needed for ${ro.roNumber}`, body: `${qty} × ${line.description}`, link: '#/app/parts', entityType: 'RepairOrder', entityId: ro.id }, session);
  }
  return null;
};

export const releaseReservation = async (req, reservationId, reason, session) => {
  const r = await Reservation.findOne({ id: reservationId, status: 'active' }).session(session);
  if (!r) return null;
  const remaining = r.quantity - r.issuedQuantity;
  if (remaining > 0) {
    await moveStock(req, { partId: r.partId, locationId: r.locationId, type: 'release', reservedDelta: -remaining, refs: { roId: r.roId, reservationId: r.id }, reason }, session);
  }
  await Reservation.updateOne({ id: r.id, status: 'active' }, { $set: { status: r.issuedQuantity > 0 ? 'issued' : 'released', releasedReason: reason } }, { session });
  return r;
};

export const releaseReservationsForRo = async (req, roId, reason, session) => {
  const active = await Reservation.find({ roId, status: 'active' }).session(session).lean();
  for (const r of active) await releaseReservation(req, r.id, reason, session);
};

export const listReservations = async (auth, { roId, locationId, status }) => {
  const filter = { ...locationFilter(auth) };
  if (roId) filter.roId = roId;
  if (locationId) {
    assertLocation(auth, locationId);
    filter.locationId = locationId;
  }
  filter.status = status || 'active';
  return toDTO(await Reservation.find(filter).sort({ createdAt: -1 }).limit(500).lean());
};

/**
 * Issues stock to a repair-order job and records the installed part (lot and
 * serial where available) for warranty and reliability tracking.
 */
export const issueToRepairOrder = async (req, { roId, jobId, reservationId, partId, quantity, lotNumber, serialNumber }) => {
  const ro = await findRoForAccess(req.auth, roId);
  if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Repair order is closed');
  if (jobId && !ro.jobs.some(j => j.id === jobId && j.status !== 'cancelled')) throw badRequest('Job not found on this repair order');
  let reservation = null;
  if (reservationId) {
    reservation = await Reservation.findOne({ id: reservationId, roId: ro.id, status: 'active' }).lean();
    if (!reservation) throw notFound('Active reservation');
    partId = reservation.partId;
    if (quantity > reservation.quantity - reservation.issuedQuantity) throw badRequest('Quantity exceeds the reserved amount');
  }
  const part = await Part.findOne({ id: partId }).lean();
  if (!part) throw notFound('Part');
  const vehicle = await Vehicle.findOne({ id: ro.vehicleId }).select('mileage').lean();
  const installedPartId = uuid();
  const result = await withTransaction(async (session) => {
    const { transaction, stock } = await moveStock(req, {
      partId, locationId: ro.locationId, type: 'issue', quantity: -quantity, reservedDelta: reservation ? -quantity : 0,
      refs: { roId: ro.id, jobId, reservationId, installedPartId }, reason: `Issued to ${ro.roNumber}`
    }, session);
    if (reservation) {
      const issued = reservation.issuedQuantity + quantity;
      await Reservation.updateOne({ id: reservation.id }, { $set: { issuedQuantity: issued, status: issued >= reservation.quantity ? 'issued' : 'active', jobId } }, { session });
    }
    const [installed] = await InstalledPart.create([{
      id: installedPartId, partId, partNumber: part.partNumber, description: part.description, brand: part.brand,
      supplierId: part.supplierId, supplierName: part.supplier, lotNumber, serialNumber,
      roId: ro.id, jobId, vehicleId: ro.vehicleId, locationId: ro.locationId, quantity,
      unitCostCents: transaction.unitCostCents, odometer: ro.odometerIn || vehicle?.mileage,
      techId: req.auth.role === 'technician' ? req.auth.userId : undefined,
      warrantyMonths: part.warrantyMonths, warrantyMiles: part.warrantyMiles,
      inventoryTransactionId: transaction.id
    }], { session });
    await PartRequest.updateMany({ roId: ro.id, reservationId, status: 'reserved' }, { $set: { status: 'issued' } }, { session });
    await audit(req, { eventType: 'PART_ISSUED', category: 'inventory', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId, action: `Issued ${quantity} × ${part.partNumber} to ${ro.roNumber}${lotNumber ? ` (lot ${lotNumber})` : ''}` }, session);
    return { transaction, stock, installed };
  });
  return { transaction: toDTO(result.transaction.toObject()), installedPart: toDTO(result.installed.toObject()), stock: toDTO(result.stock.toObject()) };
};

export const returnFromRepairOrder = async (req, { installedPartId, quantity, reason, restock = true }) => {
  const installed = await InstalledPart.findOne({ id: installedPartId }).lean();
  if (!installed) throw notFound('Installed part');
  const ro = await findRoForAccess(req.auth, installed.roId);
  if (installed.status !== 'in_service') throw conflict('This part is no longer in service');
  if (quantity > installed.quantity) throw badRequest('Cannot return more than was issued');
  await withTransaction(async (session) => {
    if (restock) {
      await moveStock(req, { partId: installed.partId, locationId: ro.locationId, type: 'return_from_ro', quantity, unitCostCents: installed.unitCostCents, refs: { roId: ro.id, installedPartId }, reason }, session);
    }
    await InstalledPart.updateOne({ id: installedPartId }, quantity >= installed.quantity ? { $set: { status: 'removed' } } : { $inc: { quantity: -quantity } }, { session });
    await audit(req, { eventType: 'PART_RETURNED_FROM_RO', category: 'inventory', entityType: 'RepairOrder', entityId: ro.id, locationId: ro.locationId, action: `Returned ${quantity} × ${installed.partNumber}${restock ? ' to stock' : ' (not restocked)'}`, reason }, session);
  });
  return { success: true };
};

// ---------------------------------------------------------------------------
// Part requests (technician -> parts department)
// ---------------------------------------------------------------------------
export const createPartRequest = async (req, input) => {
  const ro = await findRoForAccess(req.auth, input.roId);
  if (!RO_OPEN_STATUSES.includes(ro.status)) throw conflict('Repair order is closed');
  const request = await PartRequest.create({
    roId: ro.id, locationId: ro.locationId, jobId: input.jobId, partId: input.partId, partNumber: input.partNumber,
    description: input.description, quantity: input.quantity || 1, urgency: input.urgency || 'normal', requestedBy: req.auth.userId, notes: input.notes
  });
  await notifyRoles(ro.locationId, ['parts'], { type: 'part_request', title: `Part request for ${ro.roNumber}`, body: `${request.quantity} × ${request.description}`, link: '#/app/parts', entityType: 'PartRequest', entityId: request.id, severity: request.urgency === 'urgent' ? 'warning' : 'info' });
  await audit(req, { eventType: 'PART_REQUESTED', category: 'inventory', entityType: 'PartRequest', entityId: request.id, locationId: ro.locationId, action: `Requested ${request.quantity} × ${request.description} for ${ro.roNumber}` });
  return toDTO(request);
};

export const listPartRequests = async (auth, { locationId, status, roId }) => {
  const filter = { ...locationFilter(auth) };
  if (locationId) {
    assertLocation(auth, locationId);
    filter.locationId = locationId;
  }
  if (roId) filter.roId = roId;
  if (status) filter.status = { $in: status.split(',') };
  const items = await PartRequest.find(filter).sort({ urgency: -1, createdAt: 1 }).limit(500).lean();
  const ros = await RepairOrder.find({ id: { $in: items.map(i => i.roId) } }).select('id roNumber vehicleId status').lean();
  const rm = new Map(ros.map(r => [r.id, r]));
  return items.map(i => ({ ...toDTO(i), roNumber: rm.get(i.roId)?.roNumber, roStatus: rm.get(i.roId)?.status }));
};

export const updatePartRequest = async (req, id, { status, partId, notes, purchaseOrderId }) => {
  const request = await PartRequest.findOne({ id }).lean();
  if (!request) throw notFound('Part request');
  assertLocation(req.auth, request.locationId);
  const allowed = {
    requested: ['sourcing', 'ordered', 'cancelled'],
    sourcing: ['ordered', 'cancelled', 'requested'],
    ordered: ['received', 'cancelled'],
    received: ['cancelled'],
    reserved: ['cancelled'],
    issued: [],
    cancelled: []
  };
  const set = { handledBy: req.auth.userId };
  if (status) {
    if (!allowed[request.status].includes(status)) throw conflict(`Cannot move part request from ${request.status} to ${status}`);
    set.status = status;
  }
  if (partId) set.partId = partId;
  if (notes !== undefined) set.notes = notes;
  if (purchaseOrderId) set.purchaseOrderId = purchaseOrderId;
  const updated = await PartRequest.findOneAndUpdate({ id, status: request.status }, { $set: set }, { new: true }).lean();
  if (!updated) throw conflict('Part request changed; reload and try again');
  return toDTO(updated);
};

// Reserve stock for a part request once it is on hand (e.g. after receiving).
export const fulfillPartRequest = async (req, id) => {
  const request = await PartRequest.findOne({ id }).lean();
  if (!request) throw notFound('Part request');
  assertLocation(req.auth, request.locationId);
  if (!request.partId) throw badRequest('Link the request to a catalog part first');
  if (['issued', 'cancelled', 'reserved'].includes(request.status)) throw conflict(`Part request is ${request.status}`);
  const ro = await RepairOrder.findOne({ id: request.roId }).lean();
  await withTransaction(async (session) => {
    const [reservation] = await Reservation.create([{ partId: request.partId, locationId: request.locationId, roId: request.roId, estimateLineId: request.estimateLineId, jobId: request.jobId, partRequestId: request.id, quantity: request.quantity, createdBy: req.auth.userId }], { session });
    await moveStock(req, { partId: request.partId, locationId: request.locationId, type: 'reserve', reservedDelta: request.quantity, refs: { roId: request.roId, reservationId: reservation.id }, reason: `Reserved for ${ro?.roNumber || 'repair order'}` }, session);
    await PartRequest.updateOne({ id }, { $set: { status: 'reserved', reservationId: reservation.id, handledBy: req.auth.userId } }, { session });
  });
  if (ro?.assignedTechId) {
    const { notifyUsers } = await import('./notificationService.js');
    await notifyUsers([ro.assignedTechId], { type: 'part_ready', title: `Part ready for ${ro.roNumber}`, body: request.description, link: `#/app/ro/${ro.id}`, entityType: 'RepairOrder', entityId: ro.id });
  }
  return toDTO(await PartRequest.findOne({ id }).lean());
};

// ---------------------------------------------------------------------------
// Suppliers, purchase orders and receiving
// ---------------------------------------------------------------------------
export const listSuppliers = async () => toDTO(await Supplier.find({ active: true }).sort({ name: 1 }).lean());
export const saveSupplier = async (req, id, input) => {
  const doc = id
    ? await Supplier.findOneAndUpdate({ id }, { $set: input }, { new: true }).lean()
    : (await Supplier.create(input)).toObject();
  if (!doc) throw notFound('Supplier');
  await audit(req, { eventType: id ? 'SUPPLIER_UPDATED' : 'SUPPLIER_CREATED', category: 'inventory', entityType: 'Supplier', entityId: doc.id, action: `${id ? 'Updated' : 'Created'} supplier ${doc.name}` });
  return toDTO(doc);
};

const poTotal = (lines) => lines.reduce((s, l) => s + l.quantityOrdered * (l.unitCostCents || 0), 0);

export const createPurchaseOrder = async (req, input) => {
  assertLocation(req.auth, input.locationId);
  const location = await Location.findOne({ id: input.locationId }).lean();
  const parts = await Part.find({ id: { $in: input.lines.map(l => l.partId) } }).lean();
  const pm = new Map(parts.map(p => [p.id, p]));
  const lines = input.lines.map(l => {
    const part = pm.get(l.partId);
    if (!part) throw badRequest(`Unknown part ${l.partId}`);
    return { id: uuid(), partId: part.id, partNumber: part.partNumber, description: part.description, quantityOrdered: l.quantity, unitCostCents: l.unitCostCents ?? part.unitCostCents };
  });
  const supplier = input.supplierId ? await Supplier.findOne({ id: input.supplierId }).lean() : null;
  const po = await PurchaseOrder.create({
    poNumber: await nextNumber('PO', shortCode(location.code), new Date().getUTCFullYear()),
    locationId: input.locationId, supplierId: supplier?.id, supplierName: supplier?.name || input.supplierName,
    currency: location.currency, lines, totalCents: poTotal(lines), expectedAt: input.expectedAt, notes: input.notes, createdBy: req.auth.userId
  });
  if (input.partRequestIds?.length) {
    await PartRequest.updateMany({ id: { $in: input.partRequestIds }, locationId: input.locationId, status: { $in: ['requested', 'sourcing'] } }, { $set: { status: 'ordered', purchaseOrderId: po.id } });
  }
  await audit(req, { eventType: 'PURCHASE_ORDER_CREATED', category: 'inventory', entityType: 'PurchaseOrder', entityId: po.id, locationId: po.locationId, action: `Created ${po.poNumber} (${lines.length} lines)` });
  return toDTO(po);
};

export const listPurchaseOrders = async (auth, { locationId, status }) => {
  const filter = { ...locationFilter(auth) };
  if (locationId) {
    assertLocation(auth, locationId);
    filter.locationId = locationId;
  }
  if (status) filter.status = { $in: status.split(',') };
  return toDTO(await PurchaseOrder.find(filter).sort({ createdAt: -1 }).limit(300).lean());
};

export const submitPurchaseOrder = async (req, id, { supplierReference }) => {
  const po = await PurchaseOrder.findOne({ id }).lean();
  if (!po) throw notFound('Purchase order');
  assertLocation(req.auth, po.locationId);
  const updated = await PurchaseOrder.findOneAndUpdate({ id, status: 'draft' }, { $set: { status: 'ordered', orderedAt: new Date(), orderedBy: req.auth.userId, supplierReference } }, { new: true }).lean();
  if (!updated) throw conflict('Only draft purchase orders can be submitted');
  await audit(req, { eventType: 'PURCHASE_ORDER_SUBMITTED', category: 'inventory', entityType: 'PurchaseOrder', entityId: id, locationId: po.locationId, action: `Submitted ${po.poNumber} to ${po.supplierName || 'supplier'}` });
  return toDTO(updated);
};

export const cancelPurchaseOrder = async (req, id, { reason }) => {
  const po = await PurchaseOrder.findOne({ id }).lean();
  if (!po) throw notFound('Purchase order');
  assertLocation(req.auth, po.locationId);
  if (po.lines.some(l => l.quantityReceived > 0)) throw conflict('Partially received purchase orders cannot be cancelled');
  const updated = await PurchaseOrder.findOneAndUpdate({ id, status: { $in: ['draft', 'ordered'] } }, { $set: { status: 'cancelled', notes: `${po.notes || ''}\nCancelled: ${reason}`.trim() } }, { new: true }).lean();
  if (!updated) throw conflict('Purchase order cannot be cancelled');
  await PartRequest.updateMany({ purchaseOrderId: id, status: 'ordered' }, { $set: { status: 'sourcing' }, $unset: { purchaseOrderId: 1 } });
  await audit(req, { eventType: 'PURCHASE_ORDER_CANCELLED', category: 'inventory', entityType: 'PurchaseOrder', entityId: id, locationId: po.locationId, action: `Cancelled ${po.poNumber}`, reason });
  return toDTO(updated);
};

export const receivePurchaseOrder = async (req, id, { lines, packingSlip }) => {
  const po = await PurchaseOrder.findOne({ id }).lean();
  if (!po) throw notFound('Purchase order');
  assertLocation(req.auth, po.locationId);
  if (!['ordered', 'partially_received'].includes(po.status)) throw conflict('Only ordered purchase orders can be received');
  const receiptId = uuid();
  await withTransaction(async (session) => {
    const fresh = await PurchaseOrder.findOne({ id }).session(session).lean();
    const updatedLines = fresh.lines.map(l => ({ ...l }));
    for (const r of lines) {
      const line = updatedLines.find(l => l.id === r.lineId);
      if (!line) throw badRequest(`Unknown PO line ${r.lineId}`);
      if (r.quantity <= 0) continue;
      if (line.quantityReceived + r.quantity > line.quantityOrdered) throw badRequest(`Receiving more than ordered for ${line.partNumber}`);
      line.quantityReceived += r.quantity;
      const unitCost = r.unitCostCents ?? line.unitCostCents;
      await moveStock(req, { partId: line.partId, locationId: po.locationId, type: 'receive', quantity: r.quantity, unitCostCents: unitCost, refs: { purchaseOrderId: id }, reason: `Received on ${po.poNumber}` }, session);
      if (Number.isSafeInteger(unitCost)) await Part.updateOne({ id: line.partId }, { $set: { unitCostCents: unitCost } }, { session });
    }
    const allReceived = updatedLines.every(l => l.quantityReceived >= l.quantityOrdered);
    const res = await PurchaseOrder.updateOne({ id, __v: fresh.__v }, {
      $set: { lines: updatedLines, status: allReceived ? 'received' : 'partially_received' },
      $push: { receipts: { id: receiptId, at: new Date(), by: req.auth.userId, packingSlip, lines } },
      $inc: { __v: 1 }
    }, { session });
    if (res.modifiedCount !== 1) throw conflict('Purchase order changed; reload and try again');
    await PartRequest.updateMany({ purchaseOrderId: id, status: 'ordered', partId: { $in: lines.filter(l => l.quantity > 0).map(l => updatedLines.find(u => u.id === l.lineId)?.partId) } }, { $set: { status: 'received' } }, { session });
    await audit(req, { eventType: 'PURCHASE_ORDER_RECEIVED', category: 'inventory', entityType: 'PurchaseOrder', entityId: id, locationId: po.locationId, action: `Received ${lines.reduce((s, l) => s + l.quantity, 0)} units on ${po.poNumber}${allReceived ? ' (complete)' : ' (partial)'}` }, session);
  });
  // waiting repair orders can now be served
  const waiting = await PartRequest.find({ purchaseOrderId: id, status: 'received' }).select('roId').lean();
  if (waiting.length) {
    await notifyRoles(po.locationId, ['parts', 'advisor'], { type: 'parts_received', title: `${po.poNumber} received`, body: `${waiting.length} part request(s) can be reserved`, link: '#/app/parts' });
  }
  return toDTO(await PurchaseOrder.findOne({ id }).lean());
};

// ---------------------------------------------------------------------------
// Transfers between locations
// ---------------------------------------------------------------------------
export const createTransfer = async (req, { fromLocationId, toLocationId, lines, notes }) => {
  if (fromLocationId === toLocationId) throw badRequest('Choose two different locations');
  assertLocation(req.auth, toLocationId);
  const from = await Location.findOne({ id: fromLocationId }).lean();
  if (!from) throw notFound('Source location');
  const parts = await Part.find({ id: { $in: lines.map(l => l.partId) } }).lean();
  const t = await Transfer.create({
    transferNumber: await nextNumber('TRF', shortCode(from.code), new Date().getUTCFullYear()),
    fromLocationId, toLocationId, notes, requestedBy: req.auth.userId,
    lines: lines.map(l => ({ partId: l.partId, partNumber: parts.find(p => p.id === l.partId)?.partNumber, quantity: l.quantity }))
  });
  await notifyRoles(fromLocationId, ['parts'], { type: 'transfer_requested', title: `Transfer ${t.transferNumber} requested`, link: '#/app/parts' });
  await audit(req, { eventType: 'TRANSFER_REQUESTED', category: 'inventory', entityType: 'Transfer', entityId: t.id, locationId: toLocationId, action: `Requested ${t.transferNumber}` });
  return toDTO(t);
};

export const shipTransfer = async (req, id) => {
  const t = await Transfer.findOne({ id }).lean();
  if (!t) throw notFound('Transfer');
  assertLocation(req.auth, t.fromLocationId);
  await withTransaction(async (session) => {
    const lines = [];
    for (const line of t.lines) {
      const { transaction } = await moveStock(req, { partId: line.partId, locationId: t.fromLocationId, type: 'transfer_out', quantity: -line.quantity, refs: { transferId: id }, reason: `Shipped on ${t.transferNumber}` }, session);
      lines.push({ ...line, unitCostCents: transaction.unitCostCents });
    }
    const res = await Transfer.updateOne({ id, status: 'requested' }, { $set: { status: 'in_transit', shippedBy: req.auth.userId, shippedAt: new Date(), lines } }, { session });
    if (res.modifiedCount !== 1) throw conflict('Only requested transfers can be shipped');
    await audit(req, { eventType: 'TRANSFER_SHIPPED', category: 'inventory', entityType: 'Transfer', entityId: id, locationId: t.fromLocationId, action: `Shipped ${t.transferNumber}` }, session);
  });
  return toDTO(await Transfer.findOne({ id }).lean());
};

export const receiveTransfer = async (req, id) => {
  const t = await Transfer.findOne({ id }).lean();
  if (!t) throw notFound('Transfer');
  assertLocation(req.auth, t.toLocationId);
  await withTransaction(async (session) => {
    for (const line of t.lines) {
      await moveStock(req, { partId: line.partId, locationId: t.toLocationId, type: 'transfer_in', quantity: line.quantity, unitCostCents: line.unitCostCents, refs: { transferId: id }, reason: `Received on ${t.transferNumber}` }, session);
    }
    const res = await Transfer.updateOne({ id, status: 'in_transit' }, { $set: { status: 'received', receivedBy: req.auth.userId, receivedAt: new Date(), lines: t.lines.map(l => ({ ...l, quantityReceived: l.quantity })) } }, { session });
    if (res.modifiedCount !== 1) throw conflict('Only in-transit transfers can be received');
    await audit(req, { eventType: 'TRANSFER_RECEIVED', category: 'inventory', entityType: 'Transfer', entityId: id, locationId: t.toLocationId, action: `Received ${t.transferNumber}` }, session);
  });
  return toDTO(await Transfer.findOne({ id }).lean());
};

export const cancelTransfer = async (req, id) => {
  const t = await Transfer.findOne({ id }).lean();
  if (!t) throw notFound('Transfer');
  assertLocation(req.auth, t.toLocationId);
  const updated = await Transfer.findOneAndUpdate({ id, status: 'requested' }, { $set: { status: 'cancelled' } }, { new: true }).lean();
  if (!updated) throw conflict('Only requested transfers can be cancelled');
  return toDTO(updated);
};

export const listTransfers = async (auth, { status }) => {
  const filter = auth.role === 'admin' ? {} : { $or: [{ fromLocationId: { $in: auth.locationIds } }, { toLocationId: { $in: auth.locationIds } }] };
  if (status) filter.status = { $in: status.split(',') };
  return toDTO(await Transfer.find(filter).sort({ createdAt: -1 }).limit(300).lean());
};

// ---------------------------------------------------------------------------
// Returns to vendor
// ---------------------------------------------------------------------------
export const createVendorReturn = async (req, { locationId, supplierId, lines, rmaNumber }) => {
  assertLocation(req.auth, locationId);
  const location = await Location.findOne({ id: locationId }).lean();
  const supplier = supplierId ? await Supplier.findOne({ id: supplierId }).lean() : null;
  const parts = await Part.find({ id: { $in: lines.map(l => l.partId) } }).lean();
  const vr = await VendorReturn.create({
    returnNumber: await nextNumber('RTV', shortCode(location.code), new Date().getUTCFullYear()),
    locationId, supplierId: supplier?.id, supplierName: supplier?.name, rmaNumber, createdBy: req.auth.userId,
    lines: lines.map(l => ({ ...l, partNumber: parts.find(p => p.id === l.partId)?.partNumber }))
  });
  await audit(req, { eventType: 'VENDOR_RETURN_CREATED', category: 'inventory', entityType: 'VendorReturn', entityId: vr.id, locationId, action: `Created ${vr.returnNumber}` });
  return toDTO(vr);
};

export const shipVendorReturn = async (req, id) => {
  const vr = await VendorReturn.findOne({ id }).lean();
  if (!vr) throw notFound('Vendor return');
  assertLocation(req.auth, vr.locationId);
  await withTransaction(async (session) => {
    for (const line of vr.lines.filter(l => l.fromStock !== false)) {
      await moveStock(req, { partId: line.partId, locationId: vr.locationId, type: 'return_to_vendor', quantity: -line.quantity, refs: { vendorReturnId: id }, reason: line.reason || `Returned on ${vr.returnNumber}` }, session);
    }
    const res = await VendorReturn.updateOne({ id, status: 'draft' }, { $set: { status: 'shipped', shippedAt: new Date() } }, { session });
    if (res.modifiedCount !== 1) throw conflict('Only draft returns can be shipped');
    await audit(req, { eventType: 'VENDOR_RETURN_SHIPPED', category: 'inventory', entityType: 'VendorReturn', entityId: id, locationId: vr.locationId, action: `Shipped ${vr.returnNumber}` }, session);
  });
  return toDTO(await VendorReturn.findOne({ id }).lean());
};

export const creditVendorReturn = async (req, id, { creditCents }) => {
  const vr = await VendorReturn.findOne({ id }).lean();
  if (!vr) throw notFound('Vendor return');
  assertLocation(req.auth, vr.locationId);
  const updated = await VendorReturn.findOneAndUpdate({ id, status: 'shipped' }, { $set: { status: 'credited', creditCents, creditedAt: new Date() } }, { new: true }).lean();
  if (!updated) throw conflict('Only shipped returns can be credited');
  await audit(req, { eventType: 'VENDOR_RETURN_CREDITED', category: 'financial', entityType: 'VendorReturn', entityId: id, locationId: vr.locationId, action: `Supplier credit ${creditCents} cents recorded on ${vr.returnNumber}` });
  return toDTO(updated);
};

export const listVendorReturns = async (auth) => toDTO(await VendorReturn.find(locationFilter(auth)).sort({ createdAt: -1 }).limit(300).lean());

export const lowStock = async (auth, { locationId }) => {
  const filter = { ...locationFilter(auth), $expr: { $lte: [{ $subtract: ['$onHand', '$reserved'] }, '$minLevel'] }, minLevel: { $gt: 0 } };
  if (locationId) {
    assertLocation(auth, locationId);
    filter.locationId = locationId;
  }
  const levels = await StockLevel.find(filter).lean();
  const parts = await Part.find({ id: { $in: levels.map(l => l.partId) } }).select('id partNumber description brand supplier').lean();
  const pm = new Map(parts.map(p => [p.id, p]));
  return levels.map(l => ({ ...toDTO(l), available: l.onHand - l.reserved, part: pm.get(l.partId) ? toDTO(pm.get(l.partId)) : null }));
};
