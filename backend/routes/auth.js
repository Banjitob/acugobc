const mongoose = require('mongoose');
const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const { User, Order, Listing, Waitlist, Hostel, AdminAction, UserReport } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail, sendSellerApplicationEmail, sendSellerDecisionEmail } = require('../utils/email');
const { notifyUser } = require('../db/push');
const { listBanks, resolveBankAccount, createSubaccount } = require('../utils/paystack');
let getPredictedBanks = null;
try { getPredictedBanks = require('nuban-prediction'); } catch (_) { /* dependency is installed during deployment; keep server bootable before npm install */ }

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many attempts, please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many password reset requests. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, full_name: user.full_name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function safeUser(u) {
  const obj = u.toObject ? u.toObject() : { ...u };
  delete obj.password_hash;
  delete obj.email_verify_token;
  delete obj.email_verify_expires;
  delete obj.password_reset_token;
  delete obj.password_reset_expires;
  // Never expose Paystack subaccount identifiers to the browser. These are backend-only.
  delete obj.paystack_subaccount_code;
  obj.id = obj._id;
  return obj;
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

const PASSWORD_MIN = 8;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

function validatePassword(password) {
  if (!password || password.length < PASSWORD_MIN)
    return `Password must be at least ${PASSWORD_MIN} characters`;
  if (!PASSWORD_REGEX.test(password))
    return 'Password must contain uppercase, lowercase, and a number';
  return null;
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password, confirm_password, full_name, role } = req.body;

    if (!email || !password || !confirm_password || !full_name || !role)
      return res.status(400).json({ error: 'All fields are required' });

    if (!['buyer', 'seller'].includes(role))
      return res.status(400).json({ error: 'Role must be buyer or seller' });

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      return res.status(400).json({ error: 'Please enter a valid email address' });

    // Password strength
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    // Confirm password
    if (password !== confirm_password)
      return res.status(400).json({ error: 'Passwords do not match' });

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const verifyToken   = randomToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const user = await User.create({
      email: normalizedEmail,
      full_name,
      role,
      seller_approval_status: role === 'seller' ? 'pending' : 'approved',
      seller_approval_reason: '',
      password_hash:         bcrypt.hashSync(password, 12),
      registration_complete: false,
      email_verified:        false,
      email_verify_token:    verifyToken,
      email_verify_expires:  verifyExpires,
    });

    // Send verification email — non-blocking so registration still succeeds,
    // but errors are logged clearly so you can diagnose SMTP issues in Render logs
    sendVerificationEmail(user.email, verifyToken).catch(err => {
      console.error('[email] VERIFICATION EMAIL FAILED:', err.message);
      console.error('[email] SMTP config — host:', process.env.SMTP_HOST, 'port:', process.env.SMTP_PORT, 'user:', process.env.SMTP_USER);
    });

    res.json({
      token: signToken(user),
      user: safeUser(user),
      message: 'Account created. Please check your email to verify your address.',
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });

    if (['suspended','deletion_pending','deleted'].includes(user.account_status)) {
      const msg = user.account_status === 'deletion_pending' ? 'Your account deletion request is awaiting admin approval.' : user.account_status === 'deleted' ? 'This account has been deleted.' : 'Your account has been suspended. Contact support for assistance.';
      return res.status(403).json({ code: 'ACCOUNT_UNAVAILABLE', error: msg });
    }

    if (user.role === 'seller' && user.seller_approval_status === 'pending') {
      return res.status(403).json({
        code: 'SELLER_APPROVAL_PENDING',
        error: 'Your seller account is awaiting admin approval. Please allow up to 6 hours.',
        approval_status: 'pending',
        user: safeUser(user),
      });
    }
    if (user.role === 'seller' && user.seller_approval_status === 'rejected') {
      return res.status(403).json({
        code: 'SELLER_APPROVAL_REJECTED',
        error: 'Your seller application was rejected.',
        approval_status: 'rejected',
        reason: user.seller_approval_reason || 'No reason provided.',
        user: safeUser(user),
      });
    }

    res.json({ token: signToken(user), user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/auth/verify-email?token=… ──────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const user = await User.findOne({
      email_verify_token:   token,
      email_verify_expires: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ error: 'Verification link is invalid or has expired' });

    await User.findByIdAndUpdate(user._id, {
      $set: {
        email_verified:       true,
        email_verify_token:   null,
        email_verify_expires: null,
      },
    });

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/resend-verification ──────────────────────────────────────
router.post('/resend-verification', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email: email.toLowerCase() });

    // Always respond the same to prevent user enumeration
    if (!user || user.email_verified) {
      return res.json({ message: 'If that email is registered and unverified, a new link has been sent.' });
    }

    const verifyToken   = randomToken();
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await User.findByIdAndUpdate(user._id, {
      $set: { email_verify_token: verifyToken, email_verify_expires: verifyExpires },
    });

    sendVerificationEmail(user.email, verifyToken).catch(err => {
      console.error('[email] RESEND VERIFICATION FAILED:', err.message);
      console.error('[email] SMTP config — host:', process.env.SMTP_HOST, 'port:', process.env.SMTP_PORT, 'user:', process.env.SMTP_USER);
    });

    res.json({ message: 'If that email is registered and unverified, a new link has been sent.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
router.post('/forgot-password', forgotLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email: email.toLowerCase() });

    // Always same response to prevent user enumeration
    const genericMsg = { message: 'If that email is registered, a password reset link has been sent.' };

    if (!user) return res.json(genericMsg);

    const resetToken   = randomToken();
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1h

    await User.findByIdAndUpdate(user._id, {
      $set: {
        password_reset_token:   resetToken,
        password_reset_expires: resetExpires,
      },
    });

    sendPasswordResetEmail(user.email, resetToken).catch(err => {
      console.error('[email] PASSWORD RESET EMAIL FAILED:', err.message);
      console.error('[email] SMTP config — host:', process.env.SMTP_HOST, 'port:', process.env.SMTP_PORT, 'user:', process.env.SMTP_USER);
    });

    res.json(genericMsg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
router.post('/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password, confirm_password } = req.body;
    if (!token || !password || !confirm_password)
      return res.status(400).json({ error: 'All fields are required' });

    if (password !== confirm_password)
      return res.status(400).json({ error: 'Passwords do not match' });

    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const user = await User.findOne({
      password_reset_token:   token,
      password_reset_expires: { $gt: new Date() },
    });

    if (!user) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    await User.findByIdAndUpdate(user._id, {
      $set: {
        password_hash:          bcrypt.hashSync(password, 12),
        password_reset_token:   null,
        password_reset_expires: null,
      },
    });

    res.json({ success: true, message: 'Password reset successfully. You can now sign in.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/auth/vapid-public-key ──────────────────────────────────────────
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(404).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

// ─── GET /api/auth/paystack-public-key ───────────────────────────────────────
router.get('/paystack-public-key', (req, res) => {
  const key = process.env.PAYSTACK_PUBLIC_KEY;
  if (!key) return res.status(500).json({ error: 'Paystack not configured' });
  res.json({ publicKey: key });
});

// ─── GET /api/auth/deletion-status ───────────────────────────────────────────
router.get('/deletion-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('account_status deletion_requested_at deletion_reason deletion_reviewed_at deletion_approved_at deletion_retention_until').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password_hash -email_verify_token -password_reset_token');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.account_status === 'deleted' || user.account_status === 'deletion_pending') return res.status(403).json({ error: 'This account is unavailable.', code: 'ACCOUNT_DELETION' });
    const obj = user.toObject(); obj.id = obj._id;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/hostels', async (req, res) => {
  try {
    const hostels = await Hostel.find({ is_active: { $ne: false } }).sort({ sort_order: 1, name: 1 }).lean();
    res.json({ hostels: hostels.map(h => ({ ...h, id: h._id })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/auth/complete-registration ─────────────────────────────────────
router.put('/complete-registration', authMiddleware, async (req, res) => {
  try {
    const {
      full_name,
      business_name,
      seller_location_type,
      hostel_name,
      level,
      room_number,
      shop_name,
      shop_address,
      shop_number,
      delivery_info,
      id_type,
      id_front_url,
      id_back_url,
    } = req.body;

    const current = await User.findById(req.user.id);
    if (!current) return res.status(404).json({ error: 'User not found' });

    const allowedIdTypes = ['school_id', 'nin'];
    if (!full_name || !level || !id_type || !id_front_url || !id_back_url)
      return res.status(400).json({ error: 'Full name, level, ID type and both ID photos are required' });
    if (!allowedIdTypes.includes(id_type))
      return res.status(400).json({ error: 'Only ACU School ID and NIN are accepted' });
    const allowedLevels = ['100 Level','200 Level','300 Level','400 Level','500 Level'];
    if (!allowedLevels.includes(String(level).trim())) return res.status(400).json({ error: 'Please select a valid level' });

    const isSeller = current.role === 'seller';
    let locationType = isSeller ? String(seller_location_type || '').trim().toLowerCase() : 'hostel';
    if (!['hostel','shop'].includes(locationType)) {
      return res.status(400).json({ error: isSeller ? 'Choose either a hostel or a shop as your seller location' : 'Hostel is required' });
    }

    const cleanHostel = String(hostel_name || '').trim();
    const cleanRoom = String(room_number || '').trim();
    const cleanShop = String(shop_name || '').trim();
    const cleanShopNumber = String(shop_number || '').trim();
    const cleanShopAddress = String(shop_address || '').trim();

    if (locationType === 'hostel') {
      if (!cleanHostel || !cleanRoom) return res.status(400).json({ error: 'Hostel and room number are required when using a hostel location' });
      const validHostel = await Hostel.findOne({ name: cleanHostel, is_active: { $ne: false } }).lean();
      if (!validHostel) return res.status(400).json({ error: 'Please select a valid hostel from the approved hostel list' });
    } else {
      if (!cleanShop || !cleanShopNumber || !cleanShopAddress) {
        return res.status(400).json({ error: 'Shop name, shop number and shop address are required when using a shop location' });
      }
    }

    const update = {
      full_name: String(full_name).trim(),
      level: String(level).trim(),
      seller_location_type: locationType,
      hostel_name: locationType === 'hostel' ? cleanHostel : '',
      room_number: locationType === 'hostel' ? cleanRoom : '',
      id_type,
      id_front_url,
      id_back_url,
      registration_complete: true,
      delivery_info: delivery_info || '',
    };
    // Only sellers may set shop/business fields.
    if (current.role === 'seller') {
      update.business_name = String(business_name || '').trim();
      update.shop_name = locationType === 'shop' ? cleanShop : '';
      update.shop_number = locationType === 'shop' ? cleanShopNumber : '';
      update.shop_address = locationType === 'shop' ? cleanShopAddress : '';
      update.seller_approval_status = 'pending';
      update.seller_approval_reason = '';
      update.seller_approval_requested_at = new Date();
      update.seller_approval_reviewed_at = null;
      update.seller_approval_reviewed_by = null;
    } else {
      update.business_name = '';
      update.shop_name = '';
      update.shop_number = '';
      update.shop_address = '';
    }

    const user = await User.findByIdAndUpdate(
      req.user.id, { $set: update }, { new: true }
    ).select('-password_hash -email_verify_token -password_reset_token');

    if (current.role === 'seller') {
      // Notify every admin that a seller application is ready for review.
      const admins = await User.find({ role: 'admin' }).select('email full_name').lean();
      await Promise.all(admins.map(a => sendSellerApplicationEmail(a.email, { sellerName: user.full_name, sellerEmail: user.email, userId: user._id })).map(p => p.catch(err => console.error('[email] seller application notice failed:', err.message))));
    }

    const obj = user.toObject(); obj.id = obj._id;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /api/auth/profile ────────────────────────────────────────────────────
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const {
      full_name,
      bio,
      business_name,
      seller_location_type,
      hostel_name,
      level,
      room_number,
      shop_name,
      shop_address,
      shop_number,
      delivery_info,
      university,
      location,
      avatar_url,
      banner_url,
    } = req.body;
    const fixedUniversity = 'Ajayi Crowther University';
    const fixedLocation = 'Ajegunle, Oyo, Oyo State';
    const update = { full_name, bio };
    const currentProfileUser = await User.findById(req.user.id).select('role').lean();
    if (business_name !== undefined && currentProfileUser?.role === 'seller') update.business_name = business_name;
    if (level !== undefined) update.level = level;
    if (currentProfileUser?.role === 'seller') {
      const locationType = String(seller_location_type || '').trim().toLowerCase();
      if (locationType && !['hostel','shop'].includes(locationType)) {
        return res.status(400).json({ error: 'Seller location must be either hostel or shop' });
      }
      if (locationType === 'hostel') {
        const h = String(hostel_name || '').trim();
        const r = String(room_number || '').trim();
        if (!h || !r) return res.status(400).json({ error: 'Hostel and room number are required for a hostel location' });
        const validHostel = await Hostel.findOne({ name: h, is_active: { $ne: false } }).lean();
        if (!validHostel) return res.status(400).json({ error: 'Please select a valid hostel from the approved hostel list' });
        update.seller_location_type = 'hostel';
        update.hostel_name = h;
        update.room_number = r;
        update.shop_name = '';
        update.shop_number = '';
        update.shop_address = '';
      } else if (locationType === 'shop') {
        const sn = String(shop_name || '').trim();
        const snum = String(shop_number || '').trim();
        const sa = String(shop_address || '').trim();
        if (!sn || !snum || !sa) return res.status(400).json({ error: 'Shop name, shop number and shop address are required for a shop location' });
        update.seller_location_type = 'shop';
        update.shop_name = sn;
        update.shop_number = snum;
        update.shop_address = sa;
        update.hostel_name = '';
        update.room_number = '';
      } else if (hostel_name !== undefined || shop_name !== undefined || shop_number !== undefined || shop_address !== undefined) {
        return res.status(400).json({ error: 'Choose either hostel or shop as your seller location' });
      }
    } else {
      if (hostel_name !== undefined) update.hostel_name = hostel_name;
      if (room_number !== undefined) update.room_number = room_number;
      // Buyers cannot set or retain seller shop details.
      update.shop_name = '';
      update.shop_number = '';
      update.shop_address = '';
      update.seller_location_type = 'hostel';
    }
    if (delivery_info !== undefined) update.delivery_info = delivery_info;
    update.university = fixedUniversity;
    update.location = (typeof location === 'string' && location.trim()) ? location.trim() : fixedLocation;
    if (avatar_url   !== undefined) update.avatar_url     = avatar_url;
    if (banner_url   !== undefined) update.banner_url     = banner_url;
    const user = await User.findByIdAndUpdate(
      req.user.id, { $set: update }, { new: true }
    ).select('-password_hash -email_verify_token -password_reset_token');
    const obj = user.toObject(); obj.id = obj._id;
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Seller payment account / Paystack subaccount ────────────────────────────
router.get('/payout-bank-predictions', authMiddleware, async (req, res) => {
  try {
    const account_number = String(req.query.account_number || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(account_number)) return res.json({ predictions: [] });
    const predictions = typeof getPredictedBanks === 'function' ? getPredictedBanks(account_number).slice(0, 6) : [];
    res.json({ predictions });
  } catch (e) {
    res.json({ predictions: [] });
  }
});

router.get('/payout-banks', authMiddleware, async (req, res) => {
  try {
    const banks = await listBanks({ country: 'nigeria', perPage: 100, page: 1 });
    res.json({ banks: Array.isArray(banks) ? banks.filter(b => b.active !== false) : [] });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/resolve-bank-account', authMiddleware, async (req, res) => {
  try {
    const account_number = String(req.query.account_number || '').replace(/\D/g, '');
    const bank_code = String(req.query.bank_code || '').trim();
    if (!/^\d{10}$/.test(account_number) || !bank_code) return res.status(400).json({ error: 'A 10-digit account number and bank are required' });
    const result = await resolveBankAccount({ account_number, bank_code });
    res.json({ account_number, bank_code, account_name: result.account_name, verified: true });
  } catch (e) { res.status(400).json({ error: e.message || 'Could not resolve bank account' }); }
});

router.post('/payout-account', authMiddleware, async (req, res) => {
  try {
    const { bank_name, bank_code, account_number, account_name } = req.body;
    if (!bank_name || !bank_code || !account_number || !account_name) {
      return res.status(400).json({ error: 'Bank name, bank code, account number and account name are required' });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role !== 'seller') return res.status(403).json({ error: 'Only sellers can connect a payment account' });
    if (user.seller_approval_status !== 'approved') return res.status(403).json({ error: 'Your seller account must be approved before connecting a payment account' });

    const resolved = await resolveBankAccount({ account_number: String(account_number).trim(), bank_code: String(bank_code).trim() });
    const resolvedName = String(resolved.account_name || '').trim();
    if (!resolvedName) return res.status(400).json({ error: 'Paystack could not verify this account' });

    // Seller bank accounts are Paystack subaccounts. Checkout transactions are
    // split at payment time, so Bixcart never initiates a separate transfer.
    const subaccount = await createSubaccount({
      business_name: user.shop_name || user.business_name || user.full_name,
      bank_code: String(bank_code).trim(),
      account_number: String(account_number).trim(),
      percentage_charge: 0,
      description: `Bixcart seller account for ${user.full_name}`.slice(0, 200),
      primary_contact_email: user.email,
      primary_contact_name: resolvedName,
      primary_contact_phone: user.phone || '',
    });

    user.bank_name = String(bank_name).trim();
    user.bank_code = String(bank_code).trim();
    user.account_number = String(account_number).trim();
    user.account_name = resolvedName;
    user.paystack_subaccount_code = subaccount.subaccount_code;
    user.payout_status = 'ready';
    user.payout_error = '';
    await user.save();

    res.json({
      success: true, payout_status: user.payout_status,
      bank_name: user.bank_name, bank_code: user.bank_code,
      account_number: user.account_number, account_name: user.account_name,
    });
  } catch (e) {
    console.error('[payment-account]', e);
    const user = await User.findById(req.user.id).catch(() => null);
    if (user) { user.payout_status = 'failed'; user.payout_error = e.message || 'Could not connect payment account'; await user.save().catch(() => {}); }
    res.status(502).json({ error: e.message || 'Could not connect payment account' });
  }
});

// ─── PUT /api/auth/change-password ───────────────────────────────────────────
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    if (!current_password || !new_password || !confirm_password)
      return res.status(400).json({ error: 'All fields are required' });

    if (new_password !== confirm_password)
      return res.status(400).json({ error: 'New passwords do not match' });

    const pwErr = validatePassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!bcrypt.compareSync(current_password, user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' });

    user.password_hash = bcrypt.hashSync(new_password, 12);
    await user.save();

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/request-deletion ─────────────────────────────────────────
router.post('/request-deletion', authMiddleware, async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 10) return res.status(400).json({ error: 'Please provide a deletion reason of at least 10 characters.' });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Admin accounts cannot be deleted from this workflow.' });
    if (user.account_status === 'deletion_pending') return res.status(409).json({ error: 'Your deletion request is already awaiting admin approval.' });
    if (user.account_status === 'deleted') return res.status(409).json({ error: 'This account has already been deleted.' });
    user.account_status = 'deletion_pending';
    user.deletion_requested_at = new Date();
    user.deletion_reason = reason;
    user.deletion_reviewed_at = null;
    user.deletion_reviewed_by = null;
    user.deletion_approved_at = null;
    user.deletion_retention_until = null;
    await user.save();
    // Notify admins through the existing audit system's target data; admin UI can review the request.
    const { UserActivity } = require('../db/database');
    await UserActivity.create({ user_id: user._id, action: 'account_deletion_requested', method: 'POST', path: '/api/auth/request-deletion', metadata: { reason } });
    res.json({ success: true, status: 'deletion_pending', message: 'Your deletion request has been submitted for admin approval.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/auth/admin-messages ────────────────────────────────────────────
// Returns unacknowledged admin messages. Does NOT mark them as read/acknowledged —
// that only happens when the user explicitly presses the acknowledge button
// (see POST /admin-messages/:id/ack below), so a message can't be silently
// consumed just by the app fetching it in the background.
router.get('/admin-messages', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('admin_messages');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const unacknowledged = (user.admin_messages || []).filter(m => !m.acknowledged);

    res.json({
      messages: unacknowledged.map(m => ({
        id:      m._id,
        title:   m.title || '',
        content: m.content,
        sent_at: m.sent_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/admin-messages/:id/ack ───────────────────────────────────
// Marks a single admin message as acknowledged. Called only when the user
// presses the "I've read this" button on the popup.
router.post('/admin-messages/:id/ack', authMiddleware, async (req, res) => {
  try {
    const result = await User.updateOne(
      { _id: req.user.id, 'admin_messages._id': req.params.id },
      { $set: {
          'admin_messages.$.acknowledged': true,
          'admin_messages.$.acknowledged_at': new Date(),
          'admin_messages.$.read': true,
        } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: 'Message not found' });

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/auth/credits/verify ───────────────────────────────────────────
router.post('/credits/verify', authMiddleware, async (req, res) => {
  try {
    const { reference, credits } = req.body;
    if (!reference) return res.status(400).json({ error: 'reference required' });

    const _fetch = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

    const paystackRes  = await _fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const paystackData = await paystackRes.json();

    console.log('[credits/verify] Paystack response:', JSON.stringify(paystackData));

    if (!paystackData.status || paystackData.data?.status !== 'success') {
      console.error('[credits/verify] Not verified. status:', paystackData.data?.status, 'msg:', paystackData.message);
      return res.status(400).json({ error: 'Payment not verified: ' + (paystackData.message || paystackData.data?.gateway_response || 'unknown') });
    }

    const existing = await User.findOne({ used_payment_refs: reference });
    if (existing) return res.status(409).json({ error: 'Payment reference already used' });

    const CREDIT_TIERS = [
      { amountKobo: 60000,   credits: 1  },
      { amountKobo: 190000,  credits: 3  },
      { amountKobo: 600000,  credits: 10 },
      { amountKobo: 1650000, credits: 30 },
    ];
    const paidAmount  = paystackData.data.amount;
    const tier        = CREDIT_TIERS.find(t => t.amountKobo === paidAmount);
    const creditAmount = tier ? tier.credits : (credits ? parseInt(credits) : null);

    console.log('[credits/verify] paidAmount:', paidAmount, 'creditAmount:', creditAmount);

    if (!creditAmount || creditAmount < 1)
      return res.status(400).json({ error: 'Could not determine credits for this payment amount (paid: ' + paidAmount + ' kobo)' });

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $inc: { listing_credits: creditAmount }, $addToSet: { used_payment_refs: reference } },
      { new: true }
    ).select('-password_hash -email_verify_token -password_reset_token');

    console.log('[credits/verify] Success. New balance:', user.listing_credits);
    const obj = user.toObject(); obj.id = obj._id;
    res.json(obj);
  } catch (e) {
    console.error('[credits/verify] Exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/waitlist — join the waitlist (earns 6 listing credits on signup)
router.post('/waitlist', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });
    const normalised = email.toLowerCase().trim();
    // Check already registered
    const existing = await User.findOne({ email: normalised });
    if (existing) return res.status(409).json({ error: 'already_registered' });
    // Upsert into waitlist
    await Waitlist.findOneAndUpdate(
      { email: normalised },
      { email: normalised },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/seller-count — public, for first-50 badge display
router.get('/seller-count', async (req, res) => {
  try {
    const count = await User.countDocuments({ role: 'seller' });
    res.json({ count, bonus_available: count < 50 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/users/:id/profile — public profile (no auth required)
router.get('/users/:id/profile', async (req, res) => {
  try {
    let profileId = String(req.params.id || '').trim();
    // Prevent Mongoose CastError from malformed profile URLs such as [object Object].
    if (profileId.startsWith('{') && profileId.endsWith('}')) {
      try {
        const parsed = JSON.parse(profileId);
        profileId = String(parsed?.$oid || parsed?._id || parsed?.id || '').trim();
      } catch (_) {}
    }
    if (!mongoose.Types.ObjectId.isValid(profileId)) return res.status(400).json({ error: 'Invalid user profile ID' });
    const user = await User.findById(profileId)
      .select('full_name avatar_url bio university role rating rating_count business_name hostel_name room_number shop_name shop_number delivery_info created_at account_status is_verified report_count discoverability_score successful_sales_count')
      .lean();
    if (!user || user.account_status === 'suspended') return res.status(404).json({ error: 'User not found' });

    let extra = {};
    if (user.role === 'seller') {
      const listings = await Listing.find({ seller_id: user._id, status: { $ne: 'deleted' } })
        .select('title images price category status views').sort({ created_at: -1 }).lean();
      const completedOrders = await Order.countDocuments({ seller_id: user._id, status: 'completed' });
      const reviews = await Order.find({ seller_id: user._id, buyer_rating: { $ne: null } })
        .populate('buyer_id', 'full_name avatar_url')
        .select('buyer_rating buyer_review buyer_rated_at buyer_id')
        .sort({ buyer_rated_at: -1 }).limit(50).lean();
      const totalRated = await Order.countDocuments({ seller_id: user._id, buyer_rating: { $ne: null } });
      const highRated = await Order.countDocuments({ seller_id: user._id, buyer_rating: { $gte: 4 } });
      const highRatingPercent = totalRated ? (highRated / totalRated) * 100 : 0;
      const verified = completedOrders >= 100 && totalRated > 0 && highRatingPercent >= 95;
      if (verified !== !!user.is_verified) await User.findByIdAndUpdate(user._id, { $set: { is_verified: verified } });
      const reportCount = await UserReport.countDocuments({ reported_user_id: user._id, status: 'pending' });
      extra = { listings, completed_sales: completedOrders, reviews, total_ratings: totalRated, high_rating_percent: Math.round(highRatingPercent * 10) / 10, is_verified: verified, report_count: reportCount };
    } else {
      const purchases = await Order.countDocuments({ buyer_id: user._id, status: 'completed' });
      const reviews = await Order.find({ buyer_id: user._id, seller_rating: { $ne: null } })
        .populate('seller_id', 'full_name avatar_url')
        .select('seller_rating seller_review seller_rated_at seller_id')
        .sort({ seller_rated_at: -1 }).limit(50).lean();
      const totalRated = await Order.countDocuments({ buyer_id: user._id, seller_rating: { $ne: null } });
      const highRated = await Order.countDocuments({ buyer_id: user._id, seller_rating: { $gte: 4 } });
      const highRatingPercent = totalRated ? (highRated / totalRated) * 100 : 0;
      const verified = purchases >= 100 && totalRated > 0 && highRatingPercent >= 95;
      if (verified !== !!user.is_verified) await User.findByIdAndUpdate(user._id, { $set: { is_verified: verified } });
      const reportCount = await UserReport.countDocuments({ reported_user_id: user._id, status: 'pending' });
      extra = { purchases, reviews, total_ratings: totalRated, high_rating_percent: Math.round(highRatingPercent * 10) / 10, is_verified: verified, report_count: reportCount };
    }

    res.json({ ...user, id: user._id, ...extra });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// POST /api/auth/users/:id/report — report a user from their public profile
router.post('/users/:id/report', authMiddleware, async (req, res) => {
  try {
    const reporterId = req.user.id;
    const targetId = String(req.params.id || '').trim();
    const { reason } = req.body;
    if (!mongoose.Types.ObjectId.isValid(targetId)) return res.status(400).json({ error: 'Invalid user ID' });
    if (String(reporterId) === targetId) return res.status(400).json({ error: 'You cannot report yourself' });
    if (!reason?.trim()) return res.status(400).json({ error: 'A report reason is required' });
    const target = await User.findById(targetId).select('full_name role account_status').lean();
    if (!target || target.role === 'admin' || target.account_status === 'deleted') return res.status(404).json({ error: 'User not found' });
    const existing = await UserReport.findOne({ reported_user_id: targetId, reporter_id: reporterId, status: 'pending' });
    if (existing) return res.status(409).json({ error: 'You have already submitted a pending report for this user' });
    const report = await UserReport.create({ reported_user_id: targetId, reporter_id: reporterId, reason: reason.trim() });
    res.json({ success: true, report_id: report._id, message: 'Report submitted. An admin will review it.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
