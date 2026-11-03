'use strict';
const b = require('../lib/billing');

exports.handler = (event) => b.run(event, 'GET', async () => {
  try {
    const stripe = b.client();
    await b.verifyAccount(stripe);
    return b.response(200, { enabled: true, mode: b.mode() });
  } catch (e) {
    const allowed = [
      'disabled',
      'test_key_required',
      'webhook_secret_required',
      'sandbox_mismatch',
      'live_key_required',
      'live_portal_required',
      'live_charges_disabled'
    ];

    const reason = allowed.includes(e.code)
      ? e.code
      : e.type === 'StripeAuthenticationError'
        ? 'stripe_authentication_failed'
        : e.type === 'StripePermissionError'
          ? 'stripe_permissions_required'
          : 'stripe_connection_failed';

    return b.response(200, { enabled: false, mode: 'disabled', reason });
  }
});
