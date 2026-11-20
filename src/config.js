// ===== إعدادات يجب ضبطها قبل النشر =====
export const CONFIG = {
  revenueCat: {
    // من لوحة RevenueCat ← Project ← API keys (مفاتيح عامة، آمنة داخل التطبيق)
    androidApiKey: 'goog_TyqaSylfSAcwWyiGpWFeeEEIXPn',
    iosApiKey: 'REPLACE_WITH_REVENUECAT_IOS_PUBLIC_KEY',
    // الترخيص يُحسب على الخادم من مشتريات RevenueCat، فلا حاجة لاسم Entitlement هنا
    entitlementId: 'pro'
  },
  // عنوان دوال الخادم (Vercel) المسؤولة عن الترخيص والأجهزة
  apiBase: 'https://saydaliati-pro.vercel.app',
  // روابط إلزامية لدى Apple وGoogle
  privacyUrl: 'https://saydaliati-pro.vercel.app/privacy.html',
  termsUrl: 'https://saydaliati-pro.vercel.app/terms.html',
  // حسابات مراجعة المتاجر (Google/Apple): ترخيصها يُعدّ فعّالاً دائماً بأعلى باقة. لا تضف إلا حساباً مخصصاً للمراجعين.
  reviewerEmails: ['review@reshy-apps.com'],
  // أعلى باقة (تُعطى لحسابات المراجعة)
  maxTier: 5
};
