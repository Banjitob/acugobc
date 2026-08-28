// ── CONFIG ──
const API_BASE = '/api';

// ── API CLIENT ──
const api = {
  async request(method, path, body, auth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = localStorage.getItem('cm_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    // Prevent dashboard sections from staying on "Loading…" forever when a request hangs.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method, headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('Request timed out. Please try again.');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    let data;
    try { data = await res.json(); }
    catch { data = { error: 'Server returned an invalid response' }; }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  get:    (path, auth)       => api.request('GET',    path, null, auth),
  post:   (path, body, auth) => api.request('POST',   path, body, auth),
  put:    (path, body, auth) => api.request('PUT',    path, body, auth),
  patch:  (path, body, auth) => api.request('PATCH',  path, body, auth),
  delete: (path, auth)       => api.request('DELETE', path, null, auth),
};

// ── AUTH STATE ──
const auth = {
  getToken: ()  => localStorage.getItem('cm_token'),
  getUser:  ()  => { try { return JSON.parse(localStorage.getItem('cm_user')); } catch { return null; } },
  isLoggedIn:() => !!auth.getToken(),
  save(token, user) { localStorage.setItem('cm_token', token); localStorage.setItem('cm_user', JSON.stringify(user)); },
  clear() { localStorage.removeItem('cm_token'); localStorage.removeItem('cm_user'); },
  requireAuth(redirect = '/pages/auth.html') {
    if (!auth.isLoggedIn()) { window.location.href = redirect; return false; }
    return true;
  },
  requireBuyer() {
    const u = auth.getUser();
    if (!u || u.role !== 'buyer') { window.location.href = '/pages/seller-dashboard.html'; return false; }
    return true;
  },
  requireSeller() {
    const u = auth.getUser();
    if (!u || u.role !== 'seller') { window.location.href = '/pages/buyer-dashboard.html'; return false; }
    return true;
  },
};

// ── CART ──
const cartState = {
  ids: new Set(),
  count: 0,
};

function isInCart(listingId) {
  return cartState.ids.has(String(listingId));
}

function updateCartBadge(count) {
  cartState.count = Number(count) || 0;
  const badge = document.getElementById('nav-cart-badge');
  if (!badge) return;
  if (cartState.count > 0) { badge.textContent = cartState.count > 99 ? '99+' : cartState.count; badge.style.display = 'flex'; }
  else badge.style.display = 'none';
}

function syncCartButtons() {
  document.querySelectorAll('[data-cart-listing-id]').forEach(btn => {
    const id = btn.getAttribute('data-cart-listing-id');
    const inCart = isInCart(id);
    btn.classList.toggle('in-cart', inCart);
    btn.title = inCart ? 'In cart — view cart' : 'Add to cart';
    if (btn.dataset.cartType === 'card') {
      btn.innerHTML = inCart ? icons.check : icons.shoppingBag;
      btn.setAttribute('aria-label', inCart ? 'In cart' : 'Add to cart');
    }
  });
}

async function refreshCartState() {
  if (!auth.isLoggedIn()) return;
  try {
    const items = await api.get('/cart');
    cartState.ids = new Set((items || []).map(i => String(i.id || i.listing_id || i._id)));
    updateCartBadge(items?.length || 0);
    syncCartButtons();
  } catch (e) {
    // Keep the navigation usable if cart loading fails.
  }
}

const cart = {
  async add(listingId) {
    const r = await api.post('/cart/add', { listing_id: listingId });
    cartState.ids.add(String(listingId));
    updateCartBadge(r.count);
    syncCartButtons();
    return r;
  },
  async remove(listingId) {
    const r = await api.delete(`/cart/${listingId}`);
    cartState.ids.delete(String(listingId));
    updateCartBadge(r.count);
    syncCartButtons();
    return r;
  },
  list()  { return api.get('/cart'); },
  async clear() {
    const r = await api.delete('/cart');
    cartState.ids.clear();
    updateCartBadge(0);
    syncCartButtons();
    return r;
  },
};

async function refreshCartBadge() {
  await refreshCartState();
}

// Quick add-to-cart, used from product cards and the listing page.
// Once an item is added, every visible instance of that listing updates.
async function addToCart(e, id, btn) {
  if (e) e.stopPropagation();
  if (!auth.isLoggedIn()) { window.location.href = '/pages/auth.html'; return; }
  if (isInCart(id)) { window.location.href = '/pages/cart.html'; return; }
  const original = btn?.innerHTML;
  try {
    if (btn) { btn.disabled = true; btn.innerHTML = icons.loader; }
    await cart.add(id);
    toast('Added to cart', 'success');
    syncCartButtons();
    if (btn) btn.disabled = false;
  } catch (err) {
    toast(err.message, 'error');
    if (btn) { btn.innerHTML = original; btn.disabled = false; }
  }
}

// ── TOAST ──
function ensureToastContainer() {
  let c = document.getElementById('toast-container');
  if (!c) { c = document.createElement('div'); c.id = 'toast-container'; document.body.appendChild(c); }
  return c;
}
function toast(message, type = 'default', duration = 3500) {
  const c = ensureToastContainer();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const iconMap = { success: icons.check, error: icons.alertCircle, warning: icons.alertTriangle, default: icons.info };
  el.innerHTML = `<span style="flex-shrink:0">${iconMap[type] || iconMap.default}</span><span>${message}</span>`;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 320); }, duration);
}

