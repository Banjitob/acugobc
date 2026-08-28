const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Order, Listing, User, Conversation, SavedListing, CartItem, CheckoutIntent, BuyRequest, getSellerCommissionInfo } = require('../db/database');
const { authMiddleware, sellerApprovalMiddleware } = require('../middleware/auth');
const { notifyUser } = require('../db/push');
const { generateVerificationCode, verifyDeliveryCode } = require('../utils/deliveryCode');
const { createRefund, listRefunds, verifyTransaction, initializeTransaction } = require('../utils/paystack');
const { sendOrderSellerAlertEmail, sendOrderRefundEmail } = require('../utils/email');

const refundLocks = new Map();

async function withRefundLock(reference, fn) {
  const previous = refundLocks.get(reference) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  refundLocks.set(reference, current);
  await previous;
  try { return await fn(); } finally {
    release();
    if (refundLocks.get(reference) === current) refundLocks.delete(reference);
  }
}

async function initiateOrderRefund(order, reason) {
  if (!order.payment_reference || order.payment_status !== 'paid') {
    order.refund_status = 'not_required';
    order.payout_status = 'refunded';
    await order.save();
    return { initiated: false, skipped: true };
  }
  if (['pending','processing','needs-attention','processed'].includes(order.refund_status)) {
    return { initiated: order.refund_status !== 'processed', skipped: true, status: order.refund_status };
  }

  return withRefundLock(order.payment_reference, async () => {
    const fresh = await Order.findById(order._id);
    if (!fresh) throw new Error('Order disappeared while processing refund');
    if (['pending','processing','needs-attention','processed'].includes(fresh.refund_status)) return { initiated: false, skipped: true, status: fresh.refund_status };

    const [refunds, transaction] = await Promise.all([
      listRefunds({ transaction: fresh.payment_reference, perPage: 100 }),
      verifyTransaction(fresh.payment_reference),
    ]);
    const valid = new Set(['pending','processing','needs-attention','processed']);
    const existing = (Array.isArray(refunds) ? refunds : []).filter(r => valid.has(String(r.status)));
    const amountKobo = Math.round(Number(fresh.amount || 0) * 100);
    const transactionKobo = Number(transaction?.amount || 0);
    if (amountKobo <= 0 || transactionKobo <= 0) throw new Error('Invalid Paystack refund amount or transaction amount');

    const ownRefund = existing.find(r => String(r.merchant_note || '').includes(String(fresh._id)));
    if (ownRefund) {
      fresh.refund_amount = Number(ownRefund.amount || fresh.amount || 0) / 100;
      fresh.refund_reference = ownRefund.id ? String(ownRefund.id) : (ownRefund.refund_reference || null);
      fresh.refund_status = String(ownRefund.status);
      fresh.payment_status = fresh.refund_status === 'processed' ? 'refunded' : 'paid';
      fresh.payout_status = 'refunded';
      await fresh.save();
      Object.assign(order, fresh.toObject());
      return { initiated: false, skipped: true, status: fresh.refund_status };
    }

    const existingKobo = existing.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const remainingKobo = transactionKobo - existingKobo;
    if (remainingKobo < amountKobo) {
      throw new Error(`Refund amount exceeds the remaining refundable amount on Paystack transaction ${fresh.payment_reference}`);
    }
    let refund;
    try {
      refund = await createRefund({
        transaction: fresh.payment_reference,
        amount: fresh.amount,
        customer_note: `Bixcart refund for cancelled order ${fresh._id}`,
        merchant_note: `Bixcart order ${fresh._id} cancelled: ${reason}`,
      });
    } catch (error) {
      // Paystack refunds are funded from the merchant's Paystack balance/pending
      // payout. If that balance is temporarily insufficient, the order should
      // still be cancelled, but the refund must remain pending/failed rather than
      // falsely telling the buyer that a refund was initiated.
      fresh.refund_status = 'pending';
      fresh.refund_error = error.message || 'Paystack refund request failed';
      fresh.refund_amount = Number(fresh.amount || 0);
      fresh.payment_status = 'paid';
      fresh.payout_status = 'refunded';
      await fresh.save();
      Object.assign(order, fresh.toObject());
      return { initiated: false, pending: true, skipped: false, status: 'pending', error: fresh.refund_error };
    }
    fresh.refund_amount = Number(fresh.amount || 0);
    fresh.refund_reference = refund?.id ? String(refund.id) : (refund?.refund_reference || null);
    fresh.refund_status = ['pending','processing','needs-attention','processed'].includes(String(refund?.status)) ? String(refund.status) : 'pending';
    fresh.refund_error = '';
    fresh.refund_initiated_at = new Date();
    fresh.payout_status = 'refunded';
    fresh.payment_status = fresh.refund_status === 'processed' ? 'refunded' : 'paid';
    await fresh.save();
    Object.assign(order, fresh.toObject());
    return { initiated: true, status: fresh.refund_status, amount: fresh.refund_amount };
  });
}

