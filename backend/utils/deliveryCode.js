const crypto = require('crypto');

function generateVerificationCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function verifyDeliveryCode(candidate, expected) {
  if (!candidate || !expected) return false;
  return String(candidate).trim().toUpperCase() === String(expected).trim().toUpperCase();
}

module.exports = { generateVerificationCode, verifyDeliveryCode };
