'use strict';
// مكتبة مشتركة لدوال الخادم (Vercel). الملفات التي تبدأ بـ _ لا تُنشر كمسارات.
const admin = require('firebase-admin');

// عدد الأجهزة المسموح بها لكل صيدلية مرخّصة (يُضرب في رقم الباقة)
const DEVICES_PER_PHARMACY = 3;

// معرّفات المنتجات في Google Play / RevenueCat
const BASE_PRODUCTS = { pharmacy_1: 1, pharmacy_2: 2, pharmacy_3: 3, pharmacy_5: 5 };
const UPGRADES = [
  { id: 'upgrade_1_to_2', from: 1, to: 2 },
  { id: 'upgrade_2_to_3', from: 2, to: 3 },
  { id: 'upgrade_3_to_5', from: 3, to: 5 }
];

const baseId = id => String(id || '').split(':')[0]; // اشتراكات أندرويد تأتي بصيغة product:basePlan

// يحسب الباقة من قائمة المنتجات المشتراة فعلاً. الترقية لا تُحتسب إلا إذا كانت الباقة السابقة مملوكة.
function computeTier(productIds) {
  const ids = new Set((productIds || []).map(baseId));
  let tier = 0;
  for (const [id, t] of Object.entries(BASE_PRODUCTS)) if (ids.has(id)) tier = Math.max(tier, t);
  let changed = true;
  while (changed) {
    changed = false;
    for (const u of UPGRADES) {
      if (ids.has(u.id) && tier >= u.from && tier < u.to) { tier = u.to; changed = true; }
    }
  }
  return tier;
}

function buildLicense(productIds) {
  const tier = computeTier(productIds);
  return {
    tier,
    maxBranches: tier,
    maxDevices: tier > 0 ? tier * DEVICES_PER_PHARMACY : DEVICES_PER_PHARMACY,
    products: [...new Set((productIds || []).map(baseId))].sort(),
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

// يجلب مشتريات الصيدلية من RevenueCat (مصدر الحقيقة، ويراعي الاسترداد) ثم يكتب الترخيص في Firestore
async function fetchPurchasedProducts(appUserId) {
  const key = process.env.RC_SECRET_KEY;
  if (!key) throw new Error('RC_SECRET_KEY is not set');
  const r = await fetch('https://api.revenuecat.com/v1/subscribers/' + encodeURIComponent(appUserId), {
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error('RevenueCat ' + r.status);
  const { subscriber } = await r.json();
  const ids = new Set();
  // المنتجات لمرة واحدة تظهر في non_subscriptions (كل منتج له قائمة عمليات شراء)
  for (const [pid, list] of Object.entries(subscriber?.non_subscriptions || {})) if ((list || []).length) ids.add(pid);
  // احتياط: منتجات تُعامل كاستحقاق نشط
  for (const e of Object.values(subscriber?.entitlements || {})) {
    const exp = e.expires_date ? new Date(e.expires_date).getTime() : Infinity;
    if (e.product_identifier && exp > Date.now()) ids.add(e.product_identifier);
  }
  return [...ids];
}

async function syncPharmacyLicense(pharmacyId) {
  const ref = db().doc('pharmacies/' + pharmacyId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const license = buildLicense(await fetchPurchasedProducts(pharmacyId));
  const cur = snap.data().license || {};
  if (cur.tier === license.tier && (cur.products || []).join() === license.products.join()) return cur;
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

module.exports = { DEVICES_PER_PHARMACY, computeTier, buildLicense, db, auth, syncPharmacyLicense, cors, requireUser, getMember, body };
