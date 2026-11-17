// محاكاة بسيطة لـ Firebase Auth، تُحفظ في localStorage لتبقى بعد إعادة التحميل
const KEY = '__mock_auth';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { users: {}, current: {}, n: 0 }; } catch { return { users: {}, current: {}, n: 0 }; } };
const save = s => localStorage.setItem(KEY, JSON.stringify(s));
const instances = new Map();
const resets = (window.__resetEmails = window.__resetEmails || []);

export function getAuth(app) {
  const name = app?.name || '[DEFAULT]';
  if (!instances.has(name)) {
    const inst = { name, listeners: [], get currentUser() { const s = load(); const c = s.current[name]; return c ? { uid: c.uid, email: c.email, _auth: inst } : null; } };
    instances.set(name, inst);
  }
  return instances.get(name);
}
const notify = auth => setTimeout(() => auth.listeners.forEach(cb => cb(auth.currentUser)), 0);
const err = (code, message) => Object.assign(new Error(message || code), { code });

export async function createUserWithEmailAndPassword(auth, email, password) {
  const s = load(); email = email.toLowerCase();
  if (s.users[email]) throw err('auth/email-already-in-use');
  if (password.length < 6) throw err('auth/weak-password');
  s.n += 1; const uid = 'uid' + s.n;
  s.users[email] = { uid, email, password }; s.current[auth.name] = { uid, email }; save(s);
  notify(auth);
  return { user: { uid, email, _auth: auth } };
}
export async function signInWithEmailAndPassword(auth, email, password) {
  const s = load(); const u = s.users[email.toLowerCase()];
  if (!u || u.password !== password) throw err('auth/invalid-credential');
  s.current[auth.name] = { uid: u.uid, email: u.email }; save(s);
  notify(auth);
  return { user: { uid: u.uid, email: u.email, _auth: auth } };
}
export async function signOut(auth) { const s = load(); delete s.current[auth.name]; save(s); notify(auth); }
export function onAuthStateChanged(auth, cb) {
  auth.listeners.push(cb);
  setTimeout(() => cb(auth.currentUser), 0);
  return () => { auth.listeners = auth.listeners.filter(x => x !== cb); };
}
export async function sendPasswordResetEmail(auth, email) { resets.push(email); }
export async function deleteUser(user) {
  const s = load();
  for (const [em, u] of Object.entries(s.users)) if (u.uid === user.uid) delete s.users[em];
  delete s.current[user._auth.name]; save(s); notify(user._auth);
}
export const EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
export async function reauthenticateWithCredential(user, cred) {
  const u = load().users[cred.email.toLowerCase()];
  if (!u || u.password !== cred.password) throw err('auth/invalid-credential');
}
