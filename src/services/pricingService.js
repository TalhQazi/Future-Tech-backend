import { Part, Fee, LaborOperation } from '../models/index.js';
import { laborCents, extendCents, applyBps, roundDiv, isCents } from '../lib/money.js';
import { badRequest, unprocessable } from '../lib/errors.js';
import { evaluateMembership } from './membershipService.js';
import { hashCanonical } from '../lib/crypto.js';

export const PRICING_ENGINE_VERSION = 'pricing-1';

const rateFor = (location, rateType) => {
  const key = { standard: 'standardCents', diagnostic: 'diagnosticCents', ev: 'evCents' }[rateType || 'standard'];
  return location.laborRates?.[key] || 0;
};

// Parts matrix: first tier whose maxCostCents >= unit cost (null = no ceiling).
export const matrixPrice = (location, unitCostCents) => {
  const tiers = [...(location.partsMarkupMatrix || [])].sort((a, b) => (a.maxCostCents ?? Infinity) - (b.maxCostCents ?? Infinity));
  const tier = tiers.find(t => t.maxCostCents === null || t.maxCostCents === undefined || unitCostCents <= t.maxCostCents);
  if (!tier) return null;
  return unitCostCents + applyBps(unitCostCents, tier.markupBps);
};

// Largest-remainder allocation so per-line tax always sums to the total tax.
const allocate = (total, weights) => {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - floors[i], i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    floors[i] += 1;
    rest -= 1;
  }
  return floors;
};

/**
 * Prices draft lines for a location. All money is integer cents.
 * Returns { lines, totals, pricingContext, membershipEvaluation }.
 */