// ── FORMAT HELPERS ──
function formatPrice(p) { return '₦' + parseFloat(p).toLocaleString('en-NG', {minimumFractionDigits: 0, maximumFractionDigits: 0}); }

// Human-readable delivery window — '6h' -> '6 hours', etc.
function windowLabel(w) {
  const map = { '5m': '5 minutes', '6h': '6 hours', '12h': '12 hours', '1d': '1 day', '3d': '3 days', '7d': '7 days' };
  return map[w] || w || '1 day';
}

// The backend order status has several in-between states (paid, confirmed,
// fulfilled, completing...) that exist for the payment/accept/fulfil pipeline, but
// the buyer and seller only need to see three buckets: an order that hasn't been
// verified with the delivery code yet is "pending", no matter which internal step
// it's on; verified orders are "completed"; everything else is "cancelled".
function orderDisplayStatus(o) {
  if (o.status === 'completed') return 'completed';
  if (o.status === 'cancelled') return 'cancelled';
  return 'pending';
}

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d);
  const now = new Date();
  const diff = now - date;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff/86400000) + 'd ago';
  return date.toLocaleDateString('en-NG', { month: 'short', day: 'numeric' });
}
function formatCurrency(n) { return '₦' + parseFloat(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 0 }); }
function getInitials(name) { return (name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2); }
function conditionColor(c) {
  const map = { 'New': 'green', 'Like New': 'green', 'Good': 'amber', 'Fair': 'amber' };
  return map[c] || 'surface';
}
function conditionDot(c) {
  const map = { 'New': 'cond-new', 'Like New': 'cond-like-new', 'Good': 'cond-good', 'Fair': 'cond-fair' };
  return `<span class="condition-dot ${map[c] || ''}"></span>`;
}
function statusBadge(s) {
  const map = { active: ['green','Active'], pending: ['amber','Pending'], sold: ['blue','Sold'], deleted: ['red','Deleted'], confirmed: ['green','Confirmed'], completed: ['blue','Completed'], cancelled: ['red','Cancelled'] };
  const [cls, label] = map[s] || ['surface', s];
  return `<span class="badge badge-${cls}">${label}</span>`;
}
function stars(rating, count) {
  const filled = Math.round(rating || 0);
  let html = '<div class="stars">';
  for (let i = 1; i <= 5; i++) {
    html += `<svg viewBox="0 0 24 24" fill="${i <= filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>`;
  }
  html += '</div>';
  if (count !== undefined) html += `<span class="text-sm text-muted">(${count})</span>`;
  return html;
}

