'use strict';
const b = require('../lib/billing');
const { createHash } = require('node:crypto');

exports.handler = (event) => b.run(event, 'POST', async () => {
  const stripe = b.client();
  await b.verifyAccount(stripe);
  const user = await b.user(event);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    throw b.error(400, 'Solicitud no válida.');
  }

  const lookup = b.planLookupKey(body.plan);
  const price = await b.requirePrice(stripe, lookup);
  const expectedInterval = body.plan.endsWith('_yearly') ? 'year' : 'month';
  if (price.lookup_key !== lookup || price.recurring?.interval !== expectedInterval || !Number.isInteger(price.unit_amount) || price.unit_amount <= 0) {
    throw b.error(503, 'El precio configurado para este plan no es válido.');
  }

  const customer = await b.customerFor(stripe, user, true);
  const current = await b.entitlement(stripe, customer.id);
  if (current.plan !== 'free') {
    throw b.error(409, 'Ya tienes una suscripción. Gestiona el plan existente.');
  }

  const sessions = await stripe.checkout.sessions.list({ customer: customer.id, status: 'open', limit: 100 });
  if (sessions.has_more) {
    throw b.error(409, 'Cierra los pagos pendientes antes de continuar.');
  }

  for (const session of sessions.data || []) {
    if (session.metadata?.app === 'finova' && session.metadata.plan === body.plan && session.url) {
      return b.response(200, { url: session.url, test: !b.isLive() });
    }
  }

  const idempotencyKey = 'finova-checkout-' + createHash('sha256')
    .update(`${user.id}:${body.plan}:${price.id}:${b.isLive() ? 'live' : 'test'}`)
    .digest('hex');

  const created = await stripe.checkout.sessions.create({
    mode: 'subscription',
    branding_settings: {
      display_name: 'm.cfinova',
      button_color: '#713cce',
      background_color: '#faf7ff'
    },
    customer: customer.id,
    billing_address_collection: 'required',
    customer_update: { address: 'auto', name: 'auto' },
    tax_id_collection: { enabled: true },
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { app: 'finova', plan: body.plan },
    subscription_data: { metadata: { app: 'finova', plan: body.plan } },
    client_reference_id: String(user.id),
    success_url: b.ORIGIN + '/?checkout=success&billing=1',
    cancel_url: b.ORIGIN + '/?checkout=cancel'
  }, { idempotencyKey });

  if (!created.url) {
    throw b.error(502, 'Stripe no devolvió un enlace de pago válido.');
  }

  return b.response(200, { url: created.url, test: !b.isLive() });
});
