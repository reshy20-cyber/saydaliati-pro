// محاكاة Firestore في الذاكرة + نسخة JavaScript من قواعد firestore.rules للتحقق من أن عمليات التطبيق تمر منها
const KEY = '__mock_db';
const store = new Map(JSON.parse(localStorage.getItem(KEY) || '[]'));
const persist = () => localStorage.setItem(KEY, JSON.stringify([...store]));
const listeners = new Set();
let pendingWrites = 0;
let autoId = 0;
export const mockDb = { store, stats: { batches: [], reads: 0 } };
window.__mock = mockDb;
window.__mockSet = (path, data) => { store.set(path, data); persist(); fire(); };   // يحاكي تغييراً من جهاز آخر

const uid = () => {
  try { const c = JSON.parse(localStorage.getItem('__mock_auth') || '{}').current?.['[DEFAULT]']; return c ? c.uid : null; } catch { return null; }
};
const err = (code, message) => Object.assign(new Error(message || code), { code });

// ---------- مراجع ----------
export const initializeFirestore = () => ({ type: 'db' });
export const getFirestore = () => ({ type: 'db' });
export const persistentLocalCache = () => ({});
const isCol = r => r && r.type === 'col';
export function collection(base, ...segs) {
  const path = isCol(base) || base?.type === 'doc' ? [base.path, ...segs].join('/') : segs.join('/');
  return { type: 'col', path, id: path.split('/').pop() };
}
export function doc(base, ...segs) {
  if (isCol(base) && segs.length === 0) { const id = 'auto' + (++autoId) + '_' + Math.random().toString(36).slice(2, 7); return { type: 'doc', path: base.path + '/' + id, id }; }
  const path = (isCol(base) || base?.type === 'doc' ? [base.path, ...segs] : segs).join('/');
  return { type: 'doc', path, id: path.split('/').pop() };
}
export const where = (field, op, value) => ({ k: 'where', field, op, value });
export const orderBy = (field, dir = 'asc') => ({ k: 'order', field, dir });
export const limit = n => ({ k: 'limit', n });
export const query = (col, ...constraints) => ({ type: 'query', col, constraints });
export const increment = n => ({ __inc: n });

// ---------- القواعد (ترجمة لقواعد firestore.rules) ----------
const get = p => store.get(p);
const me = (pid, u) => get(`pharmacies/${pid}/members/${u}`);   // undefined => خطأ تقييم => رفض
const activeMember = (pid, u) => { const m = me(pid, u); return m && m.status === 'active' ? m : null; };
const isActive = (pid, u) => !!u && !!activeMember(pid, u);
const isOwner = (pid, u) => { const m = u && activeMember(pid, u); return !!m && m.role === 'owner'; };
const isManager = (pid, u) => { const m = u && activeMember(pid, u); return !!m && ['owner', 'manager'].includes(m.role); };
const inBranch = (pid, bid, u) => { const m = u && activeMember(pid, u); return !!m && (m.allBranches === true || (m.branchIds || []).includes(bid)); };
const mgrInBranch = (pid, bid, u) => { const m = u && activeMember(pid, u); return !!m && ['owner', 'manager'].includes(m.role) && (m.allBranches === true || (m.branchIds || []).includes(bid)); };
const ownerUidOf = pid => get(`pharmacies/${pid}`)?.ownerUid;