// ── PRODUCT CARD ──
function productCardHTML(listing, saved = false) {
  const imgContent = listing.images?.length
    ? `<img src="${listing.images[0]}" alt="${listing.title}" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="product-card-img-placeholder">${icons.package}</div>`;

  const user = auth.getUser();
  const isOwnListing = user && String(user.id) === String(listing.seller_id);
  const canAddToCart = listing.status === 'active' && !isOwnListing && user?.role === 'buyer';

  const discount = listing.original_price && listing.original_price > listing.price
    ? Math.round((1 - listing.price / listing.original_price) * 100) : 0;
  const isNew = listing.created_at && (Date.now() - new Date(listing.created_at).getTime()) < 3 * 24 * 60 * 60 * 1000;
  const cornerBadge = discount >= 10
    ? `<span class="product-card-corner-badge discount">-${discount}%</span>`
    : (isNew ? `<span class="product-card-corner-badge new">New</span>` : '');

  return `
  <div class="product-card card-hover" data-id="${listing.id}" onclick="viewListing('${listing.id}')">
    <div class="product-card-img">
      ${imgContent}
      ${cornerBadge}
      ${user?.role !== 'seller' ? `<button class="product-card-save ${saved ? 'saved' : ''}" data-id="${listing.id}" onclick="toggleSave(event,'${listing.id}',this)" title="${saved ? 'Unsave' : 'Save'}">${saved ? icons.heartFilled : icons.heart}</button>` : ''}
      ${canAddToCart ? `<button class="product-card-cart-btn ${isInCart(listing.id) ? 'in-cart' : ''}" data-id="${listing.id}" data-cart-listing-id="${listing.id}" data-cart-type="card" onclick="addToCart(event,'${listing.id}',this)" title="${isInCart(listing.id) ? 'In cart — view cart' : 'Add to cart'}">${isInCart(listing.id) ? icons.check : icons.shoppingBag}</button>` : ''}
      ${listing.status === 'sold' ? `<div style="position:absolute;inset:0;background:rgba(24,21,15,.5);display:flex;align-items:center;justify-content:center;"><span class="badge badge-ink" style="font-size:13px;padding:6px 14px;">Sold</span></div>` : ''}
    </div>
    <div class="product-card-body">
      <div class="product-card-category">${listing.category}</div>
      <div class="product-card-title">${listing.title}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
        ${conditionDot(listing.condition)}<span class="text-sm text-muted">${listing.condition}</span>
      </div>
      <div class="product-card-footer">
        <div>
          <span class="product-card-price">${formatPrice(listing.price)}</span>
          ${listing.original_price ? `<span class="product-card-price-orig">${formatPrice(listing.original_price)}</span>` : ''}
        </div>
        <div class="product-card-seller">
          ${listing.seller_id
            ? `<a href="/pages/user-profile.html?id=${listing.seller_id}" onclick="event.stopPropagation()" style="color:inherit;text-decoration:none;">${listing.seller_name || 'ACU Student'}</a>`
            : (listing.seller_name || 'ACU Student')}
        </div>
      </div>
    </div>
  </div>`;
}

