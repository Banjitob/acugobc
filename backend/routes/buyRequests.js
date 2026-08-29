const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { BuyRequest, Listing, User, CartItem } = require('../db/database');
const { authMiddleware, sellerApprovalMiddleware } = require('../middleware/auth');
const { notifyUser } = require('../db/push');
const { sendBuyRequestSellerAlertEmail, sendBuyRequestAcceptedEmail } = require('../utils/email');
const ordersRouter = require('./orders'); // for the shared buildSplitCheckoutSession helper

// Buyer must pay for this many listings; response/payment windows are short
// so a listing isn't tied up in limbo for long. Listings stay live/buyable by
// other users the whole time — nothing is reserved until money moves.
const RESPONSE_WINDOW_MS = 2 * 60 * 60 * 1000; // seller must accept/decline within 2h
const PAYMENT_WINDOW_MS  = 2 * 60 * 60 * 1000; // buyer must pay within 2h of acceptance

function shapeRequest(r) {
  return {
    ...r,
    id: r._id,
    listing_title:  r.listing_id?.title,
    listing_images: r.listing_id?.images || [],
    listing_price:  r.listing_id?.price,
    listing_status: r.listing_id?.status,
    buyer_name:      r.buyer_id?.full_name,
    buyer_university:r.buyer_id?.university,
    seller_name:     r.seller_id?.full_name,
    listing_id:      r.listing_id?._id || r.listing_id,
    buyer_id:        r.buyer_id?._id || r.buyer_id,
    seller_id:       r.seller_id?._id || r.seller_id,
  };
}

// POST /api/buy-requests — turn the buyer's current cart into buy requests,
// one per listing, grouped by request_group. No money moves here. Each
// seller gets their own request(s) to accept or decline independently.
router.post('/', authMiddleware, async (req, res) => {
  try {
    const cartItems = await CartItem.find({ user_id: req.user.id }).populate('listing_id');
    if (!cartItems.length) return res.status(400).json({ error: 'Your cart is empty' });

    const eligible = cartItems.filter(c => c.listing_id && c.listing_id.status === 'active' && Number(c.listing_id.stock_quantity || 0) >= 1);
    const unavailable = cartItems.filter(c => !eligible.includes(c));
    if (!eligible.length) {
      return res.status(409).json({
        error: 'Nothing in your cart is currently available to request',
        unavailable_ids: unavailable.map(c => c.listing_id?._id).filter(Boolean),
      });
    }
    if (eligible.some(c => String(c.listing_id.seller_id) === String(req.user.id))) {
      return res.status(400).json({ error: 'You cannot request to buy your own listing' });
    }

    const request_group = uuidv4();
    const now = new Date();
    const toCreate = eligible.map(c => ({
      buyer_id: req.user.id,
      seller_id: c.listing_id.seller_id,
      listing_id: c.listing_id._id,
      amount: Number(c.listing_id.price || 0),
      request_group,
      response_deadline_at: new Date(now.getTime() + RESPONSE_WINDOW_MS),
    }));

    const created = await BuyRequest.insertMany(toCreate);

    // Requested items leave the cart — they're now "pending seller response"
    // rather than sitting in the cart.
    await CartItem.deleteMany({ user_id: req.user.id, listing_id: { $in: eligible.map(c => c.listing_id._id) } });

    // Notify each seller once, even if the buyer requested several of their listings.
    const bySeller = new Map();
    for (const c of eligible) {
      const sid = String(c.listing_id.seller_id);
      if (!bySeller.has(sid)) bySeller.set(sid, []);
      bySeller.get(sid).push(c.listing_id);
    }
    const buyer = await User.findById(req.user.id).select('full_name').lean();
    for (const [sid, listings] of bySeller.entries()) {
      const seller = await User.findById(sid).select('email full_name').lean();
      const title = listings.length === 1 ? listings[0].title : `${listings.length} items`;
      const totalAmount = listings.reduce((s, l) => s + Number(l.price || 0), 0);
      await notifyUser(sid, {
        title: 'New buy request',
        body: `${buyer?.full_name || 'A buyer'} wants to buy ${title}. Accept or decline within 2 hours — no payment has been taken yet.`,
        type: 'order',
        url: `/pages/seller-dashboard.html?tab=orders`,
      }).catch(() => {});
      if (seller?.email) {
        await sendBuyRequestSellerAlertEmail(seller.email, {
          buyerName: buyer?.full_name || 'A buyer',
          listingTitle: title,
          amount: totalAmount,
        }).catch(err => console.error('[email] buy request alert failed:', err.message));
      }
    }

    res.json({
      request_group,
      count: created.length,
      requests: created.map(r => ({ ...r.toObject(), id: r._id })),
      unavailable_ids: unavailable.map(c => c.listing_id?._id).filter(Boolean),
    });
  } catch (e) {
    console.error('[buy-requests] create failed:', e);
    res.status(500).json({ error: e.message || 'Could not send buy request' });
  }
});

