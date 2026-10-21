import { env } from '../config/env.js';
import { serviceUnavailable } from '../lib/errors.js';

// VIN decoding and recall lookup through NHTSA's public vPIC and Recalls APIs.
// Results are returned exactly as NHTSA reports them; nothing is inferred.

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export const normalizeVin = (vin) => String(vin || '').toUpperCase().replace(/\s+/g, '');

// ISO 3779 check digit (mandatory for North American VINs).
export const vinCheckDigitValid = (vin) => {
  const v = normalizeVin(vin);
  if (!VIN_RE.test(v)) return false;
  const sum = [...v].reduce((acc, ch, i) => acc + (/\d/.test(ch) ? Number(ch) : TRANSLIT[ch]) * WEIGHTS[i], 0);
  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return v[8] === expected;
};

export const validateVin = (vin) => {
  const v = normalizeVin(vin);
  if (!VIN_RE.test(v)) return { valid: false, vin: v, reason: 'VIN must be 17 characters using digits and letters except I, O and Q' };
  return { valid: true, vin: v, checkDigitValid: vinCheckDigitValid(v) };
};

const fetchJson = async (url, timeoutMs = 8000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw serviceUnavailable(`Vehicle data service unavailable (${err.name === 'AbortError' ? 'timeout' : err.message}). Enter the vehicle details manually.`, 'VEHICLE_DATA_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
};

const clean = (v) => (v === null || v === undefined || v === '' || v === 'Not Applicable' ? null : String(v).trim());

export const decodeVin = async (vin) => {
  const check = validateVin(vin);
  if (!check.valid) return { valid: false, vin: check.vin, reason: check.reason };
  const data = await fetchJson(`${env.vin.nhtsaBaseUrl}/vehicles/DecodeVinValuesExtended/${encodeURIComponent(check.vin)}?format=json`);
  const r = data?.Results?.[0] || {};
  const engineParts = [
    clean(r.DisplacementL) ? `${Number(r.DisplacementL).toFixed(1)}L` : null,
    clean(r.EngineConfiguration),
    clean(r.EngineCylinders) ? `${r.EngineCylinders}-cyl` : null,
    clean(r.EngineModel)
  ].filter(Boolean);
  const errorCode = clean(r.ErrorCode);
  return {
    valid: true,
    vin: check.vin,
    checkDigitValid: check.checkDigitValid,
    source: 'nhtsa_vpic',
    year: clean(r.ModelYear) ? Number(r.ModelYear) : null,
    make: clean(r.Make),
    model: clean(r.Model),
    trim: clean(r.Trim) || clean(r.Series),
    engine: engineParts.join(' ') || null,
    fuelType: clean(r.FuelTypePrimary),
    bodyClass: clean(r.BodyClass),
    driveType: clean(r.DriveType),
    transmission: clean(r.TransmissionStyle),
    plantCountry: clean(r.PlantCountry),
    errorCode,
    errorText: clean(r.ErrorText),
    decodeComplete: errorCode === '0'
  };
};

export const lookupRecalls = async ({ make, model, year }) => {
  if (!make || !model || !year) {
    return { available: false, reason: 'Make, model and model year are required for a recall lookup', recalls: [] };
  }
  const params = new URLSearchParams({ make, model, modelYear: String(year) });
  const data = await fetchJson(`${env.vin.recallsBaseUrl}/recalls/recallsByVehicle?${params.toString()}`);
  const recalls = (data?.results || []).map(r => ({
    campaignNumber: r.NHTSACampaignNumber,
    component: r.Component,
    summary: r.Summary,
    consequence: r.Consequence,
    remedy: r.Remedy,
    manufacturer: r.Manufacturer,
    reportReceivedDate: r.ReportReceivedDate,
    parkIt: Boolean(r.parkIt),
    parkOutSide: Boolean(r.parkOutSide)
  }));
  return {
    available: true,
    source: 'nhtsa_recalls_api',
    retrievedAt: new Date().toISOString(),
    scope: 'make_model_year',
    note: 'NHTSA campaigns for this make/model/year. Whether a specific VIN is affected or already remedied must be confirmed with the manufacturer.',
    recalls
  };
};

export const vehicleDataStatus = () => ({
  vinDecoder: { provider: 'NHTSA vPIC', configured: true, baseUrl: env.vin.nhtsaBaseUrl },
  recalls: { provider: 'NHTSA Recalls API', configured: true, scope: 'make/model/year' }
});
