/**
 * One-time script to create an admin account.
 * Usage: node scripts/create-admin.js
 *
 * Set these env vars first (or let them be prompted):
 *   ADMIN_EMAIL    — email for the admin account
 *   ADMIN_PASSWORD — password (min 8 chars recommended)
 *   ADMIN_NAME     — display name
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const readline = require('readline');
const bcrypt    = require('bcryptjs');
const { connectDb, User } = require('../db/database');

async function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    await connectDb();

    const email    = process.env.ADMIN_EMAIL    || await prompt(rl, 'Admin email: ');
    const password = process.env.ADMIN_PASSWORD || await prompt(rl, 'Admin password: ');
    const name     = process.env.ADMIN_NAME     || await prompt(rl, 'Admin name: ');

    if (!email || !password || !name) {
      console.error('Email, password and name are required.');
      process.exit(1);
    }
    if (password.length < 6) {
      console.error('Password must be at least 6 characters.');
      process.exit(1);
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      if (existing.role === 'admin') {
        console.log(`Admin account already exists for ${email}`);
      } else {
        await User.findByIdAndUpdate(existing._id, { $set: { role: 'admin', account_status: 'active' } });
        console.log(`✅ Upgraded existing account ${email} to admin.`);
      }
    } else {
      await User.create({
        email: email.toLowerCase(),
        password_hash: bcrypt.hashSync(password, 10),
        full_name: name,
        role: 'admin',
        account_status: 'active',
        registration_complete: true,
        listing_credits: 0,
      });
      console.log(`✅ Admin account created for ${email}`);
    }

    console.log('You can now log in at /pages/auth.html and navigate to /pages/admin.html');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    rl.close();
    process.exit(0);
  }
})();
