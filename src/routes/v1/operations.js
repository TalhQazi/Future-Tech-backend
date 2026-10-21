import { Router } from 'express';
import { z, h, ok, id, page, cents, posCents, reqText, text, dateStr } from './_helpers.js';
import { validate } from '../../middleware/validate.js';
import { requirePermission, requireAnyPermission } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import { evidenceUpload } from '../../middleware/upload.js';
import * as evidence from '../../services/evidenceService.js';
import * as invsvc from '../../services/inventoryService.js';
import * as invoices from '../../services/invoiceService.js';
import * as payments from '../../services/paymentService.js';
import { PAYMENT_METHODS } from '../../models/finance.js';
import { paymentProvidersStatus } from '../../adapters/payments.js';

const r = Router();
const staffOr = (perm) => requireAnyPermission(perm, 'portal:access');

// ---- evidence --------------------------------------------------------------------------
r.post('/evidence', requirePermission('evidence:write'), evidenceUpload.single('file'), validate({ body: z.object({
  roId: id.optional(), findingId: id.optional(), sessionId: id.optional(), forumThreadId: id.optional(), vehicleId: id.optional(),
  kind: z.enum(['photo', 'video', 'audio', 'document', 'scan_report', 'signature']).optional(), caption: text(500).optional(),
  visibility: z.enum(['internal', 'customer']).optional(), clientId: text(100).optional(), supersedesId: id.optional(),
  reason: text(500).optional(), capturedAt: z.string().datetime({ offset: true }).optional()
}) }), h(async (req, res) => {
  const out = await evidence.uploadEvidence(req, req.file, req.body);
  ok(res, out, out.duplicate ? 200 : 201);
}));
r.get('/evidence', staffOr('evidence:read'), h(async (req, res) => ok(res, { evidence: await evidence.listEvidence(req.auth, req.query) })));
r.get('/evidence/:id', staffOr('evidence:read'), h(async (req, res) => ok(res, { evidence: await evidence.getEvidence(req.auth, req.params.id) })));
r.get('/evidence/:id/content', staffOr('evidence:read'), h(async (req, res) => evidence.streamEvidence(req.auth, req.params.id, res)));

// ---- inventory ---------------------------------------------------------------------------
const partBody = z.object({
  partNumber: reqText(60), description: reqText(300), category: text(80).optional(), brand: text(80).optional(), manufacturerPartNumber: text(60).optional(),
  supplierId: id.optional(), supplier: text(120).optional(), unitOfMeasure: text(20).optional(), unitCostCents: cents.optional(), listPriceCents: cents.optional(),
  coreChargeCents: cents.optional(), taxable: z.boolean().optional(), warrantyMonths: z.number().int().min(0).max(240).nullable().optional(),
  warrantyMiles: z.number().int().min(0).nullable().optional(), active: z.boolean().optional()
});
r.get('/parts', requirePermission('inventory:read'), h(async (req, res) => ok(res, await invsvc.listParts(req.auth, { ...req.query, ...page(req) }))));
r.get('/parts/:id', requirePermission('inventory:read'), h(async (req, res) => ok(res, { part: await invsvc.getPart(req.auth, req.params.id) })));
r.post('/parts', requirePermission('inventory:write'), validate({ body: partBody }), h(async (req, res) => ok(res, { part: await invsvc.savePart(req, null, req.body) }, 201)));
r.patch('/parts/:id', requirePermission('inventory:write'), validate({ body: partBody.partial() }), h(async (req, res) => ok(res, { part: await invsvc.savePart(req, req.params.id, req.body) })));
r.post('/parts/:id/assign-legacy-stock', requirePermission('inventory:adjust'), validate({ body: z.object({ locationId: id, binLocation: text(80).optional() }) }), h(async (req, res) => ok(res, { part: await invsvc.assignLegacyStock(req, req.params.id, req.body) })));
r.patch('/stock', requirePermission('inventory:write'), validate({ body: z.object({ partId: id, locationId: id, minLevel: z.number().int().min(0).optional(), maxLevel: z.number().int().min(0).nullable().optional(), binLocation: text(80).optional() }) }),
  h(async (req, res) => ok(res, { stock: await invsvc.updateStockSettings(req, req.body) })));
