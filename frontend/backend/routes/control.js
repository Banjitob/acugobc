const mongoose = require('mongoose');
const express = require('express');
const router = express.Router();
const { User, Listing, Conversation, Message, Order, ConversationReport, UserReport, AdminAction } = require('../db/database');
const { controlMiddleware } = require('../middleware/auth');
const { notifyUser } = require('../db/push');
const { sendSellerDecisionEmail } = require('../utils/email');

router.use(controlMiddleware);

async function logControlAction(req, action, target = null, reason = '', metadata = {}, reversible = false) {
  const control = await User.findById(req.user.id).select('full_name email').lean();
  return AdminAction.create({
    admin_id: req.user.id,
    actor_role: 'control',
    admin_name: control?.full_name || control?.email || 'Control',
    action,
    target_user_id: target?._id || null,
    target_user_name: target?.full_name || '',
    target_user_email: target?.email || '',
    reason: reason || '',
    metadata,
    reversible,
  });
}

router.get('/seller-applications', async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const filter = { role: 'seller' };
    if (status !== 'all') filter.seller_approval_status = status;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, sellers] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).select('-password_hash -push_subscriptions -used_payment_refs').sort({ seller_approval_requested_at: -1, created_at: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    ]);
    res.json({ sellers: sellers.map(u => ({ ...u, id: u._id })), total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seller-applications/:id/approve', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid seller ID' });
    const seller = await User.findOne({ _id: req.params.id, role: 'seller' });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    if (!seller.registration_complete) return res.status(400).json({ error: 'Seller has not completed registration' });
    if (seller.seller_approval_status === 'approved') return res.status(409).json({ error: 'Seller is already approved' });
    const previous = { status: seller.seller_approval_status, reason: seller.seller_approval_reason || '', reviewed_by: seller.seller_approval_reviewed_by ? String(seller.seller_approval_reviewed_by) : null };
    seller.seller_approval_status = 'approved'; seller.seller_approval_reason = ''; seller.seller_approval_reviewed_at = new Date(); seller.seller_approval_reviewed_by = req.user.id;
    await seller.save();
    await logControlAction(req, 'seller_approved', seller, '', { application_id: String(seller._id), previous_status: previous.status, previous_reason: previous.reason, previous_reviewed_by: previous.reviewed_by }, true);
    await notifyUser(String(seller._id), { title: '✅ Seller account approved', body: 'Your Bixcart seller account has been approved. You can now sign in and start selling.', type: 'seller_approval', url: '/pages/seller-dashboard.html' }).catch(() => {});
    sendSellerDecisionEmail(seller.email, { sellerName: seller.full_name, approved: true }).catch(() => {});
    res.json({ success: true, user: { ...seller.toObject(), id: seller._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seller-applications/:id/reject', async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });
    const seller = await User.findOne({ _id: req.params.id, role: 'seller' });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    if (seller.seller_approval_status === 'approved') return res.status(409).json({ error: 'Approved sellers cannot be rejected from this workflow' });
    const previous = { status: seller.seller_approval_status, reason: seller.seller_approval_reason || '', reviewed_by: seller.seller_approval_reviewed_by ? String(seller.seller_approval_reviewed_by) : null };
    seller.seller_approval_status = 'rejected'; seller.seller_approval_reason = reason; seller.seller_approval_reviewed_at = new Date(); seller.seller_approval_reviewed_by = req.user.id;
    await seller.save();
    await logControlAction(req, 'seller_rejected', seller, reason, { application_id: String(seller._id), previous_status: previous.status, previous_reason: previous.reason, previous_reviewed_by: previous.reviewed_by }, true);
    await notifyUser(String(seller._id), { title: 'Seller application rejected', body: `Your seller application was rejected. Reason: ${reason}`, type: 'seller_approval', url: '/pages/auth.html' }).catch(() => {});
    sendSellerDecisionEmail(seller.email, { sellerName: seller.full_name, approved: false, reason }).catch(() => {});
    res.json({ success: true, user: { ...seller.toObject(), id: seller._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reports/disputes/AI are intentionally read-only for Control users.
router.get('/user-reports', async (req, res) => {
  try {
    const status = ['pending','resolved','dismissed','all'].includes(req.query.status) ? req.query.status : 'pending';
    const filter = status === 'all' ? {} : { status };
    const reports = await UserReport.find(filter)
      .populate('reported_user_id', 'full_name email role rating rating_count report_count discoverability_score is_verified account_status')
      .populate('reporter_id', 'full_name email role')
      .populate('resolved_by', 'full_name')
      .sort({ created_at: -1 }).limit(200).lean();
    res.json({ reports: reports.map(r => ({ ...r, id: r._id })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/conversations', async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const filter = status === 'all' ? {} : { status };
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await ConversationReport.countDocuments(filter);
    const reports = await ConversationReport.find(filter)
      .populate('reporter_id', 'full_name email')
      .populate('fault_user_id', 'full_name')
      .sort({ created_at: -1 }).skip(skip).limit(parseInt(limit)).lean();
    const convIds = reports.map(r => r.conversation_id);
    const convs = await Conversation.find({ _id: { $in: convIds } })
      .populate('buyer_id', 'full_name email account_status')
      .populate('seller_id', 'full_name email account_status')
      .populate('listing_id', 'title status').lean();
    const convMap = Object.fromEntries(convs.map(c => [String(c._id), c]));
    res.json({ conversations: reports.map(r => ({ ...r, id: r._id, conversation: convMap[String(r.conversation_id)] || null })), total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/conversations/:id', async (req, res) => {
  try {
    let report = await ConversationReport.findById(req.params.id).populate('reporter_id','full_name email').populate('fault_user_id','full_name email').lean().catch(() => null);
    const conv = report
      ? await Conversation.findById(report.conversation_id).populate('buyer_id','full_name email').populate('seller_id','full_name email').populate('listing_id','title status price').lean()
      : await Conversation.findById(req.params.id).populate('buyer_id','full_name email').populate('seller_id','full_name email').populate('listing_id','title status price').lean();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const messages = await Message.find({ conversation_id: conv._id }).populate('sender_id','full_name role').sort({ created_at: 1 }).lean();
    res.json({ conversation: { ...conv, id: conv._id }, report: report ? { ...report, id: report._id } : null, messages: messages.map(m => ({ ...m, id: m._id, sender_name: m.sender_id?.full_name, sender_role: m.sender_id?.role })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/flagged', async (req, res) => {
  try {
    const [conversations, listings, pending] = await Promise.all([
      Conversation.find({ ai_flagged: true }).populate('buyer_id','full_name email').populate('seller_id','full_name email').populate('listing_id','title').sort({ ai_flagged_at:-1 }).lean(),
      Listing.find({ ai_flagged: true }).populate('seller_id','full_name email').sort({ ai_flagged_at:-1 }).lean(),
      Promise.all([Conversation.countDocuments({ ai_flagged:true, ai_reviewed:false }), Listing.countDocuments({ ai_flagged:true, ai_reviewed:false })]),
    ]);
    res.json({ conversations: conversations.map(c=>({...c,id:c._id})), listings:listings.map(l=>({...l,id:l._id})), pending_count: pending[0]+pending[1] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
