/**
 * Bixcart AI Sweep Job
 * Runs every 26 hours — scans all active listings and recent messages
 * for policy violations and flags anything suspicious.
 */

const { Listing, Conversation, Message, Order, User, BuyRequest } = require('../db/database');
const { moderateListing, moderateMessage } = require('./aiModerator');
const { notifyUser } = require('../db/push');
const { sendOrderRefundEmail } = require('./email');
const { listRefunds, createRefund } = require('./paystack');
const ordersRouter = require('../routes/orders');
const cancelOrderAndRefund = ordersRouter.cancelOrderAndRefund;
const fetch = require('node-fetch');

const SWEEP_INTERVAL_MS = 26 * 60 * 60 * 1000;
const BATCH_DELAY_MS    = 5000; // 5s between API calls = ~12/min, safely under limit

let sweepRunning = false;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Call Gemini directly — bypasses keyword filter (which already runs in real-time)
async function geminiCheck(text, type) {
  if (!process.env.GEMINI_API_KEY) return { flagged: false, reason: '', category: '' };
  const PROMPT = `You are moderating content on Bixcart, an ACU student marketplace.
Flag if content contains: social handles/phone numbers to bypass platform, prohibited items (weapons/drugs/stolen goods/porn), academic fraud (exam answers/runz/expo), sexual solicitation.
Do NOT flag: price negotiation, campus meetups, bank account details, normal conversation.
${type === 'listing' ? 'This is a LISTING (title + description).' : 'This is a CHAT MESSAGE.'}
Content: "${text.slice(0, 400)}"
Respond ONLY with JSON: {"flagged":true|false,"reason":"short reason or empty","category":"contact_bypass|prohibited_item|academic_fraud|adult_content or empty"}`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }] }],
        generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
      }),
    });
    if (!res.ok) { console.warn('[sweep] Gemini', res.status); return { flagged: false }; }
    const data   = await res.json();
    const raw    = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return { flagged: !!parsed.flagged, reason: parsed.reason || '', category: parsed.category || '' };
  } catch (e) { console.warn('[sweep] error:', e.message); return { flagged: false }; }
}



async function syncRefundStatuses() {
  const orders = await Order.find({
    payment_reference: { $ne: null },
    refund_status: { $in: ['pending', 'processing', 'needs-attention'] },
  }).limit(100).lean();

  for (const order of orders) {
    try {
      const refunds = await listRefunds({ transaction: order.payment_reference, perPage: 100 });
      const own = (Array.isArray(refunds) ? refunds : []).find(r =>
        String(r.merchant_note || '').includes(String(order._id))
      );
      if (!own) continue;

      const status = String(own.status);
      const update = { refund_status: status };
      if (own.id) update.refund_reference = String(own.id);
      if (status === 'processed') {
        update.payment_status = 'refunded';
        update.payout_status = 'refunded';
        update.refund_processed_at = own.refunded_at ? new Date(own.refunded_at) : new Date();
      } else if (status === 'failed') {
        update.refund_error = own.reason || own.message || 'Paystack refund failed';
      }
      await Order.findByIdAndUpdate(order._id, { $set: update });
    } catch (e) {
      console.error(`[refunds] Failed to sync ${order._id}:`, e.message);
    }
  }
}

async function retryFailedRefunds() {
  const orders = await Order.find({
    status: 'cancelled',
    payment_reference: { $ne: null },
    payment_status: 'paid',
    refund_status: 'pending',
  }).limit(50);
  if (!orders.length) return;

  for (const order of orders) {
    try {
      const existing = await listRefunds({ transaction: order.payment_reference, perPage: 100 });
      const own = (Array.isArray(existing) ? existing : []).find(r =>
        String(r.merchant_note || '').includes(String(order._id)) &&
        ['pending','processing','needs-attention','processed'].includes(String(r.status))
      );
      if (own) {
        order.refund_status = String(own.status);
        order.refund_reference = own.id ? String(own.id) : (own.refund_reference || null);
        if (own.status === 'processed') order.payment_status = 'refunded';
        await order.save();
        continue;
      }

      const refund = await createRefund({
        transaction: order.payment_reference,
        amount: order.amount,
        customer_note: `Bixcart refund retry for cancelled order ${order._id}`,
        merchant_note: `Bixcart order ${order._id} cancellation refund retry`,
      });

      order.refund_amount = Number(order.amount || 0);
      order.refund_reference = refund?.id ? String(refund.id) : (refund?.refund_reference || null);
      order.refund_status = ['pending','processing','needs-attention','processed'].includes(String(refund?.status)) ? String(refund.status) : 'pending';
      order.refund_error = '';
      order.refund_initiated_at = new Date();
      if (order.refund_status === 'processed') order.payment_status = 'refunded';
      await order.save();

      const listing = await Listing.findById(order.listing_id).select('title').lean();
      await notifyUser(String(order.buyer_id), {
        title: 'Refund initiated',
        body: `Your refund for ${listing?.title || 'your cancelled order'} has now been initiated by Paystack. It will be returned through the supported refund route.`,
        type: 'refund',
        url: `/pages/orders.html?id=${order._id}`,
      }).catch(() => {});

      const buyer = await User.findById(order.buyer_id).select('email full_name').lean();
      if (buyer?.email) {
        await sendOrderRefundEmail(buyer.email, {
          buyerName: buyer.full_name || 'buyer',
          listingTitle: listing?.title || 'your item',
          reason: 'Your refund is being processed and will be returned through the original payment method.',
          amount: order.amount,
          refundStatus: order.refund_status,
        }).catch(() => {});
      }
    } catch (e) {
      console.error(`[refund-retry] ${order._id}:`, e.message);
      await Order.findByIdAndUpdate(order._id, { $set: { refund_error: e.message || 'Refund retry failed' } }).catch(() => {});
    }
  }
}

