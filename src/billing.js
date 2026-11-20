import { Capacitor } from '@capacitor/core';
import { CONFIG } from './config.js';

// الشراء عبر RevenueCat: يغلّف Google Play Billing وStoreKit (App Store) بواجهة واحدة.
// التراخيص منتجات لمرة واحدة؛ الخادم يحسب الباقة من المشتريات ولا يعتمد على ما يقوله التطبيق.
let Purchases = null;
let configured = false;

const platform = () => Capacitor.getPlatform();
export const isNativeApp = () => Capacitor.isNativePlatform();
const apiKey = () => (platform() === 'ios' ? CONFIG.revenueCat.iosApiKey : CONFIG.revenueCat.androidApiKey);
export const isBillingConfigured = () => isNativeApp() && !/^REPLACE/.test(apiKey() || 'REPLACE');

async function sdk() {
  if (!Purchases) ({ Purchases } = await import('@revenuecat/purchases-capacitor'));
  return Purchases;
}

// معرّفات المنتجات (يجب أن تطابق Google Play وapi/_lib.js)
export const BASE_PRODUCT = 'pharmacy_1';   // الترخيص الأول
export const EXTRA_PRODUCT = 'pharmacy_extra'; // صيدلية (فرع) إضافية، تُشترى عدة مرات
export const productKey = pkg => String(pkg?.product?.identifier || '').split(':')[0];

// يربط المشتريات بمعرّف الصيدلية حتى تُستعاد على أي جهاز للمالك
export async function initBilling(appUserId) {
  if (!isBillingConfigured()) return false;
  const P = await sdk();
  if (!configured) { await P.configure({ apiKey: apiKey(), appUserID: appUserId }); configured = true; }
  else await P.logIn({ appUserID: appUserId });
  return true;
}
export async function getPackages() { const P = await sdk(); const o = await P.getOfferings(); return o?.current?.availablePackages || []; }
export async function purchase(pkg) { const P = await sdk(); await P.purchasePackage({ aPackage: pkg }); }
export async function restore() { const P = await sdk(); await P.restorePurchases(); }
export async function logoutBilling() { if (!configured) return; try { const P = await sdk(); await P.logOut(); } catch (e) {} }
export const wasCancelled = e => !!(e && (e.userCancelled || /cancel/i.test(String(e.message || ''))));
