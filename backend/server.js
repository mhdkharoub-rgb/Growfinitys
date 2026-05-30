/**
 * GrowFinitys — Backend Server
 * Node.js + Express
 *
 * Handles:
 *  - Pi Network payment verification (Server-Side API)
 *  - Member subscription management
 *  - AI signal generation via Anthropic API
 *  - Protected API routes for members
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',  // Allow all origins (Pi Browser uses various origins)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-pi-uid']
}));
app.options('*', cors()); // Handle preflight requests

// ─── Config ──────────────────────────────────────────────────────────────────
const PI_API_KEY        = process.env.PI_API_KEY;         // From Pi Developer Portal
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;  // From Anthropic Console
const PORT              = process.env.PORT || 3001;

// App identity
const APP_NAME   = 'GrowFinitys';
const APP_DOMAIN = 'growfinitys.pi';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── In-memory store (replace with DB in production) ─────────────────────────
// Use MongoDB / PostgreSQL / Supabase in production
const members = new Map();     // uid -> { plan, expiresAt, payments[] }
const payments = new Map();    // paymentId -> status

// ─── Pi Network API helpers ───────────────────────────────────────────────────
const PI_API = axios.create({
  baseURL: 'https://api.minepi.com/v2',
  headers: { Authorization: `Key ${PI_API_KEY}` }
});

/**
 * Verify a Pi payment on the server side.
 * Always call this BEFORE approving a payment.
 */
async function verifyPiPayment(paymentId) {
  const res = await PI_API.get(`/payments/${paymentId}`);
  return res.data;
}

/**
 * Complete (capture) a payment after you've fulfilled the order.
 * Must be called to release Pi to your wallet.
 */
async function completePiPayment(paymentId, txId) {
  const res = await PI_API.post(`/payments/${paymentId}/complete`, { txid: txId });
  return res.data;
}

// ─── Plan config ─────────────────────────────────────────────────────────────
const PLANS = {
  starter: { pricePI: 15, durationDays: 30,  label: 'Starter Monthly' },
  pro:     { pricePI: 45, durationDays: 30,  label: 'Pro Monthly'     },
  annual:  { pricePI: 390, durationDays: 365, label: 'Pro Annual'      },
};

// ─── Middleware: verify member token ─────────────────────────────────────────
function requireMember(req, res, next) {
  const uid = req.headers['x-pi-uid'];
  const member = members.get(uid);
  if (!member) return res.status(401).json({ error: 'Not a member' });
  if (new Date() > new Date(member.expiresAt))
    return res.status(403).json({ error: 'Subscription expired' });
  req.member = member;
  req.uid = uid;
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

/**
 * POST /payments/approve
 * Called by frontend immediately when user approves a payment.
 * Validates the payment exists and amount matches the plan.
 */
app.post('/payments/approve', async (req, res) => {
  const { paymentId, uid, plan } = req.body;
  if (!paymentId || !uid || !plan) return res.status(400).json({ error: 'Missing fields' });

  try {
    const payment = await verifyPiPayment(paymentId);

    // Verify amount matches expected plan price
    const expectedPlan = PLANS[plan];
    if (!expectedPlan) return res.status(400).json({ error: 'Unknown plan' });
    if (payment.amount !== expectedPlan.pricePI)
      return res.status(400).json({ error: 'Payment amount mismatch' });
    if (payment.metadata?.uid !== uid)
      return res.status(400).json({ error: 'UID mismatch' });

    // Store pending payment
    payments.set(paymentId, { uid, plan, status: 'approved', approvedAt: new Date() });

    res.json({ success: true, message: 'Payment approved' });
  } catch (err) {
    console.error('Approve error:', err.message);
    res.status(500).json({ error: 'Failed to verify payment with Pi Network' });
  }
});

/**
 * POST /payments/complete
 * Called by frontend after Pi blockchain transaction is confirmed.
 * Activates the member subscription.
 */
app.post('/payments/complete', async (req, res) => {
  const { paymentId, txId } = req.body;
  if (!paymentId || !txId) return res.status(400).json({ error: 'Missing fields' });

  const pending = payments.get(paymentId);
  if (!pending) return res.status(404).json({ error: 'Payment not found' });
  if (pending.status === 'completed') return res.json({ success: true, alreadyProcessed: true });

  try {
    // Tell Pi Network we've fulfilled the order
    await completePiPayment(paymentId, txId);

    // Activate subscription
    const plan = PLANS[pending.plan];
    const expiresAt = new Date(Date.now() + plan.durationDays * 86400000);

    members.set(pending.uid, {
      uid: pending.uid,
      plan: pending.plan,
      planLabel: plan.label,
      expiresAt: expiresAt.toISOString(),
      activatedAt: new Date().toISOString(),
      payments: [paymentId],
    });

    payments.set(paymentId, { ...pending, status: 'completed', txId, completedAt: new Date() });

    res.json({
      success: true,
      member: { plan: pending.plan, expiresAt: expiresAt.toISOString() }
    });
  } catch (err) {
    console.error('Complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete payment' });
  }
});

