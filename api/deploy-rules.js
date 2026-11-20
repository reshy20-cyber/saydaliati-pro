'use strict';
// أداة لمرة واحدة: تنشر firestore.rules من فرع main في هذا المستودع إلى Firebase (بدل اللصق اليدوي من الجوال).
// لا تقبل أي محتوى من الطلب؛ تنشر فقط ما هو موجود في المستودع. احذف هذا الملف بعد الاستخدام.
const admin = require('firebase-admin');
const { db } = require('./_lib');

const RULES_URL = 'https://raw.githubusercontent.com/reshy20-cyber/saydaliati-pro/main/firestore.rules';

module.exports = async (req, res) => {
  try {
    db(); // يهيّئ firebase-admin بحساب الخدمة
    const r = await fetch(RULES_URL, { cache: 'no-store' });
    if (!r.ok) return res.status(502).json({ error: 'cannot_fetch_rules', status: r.status });
    const source = await r.text();
    if (!source.includes("rules_version") || !source.includes('service cloud.firestore')) {
      return res.status(422).json({ error: 'not_a_firestore_rules_file' });
    }
    const ruleset = await admin.securityRules().releaseFirestoreRulesetFromSource(source);
    res.status(200).json({ ok: true, ruleset: ruleset.name, createTime: ruleset.createTime, lines: source.split('\n').length });
  } catch (e) {
    console.error('deploy-rules', e);
    res.status(500).json({ error: 'failed', message: String(e && e.message || e).slice(0, 300) });
  }
};