r.post('/stock/adjust', requirePermission('inventory:adjust'), idempotent(), validate({ body: z.object({ partId: id, locationId: id, quantityDelta: z.number().int().refine(v => v !== 0, 'Must not be zero'), reason: reqText(500) }) }),
  h(async (req, res) => ok(res, await invsvc.adjustStock(req, req.body))));
r.post('/stock/count', requirePermission('inventory:adjust'), idempotent(), validate({ body: z.object({ partId: id, locationId: id, countedQuantity: z.number().int().min(0), reason: text(500).optional() }) }),
  h(async (req, res) => ok(res, await invsvc.cycleCount(req, req.body))));
r.get('/stock/low', requirePermission('inventory:read'), h(async (req, res) => ok(res, { lowStock: await invsvc.lowStock(req.auth, req.query) })));
r.get('/stock/ledger', requirePermission('inventory:read'), h(async (req, res) => ok(res, { transactions: await invsvc.ledger(req.auth, req.query) })));
r.get('/reservations', requirePermission('inventory:read'), h(async (req, res) => ok(res, { reservations: await invsvc.listReservations(req.auth, req.query) })));
r.post('/stock/issue', requireAnyPermission('inventory:write', 'jobs:execute'), idempotent({ required: true }), validate({ body: z.object({
  roId: id, jobId: id.optional(), reservationId: id.optional(), partId: id.optional(), quantity: z.number().int().positive(), lotNumber: text(60).optional(), serialNumber: text(60).optional()
}).refine(b => b.reservationId || b.partId, 'reservationId or partId is required') }), h(async (req, res) => ok(res, await invsvc.issueToRepairOrder(req, req.body), 201)));
r.post('/stock/return', requirePermission('inventory:write'), idempotent({ required: true }), validate({ body: z.object({ installedPartId: id, quantity: z.number().int().positive(), reason: reqText(500), restock: z.boolean().optional() }) }),
  h(async (req, res) => ok(res, await invsvc.returnFromRepairOrder(req, req.body))));

r.get('/part-requests', requireAnyPermission('inventory:read', 'parts:request'), h(async (req, res) => ok(res, { partRequests: await invsvc.listPartRequests(req.auth, req.query) })));
r.post('/part-requests', requirePermission('parts:request'), validate({ body: z.object({ roId: id, jobId: id.optional(), partId: id.optional(), partNumber: text(60).optional(), description: reqText(300), quantity: z.number().int().positive().max(1000).optional(), urgency: z.enum(['normal', 'urgent']).optional(), notes: text(1000).optional() }) }),
  h(async (req, res) => ok(res, { partRequest: await invsvc.createPartRequest(req, req.body) }, 201)));
r.patch('/part-requests/:id', requirePermission('inventory:write'), validate({ body: z.object({ status: z.enum(['requested', 'sourcing', 'ordered', 'received', 'cancelled']).optional(), partId: id.optional(), notes: text(1000).optional(), purchaseOrderId: id.optional() }) }),
  h(async (req, res) => ok(res, { partRequest: await invsvc.updatePartRequest(req, req.params.id, req.body) })));
r.post('/part-requests/:id/fulfill', requirePermission('inventory:write'), h(async (req, res) => ok(res, { partRequest: await invsvc.fulfillPartRequest(req, req.params.id) })));

r.get('/suppliers', requirePermission('inventory:read'), h(async (_req, res) => ok(res, { suppliers: await invsvc.listSuppliers() })));
const supplier = z.object({ name: reqText(160), accountNumber: text(60).optional(), contactName: text(120).optional(), phone: text(30).optional(), email: z.string().email().optional().or(z.literal('')), website: text(200).optional(), notes: text(1000).optional(), active: z.boolean().optional() });
r.post('/suppliers', requirePermission('purchasing:manage'), validate({ body: supplier }), h(async (req, res) => ok(res, { supplier: await invsvc.saveSupplier(req, null, req.body) }, 201)));
r.patch('/suppliers/:id', requirePermission('purchasing:manage'), validate({ body: supplier.partial() }), h(async (req, res) => ok(res, { supplier: await invsvc.saveSupplier(req, req.params.id, req.body) })));

