import { auth, db } from './firebase.js';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { getDoc, onSnapshot, updateDoc, writeBatch, increment } from 'firebase/firestore';
import { S, hooks, isCloud, role, can, subscriptionActive, isReviewer, activeBranch, allowedBranches, requireCan, getCurrencySymbol } from './state.js';
import { escapeHtml, todayLocal, round2, uuid, validStock, fefoBatches, shareText, isNative } from './util.js';
import { userRef, pharmacyRef, memberRef, branchesCol, branchCol, branchDoc, commitBatch, MAX_INVOICE_LINES } from './data.js';
import { toast } from './ui.js';
import * as panels from './panels.js';
import { initBilling, getEntitlement, logoutBilling } from './billing.js';

const BRANCH_KEY = 'saydaliati_active_branch_v2:';
const DEMO_KEY = 'saydaliati_demo_v2';
const DRAFT_PREFIX = 'saydaliati_pos_draft_v2:';
const LEGACY_KEYS = ['saydaliati_active_license_v1', 'saydaliati_branch_id_v1', 'saydaliati_local_inventory_cache_v1', 'saydaliati_local_meta_cache_v1', 'saydaliati_pos_draft_v1', 'saydaliati_pending_ops_v1'];

let suppressAuth = false;
let sessionToken = 0;
let sessionListeners = [];
let branchListeners = [];
let dailyDate = null;
let draftRestored = false;
let stockMeta = { pending: false, cache: false };
let searchDebounceTimer = null;

const clearList = list => { while (list.length) { try { list.pop()(); } catch (e) {} } };
const emptyState = () => ({ inventory: [], dailySales: {} });

// ================= شريط الحالة =================
function syncStatus(message, connected = false) {
  let e = document.getElementById('saydaliati-sync-status');
  if (!e) {
    e = document.createElement('div');
    e.id = 'saydaliati-sync-status';
    e.style.cssText = 'position:fixed;bottom:68px;left:12px;right:12px;z-index:35;text-align:center;pointer-events:none;font-size:10px;font-weight:800;color:#064e36;background:rgba(255,255,255,0.9);padding:3px 10px;border-radius:99px;max-width:340px;margin:auto;box-shadow:0 2px 6px rgba(0,0,0,0.08)';
    document.body.append(e);
  }
  e.textContent = message;
  const dot = document.getElementById('cloud-dot');
  if (dot) dot.className = `absolute top-2 right-2 w-2.5 h-2.5 rounded-full border border-emerald-950 ${connected ? 'bg-emerald-400' : 'bg-amber-400'}`;
}
function updateSyncLabel() {
  if (!isCloud()) return;
  let text = stockMeta.pending ? 'بانتظار المزامنة مع السحابة…'
    : (!navigator.onLine ? 'دون إنترنت — العمل محفوظ على الجهاز' : 'متصل بالسحابة ✓');
  if (!subscriptionActive()) text = 'الاشتراك غير فعّال — وضع العرض فقط | ' + text;
  syncStatus(text, navigator.onLine && !stockMeta.pending && subscriptionActive());
}
function setBranchLabel() {
  const el = document.getElementById('branch-name-label');
  if (!el) return;
  el.textContent = isCloud()
    ? `الصيدلية الحالية: ${S.session.pharmacy?.name || ''} — ${activeBranch()?.name || 'بلا فرع'}`
    : 'الوضع التجريبي المحلي (بيانات على جهازك فقط)';
}

// ================= الوضع التجريبي المحلي =================
function loadDemo() {
  try {
    const v = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null');
    if (v && Array.isArray(v.inventory)) return { inventory: v.inventory, dailySales: v.dailySales || {} };
  } catch (e) {}
  return emptyState();
}
let demoReady = false; // لا نحفظ قبل تحميل البيانات المحفوظة، وإلا تُمسح عند كل تحديث للصفحة
function saveDemo() {
  if (S.session.user || !demoReady) return;
  try { localStorage.setItem(DEMO_KEY, JSON.stringify({ inventory: S.state.inventory, dailySales: S.state.dailySales })); } catch (e) {}
}
function enterDemoMode() {
  sessionToken++;
  stopSession();
  S.state = loadDemo();
  demoReady = true;
  S.cart = [];
  setBranchLabel();
  updateUI();
  syncStatus('وضع تجريبي محلي — سجّل الدخول لتفعيل السحابة والفروع والموظفين', false);
}

// ================= الجلسة السحابية =================
function stopSession() {
  clearList(sessionListeners);
  clearList(branchListeners);
  S.session = { user: null, pharmacyId: null, pharmacy: null, member: null, branches: [], branchId: null };
  dailyDate = null;
  draftRestored = false;
}

async function logout() {
  try { await logoutBilling(); } catch (e) {}
  sessionToken++;
  try { await signOut(auth); } catch (e) {}
  enterDemoMode();
}