function canRead(path, u) {
  const s = path.split('/');
  if (!u) return false;
  if (s[0] === 'users') return s[1] === u;
  if (s[0] !== 'pharmacies') return false;
  const pid = s[1];
  if (s.length <= 2) return isActive(pid, u);
  if (s[2] === 'members') return s[3] === u || isManager(pid, u) || s.length === 3 && isManager(pid, u);
  if (s[2] === 'suppliers') return isManager(pid, u);
  if (s[2] === 'branches') {
    if (s.length <= 4) return isActive(pid, u);
    const bid = s[3], sub = s[4];
    if (['stock', 'invoices', 'daily'].includes(sub)) return inBranch(pid, bid, u);
    if (['purchases', 'returns'].includes(sub)) return mgrInBranch(pid, bid, u);
  }
  return false;
}
function canWrite(op, u) {
  const s = op.path.split('/');
  if (!u) return false;
  const existing = get(op.path);
  const next = op.type === 'delete' ? null : op.next;
  if (s[0] === 'users') {
    if (op.type === 'delete') return s[1] === u || ownerUidOf(existing?.pharmacyId) === u;
    return s[1] === u || ownerUidOf(next?.pharmacyId) === u;
  }
  if (s[0] !== 'pharmacies') return false;
  const pid = s[1];
  if (s.length === 2) {
    if (op.type === 'delete') return existing?.ownerUid === u;
    if (!existing) return next.ownerUid === u;
    return existing.ownerUid === u && next.ownerUid === existing.ownerUid;
  }
  const sub = s[2];
  if (sub === 'members') {
    const mid = s[3];
    if (op.type === 'delete') return mid === u || isOwner(pid, u);
    if (!existing) return (mid === u && next.role === 'owner' && ownerUidOf(pid) === u) || isOwner(pid, u);
    return isOwner(pid, u);
  }
  if (sub === 'suppliers') return isManager(pid, u);
  if (sub === 'branches') {
    if (s.length === 4) return isOwner(pid, u);
    const bid = s[3], coll = s[4];
    if (coll === 'stock') {
      if (op.type === 'update' || (op.type === 'set' && existing)) {
        if (mgrInBranch(pid, bid, u)) return true;
        const changed = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(existing?.[k]));
        return inBranch(pid, bid, u) && changed.every(k => k === 'qty');
      }
      return mgrInBranch(pid, bid, u);       // create / delete
    }
    if (coll === 'invoices') {
      if (op.type === 'delete') return isOwner(pid, u);
      if (!existing) return inBranch(pid, bid, u) && next.branchId === bid;
      return mgrInBranch(pid, bid, u);
    }
    if (coll === 'daily') return inBranch(pid, bid, u);
    if (coll === 'purchases' || coll === 'returns') return op.type === 'delete' ? isOwner(pid, u) : mgrInBranch(pid, bid, u);
  }
  return false;
}

// ---------- تطبيق العمليات ----------
function resolveValue(old, v) { return v && typeof v === 'object' && '__inc' in v ? (Number(old) || 0) + v.__inc : v; }
function buildNext(op) {
  const existing = store.get(op.path);
  if (op.type === 'delete') return null;
  if (op.type === 'update') {
    if (!existing) throw err('not-found', 'No document to update: ' + op.path);
    const next = { ...existing }; for (const [k, v] of Object.entries(op.data)) next[k] = resolveValue(existing[k], v); return next;
  }
  const base = op.merge && existing ? { ...existing } : {};
  for (const [k, v] of Object.entries(op.data)) base[k] = resolveValue(base[k], v);
  return base;
}
function applyOps(ops) {
  const u = uid();
  if (ops.length > 20) throw err('invalid-argument', 'batch too large for rules access-call limit: ' + ops.length);
  const prepared = ops.map(op => ({ ...op, next: buildNext(op) }));
  for (const op of prepared) if (!canWrite(op, u)) throw err('permission-denied', `rules denied ${op.type} ${op.path} for ${u}`);
  mockDb.stats.batches.push(ops.length);
  for (const op of prepared) { if (op.type === 'delete') store.delete(op.path); else store.set(op.path, op.next); }
  persist(); fire();
}
let waiters = [];
function commit(ops) {
  if (!navigator.onLine) {
    applyOps(ops); pendingWrites++; fire();
    return new Promise(res => waiters.push(res));
  }
  try { applyOps(ops); return Promise.resolve(); } catch (e) { return Promise.reject(e); }
}
window.addEventListener('online', () => { const w = waiters; waiters = []; pendingWrites = 0; w.forEach(r => r()); fire(); });