r.get('/purchase-orders', requirePermission('inventory:read'), h(async (req, res) => ok(res, { purchaseOrders: await invsvc.listPurchaseOrders(req.auth, req.query) })));
r.post('/purchase-orders', requirePermission('purchasing:manage'), validate({ body: z.object({ locationId: id, supplierId: id.optional(), supplierName: text(160).optional(), lines: z.array(z.object({ partId: id, quantity: z.number().int().positive(), unitCostCents: cents.optional() })).min(1), expectedAt: z.string().datetime({ offset: true }).optional(), notes: text(1000).optional(), partRequestIds: z.array(id).optional() }) }),
  h(async (req, res) => ok(res, { purchaseOrder: await invsvc.createPurchaseOrder(req, req.body) }, 201)));
r.post('/purchase-orders/:id/submit', requirePermission('purchasing:manage'), validate({ body: z.object({ supplierReference: text(80).optional() }) }), h(async (req, res) => ok(res, { purchaseOrder: await invsvc.submitPurchaseOrder(req, req.params.id, req.body) })));
r.post('/purchase-orders/:id/cancel', requirePermission('purchasing:manage'), validate({ body: z.object({ reason: reqText(500) }) }), h(async (req, res) => ok(res, { purchaseOrder: await invsvc.cancelPurchaseOrder(req, req.params.id, req.body) })));
r.post('/purchase-orders/:id/receive', requirePermission('inventory:write'), idempotent({ required: true }), validate({ body: z.object({ packingSlip: text(80).optional(), lines: z.array(z.object({ lineId: id, quantity: z.number().int().min(0), unitCostCents: cents.optional() })).min(1) }) }),
  h(async (req, res) => ok(res, { purchaseOrder: await invsvc.receivePurchaseOrder(req, req.params.id, req.body) })));

r.get('/transfers', requirePermission('inventory:read'), h(async (req, res) => ok(res, { transfers: await invsvc.listTransfers(req.auth, req.query) })));
r.post('/transfers', requirePermission('transfers:manage'), validate({ body: z.object({ fromLocationId: id, toLocationId: id, lines: z.array(z.object({ partId: id, quantity: z.number().int().positive() })).min(1), notes: text(500).optional() }) }),
  h(async (req, res) => ok(res, { transfer: await invsvc.createTransfer(req, req.body) }, 201)));
r.post('/transfers/:id/ship', requirePermission('transfers:manage'), idempotent(), h(async (req, res) => ok(res, { transfer: await invsvc.shipTransfer(req, req.params.id) })));
r.post('/transfers/:id/receive', requirePermission('transfers:manage'), idempotent(), h(async (req, res) => ok(res, { transfer: await invsvc.receiveTransfer(req, req.params.id) })));
r.post('/transfers/:id/cancel', requirePermission('transfers:manage'), h(async (req, res) => ok(res, { transfer: await invsvc.cancelTransfer(req, req.params.id) })));

r.get('/vendor-returns', requirePermission('inventory:read'), h(async (req, res) => ok(res, { vendorReturns: await invsvc.listVendorReturns(req.auth) })));
r.post('/vendor-returns', requirePermission('purchasing:manage'), validate({ body: z.object({ locationId: id, supplierId: id.optional(), rmaNumber: text(60).optional(), lines: z.array(z.object({ partId: id, quantity: z.number().int().positive(), unitCostCents: cents.optional(), reason: text(300).optional(), installedPartId: id.optional(), fromStock: z.boolean().optional() })).min(1) }) }),
  h(async (req, res) => ok(res, { vendorReturn: await invsvc.createVendorReturn(req, req.body) }, 201)));
