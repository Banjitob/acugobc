require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { connectDb, Listing } = require('./db/database');
const { verifyTransport } = require('./utils/email');

const app = express();

// Trust proxy headers (needed for rate-limiter to see real IP behind Render/nginx)
app.set('trust proxy', 1);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: true }));

// Record authenticated, state-changing user actions without storing request bodies/passwords.
app.use('/api', (req, res, next) => {
  if (['GET','HEAD','OPTIONS'].includes(req.method) || req.path.startsWith('/admin')) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return next();
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    req.user = req.user || decoded;
    const started = Date.now();
    res.on('finish', () => {
      try {
        const { UserActivity } = require('./db/database');
        const action = `${req.method} ${req.path}`;
        UserActivity.create({ user_id: decoded.id, action, method: req.method, path: req.path, status_code: res.statusCode, metadata: { duration_ms: Date.now() - started } }).catch(() => {});
      } catch (_) {}
    });
  } catch (_) {}
  next();
});

// ─── Dynamic OG/SEO tags for shared listing links ─────────────────────────────
// Crawlers (WhatsApp, Twitter/X, Facebook, Telegram, etc.) don't run JS, so the
// listing page's <meta> tags need to be filled in server-side based on ?id=.
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

app.get('/pages/listing.html', async (req, res, next) => {
  try {
    const id = req.query.id;
    const filePath = path.join(__dirname, '../frontend/pages/listing.html');
    let html = fs.readFileSync(filePath, 'utf8');

    if (id) {
      const listing = await Listing.findById(id).populate('seller_id', 'full_name').lean();
      if (listing) {
        const siteUrl   = process.env.FRONTEND_URL || 'https://bixcart.onrender.com';
        const sellerName = listing.seller_id?.full_name || 'an ACU student';
        const title    = `${listing.title} — ₦${Number(listing.price).toLocaleString('en-NG')}`;
        const pageTitle = `${title} | Bixcart`;
        const description = `Buy "${listing.title}" from ${sellerName} on Bixcart — ₦${Number(listing.price).toLocaleString('en-NG')}. ${listing.description || ''}`.slice(0, 200).trim();
        const image    = listing.images?.[0] || `${siteUrl}/og-image.png`;
        const pageUrl  = `${siteUrl}/pages/listing.html?id=${id}`;

        html = html
          .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`)
          .replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${escapeHtml(description)}">`)
          .replace(/<meta property="og:title" content=".*?">/, `<meta property="og:title" content="${escapeHtml(title)}">`)
          .replace(/<meta property="og:description" content=".*?">/, `<meta property="og:description" content="${escapeHtml(description)}">`)
          .replace(/<meta property="og:url" content=".*?">/, `<meta property="og:url" content="${escapeHtml(pageUrl)}">`)
          .replace(/<meta property="og:image" content=".*?">/, `<meta property="og:image" content="${escapeHtml(image)}">`)
          .replace(/<meta property="og:image:width" content=".*?">/, '')
          .replace(/<meta property="og:image:height" content=".*?">/, '')
          .replace(/<meta property="og:image:alt" content=".*?">/, `<meta property="og:image:alt" content="${escapeHtml(listing.title)}">`)
          .replace(/<meta name="twitter:title" content=".*?">/, `<meta name="twitter:title" content="${escapeHtml(title)}">`)
          .replace(/<meta name="twitter:description" content=".*?">/, `<meta name="twitter:description" content="${escapeHtml(description)}">`)
          .replace(/<meta name="twitter:image" content=".*?">/, `<meta name="twitter:image" content="${escapeHtml(image)}">`);
      }
    }

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    next(); // fall through to static file on error
  }
});

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend')));
}

// API routes
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/listings', require('./routes/listings'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/orders',   require('./routes/orders'));
app.use('/api/cart',     require('./routes/cart'));
app.use('/api/uploads',  require('./routes/uploads'));
app.use('/api/push',     require('./routes/push'));
app.use('/api/admin',    require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString(), env: process.env.NODE_ENV })
);

// Catch-all for frontend SPA (production)
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
  });
}

const PORT = process.env.PORT || 3001;

const { startSweepScheduler } = require('./utils/sweepJob');

connectDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Bixcart running on http://localhost:${PORT}\n`);
      verifyTransport();    // test SMTP on startup
      startSweepScheduler(); // start 26-hour AI content sweep
    });
  })
  .catch(err => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
