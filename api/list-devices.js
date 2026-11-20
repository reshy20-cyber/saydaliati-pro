'use strict';
// المالك فقط: قائمة الأجهزة المصرح بها وحدّ الترخيص
const { db, cors, requireUser, getMember, body, DEVICES_PER_PHARMACY } = require('./_lib');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const { pharmacyId } = body(req);
    const member = pharmacyId && await getMember(pharmacyId, user.uid);
    if (!member || member.role !== 'owner') return res.status(403).json({ error: 'forbidden' });
    const pRef = db().doc('pharmacies/' + pharmacyId);
    const [p, all] = await Promise.all([pRef.get(), pRef.collection('devices').get()]);
    res.status(200).json({
      max: p.data()?.license?.maxDevices || DEVICES_PER_PHARMACY,
      devices: all.docs.map(x => ({ id: x.id, name: x.data().name || '', lastSeen: x.data().lastSeen || '' }))
    });
  } catch (e) { console.error('list-devices', e); res.status(500).json({ error: 'server_error' }); }
};
