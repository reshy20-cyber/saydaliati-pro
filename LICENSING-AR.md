# نظام التراخيص (دفعة واحدة لكل صيدلية)

## كيف يعمل
- الصيدلية (الفرع) = وحدة ترخيص. الترخيص الأول يشمل صيدلية واحدة، ولكل صيدلية إضافية ترخيص مستقل بسعر ثابت. لكل صيدلية مرخّصة **3 أجهزة** مصرح بها (غيّر `DEVICES_PER_PHARMACY` في `api/_lib.js`).
- المشتري يدفع من داخل التطبيق عبر Google Play (RevenueCat يغلّفه). معرّف المستخدم في RevenueCat = معرّف الصيدلية في Firestore.
- **الخادم هو من يقرّر الترخيص**: بعد الشراء يطلب التطبيق `/api/sync-license`، والخادم يسأل RevenueCat عن المشتريات الفعلية ويكتب `pharmacies/{id}.license`. قواعد Firestore تمنع العميل من كتابة `license`، فلا يمكن تزويره. الاسترداد يُسقط الترخيص تلقائياً عبر الـ webhook.
- الأجهزة: كل جهاز يسجّل نفسه عند الدخول (`/api/register-device`) ويُرفض إن بلغت الصيدلية حدّها. المالك يحذف جهازاً قديماً من: حسابي ← الأجهزة المصرح بها.

## المنتجات في Google Play (منتجان فقط)
| المعرّف | النوع | الاستخدام | السعر (£) |
|---|---|---|---|
| pharmacy_1 | غير مستهلك (Non-consumable في RevenueCat) | الترخيص الأول: صيدلية واحدة | 49.99 |
| pharmacy_extra | **مستهلك (Consumable في RevenueCat)** | صيدلية إضافية، يُشترى عدة مرات | 35 |

عدد الصيدليات المسموح = 1 + عدد مرات شراء pharmacy_extra (ولا تُحتسب الإضافية بلا pharmacy_1).

أسعار الدول (حدّدها في Play Console لكل منتج). الأول | الإضافية:
- بريطانيا والسعر الافتراضي: £49.99 | £35
- السعودية: 245 ريالاً | 170
- الإمارات: 240 درهماً | 170
- قطر: 237 ريالاً | 165
- الكويت: 20 ديناراً | 14
- عُمان: 25 ريالاً | 17.5
- البحرين: 24.5 ديناراً | 17
- مصر: 1,000 جنيه | 700
- الأردن: 32 ديناراً | 22
- العراق: 60,000 دينار | 42,000
- المغرب: 420 درهماً | 295
- الجزائر: 6,000 دينار | 4,200
- تونس: 140 ديناراً | 100
- ليبيا: 230 ديناراً | 160
- لبنان: 45 دولاراً | 30
- بقية الدول: 35 دولاراً | 25
- أسعار الصرف تقريبية: راجعها قبل الحفظ.

## خطوات الإعداد (مرة واحدة)
1. **Play Console**: Monetize ← Products ← In-app products: أنشئ المنتجين أعلاه بنفس المعرّفين كمنتجين لمرة واحدة. لا يوجد خيار "مستهلك" في Play Console؛ التمييز بين المستهلك وغير المستهلك يُحدَّد في RevenueCat عند إضافة المنتج (pharmacy_extra = Consumable). ثم اضبط الأسعار لكل دولة.
2. **RevenueCat**: أضف المنتجين (نوع pharmacy_1: Non-consumable، ونوع pharmacy_extra: Consumable)، وأنشئ Offering باسم `default` فيه Package (Custom) لكل منتج. ضع المفتاح العام في `src/config.js` (`androidApiKey`).
3. **Firebase**: Project settings ← Service accounts ← Generate new private key.
4. **Vercel** ← Settings ← Environment Variables:
   - `FIREBASE_SERVICE_ACCOUNT` = محتوى ملف JSON كاملاً
   - `RC_SECRET_KEY` = مفتاح RevenueCat السري (Secret API key v1)
   - `RC_WEBHOOK_AUTH` = كلمة سرية طويلة من اختيارك
5. **RevenueCat** ← Integrations ← Webhooks: العنوان `https://saydaliati-pro.vercel.app/api/rc-webhook`، وقيمة Authorization header = نفس `RC_WEBHOOK_AUTH`.
6. **Firebase** ← Firestore ← Rules: انشر محتوى `firestore.rules` الجديد (أو شغّل `firebase deploy --only firestore:rules`).
7. جرّب بحساب اختبار من License testers في Play Console: اشترِ pharmacy_1، ثم pharmacy_extra مرتين، وتأكد أن `license.tier` يتغير في Firestore.

## حدود معروفة
- حدّ عدد الصيدليات يُطبَّق في التطبيق (يمنع إضافة فرع جديد ويُخفي الفروع الزائدة)، ولا يُفرض على مستوى Firestore. التعديل المتعمد للتطبيق قد يتجاوزه؛ حدّ الأجهزة والترخيص نفسه يُفرضان على الخادم.
- من لا إنترنت لديه عند أول تشغيل لا يُسجَّل جهازه إلا عند أول اتصال.
- آيفون: تُنشأ في App Store Connect: pharmacy_1 كمنتج Non-Consumable، وpharmacy_extra كمنتج Consumable.
- الاسترداد: الكود يتجاهل العمليات المستردّة إن أرجعها RevenueCat بعلامة refunded، ولم يُجرَّب مع استرداد حقيقي؛ تحقق منه في اختبار الاسترداد.
