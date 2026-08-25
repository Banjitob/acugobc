const express   = require('express');
const router    = express.Router();
const multer    = require('multer');
const cloudinary = require('cloudinary').v2;
const { authMiddleware } = require('../middleware/auth');

// Configure Cloudinary from env vars
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Store files in memory (no disk needed)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// POST /api/uploads/image
// Returns { url } — a Cloudinary CDN URL
router.post('/image', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder:    'bixcart/listings',
          public_id: `${req.user.id}_${Date.now()}`,
          transformation: [
            { width: 1200, height: 1200, crop: 'limit', quality: 'auto:good', fetch_format: 'auto' }
          ],
        },
        (err, result) => { if (err) reject(err); else resolve(result); }
      );
      stream.end(req.file.buffer);
    });

    res.json({ url: result.secure_url });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

module.exports = router;
