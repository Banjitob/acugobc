const express = require('express');
const router  = express.Router();
const { User } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

// POST /api/push/subscribe — save push subscription for user
router.post('/subscribe', authMiddleware, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

    await User.findByIdAndUpdate(req.user.id, {
      $addToSet: { push_subscriptions: subscription }
    });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/push/unsubscribe
router.delete('/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await User.findByIdAndUpdate(req.user.id, {
      $pull: { push_subscriptions: { endpoint } }
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