export const setDoc = (ref, data, opts = {}) => commit([{ type: 'set', path: ref.path, data, merge: !!opts.merge }]);
export const updateDoc = (ref, data) => commit([{ type: 'update', path: ref.path, data }]);
export const deleteDoc = ref => commit([{ type: 'delete', path: ref.path }]);
export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opts = {}) { ops.push({ type: 'set', path: ref.path, data, merge: !!opts.merge }); return this; },
    update(ref, data) { ops.push({ type: 'update', path: ref.path, data }); return this; },
    delete(ref) { ops.push({ type: 'delete', path: ref.path }); return this; },
    commit() { return commit(ops); }
  };
}
export async function runTransaction(db, fn) {
  if (!navigator.onLine) throw err('unavailable', 'offline');
  const ops = [];
  const tx = {
    async get(ref) { return snapOf(ref); },
    set(ref, data, opts = {}) { ops.push({ type: 'set', path: ref.path, data, merge: !!opts.merge }); return tx; },
    update(ref, data) { ops.push({ type: 'update', path: ref.path, data }); return tx; },
    delete(ref) { ops.push({ type: 'delete', path: ref.path }); return tx; }
  };
  const r = await fn(tx);
  applyOps(ops);
  return r;
}

// ---------- القراءة ----------
const meta = () => ({ fromCache: !navigator.onLine, hasPendingWrites: pendingWrites > 0 });
function snapOf(ref) {
  if (!canRead(ref.path, uid())) throw err('permission-denied', 'rules denied read ' + ref.path);
  const data = store.get(ref.path);
  return { id: ref.id, ref, exists: () => data !== undefined, data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))), metadata: meta() };
}
function evalQuery(q) {
  const col = q.type === 'query' ? q.col : q;
  const cons = q.type === 'query' ? q.constraints : [];
  if (!canRead(col.path + '/x', uid()) && !canRead(col.path + '/x/y', uid()) && !canRead(col.path, uid())) {
    // مجموعات: تُقيَّم قاعدة القراءة على المسار الأب للمستند
    throw err('permission-denied', 'rules denied list ' + col.path);
  }
  let docs = [...store.entries()].filter(([p]) => p.startsWith(col.path + '/') && p.split('/').length === col.path.split('/').length + 1)
    .map(([p, d]) => ({ id: p.split('/').pop(), path: p, data: d }));
  for (const c of cons) {
    if (c.k === 'where') docs = docs.filter(d => c.op === '==' ? d.data[c.field] === c.value : c.op === '>=' ? d.data[c.field] >= c.value : true);
  }
  const ord = cons.find(c => c.k === 'order');
  if (ord) docs.sort((a, b) => (a.data[ord.field] > b.data[ord.field] ? 1 : a.data[ord.field] < b.data[ord.field] ? -1 : 0) * (ord.dir === 'desc' ? -1 : 1));
  const lim = cons.find(c => c.k === 'limit'); if (lim) docs = docs.slice(0, lim.n);
  mockDb.stats.reads += docs.length;
  const mk = d => ({ id: d.id, ref: { type: 'doc', path: d.path, id: d.id }, exists: () => true, data: () => JSON.parse(JSON.stringify(d.data)) });
  const arr = docs.map(mk);
  return { docs: arr, empty: arr.length === 0, size: arr.length, forEach: f => arr.forEach(f), metadata: meta() };
}
export async function getDoc(ref) { return snapOf(ref); }
export async function getDocs(q) { return evalQuery(q); }

function fire() { setTimeout(() => listeners.forEach(l => l()), 0); }
export function onSnapshot(target, ...rest) {
  const opts = typeof rest[0] === 'function' ? {} : rest.shift();
  const [next, onErr] = rest;
  let last = null, dead = false;
  const run = () => {
    if (dead) return;
    let result;
    try { result = (target.type === 'doc') ? snapOf(target) : evalQuery(target); }
    catch (e) { if (last !== 'err') { last = 'err'; onErr?.(e); } return; }
    const sig = JSON.stringify(target.type === 'doc' ? [result.exists(), result.data()] : result.docs.map(d => [d.id, d.data()])) + JSON.stringify(opts.includeMetadataChanges ? meta() : 0);
    if (sig === last) return; last = sig; next(result);
  };
  listeners.add(run); setTimeout(run, 0);
  return () => { dead = true; listeners.delete(run); };
}
