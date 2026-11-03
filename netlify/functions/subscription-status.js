'use strict';
const b = require('../lib/billing');

exports.handler = (event) => b.run(event, 'GET', async () => {
  const stripe = b.client();
  await b.verifyAccount(stripe);
  const user = await b.user(event);
  const customer = await b.customerFor(stripe, user);

  if (!customer) {
    return b.response(200, { plan: 'free', status: 'inactive', cancellation_scheduled: false, cancel_at: null });
  }

  const data = await b.entitlement(stripe, customer.id);
  return b.response(200, {
    plan: data.plan,
    status: data.status,
    cancellation_scheduled: data.cancellation_scheduled,
    cancel_at: data.cancel_at,
    test: !b.isLive()
  });
});