async function startSession(user) {
  const token = ++sessionToken;
  stopSession();
  S.session.user = user;
  S.state = emptyState();
  S.cart = [];
  setBranchLabel();
  updateUI();
  syncStatus('جارٍ تحميل بيانات الصيدلية…', false);
  let pid, member;
  try {
    const u = await getDoc(userRef(user.uid));
    if (token !== sessionToken) return;
    if (!u.exists()) { syncStatus('الحساب غير مرتبط بصيدلية بعد', false); hooks.showCreatePharmacy(); return; }
    pid = u.data().pharmacyId;
    const m = await getDoc(memberRef(pid, user.uid));
    if (token !== sessionToken) return;
    if (!m.exists() || m.data().status !== 'active') {
      alert('تم تعطيل حسابك أو إزالته من الصيدلية. تواصل مع مالك الصيدلية.');
      await logout();
      return;
    }
    member = { id: m.id, ...m.data() };
  } catch (e) {
    if (token !== sessionToken) return;
    syncStatus('تعذر تحميل الحساب', false);
    alert('تعذر تحميل حسابك: ' + (e.code || e.message) + (navigator.onLine ? '' : '\nيلزم اتصال بالإنترنت عند أول تسجيل دخول على الجهاز.'));
    return;
  }
  S.session.pharmacyId = pid;
  S.session.member = member;

  sessionListeners.push(onSnapshot(memberRef(pid, user.uid), snap => {
    if (!snap.exists() || snap.data().status !== 'active') {
      if (!snap.exists() && snap.metadata.fromCache) return;
      alert('تم تعطيل حسابك أو إزالته من الصيدلية.');
      logout();
      return;
    }
    S.session.member = { id: snap.id, ...snap.data() };
    ensureBranch();
    updateUI();
  }, e => console.warn('member listener', e)));

  sessionListeners.push(onSnapshot(pharmacyRef(pid), snap => {
    S.session.pharmacy = snap.exists() ? snap.data() : null;
    setBranchLabel();
    updateSyncLabel();
    updateUI();
  }, e => console.warn('pharmacy listener', e)));

  sessionListeners.push(onSnapshot(branchesCol(pid), snap => {
    S.session.branches = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    ensureBranch();
  }, e => console.warn('branches listener', e)));

  setupBilling();
}

function ensureBranch() {
  if (!isCloud()) return;
  const list = allowedBranches();
  const saved = localStorage.getItem(BRANCH_KEY + S.session.user.uid);
  const current = S.session.branchId;
  const target = current && list.some(b => b.id === current) ? current
    : list.some(b => b.id === saved) ? saved
    : (list[0]?.id || null);
  if (target !== current) selectBranch(target); else setBranchLabel();
}

function selectBranch(id) {
  clearList(branchListeners);
  draftRestored = false;
  S.session.branchId = id;
  S.state = emptyState();
  S.cart = [];
  if (id) { try { localStorage.setItem(BRANCH_KEY + S.session.user.uid, id); } catch (e) {} }
  setBranchLabel();
  updateUI();
  if (!id) { syncStatus('لا توجد فروع متاحة لحسابك. تواصل مع المالك.', false); return; }
  const pid = S.session.pharmacyId;

  branchListeners.push(onSnapshot(branchCol(pid, id, 'stock'), { includeMetadataChanges: true }, snap => {
    S.state.inventory = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    stockMeta = { pending: snap.metadata.hasPendingWrites, cache: snap.metadata.fromCache };
    restoreCartDraft();
    S.cart = S.cart.filter(c => S.state.inventory.some(i => i.id === c.id && validStock(i) && Number(i.qty) >= c.quantity));
    saveCartDraft();
    updateUI();
    updateSyncLabel();
  }, e => { syncStatus('تعذر قراءة المخزون: ' + (e.code || e.message), false); }));

  dailyDate = todayLocal();
  const day = dailyDate;
  branchListeners.push(onSnapshot(branchDoc(pid, id, 'daily', day), snap => {
    S.state.dailySales = { [day]: snap.exists() ? Number(snap.data().total) || 0 : 0 };
    updateUI();
  }, e => console.warn('daily listener', e)));
}

// ================= الاشتراك (المالك) =================
async function syncSubscription(ent) {
  if (role() !== 'owner' || !ent) return;
  const cur = S.session.pharmacy?.subscription || {};
  if (!!cur.active === ent.active && (cur.expiresAt || null) === (ent.expiresAt || null)) return;
  try {
    await updateDoc(pharmacyRef(S.session.pharmacyId), {
      subscription: { active: ent.active, expiresAt: ent.expiresAt || null, productId: ent.productId || null, source: 'store', updatedAt: new Date().toISOString() }
    });
  } catch (e) { console.warn('تعذر تحديث حالة الاشتراك', e); }
}
async function setupBilling() {
  if (role() !== 'owner' || isReviewer()) return;
  try {
    const ok = await initBilling(S.session.pharmacyId, ent => syncSubscription(ent));
    if (!ok) return;
    const ent = await getEntitlement();
    await syncSubscription(ent);
    if (!ent.active) hooks.showPaywall();
  } catch (e) { console.warn('billing', e); }
}

