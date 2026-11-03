'use strict';
const b = require('../lib/billing');

exports.handler = (event) => b.run(event, 'POST', async () => {
  const stripe = b.client();
  await b.verifyAccount(stripe);
  const user = await b.user(event);
  const customer = await b.customerFor(stripe, user);

  if (!customer) {
    throw b.error(404, 'No existe un cliente de Stripe para esta cuenta.');
  }

  const data = await b.entitlement(stripe, customer.id);
  const portal = await stripe.billingPortal.sessions.create({
    customer: customer.id,
    return_url: b.ORIGIN + '/?billing=portal',
    metadata: { app: 'finova', finova_user_id: String(user.id), finova_plan: data.plan }
  });

  return b.response(200, {
    url: portal.url,
    plan: data.plan,
    status: data.status,
    cancellation_scheduled: data.cancellation_scheduled,
    cancel_at: data.cancel_at,
    test: !b.isLive()
  });
});
