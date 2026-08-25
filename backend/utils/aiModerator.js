/**
 * Bixcart AI Content Moderation
 * Layer 1: Instant keyword filter (free, no API, catches 90% of violations)
 * Layer 2: Gemini queue (rate-safe, for ambiguous cases only)
 */

const fetch = require('node-fetch');

// ── KEYWORD RULES ──────────────────────────────────────────────────────────
const RULES = [
  {
    category: 'contact_bypass',
    reason: 'Sharing contact details or moving conversations off-platform is not allowed.',
    tests: [
      t => /whatsapp/i.test(t),
      t => /watsap/i.test(t),
      t => /snapchat/i.test(t),
      t => /\bsnap\b/i.test(t),
      t => /\btelegram\b/i.test(t),
      t => /\binstagram\b/i.test(t),
      t => /\binsta\b/i.test(t),
      t => /\btiktok\b/i.test(t),
      t => /\bfacebook\b/i.test(t),
      t => /\btwitter\b/i.test(t),
      t => /\b(chat|message|reach|text|contact|dm|pm|hit) me (on|at|via|through)\b/i.test(t),
      t => /\b(find|add|follow) me on\b/i.test(t),
      t => /my (snap|ig|insta|telegram|username|handle)\b/i.test(t),
      t => /\b0[789][01]\d{8}\b/.test(t),   // Nigerian mobile 08xx / 09xx
      t => /\+?234\d{10}/.test(t),
      t => /outside (this|the) (app|platform|chat)/i.test(t),
    ],
  },
  {
    category: 'academic_fraud',
    reason: 'Academic fraud materials are strictly prohibited and violate ACU rules.',
    tests: [
      t => /\bexam (expo|runz|answers?|leak|questions?)\b/i.test(t),
      t => /\b(expo|runz)\b/i.test(t),
      t => /\b(sell|selling|buy|buying|got|have)\b.{0,30}\b(exam|test|quiz)\b.{0,20}\b(answer|paper|question)/i.test(t),
      t => /\bassignment\b.{0,40}\b(for sale|₦|naira|cheap|sell|pay)/i.test(t),
      t => /\b(do|write|complete)\b.{0,20}\b(assignment|project|thesis)\b.{0,20}\b(for you|for.*pay|₦)/i.test(t),
    ],
  },
  {
    category: 'prohibited_item',
    reason: 'This item is prohibited on Bixcart.',
    tests: [
      t => /\b(weed|igbo|loud|colorado|shisha|codeine|tramadol|refnol|mkpuru)\b/i.test(t),
      t => /\b(cocaine|heroin|meth|crack)\b/i.test(t),
      t => /\b(gun|pistol|rifle|firearm|ammunition|ammo)\b/i.test(t),
      t => /\b(sell|selling|supply|get)\b.{0,20}\b(cutlass|blade|weapon|knife)\b/i.test(t),
      t => /\bporn(ography)?\b/i.test(t),
      t => /\bsex (tape|video|clip|content)\b/i.test(t),
    ],
  },
  {
    category: 'adult_content',
    reason: 'Adult content is not allowed on Bixcart.',
    tests: [
      t => /\bnude(s)?\b/i.test(t),
      t => /\bhook[\s-]?up\b/i.test(t),
      t => /link[\s-]?up for sex/i.test(t),
      t => /friends with benefits/i.test(t),
      t => /\bone night stand\b/i.test(t),
    ],
  },
];

function keywordCheck(text) {
  const t = String(text || '');
  for (const rule of RULES) {
    for (const test of rule.tests) {
      if (test(t)) return { flagged: true, reason: rule.reason, category: rule.category };
    }
  }
  return { flagged: false, reason: '', category: '' };
}

// ── GEMINI QUEUE ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You moderate Bixcart, a student marketplace at Ajayi Crowther University (ACU), Nigeria.

ALLOWED: Price negotiation, campus meetup plans, item condition questions, bank account details for payment, Nigerian slang/insults.

FLAG ONLY:
- Moving conversation off-platform (WhatsApp, Snapchat, Telegram, social handles, phone numbers)
- Prohibited items: weapons, hard drugs (weed, codeine, tramadol), stolen/pirated goods, pornography
- Academic fraud: selling exam answers, assignment help for money, runz/expo
- Sexual solicitation

Respond ONLY with JSON: {"flagged":true|false,"reason":"short reason or empty","category":"contact_bypass|prohibited_item|academic_fraud|adult_content or empty"}`;

const queue = [];
let draining = false;

function enqueue(text, context, resolve) {
  queue.push({ text, context, resolve });
  if (!draining) drain();
}

async function drain() {
  draining = true;
  while (queue.length) {
    const job = queue.shift();
    const result = await callGemini(job.text, job.context);
    job.resolve(result);
    if (queue.length) await sleep(4200); // stay under 15 req/min
  }
  draining = false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function moderateMessage(content, history = []) {
  const kw = keywordCheck(content);
  if (kw.flagged) {
    console.log('[aiMod] keyword hit:', kw.category, '—', content.slice(0,60));
    return Promise.resolve(kw);
  }
  if (!process.env.GEMINI_API_KEY) return Promise.resolve({ flagged: false, reason: '', category: '' });
  // Only queue for AI if message has ambiguous signals
  if (/(@|\bsnap\b|\bsocial\b|\bcontact\b|\boutside\b|\bexam\b|\bassignment\b|\d{8,})/i.test(content)) {
    return new Promise(resolve => enqueue(content, history, resolve));
  }
  return Promise.resolve({ flagged: false, reason: '', category: '' });
}

function moderateListing(data) {
  const text = `${data.title} ${data.description}`;
  const kw = keywordCheck(text);
  if (kw.flagged) {
    console.log('[aiMod] listing keyword hit:', kw.category);
    return Promise.resolve(kw);
  }
  if (!process.env.GEMINI_API_KEY) return Promise.resolve({ flagged: false, reason: '', category: '' });
  return new Promise(resolve => enqueue(text, [], resolve));
}

async function callGemini(text, context) {
  try {
    const ctx = (context || []).slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = `${ctx ? `Context:\n${ctx}\n\n` : ''}Check this: "${text}"\n\nJSON only:`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
      }),
    });
    if (!res.ok) { console.warn('[aiMod] Gemini', res.status); return safe(); }
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (parsed.flagged) console.log('[aiMod] Gemini flagged:', parsed.reason);
    return { flagged: !!parsed.flagged, reason: parsed.reason || '', category: parsed.category || '' };
  } catch(e) {
    console.warn('[aiMod] error:', e.message);
    return safe();
  }
}

function safe() { return { flagged: false, reason: '', category: '' }; }
module.exports = { moderateMessage, moderateListing, keywordCheck };