// GET /api/buy-requests/buying — the current user's own requests, as a buyer.
router.get('/buying', authMiddleware, async (req, res) => {
  try {
    const filter = { buyer_id: req.user.id };
    if (req.query.status) filter.status = req.query.status;
    const requests = await BuyRequest.find(filter)
      .populate('listing_id', 'title images price status')
      .populate('seller_id', 'full_name')
      .sort({ created_at: -1 }).lean();
    res.json(requests.map(shapeRequest));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/buy-requests/selling — incoming requests for the current seller.
router.get('/selling', sellerApprovalMiddleware, async (req, res) => {
  try {
    const filter = { seller_id: req.user.id };
    if (req.query.status) filter.status = req.query.status;
    const requests = await BuyRequest.find(filter)
      .populate('listing_id', 'title images price status stock_quantity')
      .populate('buyer_id', 'full_name university')
      .sort({ created_at: -1 }).lean();
    res.json(requests.map(shapeRequest));
  } catch (e) {
    console.error('[buy-requests/selling] failed:', e);
    res.status(500).json({ error: e.message || 'Could not load buy requests' });
  }
});

// POST /api/buy-requests/:id/accept — seller accepts. The buyer is then free
// to pay (within PAYMENT_WINDOW_MS) — this is the whole point of the feature:
// no payment can happen before this call succeeds.
router.post('/:id/accept', sellerApprovalMiddleware, async (req, res) => {
  try {
    const reqDoc = await BuyRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: 'Request not found' });
    if (String(reqDoc.seller_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the seller can accept this request' });
    if (reqDoc.status !== 'pending')
      return res.status(400).json({ error: `This request is already ${reqDoc.status}` });
    if (reqDoc.response_deadline_at && new Date(reqDoc.response_deadline_at) < new Date())
      return res.status(400).json({ error: 'This request expired before you responded' });

    // Re-check stock at accept time — it may have sold out to someone else
    // since the request came in, since the listing stays live throughout.
    const listing = await Listing.findById(reqDoc.listing_id);
    if (!listing || listing.status !== 'active' || Number(listing.stock_quantity || 0) < 1) {
      reqDoc.status = 'declined';
      reqDoc.decline_reason = 'Out of stock';
      reqDoc.responded_at = new Date();
      await reqDoc.save();
      return res.status(409).json({ error: 'This item is no longer in stock, so the request was automatically declined.' });
    }

    const [seller, buyer] = await Promise.all([
      User.findById(req.user.id).select('full_name hostel_name').lean(),
      User.findById(reqDoc.buyer_id).select('email hostel_name').lean(),
    ]);

    reqDoc.status = 'accepted';
    reqDoc.responded_at = new Date();
    reqDoc.payment_deadline_at = new Date(Date.now() + PAYMENT_WINDOW_MS);
    await reqDoc.save();

    await notifyUser(String(reqDoc.buyer_id), {
      title: 'Seller accepted your request',
      body: `${seller?.full_name || 'The seller'} accepted your request for "${listing.title}". Pay within 2 hours to complete the purchase.`,
      type: 'order',
      url: `/pages/checkout.html?group=${reqDoc.request_group}`,
    }).catch(() => {});
    if (buyer?.email) {
      await sendBuyRequestAcceptedEmail(buyer.email, {
        sellerName: seller?.full_name || 'The seller',
        listingTitle: listing.title,
        amount: reqDoc.amount,
      }).catch(err => console.error('[email] buy request accepted failed:', err.message));
    }

    res.json({ success: true, request: { ...reqDoc.toObject(), id: reqDoc._id } });
  } catch (e) {
    console.error('[buy-requests/accept] failed:', e);
    res.status(500).json({ error: e.message || 'Could not accept request' });
  }
});

// POST /api/buy-requests/:id/decline
router.post('/:id/decline', sellerApprovalMiddleware, async (req, res) => {
  try {
    const reqDoc = await BuyRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: 'Request not found' });
    if (String(reqDoc.seller_id) !== String(req.user.id))
      return res.status(403).json({ error: 'Only the seller can decline this request' });
    if (reqDoc.status !== 'pending')
      return res.status(400).json({ error: `This request is already ${reqDoc.status}` });

    reqDoc.status = 'declined';
    reqDoc.decline_reason = String(req.body?.reason || '').trim().slice(0, 300);
    reqDoc.responded_at = new Date();
    await reqDoc.save();

    const listing = await Listing.findById(reqDoc.listing_id).select('title').lean();
    await notifyUser(String(reqDoc.buyer_id), {
      title: 'Buy request declined',
      body: `Your request for "${listing?.title || 'this item'}" was declined by the seller.${reqDoc.decline_reason ? ' Reason: ' + reqDoc.decline_reason : ''}`,
      type: 'order',
      url: `/pages/buyer-dashboard.html?tab=orders`,
    }).catch(() => {});

    res.json({ success: true, request: { ...reqDoc.toObject(), id: reqDoc._id } });
  } catch (e) {
    console.error('[buy-requests/decline] failed:', e);
    res.status(500).json({ error: e.message || 'Could not decline request' });
  }
});

// GET /api/buy-requests/group/:group — the buyer's own accepted-and-unpaid
// requests in this batch, for the "pay now" checkout page.
router.get('/group/:group', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const requests = await BuyRequest.find({
      request_group: req.params.group,
      buyer_id: req.user.id,
      status: 'accepted',
      payment_deadline_at: { $gt: now },
    }).populate('listing_id', 'title images price status stock_quantity').lean();

    if (!requests.length) return res.status(404).json({ error: 'No accepted requests to pay for in this group. They may have expired or already been paid.' });
    res.json(requests.map(shapeRequest));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/buy-requests/:group/initialize-payment — buyer pays for the
// accepted subset of a request group. This is the ONLY way money can move —
// every listing here was individually accepted by its seller first.
router.post('/:group/initialize-payment', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const requests = await BuyRequest.find({
      request_group: req.params.group,
      buyer_id: req.user.id,
      status: 'accepted',
      payment_deadline_at: { $gt: now },
    }).populate('listing_id');

    const unavailable = requests.filter(r => !r.listing_id || r.listing_id.status !== 'active' || Number(r.listing_id.stock_quantity || 0) < 1);
    const payable = requests.filter(r => !unavailable.includes(r));

    if (!payable.length) {
      return res.status(409).json({
        error: unavailable.length
          ? 'The item(s) you were about to pay for are no longer available.'
          : 'Nothing to pay for — accepted requests may have expired.',
        unavailable_ids: unavailable.map(r => r.listing_id?._id).filter(Boolean),
      });
    }

    const buyer = await User.findById(req.user.id).select('email').lean();
    const delivery_contact = req.body?.delivery_address || req.body?.delivery_contact || {};

    let session;
    try {
      session = await ordersRouter.buildSplitCheckoutSession({
        buyerId: req.user.id,
        buyerEmail: buyer?.email,
        deliveryContact: delivery_contact,
        listings: payable.map(r => r.listing_id),
        source: 'buy_request',
        buyRequestGroup: req.params.group,
        req,
      });
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.message || 'Could not initialize payment' });
    }

    res.json({ ...session, unavailable_ids: unavailable.map(r => r.listing_id?._id).filter(Boolean) });
  } catch (e) {
    console.error('[buy-requests/initialize-payment] failed:', e);
    res.status(502).json({ error: e.message || 'Could not initialize payment' });
  }
});

module.exports = router;
