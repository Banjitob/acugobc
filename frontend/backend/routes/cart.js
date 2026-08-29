const express = require('express');
const router  = express.Router();
const { CartItem, Listing } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

router.get('/count', authMiddleware, async (req, res) => {
  try {
    const count = await CartItem.countDocuments({ user_id: req.user.id });
    res.json({ count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', authMiddleware, async (req, res) => {
  try {
    const items = await CartItem
      .find({ user_id: req.user.id })
      .populate({ path: 'listing_id', populate: { path: 'seller_id', select: 'full_name university rating' } })
      .sort({ created_at: -1 }).lean();

    const results = items.filter(i => i.listing_id).map(i => {
      const l = i.listing_id;
      return {
        cart_item_id: i._id,
        id: l._id,
        title: l.title,
        price: l.price,
        original_price: l.original_price,
        images: l.images,
        category: l.category,
        condition: l.condition,
        status: l.status,
        stock_quantity: Number(l.stock_quantity || 0),
        quantity: Math.max(1, Number(i.quantity || 1)),
        seller_id: l.seller_id?._id,
        seller_name: l.seller_id?.full_name,
        seller_university: l.seller_id?.university,
        added_at: i.created_at,
      };
    });
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/add', authMiddleware, async (req, res) => {
  try {
    const { listing_id } = req.body;
    const requestedQuantity = Math.max(1, parseInt(req.body?.quantity ?? 1, 10));
    if (!listing_id) return res.status(400).json({ error: 'listing_id is required' });
    if (!Number.isFinite(requestedQuantity) || requestedQuantity < 1) return res.status(400).json({ error: 'Quantity must be at least 1' });

    const listing = await Listing.findOne({ _id: listing_id, status: 'active' });
    if (!listing) return res.status(404).json({ error: 'Listing not found or no longer available' });
    if (String(listing.seller_id) === String(req.user.id)) return res.status(400).json({ error: 'Cannot add your own listing to cart' });
    const stock = Number(listing.stock_quantity || 0);
    if (stock < requestedQuantity) return res.status(409).json({ error: `Only ${stock} unit${stock === 1 ? '' : 's'} available.` });

    const existing = await CartItem.findOne({ user_id: req.user.id, listing_id });
    if (existing) {
      existing.quantity = requestedQuantity;
      await existing.save();
    } else {
      await CartItem.create({ user_id: req.user.id, listing_id, quantity: requestedQuantity });
    }

    const count = await CartItem.countDocuments({ user_id: req.user.id });
    res.json({ added: true, quantity: requestedQuantity, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:listingId', authMiddleware, async (req, res) => {
  try {
    const quantity = parseInt(req.body?.quantity, 10);
    if (!Number.isFinite(quantity) || quantity < 1) return res.status(400).json({ error: 'Quantity must be at least 1' });
    const listing = await Listing.findOne({ _id: req.params.listingId, status: 'active' });
    if (!listing) return res.status(404).json({ error: 'Listing is no longer available' });
    const stock = Number(listing.stock_quantity || 0);
    if (quantity > stock) return res.status(409).json({ error: `Only ${stock} unit${stock === 1 ? '' : 's'} available.` });
    const item = await CartItem.findOneAndUpdate({ user_id: req.user.id, listing_id: req.params.listingId }, { $set: { quantity } }, { new: true });
    if (!item) return res.status(404).json({ error: 'Item is not in your cart' });
    res.json({ updated: true, quantity: item.quantity });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:listingId', authMiddleware, async (req, res) => {
  try {
    await CartItem.deleteOne({ user_id: req.user.id, listing_id: req.params.listingId });
    const count = await CartItem.countDocuments({ user_id: req.user.id });
    res.json({ removed: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/', authMiddleware, async (req, res) => {
  try {
    await CartItem.deleteMany({ user_id: req.user.id });
    res.json({ cleared: true, count: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