async function sweepExpiredOrders() {
  const now = new Date();
  const responseExpired = await Order.find({
    status: 'paid',
    payment_status: 'paid',
    response_deadline_at: { $ne: null, $lt: now },
  }).limit(50);

  const deliveryExpired = await Order.find({
    status: { $in: ['confirmed', 'fulfilled', 'completing'] },
    payment_status: 'paid',
    delivery_deadline_at: { $ne: null, $lt: now },
  }).limit(50);

  const expired = [...responseExpired, ...deliveryExpired];
  if (!expired.length) return;
  console.log(`[orders] Found ${expired.length} expired order(s) requiring cancellation/refund`);

  for (const order of expired) {
    try {
      const reason = order.status === 'paid'
        ? 'Seller did not respond within the required 6-hour window.'
        : 'The seller missed the delivery deadline.';

      const result = await cancelOrderAndRefund(order, reason);
      const listing = await Listing.findById(order.listing_id).select('title').lean();
      const title = listing?.title || 'your order';

      await notifyUser(String(order.buyer_id), {
        title: 'Refund initiated',
        body: `Your payment for ${title} has been cancelled and a refund has been initiated. You will receive the funds back through the original payment method.` ,
        type: 'refund',
        url: `/pages/orders.html?id=${order._id}`,
      }).catch(() => {});

      await notifyUser(String(order.seller_id), {
        title: 'Order cancelled',
        body: `${title} was cancelled because the order deadline was missed.`,
        type: 'order',
        url: `/pages/messages.html?conv=${order._id}`,
      }).catch(() => {});

      if (result.initiated) {
        const buyer = await User.findById(order.buyer_id).select('email full_name').lean();
        if (buyer?.email) {
          await sendOrderRefundEmail(buyer.email, {
            buyerName: buyer.full_name || 'buyer',
            listingTitle: title,
            reason,
            amount: order.amount,
            refundStatus: order.refund_status,
          }).catch(() => {});
        }
      }
      console.log(`[orders] Cancelled/refund initiated for ${order._id} (${reason})`);
    } catch (e) {
      console.error(`[orders] Failed to cancel/refund ${order._id}:`, e.message);
      // Leave the order untouched so the next sweep can retry safely.
    }
  }
}

// Buy requests the seller never answered (still 'pending' past their
// response deadline), and requests the seller accepted but the buyer never
// paid for (past the payment deadline), both auto-expire. Nothing needs to
// be restored on the listing side — a pending/accepted request never
// reserved stock, since listings stay live/buyable the whole time.
async function sweepExpiredBuyRequests() {
  const now = new Date();
  const [pendingExpired, acceptedExpired] = await Promise.all([
    BuyRequest.find({ status: 'pending', response_deadline_at: { $ne: null, $lt: now } }).limit(100),
    BuyRequest.find({ status: 'accepted', payment_deadline_at: { $ne: null, $lt: now } }).limit(100),
  ]);
  const expired = [...pendingExpired, ...acceptedExpired];
  if (!expired.length) return;
  console.log(`[buy-requests] Found ${expired.length} expired request(s)`);

  for (const reqDoc of expired) {
    try {
      const wasAccepted = reqDoc.status === 'accepted';
      reqDoc.status = 'expired';
      await reqDoc.save();

      const listing = await Listing.findById(reqDoc.listing_id).select('title').lean();
      const title = listing?.title || 'this item';
      await notifyUser(String(reqDoc.buyer_id), {
        title: 'Buy request expired',
        body: wasAccepted
          ? `Your request for "${title}" expired because payment wasn't completed in time.`
          : `Your request for "${title}" expired because the seller didn't respond in time.`,
        type: 'order',
        url: `/pages/buyer-dashboard.html?tab=orders`,
      }).catch(() => {});
    } catch (e) {
      console.error(`[buy-requests] Failed to expire ${reqDoc._id}:`, e.message);
    }
  }
}

