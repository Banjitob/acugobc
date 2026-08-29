// push.js — send Web Push notifications to a user's saved subscriptions
// Uses the Web Push Protocol directly (no external library needed for simple cases,
// but we support webpush via optional dep). Falls back gracefully if not installed.

let webpush;
try { webpush = require('web-push'); } catch { webpush = null; }

const { User } = require('./database');

/**
 * Send a push notification to all subscriptions for a user.
 * @param {string} userId  - MongoDB ObjectId string
 * @param {object} payload - { title, body, type, url, tag }
 */
async function notifyUser(userId, payload) {
  if (!webpush) return; // web-push not installed, skip silently

  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail   = process.env.VAPID_EMAIL || 'mailto:admin@bixcart.app';

  if (!vapidPublic || !vapidPrivate) {
    console.warn('[push] VAPID keys not set — push notifications disabled. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL in .env');
    return;
  }

  webpush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate);

  const user = await User.findById(userId).lean();
  if (!user?.push_subscriptions?.length) return;

  const text = JSON.stringify(payload);
  const deadSubs = [];

  await Promise.all(user.push_subscriptions.map(async sub => {
    try {
      await webpush.sendNotification(sub, text);
    } catch (err) {
      // 410 Gone = subscription expired/unregistered
      if (err.statusCode === 410 || err.statusCode === 404) {
        deadSubs.push(sub.endpoint);
      }
    }
  }));

  // Clean up dead subs
  if (deadSubs.length) {
    await User.findByIdAndUpdate(userId, {
      $pull: { push_subscriptions: { endpoint: { $in: deadSubs } } }
    });
  }
}

module.exports = { notifyUser };
