# بناء النسخ من الهاتف (GitHub Actions)

كل البناء يتم على خوادم GitHub. من الهاتف: المستودع > Actions > اختر الـ workflow > Run workflow.

## أندرويد
### المرحلة 1: نسخة تجريبية فوراً (بلا أي إعداد)
1. Actions > "Android build" > Run workflow.
2. بعد 5-10 دقائق افتح التشغيل ونزّل الملف `saydaliati-android-apk-debug` (zip فيه app-debug.apk) لتثبيته وتجربة الكاميرا.

### المرحلة 2: ملف النشر لـ Google Play (AAB موقّع)
1. Actions > "Create Android upload key" > Run workflow، واكتب كلمة مرور (أحرف وأرقام).
2. نزّل الـ artifact `KEEP-PRIVATE-android-upload-key` واحفظه في مكان آمن. إن ضاع المفتاح تحتاج إعادة ضبط من Google.
3. في المستودع: Settings > Secrets and variables > Actions > New repository secret، وأضف:
   - ANDROID_KEYSTORE_BASE64: محتوى الملف upload.jks.base64.txt
   - ANDROID_KEYSTORE_PASSWORD: كلمة المرور التي اخترتها
   - ANDROID_KEY_ALIAS: upload
   - ANDROID_KEY_PASSWORD: نفس كلمة المرور
4. شغّل "Android build" من جديد. سيظهر artifact باسم `...aab-signed`.
5. ارفعه في Play Console > Testing > Internal testing.

## آيفون (بعد تفعيل حساب Apple Developer)
1. App Store Connect > Users and Access > Integrations > App Store Connect API > أنشئ مفتاحاً بصلاحية App Manager، ونزّل ملف .p8 (مرة واحدة فقط). دوّن Key ID وIssuer ID.
2. دوّن Team ID من developer.apple.com > Membership.
3. أنشئ التطبيق في App Store Connect بمعرّف com.reshyapps.saydaliati.
4. أضف الأسرار: APPLE_TEAM_ID, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8 (محتوى ملف .p8 كاملاً).
5. شغّل "iOS build and upload to TestFlight". يظهر البناء في TestFlight خلال دقائق.

## تنبيهات
- هذه الملفات لم تُجرَّب على GitHub فعلياً؛ إن فشل تشغيل فأرسل لي لقطة الخطأ وأصلحه.
- الأيقونات تُولَّد تلقائياً من مجلد assets (icon-only.png وicon-foreground.png وicon-background.png بحجم 1024). استبدل هذه الملفات بأيقونتك.
- معرّف التطبيق com.reshyapps.saydaliati؛ لا يمكن تغييره بعد النشر.