async function sweepListings() {
  const listings = await Listing.find({ status: 'active', ai_flagged: { $ne: true } })
    .select('_id title description category seller_id').lean();
  console.log(`[sweep] Checking ${listings.length} listings with Gemini…`);
  let flagged = 0;
  for (const l of listings) {
    const text   = `${l.title}. ${l.description}`;
    const result = await geminiCheck(text, 'listing');
    if (result.flagged) {
      flagged++;
      await Listing.findByIdAndUpdate(l._id, { $set: {
        status: 'flagged', ai_flagged: true,
        ai_flag_reason: `[Sweep] ${result.reason}`,
        ai_flag_category: result.category, ai_flagged_at: new Date(),
      }});
      notifyUser(String(l.seller_id), {
        title: '⚠️ Listing Hidden',
        body:  `"${l.title}" was flagged during routine AI sweep: ${result.reason}`,
        type:  'ai_flag',
      }).catch(() => {});
      console.log(`[sweep] Flagged listing "${l.title}": ${result.reason}`);
    }
    await sleep(BATCH_DELAY_MS);
  }
  console.log(`[sweep] Listings done — ${flagged}/${listings.length} flagged`);
}

async function sweepMessages() {
  const since = new Date(Date.now() - SWEEP_INTERVAL_MS * 1.1);
  const messages = await Message.find({
    created_at: { $gte: since },
    is_admin_notification: { $ne: true },
    triggered_ai_flag:     { $ne: true },
  }).populate({ path: 'conversation_id', select: 'ai_flagged buyer_id seller_id' }).lean();

  const toCheck = messages.filter(m => m.conversation_id && !m.conversation_id.ai_flagged);
  console.log(`[sweep] Checking ${toCheck.length} messages with Gemini…`);
  let flagged = 0;
  for (const m of toCheck) {
    const result = await geminiCheck(m.content, 'message');
    if (result.flagged) {
      flagged++;
      const conv = m.conversation_id;
      const { Conversation } = require('../db/database');
      await Promise.all([
        Conversation.findByIdAndUpdate(conv._id, { $set: {
          ai_flagged: true, ai_flag_reason: `[Sweep] ${result.reason}`,
          ai_flag_category: result.category, ai_flagged_at: new Date(),
        }}),
        Message.findByIdAndUpdate(m._id, { $set: { triggered_ai_flag: true } }),
      ]);
      [String(conv.buyer_id), String(conv.seller_id)].forEach(uid => {
        notifyUser(uid, {
          title: '⚠️ Conversation Flagged',
          body:  `A message was flagged during routine AI sweep: ${result.reason}`,
          type:  'ai_flag',
        }).catch(() => {});
      });
      console.log(`[sweep] Flagged message in conv ${conv._id}: ${result.reason}`);
    }
    await sleep(BATCH_DELAY_MS);
  }
  console.log(`[sweep] Messages done — ${flagged}/${toCheck.length} flagged`);
}

// ── Main sweep ────────────────────────────────────────────────────────────────
async function runSweep() {
  if (sweepRunning) { console.log('[sweep] Already running, skipping'); return; }
  sweepRunning = true;
  console.log(`[sweep] Starting AI sweep — ${new Date().toISOString()}`);
  try {
    await sweepExpiredOrders();
    await sweepListings();
    await sweepMessages();
    console.log(`[sweep] Sweep complete — ${new Date().toISOString()}`);
  } catch (e) {
    console.error('[sweep] Fatal error:', e.message);
  } finally {
    sweepRunning = false;
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────
function startSweepScheduler() {
  const ORDER_SWEEP_INTERVAL_MS = 60 * 1000;

  // Order deadlines are time-sensitive, so they run independently of Gemini.
  setTimeout(() => {
    sweepExpiredOrders().catch(e => console.error('[orders] Initial expiry sweep failed:', e.message));
    sweepExpiredBuyRequests().catch(e => console.error('[buy-requests] Initial expiry sweep failed:', e.message));
    syncRefundStatuses().catch(e => console.error('[refunds] Initial sync failed:', e.message));
    retryFailedRefunds().catch(e => console.error('[refund-retry] Initial retry failed:', e.message));
  }, 15 * 1000);
  setInterval(() => {
    sweepExpiredOrders().catch(e => console.error('[orders] Expiry sweep failed:', e.message));
    sweepExpiredBuyRequests().catch(e => console.error('[buy-requests] Expiry sweep failed:', e.message));
    syncRefundStatuses().catch(e => console.error('[refunds] Sync failed:', e.message));
    retryFailedRefunds().catch(e => console.error('[refund-retry] Retry failed:', e.message));
  }, ORDER_SWEEP_INTERVAL_MS);
  console.log('[orders] Deadline/refund scheduler started — checks every 60s');

  if (!process.env.GEMINI_API_KEY) {
    console.log('[sweep] GEMINI_API_KEY not set — AI sweep disabled');
    return;
  }

  setTimeout(runSweep, 2 * 60 * 1000);
  setInterval(runSweep, SWEEP_INTERVAL_MS);
  console.log(`[sweep] AI scheduler started — first sweep in 2 min, then every 26h`);
}

module.exports = { startSweepScheduler, runSweep };
