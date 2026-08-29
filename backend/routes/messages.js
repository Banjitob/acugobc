const express = require('express');
const router  = express.Router();
const { Conversation, Message, Listing, User, ConversationReport } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { notifyUser } = require('../db/push');
const { moderateMessage } = require('../utils/aiModerator');

// GET /api/messages/conversations
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const convs = await Conversation
      .find({ $or: [{ buyer_id: uid }, { seller_id: uid }] })
      .populate('buyer_id',  'full_name')
      .populate('seller_id', 'full_name')
      .populate('listing_id','title images')
      .sort({ last_message_at: -1 })
      .lean();

    const enriched = await Promise.all(convs.map(async c => {
      const isbuyer  = String(c.buyer_id?._id)  === String(uid);
      const otherDoc = isbuyer ? c.seller_id : c.buyer_id;
      const unread   = await Message.countDocuments({ conversation_id: c._id, receiver_id: uid, is_read: false });
      return {
        ...c, id: c._id,
        seller_id:      c.seller_id?._id || c.seller_id,
        buyer_id:       c.buyer_id?._id  || c.buyer_id,
        other_user:     { id: otherDoc?._id, name: otherDoc?.full_name || 'Unknown' },
        listing_title:  c.listing_id?.title  || null,
        listing_id:     c.listing_id?._id    || null,
        listing_images: c.listing_id?.images || [],
        unread_count:   unread,
        txn_status:     c.txn_status || 'pending',
      };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/messages/conversations/:id
router.get('/conversations/:id', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const conv = await Conversation.findOne({
      _id: req.params.id,
      $or: [{ buyer_id: uid }, { seller_id: uid }],
    }).lean();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const messages = await Message
      .find({
        conversation_id: req.params.id,
        $or: [
          { is_admin_notification: { $ne: true } },
          { is_admin_notification: true, notification_to: uid },
        ],
      })
      .populate('sender_id', 'full_name')
      .sort({ created_at: 1 }).lean();

    // Mark as read
    await Message.updateMany(
      { conversation_id: req.params.id, receiver_id: uid },
      { $set: { is_read: true } }
    );

    // Fetch any active order tied to this conversation's listing + participants
    const { Order } = require('../db/database');
    let order = null;
    if (conv.listing_id) {
      order = await Order.findOne({
        listing_id: conv.listing_id,
        buyer_id:  conv.buyer_id,
        seller_id: conv.seller_id,
        status: { $nin: ['cancelled'] },
      }).sort({ created_at: -1 }).lean();
    }
    if (!order) {
      order = await Order.findOne({
        $or: [
          { buyer_id: conv.buyer_id, seller_id: conv.seller_id },
          { buyer_id: conv.seller_id, seller_id: conv.buyer_id },
        ],
        status: { $nin: ['cancelled'] },
      }).sort({ created_at: -1 }).lean();
    }

    res.json({
      conversation: { ...conv, id: conv._id },
      messages: messages.map(m => ({ ...m, id: m._id, sender_name: m.sender_id?.full_name })),
      order: order ? { ...order, id: order._id } : null,
      ai_flagged:       conv.ai_flagged       || false,
      ai_flag_reason:   conv.ai_flag_reason   || '',
      ai_flag_category: conv.ai_flag_category || '',
      txn_status:       conv.txn_status       || 'pending',
      buyer_rated:      conv.buyer_rated       || false,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/send
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const { receiver_id, listing_id, content, conversation_id } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

    let convDoc;

    if (conversation_id) {
      convDoc = await Conversation.findOne({
        _id: conversation_id,
        $or: [{ buyer_id: uid }, { seller_id: uid }],
      });
      if (!convDoc) return res.status(404).json({ error: 'Conversation not found' });
    } else {
      if (!receiver_id) return res.status(400).json({ error: 'receiver_id required' });

      // Find an existing *active* conversation for this listing + pair.
      // A conversation whose transaction already finished (completed or
      // cancelled) is left alone as a record of that past deal — messaging
      // the seller again starts a brand new conversation/transaction,
      // rather than reopening the old one.
      const orPairs = [
        { buyer_id: uid, seller_id: receiver_id },
        { buyer_id: receiver_id, seller_id: uid },
      ];
      const qry = listing_id
        ? { listing_id, $or: orPairs, txn_status: 'pending' }
        : { $or: orPairs, txn_status: 'pending' };

      convDoc = await Conversation.findOne(qry).sort({ last_message_at: -1 });

      if (!convDoc) {
        const listing = listing_id ? await Listing.findById(listing_id) : null;
        const sellerId = listing ? String(listing.seller_id) : receiver_id;
        const buyerId  = String(uid);
        convDoc = await Conversation.create({
          listing_id: listing_id || null,
          buyer_id:  buyerId,
          seller_id: sellerId,
        });
      }
    }

    // Block sending if conversation is AI-halted
    if (convDoc.ai_flagged) {
      return res.status(403).json({
        error: 'This conversation has been flagged and halted. Please wait for admin review.',
        ai_flagged: true,
      });
    }

    // Determine receiver
    const receiverId = String(convDoc.buyer_id) === String(uid)
      ? String(convDoc.seller_id)
      : String(convDoc.buyer_id);

    const msg = await Message.create({
      conversation_id: convDoc._id,
      sender_id:   uid,
      receiver_id: receiverId,
      listing_id:  listing_id || null,
      content:     content.trim(),
    });

    await Conversation.findByIdAndUpdate(convDoc._id, {
      $set: { last_message: content.trim().slice(0, 100), last_message_at: new Date() },
    });

    const populated = await Message.findById(msg._id).populate('sender_id', 'full_name').lean();

    // Push notification to receiver
    const senderName = populated.sender_id?.full_name || 'Someone';
    notifyUser(receiverId, {
      title: `New message from ${senderName}`,
      body: content.trim().slice(0, 100),
      type: 'message',
      tag: `msg-${convDoc._id}`,
      url: `/pages/messages.html?conv=${convDoc._id}`,
    }).catch(() => {});

    // ── AI moderation (fire-and-forget, non-blocking) ────────────────────────
    setImmediate(async () => {
      try {
        // Get recent message history for context
        const recentMsgs = await Message.find({ conversation_id: convDoc._id })
          .sort({ created_at: -1 }).limit(6).lean();
        const history = recentMsgs.reverse().map(m => ({
          role:    String(m.sender_id) === String(uid) ? 'user' : 'assistant',
          content: m.content,
        }));

        const result = await moderateMessage(content.trim(), history);
        if (result.flagged) {
          // Halt the conversation
          await Conversation.findByIdAndUpdate(convDoc._id, {
            $set: {
              ai_flagged:       true,
              ai_flag_reason:   result.reason,
              ai_flag_category: result.category,
              ai_flagged_at:    new Date(),
            },
          });

          // Mark the triggering message
          await Message.findByIdAndUpdate(msg._id, { $set: { triggered_ai_flag: true } });

          // Notify both parties
          const flagMsg = `Your conversation has been flagged and paused by our AI moderation system. Reason: ${result.reason}. An admin will review shortly.`;
          notifyUser(String(uid), {
            title: '⚠️ Conversation Flagged',
            body: flagMsg,
            type: 'ai_flag',
            url: `/pages/messages.html?conv=${convDoc._id}`,
          }).catch(() => {});
          notifyUser(receiverId, {
            title: '⚠️ Conversation Flagged',
            body: flagMsg,
            type: 'ai_flag',
            url: `/pages/messages.html?conv=${convDoc._id}`,
          }).catch(() => {});
        }
      } catch(e) { console.warn('[AI mod] message check failed:', e.message); }
    });

    res.json({
      message: { ...populated, id: populated._id, sender_name: populated.sender_id?.full_name },
      conversation_id: convDoc._id,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/conversations/:id/txn-status — set conversation transaction status
router.post('/conversations/:id/txn-status', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const { status } = req.body;
    if (!['pending','completed','cancelled'].includes(status))
      return res.status(400).json({ error: 'status must be pending, completed, or cancelled' });

    const conv = await Conversation.findOne({
      _id: req.params.id,
      $or: [{ buyer_id: uid }, { seller_id: uid }],
    });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    conv.txn_status = status;
    await conv.save();
    res.json({ success: true, txn_status: status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/conversations/:id/rate — buyer rates seller
router.post('/conversations/:id/rate', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5)
      return res.status(400).json({ error: 'Rating must be 1–5' });

    const conv = await Conversation.findOne({ _id: req.params.id, buyer_id: uid });
    if (!conv) return res.status(404).json({ error: 'Conversation not found or you are not the buyer' });
    if (conv.buyer_rated) return res.status(400).json({ error: 'Already rated' });

    conv.buyer_rated  = true;
    conv.buyer_rating = rating;
    conv.buyer_review = review || '';
    await conv.save();

    // Update seller's global rating
    const seller = await User.findById(conv.seller_id);
    if (seller) {
      const newCount = (seller.rating_count || 0) + 1;
      const newRating = ((seller.rating || 0) * (seller.rating_count || 0) + rating) / newCount;
      seller.rating       = Math.round(newRating * 10) / 10;
      seller.rating_count = newCount;
      await seller.save();
    }

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/report
router.post('/report', authMiddleware, async (req, res) => {
  try {
    const uid = req.user.id;
    const { conversation_id, reason } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id is required' });
    if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required' });

    // Verify the reporter is actually part of this conversation
    const conv = await Conversation.findOne({
      _id: conversation_id,
      $or: [{ buyer_id: uid }, { seller_id: uid }],
    });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Prevent duplicate pending reports from same user
    const existing = await ConversationReport.findOne({
      conversation_id: conv._id,
      reporter_id: uid,
      status: 'pending',
    });
    if (existing) return res.status(409).json({ error: 'You have already reported this conversation' });

    const report = await ConversationReport.create({
      conversation_id: conv._id,
      reporter_id: uid,
      reason: reason.trim(),
    });

    res.json({ success: true, report_id: report._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
