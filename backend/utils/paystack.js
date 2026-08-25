const _fetch = globalThis.fetch || require('node-fetch');

async function paystackRequest(path, options = {}) {
  const base = 'https://api.paystack.co';
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error('PAYSTACK_SECRET_KEY is not configured');

  const res = await _fetch(`${base}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let data;
  const raw = await res.text();
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { message: raw || 'Paystack returned an invalid response' }; }
  if (!res.ok || !data.status) {
    const error = new Error(data.message || 'Paystack request failed');
    error.paystack_status = data.status ?? false;
    error.paystack_code = data.code || null;
    error.paystack_http_status = res.status;
    error.paystack_data = data.data ?? null;
    error.paystack_response = data;
    throw error;
  }

  return data.data;
}


async function listBanks({ country = 'nigeria', perPage = 100, page = 1 } = {}) {
  const params = new URLSearchParams({ country, perPage: String(perPage), page: String(page) });
  return paystackRequest(`/bank?${params.toString()}`, { method: 'GET' });
}

async function resolveBankAccount({ account_number, bank_code, currency = 'NGN' }) {
  const params = new URLSearchParams({ account_number, bank_code, currency });
  return paystackRequest(`/bank/resolve?${params.toString()}`, { method: 'GET' });
}

async function createSubaccount({ business_name, bank_code, account_number, percentage_charge = 0, description = '', primary_contact_email = '', primary_contact_name = '', primary_contact_phone = '' }) {
  return paystackRequest('/subaccount', {
    method: 'POST',
    body: JSON.stringify({
      business_name, bank_code, account_number, percentage_charge,
      description, primary_contact_email, primary_contact_name, primary_contact_phone,
    }),
  });
}


async function initializeTransaction(payload) {
  return paystackRequest('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function verifyTransaction(reference) {
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
}

async function createRefund({ transaction, amount, customer_note = '', merchant_note = '' }) {
  const body = { transaction };
  if (amount !== undefined && amount !== null) body.amount = Math.round(Number(amount) * 100);
  if (customer_note) body.customer_note = customer_note;
  if (merchant_note) body.merchant_note = merchant_note;
  return paystackRequest('/refund', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function listRefunds({ transaction, perPage = 100, page = 1 } = {}) {
  const params = new URLSearchParams();
  if (transaction) params.set('transaction', transaction);
  params.set('perPage', String(perPage));
  params.set('page', String(page));
  return paystackRequest(`/refund?${params.toString()}`, { method: 'GET' });
}

async function getRefund(refundId) {
  return paystackRequest(`/refund/${encodeURIComponent(refundId)}`, { method: 'GET' });
}

module.exports = {
  paystackRequest,
  createRefund,
  listRefunds,
  getRefund,
  verifyTransaction,
  listBanks,
  resolveBankAccount,
  createSubaccount,
  initializeTransaction,
};
