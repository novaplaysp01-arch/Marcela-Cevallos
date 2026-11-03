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
    accounts: {
      retrieve: async () => ({ id: b.ACCOUNT })
    },
    customers: {
      search: async () => ({ data: [{ id: 'cus_owned', metadata: { app: 'finova', finova_user_id: 'user-123' } }] }),
      create: async (...x) => { calls.created.push(x); return { id: 'cus_owned' }; },
      retrieve: async () => ({ id: 'cus_owned', metadata: { app: 'finova', finova_user_id: 'user-123' } }),
      update: async (...x) => { calls.updated.push(x); return { id: 'cus_owned' }; }
    },
    subscriptions: {
      list: async () => ({ data: [], has_more: false })
    },
    prices: {
      list: async () => ({ data: [{ id: 'price_test', currency: 'eur', livemode: false, recurring: { interval: 'month' }, lookup_key: 'finova_premium_monthly', active: true }], has_more: false })
    },
    checkout: {
      sessions: {
        list: async () => ({ data: [], has_more: false }),
        expire: async () => {},
        create: async (...x) => { calls.sessions.push(x); return { id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/cs_test' }; }
      }
    },
    billingPortal: {
      sessions: {
        create: async (x) => { calls.portals.push(x); return { url: 'https://billing.stripe.com/p/session/test' }; }
      }
    },
    webhooks: new Stripe('sk_test_placeholder').webhooks
  };
  return { stripe, calls };
}