// ── NAV RENDERING ──
function renderNav(activePage = '') {
  const user = auth.getUser();
  const navEl = document.querySelector('.nav');
  if (!navEl) return;

  const isBuyer = user?.role === 'buyer';
  const isSeller = user?.role === 'seller';

  // Sellers can browse the marketplace too, but seller accounts do not get buyer actions.
  const links = [
    { href: '/pages/marketplace.html', label: 'Browse', icon: icons.search },
  ];
  if (isSeller) links.push({ href: '/pages/sell.html', label: 'Sell', icon: icons.plus });

  const linksHTML = links.map(l =>
    `<li><a href="${l.href}" class="${activePage === l.label ? 'active' : ''}">${l.icon} ${l.label}</a></li>`
  ).join('');

  const dashHref = isSeller ? '/pages/seller-dashboard.html' : '/pages/buyer-dashboard.html';

  const authHTML = user ? `
    ${isBuyer ? `
    <a href="/pages/cart.html" class="btn btn-surface btn-icon" title="Cart" aria-label="Cart" id="nav-cart-btn" style="position:relative;display:inline-flex">
      ${icons.shoppingBag}
      <span id="nav-cart-badge" style="display:none;position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:var(--accent);color:#fff;font-size:10px;font-weight:700;align-items:center;justify-content:center;line-height:1;border:1.5px solid var(--bg);"></span>
    </a>` : ''}
    <div style="position:relative">
      <div class="avatar avatar-sm" style="border:2px solid var(--border);cursor:pointer;" onclick="document.getElementById('nav-user-menu').classList.toggle('open')">${getInitials(user.full_name)}</div>
      <div id="nav-user-menu" class="nav-user-menu">
        <a href="${dashHref}" class="nav-user-menu-item">${icons.user} Dashboard</a>
        <a href="/pages/wishlist.html" class="nav-user-menu-item"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> Wishlist</a>
        <a href="/pages/settings.html" class="nav-user-menu-item">${icons.settings} Settings</a>
        <div class="nav-user-menu-sep"></div>
        <button class="nav-user-menu-item nav-user-menu-logout" onclick="logout()">${icons.logout} Log out</button>
      </div>
    </div>
  ` : `
    <a href="/pages/auth.html" class="btn btn-ghost btn-sm">Log in</a>
    <a href="/pages/auth.html?mode=register" class="btn btn-primary btn-sm">Sign up free</a>
  `;

  navEl.innerHTML = `
    <a href="/" class="nav-logo">Bix<span>cart</span></a>
    <ul class="nav-links">${linksHTML}</ul>
    <div class="nav-spacer"></div>
    <div class="nav-actions">${authHTML}</div>
  `;

  // Close menu on outside click
  if (user) {
    document.addEventListener('click', e => {
      const menu = document.getElementById('nav-user-menu');
      if (menu && !menu.closest('.nav-actions')?.contains(e.target)) menu.classList.remove('open');
    }, { once: false });

    // Refresh cart badge now that the element exists
    if (isBuyer) setTimeout(refreshCartBadge, 0);
  }
}

// ── LOGOUT ──
function logout() {
  auth.clear();
  window.location.href = '/pages/auth.html';
}

// ── LISTING NAVIGATION ──
function viewListing(id) { window.location.href = `/pages/listing.html?id=${id}`; }

// ── SAVE TOGGLE ──
async function toggleSave(e, id, btn) {
  e.stopPropagation();
  if (!auth.isLoggedIn()) { window.location.href = '/pages/auth.html'; return; }
  try {
    const r = await api.post(`/listings/${id}/save`);
    btn.classList.toggle('saved', r.saved);
    btn.innerHTML = r.saved ? icons.heartFilled : icons.heart;
    toast(r.saved ? 'Saved to wishlist ❤️' : 'Removed from wishlist', 'success');
    // Notify wishlist page if it's listening
    window.dispatchEvent(new CustomEvent('saveToggled', { detail: { id, saved: r.saved } }));
  } catch (err) { toast(err.message, 'error'); }
}

// ── SEARCH PARAMS ──
function getParam(key) { return new URLSearchParams(window.location.search).get(key); }
function setParams(obj) {
  const params = new URLSearchParams(window.location.search);
  Object.entries(obj).forEach(([k, v]) => { if (v) params.set(k, v); else params.delete(k); });
  window.history.replaceState({}, '', '?' + params.toString());
}

