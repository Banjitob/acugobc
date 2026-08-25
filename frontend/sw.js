// Bixcart Service Worker — Push Notifications
const CACHE = 'bixcart-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => clients.claim());

// ── PUSH HANDLER ──
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); }
  catch { payload = { title: 'Bixcart', body: e.data.text(), type: 'generic' }; }

  const options = {
    body: payload.body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: payload.tag || payload.type || 'bixcart',
    renotify: true,
    data: { url: payload.url || '/pages/messages.html', type: payload.type },
    actions: [],
  };

  if (payload.type === 'message') {
    options.actions = [{ action: 'reply', title: 'Open chat' }];
  } else if (payload.type === 'like') {
    options.actions = [{ action: 'view', title: 'View listing' }];
  }

  e.waitUntil(self.registration.showNotification(payload.title || 'Bixcart', options));
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/pages/messages.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) { c.focus(); c.navigate(url); return; }
      }
      clients.openWindow(url);
    })
  );
});
