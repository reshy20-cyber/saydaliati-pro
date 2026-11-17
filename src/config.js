// ===== إعدادات يجب ضبطها قبل النشر =====
export const CONFIG = {
  revenueCat: {
    // من لوحة RevenueCat ← Project ← API keys (مفاتيح عامة، آمنة داخل التطبيق)
    androidApiKey: 'REPLACE_WITH_REVENUECAT_ANDROID_PUBLIC_KEY',
    iosApiKey: 'REPLACE_WITH_REVENUECAT_IOS_PUBLIC_KEY',
    // اسم الـ Entitlement الذي تنشئه في RevenueCat ويرتبط بمنتجات الاشتراك
    entitlementId: 'pro'
  },
  // روابط إلزامية لدى Apple وGoogle للتطبيقات ذات الاشتراكات
  privacyUrl: 'https://saydaliati-pro.vercel.app/privacy.html',
  termsUrl: 'https://saydaliati-pro.vercel.app/terms.html',
  // حسابات مراجعة المتاجر (Google/Apple): اشتراكها يُعدّ فعّالاً دائماً. لا تضف إلا حساباً مخصصاً للمراجعين.
  reviewerEmails: ['review@reshy-apps.com'],
  // أيام سماح بعد انتهاء الاشتراك (لحالات إعادة محاولة الدفع)
  graceDays: 2
};
