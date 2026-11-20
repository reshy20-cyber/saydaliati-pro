'use strict';
// مكتبة مشتركة لدوال الخادم (Vercel). الملفات التي تبدأ بـ _ لا تُنشر كمسارات.
const admin = require('firebase-admin');

// عدد الأجهزة المسموح بها لكل صيدلية مرخّصة (يُضرب في رقم الباقة)
const DEVICES_PER_PHARMACY = 3;

// معرّفات المنتجات في Google Play / RevenueCat
// pharmacy_1: الترخيص الأول (غير مستهلك). pharmacy_extra: صيدلية (فرع) إضافية، تُشترى عدة مرات (مستهلك).
const BASE_PRODUCT = 'pharmacy_1';
const EXTRA_PRODUCT = 'pharmacy_extra';

const baseId = id => String(id || '').split(':')[0]; // اشتراكات أندرويد تأتي بصيغة product:basePlan

// purchases: { productId: عدد مرات الشراء }. الصيدلية الإضافية لا تُحتسب بلا الترخيص الأول.
function computeBranches(purchases) {
  const count = {};
  for (const [id, n] of Object.entries(purchases || {})) count[baseId(id)] = (count[baseId(id)] || 0) + n;
  if (!count[BASE_PRODUCT]) return { branches: 0, extras: 0 };
  const extras = Math.max(0, count[EXTRA_PRODUCT] || 0);
  return { branches: 1 + extras, extras };
}

function buildLicense(purchases) {
  const { branches, extras } = computeBranches(purchases);
  return {
    tier: branches, // عدد الصيدليات المرخّصة
    maxBranches: branches,
    extras,
    maxDevices: (branches || 1) * DEVICES_PER_PHARMACY,
    source: 'store'
  };
}

let _db, _auth;
function init() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}
function db() { init(); return (_db = _db || admin.firestore()); }
function auth() { init(); return (_auth = _auth || admin.auth()); }

// يجلب مشتريات الصيدلية من RevenueCat (مصدر الحقيقة) كعدّاد { productId: عدد }
async function fetchPurchases(appUserId) {
  const key = process.env.RC_SECRET_KEY;
  if (!key) throw new Error('RC_SECRET_KEY is not set');
  const r = await fetch('https://api.revenuecat.com/v1/subscribers/' + encodeURIComponent(appUserId), {
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error('RevenueCat ' + r.status);
  const { subscriber } = await r.json();
  const counts = {};
  // المنتجات لمرة واحدة تظهر في non_subscriptions: قائمة عمليات شراء لكل منتج (نتجاهل المستردّة)
  for (const [pid, list] of Object.entries(subscriber?.non_subscriptions || {})) {
    const n = (list || []).filter(t => !t.refunded_at && !t.is_refunded).length;
    if (n) counts[pid] = n;
  }
  return counts;
}

async function syncPharmacyLicense(pharmacyId) {
  const ref = db().doc('pharmacies/' + pharmacyId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const license = buildLicense(await fetchPurchases(pharmacyId));
  const cur = snap.data().license || {};
  if (cur.tier === license.tier && cur.extras === license.extras) return cur;
  const next = { ...license, updatedAt: new Date().toISOString() };
  await ref.update({ license: next });
  return next;
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return true; }
  return false;
}

// يتحقق من رمز Firebase ويرجع uid، أو يكتب خطأ 401
async function requireUser(req, res) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) { res.status(401).json({ error: 'unauthenticated' }); return null; }
  try { return await auth().verifyIdToken(m[1]); }
  catch (e) { res.status(401).json({ error: 'unauthenticated' }); return null; }
}

async function getMember(pharmacyId, uid) {
  const s = await db().doc(`pharmacies/${pharmacyId}/members/${uid}`).get();
  return s.exists && s.data().status === 'active' ? s.data() : null;
}

const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});

module.exports = { DEVICES_PER_PHARMACY, computeBranches, buildLicense, db, auth, syncPharmacyLicense, cors, requireUser, getMember, body };