// ── SKELETON LOADER ──
function skeletonCard() {
  return `<div class="card" style="overflow:hidden;">
    <div class="skeleton" style="height:196px;border-radius:0;"></div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:8px;">
      <div class="skeleton" style="height:12px;width:60px;"></div>
      <div class="skeleton" style="height:16px;"></div>
      <div class="skeleton" style="height:14px;width:80%;"></div>
      <div class="skeleton" style="height:1px;margin:4px 0;"></div>
      <div style="display:flex;justify-content:space-between;">
        <div class="skeleton" style="height:20px;width:60px;"></div>
        <div class="skeleton" style="height:14px;width:80px;"></div>
      </div>
    </div>
  </div>`;
}

// ── FOOTER ──
function renderFooter() {
  const el = document.querySelector('.footer');
  if (!el) return;

  const user = auth.getUser();
  const isBuyer = user?.role === 'buyer';
  const isSeller = user?.role === 'seller';

  const marketplaceLinks = isSeller ? `
    <li><a href="/pages/sell.html">List an item</a></li>
    <li><a href="/pages/seller-dashboard.html">My listings</a></li>
  ` : `
    <li><a href="/pages/marketplace.html">Browse listings</a></li>
    <li><a href="/pages/marketplace.html?category=Textbooks">Textbooks</a></li>
    <li><a href="/pages/marketplace.html?category=Electronics">Electronics</a></li>
    <li><a href="/pages/cart.html">Cart</a></li>
  `;

  const accountLinks = isSeller ? `
    <li><a href="/pages/seller-dashboard.html">Seller dashboard</a></li>
    <li><a href="/pages/messages.html">Messages</a></li>
    <li><a href="/pages/settings.html">Account settings</a></li>
  ` : `
    <li><a href="/pages/buyer-dashboard.html">My purchases</a></li>
    <li><a href="/pages/messages.html">Messages</a></li>
    <li><a href="/pages/settings.html">Account settings</a></li>
  `;

  el.innerHTML = `
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <div class="footer-brand-logo">Bix<span>cart</span></div>
        <p>The campus marketplace built for Ajayi Crowther University students. Buy, sell, connect.</p>
      </div>
      <div class="footer-col"><h5>${isSeller ? 'Selling' : 'Marketplace'}</h5><ul>
        ${marketplaceLinks}
      </ul></div>
      <div class="footer-col"><h5>Account</h5><ul>
        ${accountLinks}
        ${!user ? '<li><a href="/pages/auth.html">Sign in</a></li>' : ''}
      </ul></div>
      <div class="footer-col"><h5>Company</h5><ul>
        <li><a href="/pages/about.html">About Bixcart</a></li>
        <li><a href="/pages/safety.html">Safety tips</a></li>
        <li><a href="/pages/privacy.html">Privacy policy</a></li>
        <li><a href="/pages/terms.html">Terms of use</a></li>
      </ul></div>
    </div>
    <div class="footer-bottom">
      <span>© 2026 Bixcart — Ajayi Crowther University, Oyo, Nigeria</span>
      <span>Made for students, by students.</span>
    </div>
  </div>`;
}

