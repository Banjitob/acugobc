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
          seller_id:         l.seller_id?._id,
          seller_name:       l.seller_id?.full_name,
          seller_university: l.seller_id?.university,
          added_at:          i.created_at,
        };
      });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/cart/add — { listing_id }
router.post('/add', authMiddleware, async (req, res) => {
  try {
    const { listing_id } = req.body;
    if (!listing_id) return res.status(400).json({ error: 'listing_id is required' });

    const listing = await Listing.findOne({ _id: listing_id, status: 'active' });
    if (!listing) return res.status(404).json({ error: 'Listing not found or no longer available' });
    if (String(listing.seller_id) === String(req.user.id))
      return res.status(400).json({ error: 'Cannot add your own listing to cart' });

    try {
      await CartItem.create({ user_id: req.user.id, listing_id });
    } catch (e) {
      if (e.code !== 11000) throw e; // 11000 = already in cart, treat as success
    }

    const count = await CartItem.countDocuments({ user_id: req.user.id });
    res.json({ added: true, count });
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
