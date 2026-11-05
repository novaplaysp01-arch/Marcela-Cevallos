const { test } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const b = require('../netlify/lib/billing');

const checkout = require('../netlify/functions/create-checkout-session').handler;
const status = require('../netlify/functions/subscription-status').handler;
const portal = require('../netlify/functions/manage-subscription').handler;
const webhook = require('../netlify/functions/stripe-webhook').handler;

const event = {
  httpMethod: 'POST',
  headers: { origin: b.ORIGIN, authorization: 'Bearer verified.token' },
  body: JSON.stringify({ plan: 'premium_monthly', email: 'forged@example.invalid' })
};

function fake() {
  const calls = { created: [], updated: [], sessions: [], portals: [] };
  const stripe = {
    accounts: { retrieve: async () => ({ id: b.ACCOUNT }) },
    customers: {
      search: async () => ({ data: [{ id: 'cus_owned', metadata: { app: 'finova', finova_user_id: 'user-123' } }] }),
      create: async (...args) => { calls.created.push(args); return { id: 'cus_owned' }; },
      retrieve: async () => ({ id: 'cus_owned', metadata: { app: 'finova', finova_user_id: 'user-123' } }),
      update: async (...args) => { calls.updated.push(args); return { id: 'cus_owned' }; }
    },
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    prices: { list: async () => ({ data: [{ id: 'price_test', unit_amount: 999, currency: 'eur', livemode: false, recurring: { interval: 'month' }, lookup_key: 'finova_premium_monthly', active: true }], has_more: false }) },
    checkout: { sessions: {
      list: async () => ({ data: [], has_more: false }),
      create: async (...args) => { calls.sessions.push(args); return { id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/cs_test' }; }
    } },
    billingPortal: { sessions: {
      create: async (args) => { calls.portals.push(args); return { url: 'https://billing.stripe.com/p/session/test' }; }
    } },
    webhooks: new Stripe('sk_test_placeholder').webhooks
  };
  return { stripe, calls };
}

function setup(t) {
  const f = fake();
  t.mock.method(b, 'client', () => f.stripe);
  t.mock.method(global, 'fetch', async (url) => {
    assert.equal(url, b.ORIGIN + '/.netlify/identity/user');
    return { ok: true, json: async () => ({ id: 'user-123', email: 'user@example.com', confirmed_at: '2026-01-01T00:00:00Z' }) };
  });
  return f;
}

function subscription(overrides = {}) {
  return {
    livemode: false,
    status: 'active',
    metadata: { app: 'finova' },
    latest_invoice: { status: 'paid' },
    items: { data: [{ price: { lookup_key: 'finova_premium_monthly' } }] },
    ...overrides
  };
}

test('billing rejects disabled mode and mismatched live credentials', () => {
  const previous = { ...process.env };
  try {
    process.env.FINOVA_BILLING_MODE = 'disabled';
    assert.throws(() => b.client(), /desactivada/);
    process.env.FINOVA_BILLING_MODE = 'live';
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    assert.throws(() => b.client(), /producción/);
  } finally { process.env = previous; }
});

test('checkout creates a subscription using verified identity and a valid price', async (t) => {
  const f = setup(t);
  f.stripe.customers.search = async () => ({ data: [] });
  const response = await checkout(event);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /checkout\.stripe\.com/);
  assert.equal(f.calls.sessions.length, 1);
  assert.equal(f.calls.sessions[0][0].customer, 'cus_owned');
});

test('checkout rejects wrong account, absent token, invalid plan and duplicate subscription', async (t) => {
  const f = setup(t);
  f.stripe.accounts.retrieve = async () => ({ id: 'acct_wrong' });
  assert.equal((await checkout(event)).statusCode, 503);
  f.stripe.accounts.retrieve = async () => ({ id: b.ACCOUNT });
  assert.equal((await checkout({ ...event, headers: { ...event.headers, authorization: '' } })).statusCode, 401);
  assert.equal((await checkout({ ...event, body: JSON.stringify({ plan: 'bad_plan' }) })).statusCode, 400);
  f.stripe.subscriptions.list = async () => ({ data: [subscription()], has_more: false });
  assert.equal((await checkout(event)).statusCode, 409);
});

test('entitlement is derived from Stripe and excludes unpaid and wrong-mode subscriptions', async () => {
  const f = fake();
  f.stripe.subscriptions.list = async () => ({ data: [subscription()], has_more: false });
  assert.equal((await b.entitlement(f.stripe, 'cus_owned')).plan, 'premium');
  f.stripe.subscriptions.list = async () => ({ data: [subscription({ latest_invoice: { status: 'unpaid' } })], has_more: false });
  assert.equal((await b.entitlement(f.stripe, 'cus_owned')).plan, 'free');
  f.stripe.subscriptions.list = async () => ({ data: [subscription({ livemode: true })], has_more: false });
  assert.equal((await b.entitlement(f.stripe, 'cus_owned')).plan, 'free');
});

test('portal and status are bound to authenticated customer', async (t) => {
  const f = setup(t);
  const old = process.env.STRIPE_PORTAL_CONFIGURATION;
  process.env.STRIPE_PORTAL_CONFIGURATION = 'bpc_test';
  try {
    const response = await portal({ httpMethod: 'POST', headers: event.headers });
    assert.equal(response.statusCode, 200);
    assert.equal(f.calls.portals[0].customer, 'cus_owned');
    const result = await status({ httpMethod: 'GET', headers: { origin: b.ORIGIN, authorization: 'Bearer verified.token' } });
    assert.equal(result.statusCode, 200);
  } finally {
    if (old === undefined) delete process.env.STRIPE_PORTAL_CONFIGURATION;
    else process.env.STRIPE_PORTAL_CONFIGURATION = old;
  }
});

test('webhook rejects missing signature and synchronizes valid signed events', async (t) => {
  const f = setup(t);
  const secret = 'whsec_unit_test_only';
  const old = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  try {
    const payload = { id: 'evt_test', type: 'customer.subscription.deleted', livemode: false, data: { object: { customer: 'cus_owned' } } };
    const signed = (obj) => {
      const message = JSON.stringify(obj);
      const crypto = require('node:crypto');
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${message}`).digest('hex');
      return { httpMethod: 'POST', headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` }, body: message };
    };
    assert.equal((await webhook({ httpMethod: 'POST', headers: {}, body: '{}' })).statusCode, 400);
    assert.equal((await webhook(signed(payload))).statusCode, 200);
    assert.equal(f.calls.updated.length, 1);
  } finally {
    if (old === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = old;
  }
});

test('cross-origin requests and incorrect methods are rejected', async (t) => {
  setup(t);
  assert.equal((await checkout({ ...event, headers: { ...event.headers, origin: 'https://attacker.invalid' } })).statusCode, 403);
  assert.equal((await checkout({ ...event, httpMethod: 'GET' })).statusCode, 405);
});