// ================= واجهة الشاشة الرئيسية والمخزون =================
function updateUI() {
  const inv = S.state.inventory || [];
  const sales = Number(S.state.dailySales?.[todayLocal()]) || 0;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.innerText = value; };
  const soon = i => { const ms = i.expiryDate ? new Date(i.expiryDate + 'T23:59:59') - new Date() : NaN; return ms > 0 && ms < 90 * 86400000; };
  set('dash-sales', `${getCurrencySymbol()} ${sales.toFixed(2)}`);
  set('dash-items-count', String(inv.length));
  set('dash-low-stock', `${inv.filter(i => Number(i.qty) < 50).length} صنف`);
  set('dash-near-expiry', `${inv.filter(soon).length} صنف`);
  renderInventoryList(inv, S.activeFilter);
  renderCart();
  saveDemo();
}

function renderInventoryList(items, filter = 'all') {
  const container = document.getElementById('inventory-cards-container');
  if (!container) return;
  const q = S.invQuery.trim().toLowerCase();
  const filtered = items.filter(i => {
    const ms = i.expiryDate ? new Date(i.expiryDate + 'T23:59:59') - new Date() : NaN;
    const matchFilter = filter === 'near_expiry' ? (ms >= 0 && ms < 90 * 86400000)
      : filter === 'low_stock' ? Number(i.qty) < 50 : true;
    const matchText = !q || String(i.name || '').toLowerCase().includes(q) || String(i.generic || '').toLowerCase().includes(q) || String(i.barcode || '').includes(q);
    return matchFilter && matchText;
  });
  container.innerHTML = '';
  if (!filtered.length) {
    container.innerHTML = '<div class="bg-white p-8 rounded-2xl border border-slate-200 text-center text-slate-400 text-xs font-bold">لا توجد أصناف في المخزون حالياً. أضف دواءً جديداً أو استورد نسخة احتياطية.</div>';
    return;
  }
  for (const item of filtered) {
    const qtyNum = Math.max(0, Number(item.qty) || 0);
    const isLow = qtyNum < 50;
    const isNear = item.expiryDate && (new Date(item.expiryDate + 'T23:59:59') - new Date() < 90 * 86400000);
    const boxColor = item.color || (isLow ? '#15803d' : '#1d4ed8');
    const card = document.createElement('div');
    card.className = 'bg-white p-3 rounded-2xl shadow-sm border border-slate-200 flex justify-between items-center';
    card.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="w-12 h-11 rounded-xl flex flex-col justify-center px-1.5 text-white font-bold shadow-sm shrink-0" style="background:linear-gradient(135deg, ${escapeHtml(boxColor)}, #0f172a)">
          <span class="text-[8px] truncate opacity-90">${escapeHtml(String(item.generic || item.name || '').split(' ')[0])}</span>
          <span class="text-[7px] bg-white/25 rounded px-1 mt-0.5 w-fit">Rx</span>
        </div>
        <div class="space-y-0.5">
          <h4 class="font-black text-slate-900 text-sm">${escapeHtml(item.name)}</h4>
          <p class="text-[11px] text-slate-500 font-semibold">${escapeHtml(item.generic || '')}</p>
          <div class="text-emerald-900 font-black text-xs">${getCurrencySymbol()} ${Number(item.price || 0).toFixed(2)}</div>
          ${isNear && item.expiryDate ? `<div class="text-[10px] text-red-600 font-extrabold">📅 تنتهي: ${escapeHtml(item.expiryDate)}</div>` : ''}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <div class="${isLow ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'} border font-black px-2.5 py-1.5 rounded-xl text-xs text-center min-w-[54px]">
          <div class="text-[9px] text-slate-500 font-bold">المخزون</div>
          <div>${qtyNum}</div>
        </div>
        <button data-add-id="${escapeHtml(item.id)}" aria-label="إضافة إلى السلة" class="bg-emerald-800 hover:bg-emerald-900 text-white w-8 h-8 rounded-xl font-black flex items-center justify-center shadow text-base">+</button>
      </div>`;
    container.append(card);
  }
}

window.filterInventory = (type, btn) => {
  document.querySelectorAll('.inv-filter-btn').forEach(b => b.className = 'inv-filter-btn px-4 py-2 rounded-full bg-white text-slate-700 border border-slate-200');
  btn.className = 'inv-filter-btn px-4 py-2 rounded-full bg-emerald-800 text-white shadow';
  S.activeFilter = type;
  renderInventoryList(S.state.inventory, type);
};
window.filterInventoryText = val => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => { S.invQuery = val; renderInventoryList(S.state.inventory, S.activeFilter); }, 150);
};

window.switchScreen = screenId => {
  if (screenId === 'screen-add-product' && isCloud() && !requireCan('editStock')) return;
  document.querySelectorAll('.screen-view').forEach(e => e.classList.add('hidden'));
  document.getElementById(screenId)?.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.className = 'nav-btn flex flex-col items-center gap-1 text-white/85');
  const id = ({ 'screen-home': 'nav-home', 'screen-pos': 'nav-pos', 'screen-inventory': 'nav-inv' })[screenId];
  if (id) document.getElementById(id).className = 'nav-btn flex flex-col items-center gap-1 text-amber-300';
};

// ================= نقطة البيع =================
const draftKey = () => `${DRAFT_PREFIX}${S.session.user?.uid}:${S.session.branchId}`;
function saveCartDraft() {
  try {
    if (!isCloud() || !S.session.branchId) return;
    const lines = S.cart.filter(c => Number.isSafeInteger(c.quantity) && c.quantity > 0).map(c => ({ id: String(c.id), quantity: c.quantity }));
    if (lines.length) localStorage.setItem(draftKey(), JSON.stringify({ version: 1, lines }));
    else localStorage.removeItem(draftKey());
  } catch (e) { console.warn('تعذر حفظ مسودة السلة', e); }
}
function restoreCartDraft() {
  if (draftRestored || !isCloud() || !S.state.inventory.length) return;
  draftRestored = true;
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft.version !== 1 || !Array.isArray(draft.lines) || draft.lines.length > 200) throw Error('مسودة غير صالحة');
    const restored = [], seen = new Set();
    for (const line of draft.lines) {
      if (!line || typeof line.id !== 'string' || seen.has(line.id) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) continue;
      seen.add(line.id);
      const item = S.state.inventory.find(i => i.id === line.id);
      if (item && validStock(item) && Number(item.qty) >= line.quantity) restored.push({ ...item, quantity: line.quantity });
    }
    S.cart = restored;
    saveCartDraft();
  } catch (e) { localStorage.removeItem(draftKey()); }
}

window.searchPosQuick = val => {
  const box = document.getElementById('pos-quick-results');
  if (!box) return;
  const q = val.trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); return; }
  const matches = S.state.inventory.filter(i => String(i.name || '').toLowerCase().includes(q) || String(i.barcode || '').includes(q)).slice(0, 6);
  if (!matches.length) { box.classList.add('hidden'); return; }
  box.innerHTML = matches.map(m => `
    <button data-quick-id="${escapeHtml(m.id)}" class="w-full text-right px-3.5 py-2.5 border-b border-slate-100 hover:bg-emerald-50 flex justify-between items-center text-xs font-bold">
      <span>${escapeHtml(m.name)}</span>
      <span class="text-emerald-800 font-black">${getCurrencySymbol()} ${Number(m.price).toFixed(2)} (${Math.max(0, Number(m.qty) || 0)})</span>
    </button>`).join('');
  box.classList.remove('hidden');
};

window.addToCart = id => {
  if (S.checkoutInProgress) return;
  const item = S.state.inventory.find(i => i.id === id);
  if (!item) return alert('الصنف غير موجود');
  if (isCloud() && !requireCan('sell')) return;
  const chosen = isCloud()
    ? fefoBatches(S.state.inventory, item).find(i => (S.cart.find(c => c.id === i.id)?.quantity || 0) < Number(i.qty))
    : item;
  if (!chosen) return alert('لا توجد دفعة صالحة ومتاحة للبيع');
  const existing = S.cart.find(c => c.id === chosen.id);
  if (existing) existing.quantity++;
  else S.cart.push({ ...chosen, quantity: 1 });
  renderCart();
  saveCartDraft();
  window.switchScreen('screen-pos');
};

window.updateCartQty = (id, delta) => {
  if (S.checkoutInProgress) return;
  const c = S.cart.find(i => i.id === id);
  const i = S.state.inventory.find(x => x.id === id);
  if (!c) return;
  const qty = c.quantity + delta;
  if (qty > 0 && i && qty > Number(i.qty)) return alert('الكمية تتجاوز المخزون المتوفر');
  if (qty <= 0) S.cart = S.cart.filter(x => x.id !== id);
  else c.quantity = qty;
  renderCart();
  saveCartDraft();
};
window.removeFromCart = id => {
  if (S.checkoutInProgress) return;
  S.cart = S.cart.filter(i => i.id !== id);
  renderCart();
  saveCartDraft();
};

const TRASH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

window.renderCart = function renderCart() {
  const container = document.getElementById('cart-items-container');
  if (!container) return;
  const subtotal = S.cart.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const discount = Math.max(0, Number(document.getElementById('pos-discount')?.value) || 0);
  const finalTotal = Math.max(0, subtotal - discount);
  const subEl = document.getElementById('cart-subtotal');
  const finEl = document.getElementById('cart-final-total');
  if (subEl) subEl.innerText = `${getCurrencySymbol()} ${subtotal.toFixed(2)}`;
  if (finEl) finEl.innerText = `${getCurrencySymbol()} ${finalTotal.toFixed(2)}`;
  if (!S.cart.length) {
    container.innerHTML = '<p class="text-slate-400 text-xs font-bold text-center py-10">السلة فارغة حالياً... اختر أدوية من قسم المخزون أو ابحث بالأعلى</p>';
    return;
  }
  container.innerHTML = '';
  for (const i of S.cart) {
    const boxColor = i.color || '#1d4ed8';
    const div = document.createElement('div');
    div.className = 'flex justify-between items-center bg-slate-50/70 p-2.5 rounded-2xl border border-slate-200/80';
    div.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="w-11 h-10 rounded-xl flex flex-col justify-center px-1.5 text-white font-bold shrink-0" style="background:linear-gradient(135deg, ${escapeHtml(boxColor)}, #0f172a)">
          <span class="text-[8px] truncate">${escapeHtml(String(i.generic || i.name || '').split(' ')[0])}</span>
        </div>
        <div>
          <h4 class="font-black text-slate-900 text-xs">${escapeHtml(i.name)}</h4>
          <span class="text-emerald-900 font-black text-xs">${getCurrencySymbol()} ${Number(i.price).toFixed(2)}</span>
        </div>
      </div>
      <div class="flex items-center gap-1.5">
        <div class="flex items-center gap-1.5 bg-white px-2 py-1 rounded-xl border border-slate-200 shadow-sm">
          <button data-qty-id="${escapeHtml(i.id)}" data-delta="1" class="w-5 h-5 rounded-md bg-emerald-50 text-emerald-900 font-black text-xs">+</button>
          <span class="font-black text-xs w-4 text-center">${i.quantity}</span>
          <button data-qty-id="${escapeHtml(i.id)}" data-delta="-1" class="w-5 h-5 rounded-md bg-slate-100 text-slate-700 font-black text-xs">-</button>
        </div>
        <button data-remove-id="${escapeHtml(i.id)}" aria-label="حذف من السلة" class="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100">${TRASH_SVG}</button>
      </div>`;
    container.append(div);
  }
};

