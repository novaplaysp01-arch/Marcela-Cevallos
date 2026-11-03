'use strict';
const Stripe = require('stripe');
const { createHash, randomBytes } = require('node:crypto');

const ORIGIN = 'https://storied-pika-1d2990.netlify.app';
const ACCOUNT = 'acct_1UNYwq0WT1XqdqLb';
const LIVE_ACCOUNT = 'acct_1UNYwe0G40NrtpeH';
const TEST_PORTAL_CONFIGURATION = 'bpc_1UTp1i0WT1XqdqLbOgaNDm1w';

const plans = Object.freeze({
  premium_monthly: 'finova_premium_monthly',
  premium_yearly: 'finova_premium_yearly',
  pro_monthly: 'finova_pro_monthly',
  pro_yearly: 'finova_pro_yearly'
});

const events = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed'
]);

function mode() {
  return process.env.FINOVA_BILLING_MODE ?? 'test';
}

function isLive() {
  return mode() === 'live';
}

function portalConfiguration() {
  const value = process.env.STRIPE_PORTAL_CONFIGURATION;
  if (isLive()) {
    if (!value || value === TEST_PORTAL_CONFIGURATION) {
      throw error(503, 'Falta configurar el portal de producción.');
    }
    return value;
  }
  if (!value) {
    return TEST_PORTAL_CONFIGURATION;
  }
  return value;
}

