import { auth } from './firebase.js';
import { CONFIG } from './config.js';

// عميل دوال الخادم الخاصة بالترخيص والأجهزة
async function call(path, payload) {
  const user = auth.currentUser;
  if (!user) throw new Error('غير مسجّل الدخول');
  const token = await user.getIdToken();
  const r = await fetch(CONFIG.apiBase + '/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'http_' + r.status), { status: r.status, data });
  return data;
}

const DEVICE_KEY = 'saydaliati_device_id';
export function getDeviceId() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch (e) {}
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
    try { localStorage.setItem(DEVICE_KEY, id); } catch (e) {}
  }
  return id;
}
const deviceName = () => (navigator.userAgentData?.platform || navigator.platform || 'جهاز') + ' · ' + (navigator.userAgent.match(/\(([^)]+)\)/)?.[1] || '').slice(0, 40);

// يسجّل هذا الجهاز؛ إن بلغت الصيدلية حدّ أجهزتها يرمي خطأ status=409
export const registerDevice = pharmacyId => call('register-device', { pharmacyId, deviceId: getDeviceId(), deviceName: deviceName() });
export const syncLicense = pharmacyId => call('sync-license', { pharmacyId });
export const listDevices = pharmacyId => call('list-devices', { pharmacyId });
export const removeDevice = (pharmacyId, deviceId) => call('remove-device', { pharmacyId, deviceId });
