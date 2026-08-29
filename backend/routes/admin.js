const mongoose = require('mongoose');
const express = require('express');
const router  = express.Router();
const { User, Listing, Conversation, Message, Order, ConversationReport, UserReport, Broadcast, Hostel, DeliverySpot, AdminAction, UserActivity, PlatformSetting, CommissionProposal, getCurrentCommissionPercent } = require('../db/database');
const { adminMiddleware } = require('../middleware/auth');
const { notifyUser } = require('../db/push');
const { sendSellerDecisionEmail } = require('../utils/email');

// All admin routes require admin role
router.use(adminMiddleware);

async function logAdminAction(req, action, target = null, reason = '', metadata = {}, reversible = false) {
  const admin = await User.findById(req.user.id).select('full_name email').lean();
  return AdminAction.create({
    admin_id: req.user.id,
    actor_role: req.user.role === 'control' ? 'control' : 'admin',
    admin_name: admin?.full_name || admin?.email || 'Admin',
    action,
    target_user_id: target?._id || null,
    target_user_name: target?.full_name || '',
    target_user_email: target?.email || '',
    reason: reason || '',
    metadata,
    reversible,
  });
}



// ── PLATFORM COMMISSION GOVERNANCE ──────────────────────────────────────────
router.get('/commission', async (req, res) => {
  try {
    const [percent, pending, history] = await Promise.all([
      getCurrentCommissionPercent(),
      CommissionProposal.findOne({ status: 'pending' }).populate('proposed_by', 'full_name email').sort({ created_at: -1 }).lean(),
      CommissionProposal.find({ status: { $in: ['approved','rejected','cancelled'] } }).populate('proposed_by', 'full_name email').sort({ decided_at: -1, created_at: -1 }).limit(20).lean(),
    ]);
    const format = p => p ? ({ ...p, id: p._id, proposer: p.proposed_by ? { id: p.proposed_by._id, full_name: p.proposed_by.full_name, email: p.proposed_by.email } : null, votes: (p.votes || []).map(v => ({ ...v, id: v._id })) }) : null;
    res.json({ commission_percent: percent, pending: format(pending), history: history.map(format) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/commission/proposals', async (req, res) => {
  try {
    const proposed_percent = Number(req.body?.proposed_percent);
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isFinite(proposed_percent) || proposed_percent < 0 || proposed_percent > 100) return res.status(400).json({ error: 'Commission must be between 0% and 100%.' });
    const current = await getCurrentCommissionPercent();
    if (proposed_percent === current) return res.status(409).json({ error: `Commission is already ${current}%.` });
    const existing = await CommissionProposal.findOne({ status: 'pending' });
    if (existing) return res.status(409).json({ error: 'There is already a pending commission change awaiting a vote.' });
    const proposal = await CommissionProposal.create({ proposed_percent, proposed_by: req.user.id, reason });
    res.status(201).json({ success: true, proposal: { ...proposal.toObject(), id: proposal._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/commission/proposals/:id/vote', async (req, res) => {
  try {
    const vote = String(req.body?.vote || '').toLowerCase();
    if (!['agree','disagree'].includes(vote)) return res.status(400).json({ error: 'Vote must be agree or disagree.' });
    const proposal = await CommissionProposal.findById(req.params.id);
    if (!proposal || proposal.status !== 'pending') return res.status(404).json({ error: 'Pending commission proposal not found.' });
    if (String(proposal.proposed_by) === String(req.user.id)) return res.status(403).json({ error: 'The admin who proposed the change cannot cast the required deciding vote.' });
    if (proposal.votes.some(v => String(v.voter_id) === String(req.user.id))) return res.status(409).json({ error: 'You have already voted on this proposal.' });

    proposal.votes.push({ voter_id: req.user.id, vote, voted_at: new Date() });
    proposal.status = vote === 'agree' ? 'approved' : 'rejected';
    proposal.decided_at = new Date();
    await proposal.save();

    if (vote === 'agree') {
      const previous_percent = await getCurrentCommissionPercent();
      await PlatformSetting.findOneAndUpdate({ key: 'commission_percent' }, { $set: { value: proposal.proposed_percent } }, { upsert: true, new: true, setDefaultsOnInsert: true });
      await logAdminAction(req, 'commission_changed', null, proposal.reason || '', { proposal_id: String(proposal._id), previous_percent, new_percent: proposal.proposed_percent, vote: 'agree' });
    }
    res.json({ success: true, status: proposal.status, commission_percent: await getCurrentCommissionPercent() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS ────────────────────────────────────────────────────────────────────
// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsers, buyers, sellers,
      activeListings, totalListings,
      totalConversations, totalMessages,
      totalOrders, suspendedUsers, warnedUsers, pendingReports,
    ] = await Promise.all([
      User.countDocuments({ role: { $ne: 'admin' } }),
      User.countDocuments({ role: 'buyer' }),
      User.countDocuments({ role: 'seller' }),
      Listing.countDocuments({ status: 'active' }),
      Listing.countDocuments({ status: { $ne: 'deleted' } }),
      Conversation.countDocuments(),
      Message.countDocuments(),
      Order.countDocuments(),
      User.countDocuments({ account_status: 'suspended' }),
      User.countDocuments({ account_status: 'warned' }),
      ConversationReport.countDocuments({ status: 'pending' }),
    ]);
    res.json({
      totalUsers, buyers, sellers,
      activeListings, totalListings,
      totalConversations, totalMessages,
      totalOrders, suspendedUsers, warnedUsers, pendingReports,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SELLER APPROVALS ─────────────────────────────────────────────────────────
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

    seller.seller_approval_status = 'approved';
    seller.seller_approval_reason = '';
    seller.seller_approval_reviewed_at = new Date();
    seller.seller_approval_reviewed_by = req.user.id;
    await seller.save();

    await logAdminAction(req, 'seller_approved', seller, '', { application_id: String(seller._id), previous_status: 'pending', previous_reason: '', previous_reviewed_by: null }, true);
    await notifyUser(String(seller._id), { title: '✅ Seller account approved', body: 'Your Bixcart seller account has been approved. You can now sign in and start selling.', type: 'seller_approval', url: '/pages/seller-dashboard.html' }).catch(() => {});
    sendSellerDecisionEmail(seller.email, { sellerName: seller.full_name, approved: true }).catch(err => console.error('[email] seller approval email failed:', err.message));

    res.json({ success: true, user: { ...seller.toObject(), id: seller._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seller-applications/:id/reject', async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid seller ID' });
    const seller = await User.findOne({ _id: req.params.id, role: 'seller' });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });
    if (seller.seller_approval_status === 'approved') return res.status(409).json({ error: 'Approved sellers cannot be rejected from this workflow' });

    seller.seller_approval_status = 'rejected';
    seller.seller_approval_reason = reason;
    seller.seller_approval_reviewed_at = new Date();
    seller.seller_approval_reviewed_by = req.user.id;
    await seller.save();

    await logAdminAction(req, 'seller_rejected', seller, reason, { application_id: String(seller._id), previous_status: 'pending', previous_reason: '', previous_reviewed_by: null }, true);
    await notifyUser(String(seller._id), { title: 'Seller application rejected', body: `Your seller application was rejected. Reason: ${reason}`, type: 'seller_approval', url: '/pages/auth.html' }).catch(() => {});
    sendSellerDecisionEmail(seller.email, { sellerName: seller.full_name, approved: false, reason }).catch(err => console.error('[email] seller rejection email failed:', err.message));

    res.json({ success: true, user: { ...seller.toObject(), id: seller._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ACCOUNT DELETION REQUESTS ────────────────────────────────────────────────
// GET /api/admin/deletion-requests?status=pending|approved|rejected|all
router.get('/deletion-requests', async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const filter = status === 'all'
      ? { deletion_requested_at: { $ne: null } }
      : status === 'pending'
        ? { account_status: 'deletion_pending' }
        : status === 'approved'
          ? { account_status: 'deleted', deletion_approved_at: { $ne: null } }
          : { deletion_requested_at: { $ne: null }, deletion_reviewed_at: { $ne: null }, account_status: { $ne: 'deleted' } }; // 'rejected'
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).select('-password_hash -push_subscriptions -used_payment_refs').sort({ deletion_requested_at: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    ]);
    res.json({ users: users.map(u => ({ ...u, id: u._id })), total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/deletion-requests/:id/approve', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid user ID' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.account_status !== 'deletion_pending') return res.status(400).json({ error: 'This user does not have a pending deletion request' });

    user.account_status = 'deleted';
    user.deletion_reviewed_at = new Date();
    user.deletion_reviewed_by = req.user.id;
    user.deletion_approved_at = new Date();
    // Data is retained for one year after approval before being purged by a
    // separate housekeeping job, per Bixcart's stated retention policy.
    user.deletion_retention_until = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await user.save();

    await logAdminAction(req, 'account_deletion_approved', user, '', { deletion_reason: user.deletion_reason });
    res.json({ success: true, user: { ...user.toObject(), id: user._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/deletion-requests/:id/reject', async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required so the user understands why their request was rejected' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid user ID' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.account_status !== 'deletion_pending') return res.status(400).json({ error: 'This user does not have a pending deletion request' });

    user.account_status = 'active';
    user.deletion_reviewed_at = new Date();
    user.deletion_reviewed_by = req.user.id;
    await user.save();

    await logAdminAction(req, 'account_deletion_rejected', user, reason, { deletion_reason: user.deletion_reason });
    await notifyUser(String(user._id), { title: 'Account deletion request rejected', body: `Your account deletion request was rejected. Reason: ${reason}`, type: 'account', url: '/pages/profile.html' }).catch(() => {});
    res.json({ success: true, user: { ...user.toObject(), id: user._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN OVERRIDE OF SELLER DECISIONS ───────────────────────────────────────
// POST /api/admin/seller-applications/:id/override — set a seller's approval
// decision to a specific new status regardless of the current status. This is
// how an admin overrides a Control account's decision (or a prior admin
// decision): "Reverse" (see /control-actions/:id/reverse below) restores the
// exact prior state, this instead lets the admin choose the outcome directly.
router.post('/seller-applications/:id/override', async (req, res) => {
  try {
    const { status, reason } = req.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Status must be approved, rejected, or pending' });
    if (status === 'rejected' && !String(reason || '').trim()) return res.status(400).json({ error: 'A reason is required when overriding to rejected' });
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid seller ID' });
    const seller = await User.findOne({ _id: req.params.id, role: 'seller' });
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const previous = {
      status: seller.seller_approval_status,
      reason: seller.seller_approval_reason || '',
      reviewed_by: seller.seller_approval_reviewed_by ? String(seller.seller_approval_reviewed_by) : null,
    };
    if (previous.status === status) return res.status(409).json({ error: `Seller is already ${status}` });

    seller.seller_approval_status = status;
    seller.seller_approval_reason = status === 'rejected' ? String(reason).trim() : '';
    seller.seller_approval_reviewed_at = new Date();
    seller.seller_approval_reviewed_by = req.user.id;
    await seller.save();

    // Find the most recent Control decision on this seller, if any, so the
    // audit trail clearly shows what this override superseded.
    const priorControlAction = await AdminAction.findOne({ target_user_id: seller._id, actor_role: 'control', action: { $in: ['seller_approved', 'seller_rejected'] } }).sort({ created_at: -1 });

    await logAdminAction(req, 'seller_override', seller, String(reason || '').trim(), {
      application_id: String(seller._id),
      new_status: status,
      previous_status: previous.status,
      previous_reason: previous.reason,
      previous_reviewed_by: previous.reviewed_by,
      overrides_control_action_id: priorControlAction ? String(priorControlAction._id) : null,
    }, true);

    if (status === 'approved') {
      await notifyUser(String(seller._id), { title: '✅ Seller account approved', body: 'An admin has approved your Bixcart seller account. You can now sign in and start selling.', type: 'seller_approval', url: '/pages/seller-dashboard.html' }).catch(() => {});
      sendSellerDecisionEmail(seller.email, { sellerName: seller.full_name, approved: true }).catch(() => {});
    } else if (status === 'rejected') {
      await notifyUser(String(seller._id), { title: 'Seller application decision updated', body: `An admin has reviewed your seller application again. Decision: rejected. Reason: ${reason}`, type: 'seller_approval', url: '/pages/auth.html' }).catch(() => {});
      sendSellerDecisionEmail(seller.email, { sellerName: seller.full_name, approved: false, reason: String(reason).trim() }).catch(() => {});
    } else {
      await notifyUser(String(seller._id), { title: 'Seller application reopened', body: 'An admin has reopened your seller application for review.', type: 'seller_approval', url: '/pages/auth.html' }).catch(() => {});
    }

    res.json({ success: true, user: { ...seller.toObject(), id: seller._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ACTIONS ────────────────────────────────────────────────────────────
router.get('/actions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const [total, actions] = await Promise.all([
      AdminAction.countDocuments(),
      AdminAction.find().sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    ]);
    res.json({ actions: actions.map(a => ({ ...a, id: a._id })), total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONTROL ACCOUNTS ─────────────────────────────────────────────────────────
router.get('/controls', async (req, res) => {
  try {
    const controls = await User.find({ role: 'control' }).select('-password_hash -push_subscriptions -used_payment_refs').sort({ created_at: -1 }).lean();
    res.json({ controls: controls.map(u => ({ ...u, id: u._id })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/controls', async (req, res) => {
  try {
    const { email, password, full_name } = req.body || {};
    if (!email || !password || !full_name) return res.status(400).json({ error: 'Full name, email and password are required' });
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return res.status(400).json({ error: 'Please enter a valid email address' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (await User.exists({ email: normalizedEmail })) return res.status(409).json({ error: 'That email is already registered. A Control account needs a unique email.' });
    const bcrypt = require('bcryptjs');
    const control = await User.create({ email: normalizedEmail, password_hash: bcrypt.hashSync(password, 12), full_name: String(full_name).trim(), role: 'control', account_status: 'active', registration_complete: true, listing_credits: 0 });
    await logAdminAction(req, 'control_created', control, '', { control_id: String(control._id) });
    res.status(201).json({ success: true, control: { ...control.toObject(), id: control._id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CONTROL ACTION AUDIT / REVERSAL ─────────────────────────────────────────
router.get('/control-actions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 100)));
    const skip = (page - 1) * limit;
    const [total, actions] = await Promise.all([
      AdminAction.countDocuments({ actor_role: 'control' }),
      AdminAction.find({ actor_role: 'control' }).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    ]);
    res.json({ actions: actions.map(a => ({ ...a, id: a._id })), total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/control-actions/:id/reverse', async (req, res) => {
  try {
    const action = await AdminAction.findOne({ _id: req.params.id, actor_role: 'control', reversible: true });
    if (!action) return res.status(404).json({ error: 'Reversible control action not found' });
    if (action.reversed_at) return res.status(409).json({ error: 'This control action has already been reversed' });
    const meta = action.metadata || {};

    if (['seller_approved','seller_rejected'].includes(action.action)) {
      const seller = await User.findById(action.target_user_id);
      if (!seller) return res.status(404).json({ error: 'Seller no longer exists' });
      seller.seller_approval_status = meta.previous_status || 'pending';
      seller.seller_approval_reason = meta.previous_reason || '';
      seller.seller_approval_reviewed_at = null;
      seller.seller_approval_reviewed_by = meta.previous_reviewed_by || null;
      await seller.save();
      action.reversed_at = new Date(); action.reversed_by = req.user.id; await action.save();
      await logAdminAction(req, 'control_action_reversed', seller, `Reversed ${action.action}`, { original_action_id: String(action._id) });
      return res.json({ success: true });
    }
    return res.status(400).json({ error: 'This control action type cannot be reversed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
// GET /api/admin/users?q=&role=&status=&page=&limit=
router.get('/users', async (req, res) => {
  try {
    const { q, role, status, page = 1, limit = 20 } = req.query;
    const filter = { role: { $nin: ['admin', 'control'] } };
    if (role && role !== 'all') filter.role = role;
    if (status && status !== 'all') filter.account_status = status;
    if (q) {
      const re = new RegExp(q, 'i');
      filter.$or = [{ full_name: re }, { email: re }];
    }
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select('-password_hash -push_subscriptions -used_payment_refs')
      .sort({ created_at: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    // Attach listing counts
    const ids = users.map(u => u._id);
    const counts = await Listing.aggregate([
      { $match: { seller_id: { $in: ids }, status: { $ne: 'deleted' } } },
      { $group: { _id: '$seller_id', count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(counts.map(c => [String(c._id), c.count]));

    res.json({
      users: users.map(u => ({ ...u, id: u._id, listing_count: countMap[String(u._id)] || 0 })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/users/:id — full user profile
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password_hash -push_subscriptions -used_payment_refs').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [listings, orders, convCount, adminActions, userActivities, ratingsGiven, ratingsReceived] = await Promise.all([
      Listing.find({ seller_id: user._id, status: { $ne: 'deleted' } }).sort({ created_at: -1 }).limit(10).lean(),
      Order.find({ $or: [{ buyer_id: user._id }, { seller_id: user._id }] }).sort({ created_at: -1 }).limit(10).lean(),
      Conversation.countDocuments({ $or: [{ buyer_id: user._id }, { seller_id: user._id }] }),
      AdminAction.find({ target_user_id: user._id }).sort({ created_at: -1 }).limit(100).lean(),
      UserActivity.find({ user_id: user._id }).sort({ created_at: -1 }).limit(200).lean(),
      Order.find({ buyer_id: user._id, seller_rating: { $ne: null } }).select('seller_id seller_rating seller_review seller_rated_at listing_id').sort({ seller_rated_at: -1 }).limit(50).lean(),
      Order.find({ seller_id: user._id, buyer_rating: { $ne: null } }).select('buyer_id buyer_rating buyer_review buyer_rated_at listing_id').sort({ buyer_rated_at: -1 }).limit(50).lean(),
    ]);

    res.json({
      ...user, id: user._id,
      listings: listings.map(l => ({ ...l, id: l._id })),
      orders: orders.map(o => ({ ...o, id: o._id })),
      conv_count: convCount,
      admin_actions: adminActions.map(a => ({ ...a, id: a._id })),
      user_activities: userActivities.map(a => ({ ...a, id: a._id })),
      ratings_given: ratingsGiven,
      ratings_received: ratingsReceived,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/warn
router.post('/users/:id/warn', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required' });
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { account_status: 'warned', warn_reason: reason.trim(), warned_at: new Date() } },
      { new: true }
    ).select('-password_hash -push_subscriptions').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logAdminAction(req, 'user_warned', user, reason);
    res.json({ ...user, id: user._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/suspend
router.post('/users/:id/suspend', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Reason is required' });
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { account_status: 'suspended', suspend_reason: reason.trim(), suspended_at: new Date() } },
      { new: true }
    ).select('-password_hash -push_subscriptions').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logAdminAction(req, 'user_suspended', user, reason);
    res.json({ ...user, id: user._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/unsuspend
router.post('/users/:id/unsuspend', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { account_status: 'active', suspend_reason: '', suspended_at: null, warn_reason: '', warned_at: null } },
      { new: true }
    ).select('-password_hash -push_subscriptions').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    await logAdminAction(req, 'user_unsuspended', user);
    res.json({ ...user, id: user._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/message — send a system message/notification to a user
router.post('/users/:id/message', async (req, res) => {
  try {
    const { message, title } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    notifyUser(String(user._id), {
      title: '📣 Message from Bixcart Admin',
      body:  message.trim(),
      type:  'admin_message',
    }).catch(() => {});

    // Store message on user record for in-app inbox / popup modal
    await User.findByIdAndUpdate(req.params.id, {
      $push: {
        admin_messages: {
          title:   (title || '').trim(),
          content: message.trim(),
          sent_at: new Date(),
          read: false,
          acknowledged: false,
        },
      },
    });

    await logAdminAction(req, 'user_messaged', user, message.trim(), { title: (title || '').trim() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/users/:id', async (req, res) => {
  return res.status(410).json({ error: 'Direct account deletion is disabled. Users must request deletion and an admin must approve it.' });
});


// ── USER PROFILE REPORTS ─────────────────────────────────────────────────────
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

router.post('/user-reports/:id/resolve', async (req, res) => {
  try {
    const { fault_confirmed, admin_note = '', action = 'none' } = req.body;
    if (typeof fault_confirmed !== 'boolean') return res.status(400).json({ error: 'fault_confirmed must be true or false' });
    const report = await UserReport.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'User report not found' });
    if (report.status !== 'pending') return res.status(409).json({ error: 'Report has already been resolved' });

    const target = await User.findById(report.reported_user_id);
    if (!target) return res.status(404).json({ error: 'Reported user no longer exists' });

    report.status = fault_confirmed ? 'resolved' : 'dismissed';
    report.fault_confirmed = fault_confirmed;
    report.admin_note = String(admin_note || '').trim();
    report.resolved_at = new Date();
    report.resolved_by = req.user.id;
    await report.save();

    if (fault_confirmed) {
      const penalty = target.role === 'seller' ? 10 : 0;
      target.report_count = Number(target.report_count || 0) + 1;
      if (target.role === 'seller') target.discoverability_score = Math.max(0, Number(target.discoverability_score ?? 100) - penalty);
      await target.save();
    }

    if (action === 'warn') {
      target.account_status = 'warned';
      target.warn_reason = report.admin_note || 'A user report was upheld by an administrator.';
      target.warned_at = new Date();
      await target.save();
    } else if (action === 'suspend') {
      target.account_status = 'suspended';
      target.suspend_reason = report.admin_note || 'A user report was upheld by an administrator.';
      target.suspended_at = new Date();
      await target.save();
    }

    await logAdminAction(req, fault_confirmed ? 'user_report_upheld' : 'user_report_dismissed', target, report.admin_note, {
      report_id: String(report._id), action, fault_confirmed,
      discoverability_score: target.discoverability_score,
    });

    res.json({ success: true, report: { ...report.toObject(), id: report._id }, user: { id: target._id, full_name: target.full_name, account_status: target.account_status, discoverability_score: target.discoverability_score, report_count: target.report_count } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HOSTELS ──────────────────────────────────────────────────────────────────
// Admin-managed hostel catalog. Users choose from this list; room numbers remain free text.
router.get('/hostels', async (req, res) => {
  try {
    const hostels = await Hostel.find().sort({ sort_order: 1, name: 1 }).lean();
    res.json({ hostels: hostels.map(h => ({ ...h, id: h._id })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hostels', async (req, res) => {
  try {
    const { name, campus, is_active, sort_order } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Hostel name is required' });

    const hostel = await Hostel.create({
      name: String(name).trim(),
      campus: campus || 'Ajayi Crowther University',
      is_active: is_active !== false,
      sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
    });

    res.status(201).json({ ...hostel.toObject(), id: hostel._id });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'This hostel already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/hostels/:id', async (req, res) => {
  try {
    const { name, campus, is_active, sort_order } = req.body;
    const update = {};
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Hostel name is required' });
      update.name = String(name).trim();
    }
    if (campus !== undefined) update.campus = campus || 'Ajayi Crowther University';
    if (is_active !== undefined) update.is_active = !!is_active;
    if (sort_order !== undefined) update.sort_order = Number(sort_order) || 0;

    const hostel = await Hostel.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!hostel) return res.status(404).json({ error: 'Hostel not found' });
    res.json({ ...hostel.toObject(), id: hostel._id });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'This hostel already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/hostels/:id', async (req, res) => {
  try {
    const hostel = await Hostel.findByIdAndDelete(req.params.id);
    if (!hostel) return res.status(404).json({ error: 'Hostel not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELIVERY SPOTS ───────────────────────────────────────────────────────────
// Admin-managed list of popular on-campus meetup/delivery spots. Buyers pick
// from this list at checkout instead of typing a free-text location.
router.get('/delivery-spots', async (req, res) => {
  try {
    const spots = await DeliverySpot.find().sort({ sort_order: 1, name: 1 }).lean();
    res.json({ spots: spots.map(s => ({ ...s, id: s._id })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/delivery-spots', async (req, res) => {
  try {
    const { name, campus, is_active, sort_order } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Spot name is required' });

    const spot = await DeliverySpot.create({
      name: String(name).trim(),
      campus: campus || 'Ajayi Crowther University',
      is_active: is_active !== false,
      sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
    });

    res.status(201).json({ ...spot.toObject(), id: spot._id });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'This spot already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/delivery-spots/:id', async (req, res) => {
  try {
    const { name, campus, is_active, sort_order } = req.body;
    const update = {};
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Spot name is required' });
      update.name = String(name).trim();
    }
    if (campus !== undefined) update.campus = campus || 'Ajayi Crowther University';
    if (is_active !== undefined) update.is_active = !!is_active;
    if (sort_order !== undefined) update.sort_order = Number(sort_order) || 0;

    const spot = await DeliverySpot.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!spot) return res.status(404).json({ error: 'Spot not found' });
    res.json({ ...spot.toObject(), id: spot._id });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'This spot already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/delivery-spots/:id', async (req, res) => {
  try {
    const spot = await DeliverySpot.findByIdAndDelete(req.params.id);
    if (!spot) return res.status(404).json({ error: 'Spot not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BROADCAST MESSAGES ─────────────────────────────────────────────────────────
// Shared helper: build a Mongo filter for the recipient-selection filters
// used by both the recipient list and the "select all matching" send path.
function buildRecipientFilter(query) {
  const { q, role, status, verified, university } = query;
  const filter = { role: { $nin: ['admin', 'control'] } };
  if (role && role !== 'all') filter.role = role;
  if (status && status !== 'all') filter.account_status = status;
  if (verified === 'yes') filter.is_verified = true;
  if (verified === 'no')  filter.is_verified = false;
  if (university && university !== 'all') filter.university = university;
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ full_name: re }, { email: re }];
  }
  return filter;
}

// GET /api/admin/broadcast/universities — distinct universities, for the filter dropdown
router.get('/broadcast/universities', async (req, res) => {
  try {
    const list = await User.distinct('university', { role: { $ne: 'admin' } });
    res.json({ universities: list.filter(Boolean).sort() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/broadcast/recipients?q=&role=&status=&verified=&university=&page=&limit=
// Paginated list of users matching the filters, for the checkbox picker.
router.get('/broadcast/recipients', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = buildRecipientFilter(req.query);
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select('full_name email role account_status is_verified university avatar_url')
      .sort({ created_at: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    res.json({
      users: users.map(u => ({ ...u, id: u._id })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/broadcast/recipients/ids?...filters — all user ids matching the
// filters (no pagination). Used for "select all N users matching these filters".
router.get('/broadcast/recipients/ids', async (req, res) => {
  try {
    const filter = buildRecipientFilter(req.query);
    const ids = await User.find(filter).select('_id').lean();
    res.json({ ids: ids.map(u => String(u._id)), count: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/broadcast — send a message to a selected set of users.
// Body: { user_ids: [...], title, message, filters (optional, for audit history) }
router.post('/broadcast', async (req, res) => {
  try {
    const { user_ids, title, message, filters } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    if (!Array.isArray(user_ids) || !user_ids.length) {
      return res.status(400).json({ error: 'At least one recipient is required' });
    }
    // Safety cap so a bad payload can't fan out unbounded writes/pushes
    if (user_ids.length > 20000) {
      return res.status(400).json({ error: 'Too many recipients in a single broadcast' });
    }

    // Only message real, existing, non-admin users
    const validUsers = await User.find({ _id: { $in: user_ids }, role: { $ne: 'admin' } }).select('_id').lean();
    const validIds = validUsers.map(u => u._id);
    if (!validIds.length) return res.status(400).json({ error: 'No valid recipients found' });

    const broadcast = await Broadcast.create({
      title:           (title || '').trim(),
      content:         message.trim(),
      filters:         filters || {},
      recipient_ids:   validIds,
      recipient_count: validIds.length,
      sent_by:         req.user.id,
    });

    await User.updateMany(
      { _id: { $in: validIds } },
      { $push: { admin_messages: {
          title:   (title || '').trim(),
          content: message.trim(),
          sent_at: new Date(),
          read: false,
          acknowledged: false,
          broadcast_id: broadcast._id,
        } } }
    );

    // Best-effort push notifications, fire-and-forget
    validIds.forEach(id => {
      notifyUser(String(id), {
        title: title?.trim() ? `📣 ${title.trim()}` : '📣 Message from Bixcart Admin',
        body:  message.trim(),
        type:  'admin_broadcast',
      }).catch(() => {});
    });

    await logAdminAction(req, 'broadcast_sent', null, '', { broadcast_id: String(broadcast._id), recipient_count: validIds.length, title: (title || '').trim() });
    res.json({ success: true, recipient_count: validIds.length, broadcast_id: broadcast._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/broadcasts — history of past broadcasts with acknowledgment counts
router.get('/broadcasts', async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Broadcast.countDocuments();
    const broadcasts = await Broadcast.find()
      .sort({ created_at: -1 }).skip(skip).limit(parseInt(limit))
      .populate('sent_by', 'full_name email')
      .lean();

    const ids = broadcasts.map(b => b._id);
    const ackCounts = await User.aggregate([
      { $match: { 'admin_messages.broadcast_id': { $in: ids } } },
      { $unwind: '$admin_messages' },
      { $match: { 'admin_messages.broadcast_id': { $in: ids }, 'admin_messages.acknowledged': true } },
      { $group: { _id: '$admin_messages.broadcast_id', count: { $sum: 1 } } },
    ]);
    const ackMap = Object.fromEntries(ackCounts.map(a => [String(a._id), a.count]));

    res.json({
      broadcasts: broadcasts.map(b => ({
        ...b, id: b._id,
        acknowledged_count: ackMap[String(b._id)] || 0,
      })),
      total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LISTINGS ──────────────────────────────────────────────────────────────────
// GET /api/admin/listings?q=&status=&page=&limit=
router.get('/listings', async (req, res) => {
  try {
    const { q, status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    else filter.status = { $ne: 'deleted' };
    if (q) filter.$text = { $search: q };

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Listing.countDocuments(filter);
    const listings = await Listing.find(filter)
      .populate('seller_id', 'full_name email account_status')
      .sort({ created_at: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    res.json({
      listings: listings.map(l => ({
        ...l, id: l._id,
        seller_name:   l.seller_id?.full_name,
        seller_email:  l.seller_id?.email,
        seller_status: l.seller_id?.account_status,
      })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/listings/:id/status
router.patch('/listings/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active','pending','sold','deleted','flagged'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    const listing = await Listing.findByIdAndUpdate(
      req.params.id, { $set: { status } }, { new: true }
    ).lean();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ ...listing, id: listing._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/listings/:id — hard delete
router.delete('/listings/:id', async (req, res) => {
  try {
    const listing = await Listing.findByIdAndUpdate(
      req.params.id, { $set: { status: 'deleted' } }, { new: true }
    ).lean();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REPORTED CONVERSATIONS ────────────────────────────────────────────────────
// GET /api/admin/conversations?status=pending|resolved|all&page=&limit=
router.get('/conversations', async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const reportFilter = {};
    if (status && status !== 'all') reportFilter.status = status;

    const total   = await ConversationReport.countDocuments(reportFilter);
    const reports = await ConversationReport.find(reportFilter)
      .populate('reporter_id', 'full_name email')
      .populate('fault_user_id', 'full_name')
      .sort({ created_at: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    // Attach conversation details
    const convIds = reports.map(r => r.conversation_id);
    const convs = await Conversation.find({ _id: { $in: convIds } })
      .populate('buyer_id',   'full_name email account_status')
      .populate('seller_id',  'full_name email account_status')
      .populate('listing_id', 'title status')
      .lean();
    const convMap = Object.fromEntries(convs.map(c => [String(c._id), c]));

    res.json({
      conversations: reports.map(r => ({
        ...r,
        id: r._id,
        conversation: convMap[String(r.conversation_id)] || null,
      })),
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/conversations/:id — full thread (by report id OR conversation id)
router.get('/conversations/:id', async (req, res) => {
  try {
    // Try to find a report first; fall back to treating id as a conversation id
    let conv, report = null;
    report = await ConversationReport.findById(req.params.id)
      .populate('reporter_id', 'full_name email')
      .populate('fault_user_id', 'full_name email')
      .lean().catch(() => null);

    if (report) {
      conv = await Conversation.findById(report.conversation_id)
        .populate('buyer_id',   'full_name email')
        .populate('seller_id',  'full_name email')
        .populate('listing_id', 'title status price').lean();
    } else {
      conv = await Conversation.findById(req.params.id)
        .populate('buyer_id',   'full_name email')
        .populate('seller_id',  'full_name email')
        .populate('listing_id', 'title status price').lean();
    }
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const messages = await Message.find({ conversation_id: conv._id })
      .populate('sender_id', 'full_name role')
      .sort({ created_at: 1 }).lean();

    res.json({
      conversation: { ...conv, id: conv._id },
      report: report ? { ...report, id: report._id } : null,
      messages: messages.map(m => ({
        ...m, id: m._id,
        sender_name: m.sender_id?.full_name,
        sender_role: m.sender_id?.role,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/conversations/:reportId/resolve
router.post('/conversations/:reportId/resolve', async (req, res) => {
  try {
    const { fault_user_id, admin_note } = req.body;
    // fault_user_id can be null (no one at fault) or a valid user id
    const update = {
      status: 'resolved',
      fault_user_id: fault_user_id || null,
      admin_note: admin_note?.trim() || '',
      resolved_at: new Date(),
    };
    const report = await ConversationReport.findByIdAndUpdate(
      req.params.reportId, { $set: update }, { new: true }
    ).lean();
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ ...report, id: report._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/conversations/:reportId/notify — send notification message to one user
router.post('/conversations/:reportId/notify', async (req, res) => {
  try {
    const { user_id, message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    const report = await ConversationReport.findById(req.params.reportId).lean();
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const conv = await Conversation.findById(report.conversation_id).lean();
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const validUserIds = [String(conv.buyer_id), String(conv.seller_id)];
    if (!validUserIds.includes(String(user_id))) {
      return res.status(400).json({ error: 'User is not part of this conversation' });
    }

    const msg = await Message.create({
      conversation_id:       conv._id,
      sender_id:             req.user.id,
      receiver_id:           user_id,
      content:               message.trim(),
      is_admin_notification: true,
      notification_to:       user_id,
    });

    await Conversation.findByIdAndUpdate(conv._id, {
      $set: { last_message: '📣 Admin notification', last_message_at: new Date() },
    });

    const { notifyUser } = require('../db/push');
const { sendSellerDecisionEmail } = require('../utils/email');
    notifyUser(String(user_id), {
      title: '📣 Admin Notice',
      body: message.trim().slice(0, 100),
      type: 'admin_notification',
      url: `/pages/messages.html?conv=${conv._id}`,
    }).catch(() => {});

    res.json({ success: true, message_id: msg._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI FLAGGED CONTENT ────────────────────────────────────────────────────────
// GET /api/admin/flagged?type=all|conversations|listings
router.get('/flagged', async (req, res) => {
  try {
    const { type = 'all' } = req.query;
    const results = {};

    if (type === 'all' || type === 'conversations') {
      const convs = await Conversation.find({ ai_flagged: true })
        .populate('buyer_id',  'full_name email')
        .populate('seller_id', 'full_name email')
        .populate('listing_id','title')
        .sort({ ai_flagged_at: -1 }).lean();
      results.conversations = convs.map(c => ({ ...c, id: c._id }));
    }

    if (type === 'all' || type === 'listings') {
      const listings = await Listing.find({ ai_flagged: true })
        .populate('seller_id', 'full_name email')
        .sort({ ai_flagged_at: -1 }).lean();
      results.listings = listings.map(l => ({ ...l, id: l._id }));
    }

    const pendingCount = await Promise.all([
      Conversation.countDocuments({ ai_flagged: true, ai_reviewed: false }),
      Listing.countDocuments({ ai_flagged: true, ai_reviewed: false }),
    ]);
    results.pending_count = pendingCount[0] + pendingCount[1];

    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/flagged/conversations/:id/unflag
router.post('/flagged/conversations/:id/unflag', async (req, res) => {
  try {
    const { note } = req.body;
    const conv = await Conversation.findByIdAndUpdate(req.params.id, {
      $set: { ai_flagged: false, ai_reviewed: true, ai_flag_reason: note ? `[Cleared] ${note}` : '' },
    }, { new: true });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Notify both participants it's been cleared
    const notifyBoth = [String(conv.buyer_id), String(conv.seller_id)];
    notifyBoth.forEach(uid => notifyUser(uid, {
      title: '✅ Conversation Cleared',
      body:  'Your flagged conversation has been reviewed and cleared by an admin. You may continue.',
      type:  'ai_cleared',
      url:   `/pages/messages.html?conv=${conv._id}`,
    }).catch(() => {}));

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/flagged/listings/:id/unflag
router.post('/flagged/listings/:id/unflag', async (req, res) => {
  try {
    const { action = 'restore' } = req.body; // 'restore' | 'remove'
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const newStatus = action === 'remove' ? 'deleted' : 'active';
    await Listing.findByIdAndUpdate(req.params.id, {
      $set: { ai_flagged: false, ai_reviewed: true, status: newStatus },
    });

    notifyUser(String(listing.seller_id), {
      title: action === 'remove' ? '❌ Listing Removed' : '✅ Listing Restored',
      body:  action === 'remove'
        ? `Your listing "${listing.title}" was removed after admin review.`
        : `Your listing "${listing.title}" has been reviewed and is now visible again.`,
      type: 'ai_cleared',
    }).catch(() => {});

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