function error(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function client() {
  const secret = process.env.STRIPE_SECRET_KEY || '';
  const selected = mode();

  if (!['test', 'live'].includes(selected)) {
    throw error(503, 'La facturación está desactivada.', 'disabled');
  }

  if (selected === 'live') {
    if (!/^([sr]k)_live_/.test(secret)) {
      throw error(503, 'Se necesita una clave de Stripe de producción.', 'live_key_required');
    }
    portalConfiguration();
  } else if (!/^([sr]k)_test_/.test(secret)) {
    throw error(503, 'Se necesita una clave de Stripe de pruebas.', 'test_key_required');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw error(503, 'Falta configurar la firma del webhook.', 'webhook_secret_required');
  }

  return new Stripe(secret, { apiVersion: '2026-08-26.dahlia', maxNetworkRetries: 2 });
}

async function verifyAccount(stripe) {
  const account = await stripe.accounts.retrieve();
  const expected = isLive() ? LIVE_ACCOUNT : ACCOUNT;
  if (account.id !== expected) {
    throw error(503, 'La cuenta de Stripe no coincide con el entorno configurado.', 'sandbox_mismatch');
  }
  if (isLive() && !account.charges_enabled) {
    throw error(503, 'Los cobros reales no están disponibles.', 'live_charges_disabled');
  }
  return account;
}

async function user(event) {
  const token = event.headers?.authorization || event.headers?.Authorization || '';
  if (!/^Bearer [\w.-]+$/.test(token)) {
    throw error(401, 'Inicia sesión para gestionar tu suscripción.');
  }

  const res = await fetch(ORIGIN + '/.netlify/identity/user', {
    headers: { Authorization: token },
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    throw error(401, 'La sesión ha caducado. Vuelve a iniciar sesión.');
  }

  const u = await res.json();
  if (!u.id || !u.email || !u.confirmed_at) {
    throw error(401, 'Confirma tu cuenta antes de continuar.');
  }

  return u;
}

function sameOrigin(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  if (origin && origin !== ORIGIN) {
    throw error(403, 'Origen no permitido.');
  }
}

async function customerFor(stripe, u, create = false) {
  const id = String(u.id);
  if (!/^[\w-]{1,100}$/.test(id)) {
    throw error(401, 'Usuario no válido.');
  }

  const found = await stripe.customers.search({
    query: `metadata['finova_user_id']:'${id}' AND metadata['app']:'finova'`,
    limit: 2
  });

  if (found.data.length > 1) {
    throw error(409, 'Hay cuentas duplicadas. Contacta con soporte antes de pagar.');
  }

  if (found.data[0]) {
    return found.data[0];
  }

  if (!create) {
    return null;
  }

  return stripe.customers.create({
    email: u.email,
    metadata: { app: 'finova', finova_user_id: id }
  }, {
    idempotencyKey: 'finova-customer-' + createHash('sha256').update(id).digest('hex')
  });
}

function planLookupKey(plan) {
  const key = String(plan || '').trim();
  if (!Object.prototype.hasOwnProperty.call(plans, key)) {
    throw error(400, 'Plan no válido.');
  }
  return plans[key];
}

async function requirePrice(stripe, lookupKey, liveMode = isLive()) {
  const key = String(lookupKey || '').trim();
  if (!Object.values(plans).includes(key)) {
    throw error(400, 'Plan no válido.');
  }

  const result = await stripe.prices.list({ active: true, lookup_keys: [key], limit: 100 });
  const data = Array.isArray(result?.data) ? result.data : [];

  if (result?.has_more || data.length !== 1) {
    throw error(503, 'El precio de este plan no está disponible de forma única en el entorno actual.');
  }

  const price = data[0];
  if (!price?.id || price.active === false || price.currency !== 'eur' || price.livemode !== liveMode || !price.recurring || (price.lookup_key != null && price.lookup_key !== key)) {
    throw error(503, 'El precio del plan no cumple las condiciones del entorno actual.');
  }

  return price;
}

async function entitlement(stripe, customer) {
  const list = await stripe.subscriptions.list({ customer, status: 'all', limit: 100, expand: ['data.latest_invoice'] });
  if (list.has_more) {
    throw error(503, 'No se pudo verificar todas las suscripciones.');
  }

  const eligible = (list.data || []).filter((s) => {
    return s.livemode === isLive() && ['active', 'trialing'].includes(s.status) && s.metadata?.app === 'finova' && (s.status === 'trialing' || s.latest_invoice?.status === 'paid');
  });

  let chosen = null;
  let tier = 'free';
  for (const sub of eligible) {
    const lookup = sub.items?.data?.[0]?.price?.lookup_key;
    if (!Object.values(plans).includes(lookup)) continue;
    const current = lookup.includes('_pro_') ? 'pro' : 'premium';
    if (!chosen || current === 'pro' || (current === 'premium' && chosen.plan === 'free')) {
      chosen = { ...sub, plan: current };
      tier = current;
    }
  }

  return {
    plan: tier,
    status: chosen?.status || 'inactive',
    cancel_at_period_end: !!chosen?.cancel_at_period_end,
    cancel_at: chosen?.cancel_at || null,
    cancellation_scheduled: !!(chosen?.cancel_at_period_end || chosen?.cancel_at),
    customer: customer
  };
}

async function syncCustomer(stripe, id) {
  const state = await entitlement(stripe, id);
  await stripe.customers.update(id, {
    metadata: {
      finova_plan: state.plan,
      finova_status: state.status
    }
  });
  return state;
}

async function run(event, method, fn) {
  try {
    if (event.httpMethod !== method) {
      return response(405, { error: 'Método no permitido.' });
    }
    sameOrigin(event);
    return await fn();
  } catch (e) {
    const status = Number.isInteger(e.status) ? e.status : 500;
    const message = e.message || 'Error interno.';
    const payload = { error: message };
    if (e.code) payload.code = e.code;
    return response(status, payload);
  }
}

function identifier() {
  return 'finova_' + mode() + '_' + Array.from(randomBytes(8), (byte) => String.fromCharCode(97 + byte % 26)).join('');
}

module.exports = {
  ORIGIN,
  ACCOUNT,
  LIVE_ACCOUNT,
  TEST_PORTAL_CONFIGURATION,
  mode,
  isLive,
  portalConfiguration,
  plans,
  events,
  error,
  response,
  client,
  verifyAccount,
  user,
  sameOrigin,
  customerFor,
  planLookupKey,
  requirePrice,
  entitlement,
  syncCustomer,
  run,
  identifier
};
