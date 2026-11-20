'use strict';
// يسجّل الجهاز ضمن الأجهزة المصرح بها للصيدلية، ويرفض إذا بلغت الصيدلية حدّ ترخيصها
const { db, cors, requireUser, getMember, body, DEVICES_PER_PHARMACY } = require('./_lib');

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const { pharmacyId, deviceId, deviceName } = body(req);
    if (!pharmacyId || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceId || '')) return res.status(400).json({ error: 'bad_request' });
    const member = await getMember(pharmacyId, user.uid);
    if (!member) return res.status(403).json({ error: 'forbidden' });

    const pRef = db().doc('pharmacies/' + pharmacyId);
    const dRef = pRef.collection('devices').doc(deviceId);
    const result = await db().runTransaction(async tx => {
      const [p, d, all] = await Promise.all([tx.get(pRef), tx.get(dRef), tx.get(pRef.collection('devices'))]);
      const max = p.data()?.license?.maxDevices || DEVICES_PER_PHARMACY;
      const now = new Date().toISOString();
      if (d.exists) { tx.update(dRef, { lastSeen: now, uid: user.uid, name: String(deviceName || '').slice(0, 60) }); return { ok: true, max }; }
      if (all.size >= max) return { ok: false, max, devices: all.docs.map(x => ({ id: x.id, name: x.data().name || '', lastSeen: x.data().lastSeen || '' })) };
      tx.set(dRef, { uid: user.uid, name: String(deviceName || '').slice(0, 60), createdAt: now, lastSeen: now });
      return { ok: true, max };
    });
    res.status(result.ok ? 200 : 409).json(result.ok ? result : { error: 'device_limit', ...result });
  } catch (e) { console.error('register-device', e); res.status(500).json({ error: 'server_error' }); }
};
