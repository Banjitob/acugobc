const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const ordersRouter = require('./orders');

function validSignature(req) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !req.rawBody) return false;
  const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
  const received = String(req.headers['x-paystack-signature'] || '');
  if (!received || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// Paystack sends charge.success for successful transactions. This is a second,
// server-to-server finalization path so a buyer's browser is never the only thing
// responsible for creating the Bixcart order after money has been received.
router.post('/', async (req, res) => {
  try {
    if (!validSignature(req)) return res.status(401).json({ error: 'Invalid Paystack signature' });
    if (req.body?.event !== 'charge.success') return res.sendStatus(200);

    const reference = req.body?.data?.reference;
    const buyerId = req.body?.data?.metadata?.user_id;
    if (!reference || !buyerId) return res.sendStatus(200);

    try {
      await ordersRouter.finalizeCheckoutPayment({ payment_reference: reference, buyerId });
    } catch (e) {
      // Return 200 so Paystack does not endlessly retry an event that requires
      // a user-facing checkout recovery path (for example an expired intent).
      // The error is logged for reconciliation.
      console.error('[paystack-webhook] charge.success finalization failed:', reference, e.message);
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error('[paystack-webhook] fatal:', e.message);
    return res.sendStatus(200);
  }
});

module.exports = router;
