import crypto from 'crypto';
import { env } from '../config/env.js';
import { serviceUnavailable, badRequest } from '../lib/errors.js';

// Payment processing behind a replaceable adapter.
//  - manual: staff-attested in-store payments (cash, check, card terminal with
//    approval code, ACH reference, fleet account). Nothing is sent anywhere.
//  - stripe: online card payments through Stripe PaymentIntents. Only active
//    when STRIPE_SECRET_KEY is configured; never simulated.

const STRIPE_API = 'https://api.stripe.com/v1';

const formEncode = (obj, prefix) => {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') out.push(formEncode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
};

const stripeRequest = async (method, path, body, idempotencyKey) => {
  if (!env.payments.stripeSecretKey) {
    throw serviceUnavailable('Online card payments are not configured for this shop. Record an in-store payment instead.', 'PAYMENT_PROVIDER_NOT_CONFIGURED');
  }
  const headers = {
    Authorization: `Bearer ${env.payments.stripeSecretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${STRIPE_API}${path}`, { method, headers, body: body ? formEncode(body) : undefined, signal: ctrl.signal });
    const data = await res.json();
    if (!res.ok) {
      const message = data?.error?.message || `Stripe error ${res.status}`;
      const err = res.status >= 500 ? serviceUnavailable(`Payment provider error: ${message}`, 'PAYMENT_PROVIDER_ERROR') : badRequest(`Payment provider rejected the request: ${message}`);
      throw err;
    }
    return data;
  } catch (err) {
    if (err.status) throw err;
    throw serviceUnavailable(`Payment provider unreachable (${err.name === 'AbortError' ? 'timeout' : err.message})`, 'PAYMENT_PROVIDER_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
};

export const stripeAdapter = {
  configured: () => Boolean(env.payments.stripeSecretKey),
  createPaymentIntent: ({ amountCents, currency, metadata, idempotencyKey, description }) =>
    stripeRequest('POST', '/payment_intents', {
      amount: amountCents,
      currency: currency.toLowerCase(),
      description,
      automatic_payment_methods: { enabled: 'true' },
      metadata
    }, idempotencyKey),
  retrievePaymentIntent: (id) => stripeRequest('GET', `/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`),
  createRefund: ({ paymentIntentId, amountCents, idempotencyKey, reason }) =>
    stripeRequest('POST', '/refunds', { payment_intent: paymentIntentId, amount: amountCents, metadata: { reason: reason?.slice(0, 450) } }, idempotencyKey),
  // Stripe-Signature: t=<ts>,v1=<hex hmac of "<ts>.<raw body>">
  verifyWebhook: (rawBody, signatureHeader, toleranceSeconds = 300) => {
    if (!env.payments.stripeWebhookSecret) throw serviceUnavailable('Stripe webhook secret is not configured', 'PAYMENT_WEBHOOK_NOT_CONFIGURED');
    const parts = Object.fromEntries(String(signatureHeader || '').split(',').map(kv => kv.split('=')));
    const ts = Number(parts.t);
    if (!ts || !parts.v1) return false;
    if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
    const expected = crypto.createHmac('sha256', env.payments.stripeWebhookSecret).update(`${ts}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
};

export const paymentProvidersStatus = () => ({
  manual: { configured: true, methods: ['cash', 'check', 'card_terminal', 'ach', 'fleet_account'], description: 'Staff-recorded in-store payments' },
  stripe: {
    configured: stripeAdapter.configured(),
    webhookConfigured: Boolean(env.payments.stripeWebhookSecret),
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    methods: ['card_online']
  }
});
