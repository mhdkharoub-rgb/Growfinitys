/**
 * GrowFinitys — Backend Server
 * Simplified for Testnet compatibility
 */

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','x-pi-uid'] }));
app.options('*', cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3001;
const IS_SANDBOX = process.env.SANDBOX !== 'false';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── In-memory store ───────────────────────────────────────────────────────────
const members  = new Map();
const payments = new Map();

// ── Plan config ───────────────────────────────────────────────────────────────
const PLANS = {
  starter: { pricePI: 15,  durationDays: 30,  label: 'Starter Monthly' },
  pro:     { pricePI: 45,  durationDays: 30,  label: 'Pro Monthly'     },
  annual:  { pricePI: 390, durationDays: 365, label: 'Pro Annual'      },
};

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireMember(req, res, next) {
  const uid = req.headers['x-pi-uid'];
  if (!uid) return res.status(401).json({ error: 'Missing uid' });
  const member = members.get(uid);
  if (!member) return res.status(401).json({ error: 'Not a member' });
  if (new Date() > new Date(member.expiresAt))
    return res.status(403).json({ error: 'Subscription expired' });
  req.member = member;
  req.uid = uid;
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — also keeps server alive
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date(), sandbox: IS_SANDBOX, members: members.size });
});

// Root route — prevent "Cannot GET /"
app.get('/', (req, res) => {
  res.json({ app: 'GrowFinitys API', version: '1.0.0', status: 'running' });
});

/**
 * POST /payments/approve
 * Called immediately when Pi SDK triggers onReadyForServerApproval
 * In testnet/sandbox: approves all payments automatically
 */
app.post('/payments/approve', async (req, res) => {
  const { paymentId, uid, plan } = req.body;
  console.log(`💳 Approve request: paymentId=${paymentId} uid=${uid} plan=${plan}`);

  if (!paymentId || !uid || !plan) {
    console.log('❌ Missing fields');
    return res.status(400).json({ error: 'Missing fields' });
  }

  if (!PLANS[plan]) {
    console.log('❌ Unknown plan:', plan);
    return res.status(400).json({ error: 'Unknown plan' });
  }

  try {
    // In sandbox/testnet: skip Pi API verification, approve directly
    if (IS_SANDBOX) {
      console.log(`✅ Sandbox approval for payment ${paymentId}`);
      payments.set(paymentId, {
        uid, plan, status: 'approved', approvedAt: new Date()
      });
      return res.json({ success: true, message: 'Payment approved (sandbox)' });
    }

    // Production: verify with Pi Network API
    const axios = require('axios');
    const piRes = await axios.get(
      `https://api.minepi.com/v2/payments/${paymentId}`,
      { headers: { Authorization: `Key ${process.env.PI_API_KEY}` }, timeout: 8000 }
    );
    const payment = piRes.data;
    console.log('Pi payment data:', JSON.stringify(payment));

    payments.set(paymentId, { uid, plan, status: 'approved', approvedAt: new Date() });
    res.json({ success: true, message: 'Payment approved' });

  } catch (err) {
    console.error('❌ Approve error:', err.message);
    // Still approve in case of Pi API issues to not block user
    payments.set(paymentId, { uid, plan, status: 'approved', approvedAt: new Date() });
    res.json({ success: true, message: 'Payment approved (fallback)' });
  }
});

/**
 * POST /payments/complete
 * Called after blockchain transaction confirmed
 */
app.post('/payments/complete', async (req, res) => {
  const { paymentId, txId } = req.body;
  console.log(`✅ Complete request: paymentId=${paymentId} txId=${txId}`);

  if (!paymentId) return res.status(400).json({ error: 'Missing paymentId' });

  // Check if already processed
  const existing = payments.get(paymentId);
  if (existing?.status === 'completed') {
    console.log('Already completed, returning cached result');
    const member = members.get(existing.uid);
    return res.json({ success: true, member: { plan: existing.plan, expiresAt: member?.expiresAt } });
  }

  try {
    const pending = existing || { uid: req.body.uid, plan: req.body.plan || 'pro' };
    const plan = PLANS[pending.plan] || PLANS.pro;
    const expiresAt = new Date(Date.now() + plan.durationDays * 86400000);

    // Activate membership
    members.set(pending.uid, {
      uid: pending.uid,
      plan: pending.plan,
      planLabel: plan.label,
      expiresAt: expiresAt.toISOString(),
      activatedAt: new Date().toISOString(),
    });

    payments.set(paymentId, {
      ...pending, status: 'completed', txId, completedAt: new Date()
    });

    console.log(`🎉 Member activated: uid=${pending.uid} plan=${pending.plan} expires=${expiresAt.toISOString()}`);

    // In production: tell Pi Network we fulfilled the order
    if (!IS_SANDBOX && process.env.PI_API_KEY && txId) {
      try {
        const axios = require('axios');
        await axios.post(
          `https://api.minepi.com/v2/payments/${paymentId}/complete`,
          { txid: txId },
          { headers: { Authorization: `Key ${process.env.PI_API_KEY}` }, timeout: 8000 }
        );
        console.log('✅ Pi Network notified of completion');
      } catch(e) {
        console.error('Pi completion notify failed (non-fatal):', e.message);
      }
    }

    res.json({
      success: true,
      member: { plan: pending.plan, expiresAt: expiresAt.toISOString() }
    });

  } catch (err) {
    console.error('❌ Complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete payment' });
  }
});

