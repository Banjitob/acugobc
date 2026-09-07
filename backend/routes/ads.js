const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const cloudinary = require('cloudinary').v2;
const { Advertisement, getAdPricePerDayKobo } = require('../db/database');
const { initializeTransaction, verifyTransaction } = require('../utils/paystack');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Ad image upload is folded into /submit below rather than exposed as its own
// endpoint — a standalone public (no-login) image upload route would be an
// easy abuse vector for hosting arbitrary images. Tying the upload to a
// specific paid ad submission keeps it traceable and rate-limited by cost.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// POST /api/ads/submit — no login required; any business can advertise.
// Payment happens immediately at submission time; admin content review
// happens afterward (payment doesn't guarantee airtime — see admin.js).
router.post('/submit', upload.single('image'), async (req, res) => {
  try {
    const { business_name, contact_email, contact_phone, title, link_url, duration_days } = req.body;
    if (!business_name || !contact_email || !title || !req.file)
      return res.status(400).json({ error: 'Business name, contact email, title, and an image are required' });
    const days = parseInt(duration_days, 10);
    if (!Number.isFinite(days) || days < 1 || days > 90)
      return res.status(400).json({ error: 'Duration must be between 1 and 90 days' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email))
      return res.status(400).json({ error: 'Please provide a valid contact email' });

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'bixcart/ads', transformation: [{ width: 1600, height: 500, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }] },
        (err, result) => { if (err) reject(err); else resolve(result); }
      );
      stream.end(req.file.buffer);
    });

    const pricePerDayKobo = await getAdPricePerDayKobo();
    const amountKobo = pricePerDayKobo * days;

    const ad = await Advertisement.create({
      business_name: String(business_name).trim().slice(0, 120),
      contact_email: String(contact_email).trim().toLowerCase(),
      contact_phone: String(contact_phone || '').trim().slice(0, 30),
      title: String(title).trim().slice(0, 100),
      image_url: uploadResult.secure_url,
      link_url: String(link_url || '').trim().slice(0, 500),
      duration_days: days,
      amount_kobo: amountKobo,
    });

    const reference = 'bixcart_ad_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    try {
      const appUrl = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
      const payment = await initializeTransaction({
        email: ad.contact_email,
        amount: amountKobo,
        currency: 'NGN',
        reference,
        callback_url: `${appUrl}/pages/advertise.html?payment=success&reference=${encodeURIComponent(reference)}`,
        metadata: { type: 'advertisement', ad_id: String(ad._id) },
      });
      ad.payment_reference = reference;
      await ad.save();
      res.json({ reference, authorization_url: payment.authorization_url, access_code: payment.access_code, amount_kobo: amountKobo });
    } catch (e) {
      await Advertisement.findByIdAndDelete(ad._id).catch(() => {});
      throw e;
    }
  } catch (e) {
    console.error('[ads/submit] failed:', e);
    res.status(502).json({ error: e.message || 'Could not start payment' });
  }
});

// Shared finalize logic — called both by the buyer-facing verify endpoint
// (after Paystack redirects back) and the Paystack webhook, so payment is
// recorded even if the advertiser closes their browser mid-redirect.
async function finalizeAdPayment(reference) {
  const ad = await Advertisement.findOne({ payment_reference: reference });
  if (!ad) throw new Error('Advertisement not found for this reference');
  if (ad.payment_status === 'paid') return ad; // already processed — idempotent

  const verified = await verifyTransaction(reference);
  if (verified.status !== 'success') {
    ad.payment_status = 'failed';
    await ad.save();
    throw new Error('Payment was not successful');
  }
  if (Number(verified.amount) !== Number(ad.amount_kobo)) {
    throw new Error('Paid amount does not match the expected amount');
  }
  ad.payment_status = 'paid';
  await ad.save();
  return ad;
}
router.finalizeAdPayment = finalizeAdPayment;

// GET /api/ads/verify/:reference — polled by advertise.html after the
// Paystack redirect completes.
router.get('/verify/:reference', async (req, res) => {
  try {
    const ad = await finalizeAdPayment(req.params.reference);
    res.json({ success: true, status: ad.payment_status, review_status: ad.review_status });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// GET /api/ads/price — public; the advertise page needs to show the real
// current rate, not a guessed fallback that could mismatch what's charged.
router.get('/price', async (req, res) => {
  try {
    const priceKobo = await getAdPricePerDayKobo();
    res.json({ price_per_day_kobo: priceKobo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ads/active — public, for the marketplace top banner. Only
// approved, paid, currently-in-window ads are returned.
router.get('/active', async (req, res) => {
  try {
    const now = new Date();
    const ads = await Advertisement.find({
      payment_status: 'paid',
      review_status: 'approved',
      starts_at: { $lte: now },
      ends_at: { $gte: now },
    }).select('title image_url link_url business_name').sort({ starts_at: 1 }).lean();
    res.json(ads.map(a => ({ ...a, id: a._id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ads/:id/click — fire-and-forget analytics, no auth needed.
router.post('/:id/click', async (req, res) => {
  Advertisement.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } }).exec();
  res.json({ ok: true });
});

// POST /api/ads/:id/impression
router.post('/:id/impression', async (req, res) => {
  Advertisement.findByIdAndUpdate(req.params.id, { $inc: { impressions: 1 } }).exec();
  res.json({ ok: true });
});

module.exports = router;