/**
 * GET /member/status
 * Returns current subscription status for a Pi user.
 */
app.get('/member/status', (req, res) => {
  const uid = req.headers['x-pi-uid'];
  const member = members.get(uid);
  if (!member) return res.json({ active: false });

  const active = new Date() < new Date(member.expiresAt);
  res.json({ active, plan: member.plan, expiresAt: member.expiresAt });
});

/**
 * GET /signals
 * Protected: returns AI-generated trading signals.
 * Requires valid member token.
 */
app.get('/signals', requireMember, async (req, res) => {
  const { category = 'all' } = req.query;
  const starterOnly = req.member.plan === 'starter';

  try {
    const signals = await generateSignals({ category, starterOnly });
    res.json({ signals, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Signal generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

/**
 * GET /signals/report
 * Pro/Annual only: weekly AI market report
 */
app.get('/signals/report', requireMember, async (req, res) => {
  if (req.member.plan === 'starter')
    return res.status(403).json({ error: 'Upgrade to Pro for market reports' });

  try {
    const report = await generateWeeklyReport();
    res.json({ report, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ─── AI Signal Generation ─────────────────────────────────────────────────────

async function generateSignals({ category = 'all', starterOnly = false }) {
  const cats = starterOnly
    ? 'Crypto (2) and Forex (2)'
    : 'Crypto (2), Forex (2), Gold (1), Silver (1), Oil (2)';

  const count = starterOnly ? 4 : 8;
  const catFilter = category !== 'all'
    ? `Focus only on the ${category} category.`
    : `Generate signals across: ${cats}.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are an expert trading signal generator for professional traders.
${catFilter}

Generate exactly ${count} trading signals. Return ONLY a valid JSON array. No markdown, no explanation.

Each signal object must have:
- pair: string (e.g. "BTC/USD")
- category: "Crypto" | "Forex" | "Gold" | "Silver" | "Oil"
- action: "BUY" | "SELL" | "HOLD"
- entry: string price
- sl: string stop loss
- tp1: string take profit 1
- tp2: string take profit 2
- timeframe: e.g. "1H", "4H", "1D"
- rationale: 2 sentences max — cite technical indicators (RSI, MACD, EMA, support/resistance)
- confidence: integer 60–95
- riskReward: string e.g. "1:2.5"

Use realistic approximate prices: BTC~67000, ETH~3500, EUR/USD~1.084, GBP/USD~1.270,
XAU/USD~2315, XAG/USD~29.7, WTI~78.5, BRENT~82. Vary BUY/SELL distribution naturally.`
    }]
  });

  const raw = message.content.map(b => b.text || '').join('');
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function generateWeeklyReport() {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Generate a professional weekly trading market report covering Crypto, Forex, Gold, Silver, and Oil.
Return JSON with: { summary: string, markets: [ { name, outlook: "Bullish"|"Bearish"|"Neutral", keyLevel: string, note: string } ], topTrade: { pair, direction, reason } }`
    }]
  });

  const raw = message.content.map(b => b.text || '').join('');
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {   console.log(`✅ GrowFinitys backend running on port ${PORT}`);   // Keep-alive ping every 4 minutes to prevent Railway from sleeping   setInterval(() => {     const http = require('http');     http.get(`http://localhost:${PORT}/health`, () => {       console.log('💓 Keep-alive ping');     }).on('error', () => {});   }, 4 * 60 * 1000); });
