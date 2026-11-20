'use strict';
// المالك فقط: يحذف جهازاً من القائمة المصرح بها ليحرّر مكانه
const { db, cors, requireUser, getMember, body } = require('./_lib');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const { pharmacyId, deviceId } = body(req);
    const member = pharmacyId && await getMember(pharmacyId, user.uid);
    if (!member || member.role !== 'owner' || !deviceId) return res.status(403).json({ error: 'forbidden' });
    await db().doc(`pharmacies/${pharmacyId}/devices/${deviceId}`).delete();
    res.status(200).json({ ok: true });
  } catch (e) { console.error('remove-device', e); res.status(500).json({ error: 'server_error' }); }
};
