/**
 * GrowFinitys — Pi SDK Integration Layer
 * pi-sdk.js
 *
 * Drop this file into your frontend and import it.
 * It wraps the Pi Browser SDK with clean async/await
 * and handles all payment flows end-to-end.
 *
 * Usage:
 *   import PiSDK from './pi-sdk.js';
 *   await PiSDK.init();
 *   const user = await PiSDK.authenticate();
 *   await PiSDK.subscribe('pro');
 */

const BACKEND_URL = 'https://your-backend.com'; // ← change to your deployed backend

const PiSDK = (() => {

  let _user = null; // cached Pi user object

  // ─── Init ─────────────────────────────────────────────────────────────────
  /**
   * Must be called once on app load.
   * Initialises the Pi SDK in Sandbox mode (set sandbox=false for production).
   */
  async function init(sandbox = true) {
    if (typeof Pi === 'undefined') {
      console.warn('Pi SDK not available — not running inside Pi Browser');
      return false;
    }
    Pi.init({ version: '2.0', sandbox });
    console.log(`✅ Pi SDK initialised (sandbox=${sandbox})`);
    return true;
  }

  // ─── Authenticate ─────────────────────────────────────────────────────────
  /**
   * Authenticates the current Pi user.
   * Returns { uid, username, accessToken } or throws on failure.
   *
   * Scopes:
   *   - 'username'  : read the user's Pi username
   *   - 'payments'  : initiate payments on their behalf
   */
  async function authenticate() {
    return new Promise((resolve, reject) => {
      Pi.authenticate(['username', 'payments'], onIncompletePayment)
        .then(auth => {
          _user = auth.user;
          console.log('✅ Authenticated as', _user.username);
          resolve({
            uid:         _user.uid,
            username:    _user.username,
            accessToken: auth.accessToken,
          });
        })
        .catch(reject);
    });
  }

  // ─── Incomplete payment handler ───────────────────────────────────────────
  /**
   * Pi SDK calls this if the user has an unfinished payment from a previous
   * session. We must complete or cancel it before starting a new one.
   */
  async function onIncompletePayment(payment) {
    console.log('⚠️ Incomplete payment found:', payment.identifier);
    try {
      // Try to complete it — if our server already processed it, this is safe
      await fetch(`${BACKEND_URL}/payments/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentId: payment.identifier,
          txId: payment.transaction?.txid || null,
        })
      });
      payment.complete();
    } catch {
      payment.cancel();
    }
  }

  // ─── Subscribe ────────────────────────────────────────────────────────────
  /**
   * Initiates a Pi subscription payment for the given plan.
   * plan: 'starter' | 'pro' | 'annual'
   *
   * Returns { success: true, member } on success.
   */
  async function subscribe(plan) {
    if (!_user) throw new Error('User not authenticated. Call PiSDK.authenticate() first.');

    const PLAN_PRICES = { starter: 15, pro: 45, annual: 390 };
    const amount = PLAN_PRICES[plan];
    if (!amount) throw new Error(`Unknown plan: ${plan}`);

    return new Promise((resolve, reject) => {
      Pi.createPayment(
        {
          amount,
          memo: `GrowFinitys — ${plan} subscription`,
          metadata: { uid: _user.uid, plan, product: 'pisignals-subscription' },
        },
        {
          // ── Step 1: User approved on Pi side → verify on our server ──────
          onReadyForServerApproval: async (paymentId) => {
            try {
              const res = await fetch(`${BACKEND_URL}/payments/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paymentId, uid: _user.uid, plan }),
              });
              if (!res.ok) throw new Error('Server approval failed');
              // IMPORTANT: must call payment.approve() to continue
              // (Pi SDK requires this, but the call above IS the approval)
            } catch (err) {
              reject(err);
            }
          },

          // ── Step 2: Blockchain transaction done → complete on our server ──
          onReadyForServerCompletion: async (paymentId, txId) => {
            try {
              const res = await fetch(`${BACKEND_URL}/payments/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paymentId, txId }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Completion failed');
              resolve({ success: true, member: data.member });
            } catch (err) {
              reject(err);
            }
          },

          // ── Cancelled by user ─────────────────────────────────────────────
          onCancel: (paymentId) => {
            console.log('Payment cancelled:', paymentId);
            reject(new Error('Payment cancelled by user'));
          },

          // ── Error ─────────────────────────────────────────────────────────
          onError: (error, payment) => {
            console.error('Pi payment error:', error, payment);
            reject(error);
          },
        }
      );
    });
  }

  // ─── Check membership status ──────────────────────────────────────────────
  /**
   * Checks backend to see if the authenticated user has an active subscription.
   * Returns { active: bool, plan, expiresAt }
   */
  async function getMemberStatus() {
    if (!_user) return { active: false };
    const res = await fetch(`${BACKEND_URL}/member/status`, {
      headers: { 'x-pi-uid': _user.uid }
    });
    return res.json();
  }

  // ─── Fetch signals (authenticated) ───────────────────────────────────────
  /**
   * Fetch AI trading signals from the backend.
   * category: 'all' | 'Crypto' | 'Forex' | 'Gold' | 'Silver' | 'Oil'
   */
  async function fetchSignals(category = 'all') {
    if (!_user) throw new Error('Not authenticated');
    const res = await fetch(
      `${BACKEND_URL}/signals?category=${category}`,
      { headers: { 'x-pi-uid': _user.uid } }
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to fetch signals');
    }
    return res.json();
  }

  // ─── Fetch weekly report (Pro/Annual only) ────────────────────────────────
  async function fetchWeeklyReport() {
    if (!_user) throw new Error('Not authenticated');
    const res = await fetch(`${BACKEND_URL}/signals/report`, {
      headers: { 'x-pi-uid': _user.uid }
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to fetch report');
    }
    return res.json();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function getUser() { return _user; }
  function isInPiBrowser() { return typeof Pi !== 'undefined'; }

  // ─── Public API ───────────────────────────────────────────────────────────
  return { init, authenticate, subscribe, getMemberStatus, fetchSignals, fetchWeeklyReport, getUser, isInPiBrowser };

})();

export default PiSDK;