function setup(t) {
  const f = fake();
  t.mock.method(b, 'client', () => f.stripe);
  t.mock.method(global, 'fetch', async (url, opt) => {
    assert.equal(url, b.ORIGIN + '/.netlify/identity/user');
    return {
      ok: true,
      json: async () => ({ id: 'user-123', email: 'user@example.com', confirmed_at: '2026-01-01T00:00:00Z' })
    };
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

test('billing rejects disabled configuration and live credentials', () => {
  const previous = { ...process.env };
  try {
    process.env.FINOVA_BILLING_MODE = 'disabled';
    assert.throws(() => b.client(), /desactivada/);

    process.env.FINOVA_BILLING_MODE = 'live';
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    assert.throws(() => b.client(), /producción/);

    process.env.STRIPE_SECRET_KEY = 'sk_live_placeholder';
    process.env.STRIPE_PORTAL_CONFIGURATION = 'bpc_live_separate';
    assert.ok(b.client());
  } finally {
    process.env = previous;
  }
});

test('checkout uses verified identity and collects invoice details on Stripe', async (t) => {
  const f = setup(t);
  f.stripe.customers.search = async () => ({ data: [] });

  const r = await checkout(event);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.includes('checkout.stripe.com'), true);
});

test('checkout rejects wrong account, absent token, invalid plans and duplicate subscriptions', async (t) => {
  const f = setup(t);
  f.stripe.accounts.retrieve = async () => ({ id: 'acct_wrong' });

  let r = await checkout({ ...event, headers: { ...event.headers, authorization: 'Bearer bad' } });
  assert.equal(r.statusCode, 503);

  r = await checkout({ ...event, headers: { ...event.headers, authorization: '' } });
  assert.equal(r.statusCode, 401);

  r = await checkout({ ...event, body: JSON.stringify({ plan: 'bad_plan' }) });
  assert.equal(r.statusCode, 400);

  f.stripe.accounts.retrieve = async () => ({ id: b.ACCOUNT });
  f.stripe.subscriptions.list = async () => ({ data: [subscription({ status: 'active' })], has_more: false });
  r = await checkout(event);
  assert.equal(r.statusCode, 409);
});

test('status is derived from Stripe; cancellation, unpaid invoices and past-due states revoke entitlement', async () => {
  const f = fake();
  for (const [s, expected] of [
    [subscription(), 'premium'],
    [subscription({ status: 'trialing' }), 'premium'],
    [subscription({ latest_invoice: { status: 'unpaid' } }), 'free'],
    [subscription({ cancel_at_period_end: true }), 'premium']
  ]) {
    f.stripe.subscriptions.list = async () => ({ data: [s], has_more: false });
    const state = await b.entitlement(f.stripe, 'cus_owned');
    assert.equal(state.plan, expected);
  }
});

test('portal and status are bound to the authenticated customer', async (t) => {
  const f = setup(t);
  const old = process.env.STRIPE_PORTAL_CONFIGURATION;
  process.env.STRIPE_PORTAL_CONFIGURATION = 'bpc_test';
  try {
    const r = await portal({
      httpMethod: 'POST',
      headers: { origin: b.ORIGIN, authorization: 'Bearer verified.token' }
    });
    assert.equal(r.statusCode, 200);
    const s = await status({
      httpMethod: 'GET',
      headers: { origin: b.ORIGIN, authorization: 'Bearer verified.token' }
    });
    assert.equal(s.statusCode, 200);
  } finally {
    if (old === undefined) delete process.env.STRIPE_PORTAL_CONFIGURATION;
    else process.env.STRIPE_PORTAL_CONFIGURATION = old;
  }
});

test('webhook requires genuine signature, refuses live events, and synchronises cancellation idempotently', async (t) => {
  const f = setup(t);
  const secret = 'whsec_unit_test_only';
  const old = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  try {
    const payload = {
      id: 'evt_test',
      type: 'customer.subscription.deleted',
      livemode: false,
      data: { object: { customer: 'cus_owned', metadata: { app: 'finova' } } }
    };

    const signed = (obj) => {
      const msg = JSON.stringify(obj);
      const crypto = require('node:crypto');
      const sig = crypto.createHmac('sha256', secret).update(msg).digest('hex');
      return { httpMethod: 'POST', headers: { 'stripe-signature': `t=${Date.now()},v1=${sig}`, origin: b.ORIGIN }, body: msg };
    };

    assert.equal((await webhook({ ...signed(payload), headers: {} })).statusCode, 400);
    assert.equal((await webhook({ ...signed({ ...payload, livemode: true }), headers: { 'stripe-signature': 'v1=abc' } })).statusCode, 400);
    assert.equal((await webhook(signed(payload))).statusCode, 200);
  } finally {
    if (old === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = old;
  }
});

test('cross-origin and incorrect HTTP methods are rejected', async (t) => {
  setup(t);
  assert.equal((await checkout({ ...event, headers: { ...event.headers, origin: 'https://attacker.invalid' } })).statusCode, 403);
  assert.equal((await checkout({ ...event, httpMethod: 'GET' })).statusCode, 405);
});

test('public test defaults work without extra hosting variables while live keys remain blocked', () => {
  const previous = { ...process.env };
  try {
    delete process.env.FINOVA_BILLING_MODE;
    delete process.env.STRIPE_PORTAL_CONFIGURATION;
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit_test_only';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit_test_only';
    assert.ok(b.client());
  } finally {
    process.env = previous;
  }
});

test('public configuration exposes a reason code without exposing any secret', async () => {
  const previous = { ...process.env };
  try {
    delete process.env.FINOVA_BILLING_MODE;
    delete process.env.STRIPE_SECRET_KEY;
    const r = await require('../netlify/functions/billing-config').handler({ httpMethod: 'GET', headers: {} });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.enabled, false);
    assert.ok(body.reason);
  } finally {
    process.env = previous;
  }
});

test('explicit cancellation date is reported even when Stripe period-end flag is false', async () => {
  const f = fake();
  f.stripe.subscriptions.list = async () => ({
    data: [subscription({ cancel_at: 1800000000, cancel_at_period_end: false })],
    has_more: false
  });
  const state = await b.entitlement(f.stripe, 'cus_owned');
  assert.equal(state.plan, 'premium');
  assert.equal(state.cancellation_scheduled, true);
  assert.equal(state.cancel_at, 1800000000);
});

test('live mode requires matching credentials and a separate portal, and excludes test entitlements', async () => {
  const previous = { ...process.env };
  try {
    process.env.FINOVA_BILLING_MODE = 'live';
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_placeholder';
    assert.throws(() => b.client(), /producción/);

    process.env.STRIPE_SECRET_KEY = 'sk_live_placeholder';
    process.env.STRIPE_PORTAL_CONFIGURATION = b.TEST_PORTAL_CONFIGURATION;
    assert.throws(() => b.client(), /portal de producción/);

    process.env.STRIPE_PORTAL_CONFIGURATION = 'bpc_live_separate';
    assert.ok(b.client());

    const f = fake();
    f.stripe.subscriptions.list = async () => ({ data: [subscription()], has_more: false });
    assert.equal((await b.entitlement(f.stripe, 'cus_owned')).plan, 'free');

    f.stripe.subscriptions.list = async () => ({ data: [subscription({ livemode: true })], has_more: false });
    let state = await b.entitlement(f.stripe, 'cus_owned');
    assert.equal(state.plan, 'premium');

    f.stripe.accounts.retrieve = async () => ({ id: b.ACCOUNT, charges_enabled: true });
    await assert.rejects(() => b.verifyAccount(f.stripe), /claves/);
    f.stripe.accounts.retrieve = async () => ({ id: b.LIVE_ACCOUNT, charges_enabled: false });
    await assert.rejects(() => b.verifyAccount(f.stripe), /cobros reales/);
  } finally {
    process.env = previous;
  }
});
