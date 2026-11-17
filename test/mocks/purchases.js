// محاكاة RevenueCat: window.__rc يتحكم بالنتائج
const rc = (window.__rc = window.__rc || { active: false, expires: null, calls: [] });
const info = () => ({ entitlements: { active: rc.active ? { pro: { isActive: true, expirationDate: rc.expires, productIdentifier: 'pro_monthly', willRenew: true } } : {} } });
let cb = null;
export const Purchases = {
  async configure(o) { rc.calls.push(['configure', o.appUserID]); },
  async logIn(o) { rc.calls.push(['logIn', o.appUserID]); },
  async logOut() { rc.calls.push(['logOut']); return { customerInfo: info() }; },
  async addCustomerInfoUpdateListener(f) { cb = f; return 'cb1'; },
  async getCustomerInfo() { return { customerInfo: info() }; },
  async getOfferings() { return { current: { availablePackages: [{ identifier: '$rc_monthly', product: { title: 'اشتراك شهري', priceString: '£9.99', identifier: 'pro_monthly' } }, { identifier: '$rc_annual', product: { title: 'اشتراك سنوي', priceString: '£89.99', identifier: 'pro_annual' } }] } }; },
  async purchasePackage(o) { rc.calls.push(['purchase', o.aPackage.identifier]); if (rc.cancel) throw Object.assign(new Error('cancelled'), { userCancelled: true }); rc.active = true; rc.expires = new Date(Date.now() + 30 * 86400000).toISOString(); cb?.(info()); return { customerInfo: info() }; },
  async restorePurchases() { rc.calls.push(['restore']); return { customerInfo: info() }; }
};
