const express = require('express');
const router  = express.Router();
const { Event, EventInterest, User } = require('../db/database');
const { authMiddleware, optionalAuth, promoterApprovalMiddleware } = require('../middleware/auth');
const { notifyUser } = require('../db/push');
const { moderateListing } = require('../utils/aiModerator');

const ALLOWED_CATEGORIES = ['Party', 'Concert', 'Workshop', 'Seminar', 'Sports', 'Other'];

function shapeEvent(e, extra = {}) {
  return {
    ...e,
    id: e._id,
    promoter_id: e.promoter_id?._id || e.promoter_id,
    promoter_name: e.promoter_id?.full_name,
    promoter_university: e.promoter_id?.university,
    ...extra,
  };
}

// GET /api/events — public browsing. Only 'active' (non-flagged, non-removed)
// events with a start date in the future (or still today) show up by default.
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, q, upcoming_only = 'true', page = 1, limit = 20 } = req.query;
    const filter = { status: 'active' };
    if (upcoming_only !== 'false') filter.event_date = { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) }; // small grace window for events happening "now"
    if (category && category !== 'All') filter.category = category;
    if (q) filter.$or = [
      { title: { $regex: q, $options: 'i' } },
      { description: { $regex: q, $options: 'i' } },
    ];

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, events] = await Promise.all([
      Event.countDocuments(filter),
      Event.find(filter).populate('promoter_id', 'full_name university').sort({ event_date: 1 }).skip(skip).limit(parseInt(limit)).lean(),
    ]);

    let interestedIds = new Set();
    if (req.user) {
      const mine = await EventInterest.find({ user_id: req.user.id, event_id: { $in: events.map(e => e._id) } }).select('event_id').lean();
      interestedIds = new Set(mine.map(m => String(m.event_id)));
    }

    res.json({
      events: events.map(e => shapeEvent(e, { interested: interestedIds.has(String(e._id)) })),
      total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/events/mine — the logged-in promoter's own events (any status).
router.get('/mine', promoterApprovalMiddleware, async (req, res) => {
  try {
    const events = await Event.find({ promoter_id: req.user.id }).sort({ event_date: -1 }).lean();
    res.json(events.map(e => shapeEvent(e)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate('promoter_id', 'full_name university').lean();
    if (!event || event.status === 'removed') return res.status(404).json({ error: 'Event not found' });
    // Only the host can view their own flagged/pending event before it's cleared.
    if (event.status === 'flagged' && String(event.promoter_id?._id) !== String(req.user?.id))
      return res.status(404).json({ error: 'Event not found' });

    Event.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec();

    let interested = false;
    if (req.user) interested = !!(await EventInterest.findOne({ user_id: req.user.id, event_id: req.params.id }).lean());

    res.json(shapeEvent(event, { interested }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/events — create an event (approved promoters only).
router.post('/', promoterApprovalMiddleware, async (req, res) => {
  try {
    const { title, description, category, banner_image, location, event_date, end_date, price_info, contact_info } = req.body;
    if (!title || !description || !location || !event_date)
      return res.status(400).json({ error: 'Title, description, location, and date are required' });

    const startDate = new Date(event_date);
    if (isNaN(startDate.getTime()) || startDate < new Date(Date.now() - 60 * 60 * 1000))
      return res.status(400).json({ error: 'Please choose a valid date in the future' });
    let endDate = null;
    if (end_date) {
      endDate = new Date(end_date);
      if (isNaN(endDate.getTime()) || endDate < startDate) return res.status(400).json({ error: 'End date must be after the start date' });
    }
    const finalCategory = ALLOWED_CATEGORIES.includes(category) ? category : 'Other';

    const event = await Event.create({
      promoter_id: req.user.id,
      title: String(title).trim().slice(0, 120),
      description: String(description).trim().slice(0, 2000),
      category: finalCategory,
      banner_image: banner_image || null,
      location: String(location).trim().slice(0, 200),
      event_date: startDate,
      end_date: endDate,
      price_info: String(price_info || 'Free entry').trim().slice(0, 100),
      contact_info: String(contact_info || '').trim().slice(0, 200),
    });

    // AI moderation (non-blocking) — same content check used for listings.
    setImmediate(async () => {
      try {
        const result = await moderateListing({ title, description, category: finalCategory });
        if (result.flagged) {
          await Event.findByIdAndUpdate(event._id, { $set: { status: 'flagged', ai_flagged: true, ai_flag_reason: result.reason } });
          notifyUser(String(req.user.id), {
            title: '⚠️ Event Hidden by AI',
            body: `Your event "${title}" was flagged: ${result.reason}. It has been hidden pending admin review.`,
            type: 'ai_flag',
          }).catch(() => {});
        }
      } catch (e) { console.warn('[AI mod] event check failed:', e.message); }
    });

    res.status(201).json(shapeEvent({ ...event.toObject(), promoter_id: req.user.id }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', promoterApprovalMiddleware, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (String(event.promoter_id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (event.status === 'removed') return res.status(400).json({ error: 'This event has been removed and cannot be edited' });

    const { title, description, category, banner_image, location, event_date, end_date, price_info, contact_info } = req.body;
    const update = {};
    if (title !== undefined) update.title = String(title).trim().slice(0, 120);
    if (description !== undefined) update.description = String(description).trim().slice(0, 2000);
    if (category !== undefined) update.category = ALLOWED_CATEGORIES.includes(category) ? category : 'Other';
    if (banner_image !== undefined) update.banner_image = banner_image;
    if (location !== undefined) update.location = String(location).trim().slice(0, 200);
    if (price_info !== undefined) update.price_info = String(price_info).trim().slice(0, 100);
    if (contact_info !== undefined) update.contact_info = String(contact_info).trim().slice(0, 200);
    if (event_date !== undefined) {
      const d = new Date(event_date);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid event date' });
      update.event_date = d;
    }
    if (end_date !== undefined) update.end_date = end_date ? new Date(end_date) : null;

    const updated = await Event.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
    res.json(shapeEvent(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', promoterApprovalMiddleware, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (String(event.promoter_id) !== String(req.user.id)) return res.status(403).json({ error: 'Forbidden' });
    await Event.findByIdAndUpdate(req.params.id, { $set: { status: 'removed' } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/events/:id/interest — toggle "I'm interested" for any logged-in user.
router.post('/:id/interest', authMiddleware, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event || event.status !== 'active') return res.status(404).json({ error: 'Event not found' });

    const existing = await EventInterest.findOne({ user_id: req.user.id, event_id: req.params.id });
    if (existing) {
      await existing.deleteOne();
      await Event.findByIdAndUpdate(req.params.id, { $inc: { interested_count: -1 } });
      return res.json({ interested: false });
    }
    await EventInterest.create({ user_id: req.user.id, event_id: req.params.id });
    await Event.findByIdAndUpdate(req.params.id, { $inc: { interested_count: 1 } });
    res.json({ interested: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ interested: true }); // race — already marked interested
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