r.post('/vendor-returns/:id/ship', requirePermission('purchasing:manage'), idempotent(), h(async (req, res) => ok(res, { vendorReturn: await invsvc.shipVendorReturn(req, req.params.id) })));
r.post('/vendor-returns/:id/credit', requirePermission('purchasing:manage'), validate({ body: z.object({ creditCents: cents }) }), h(async (req, res) => ok(res, { vendorReturn: await invsvc.creditVendorReturn(req, req.params.id, req.body) })));

// ---- invoices, payments, refunds, adjustments, reconciliation -----------------------------
r.get('/payments/providers', h(async (_req, res) => ok(res, { providers: paymentProvidersStatus() })));
r.get('/invoices', staffOr('invoices:read'), h(async (req, res) => ok(res, await invoices.listInvoices(req.auth, { ...req.query, ...page(req) }))));
r.get('/invoices/:id', staffOr('invoices:read'), h(async (req, res) => ok(res, { invoice: await invoices.getInvoice(req.auth, req.params.id) })));
r.post('/invoices/:id/post', requirePermission('invoices:post'), idempotent(), h(async (req, res) => ok(res, { invoice: await invoices.postInvoice(req, req.params.id) })));
r.post('/invoices/:id/void', requirePermission('invoices:write'), validate({ body: z.object({ reason: reqText(500) }) }), h(async (req, res) => ok(res, { invoice: await invoices.voidDraftInvoice(req, req.params.id, req.body) })));
r.post('/invoices/:id/payments', requirePermission('payments:record'), idempotent({ required: true }), validate({ body: z.object({
  amountCents: posCents, method: z.enum(PAYMENT_METHODS.filter(m => m !== 'card_online')), reference: text(80).optional(),
  cardLast4: z.string().regex(/^\d{4}$/).optional(), note: text(500).optional()
}) }), h(async (req, res) => ok(res, { payment: await payments.recordManualPayment(req, req.params.id, req.body) }, 201)));
r.post('/invoices/:id/online-payment', staffOr('payments:record'), idempotent({ required: true }), validate({ body: z.object({ amountCents: posCents.optional() }) }),
  h(async (req, res) => ok(res, await payments.createOnlinePayment(req, req.params.id, req.body), 201)));
r.post('/payments/:id/sync', staffOr('payments:record'), h(async (req, res) => ok(res, { payment: await payments.syncOnlinePayment(req, req.params.id) })));
r.post('/payments/:id/refunds', requirePermission('refunds:request'), idempotent({ required: true }), validate({ body: z.object({ amountCents: posCents, reason: reqText(500) }) }),
  h(async (req, res) => ok(res, { refund: await payments.requestRefund(req, req.params.id, req.body) }, 201)));
r.post('/refunds/:id/decision', requirePermission('refunds:approve'), idempotent({ required: true }), validate({ body: z.object({ approve: z.boolean(), note: text(500).optional() }) }),
  h(async (req, res) => ok(res, { refund: await payments.decideRefund(req, req.params.id, req.body) })));
r.post('/invoices/:id/adjustments', requirePermission('adjustments:create'), idempotent({ required: true }), validate({ body: z.object({
  type: z.enum(['credit_memo', 'debit_memo', 'write_off', 'goodwill', 'reversal']), amountCents: posCents.optional(), reason: reqText(500), reversesAdjustmentId: id.optional()
}).refine(b => b.type === 'reversal' ? Boolean(b.reversesAdjustmentId) : Boolean(b.amountCents), 'amountCents (or reversesAdjustmentId for reversals) is required') }),
  h(async (req, res) => ok(res, { adjustment: await payments.createAdjustment(req, req.params.id, req.body) }, 201)));
r.get('/reconciliation', requirePermission('reconciliation:manage'), h(async (req, res) => ok(res, await payments.dailySummary(req.auth, req.query))));
r.post('/reconciliation/close', requirePermission('reconciliation:manage'), validate({ body: z.object({ locationId: id, businessDate: dateStr, counted: z.record(z.enum(PAYMENT_METHODS), cents), notes: text(1000).optional() }) }),
  h(async (req, res) => ok(res, { reconciliation: await payments.closeReconciliation(req, req.body) })));

export default r;
