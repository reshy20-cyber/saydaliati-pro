'use strict';
// webhook من RevenueCat: أي شراء أو استرداد أو نقل يعيد حساب ترخيص الصيدلية من مصدر الحقيقة
const { syncPharmacyLicense, body } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const expected = process.env.RC_WEBHOOK_AUTH;
  if (!expected || req.headers.authorization !== expected) return res.status(401).json({ error: 'unauthorized' });
  try {
    const ev = body(req).event || {};
    const ids = new Set([ev.app_user_id, ev.original_app_user_id, ...(ev.aliases || []), ...(ev.transferred_to || []), ...(ev.transferred_from || [])]);
    for (const id of ids) {
      if (!id || String(id).startsWith('$RCAnonymousID')) continue;
      await syncPharmacyLicense(id).catch(e => console.error('sync', id, e.message));
    }
    res.status(200).json({ ok: true });
  } catch (e) { console.error('rc-webhook', e); res.status(500).json({ error: 'server_error' }); }
};
