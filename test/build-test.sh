#!/bin/bash
# يبني نسخة اختبار تستخدم المحاكيات بدل Firebase وRevenueCat الحقيقيين
set -e
cd "$(dirname "$0")/.."
rm -rf /tmp/testsrc /tmp/testwww && mkdir -p /tmp/testsrc /tmp/testwww
cp -r src/* /tmp/testsrc/
cat > /tmp/testsrc/config.js <<'CFG'
export const CONFIG = { revenueCat: { androidApiKey: 'goog_test', iosApiKey: 'appl_test', entitlementId: 'pro' }, apiBase: 'https://example.com', maxTier: 5, privacyUrl: 'https://example.com/privacy', termsUrl: 'https://example.com/terms', reviewerEmails: ['review@reshy-apps.com'] };
CFG
cp -r www/* /tmp/testwww/
M=$PWD/test/mocks
npx esbuild /tmp/testsrc/app.js --bundle --format=esm --target=es2020 --outfile=/tmp/testwww/app.js \
  --alias:firebase/app=$M/app.js --alias:firebase/auth=$M/auth.js --alias:firebase/firestore=$M/firestore.js \
  --alias:@capacitor/core=$M/capacitor-core.js --alias:@revenuecat/purchases-capacitor=$M/purchases.js --log-level=warning
echo built
