const express = require('express');
const router  = express.Router();
const { CartItem, Listing } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

// GET /api/cart/count — lightweight, used by the nav badge on every page load
router.get('/count', authMiddleware, async (req, res) => {
  try {
    const count = await CartItem.countDocuments({ user_id: req.user.id });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cart — full cart with listing details for the cart page
router.get('/', authMiddleware, async (req, res) => {
  try {
    const items = await CartItem
      .find({ user_id: req.user.id })
      .populate({ path: 'listing_id', populate: { path: 'seller_id', select: 'full_name university rating' } })
      .sort({ created_at: -1 }).lean();

    const results = items
      .filter(i => i.listing_id) // listing was hard-deleted
      .map(i => {
        const l = i.listing_id;
        return {
          cart_item_id:      i._id,
          id:                l._id,
          title:             l.title,
          price:             l.price,
          original_price:    l.original_price,
          images:            l.images,
          category:          l.category,
          condition:         l.condition,
          status:            l.status,
          stock_quantity:    l.stock_quantity,
          quantity:          i.quantity || 1,
          line_total:        Number(l.price || 0) * (i.quantity || 1),
          seller_id:         l.seller_id?._id,
          seller_name:       l.seller_id?.full_name,
          seller_university: l.seller_id?.university,
          added_at:          i.created_at,
        };
      });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cart/add — { listing_id, quantity? }. Adding a listing already in
// the cart increases its quantity instead of erroring, capped at the
// listing's current stock.
router.post('/add', authMiddleware, async (req, res) => {
  try {
    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'listing_id is required' });
    let requestedQty = parseInt(req.body.quantity, 10);
    if (!Number.isFinite(requestedQty) || requestedQty < 1) requestedQty = 1;

    const listing = await Listing.findOne({ _id: listing_id, status: 'active' });
    if (!listing) return res.status(404).json({ error: 'Listing not found or no longer available' });
    if (String(listing.seller_id) === String(req.user.id))
      return res.status(400).json({ error: 'Cannot add your own listing to cart' });

    const stock = Number(listing.stock_quantity || 0);
    if (stock < 1) return res.status(409).json({ error: 'This item is out of stock' });

    const existing = await CartItem.findOne({ user_id: req.user.id, listing_id });
    const priorQty = existing?.quantity || 0;
    const wantedQty = priorQty + requestedQty;
    const desiredQty = Math.min(stock, wantedQty);
    if (existing) {
      existing.quantity = desiredQty;
      await existing.save();
    } else {
      await CartItem.create({ user_id: req.user.id, listing_id, quantity: desiredQty });
    }

    const count = await CartItem.countDocuments({ user_id: req.user.id });
    res.json({ added: true, count, quantity: desiredQty, capped: desiredQty < wantedQty });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/cart/:listingId — { quantity } — set an exact quantity for an
// item already in the cart, capped at current stock. quantity <= 0 removes it.
router.patch('/:listingId', authMiddleware, async (req, res) => {
  try {
    const qty = parseInt(req.body.quantity, 10);
    if (!Number.isFinite(qty)) return res.status(400).json({ error: 'A valid quantity is required' });

    if (qty <= 0) {
      await CartItem.deleteOne({ user_id: req.user.id, listing_id: req.params.listingId });
      const count = await CartItem.countDocuments({ user_id: req.user.id });
      return res.json({ removed: true, count });
    }

    const listing = await Listing.findById(req.params.listingId).select('stock_quantity status').lean();
    if (!listing || listing.status !== 'active') return res.status(404).json({ error: 'Listing not found or no longer available' });
    const stock = Number(listing.stock_quantity || 0);
    const cappedQty = Math.min(Math.max(1, qty), Math.max(1, stock));

    const item = await CartItem.findOneAndUpdate(
      { user_id: req.user.id, listing_id: req.params.listingId },
      { $set: { quantity: cappedQty } },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: 'Item is not in your cart' });

    const count = await CartItem.countDocuments({ user_id: req.user.id });
    res.json({ quantity: item.quantity, capped: cappedQty < qty, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/cart/:listingId — remove one item
router.delete('/:listingId', authMiddleware, async (req, res) => {
  try {
    await CartItem.deleteOne({ user_id: req.user.id, listing_id: req.params.listingId });
    const count = await CartItem.countDocuments({ user_id: req.user.id });
    res.json({ removed: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/cart — clear the whole cart
router.delete('/', authMiddleware, async (req, res) => {
  try {
    await CartItem.deleteMany({ user_id: req.user.id });
    res.json({ cleared: true, count: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