function showElectronicInvoice(invoice, queued = false) {
  document.getElementById('saydaliati-invoice-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'saydaliati-invoice-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10002;background:rgba(0,27,21,0.82);display:grid;place-items:center;padding:14px;direction:rtl';
  const card = document.createElement('div');
  card.id = 'invoice-print-area';
  card.style.cssText = 'background:#fff;width:min(100%,390px);border-radius:24px;padding:20px;box-shadow:0 24px 48px rgba(0,0,0,0.35);max-height:90vh;overflow-y:auto';
  const c = getCurrencySymbol();
  const rowsHtml = invoice.items.map(it => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px dashed #e2e8f0">
      <div><strong>${escapeHtml(it.name)}</strong><br><span style="color:#64748b;font-size:10px">${it.quantity} × ${c} ${Number(it.unitPrice).toFixed(2)}</span></div>
      <strong style="color:#064e3b">${c} ${(it.quantity * Number(it.unitPrice)).toFixed(2)}</strong>
    </div>`).join('');
  const shopName = isCloud() ? (S.session.pharmacy?.name || 'الصيدلية') : 'الصيدلية (تجريبي)';
  const branchName = isCloud() ? (activeBranch()?.name || '') : '';
  card.innerHTML = `
    <div style="text-align:center;border-bottom:2px solid #004634;padding-bottom:12px;margin-bottom:12px">
      <div style="font-size:22px;font-weight:900;color:#004634">${escapeHtml(shopName)}</div>
      <div style="font-size:11px;color:#475569;font-weight:700">فاتورة بيع${branchName ? ' — ' + escapeHtml(branchName) : ''}</div>
      <div style="font-size:10px;color:#64748b;margin-top:4px">${escapeHtml(invoice.id)}</div>
      <div style="font-size:10px;color:#64748b">${new Date(invoice.createdAt).toLocaleString('ar-EG')}</div>
      ${queued ? '<div style="font-size:10px;color:#b45309;font-weight:800;margin-top:4px">حُفظت على الجهاز وستُرفع للسحابة عند عودة الاتصال</div>' : ''}
    </div>
    <div style="margin-bottom:12px">${rowsHtml}</div>
    <div style="background:#f8fafc;padding:10px;border-radius:12px;font-size:12px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>الإجمالي الفرعي:</span><strong>${c} ${Number(invoice.subtotal || invoice.total).toFixed(2)}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>الخصم:</span><strong>${c} ${Number(invoice.discount || 0).toFixed(2)}</strong></div>
      <div style="display:flex;justify-content:space-between;font-size:15px;color:#004634;border-top:1px solid #cbd5e1;padding-top:6px"><strong>الإجمالي النهائي:</strong><strong>${c} ${Number(invoice.total).toFixed(2)}</strong></div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:14px">
      <div id="invoice-qr-box" style="padding:8px;background:#fff;border:1px solid #e2e8f0;border-radius:12px"></div>
      <span style="font-size:10px;color:#64748b;font-weight:700">رمز التحقق الإلكتروني للفاتورة (QR)</span>
    </div>
    <div class="no-print" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <button id="print-btn" style="background:#00533c;color:white;padding:11px;border-radius:12px;font-weight:800;font-size:12px">🖨️ حفظ PDF / طباعة</button>
      <button id="share-wa-btn" style="background:#16a34a;color:white;padding:11px;border-radius:12px;font-weight:800;font-size:12px">📲 مشاركة الفاتورة</button>
      <button id="invoice-close-btn" style="grid-column:span 2;padding:10px;border:1px solid #cbd5e1;border-radius:12px;font-weight:800;font-size:12px">إغلاق والعودة</button>
    </div>`;
  overlay.append(card);
  document.body.append(overlay);
  if (window.QRCode) {
    new window.QRCode(document.getElementById('invoice-qr-box'), {
      text: `SAYDALIATI|${invoice.id}|TOTAL:${Number(invoice.total).toFixed(2)}|DATE:${invoice.createdAt}`,
      width: 110, height: 110, colorDark: '#003a2c', colorLight: '#ffffff'
    });
  }
  document.getElementById('invoice-close-btn').onclick = () => overlay.remove();
  document.getElementById('share-wa-btn').onclick = async () => {
    const lines = invoice.items.map(i => `• ${i.name} (${i.quantity} × ${c} ${Number(i.unitPrice).toFixed(2)})`).join('\n');
    const shared = await shareText('فاتورة ' + invoice.id, `*${shopName}*\nفاتورة رقم: ${invoice.id}\n${lines}\n*الإجمالي النهائي: ${c} ${Number(invoice.total).toFixed(2)}*`);
    if (shared) overlay.remove();
  };
  document.getElementById('print-btn').onclick = () => {
    if (isNative()) { document.getElementById('share-wa-btn').click(); return; }
    window.addEventListener('afterprint', () => overlay.remove(), { once: true });
    window.print();
  };
}

window.checkout = async () => {
  if (S.checkoutInProgress) return;
  if (!S.cart.length) return alert('السلة فارغة!');
  const discount = Math.max(0, Number(document.getElementById('pos-discount')?.value) || 0);
  const cartSubtotal = round2(S.cart.reduce((s, i) => s + Number(i.price) * i.quantity, 0));
  if (discount > cartSubtotal) return alert('قيمة الخصم أكبر من إجمالي الفاتورة');
  const resetDiscount = () => { const d = document.getElementById('pos-discount'); if (d) d.value = 0; };

  if (!isCloud()) {
    const total = Math.max(0, round2(cartSubtotal - discount));
    const inv = {
      id: 'INV-DEMO-' + Math.floor(100000 + Math.random() * 900000),
      items: S.cart.map(c => ({ id: c.id, name: c.name, quantity: c.quantity, unitPrice: Number(c.price) })),
      subtotal: cartSubtotal, discount, total, createdAt: new Date().toISOString()
    };
    for (const c of S.cart) {
      const target = S.state.inventory.find(i => i.id === c.id);
      if (target) target.qty = Math.max(0, Number(target.qty) - c.quantity);
    }
    S.state.dailySales[todayLocal()] = round2((Number(S.state.dailySales[todayLocal()]) || 0) + total);
    S.cart = [];
    resetDiscount();
    updateUI();
    showElectronicInvoice(inv);
    return;
  }

  if (!requireCan('sell')) return;
  if (S.cart.length > MAX_INVOICE_LINES) return alert(`الحد الأقصى ${MAX_INVOICE_LINES} صنفاً في الفاتورة الواحدة. أتمم هذه الفاتورة ثم ابدأ فاتورة جديدة.`);
  S.checkoutInProgress = true;
  try {
    const pid = S.session.pharmacyId, bid = S.session.branchId;
    const invoiceId = 'INV-' + uuid(), saleDay = todayLocal();
    const items = [];
    let subtotal = 0;
    for (const c of S.cart) {
      const item = S.state.inventory.find(i => i.id === c.id);
      if (!item) throw Error('الصنف غير موجود');
      if (!validStock(item)) throw Error('الدفعة غير صالحة أو منتهية الصلاحية: ' + item.name);
      if (Number(item.qty) < c.quantity) throw Error('الكمية غير كافية: ' + item.name);
      items.push({ id: item.id, name: item.name, barcode: item.barcode || '', expiryDate: item.expiryDate || '', quantity: c.quantity, unitPrice: Number(item.price) });
      subtotal += Number(item.price) * c.quantity;
    }
    subtotal = round2(subtotal);
    const total = Math.max(0, round2(subtotal - discount));
    const invoice = { id: invoiceId, items, subtotal, discount, total, createdAt: new Date().toISOString(), branchId: bid, cashierUid: S.session.user.uid, cashierName: S.session.member?.name || '' };
    // دفعة واحدة: خصم المخزون + الفاتورة + مبيعات اليوم (increment يتجمع بأمان من عدة أجهزة)
    const batch = writeBatch(db);
    for (const it of items) batch.update(branchDoc(pid, bid, 'stock', it.id), { qty: increment(-it.quantity) });
    batch.set(branchDoc(pid, bid, 'invoices', invoiceId), invoice);
    batch.set(branchDoc(pid, bid, 'daily', saleDay), { date: saleDay, total: increment(total), count: increment(1) }, { merge: true });
    const r = await commitBatch(batch);
    S.cart = [];
    resetDiscount();
    saveCartDraft();
    updateUI();
    showElectronicInvoice(invoice, r.queued);
  } catch (e) {
    alert('لم تُحفظ عملية البيع: ' + (e.message || 'خطأ في العملية'));
  } finally {
    S.checkoutInProgress = false;
  }
};

window.addNewProduct = async e => {
  e.preventDefault();
  const name = document.getElementById('new-name').value.trim();
  const generic = document.getElementById('new-generic').value.trim();
  const barcode = document.getElementById('new-barcode').value.trim();
  const expiryDate = document.getElementById('new-expiry').value;
  const price = Number(document.getElementById('new-price').value);
  const qty = Number(document.getElementById('new-qty').value);
  if (expiryDate && expiryDate < todayLocal()) return alert('لا يمكن إضافة دفعة منتهية الصلاحية');
  if (!name || !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(qty) || qty < 0 || !expiryDate) return alert('يرجى إدخال بيانات صحيحة');

  if (!isCloud()) {
    S.state.inventory.unshift({ id: 'demo-' + Date.now(), name, generic, barcode, expiryDate, price, qty, color: '#00683e' });
    updateUI();
    document.getElementById('add-product-form').reset();
    window.switchScreen('screen-inventory');
    return;
  }
  if (!requireCan('editStock')) return;
  try {
    const id = uuid();
    const batch = writeBatch(db);
    batch.set(branchDoc(S.session.pharmacyId, S.session.branchId, 'stock', id), { name, generic, barcode, expiryDate, price, qty, createdAt: new Date().toISOString(), createdBy: S.session.user.uid });
    const r = await commitBatch(batch);
    document.getElementById('add-product-form').reset();
    window.switchScreen('screen-inventory');
    toast(r.queued ? 'حُفظ الدواء على الجهاز وسيُرفع للسحابة عند عودة الاتصال ✓' : 'تمت إضافة الدواء وحفظه سحابياً ✓');
  } catch (err) {
    alert('تعذر حفظ الدواء: ' + (err.code || err.message || 'خطأ'));
  }
};

// ================= الباركود =================
let activeHtml5QrScanner = null;

async function scanBarcode(target = 'pos') {
  if (activeHtml5QrScanner) { try { await activeHtml5QrScanner.stop(); activeHtml5QrScanner.clear(); } catch (e) {} activeHtml5QrScanner = null; }
  document.getElementById('saydaliati-scanner-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'saydaliati-scanner-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10005;background:rgba(0,27,21,0.88);display:grid;place-items:center;padding:16px;direction:rtl';
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;width:min(100%,380px);border-radius:24px;padding:20px;box-shadow:0 24px 48px rgba(0,0,0,0.4);display:grid;gap:12px;text-align:center';
  const title = document.createElement('h3');
  title.textContent = 'مسح الباركود بالكاميرا';
  title.style.cssText = 'font-size:18px;font-weight:900;color:#004634;margin:0';
  const readerContainer = document.createElement('div');
  readerContainer.id = 'reader-container-modal';
  readerContainer.style.cssText = 'width:100%;min-height:240px;background:#000;border-radius:14px;overflow:hidden';
  const manualWrap = document.createElement('div');
  manualWrap.style.cssText = 'display:grid;gap:6px;text-align:right';
  manualWrap.innerHTML = '<label style="font-size:11px;font-weight:800;color:#475569">أو أدخل رقم الباركود يدوياً:</label>';
  const manualInputRow = document.createElement('div');
  manualInputRow.style.cssText = 'display:flex;gap:8px';
  const manualInput = document.createElement('input');
  manualInput.type = 'text';
  manualInput.placeholder = 'أدخل الباركود هنا...';
  manualInput.style.cssText = 'flex:1;padding:10px;border:1px solid #cbd5e1;border-radius:10px;font-size:16px;font-weight:700';
  const manualBtn = document.createElement('button');
  manualBtn.textContent = 'تأكيد';
  manualBtn.style.cssText = 'background:#006b3d;color:white;padding:10px 16px;border-radius:10px;font-weight:800;font-size:12px';
  manualInputRow.append(manualInput, manualBtn);
  manualWrap.append(manualInputRow);
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'إغلاق الكاميرا';
  closeBtn.style.cssText = 'background:#991b1b;color:white;padding:11px;border-radius:12px;font-weight:800;font-size:13px;width:100%';
  box.append(title, readerContainer, manualWrap, closeBtn);
  overlay.append(box);
  document.body.append(overlay);

  let closed = false, handled = false;
  const stopScanner = async () => {
    closed = true;
    const scanner = activeHtml5QrScanner;
    activeHtml5QrScanner = null;
    overlay.remove();
    try { if (scanner) { await scanner.stop(); scanner.clear(); } } catch (e) {}
  };
  const finish = val => { if (handled) return; handled = true; stopScanner(); handleScannedCode(val, target); };
  closeBtn.onclick = stopScanner;
  manualBtn.onclick = () => { const val = manualInput.value.trim(); if (val) finish(val); };
  manualInput.onkeypress = e => { if (e.key === 'Enter') { const val = manualInput.value.trim(); if (val) finish(val); } };

  setTimeout(async () => {
    if (closed) return;
    try {
      if (typeof Html5Qrcode === 'undefined') throw Error('مكتبة المسح غير متوفرة');
      const scanner = new Html5Qrcode('reader-container-modal');
      activeHtml5QrScanner = scanner;
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 130 } }, decodedText => finish(decodedText), () => {});
      if (closed) { try { await scanner.stop(); scanner.clear(); } catch (e) {} }
    } catch (e) {
      console.warn('تعذر تشغيل الكاميرا:', e);
      readerContainer.innerHTML = '<p style="color:#fff;font-size:12px;font-weight:700;padding:18px;line-height:1.7">تعذر تشغيل الكاميرا. تأكد من منح صلاحية الكاميرا للتطبيق، أو أدخل الباركود يدوياً بالأسفل.</p>';
      manualInput.focus();
    }
  }, 200);
}

function handleScannedCode(code, target) {
  if (target === 'new') { const el = document.getElementById('new-barcode'); if (el) el.value = code; return; }
  const found = S.state.inventory.find(i => i.barcode === code);
  if (found) {
    if (target === 'pos') window.addToCart(found.id);
    else {
      S.invQuery = code;
      const si = document.getElementById('inv-search'); if (si) si.value = code;
      renderInventoryList(S.state.inventory, S.activeFilter);
    }
  } else alert('لم يتم العثور على دواء بالباركود: ' + code);
}
window.scanBarcode = scanBarcode;

async function requestCameraAndStoragePermissions() {
  let camStatus = 'غير مدعومة';
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const testStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      testStream.getTracks().forEach(t => t.stop());
      camStatus = 'مفعّلة ومصرّح بها ✓';
    }
  } catch (e) { camStatus = 'مرفوضة أو غير متاحة (' + (e.name || 'خطأ') + ')'; }
  let storageStatus = 'متاح';
  try {
    if (navigator.storage && navigator.storage.persist) {
      const persisted = await navigator.storage.persist();
      storageStatus = persisted ? 'تخزين دائم محمي من المسح التلقائي ✓' : 'تخزين محلي نشط ✓';
    }
  } catch (e) {}
  alert(`حالة الصلاحيات في الجهاز:\n\n📷 صلاحية الكاميرا (للباركود): ${camStatus}\n💾 التخزين المحلي: ${storageStatus}`);
}
window.requestCameraAndStoragePermissions = requestCameraAndStoragePermissions;

// ================= ربط الواجهة =================
window.showAdminLogin = panels.showAccount;
window.showAccount = panels.showAccount;
window.showInvoices = panels.showInvoices;
window.showReports = panels.showReports;
window.showSuppliers = panels.showSuppliers;
window.showPurchases = panels.showPurchases;
window.showEmployees = panels.showEmployees;
window.showBranches = panels.showBranches;
window.showBackupAndRestore = panels.showBackupAndRestore;
window.showCurrencySettings = panels.showCurrencySettings;
window.getCurrencySymbol = getCurrencySymbol;

Object.assign(hooks, {
  setSuppressAuth: v => { suppressAuth = v; },
  startSession, stopSession, logout, selectBranch, syncSubscription, updateUI,
  showInvoice: showElectronicInvoice
});

document.addEventListener('click', event => {
  const add = event.target.closest('[data-add-id]');
  const remove = event.target.closest('[data-remove-id]');
  const qty = event.target.closest('[data-qty-id]');
  const quick = event.target.closest('[data-quick-id]');
  if (quick) {
    window.addToCart(quick.dataset.quickId);
    const si = document.getElementById('pos-search'); if (si) si.value = '';
    document.getElementById('pos-quick-results')?.classList.add('hidden');
  } else if (add) window.addToCart(add.dataset.addId);
  else if (remove) window.removeFromCart(remove.dataset.removeId);
  else if (qty) window.updateCartQty(qty.dataset.qtyId, Number(qty.dataset.delta));
});

window.addEventListener('online', updateSyncLabel);
window.addEventListener('offline', updateSyncLabel);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveDemo(); });
window.addEventListener('pagehide', saveDemo);
setInterval(saveDemo, 15000);
// عند تغيّر اليوم أثناء بقاء التطبيق مفتوحاً: أعد ربط مبيعات اليوم
setInterval(() => { if (isCloud() && dailyDate && dailyDate !== todayLocal()) selectBranch(S.session.branchId); }, 60000);

function boot() {
  LEGACY_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
  S.state = emptyState();
  setBranchLabel();
  updateUI();
  syncStatus('جارٍ التحميل…', false);
  onAuthStateChanged(auth, user => {
    if (suppressAuth) return;
    if (user) startSession(user); else enterDemoMode();
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
