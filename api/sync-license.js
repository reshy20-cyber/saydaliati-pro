'use strict';
// يستدعيه التطبيق بعد الشراء أو الاستعادة ليحدّث الترخيص فوراً دون انتظار الـ webhook
const { cors, requireUser, getMember, syncPharmacyLicense, body } = require('./_lib');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const { pharmacyId } = body(req);
    const member = pharmacyId && await getMember(pharmacyId, user.uid);
    if (!member || member.role !== 'owner') return res.status(403).json({ error: 'forbidden' });
    const license = await syncPharmacyLicense(pharmacyId);
    res.status(200).json({ license });
  } catch (e) { console.error('sync-license', e); res.status(500).json({ error: 'server_error' }); }
};