// ── ICONS (Lucide SVG snippets, 18px) ──
const iconSize = 'width="18" height="18"';
const icons = {
  search:        `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`,
  plus:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5v14"/></svg>`,
  heart:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  heartFilled:   `<svg ${iconSize} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  messageCircle: `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  package:       `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>`,
  tag:           `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  mapPin:        `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  mapPinMd:      `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  user:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  settings:      `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  logout:        `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  shoppingBag:   `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
  store:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/></svg>`,
  trendingUp:    `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
  dollarSign:    `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  eye:           `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  edit:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  trash:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  check:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  x:             `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  chevronRight:  `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  chevronLeft:   `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  alertCircle:   `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  alertTriangle: `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  send:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  star:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  shield:        `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  bookOpen:      `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  cpu:           `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`,
  home:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  bike:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>`,
  music:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  shirt:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.57a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.57a2 2 0 0 0-1.34-2.23z"/></svg>`,
  dumbbell:      `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6.5 6.5 11 11"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/><path d="m3 10 7-7"/><path d="m14 21 7-7"/></svg>`,
  arrowLeft:     `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  lock:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  sliders:       `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`,
  share:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
  bell:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  grid:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  list:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  loader:        `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`,
  image:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  truck:         `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
  creditCard:    `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
  cash:          `<svg ${iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/></svg>`,
};

// ── SPIN ANIMATION ──
const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
document.head.appendChild(spinStyle);

// ── NAV USER MENU STYLES (injected once) ──
(function injectNavMenuStyles() {
  const s = document.createElement('style');
  s.textContent = `
    .nav-user-menu {
      display: none; position: absolute; top: calc(100% + 8px); right: 0;
      min-width: 180px; background: var(--surface); border: 1.5px solid var(--border);
      border-radius: var(--radius-lg); box-shadow: var(--shadow-md); z-index: 200;
      overflow: hidden; padding: 4px 0;
    }
    .nav-user-menu.open { display: block; }
    .nav-user-menu-item {
      display: flex; align-items: center; gap: 9px; padding: 9px 14px;
      font-size: 13.5px; font-weight: 500; color: var(--ink); text-decoration: none;
      background: none; border: none; width: 100%; cursor: pointer; font-family: var(--font-body);
      transition: background .12s;
    }
    .nav-user-menu-item:hover { background: var(--bg); }
    .nav-user-menu-sep { height: 1px; background: var(--border); margin: 4px 0; }
    .nav-user-menu-logout { color: #e53e3e; }

    /* Admin message modal */
    .admin-msg-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 10000; padding: 20px;
    }
    .admin-msg-modal {
      position: relative; background: var(--surface); border-radius: 16px;
      padding: 28px 24px; max-width: 420px; width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,.25);
    }
    .admin-msg-label {
      display: flex; align-items: center; gap: 7px;
      font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
      color: var(--accent); margin-bottom: 10px;
    }
    .admin-msg-title { font-size: 16px; font-weight: 700; color: var(--ink); margin-bottom: 8px; }
    .admin-msg-text { font-size: 14px; color: var(--ink); line-height: 1.6; margin-bottom: 20px; white-space: pre-wrap; }
    .admin-msg-ack-btn {
      width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
      background: var(--accent); color: #fff; border: none; border-radius: var(--radius-md, 10px);
      padding: 12px 16px; font-size: 14px; font-weight: 700; font-family: var(--font-body);
      cursor: pointer; transition: opacity .12s;
    }
    .admin-msg-ack-btn:hover { opacity: .9; }
    .admin-msg-ack-btn:disabled { opacity: .6; cursor: default; }
  `;
  document.head.appendChild(s);
})();

// ── ADMIN MESSAGE MODAL ──
// Requires an explicit button press to close — there's no X or backdrop-click
// dismissal, since the message must be actively acknowledged (not just seen).
function showAdminMessageModal(msg, queueRest) {
  const overlay = document.createElement('div');
  overlay.className = 'admin-msg-overlay';
  overlay.innerHTML = `
    <div class="admin-msg-modal">
      <div class="admin-msg-label">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Message from Bixcart Admin
      </div>
      ${msg.title ? `<div class="admin-msg-title"></div>` : ''}
      <div class="admin-msg-text"></div>
      <button class="admin-msg-ack-btn">${icons.check} I've read this</button>
    </div>`;
  if (msg.title) overlay.querySelector('.admin-msg-title').textContent = msg.title;
  overlay.querySelector('.admin-msg-text').textContent = msg.content;
  document.body.appendChild(overlay);

  const btn = overlay.querySelector('.admin-msg-ack-btn');
  let acking = false;
  btn.addEventListener('click', async () => {
    if (acking) return;
    acking = true;
    btn.disabled = true;
    btn.textContent = 'Marking as read…';
    try {
      if (msg.id) {
        await api.post(`/auth/admin-messages/${msg.id}/ack`, {});
      }
      // Only dismiss after the server confirms acknowledgement. This guarantees
      // the same admin message cannot reappear on the next page/load.
      overlay.remove();
      if (typeof queueRest === 'function') queueRest();
    } catch (e) {
      acking = false;
      btn.disabled = false;
      btn.innerHTML = `${icons.check} I've read this`;
      toast(e?.message || 'Could not acknowledge this message. Please try again.', 'error');
    }
  });
}

