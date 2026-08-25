# Bixcart

A student marketplace for Ajayi Crowther University (and built to extend to other campuses). Started as a classifieds-style app — post an item, message the seller, meet up to exchange it. It's moving toward a real online store: browse, add to cart, pay online, get it delivered. Meeting up in person is still there as a fallback for sellers/buyers who prefer it.

## Tech Stack

- **Backend**: Node.js + Express + MongoDB (Mongoose)
- **Frontend**: Vanilla HTML/CSS/JS — no build step
- **Auth**: JWT + bcrypt, email verification (any valid email address)
- **Images**: Cloudinary (upload) + Multer (handling)
- **Payments**: Paystack (checkout, refunds, and automatic seller settlement through Split Payments)
- **Email**: Brevo API (verification, password reset)
- **Push**: Web Push (VAPID)
- **AI moderation**: Gemini, flags listings/conversations for admin review
- **Icons**: Lucide-style inline SVG, no dependency
- **Fonts**: Fredoka, Raleway, Nunito (Google Fonts)

## Quick Start

```bash
cd backend
npm install
```

Create `backend/.env` (see [Environment Variables](#environment-variables) below — at minimum you need `MONGODB_URI` and `JWT_SECRET` to boot).

```bash
node server.js
# → http://localhost:3001
```

The server serves the frontend too — no separate frontend process needed.

No demo data ships with the app (that only existed back when this ran on an embedded NeDB store). Register a normal account through the UI, or create an admin account:

```bash
cd backend
npm run create-admin
```

## Environment Variables (`backend/.env`)

```bash
# Required to boot
MONGODB_URI=            # MongoDB Atlas (or any Mongo) connection string
JWT_SECRET=              # random string, used to sign auth tokens
PORT=3001
NODE_ENV=development

# Payments (Paystack) — checkout and seller credit purchases won't work without these
PAYSTACK_PUBLIC_KEY=
PAYSTACK_SECRET_KEY=

# Image upload
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# Email (Brevo API — verification + password reset)
BREVO_API_KEY=
EMAIL_FROM=

# Push notifications (generate with: npx web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_EMAIL=

# AI moderation
GEMINI_API_KEY=

# create-admin script
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_NAME=

# CORS / links in emails
FRONTEND_URL=
```

Anything left blank just disables that feature gracefully (e.g. no `GEMINI_API_KEY` means listings skip AI moderation) — except `MONGODB_URI` and `JWT_SECRET`, which the server needs to start at all.

## Project Structure

```
acugo/
├── backend/
│   ├── db/
│   │   └── database.js       # Mongoose schemas (User, Listing, Order, CartItem, ...)
│   ├── middleware/
│   │   └── auth.js           # JWT middleware
│   ├── routes/
│   │   ├── auth.js           # Register, login, profile, credits, Paystack key
│   │   ├── listings.js       # CRUD, search, save/unsave
│   │   ├── messages.js       # Conversations + messaging
│   │   ├── orders.js         # Orders, checkout, stats
│   │   ├── cart.js           # Cart CRUD
│   │   ├── uploads.js        # Cloudinary image upload
│   │   ├── push.js           # Web push subscribe/unsubscribe
│   │   └── admin.js          # Moderation, users, broadcasts, listings
│   ├── scripts/
│   │   └── create-admin.js
│   ├── utils/                # Email, push, AI moderation helpers
│   ├── .env
│   ├── package.json
│   └── server.js
└── frontend/
    ├── css/main.css          # Design tokens + shared components
    ├── js/app.js             # API client, auth, cart, icons, shared nav/footer
    ├── pages/                # See table below
    └── index.html            # Landing page
```

## Pages

| Page               | URL                             | Notes                          |
|--------------------|----------------------------------|--------------------------------|
| Landing            | `/`                              |                                 |
| Marketplace        | `/pages/marketplace.html`        | Browse, search, filter         |
| Listing detail     | `/pages/listing.html?id=<id>`    | Add to cart / contact / offer  |
| Cart               | `/pages/cart.html`               |                                 |
| Checkout           | `/pages/checkout.html`           | Delivery details + Paystack    |
| Create/edit listing| `/pages/sell.html`               |                                 |
| Buyer dashboard    | `/pages/buyer-dashboard.html`    | Orders, saved items, profile   |
| Seller dashboard   | `/pages/seller-dashboard.html`   | Listings, orders, transactions |
| Messages           | `/pages/messages.html`           |                                 |
| Wishlist           | `/pages/wishlist.html`           |                                 |
| User profile       | `/pages/user-profile.html`       | Public seller/buyer profile    |
| Settings           | `/pages/settings.html`           |                                 |
| Auth / Register    | `/pages/auth.html`, `/pages/register.html` |                       |
| Waitlist           | `/pages/waitlist.html`           | Pre-launch signup               |
| Privacy / Terms    | `/pages/privacy.html`, `/pages/terms.html` |                       |
| Admin              | `/pages/admin.html`, `/pages/admin-login.html` | Admin-only        |

## How buying works

1. Buyer adds one or more listings to their **cart** (quick-add from the marketplace grid, or from the listing page).
2. At **checkout**, they provide their checkout contact details and pay the full cart total through Paystack (card, transfer, or USSD).
3. Payment is verified server-side against Paystack before anything is created — the app never trusts a client-reported "success." If the cart spans multiple sellers, checkout splits into one order per seller, all tagged with the same `checkout_group` so the buyer sees it as one purchase.
4. Each seller sees their incoming orders under **Seller Dashboard → Orders**, with the buyer's checkout contact and delivery-location context. They accept or decline, then mark the order delivered once it's out.
5. The buyer marks it received on their end; once both sides confirm, the order is complete and the buyer can rate the seller.

The older path — message a seller directly, negotiate, agree to meet up in person — still works and shows up under **Seller Dashboard → Transactions**. Nothing about it changed; cart checkout was added alongside it, not in place of it.

## Current marketplace business model

- Product listings are **free**. There is no payment per listing and no listing-credit purchase requirement.
- Listings remain active for the configured listing period (currently 3 months / the applicable semester model) and can be renewed without a listing fee.
- Bixcart earns a commission only from successfully completed marketplace sales.
- Seller commission starts at **7%** and can permanently decrease through successful-sale tiers down to a **5.5% floor**.
- Buyer payments are processed through Paystack Split Payments. The seller share and Bixcart commission are allocated automatically at checkout.
- If an order is declined, cancelled, or automatically cancelled because a seller misses the response/delivery deadline, Bixcart initiates a refund and notifies the buyer.
- Paystack settles each seller share through the seller's verified Paystack subaccount. Bixcart and participating seller accounts share Paystack processing fees.
- Sellers must be approved by an admin before seller functionality is enabled.
- Sellers must choose **exactly one** location mode: hostel (hostel + room) **or** shop (shop name/number/address). They cannot use both at the same time.

## API Endpoints

### Auth (`/api/auth`)
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/register` | — | Register (any valid email address) |
| POST | `/login` | — | Login, returns JWT |
| GET | `/verify-email` | — | Confirm email via emailed link |
| POST | `/resend-verification` | — | Resend verification email |
| POST | `/forgot-password` / `/reset-password` | — | Password reset flow |
| GET | `/me` | ✓ | Current user |
| PUT | `/profile` / `/complete-registration` / `/change-password` | ✓ | Update account |
| GET | `/paystack-public-key` / `/vapid-public-key` | — | Public keys for frontend |
| POST | `/credits/verify` | ✓ | Legacy listing-credit verification endpoint (not used for current free listings) |
| GET | `/users/:id/profile` | — | Public profile |

### Listings (`/api/listings`)
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | optional | Search + filter (`q`, `category`, `campus`, `condition`, `min_price`, `max_price`, `sort`, `page`, `limit`) |
| GET | `/:id` | optional | Listing detail |
| GET | `/user/:userId` | — | A user's listings |
| POST | `/` | ✓ | Create listing (listings are free) |
| PUT | `/:id` | ✓ | Update listing |
| DELETE | `/:id` | ✓ | Delete listing |
| POST | `/:id/save` | ✓ | Toggle save |
| POST | `/:id/mark-sold` / `/:id/relist` | ✓ | Manual status change |

### Cart (`/api/cart`)
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/` | ✓ | Cart contents with listing details |
| GET | `/count` | ✓ | Item count, for the nav badge |
| POST | `/add` | ✓ | Add a listing (`{ listing_id }`) |
| DELETE | `/:listingId` | ✓ | Remove one item |
| DELETE | `/` | ✓ | Clear cart |

### Orders (`/api/orders`)
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/buying` / `/selling` | ✓ | My purchases / my incoming orders |
| GET | `/saved` | ✓ | Saved listings |
| GET | `/stats` | ✓ | Seller stats |
| POST | `/checkout` | ✓ | Verify Paystack payment, turn cart into orders |
| POST | `/` | ✓ | Create a single meetup-style order (legacy/chat flow) |
| PUT | `/:id/status` | ✓ | Seller accepts/declines, or either side cancels |
| POST | `/:id/mark-complete` | ✓ | Buyer or seller marks their side done |
| POST | `/:id/resolve` | ✓ | Resolve a chat-based deal (completed/cancelled) |
| POST | `/:id/rate` | ✓ | Buyer rates seller |

### Messages (`/api/messages`)
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/conversations` / `/conversations/:id` | ✓ | List / thread (marks read) |
| POST | `/send` | ✓ | Send a message |
| POST | `/conversations/:id/txn-status` | ✓ | Update deal status from chat |
| POST | `/conversations/:id/rate` | ✓ | Rate from chat |
| POST | `/report` | ✓ | Report a conversation |

### Other
- **Uploads** (`/api/uploads/image`) — Cloudinary image upload
- **Push** (`/api/push/subscribe`, `/unsubscribe`) — web push
- **Admin** (`/api/admin/*`) — user moderation (warn/suspend/message/delete), broadcasts, listing moderation, flagged-content review, conversation reports. Admin-only, see `routes/admin.js`.

## Features

- Email verification at registration (any valid email address)
- Listings — create, edit, delete, search, filter, sort, paginate, AI-moderated
- Cart + checkout — multi-item, multi-seller, paid upfront via Paystack, delivery address
- Legacy path — message a seller directly, make an offer, arrange a meetup
- Save / wishlist
- Threaded messaging with polling
- Seller dashboard — listings, cart-checkout orders, chat-based transactions, stats
- Buyer dashboard — order history (with delivery info), saved items, profile
- Push notifications, email verification/reset via Brevo
- Admin panel — moderation, broadcasts, flagged-content queue
- Responsive throughout

## Production Notes

- Set every key in [Environment Variables](#environment-variables) — the app degrades feature-by-feature if one's missing, but checkout specifically needs `PAYSTACK_SECRET_KEY` to verify payments.
- `JWT_SECRET` should be a long random string in production (Render's blueprint auto-generates one — see `render.yaml`).
- Rate limiting (`express-rate-limit`) is already a dependency — confirm it's applied to the routes that need it (auth, checkout) before going live.
- See `DEPLOY.md` for the full deployment walkthrough.
#   a c u g o 1 
 
 