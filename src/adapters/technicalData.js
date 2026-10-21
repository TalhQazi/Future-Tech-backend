import { env } from '../config/env.js';
import { serviceUnavailable } from '../lib/errors.js';

// Licensed OEM / aggregator technical-information adapter.
//
// Contract expected from a licensed provider bridge (configured with
// TECHDATA_PROVIDER_URL + TECHDATA_API_KEY):
//   GET {url}/v1/specifications?vin=&make=&model=&year=&engine=&q=
//   GET {url}/v1/procedures?vin=&dtc=&q=
//   GET {url}/v1/wiring?vin=&system=
// Each item must carry { source: { name, publisher, version, license: {...} } }.
// Nothing is returned when no provider is licensed; technicians then work from
// shop-authored records that cite their source documents.

const configured = () => Boolean(env.technicalData.providerUrl && env.technicalData.apiKey);

const call = async (path, params) => {
  if (!configured()) {
    throw serviceUnavailable('No licensed technical-data provider is configured. Use reviewed shop-authored records with cited sources.', 'TECHDATA_NOT_CONFIGURED');
  }
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${env.technicalData.providerUrl.replace(/\/$/, '')}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${env.technicalData.apiKey}`, Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    throw serviceUnavailable(`Technical-data provider unavailable (${err.name === 'AbortError' ? 'timeout' : err.message})`, 'TECHDATA_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
};

export const technicalData = {
  configured,
  status: () => ({
    configured: configured(),
    provider: env.technicalData.providerName || null,
    mode: configured() ? 'licensed_provider' : 'shop_authored_only'
  }),
  searchSpecifications: (params) => call('/v1/specifications', params),
  searchProcedures: (params) => call('/v1/procedures', params),
  searchWiring: (params) => call('/v1/wiring', params)
};
