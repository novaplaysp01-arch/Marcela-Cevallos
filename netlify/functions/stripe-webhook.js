'use strict';

const b = require('../lib/billing');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return b.response(405, { error: 'Método no permitido.' });
  }

  let stripe;
  let stripeEvent;

  try {
    stripe = b.client();
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : event.body || '';
    const signature = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];

    if (!signature) {
      return b.response(400, { error: 'Falta la firma de Stripe.' });
    }

    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    // Invalid signatures are client errors; configuration or Stripe outages must
    // return 5xx so Stripe retries after the underlying problem is fixed.
    if (error?.type === 'StripeSignatureVerificationError') {
      return b.response(400, { error: 'Firma de Stripe no válida.' });
    }
    console.error('Stripe webhook initialization failed', error?.message || 'unknown error');
    return b.response(500, { error: 'No se pudo validar el evento de Stripe.' });
  }

  if (stripeEvent.livemode !== b.isLive()) {
    return b.response(400, { error: 'El evento no corresponde al entorno configurado.' });
  }

  if (!b.events.includes(stripeEvent.type)) {
    return b.response(200, { received: true, ignored: true });
  }

  try {
    await b.verifyAccount(stripe);

    const object = stripeEvent.data?.object;
    const customerId = typeof object?.customer === 'string'
      ? object.customer
      : object?.customer?.id;

    if (!customerId) {
      // Some asynchronous checkout events can arrive without a customer. There
      // is no account entitlement to sync, but the signed event is acknowledged.
      return b.response(200, { received: true, ignored: true });
    }

    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted || customer.metadata?.app !== 'finova' || !customer.metadata?.finova_user_id) {
      return b.response(200, { received: true, ignored: true });
    }

    if (
      stripeEvent.type.startsWith('checkout.session.') &&
      stripeEvent.type !== 'checkout.session.async_payment_failed' &&
      !['paid', 'no_payment_required'].includes(object.payment_status)
    ) {
      // Never grant access based on an unpaid or still-processing checkout.
      return b.response(200, { received: true, pending: true });
    }

    // Subscription status is re-read from Stripe; webhook payloads are only
    // notifications and are not trusted as the source of entitlement state.
    await b.syncCustomer(stripe, customerId);
    return b.response(200, { received: true });
  } catch (error) {
    console.error('Stripe webhook synchronization failed', error?.message || 'unknown error');
    // A non-2xx response makes Stripe retry transient failures.
    return b.response(500, { error: 'No se pudo sincronizar la suscripción.' });
  }
};