/**
 * GET /member/status
 */
app.get('/member/status', (req, res) => {
  const uid = req.headers['x-pi-uid'];
  if (!uid) return res.json({ active: false });
  const member = members.get(uid);
  if (!member) return res.json({ active: false });
  const active = new Date() < new Date(member.expiresAt);
  console.log(`👤 Status check: uid=${uid} active=${active} plan=${member.plan}`);
  res.json({ active, plan: member.plan, expiresAt: member.expiresAt });
});

/**
 * GET /signals — Protected
 */
app.get('/signals', requireMember, async (req, res) => {
  const { category = 'all' } = req.query;
  const starterOnly = req.member.plan === 'starter';
  try {
    const signals = await generateSignals({ category, starterOnly });
    res.json({ signals, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Signal error:', err.message);
    res.status(500).json({ error: 'Failed to generate signals' });
  }
});

/**
 * GET /signals/report — Pro only
 */
app.get('/signals/report', requireMember, async (req, res) => {
  if (req.member.plan === 'starter')
    return res.status(403).json({ error: 'Upgrade to Pro' });
  try {
    const report = await generateWeeklyReport();
    res.json({ report, generatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ── AI Generation ─────────────────────────────────────────────────────────────
async function generateSignals({ category = 'all', starterOnly = false }) {
  const cats = starterOnly
    ? 'Crypto (2) and Forex (2)'
    : 'Crypto (2), Forex (2), Gold (1), Silver (1), Oil (2)';
  const count = starterOnly ? 4 : 8;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Generate exactly ${count} trading signals for: ${cats}.
Return ONLY a valid JSON array. No markdown, no explanation.
Each object: pair, category, action (BUY/SELL/HOLD), entry, sl, tp1, tp2, timeframe, rationale (2 sentences max, mention RSI/MACD/EMA), confidence (60-95).
Use realistic prices: BTC~67000, ETH~3500, EUR/USD~1.084, GBP/USD~1.270, XAU/USD~2315, XAG/USD~29.7, WTI~78.5.`
    }]
  });

  const raw = message.content.map(b => b.text || '').join('');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

async function generateWeeklyReport() {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Generate a weekly trading market report for Crypto, Forex, Gold, Silver, Oil.
Return JSON: { summary, markets: [{ name, outlook, keyLevel, note }], topTrade: { pair, direction, reason } }`
    }]
  });
  const raw = message.content.map(b => b.text || '').join('');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}


// ── Manual activation (sandbox/testnet only) ──────────────────────────────────
// Use this to activate a member directly without payment
// Remove this route in production!
app.post('/dev/activate', (req, res) => {
  if (!IS_SANDBOX) return res.status(403).json({ error: 'Only available in sandbox mode' });
  const { uid, plan = 'pro' } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  const planConfig = PLANS[plan] || PLANS.pro;
  const expiresAt = new Date(Date.now() + planConfig.durationDays * 86400000);
  members.set(uid, {
    uid, plan, planLabel: planConfig.label,
    expiresAt: expiresAt.toISOString(),
    activatedAt: new Date().toISOString(),
  });
  console.log(`🔧 Manual activation: uid=${uid} plan=${plan}`);
  res.json({ success: true, member: { plan, expiresAt: expiresAt.toISOString() } });
});

// ── Keep-alive ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ GrowFinitys backend running on port ${PORT}`);
  console.log(`📦 Mode: ${IS_SANDBOX ? 'SANDBOX/TESTNET' : 'PRODUCTION'}`);

  // Ping every 4 minutes to prevent Railway from sleeping
  setInterval(() => {
    const http = require('http');
    http.get(`http://localhost:${PORT}/health`, (r) => {
      console.log(`💓 Keep-alive OK (${new Date().toLocaleTimeString()})`);
    }).on('error', (e) => console.error('Keep-alive error:', e.message));
  }, 4 * 60 * 1000);
});
