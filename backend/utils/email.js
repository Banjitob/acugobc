// Brevo HTTP API — bypasses SMTP entirely, works on Render.
// Docs: https://developers.brevo.com/reference/sendtransacemail

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function getBaseUrl() {
  const raw  = process.env.FRONTEND_URL || 'https://bixcart.onrender.com';
  const urls = raw.split(',').map(u => u.trim()).filter(Boolean);
  return urls.find(u => u.startsWith('https://')) || urls[urls.length - 1];
}

function parseSender(from) {
  const match = from.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { email: from.trim() };
}

async function sendMail({ to, subject, html }) {
  const sender = parseSender(process.env.EMAIL_FROM || '"Bixcart" <bhuszibah@gmail.com>');

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key':      process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Brevo API error ${res.status}: ${err.message || JSON.stringify(err)}`);
  }

  return res.json();
}

async function verifyTransport() {
  if (!process.env.BREVO_API_KEY) {
    console.error('  ✗ EMAIL FAILED — BREVO_API_KEY is not set');
    return;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const account = await res.json();
    console.log(`  ✓ Brevo ready — ${account.email}`);
  } catch (err) {
    console.error('  ✗ Brevo API check FAILED —', err.message);
  }
}

async function sendVerificationEmail(to, token) {
  const link = `${getBaseUrl()}/pages/auth.html?action=verify&token=${token}`;
  await sendMail({
    to,
    subject: 'Verify your Bixcart email',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#fafafa;border-radius:12px;">
        <h2 style="color:#1a1a1a;margin-bottom:8px;">Verify your email</h2>
        <p style="color:#555;line-height:1.6;">
          Thanks for joining Bixcart! Click the button below to confirm your email address.
          This link expires in <strong>24 hours</strong>.
        </p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#c8522a;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
          Verify Email
        </a>
        <p style="color:#999;font-size:13px;">Or paste this link:<br><a href="${link}" style="color:#c8522a;">${link}</a></p>
        <p style="color:#bbb;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:16px;">
          If you didn't create a Bixcart account, ignore this email.
        </p>
      </div>`,
  });
}

async function sendPasswordResetEmail(to, token) {
  const link = `${getBaseUrl()}/pages/auth.html?action=reset&token=${token}`;
  await sendMail({
    to,
    subject: 'Reset your Bixcart password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#fafafa;border-radius:12px;">
        <h2 style="color:#1a1a1a;margin-bottom:8px;">Reset your password</h2>
        <p style="color:#555;line-height:1.6;">
          Click below to reset your Bixcart password. This link expires in <strong>1 hour</strong>.
        </p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#c8522a;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
          Reset Password
        </a>
        <p style="color:#999;font-size:13px;">Or paste this link:<br><a href="${link}" style="color:#c8522a;">${link}</a></p>
        <p style="color:#bbb;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:16px;">
          If you didn't request this, your password will not change.
        </p>
      </div>`,
  });
}

async function sendOrderSellerAlertEmail(to, { buyerName, listingTitle, orderId, deliveryWindow }) {
  await sendMail({
    to,
    subject: `New sale alert for ${listingTitle}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;background:#fafafa;border-radius:12px;">
        <h2 style="color:#1a1a1a;margin-bottom:8px;">New order received</h2>
        <p style="color:#555;line-height:1.6;">
          <strong>${buyerName}</strong> paid for <strong>${listingTitle}</strong> on Bixcart.
          Please accept or decline the order within <strong>6 hours</strong>.
        </p>
        <p style="color:#555;line-height:1.6;">If you accept it, the item must be delivered within the selected window: <strong>${deliveryWindow}</strong>.</p>
        <div style="margin:24px 0;padding:14px 18px;border:1px solid #eee;border-radius:10px;background:white;">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#666;">Order ID</div>
          <div style="font-weight:600;color:#1a1a1a;font-size:14px;">${orderId}</div>
        </div>
      </div>`,
  });
}

async function sendOrderRefundEmail(to, { buyerName, listingTitle, reason, amount, refundStatus = 'pending' }) {
  const statusText = refundStatus === 'processed'
    ? 'Your refund has been processed by Paystack and will be returned through the original payment method.'
    : 'Your refund has been initiated and may take some time to reach your account.';
  await sendMail({
    to,
    subject: `Refund initiated for ${listingTitle}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;background:#fafafa;border-radius:12px;">
        <h2 style="color:#1a1a1a;margin-bottom:8px;">Payment refund initiated</h2>
        <p style="color:#555;line-height:1.6;">Hi ${buyerName}, your Bixcart order for <strong>${listingTitle}</strong> was cancelled.</p>
        <p style="color:#555;line-height:1.6;"><strong>Refund amount:</strong> ₦${Number(amount || 0).toLocaleString('en-NG')}</p>
        <p style="color:#555;line-height:1.6;">${statusText}</p>
        <p style="color:#555;line-height:1.6;"><strong>Reason:</strong> ${reason}</p>
        <p style="color:#999;font-size:13px;line-height:1.6;">Paystack notes that processed refunds can still take up to 10 business days to reach the customer, depending on the processing rails.</p>
      </div>`,
  });
}

async function sendSellerApplicationEmail(to, { sellerName, sellerEmail, userId }) {
  const adminUrl = `${getBaseUrl()}/pages/admin.html`;
  await sendMail({
    to,
    subject: `Seller approval needed — ${sellerName}`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;background:#fafafa;border-radius:12px;">
      <h2 style="color:#1a1a1a;margin-bottom:8px;">New seller application</h2>
      <p style="color:#555;line-height:1.6;"><strong>${sellerName}</strong> (${sellerEmail}) has completed seller registration and is waiting for approval.</p>
      <p style="color:#555;line-height:1.6;">Please review the submitted profile and identity documents within <strong>6 hours</strong>.</p>
      <a href="${adminUrl}" style="display:inline-block;margin:18px 0;padding:12px 22px;background:#c8522a;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Review seller application</a>
      <p style="color:#999;font-size:12px;">Application ID: ${userId}</p>
    </div>`,
  });
}

async function sendSellerDecisionEmail(to, { sellerName, approved, reason = '' }) {
  const subject = approved ? 'Your Bixcart seller account was approved' : 'Your Bixcart seller application was rejected';
  await sendMail({
    to,
    subject,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;background:#fafafa;border-radius:12px;">
      <h2 style="color:#1a1a1a;margin-bottom:8px;">Seller application ${approved ? 'approved' : 'rejected'}</h2>
      <p style="color:#555;line-height:1.6;">Hi ${sellerName}, your Bixcart seller application has been <strong>${approved ? 'approved' : 'rejected'}</strong>.</p>
      ${approved ? '<p style="color:#555;line-height:1.6;">Your seller account is now active. You can sign in and start listing products.</p>' : `<p style="color:#555;line-height:1.6;"><strong>Reason:</strong> ${reason}</p>`}
    </div>`,
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendOrderSellerAlertEmail,
  sendOrderRefundEmail,
  sendSellerApplicationEmail,
  sendSellerDecisionEmail,
  verifyTransport,
};
