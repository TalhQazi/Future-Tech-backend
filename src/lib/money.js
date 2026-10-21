// Decimal-safe money math. Every amount is an integer number of minor units
// (cents) plus an explicit ISO-4217 currency on the owning document. Rates are
// basis points (1 bps = 0.01%), hours are hundredths, quantities thousandths.

import { badRequest } from './errors.js';

const MAX_CENTS = 100_000_000_000; // $1B guard rail keeps intermediate products < 2^53

export const isCents = (v) => Number.isSafeInteger(v) && Math.abs(v) <= MAX_CENTS;

export const assertCents = (v, field = 'amount') => {
  if (!isCents(v)) throw badRequest(`${field} must be an integer number of cents`);
  return v;
};

// Integer division with half-away-from-zero rounding.
export const roundDiv = (numerator, denominator) => {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error('roundDiv requires safe integers and a positive denominator');
  }
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const q = Math.floor(abs / denominator);
  const r = abs - q * denominator;
  return sign * (r * 2 >= denominator ? q + 1 : q);
};

// Converts a decimal value with a fixed number of digits into an integer scale
// using its string form, so 1.1 * 100 never becomes 110.00000000000001.
export const toScaledInt = (value, digits, field = 'value') => {
  if (value === null || value === undefined || value === '') throw badRequest(`${field} is required`);
  const s = typeof value === 'number' ? value.toString() : String(value).trim();
  if (!/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) throw badRequest(`${field} must be numeric`);
  const n = Number(s);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be numeric`);
  if (Math.abs(n) >= 1e12) throw badRequest(`${field} is out of range`);
  const [intPart, frac = ''] = n.toFixed(digits + 2).split('.');
  const scaled = BigInt(intPart + frac.slice(0, digits).padEnd(digits, '0'));
  // reject precision beyond the allowed digits
  if (frac.slice(digits).replace(/0+$/, '') !== '') {
    throw badRequest(`${field} supports at most ${digits} decimal places`);
  }
  const out = Number(scaled);
  if (!Number.isSafeInteger(out)) throw badRequest(`${field} is out of range`);
  return out;
};

export const dollarsToCents = (value, field = 'amount') => toScaledInt(value, 2, field);
export const hoursToHundredths = (hours, field = 'hours') => toScaledInt(hours, 2, field);
export const qtyToThousandths = (qty, field = 'quantity') => toScaledInt(qty, 3, field);

// rateCents per hour * hours
export const laborCents = (rateCents, hours) => roundDiv(rateCents * hoursToHundredths(hours), 100);

// unitCents * quantity (quantity may be fractional, e.g. 5.5 quarts)
export const extendCents = (unitCents, qty) => roundDiv(unitCents * qtyToThousandths(qty), 1000);

// amount * bps / 10000 (tax, discounts, markups)
export const applyBps = (cents, bps) => roundDiv(cents * bps, 10_000);

export const sumCents = (values) => values.reduce((acc, v) => acc + (Number.isSafeInteger(v) ? v : 0), 0);

// Legacy documents stored dollars as floating point numbers.
export const legacyDollarsToCents = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export const formatCents = (cents, currency = 'USD', locale = 'en-US') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format((cents || 0) / 100);