export const priceLines = async ({ location, ro, lines }) => {
  const currency = location.currency || 'USD';
  const partIds = [...new Set(lines.filter(l => l.kind === 'part' && l.partId).map(l => l.partId))];
  const feeCodes = [...new Set(lines.filter(l => l.kind === 'fee').map(l => l.feeCode))];
  const opCodes = [...new Set(lines.filter(l => l.laborOpCode).map(l => l.laborOpCode))];
  const [parts, fees, ops] = await Promise.all([
    Part.find({ id: { $in: partIds } }).lean(),
    Fee.find({ code: { $in: feeCodes }, active: true }).lean(),
    LaborOperation.find({ code: { $in: opCodes } }).lean()
  ]);
  const partMap = new Map(parts.map(p => [p.id, p]));
  const feeMap = new Map(fees.map(f => [f.code, f]));
  const opMap = new Map(ops.map(o => [o.code, o]));

  const priced = [];
  for (const [index, line] of lines.entries()) {
    const base = { ...line, sortOrder: line.sortOrder ?? index, findingIds: line.findingIds || [] };
    if (line.kind === 'labor') {
      const op = line.laborOpCode ? opMap.get(line.laborOpCode) : null;
      if (line.laborOpCode && !op) throw badRequest(`Unknown labor operation ${line.laborOpCode}`);
      const rateType = line.laborRateType || op?.rateType || 'standard';
      const hours = line.hours ?? op?.defaultHours;
      if (!(hours >= 0)) throw badRequest(`Labor line "${line.description}" needs hours`);
      const rate = isCents(line.rateCents) ? line.rateCents : rateFor(location, rateType);
      if (!rate) throw unprocessable(`Labor rate "${rateType}" is not configured for ${location.name}`, undefined, 'LABOR_RATE_NOT_CONFIGURED');
      priced.push({ ...base, laborRateType: rateType, hours, rateCents: rate, extendedCents: laborCents(rate, hours), taxable: Boolean(location.laborTaxable) });
    } else if (line.kind === 'part') {
      const part = line.partId ? partMap.get(line.partId) : null;
      if (line.partId && !part) throw badRequest(`Unknown part ${line.partId}`);
      const quantity = line.quantity ?? 1;
      if (!(quantity > 0)) throw badRequest(`Part line "${line.description}" needs a positive quantity`);
      const unitCost = isCents(line.unitCostCents) ? line.unitCostCents : (part?.unitCostCents ?? 0);
      let unitPrice = isCents(line.unitPriceCents) ? line.unitPriceCents : part?.listPriceCents;
      if (!unitPrice && unitCost) unitPrice = matrixPrice(location, unitCost);
      if (!isCents(unitPrice) || unitPrice <= 0) throw unprocessable(`No price for part "${line.description}". Enter a price or configure the parts matrix.`, undefined, 'PART_PRICE_MISSING');
      priced.push({
        ...base, partNumber: part?.partNumber || line.partNumber, quantity, unitPriceCents: unitPrice, unitCostCents: unitCost,
        extendedCents: extendCents(unitPrice, quantity), taxable: Boolean(location.partsTaxable) && (part ? part.taxable !== false : true)
      });
    } else if (line.kind === 'sublet') {
      const quantity = line.quantity ?? 1;
      if (!isCents(line.unitPriceCents)) throw badRequest(`Sublet line "${line.description}" needs a price`);
      priced.push({ ...base, quantity, unitPriceCents: line.unitPriceCents, unitCostCents: line.unitCostCents || 0, extendedCents: extendCents(line.unitPriceCents, quantity), taxable: Boolean(location.laborTaxable) });
    } else if (line.kind === 'fee') {
      priced.push({ ...base, pendingFee: true });
    } else {
      throw badRequest(`Unsupported line kind ${line.kind}`);
    }
  }

  // Fees are computed from labor/parts bases after those lines are priced.
  const laborBase = priced.filter(l => l.kind === 'labor').reduce((s, l) => s + l.extendedCents, 0);
  const partsBase = priced.filter(l => l.kind === 'part').reduce((s, l) => s + l.extendedCents, 0);
  for (const line of priced.filter(l => l.pendingFee)) {
    const fee = feeMap.get(line.feeCode);
    if (!fee) throw badRequest(`Unknown or inactive fee ${line.feeCode}`);
    let amount = fee.kind === 'flat' ? fee.amountCents : applyBps(fee.kind === 'percent_of_labor' ? laborBase : partsBase, fee.rateBps);
    if (fee.minCents !== null && fee.minCents !== undefined) amount = Math.max(amount, fee.minCents);
    if (fee.maxCents !== null && fee.maxCents !== undefined) amount = Math.min(amount, fee.maxCents);
    Object.assign(line, { description: line.description || fee.name, quantity: 1, unitPriceCents: amount, extendedCents: amount, taxable: Boolean(fee.taxable) && Boolean(location.feesTaxable) });
    delete line.pendingFee;
  }

  const { evaluation, discountsByLine } = await evaluateMembership({ customerId: ro.customerId, vehicleId: ro.vehicleId, roId: ro.id, lines: priced });
  for (const line of priced) {
    line.discountCents = Math.min(discountsByLine.get(line.id) || 0, line.extendedCents);
    line.netCents = line.extendedCents - line.discountCents;
  }

  const taxRateBps = location.taxRateBps || 0;
  const taxableLines = priced.filter(l => l.taxable && l.netCents > 0);
  const taxableCents = taxableLines.reduce((s, l) => s + l.netCents, 0);
  const taxCents = roundDiv(taxableCents * taxRateBps, 10_000);
  const shares = allocate(taxCents, taxableLines.map(l => l.netCents));
  taxableLines.forEach((l, i) => { l.taxCents = shares[i]; });
  for (const line of priced) {
    line.taxCents = line.taxCents || 0;
    line.totalCents = line.netCents + line.taxCents;
  }

  const sum = (kind) => priced.filter(l => l.kind === kind).reduce((s, l) => s + l.extendedCents, 0);
  const discountCents = priced.reduce((s, l) => s + l.discountCents, 0);
  const extended = priced.reduce((s, l) => s + l.extendedCents, 0);
  const totals = {
    laborCents: sum('labor'),
    partsCents: sum('part'),
    feesCents: sum('fee'),
    subletCents: sum('sublet'),
    discountCents,
    subtotalCents: extended - discountCents,
    taxableCents,
    taxCents,
    totalCents: extended - discountCents + taxCents
  };
  const pricingContext = {
    engineVersion: PRICING_ENGINE_VERSION,
    locationId: location.id,
    currency,
    taxRateBps,
    laborTaxable: Boolean(location.laborTaxable),
    partsTaxable: Boolean(location.partsTaxable),
    feesTaxable: Boolean(location.feesTaxable),
    laborRates: location.laborRates,
    partsMarkupMatrix: location.partsMarkupMatrix || []
  };
  return { lines: priced, totals, pricingContext, membershipEvaluation: evaluation, currency };
};

// Commercially relevant content of a line; any change requires re-approval.
// Tax is excluded because its cent allocation depends on the other lines.
export const lineHash = (line) => hashCanonical({
  id: line.id, kind: line.kind, description: line.description, laborOpCode: line.laborOpCode || null, hours: line.hours ?? null,
  rateCents: line.rateCents ?? null, partId: line.partId || null, partNumber: line.partNumber || null,
  quantity: line.quantity ?? null, unitPriceCents: line.unitPriceCents ?? null, feeCode: line.feeCode || null,
  extendedCents: line.extendedCents, discountCents: line.discountCents, taxable: Boolean(line.taxable),
  safetyCritical: Boolean(line.safetyCritical)
});
