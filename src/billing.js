import { Capacitor } from '@capacitor/core';
import { CONFIG } from './config.js';

// الاشتراك عبر RevenueCat: يغلّف Google Play Billing وStoreKit (App Store) بواجهة واحدة.
let Purchases = null;
let configured = false;
let listenerAdded = false;

const platform = () => Capacitor.getPlatform();
export const isNativeApp = () => Capacitor.isNativePlatform();
const apiKey = () => (platform() === 'ios' ? CONFIG.revenueCat.iosApiKey : CONFIG.revenueCat.androidApiKey);
export const isBillingConfigured = () => isNativeApp() && !/^REPLACE/.test(apiKey() || 'REPLACE');

async function sdk() {
  if (!Purchases) ({ Purchases } = await import('@revenuecat/purchases-capacitor'));
  return Purchases;
}

export function toEntitlement(info) {
  const e = info?.entitlements?.active?.[CONFIG.revenueCat.entitlementId];
  return { active: !!e, expiresAt: e?.expirationDate || null, productId: e?.productIdentifier || null, willRenew: e?.willRenew ?? null };
}

// يربط الاشتراك بمعرّف الصيدلية حتى يُستعاد على أي جهاز للمالك
export async function initBilling(appUserId, onChange) {
  if (!isBillingConfigured()) return false;
  const P = await sdk();
  if (!configured) { await P.configure({ apiKey: apiKey(), appUserID: appUserId }); configured = true; }
  else await P.logIn({ appUserID: appUserId });
  if (!listenerAdded) {
    listenerAdded = true;
    await P.addCustomerInfoUpdateListener(info => onChange?.(toEntitlement(info)));
  }
  return true;
}
export async function getEntitlement() { const P = await sdk(); const { customerInfo } = await P.getCustomerInfo(); return toEntitlement(customerInfo); }
export async function getPackages() { const P = await sdk(); const o = await P.getOfferings(); return o?.current?.availablePackages || []; }
export async function purchase(pkg) { const P = await sdk(); const { customerInfo } = await P.purchasePackage({ aPackage: pkg }); return toEntitlement(customerInfo); }
export async function restore() { const P = await sdk(); const { customerInfo } = await P.restorePurchases(); return toEntitlement(customerInfo); }
export async function logoutBilling() { if (!configured) return; try { const P = await sdk(); await P.logOut(); } catch (e) {} }
export const wasCancelled = e => !!(e && (e.userCancelled || /cancel/i.test(String(e.message || ''))));