async function cancelOrderAndRefund(order, reason) {
  const refund = await initiateOrderRefund(order, reason);
  order.status = 'cancelled';
  order.payout_status = 'refunded';
  if (order.payment_reference && refund.initiated) order.payment_status = order.refund_status === 'processed' ? 'refunded' : 'paid';
  await order.save();
  // Restore the one unit of stock this order consumed at creation time, and
  // bring the listing back onto the marketplace if it had been auto-marked
  // 'sold' because stock hit zero. A listing the seller separately deleted
  // or that AI-flagged is left alone.
  const listing = await Listing.findById(order.listing_id);
  if (listing && !['deleted', 'flagged'].includes(listing.status)) {
    listing.stock_quantity = Math.max(0, Number(listing.stock_quantity || 0)) + 1;
    listing.status = 'active';
    await listing.save();
  }
  return refund;
}

// GET /api/orders/stats  — before /:id
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const [listings, orders, seller] = await Promise.all([
      Listing.find({ seller_id: uid, status: { $ne: 'deleted' } }).lean(),
      Order.find({ seller_id: uid }).lean(),
      User.findById(uid).select('successful_sales_count commission_tier commission_percent').lean(),
    ]);
    const commission = getSellerCommissionInfo(Number(seller?.successful_sales_count || 0));
    res.json({
      total_listings:  listings.length,
      active_listings: listings.filter(l => l.status === 'active').length,
      sold_listings:   listings.filter(l => l.status === 'sold').length,
      total_revenue:   orders.filter(o => o.status === 'completed').reduce((s, o) => s + (o.amount || 0), 0),
      total_views:     listings.reduce((s, l) => s + (l.views || 0), 0),
      total_saved:     listings.reduce((s, l) => s + (l.saves || 0), 0),
      pending_orders:  orders.filter(o => o.status === 'pending').length,
      commission_tier: commission.level,
      commission_percent: commission.commission_percent,
      successful_sales_count: commission.sales_count,
      progress_to_next: commission.progress_to_next,
      remaining_sales_to_next: commission.remaining_sales_to_next,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/saved
router.get('/saved', authMiddleware, async (req, res) => {
  try {
    const saved = await SavedListing
      .find({ user_id: req.user.id })
      .populate({ path: 'listing_id', populate: { path: 'seller_id', select: 'full_name university rating' } })
      .sort({ created_at: -1 }).lean();

    const results = saved
      .filter(s => s.listing_id && s.listing_id.status !== 'deleted')
      .map(s => {
        const l = s.listing_id;
        return {
          ...l, id: l._id,
          seller_name:       l.seller_id?.full_name,
          seller_university: l.seller_id?.university,
          seller_rating:     l.seller_id?.rating,
        };
      });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/buying
router.get('/buying', authMiddleware, async (req, res) => {
  try {
    const orders = await Order
      .find({ buyer_id: req.user.id })
      .populate('listing_id', 'title images category')
      .populate('seller_id',  'full_name university')
      .sort({ created_at: -1 }).lean();

    res.json(orders.map(o => {
      // delivery_code is deliberately left out — it's for the seller to hand over
      // in person, not something the buyer should be able to read from the app
      const { delivery_code, ...safe } = o;
      return {
        ...safe, id: o._id,
        listing_title:    o.listing_id?.title,
        listing_images:   o.listing_id?.images || [],
        category:         o.listing_id?.category,
        seller_id:        o.seller_id?._id || o.seller_id,
        seller_name:      o.seller_id?.full_name,
        seller_university:o.seller_id?.university,
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/selling
router.get('/selling', sellerApprovalMiddleware, async (req, res) => {
  try {
    // The listing owner is the source of truth for seller ownership. Include
    // both the direct seller_id and any legacy orders whose seller_id may be
    // stale, then deduplicate by order id. This keeps paid orders visible even
    // if an older checkout wrote incomplete seller ownership data.
    const sellerId = String(req.user.id);
    const sellerListings = await Listing.find({ seller_id: req.user.id }).select('_id').lean();
    const listingIds = sellerListings.map(l => l._id);

    const orders = await Order
      .find({ $or: [
        { seller_id: req.user.id },
        ...(listingIds.length ? [{ listing_id: { $in: listingIds } }] : []),
      ] })
      .populate('listing_id', 'title images category seller_id')
      .populate('buyer_id',   'full_name university')
      .sort({ created_at: -1 }).lean();

    const seen = new Set();
    const sellerOrders = orders.filter(o => {
      const id = String(o._id);
      if (seen.has(id)) return false;
      seen.add(id);
      // Never expose another seller's order just because an order's listing
      // query matched accidentally. Ownership is checked against the listing.
      const listingOwner = o.listing_id?.seller_id ? String(o.listing_id.seller_id) : null;
      return String(o.seller_id) === sellerId || listingOwner === sellerId;
    });

    res.json(sellerOrders.map(o => ({
      ...o, id: o._id,
      listing_title:   o.listing_id?.title,
      listing_images:  o.listing_id?.images || [],
      category:        o.listing_id?.category,
      buyer_id:        o.buyer_id?._id || o.buyer_id,
      buyer_name:      o.buyer_id?.full_name,
      buyer_university:o.buyer_id?.university,
    })));
  } catch (e) {
    console.error('[orders/selling] failed:', e);
    res.status(500).json({ error: e.message || 'Could not load seller orders' });
  }
});

// POST /api/orders — retired. Buyers can no longer create an order directly;
// they must go through /api/buy-requests so the seller accepts before any
// payment happens. Kept as a 410 (not removed) in case anything old still
// calls it, so the failure is loud and explicit rather than silently
// bypassing seller acceptance.
router.post('/', authMiddleware, async (req, res) => {
  res.status(410).json({ error: 'Direct order creation is no longer supported. Use /api/buy-requests to request an item — the seller must accept before you can pay.' });
});

// POST /api/orders/initialize-payment — retired for the same reason as above.
// Paying from the cart directly, with no seller acceptance step, would let a
// buyer bypass the seller's accept/decline entirely. Payment now only ever
// starts from an accepted buy request — see POST
// /api/buy-requests/:group/initialize-payment, which builds the exact same
// server-controlled Paystack split this endpoint used to.
router.post('/initialize-payment', authMiddleware, async (req, res) => {
  res.status(410).json({ error: 'Paying directly from the cart is no longer supported. Send a buy request first — the seller must accept it before you can pay.' });
});

// Shared, reusable builder for a Paystack split checkout. This is the exact
// logic the old direct-cart /initialize-payment route used to run inline;
// it's now a plain function so routes/buyRequests.js can call it once a
// seller has accepted, instead of duplicating payment-critical code.
//
// `listings` — array of populated Listing documents the buyer is paying for
// (already validated as active/in-stock/etc by the caller).
// `deliveryContact` — { full_name, phone, note }.
// `source` — 'cart' (legacy) or 'buy_request'.
// `buyRequestGroup` — the BuyRequest.request_group these listings came from, if any.
// Returns { reference, authorization_url, access_code }. Throws on failure —
// callers are responsible for turning that into an HTTP response.
async function buildSplitCheckoutSession({ buyerId, buyerEmail, deliveryContact, listings, source = 'cart', buyRequestGroup = null, req }) {
  if (!deliveryContact?.full_name || !deliveryContact?.phone)
    throw Object.assign(new Error('Full name and phone number are required'), { status: 400 });

  const checkoutDelivery = {
    full_name: String(deliveryContact.full_name).trim(),
    phone: String(deliveryContact.phone).trim(),
    campus: 'Ajayi Crowther University',
    note: String(deliveryContact.note || '').trim(),
  };

  if (!listings.length) throw Object.assign(new Error('Nothing to pay for'), { status: 400 });

  const sellerIds = [...new Set(listings.map(l => String(l.seller_id)))];
  const sellers = await User.find({ _id: { $in: sellerIds } })
    .select('full_name email phone role seller_approval_status successful_sales_count paystack_subaccount_code')
    .lean();
  const sellerMap = new Map(sellers.map(s => [String(s._id), s]));

  for (const sid of sellerIds) {
    const seller = sellerMap.get(sid);
    if (!seller || seller.role !== 'seller' || seller.seller_approval_status !== 'approved')
      throw Object.assign(new Error('One or more sellers are not approved yet.'), { status: 409 });
    if (!seller.paystack_subaccount_code)
      throw Object.assign(new Error('One or more sellers have not connected a Paystack payment account yet.'), { status: 409 });
  }

  const totalKobo = Math.round(listings.reduce((sum, l) => sum + Number(l.price || 0), 0) * 100);
  if (totalKobo <= 0) throw Object.assign(new Error('Invalid checkout total'), { status: 400 });

  const grouped = new Map();
  for (const listing of listings) {
    const amount = Number(listing.price || 0);
    const sid = String(listing.seller_id);
    if (!grouped.has(sid)) grouped.set(sid, { amount: 0, seller: sellerMap.get(sid), listing_ids: [] });
    const g = grouped.get(sid);
    g.amount += amount;
    g.listing_ids.push(String(listing._id));
  }

  // Flat shares preserve each seller's exact 7%→5.5% commission even when
  // one checkout contains sellers on different tiers. Paystack keeps the
  // remainder in Bixcart's main account. bearer_type=all makes Bixcart and
  // participating seller accounts share Paystack's processing fee.
  const splitSubaccounts = [];
  const intentItems = [];
  for (const [sid, g] of grouped.entries()) {
    const commission = getSellerCommissionInfo(Number(g.seller.successful_sales_count || 0));
    const sellerShareKobo = Math.max(0, Math.round(g.amount * 100 * (1 - commission.commission_percent / 100)));
    splitSubaccounts.push({ subaccount: g.seller.paystack_subaccount_code, share: sellerShareKobo });
    intentItems.push({
      seller_id: sid,
      listing_ids: g.listing_ids,
      amount: Number(g.amount.toFixed(2)),
      commission_percent: commission.commission_percent,
      commission_amount: Number((g.amount * commission.commission_percent / 100).toFixed(2)),
      seller_share_kobo: sellerShareKobo,
    });
  }

  const reference = 'bixcart_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  const intent = await CheckoutIntent.create({
    reference,
    buyer_id: buyerId,
    expected_total_kobo: totalKobo,
    delivery_address: checkoutDelivery,
    items: intentItems,
    expires_at: new Date(Date.now() + 30 * 60 * 1000),
    source,
    buy_request_group: buyRequestGroup,
  });

  try {
    const appUrl = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
    const payment = await initializeTransaction({
      email: buyerEmail,
      amount: totalKobo,
      currency: 'NGN',
      reference,
      callback_url: `${appUrl}/pages/checkout.html?payment=success&reference=${encodeURIComponent(reference)}`,
      metadata: { user_id: String(buyerId), checkout_intent_id: String(intent._id), item_count: listings.length },
      split: {
        type: 'flat',
        bearer_type: 'all',
        subaccounts: splitSubaccounts,
        reference: `split_${reference}`,
      },
    });
    return { reference, authorization_url: payment.authorization_url, access_code: payment.access_code };
  } catch (e) {
    await CheckoutIntent.deleteOne({ _id: intent._id }).catch(() => {});
    throw e;
  }
}

router.buildSplitCheckoutSession = buildSplitCheckoutSession;

// Finalize a Paystack checkout exactly once. This is shared by the browser callback
// and the Paystack webhook so a successful payment cannot get stuck just because the
// buyer's browser failed to call /checkout.
async function finalizeCheckoutPayment({ payment_reference, buyerId }) {
  const intent = await CheckoutIntent.findOne({ reference: payment_reference, buyer_id: buyerId });
  if (!intent) throw new Error('Payment session not found');
  if (intent.expires_at < new Date() && !intent.used_at) throw new Error('Payment session expired. Please start checkout again.');

  // Idempotency: if the webhook/callback already created the orders, return them.
  const existingOrders = await Order.find({ payment_reference, buyer_id: buyerId }).lean();
  if (existingOrders.length) {
    if (!intent.used_at) {
      intent.used_at = new Date();
      await intent.save();
    }
    return {
      checkout_group: existingOrders[0].checkout_group,
      order_count: existingOrders.length,
      total: existingOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0),
      orders: existingOrders.map(o => ({ ...o, id: o._id })),
      already_finalized: true,
    };
  }

  const transaction = await verifyTransaction(payment_reference);
  if (!transaction || transaction.status !== 'success') throw new Error('Payment not verified');

  // For a normal Bixcart checkout, the actual amount charged must equal the
  // immutable amount that Bixcart requested. `requested_amount` is useful for
  // diagnostics, but the security check must use the actual charged `amount`.
  const chargedKobo = Number(transaction.amount || 0);
  const expectedKobo = Number(intent.expected_total_kobo || 0);
  if (!Number.isFinite(chargedKobo) || chargedKobo !== expectedKobo) {
    console.error('[checkout] Payment amount mismatch', {
      reference: payment_reference,
      expected_kobo: expectedKobo,
      charged_kobo: transaction.amount,
      requested_kobo: transaction.requested_amount,
    });
    throw new Error('Payment amount does not match the checkout total');
  }

  const listingIds = intent.items.flatMap(i => i.listing_ids || []);
  const listings = await Listing.find({ _id: { $in: listingIds }, status: 'active', stock_quantity: { $gte: 1 } }).lean();
  if (listings.length !== listingIds.length) {
    await createRefund({
      transaction: payment_reference,
      amount: Number(intent.expected_total_kobo) / 100,
      customer_note: 'Bixcart checkout could not be completed because an item became unavailable.',
      merchant_note: `Bixcart automatic full refund for checkout ${intent._id}`,
    });
    throw new Error('One or more items became unavailable. Your refund has been initiated automatically.');
  }

  const listingMap = new Map(listings.map(l => [String(l._id), l]));
  const checkout_group = uuidv4();
  const deliveryCode = generateVerificationCode();
  const ordersToCreate = [];
  for (const item of intent.items) {
    for (const listingId of item.listing_ids) {
      const listing = listingMap.get(String(listingId));
      const amount = Number(listing.price || 0);
      const deliveryMinutes = { '5m': 5, '6h': 360, '12h': 720, '1d': 1440, '3d': 4320, '7d': 10080 }[listing.delivery_window || '1d'] || 1440;
      // Under the new flow every checkout is 'buy_request'-sourced, meaning the
      // seller already accepted this exact listing before the buyer paid — so
      // the order can go straight to 'confirmed' and skip the old post-payment
      // "seller must accept within 6h" step entirely. `source:'cart'` is kept
      // only so any CheckoutIntent still in flight from before this change
      // finalizes the same way it always did (harmless, since the direct-pay
      // route that created those intents is now retired and creates no more).
      const preAccepted = intent.source === 'buy_request';
      ordersToCreate.push({
        listing_id: listing._id, buyer_id: buyerId, seller_id: listing.seller_id, amount,
        status: preAccepted ? 'confirmed' : 'paid', delivery_code: deliveryCode,
        delivery_code_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        response_deadline_at: preAccepted ? null : new Date(Date.now() + 6 * 60 * 60 * 1000),
        seller_accepted_at: preAccepted ? new Date() : null,
        delivery_deadline_at: new Date(Date.now() + deliveryMinutes * 60 * 1000),
        platform_fee_percent: item.commission_percent,
        platform_fee_amount: Number((amount * item.commission_percent / 100).toFixed(2)),
        seller_payout_amount: Number((amount * (1 - item.commission_percent / 100)).toFixed(2)),
        checkout_group, fulfillment: 'delivery', delivery_address: intent.delivery_address,
        delivery_fee: 0, payment_method: 'card', payment_status: 'paid', payment_reference,
        processing_fee_amount: 0, seller_processing_fee_share: 0,
      });
    }
  }

  // Protect against a second finalization racing the first one.
  const alreadyUsed = await User.findOne({ used_payment_refs: payment_reference });
  if (alreadyUsed && String(alreadyUsed._id) === String(buyerId)) {
    const raced = await Order.find({ payment_reference, buyer_id: buyerId }).lean();
    if (raced.length) {
      intent.used_at = intent.used_at || new Date();
      await intent.save();
      return {
        checkout_group: raced[0].checkout_group,
        order_count: raced.length,
        total: raced.reduce((sum, o) => sum + Number(o.amount || 0), 0),
        orders: raced.map(o => ({ ...o, id: o._id })),
        already_finalized: true,
      };
    }
    throw new Error('Payment reference already used');
  }

  let orders;
  const decrementedListingIds = [];
  try {
    orders = await Order.insertMany(ordersToCreate);
    // Each order consumes exactly one unit of stock from its listing. Only
    // mark the listing 'sold' once stock is actually exhausted — otherwise
    // it stays 'active' so buyers can keep purchasing remaining units.
    for (const listingId of listingIds) {
      const updated = await Listing.findByIdAndUpdate(
        listingId,
        { $inc: { stock_quantity: -1 } },
        { new: true }
      );
      decrementedListingIds.push(listingId);
      if (updated && updated.stock_quantity <= 0) {
        await Listing.findByIdAndUpdate(listingId, { $set: { status: 'sold', stock_quantity: 0 } });
      }
    }
  } catch (creationError) {
    await createRefund({
      transaction: payment_reference,
      amount: Number(intent.expected_total_kobo) / 100,
      customer_note: 'Bixcart could not complete your order after payment.',
      merchant_note: `Bixcart automatic full refund for checkout ${intent._id}: ${creationError.message}`,
    }).catch(() => {});
    await Order.deleteMany({ _id: { $in: orders?.map(o => o._id) || [] } }).catch(() => {});
    // Restore stock for any listing we did manage to decrement before the failure.
    for (const listingId of decrementedListingIds) {
      await Listing.findByIdAndUpdate(listingId, { $inc: { stock_quantity: 1 }, $set: { status: 'active' } }).catch(() => {});
    }
    throw creationError;
  }

  // If this checkout came from accepted buy requests, mark them paid and
  // link each to the order it produced, so they stop showing as "awaiting
  // payment" anywhere in the UI.
  if (intent.source === 'buy_request' && intent.buy_request_group) {
    await BuyRequest.updateMany(
      { request_group: intent.buy_request_group, buyer_id: buyerId, status: 'accepted' },
      { $set: { status: 'paid' } }
    ).catch(() => {});
    for (const order of orders) {
      await BuyRequest.updateOne(
        { request_group: intent.buy_request_group, buyer_id: buyerId, listing_id: order.listing_id },
        { $set: { order_id: order._id } }
      ).catch(() => {});
    }
  }

  await CartItem.deleteMany({ user_id: buyerId, listing_id: { $in: listingIds } });
  await User.findByIdAndUpdate(buyerId, { $addToSet: { used_payment_refs: payment_reference } });
  intent.used_at = new Date();
  await intent.save();

  const buyer = await User.findById(buyerId).select('full_name email').lean();
  for (const order of orders) {
    // Always derive the notification recipient from the listing owner. Never use
    // the buyer email for the seller-sale email, even if an old/corrupt order has
    // incorrect seller_id data.
    const listing = await Listing.findById(order.listing_id).select('title delivery_window seller_id').lean();
    const sellerId = listing?.seller_id ? String(listing.seller_id) : String(order.seller_id);
    const seller = await User.findById(sellerId).select('email full_name').lean();

    // A buyer must never receive the seller's "you received a sale" email.
    if (!seller?.email || String(seller._id) === String(buyerId) || seller.email.toLowerCase() === String(buyer?.email || '').toLowerCase()) {
      console.error('[order-email] Refusing seller email because recipient resolves to buyer or is missing', {
        order_id: String(order._id), seller_id: sellerId, buyer_id: String(buyerId),
      });
    } else {
      await notifyUser(sellerId, {
        title: 'Payment received',
        body: 'A buyer has paid for your item. Please fulfil the order and share the delivery details.',
        type: 'order', url: `/pages/seller-dashboard.html?tab=orders&order=${order._id}`,
      }).catch(() => {});
      await sendOrderSellerAlertEmail(seller.email, {
        buyerName: buyer?.full_name || 'A buyer',
        listingTitle: listing?.title || 'your item',
        orderId: String(order._id),
        deliveryWindow: listing?.delivery_window || '1d',
        amount: order.amount,
      }).catch(err => console.error('[email] seller sale alert failed:', err.message));
    }
  }

  return {
    checkout_group,
    order_count: orders.length,
    total: orders.reduce((sum, o) => sum + o.amount, 0),
    orders: orders.map(o => ({ ...o.toObject(), id: o._id })),
    already_finalized: false,
  };
}

// POST /api/orders/checkout — finalizes a verified Paystack payment using the
// server-created checkout intent. This endpoint is idempotent.
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    const { payment_reference } = req.body;
    if (!payment_reference) return res.status(400).json({ error: 'payment_reference is required' });
    const result = await finalizeCheckoutPayment({ payment_reference, buyerId: req.user.id });
    res.json(result);
  } catch (e) {
    console.error('[checkout] Exception:', e.message);
    res.status(400).json({ error: e.message || 'Could not finalize payment' });
  }
});

router.finalizeCheckoutPayment = finalizeCheckoutPayment;

// PUT /api/orders/:id/status
router.put('/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const role = String(order.seller_id) === String(req.user.id) ? 'seller'
               : String(order.buyer_id)  === String(req.user.id) ? 'buyer' : null;
    if (!role) return res.status(403).json({ error: 'Forbidden' });

    const valid = {
      seller: { pending: ['confirmed','cancelled'], confirmed: ['completed','cancelled'] },
      buyer:  { pending: ['cancelled'] },
    };
    if (!valid[role]?.[order.status]?.includes(status))
      return res.status(400).json({ error: 'Invalid status transition' });

    if (status === 'cancelled') {
      const reason = role === 'seller' ? 'The seller cancelled the order.' : 'The buyer cancelled the order.';
      const refund = await cancelOrderAndRefund(order, reason);
      const buyer = await User.findById(order.buyer_id).select('email full_name').lean();
      const listing = await Listing.findById(order.listing_id).select('title').lean();
      await notifyUser(String(order.buyer_id), {
        title: refund.initiated ? 'Refund initiated' : 'Refund processing',
        body: refund.initiated
          ? `Your payment for ${listing?.title || 'this order'} has been cancelled and a refund has been initiated. You will receive the funds back through the original payment method.`
          : `Your order for ${listing?.title || 'this item'} has been cancelled. Your refund is being processed and will be returned through the original payment method.`,
        type: 'refund',
        url: `/pages/orders.html?id=${order._id}`,
      }).catch(() => {});
      if (refund.initiated && buyer?.email) {
        await sendOrderRefundEmail(buyer.email, {
          buyerName: buyer.full_name || 'buyer',
          listingTitle: listing?.title || 'your item',
          reason,
          amount: order.amount,
          refundStatus: order.refund_status,
        }).catch(() => {});
      }
    } else {
      // Stock for this listing was already decremented (and marked 'sold' if
      // exhausted) when the order was created — completion doesn't touch it again.
      await Order.findByIdAndUpdate(req.params.id, { $set: { status } });
    }

    res.json({ success: true, status: 'cancelled' === status ? 'cancelled' : status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/mark-complete — buyer or seller marks their side done
router.post('/:id/mark-complete', authMiddleware, async (req, res) => {
  try {
    const uid   = req.user.id;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const isBuyer  = String(order.buyer_id)  === String(uid);
    const isSeller = String(order.seller_id) === String(uid);
    if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Forbidden' });

    // Only allow for confirmed orders
    if (!['confirmed', 'completing'].includes(order.status))
      return res.status(400).json({ error: 'Order must be confirmed before marking complete' });

    const update = {};
    if (isBuyer)  update.buyer_marked_complete  = true;
    if (isSeller) update.seller_marked_complete = true;

    // If both sides have now marked complete → finalize
    const buyerDone  = isBuyer  ? true : order.buyer_marked_complete;
    const sellerDone = isSeller ? true : order.seller_marked_complete;

    if (buyerDone && sellerDone) {
      update.status = 'completed';
      // Stock was already decremented (and marked 'sold' if exhausted) when
      // this order was created — completion doesn't touch listing stock again.
    } else {
      update.status = 'completing'; // waiting for the other side
    }

    const updated = await Order.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    res.json({ ...updated.toObject(), id: updated._id, needs_rating: isBuyer && buyerDone && sellerDone });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/:id/delivery-verification
router.get('/:id/delivery-verification', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const isBuyer = String(order.buyer_id) === String(req.user.id);
    const isSeller = String(order.seller_id) === String(req.user.id);
    if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Forbidden' });
    res.json({
      id: order._id,
      status: order.status,
      verification_code: isSeller ? order.delivery_code : undefined,
      seller_share: order.seller_payout_amount,
      platform_fee_amount: order.platform_fee_amount,
      delivered_at: order.delivered_at,
      expires_at: order.delivery_code_expires_at,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/accept
router.post('/:id/accept', sellerApprovalMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.seller_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the seller can accept this order' });
    if (order.status === 'cancelled' || false)
      return res.status(400).json({ error: 'This order can no longer be accepted' });
    if (new Date(order.response_deadline_at || Date.now()) < new Date())
      return res.status(400).json({ error: 'This order expired because the seller did not respond in time' });

    const listing = await Listing.findById(order.listing_id).select('delivery_window').lean();
    const deliveryMinutes = { '5m': 5, '6h': 6 * 60, '12h': 12 * 60, '1d': 24 * 60, '3d': 72 * 60, '7d': 7 * 24 * 60 }[listing?.delivery_window || '1d'] || 24 * 60;
    order.status = 'confirmed';
    order.seller_accepted_at = new Date();
    order.delivery_deadline_at = new Date(Date.now() + 1000 * 60 * deliveryMinutes);
    await order.save();

    await notifyUser(String(order.buyer_id), {
      title: 'Seller accepted your order',
      body: 'The seller accepted your item request. Delivery or pickup must happen within the listed timeframe.',
      type: 'order',
      url: `/pages/messages.html?conv=${order._id}`,
    }).catch(() => {});

    res.json({ success: true, order: { ...order.toObject(), id: order._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/:id/delivery-info
// Seller uses this before handing over an order. If both parties are registered
// at the same hostel, expose that fact; otherwise route them into an order-specific chat.
router.get('/:id/delivery-info', sellerApprovalMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.seller_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the seller can get delivery info' });
    if (!['confirmed', 'fulfilled'].includes(order.status))
      return res.status(400).json({ error: 'Accept the order before getting delivery info' });
    if (order.status === 'cancelled')
      return res.status(400).json({ error: 'This order is no longer active' });
    if (order.delivery_deadline_at && new Date(order.delivery_deadline_at) < new Date())
      return res.status(400).json({ error: 'This order missed the delivery deadline and will be refunded automatically' });

    const [seller, buyer, listing] = await Promise.all([
      User.findById(order.seller_id).select('full_name seller_location_type hostel_name room_number shop_name shop_number shop_address delivery_info').lean(),
      User.findById(order.buyer_id).select('full_name hostel_name room_number location').lean(),
      Listing.findById(order.listing_id).select('title').lean(),
    ]);
    if (!seller || !buyer) return res.status(404).json({ error: 'Delivery participants could not be found' });

    const sellerHostel = String(seller.hostel_name || '').trim().toLowerCase();
    const buyerHostel = String(buyer.hostel_name || '').trim().toLowerCase();
    const sameHostel = seller.seller_location_type === 'hostel' && !!sellerHostel && !!buyerHostel && sellerHostel === buyerHostel;

    if (sameHostel) {
      return res.json({
        mode: 'same_hostel',
        message: `You and ${buyer.full_name || 'the buyer'} are in the same hostel (${seller.hostel_name}).`,
        seller: { name: seller.full_name, hostel: seller.hostel_name, room: seller.room_number || '', delivery_info: seller.delivery_info || '' },
        buyer: { name: buyer.full_name, hostel: buyer.hostel_name, room: buyer.room_number || '' },
        listing_title: listing?.title || '',
      });
    }

    const pair = { listing_id: order.listing_id, buyer_id: order.buyer_id, seller_id: order.seller_id, txn_status: 'pending' };
    let conversation = await Conversation.findOne(pair).sort({ last_message_at: -1 });
    if (!conversation) conversation = await Conversation.create({ listing_id: order.listing_id, buyer_id: order.buyer_id, seller_id: order.seller_id, txn_status: 'pending' });

    await notifyUser(String(order.buyer_id), {
      title: 'Delivery chat opened',
      body: 'The seller needs to arrange delivery with you. Open the chat to coordinate the handoff.',
      type: 'message',
      tag: `delivery-${order._id}`,
      url: `/pages/messages.html?conv=${conversation._id}`,
    }).catch(() => {});

    return res.json({
      mode: 'delivery_chat',
      message: 'You and the buyer are not in the same hostel. The buyer’s checkout delivery information is shown below. Use the delivery chat to arrange the handoff.',
      conversation_id: conversation._id,
      buyer: { name: buyer.full_name, hostel: buyer.hostel_name || '', room: buyer.room_number || '', delivery_address: order.delivery_address || null },
      chat_url: `/pages/messages.html?conv=${conversation._id}`,
      listing_title: listing?.title || '',
    });
  } catch (e) {
    console.error('[delivery-info] error:', e);
    res.status(500).json({ error: e.message || 'Could not get delivery info' });
  }
});

// POST /api/orders/:id/mark-shipped
router.post('/:id/mark-shipped', sellerApprovalMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.seller_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the seller can mark this order as shipped' });
    if (order.status === 'cancelled')
      return res.status(400).json({ error: 'This order can no longer be updated' });
    if (order.delivery_deadline_at && new Date(order.delivery_deadline_at) < new Date()) {
      return res.status(400).json({ error: 'This order missed the delivery deadline and will be refunded automatically' });
    }

    order.status = 'fulfilled';
    order.delivered_at = new Date();
    await order.save();

    await notifyUser(String(order.buyer_id), {
      title: 'Seller has fulfilled your order',
      body: 'The seller has marked the order as fulfilled. Enter the delivery verification code to complete the order.',
      type: 'order',
      url: `/pages/messages.html?conv=${order._id}`,
    }).catch(() => {});

    res.json({ success: true, order: { ...order.toObject(), id: order._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/confirm-delivery
router.post('/:id/confirm-delivery', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.buyer_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the buyer can confirm delivery' });
    if (order.status !== 'fulfilled')
      return res.status(400).json({ error: 'The seller has not marked this order as fulfilled yet' });
    if (!order.delivery_code) return res.status(400).json({ error: 'No delivery verification code is attached to this order' });
    if (order.status === 'cancelled' || order.status === 'completed')
      return res.status(409).json({ error: 'This order is no longer active' });
    if (order.delivery_deadline_at && new Date(order.delivery_deadline_at) < new Date())
      return res.status(400).json({ error: 'This order missed its delivery deadline and must be refunded automatically' });
    if (!verifyDeliveryCode(code, order.delivery_code))
      return res.status(400).json({ error: 'Verification code is incorrect' });

    order.status = 'completed';
    order.completed_at = new Date();
    order.buyer_marked_complete = true;
    order.seller_marked_complete = true;
    // The seller's share was already allocated by Paystack's split at checkout.
    // There is no second payout/transfer when delivery is confirmed.
    order.payout_status = 'split';
    await order.save();

    // Stock was already decremented (and the listing marked 'sold' if that
    // exhausted it) when this order was created — completion doesn't need to
    // touch listing stock again.

    const sellerUser = await User.findById(order.seller_id);
    if (sellerUser) {
      const completedSales = Number(sellerUser.successful_sales_count || 0) + 1;
      const commissionInfo = getSellerCommissionInfo(completedSales);
      sellerUser.successful_sales_count = completedSales;
      sellerUser.commission_tier = commissionInfo.level;
      sellerUser.commission_percent = commissionInfo.commission_percent;
      await sellerUser.save();
    }

    await notifyUser(String(order.seller_id), {
      title: 'Order completed',
      body: `The buyer confirmed delivery. Your ₦${Number(order.seller_payout_amount || 0).toLocaleString('en-NG')} seller share was allocated through Paystack Split at checkout.`,
      type: 'order',
      url: `/pages/messages.html?conv=${order._id}`,
    }).catch(() => {});

    res.json({
      success: true,
      settlement_status: 'split',
      seller_share: Number(order.seller_payout_amount || 0),
      platform_fee_amount: Number(order.platform_fee_amount || 0),
      order: { ...order.toObject(), id: order._id },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/resolve — buyer or seller marks deal as completed or cancelled from chat bubble
router.post('/:id/resolve', authMiddleware, async (req, res) => {
  try {
    const uid   = req.user.id;
    const { outcome } = req.body; // 'completed' or 'cancelled'
    if (!['completed','cancelled'].includes(outcome))
      return res.status(400).json({ error: 'outcome must be completed or cancelled' });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const isBuyer  = String(order.buyer_id)  === String(uid);
    const isSeller = String(order.seller_id) === String(uid);
    if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Forbidden' });

    if (order.status === 'completed' || order.status === 'cancelled')
      return res.status(400).json({ error: `Order already ${order.status}` });

    // Paystack-paid orders must be completed through
    // confirm-delivery so the verification code is actually checked — otherwise
    // either side could mark "completed" here and skip verification entirely.
    if (outcome === 'completed' && order.payment_reference)
      return res.status(400).json({ error: 'This order needs the delivery code to be confirmed — use "Verify delivery code" instead' });

    const update = { status: outcome };
    if (outcome === 'completed') update.payout_status = 'split';
    if (outcome === 'completed') {
      update.buyer_marked_complete  = true;
      update.seller_marked_complete = true;
      update.completed_at = new Date();
      update.platform_fee_amount = order.platform_fee_amount || Number((order.amount * 0.07).toFixed(2));
      update.seller_payout_amount = Number((order.amount - (update.platform_fee_amount || 0)).toFixed(2));
      await Listing.findByIdAndUpdate(order.listing_id, { $set: { status: 'sold' } });
    } else {
      const reason = isSeller
        ? 'The seller declined the order.'
        : 'The buyer cancelled the order before fulfilment.';
      const refund = await cancelOrderAndRefund(order, reason);
      const buyer = await User.findById(order.buyer_id).select('email full_name').lean();
      const listing = await Listing.findById(order.listing_id).select('title').lean();
      await notifyUser(String(order.buyer_id), {
        title: refund.initiated ? 'Refund initiated' : 'Refund processing',
        body: refund.initiated
          ? `Your payment for ${listing?.title || 'this order'} has been cancelled and a refund has been initiated. You will receive the funds back through the original payment method.`
          : `Your order for ${listing?.title || 'this item'} has been cancelled. Your refund is being processed and will be returned through the original payment method.`,
        type: 'refund',
        url: `/pages/orders.html?id=${order._id}`,
      }).catch(() => {});
      if (refund.initiated && buyer?.email) {
        await sendOrderRefundEmail(buyer.email, {
          buyerName: buyer.full_name || 'buyer',
          listingTitle: listing?.title || 'your item',
          reason,
          amount: order.amount,
          refundStatus: order.refund_status,
        }).catch(() => {});
      }
    }

    const updated = await Order.findById(req.params.id);
    if (outcome === 'completed') await updated.updateOne({ $set: update });
    const finalOrder = await Order.findById(req.params.id);
    res.json({ ...finalOrder.toObject(), id: finalOrder._id, needs_rating: isBuyer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders/:id/rate — buyer rates seller after order completes
router.post('/:id/rate', authMiddleware, async (req, res) => {
  try {
    const uid   = req.user.id;
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (String(order.buyer_id) !== String(uid))
      return res.status(403).json({ error: 'Only the buyer can rate this order' });
    if (order.status !== 'completed' && order.status !== 'cancelled')
      return res.status(400).json({ error: 'Order must be completed or cancelled first' });
    if (order.buyer_rating)
      return res.status(409).json({ error: 'You have already rated this order' });

    await Order.findByIdAndUpdate(req.params.id, {
      $set: { buyer_rating: rating, buyer_review: (review || '').trim(), buyer_rated_at: new Date() },
    });

    const seller = await User.findById(order.seller_id);
    const newCount = (seller.rating_count || 0) + 1;
    const newRating = (((seller.rating || 0) * (seller.rating_count || 0)) + rating) / newCount;
    const profileDelta = rating >= 4 ? 5 : rating === 3 ? 0 : -8;
    const nextHealth = Math.min(100, Math.max(0, (seller.profile_health || 100) + profileDelta));
    await User.findByIdAndUpdate(order.seller_id, {
      $set: { rating: Math.round(newRating * 10) / 10, rating_count: newCount, profile_health: nextHealth },
    });

    res.json({ success: true, profile_health: nextHealth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.cancelOrderAndRefund = cancelOrderAndRefund;
module.exports = router;
