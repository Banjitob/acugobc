# Campus Market — Deployment Guide
## Render (Backend + Frontend) + MongoDB Atlas

---

## Overview

This app deploys as a **single Render Web Service** — the Express backend serves both the API and the static frontend files. No separate frontend hosting needed.

```
Browser → Render Web Service (Node/Express)
              ├── /api/*        → Express routes
              └── /*            → Static frontend files
                        ↓
              MongoDB Atlas (database)
```

---

## Step 1 — MongoDB Atlas Setup

### 1.1 Create a free cluster

1. Go to **[mongodb.com/atlas](https://www.mongodb.com/atlas)** → Sign up / Log in
2. Click **"Build a Database"** → Choose **M0 Free** tier
3. Select a cloud provider and region (pick one close to your Render region — e.g. AWS us-east-1)
4. Name your cluster (e.g. `campusmarket-cluster`) → Click **"Create"**

### 1.2 Create a database user

1. In the left sidebar → **Database Access** → **"Add New Database User"**
2. Choose **Password** authentication
3. Set a username (e.g. `campusmarket-admin`) and a strong password — **save both**
4. Under "Database User Privileges" → select **"Read and write to any database"**
5. Click **"Add User"**

### 1.3 Whitelist all IPs (required for Render)

1. In the left sidebar → **Network Access** → **"Add IP Address"**
2. Click **"Allow Access From Anywhere"** → this sets `0.0.0.0/0`
3. Click **"Confirm"**

> Render's outbound IPs change dynamically, so `0.0.0.0/0` is necessary unless you're on a paid Render plan with static IPs.

### 1.4 Get your connection string

1. Go to **Database** → click **"Connect"** on your cluster
2. Choose **"Connect your application"**
3. Driver: **Node.js**, Version: **5.5 or later**
4. Copy the connection string — it looks like:
   ```
   mongodb+srv://campusmarket-admin:<password>@campusmarket-cluster.abc12.mongodb.net/?retryWrites=true&w=majority
   ```
5. Replace `<password>` with your actual password
6. Add the database name before the `?`:
   ```
   mongodb+srv://campusmarket-admin:yourpassword@campusmarket-cluster.abc12.mongodb.net/campusmarket?retryWrites=true&w=majority
   ```
7. **Save this string** — you'll paste it into Render in Step 3

---

## Step 2 — Push Code to GitHub

Render deploys from a Git repository.

```bash
# In your campusmarket/ root folder:
git init
git add .
git commit -m "Initial commit — Campus Market"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/campusmarket.git
git branch -M main
git push -u origin main
```

Make sure `.gitignore` is in place so `node_modules/` and `.env` are **not** committed.

---

## Step 3 — Deploy on Render

### 3.1 Create a new Web Service

1. Go to **[render.com](https://render.com)** → Log in → **"New +"** → **"Web Service"**
2. Connect your GitHub account if you haven't already
3. Find and select your `campusmarket` repository → click **"Connect"**

### 3.2 Configure the service

Fill in the settings:

| Field | Value |
|-------|-------|
| **Name** | `campusmarket` (or anything you like) |
| **Region** | Same region as your Atlas cluster (e.g. US East) |
| **Branch** | `main` |
| **Root Directory** | `backend` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | Free |

### 3.3 Add environment variables

Scroll down to **"Environment Variables"** and add these one by one:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `10000` |
| `MONGODB_URI` | *(paste your full Atlas connection string from Step 1.4)* |
| `JWT_SECRET` | *(generate a random 64-char string — see tip below)* |
| `FRONTEND_URL` | *(leave blank for now — fill in after first deploy)* |

**Tip — generate a secure JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3.4 Deploy

Click **"Create Web Service"**. Render will:
1. Clone your repo
2. Run `npm install`
3. Run `node server.js`
4. Your app will be live at `https://campusmarket.onrender.com` (or similar)

Watch the build logs — a successful boot looks like:
```
MongoDB connected: campusmarket-cluster.abc12.mongodb.net
Demo data seeded successfully.
Campus Market running on http://localhost:10000
```

### 3.5 Update FRONTEND_URL

Once deployed:
1. Copy your Render URL (e.g. `https://campusmarket.onrender.com`)
2. Go to your service → **Environment** → edit `FRONTEND_URL`
3. Set it to your Render URL
4. Click **"Save Changes"** — Render will redeploy automatically

---

## Step 4 — Verify the deployment

Open your Render URL in a browser. Test these:

```
# Health check (should return JSON)
https://your-app.onrender.com/api/health

# Landing page (should load the frontend)
https://your-app.onrender.com/

# Create a real account through the registration page. Any valid email address can be used.
```

---

## Step 5 — Custom Domain (optional)

1. In Render → your service → **"Settings"** → **"Custom Domains"**
2. Click **"Add Custom Domain"** → enter your domain (e.g. `campusmarket.co`)
3. Add the CNAME record your DNS provider shows to your domain registrar
4. Render provisions an SSL certificate automatically (takes ~5 minutes)
5. Update `FRONTEND_URL` env var to your custom domain

---

## Redeployment (future updates)

Every `git push` to `main` triggers an automatic redeploy:

```bash
# Make your changes, then:
git add .
git commit -m "Your change description"
git push origin main
# Render auto-deploys within ~2 minutes
```

---

## Troubleshooting

### "MongoServerError: bad auth"
→ Wrong password in your connection string. Re-check Step 1.4.

### "MongooseServerSelectionError: connection timed out"
→ IP not whitelisted. Go to Atlas → Network Access → confirm `0.0.0.0/0` is set.

### Frontend shows blank page / 404
→ Make sure `NODE_ENV=production` is set in Render env vars. The server only serves static files in production mode.

### "Cannot find module" on deploy
→ A package is missing from `package.json`. Run `npm install <package> --save` locally, commit, and push.

### App sleeps after inactivity (Free tier)
→ Free Render services spin down after 15 minutes of inactivity. The first request after sleep takes ~30 seconds. Upgrade to a paid plan ($7/mo) for always-on.

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGODB_URI` | ✅ Yes | Full MongoDB Atlas connection string |
| `JWT_SECRET` | ✅ Yes | Secret key for signing JWTs — keep private |
| `NODE_ENV` | ✅ Yes | Set to `production` on Render |
| `PORT` | ✅ Yes | Set to `10000` on Render |
| `FRONTEND_URL` | Optional | Your Render/custom domain URL (used for CORS) |

---

## Security checklist before going live

- [ ] `JWT_SECRET` is a long random string (not the default)
- [ ] `.env` is in `.gitignore` and not committed to GitHub
- [ ] MongoDB Atlas password is strong and not reused
- [ ] Atlas Network Access is set to `0.0.0.0/0` (required for Render free tier)
- [ ] `NODE_ENV=production` is set in Render
- [ ] Test login, create listing, and messaging end-to-end after deploy

---

## Push Notifications Setup (Web Push / VAPID)

### Generate VAPID keys

Run this once to generate your VAPID key pair:

```bash
npx web-push generate-vapid-keys
```

Copy the output — you'll get a `Public Key` and `Private Key`.

### Add to Render environment variables

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | Your generated public key |
| `VAPID_PRIVATE_KEY` | Your generated private key |
| `VAPID_EMAIL` | `mailto:yourname@example.com` |

### Install the dependency

```bash
cd backend
npm install web-push
```

### How it works

1. When a logged-in user visits the seller dashboard, a **"Notifications"** button appears.
2. They click it → browser asks for permission.
3. Once granted, their push subscription is saved to their user record in MongoDB.
4. When someone **messages** them or **likes** a listing, a real push notification is sent to their phone/browser notification tray — even if the app is closed.

### Notes

- Notifications only fire if `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set; otherwise they fail silently.
- The service worker (`frontend/sw.js`) must be served from the root (`/sw.js`).
- `web-push` is an optional dependency — if not installed, notifications are simply skipped.

## Paystack marketplace split setup (Bixcart)

Bixcart now uses Paystack subaccounts and server-controlled dynamic splits for seller payments. You do **not** need to manually create a split group for each commission tier; the backend creates the split configuration per checkout.

Add these Render environment variables:

- `PAYSTACK_PUBLIC_KEY` — your Paystack public key (still used by other payment surfaces).
- `PAYSTACK_SECRET_KEY` — your Paystack secret key. **Backend only; never expose it to the frontend.**
- `PUBLIC_APP_URL` — your public Bixcart URL, e.g. `https://bixcart.onrender.com`.

The Paystack integration uses:

- One Paystack subaccount per approved seller payout account.
- Dynamic **flat** seller shares so each seller's exact 7% → 5.5% Bixcart commission can be respected even when a cart contains multiple sellers.
- `bearer_type: "all"`, so Paystack transaction fees are shared equally between the Bixcart main account and the participating seller subaccounts.
- Server-side payment initialization and verification; the browser cannot change the commission/split configuration.

Before going live, keep Paystack in Test Mode and test seller bank setup, one-seller checkout, multi-seller checkout, seller decline/refund, automatic timeout/refund, and successful delivery confirmation.