async function checkAdminMessages() {
  if (!auth.isLoggedIn()) return;
  try {
    const { messages } = await api.get('/auth/admin-messages');
    if (!messages || !messages.length) return;
    let i = 0;
    function showNext() {
      if (i >= messages.length) return;
      const m = messages[i++];
      showAdminMessageModal(m, showNext);
    }
    showNext();
  } catch {}
}

// ── BACKGROUND UNREAD POLL (updates nav badge while on any page) ──
let _unreadPollTimer = null;
async function updateUnreadBadge() {
  if (!auth.isLoggedIn()) return;
  try {
    const convs = await api.get('/messages/conversations');
    const total = convs.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    const badge = document.getElementById('nav-unread-badge');
    if (badge) badge.style.display = total > 0 ? 'block' : 'none';
  } catch {}
}
function startUnreadPoll() {
  if (_unreadPollTimer) return;
  updateUnreadBadge();
  _unreadPollTimer = setInterval(updateUnreadBadge, 15000);
}
document.addEventListener('DOMContentLoaded', () => {
  // Push SW init — register service worker on every page
  if (auth.isLoggedIn()) pushManager.init();
  // Show any unread admin messages as a modal
  checkAdminMessages();
});

// ── SERVICE WORKER + PUSH NOTIFICATIONS ──
const pushManager = {
  _reg: null,

  async init() {
    if (!auth.isLoggedIn()) return;
    if (!('serviceWorker' in navigator)) return;
    try {
      this._reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      // Re-subscribe silently if permission was previously granted (keeps subscription fresh)
      if (this.alreadyGranted()) {
        this._subscribe().catch(() => {});
      }
    } catch(e) {
      console.warn('SW register failed:', e.message);
    }
  },

  canPush() {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  },

  alreadyGranted() {
    return 'Notification' in window && Notification.permission === 'granted';
  },

  async requestPermission() {
    if (!auth.isLoggedIn()) return false;

    if (!this.canPush()) {
      toast('Push notifications not supported on this browser', 'warning');
      return false;
    }

    // Request OS permission — this shows the native browser prompt
    let perm;
    try {
      perm = await Notification.requestPermission();
    } catch {
      // Some older browsers use callback style
      perm = await new Promise(resolve => Notification.requestPermission(resolve));
    }

    if (perm !== 'granted') {
      toast('Notifications blocked. Go to browser settings → Site settings → Notifications to allow.', 'warning', 5000);
      return false;
    }

    // Try to set up push subscription (requires VAPID keys on server)
    try {
      await pushManager._subscribe();
    } catch(e) {
      console.warn('Push subscription failed (VAPID may not be configured):', e.message);
      toast('Permission granted, but push delivery requires server setup (VAPID keys).', 'warning', 5000);
    }

    return true;
  },

  async _subscribe() {
    const reg = this._reg || await navigator.serviceWorker.ready;
    // Check if already subscribed
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await api.post('/push/subscribe', { subscription: existing.toJSON() });
      return;
    }

    // Fetch VAPID public key — if server doesn't have it, skip subscription
    let publicKey;
    try {
      const res = await api.get('/auth/vapid-public-key', false);
      publicKey = res.publicKey;
    } catch {
      return; // VAPID not configured on server, skip
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: pushManager._urlBase64ToUint8(publicKey),
    });
    await api.post('/push/subscribe', { subscription: sub.toJSON() });
  },

  _urlBase64ToUint8(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  },
};

// Expose globally
window.requestPushPermission = () => pushManager.requestPermission();
