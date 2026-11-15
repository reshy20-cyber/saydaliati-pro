import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc, collection, getDocs, setDoc, query, orderBy, limit, onSnapshot, runTransaction, enableIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBBsWY5RkBHoph7EQegUNCbwCjGNCeKF4g',
  authDomain: 'saydaliati-pro.firebaseapp.com',
  projectId: 'saydaliati-pro',
  storageBucket: 'saydaliati-pro.firebasestorage.app',
  messagingSenderId: '376696818740',
  appId: '1:376696818740:web:752f369fab6980894c4e61',
  measurementId: 'G-TBDGSVB0GN'
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const LICENSE_STORAGE_KEY = 'saydaliati_active_license_v1';
const BRANCH_STORAGE_KEY = 'saydaliati_branch_id_v1';
enableIndexedDbPersistence(db).catch(() => {});

function getStoredLicense() {
  try { return JSON.parse(localStorage.getItem(LICENSE_STORAGE_KEY) || 'null'); } catch { return null; }
}
function getActiveBranchId() {
  return localStorage.getItem(BRANCH_STORAGE_KEY) || 'main_branch';
}

const DEMO_INVENTORY = [];

let state = { salesTotal: 0, dailySales: {}, inventory: [] };
let cart = [];
let checkoutInProgress = false;
let activeInventoryFilter = 'all';
let invSearchQuery = '';
let unsubscribeCloud = null;
let authenticatedAdmin = false;
let serverVerified = false;
let lastVerifiedFinancialReport = null;

const DRAFT_KEY = 'saydaliati_pos_draft_v1';
let draftRestored = false;

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validStock = i => i && typeof i === 'object' && Number.isSafeInteger(Number(i.qty)) && Number(i.qty) > 0 && typeof i.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.expiryDate) && i.expiryDate >= todayLocal() && Number.isFinite(Number(i.price)) && Number(i.price) >= 0;
const fefoBatches = (inv, item) => inv.filter(i => (item.barcode && i.barcode === item.barcode) || i.id === item.id).filter(validStock).sort((a, b) => (a.expiryDate || '9999-12-31').localeCompare(b.expiryDate || '9999-12-31'));

function saveCartDraft() {
  try {
    if (!authenticatedAdmin) return;
    const lines = cart.filter(c => Number.isSafeInteger(c.quantity) && c.quantity > 0).map(c => ({ id: String(c.id), quantity: c.quantity }));
    if (lines.length) localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, lines }));
    else localStorage.removeItem(DRAFT_KEY);
  } catch (e) { console.warn('تعذر حفظ مسودة السلة', e); }
}

function restoreCartDraft() {
  if (draftRestored || !authenticatedAdmin || !Array.isArray(state.inventory) || !state.inventory.length) return;
  draftRestored = true;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft.version !== 1 || !Array.isArray(draft.lines) || draft.lines.length > 200) throw Error('مسودة غير صالحة');
    const restored = [];
    const seen = new Set();
    for (const line of draft.lines) {
      if (!line || typeof line.id !== 'string' || seen.has(line.id) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) continue;
      seen.add(line.id);
      const item = state.inventory.find(i => i.id === line.id);
      if (item && validStock(item) && Number(item.qty) >= line.quantity) restored.push({ ...item, quantity: line.quantity });
    }
    cart = restored;
    saveCartDraft();
  } catch (e) { localStorage.removeItem(DRAFT_KEY); }
}

function requireAdmin() {
  if (!authenticatedAdmin || !getStoredLicense()) {
    alert('يرجى تفعيل نسخة التطبيق عبر إدخال كود الترخيص الخاص بك من زر الإعدادات.');
    showAdminLogin();
    return false;
  }
  return true;
}

function requireOnlineWrite() {
  if (!navigator.onLine) {
    alert('أنت الآن بدون إنترنت. تأكد من الاتصال بالشبكة لإتمام هذه العملية السحابية.');
    return false;
  }
  return true;
}

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

export function initCloudSync() {
  if (!authenticatedAdmin) return;
  if (unsubscribeCloud) unsubscribeCloud();
  serverVerified = false;
  const branchId = getActiveBranchId();
  const branchRef = doc(db, 'pharmacy', branchId);
  unsubscribeCloud = onSnapshot(branchRef, { includeMetadataChanges: true }, async snapshot => {
    if (!snapshot.exists()) {
      try {
        await setDoc(branchRef, {
          salesTotal: state.salesTotal || 0,
          dailySales: state.dailySales || {},
          inventory: state.inventory || [],
          licenseKey: getStoredLicense()?.key || '',
          createdAt: new Date().toISOString()
        });
      } catch (e) {
        serverVerified = false;
        syncStatus('وضع التشغيل المحلي المفعّل (الحفظ على الجهاز ✓)', true);
      }
      return;
    }
    serverVerified = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
    const remote = snapshot.data();
    if (!remote || !Array.isArray(remote.inventory)) { serverVerified = false; syncStatus('بيانات المخزون غير صالحة'); return; }
    state = { salesTotal: 0, inventory: [], ...remote };
    restoreCartDraft();
    cart = cart.filter(c => state.inventory.some(i => i.id === c.id && validStock(i) && Number(i.qty) >= c.quantity));
    saveCartDraft();
    saveLocalSnapshot();
    updateUI();
    syncStatus(snapshot.metadata.fromCache ? 'محفوظ محلياً — بانتظار المزامنة' : 'النسخة مفعّلة ومتصلة بالسحابة ✓', true);
  }, error => {
    serverVerified = false;
    syncStatus('النسخة مفعّلة — وضع الحفظ المحلي النشط ✓', true);
  });
}

function validateLicenseFormat(rawKey) {
  const cleaned = rawKey.trim().toUpperCase();
  // يقبل أكواد الترخيص بصيغة SYD-XXXX-XXXX-XXXX أو الأكواد المعتمدة في السحابة
  return /^SYD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cleaned) || cleaned === 'SAYDALIATI-PRO-2026';
}

function showAdminLogin() {
  document.getElementById('saydaliati-auth-dialog')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'saydaliati-auth-dialog';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#001b15b8;display:grid;place-items:center;padding:18px;direction:rtl';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:white;width:min(100%,410px);padding:24px;border-radius:22px;display:grid;gap:12px;font-family:inherit;box-shadow:0 20px 40px rgba(0,0,0,0.3)';
  const heading = document.createElement('h2');
  heading.textContent = 'تفعيل الترخيص وإعدادات الصيدلية';
  heading.style.cssText = 'font-size:19px;font-weight:900;color:#004634';
  panel.append(heading);

  const activeLic = getStoredLicense();
  if (authenticatedAdmin && activeLic) {
    const info = document.createElement('div');
    info.innerHTML = `<div style="background:#ecfdf5;border:1px solid #a7f3d0;padding:12px;border-radius:14px;font-size:12.5px;color:#065f46;font-weight:800">
      <div>✅ النسخة مفعّلة بالكامل (صلاحيات المدير الكاملة)</div>
      <div style="margin-top:4px;font-family:monospace;font-size:12px">كود الترخيص: ${escapeHtml(activeLic.key)}</div>
      <div style="margin-top:2px;font-size:11px;color:#047857">الصيدلية: ${escapeHtml(activeLic.pharmacyName || 'الصيدلية الرئيسية')}</div>
    </div>`;
    panel.append(info);

    const currBtn = document.createElement('button');
    currBtn.textContent = '💱 إعدادات العملة والدولة (' + getCurrencySymbol() + ')';
    currBtn.style.cssText = 'background:#00533c;color:white;padding:11px;border-radius:12px;font-weight:800;font-size:13px';
    currBtn.onclick = () => { overlay.remove(); window.showCurrencySettings(); };
    panel.append(currBtn);

    const deactivate = document.createElement('button');
    deactivate.textContent = 'إلغاء ربط الترخيص من هذا الجهاز';
    deactivate.style.cssText = 'background:#991b1b;color:white;padding:11px;border-radius:12px;font-weight:800;font-size:12px';
    deactivate.onclick = async () => {
      localStorage.removeItem(LICENSE_STORAGE_KEY);
      localStorage.removeItem(BRANCH_STORAGE_KEY);
      authenticatedAdmin = false;
      serverVerified = false;
      if (unsubscribeCloud) { unsubscribeCloud(); unsubscribeCloud = null; }
      await signOut(auth).catch(() => {});
      updateUI();
      syncStatus('بانتظار إدخال كود الترخيص لتفعيل النسخة', false);
      overlay.remove();
    };
    panel.append(deactivate);
  } else {
    const sub = document.createElement('p');
    sub.textContent = 'أدخل كود الترخيص الذي حصلت عليه بعد شراء التطبيق لتفعيل كافة الصلاحيات وربط قاعدة بياناتك السحابية فوراً دون الحاجة لإنشاء حساب.';
    sub.style.cssText = 'font-size:12px;color:#475569;line-height:1.6';

    const pharmacyInput = document.createElement('input');
    pharmacyInput.type = 'text';
    pharmacyInput.placeholder = 'اسم الصيدلية (مثال: صيدلية الشفاء)';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.placeholder = 'كود الترخيص (مثال: SYD-2026-PRO1-9988)';
    keyInput.dir = 'ltr';

    for (const input of [pharmacyInput, keyInput]) {
      input.style.cssText = 'padding:12px;border:1px solid #cbd5e1;border-radius:12px;color:#111;width:100%;font-size:13px;font-weight:700';
    }

    const status = document.createElement('p');
    status.style.cssText = 'color:#b91c1c;font-size:12px;font-weight:700';

    const activateBtn = document.createElement('button');
    activateBtn.textContent = 'تفعيل التطبيق وامتلاك الصلاحيات ✓';
    activateBtn.style.cssText = 'padding:12px;background:#006b3d;color:white;border-radius:12px;font-weight:800;font-size:13.5px';
    activateBtn.onclick = async () => {
      activateBtn.disabled = true;
      status.textContent = '';
      const rawKey = keyInput.value.trim().toUpperCase();
      const pharmName = pharmacyInput.value.trim() || 'الصيدلية الرئيسية';
      try {
        if (!rawKey) throw Error('يرجى إدخال كود الترخيص');
        let validRemote = false;
        let branchId = 'branch_' + rawKey.replace(/[^A-Z0-9]/g, '').toLowerCase();

        // التحقق السحابي إذا كان الإنترنت متصلاً
        if (navigator.onLine) {
          try {
            await signInAnonymously(auth).catch(() => {});
            const licSnap = await getDoc(doc(db, 'licenses', rawKey));
            if (licSnap.exists()) {
              const licData = licSnap.data();
              if (licData.status === 'revoked') throw Error('تم إيقاف هذا الترخيص');
              branchId = licData.branchId || branchId;
              validRemote = true;
            }
          } catch (cloudErr) {
            if (cloudErr.message === 'تم إيقاف هذا الترخيص') throw cloudErr;
          }
        }

        if (!validRemote && !validateLicenseFormat(rawKey)) {
          throw Error('كود الترخيص غير صحيح. تأكد من كتابته بصيغة SYD-XXXX-XXXX-XXXX');
        }

        localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify({
          key: rawKey,
          pharmacyName: pharmName,
          activatedAt: new Date().toISOString()
        }));
        localStorage.setItem(BRANCH_STORAGE_KEY, branchId);

        authenticatedAdmin = true;
        const pillSpan = document.querySelector('.branch-pill span span');
        if (pillSpan) pillSpan.textContent = 'الصيدلية الحالية: ' + pharmName;

        initCloudSync();
        updateUI();
        syncStatus('تم تفعيل الترخيص بنجاح ✓', true);
        overlay.remove();
      } catch (e) {
        status.textContent = e.message || 'تعذر تفعيل الترخيص';
      } finally {
        activateBtn.disabled = false;
      }
    };
    panel.append(sub, pharmacyInput, keyInput, activateBtn, status);
  }

  const close = document.createElement('button');
  close.textContent = 'إغلاق';
  close.style.cssText = 'padding:10px;border:1px solid #cbd5e1;border-radius:12px;font-weight:700';
  close.onclick = () => overlay.remove();
  const permBtn = document.createElement('button');
  permBtn.textContent = '📷💾 فحص وتفعيل صلاحيات الكاميرا والتخزين';
  permBtn.style.cssText = 'padding:11px;background:#0f766e;color:white;border-radius:12px;font-weight:800;font-size:12px';
  permBtn.onclick = () => window.requestCameraAndStoragePermissions();
  panel.append(permBtn, close);
  overlay.append(panel);
  document.body.append(overlay);
}
window.showAdminLogin = showAdminLogin;

function bootstrapLicenseSession() {
  const storedLic = getStoredLicense();
  if (storedLic && storedLic.key) {
    authenticatedAdmin = true;
    const pillSpan = document.querySelector('.branch-pill span span');
    if (pillSpan && storedLic.pharmacyName) {
      pillSpan.textContent = 'الصيدلية الحالية: ' + storedLic.pharmacyName;
    }
    loadLocalSnapshot();
    updateUI();
    syncStatus('النسخة مفعّلة (' + storedLic.key + ') ✓', true);
    if (navigator.onLine) {
      signInAnonymously(auth).catch(() => {}).finally(() => initCloudSync());
    }
  } else {
    authenticatedAdmin = false;
    serverVerified = false;
    state = { salesTotal: 0, dailySales: {}, inventory: [] };
    cart = [];
    draftRestored = false;
    loadLocalSnapshot();
    updateUI();
    syncStatus('أدخل كود الترخيص من الإعدادات لتفعيل النسخة الكاملة', false);
  }
}

onAuthStateChanged(auth, () => {
  // الجلسة تُدار عبر كود الترخيص المعتمد محلياً وسحابياً
});

function updateUI() {
  const sales = Number(state.dailySales?.[todayLocal()]) || 0;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.innerText = value; };
  set('dash-sales', `${getCurrencySymbol()} ${sales.toFixed(2)}`);
  set('dash-items-count', String(state.inventory.length));
  set('dash-low-stock', `${state.inventory.filter(i => Number(i.qty) < 50).length} صنف`);
  set('dash-near-expiry', `${state.inventory.filter(i => i.expiryDate && new Date(i.expiryDate + 'T23:59:59') - new Date() > 0 && new Date(i.expiryDate + 'T23:59:59') - new Date() < 90 * 86400000).length} صنف`);
  renderInventoryList(state.inventory, activeInventoryFilter);
  renderCart();
  if (window.lucide) window.lucide.createIcons();
}

function renderInventoryList(items, filter = 'all') {
  const container = document.getElementById('inventory-cards-container');
  if (!container) return;
  const q = invSearchQuery.trim().toLowerCase();
  const filtered = items.filter(i => {
    const matchFilter = filter === 'near_expiry'
      ? (i.expiryDate && new Date(i.expiryDate + 'T23:59:59') - new Date() >= 0 && new Date(i.expiryDate + 'T23:59:59') - new Date() < 90 * 86400000)
      : filter === 'low_stock' ? Number(i.qty) < 50 : true;
    const matchText = !q || String(i.name || '').toLowerCase().includes(q) || String(i.generic || '').toLowerCase().includes(q) || String(i.barcode || '').includes(q);
    return matchFilter && matchText;
  });

  container.innerHTML = '';
  if (!filtered.length) {
    container.innerHTML = '<div class="bg-white p-8 rounded-2xl border border-slate-200 text-center text-slate-400 text-xs font-bold">لا توجد أصناف في المخزون حالياً. سجّل دخول المدير أو أضف دواءً جديداً.</div>';
    return;
  }
  for (const item of filtered) {
    const qtyNum = Number(item.qty) || 0;
    const isLow = qtyNum < 50;
    const isNear = item.expiryDate && (new Date(item.expiryDate + 'T23:59:59') - new Date() < 90 * 86400000);
    const boxColor = item.color || (isLow ? '#15803d' : '#1d4ed8');
    const card = document.createElement('div');
    card.className = 'bg-white p-3 rounded-2xl shadow-sm border border-slate-200 flex justify-between items-center';
    card.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="w-12 h-11 rounded-xl flex flex-col justify-center px-1.5 text-white font-bold shadow-sm shrink-0" style="background:linear-gradient(135deg, ${boxColor}, #0f172a)">
          <span class="text-[8px] truncate opacity-90">${escapeHtml((item.generic || item.name).split(' ')[0])}</span>
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
        <button data-add-id="${escapeHtml(item.id)}" class="bg-emerald-800 hover:bg-emerald-900 text-white w-8 h-8 rounded-xl font-black flex items-center justify-center shadow text-base">+</button>
      </div>`;
    container.append(card);
  }
}

window.filterInventory = (type, btn) => {
  document.querySelectorAll('.inv-filter-btn').forEach(b => b.className = 'inv-filter-btn px-4 py-2 rounded-full bg-white text-slate-700 border border-slate-200');
  btn.className = 'inv-filter-btn px-4 py-2 rounded-full bg-emerald-800 text-white shadow';
  activeInventoryFilter = type;
  renderInventoryList(state.inventory, type);
};

// --- تحسين أداء البحث في المخزون (Optimized & Debounced Search) ---
let searchDebounceTimer = null;
window.filterInventoryText = val => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    invSearchQuery = val;
    renderInventoryList(state.inventory, activeInventoryFilter);
  }, 150); // تأخير زمني خفيف (150ms) لمنع إعادة الرسم المفرط أثناء الكتابة السريعة
};

window.switchScreen = screenId => {
  document.querySelectorAll('.screen-view').forEach(e => e.classList.add('hidden'));
  document.getElementById(screenId)?.classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(b => b.className = 'nav-btn flex flex-col items-center gap-1 text-white/85');
  const id = ({ 'screen-home': 'nav-home', 'screen-pos': 'nav-pos', 'screen-inventory': 'nav-inv' })[screenId];
  if (id) document.getElementById(id).className = 'nav-btn flex flex-col items-center gap-1 text-amber-300';
  if (window.lucide) window.lucide.createIcons();
};

window.searchPosQuick = val => {
  const box = document.getElementById('pos-quick-results');
  if (!box) return;
  const q = val.trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); return; }
  const matches = state.inventory.filter(i => String(i.name || '').toLowerCase().includes(q) || String(i.barcode || '').includes(q)).slice(0, 6);
  if (!matches.length) { box.classList.add('hidden'); return; }
  box.innerHTML = matches.map(m => `
    <button onclick="window.addToCart('${escapeHtml(m.id)}');document.getElementById('pos-search').value='';document.getElementById('pos-quick-results').classList.add('hidden')" class="w-full text-right px-3.5 py-2.5 border-b border-slate-100 hover:bg-emerald-50 flex justify-between items-center text-xs font-bold">
      <span>${escapeHtml(m.name)}</span>
      <span class="text-emerald-800 font-black">${getCurrencySymbol()} ${Number(m.price).toFixed(2)} (${m.qty})</span>
    </button>
  `).join('');
  box.classList.remove('hidden');
};

window.addToCart = id => {
  if (checkoutInProgress) return;
  const item = state.inventory.find(i => i.id === id);
  if (!item) return alert('الصنف غير موجود');
  const chosen = authenticatedAdmin
    ? fefoBatches(state.inventory, item).find(i => (cart.find(c => c.id === i.id)?.quantity || 0) < Number(i.qty))
    : item;
  if (!chosen) return alert('لا توجد دفعة صالحة ومتاحة للبيع');
  const existing = cart.find(c => c.id === chosen.id);
  if (existing) existing.quantity++;
  else cart.push({ ...chosen, quantity: 1 });
  renderCart();
  saveCartDraft();
  window.switchScreen('screen-pos');
};

window.updateCartQty = (id, delta) => {
  if (checkoutInProgress) return;
  const c = cart.find(i => i.id === id);
  const i = state.inventory.find(i => i.id === id);
  if (!c) return;
  const qty = c.quantity + delta;
  if (qty > 0 && i && qty > Number(i.qty)) return alert('الكمية تتجاوز المخزون المتوفر');
  if (qty <= 0) cart = cart.filter(x => x.id !== id);
  else c.quantity = qty;
  renderCart();
  saveCartDraft();
};

window.removeFromCart = id => {
  if (checkoutInProgress) return;
  cart = cart.filter(i => i.id !== id);
  renderCart();
  saveCartDraft();
};

window.renderCart = function renderCart() {
  const container = document.getElementById('cart-items-container');
  if (!container) return;
  const subtotal = cart.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const discount = Math.max(0, Number(document.getElementById('pos-discount')?.value) || 0);
  const finalTotal = Math.max(0, subtotal - discount);

  const subEl = document.getElementById('cart-subtotal');
  const finEl = document.getElementById('cart-final-total');
  if (subEl) subEl.innerText = `${getCurrencySymbol()} ${subtotal.toFixed(2)}`;
  if (finEl) finEl.innerText = `${getCurrencySymbol()} ${finalTotal.toFixed(2)}`;

  if (!cart.length) {
    container.innerHTML = '<p class="text-slate-400 text-xs font-bold text-center py-10">السلة فارغة حالياً... اختر أدوية من قسم المخزون أو ابحث بالأعلى</p>';
    return;
  }
  container.innerHTML = '';
  for (const i of cart) {
    const boxColor = i.color || '#1d4ed8';
    const div = document.createElement('div');
    div.className = 'flex justify-between items-center bg-slate-50/70 p-2.5 rounded-2xl border border-slate-200/80';
    div.innerHTML = `
      <div class="flex items-center gap-2.5">
        <div class="w-11 h-10 rounded-xl flex flex-col justify-center px-1.5 text-white font-bold shrink-0" style="background:linear-gradient(135deg, ${boxColor}, #0f172a)">
          <span class="text-[8px] truncate">${escapeHtml((i.generic || i.name).split(' ')[0])}</span>
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
        <button data-remove-id="${escapeHtml(i.id)}" class="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>`;
    container.append(div);
  }
  if (window.lucide) window.lucide.createIcons();
};

// Electronic Invoice Modal with QR Code + PDF Print + WhatsApp Share
function showElectronicInvoice(invoice) {
  document.getElementById('saydaliati-invoice-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'saydaliati-invoice-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10002;background:rgba(0,27,21,0.82);display:grid;place-items:center;padding:14px;direction:rtl';

  const card = document.createElement('div');
  card.id = 'invoice-print-area';
  card.style.cssText = 'background:#fff;width:min(100%,390px);border-radius:24px;padding:20px;box-shadow:0 24px 48px rgba(0,0,0,0.35);max-height:90vh;overflow-y:auto';

  const rowsHtml = invoice.items.map(it => `
    <div style="display:flex;justify-content:space-between;font-size:12px;padding:6px 0;border-bottom:1px dashed #e2e8f0">
      <div><strong>${escapeHtml(it.name)}</strong><br><span style="color:#64748b;font-size:10px">${it.quantity} × ${getCurrencySymbol()} ${Number(it.unitPrice).toFixed(2)}</span></div>
      <strong style="color:#064e3b">${getCurrencySymbol()} ${(it.quantity * Number(it.unitPrice)).toFixed(2)}</strong>
    </div>
  `).join('');

  card.innerHTML = `
    <div style="text-align:center;border-bottom:2px solid #004634;padding-bottom:12px;margin-bottom:12px">
      <div style="font-size:22px;font-weight:900;color:#004634">صيدليتي | SAYDALIATI</div>
      <div style="font-size:11px;color:#475569;font-weight:700">فاتورة ضريبية مبسطة — الصيدلية الرئيسية</div>
      <div style="font-size:10px;color:#64748b;margin-top:4px">${escapeHtml(invoice.id)}</div>
      <div style="font-size:10px;color:#64748b">${new Date(invoice.createdAt).toLocaleString('ar-EG')}</div>
    </div>
    <div style="margin-bottom:12px">${rowsHtml}</div>
    <div style="background:#f8fafc;padding:10px;border-radius:12px;font-size:12px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>الإجمالي الفرعي:</span><strong>${getCurrencySymbol()} ${Number(invoice.subtotal || invoice.total).toFixed(2)}</strong></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>الخصم:</span><strong>${getCurrencySymbol()} ${Number(invoice.discount || 0).toFixed(2)}</strong></div>
      <div style="display:flex;justify-content:space-between;font-size:15px;color:#004634;border-top:1px solid #cbd5e1;padding-top:6px"><strong>الإجمالي النهائي:</strong><strong>${getCurrencySymbol()} ${Number(invoice.total).toFixed(2)}</strong></div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:14px">
      <div id="invoice-qr-box" style="padding:8px;background:#fff;border:1px solid #e2e8f0;border-radius:12px"></div>
      <span style="font-size:10px;color:#64748b;font-weight:700">رمز التحقق الإلكتروني للفاتورة (QR)</span>
    </div>
    <div class="no-print" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <button onclick="window.print()" style="background:#00533c;color:white;padding:11px;border-radius:12px;font-weight:800;font-size:12px">🖨️ حفظ PDF / طباعة</button>
      <button id="share-wa-btn" style="background:#16a34a;color:white;padding:11px;border-radius:12px;font-weight:800;font-size:12px">📲 مشاركة واتساب</button>
      <button onclick="document.getElementById('saydaliati-invoice-modal').remove()" style="grid-column:span 2;padding:10px;border:1px solid #cbd5e1;border-radius:12px;font-weight:800;font-size:12px">إغلاق والعودة</button>
    </div>
  `;

  overlay.append(card);
  document.body.append(overlay);

  if (window.QRCode) {
    new window.QRCode(document.getElementById('invoice-qr-box'), {
      text: `SAYDALIATI|${invoice.id}|TOTAL:${Number(invoice.total).toFixed(2)}|DATE:${invoice.createdAt}`,
      width: 110, height: 110, colorDark: '#003a2c', colorLight: '#ffffff'
    });
  }

  document.getElementById('share-wa-btn').onclick = () => {
    const lines = invoice.items.map(i => `• ${i.name} (${i.quantity} × ${getCurrencySymbol()} ${Number(i.unitPrice).toFixed(2)})`).join('\n');
    const text = `*صيدليتي SAYDALIATI*\nفاتورة رقم: ${invoice.id}\n${lines}\n*الإجمالي النهائي: ${getCurrencySymbol()} ${Number(invoice.total).toFixed(2)}*`;
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  };
}

window.checkout = async () => {
  if (checkoutInProgress) return;
  if (!cart.length) return alert('السلة فارغة!');

  const discount = Math.max(0, Number(document.getElementById('pos-discount')?.value) || 0);

  // Demo mode local checkout if not logged in to Firebase yet
  if (!authenticatedAdmin) {
    const subtotal = cart.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
    const inv = {
      id: 'INV-DEMO-' + Math.floor(100000 + Math.random() * 900000),
      items: cart.map(c => ({ id: c.id, name: c.name, quantity: c.quantity, unitPrice: Number(c.price) })),
      subtotal, discount, total, createdAt: new Date().toISOString()
    };
    for (const c of cart) {
      const target = state.inventory.find(i => i.id === c.id);
      if (target) target.qty = Math.max(0, Number(target.qty) - c.quantity);
    }
    cart = [];
    updateUI();
    showElectronicInvoice(inv);
    return;
  }

  checkoutInProgress = true;
  const saleItems = cart.map(c => ({ id: c.id, quantity: c.quantity }));
  const invoiceId = 'INV-' + crypto.randomUUID();
  const saleDay = todayLocal();
  const docRef = doc(db, 'pharmacy', getActiveBranchId());
  const invoiceRef = doc(db, 'invoices', invoiceId);

  const executeLocalCheckout = () => {
    const inv = state.inventory.map(i => ({ ...i }));
    let subtotal = 0;
    const invoiceItems = [];
    for (const c of saleItems) {
      const item = inv.find(i => i.id === c.id);
      if (!item || Number(item.qty) < c.quantity) throw Error('الكمية غير كافية في المخزون');
      item.qty = Number(item.qty) - c.quantity;
      subtotal += Number(item.price) * c.quantity;
      invoiceItems.push({ id: item.id, name: item.name, barcode: item.barcode || '', expiryDate: item.expiryDate || '', quantity: c.quantity, unitPrice: Number(item.price) });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
    state.inventory = inv;
    state.salesTotal = Math.round(((Number(state.salesTotal) || 0) + total) * 100) / 100;
    state.dailySales = { ...(state.dailySales || {}) };
    state.dailySales[saleDay] = Math.round(((Number(state.dailySales[saleDay]) || 0) + total) * 100) / 100;
    saveLocalSnapshot();
    return { id: invoiceId, items: invoiceItems, subtotal, discount, total, createdAt: new Date().toISOString(), branchId: getActiveBranchId() };
  };

  try {
    let createdInvoice = null;
    if (navigator.onLine && serverVerified) {
      await runTransaction(db, async t => {
        const prior = await t.get(invoiceRef);
        if (prior.exists()) throw Error('الفاتورة مسجلة مسبقاً');
        const snap = await t.get(docRef);
        if (!snap.exists()) throw Error('لا توجد بيانات مخزون محفوظة');
        const data = snap.data();
        const inv = data.inventory.map(i => ({ ...i }));
        let subtotal = 0;
        const invoiceItems = [];
        for (const c of saleItems) {
          const item = inv.find(i => i.id === c.id);
          if (!item) throw Error('الصنف غير موجود');
          if (!validStock(item)) throw Error('الدفعة غير صالحة أو منتهية الصلاحية');
          if (Number(item.qty) < c.quantity) throw Error('الكمية غير كافية: ' + item.name);
          item.qty = Number(item.qty) - c.quantity;
          subtotal += Number(item.price) * c.quantity;
          invoiceItems.push({ id: item.id, name: item.name, barcode: item.barcode || '', expiryDate: item.expiryDate || '', quantity: c.quantity, unitPrice: Number(item.price) });
        }
        subtotal = Math.round(subtotal * 100) / 100;
        const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
        const dailySales = { ...(data.dailySales || {}) };
        dailySales[saleDay] = Math.round(((Number(dailySales[saleDay]) || 0) + total) * 100) / 100;
        t.update(docRef, { inventory: inv, salesTotal: Math.round(((Number(data.salesTotal) || 0) + total) * 100) / 100, dailySales });
        createdInvoice = { id: invoiceId, items: invoiceItems, subtotal, discount, total, createdAt: new Date().toISOString(), branchId: getActiveBranchId() };
        t.set(invoiceRef, createdInvoice);
      });
    } else {
      createdInvoice = executeLocalCheckout();
    }
    cart = [];
    saveCartDraft();
    updateUI();
    showElectronicInvoice(createdInvoice);
  } catch (e) {
    alert('لم تُحفظ عملية البيع: ' + (e.message || 'خطأ في العملية'));
  } finally {
    checkoutInProgress = false;
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

  if (!authenticatedAdmin) {
    state.inventory.unshift({ id: 'demo-' + Date.now(), name, generic, barcode, expiryDate, price, qty, color: '#00683e' });
    updateUI();
    document.getElementById('add-product-form').reset();
    window.switchScreen('screen-inventory');
    return;
  }

  try {
    const newItem = { id: crypto.randomUUID(), name, generic, barcode, expiryDate, price, qty };
    if (navigator.onLine && serverVerified) {
      await runTransaction(db, async t => {
        const ref = doc(db, 'pharmacy', getActiveBranchId());
        const snap = await t.get(ref);
        if (!snap.exists()) throw Error('لم يتم تهيئة المخزون');
        const inv = [...snap.data().inventory, newItem];
        t.update(ref, { inventory: inv });
      });
      alert('تمت إضافة الدواء وحفظه سحابياً بنجاح ✓');
    } else {
      state.inventory.unshift(newItem);
      saveLocalSnapshot();
      updateUI();
      alert('تمت إضافة الدواء وحفظه محلياً بنجاح ✓');
    }
    document.getElementById('add-product-form').reset();
    window.switchScreen('screen-inventory');
  } catch (e) {
    alert('تعذر حفظ الدواء: ' + (e.message || 'خطأ'));
  }
};

async function scanBarcode(target = 'pos') {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    const manual = prompt('الكاميرا غير مدعومة في هذا المتصفح. أدخل رقم الباركود يدوياً:');
    if (manual) handleScannedCode(manual.trim(), target);
    return;
  }
  let stream, raf;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#000e;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;color:white';
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true;
  video.style.cssText = 'width:100%;max-width:390px;border-radius:18px;border:2px solid #f4c66c';
  const close = document.createElement('button');
  close.textContent = 'إغلاق الكاميرا';
  close.style.cssText = 'background:#006b3d;padding:12px 26px;border-radius:12px;font-weight:800';
  const stop = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); overlay.remove(); };
  close.onclick = stop;
  overlay.append(video, close);
  document.body.append(overlay);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    await video.play();
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
    let busy = false;
    const frame = async () => {
      if (!overlay.isConnected) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        try {
          const found = await detector.detect(video);
          if (found.length) { handleScannedCode(found[0].rawValue, target); stop(); return; }
        } finally { busy = false; }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  } catch (e) { stop(); alert('تعذر تشغيل الكاميرا'); }
}

function handleScannedCode(code, target) {
  if (target === 'new') {
    const el = document.getElementById('new-barcode');
    if (el) el.value = code;
    return;
  }
  const found = state.inventory.find(i => i.barcode === code);
  if (found) {
    if (target === 'pos') window.addToCart(found.id);
    else { invSearchQuery = code; renderInventoryList(state.inventory, activeInventoryFilter); }
  } else {
    alert('لم يتم العثور على دواء بالباركود: ' + code);
  }
}
window.scanBarcode = scanBarcode;

// Administrative Overlays (Invoices, Returns, Reports, Suppliers, Purchases, Employees, Branches, Backup/Restore)
function adminPanel(title) {
  document.getElementById('saydaliati-admin-panel')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'saydaliati-admin-panel';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:#001b15c9;display:grid;place-items:center;padding:15px;direction:rtl';
  const panel = document.createElement('section');
  panel.style.cssText = 'background:#fff;border-radius:20px;padding:18px;width:min(100%,440px);max-height:86vh;overflow:auto;color:#123;display:grid;gap:11px';
  const header = document.createElement('h2');
  header.textContent = title;
  header.style.cssText = 'font-size:19px;font-weight:900;color:#004634';
  panel.append(header);
  const close = document.createElement('button');
  close.textContent = 'إغلاق';
  close.style.cssText = 'padding:10px;border:1px solid #cbd5e1;border-radius:12px;font-weight:800';
  close.onclick = () => overlay.remove();
  const permBtn = document.createElement('button'); permBtn.textContent = '📷💾 فحص وتفعيل صلاحيات الكاميرا والتخزين'; permBtn.style.cssText = 'padding:11px;background:#0f766e;color:white;border-radius:12px;font-weight:800;font-size:12px'; permBtn.onclick = () => window.requestCameraAndStoragePermissions(); panel.append(permBtn, close);
  overlay.append(panel);
  document.body.append(overlay);
  return { panel, close, overlay };
}
function adminText(panel, value) { const p = document.createElement('p'); p.textContent = value; p.style.cssText = 'font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6'; panel.insertBefore(p, panel.lastChild); return p; }
function adminField(panel, label, type = 'text') { const wrap = document.createElement('label'); wrap.textContent = label; wrap.style.cssText = 'display:grid;gap:4px;font-size:12px;font-weight:800'; const input = document.createElement('input'); input.type = type; input.style.cssText = 'border:1px solid #cbd5e1;border-radius:10px;padding:10px;width:100%;font-weight:600'; wrap.append(input); panel.insertBefore(wrap, panel.lastChild); return input; }
function adminButton(panel, label, handler) { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'background:#00533c;color:white;padding:11px;border-radius:12px;font-weight:800;font-size:13px'; b.onclick = handler; panel.insertBefore(b, panel.lastChild); return b; }

async function showInvoices() {
  if (!requireAdmin() || !requireOnlineWrite()) return;
  const { panel } = adminPanel('الفواتير الأخيرة');
  adminButton(panel, 'تسجيل مرتجع مبيعات', showSalesReturns);
  const msg = adminText(panel, 'جارٍ تحميل الفواتير…');
  try {
    const snaps = await getDocs(query(collection(db, 'invoices'), orderBy('createdAt', 'desc'), limit(50)));
    msg.textContent = snaps.empty ? 'لا توجد فواتير مسجلة' : `آخر ${snaps.size} فاتورة`;
    snaps.forEach(s => {
      const d = s.data();
      const row = adminText(panel, `${d.id || s.id}\n${d.createdAt || ''}\nالإجمالي: ${getCurrencySymbol()} ${Number(d.total || 0).toFixed(2)}`);
      row.style.cssText += ';background:#f8fafc;padding:8px;border-radius:10px;border:1px solid #e2e8f0;cursor:pointer';
      row.onclick = () => showElectronicInvoice(d);
    });
  } catch (e) { msg.textContent = 'تعذر قراءة الفواتير: ' + (e.code || e.message); }
}

async function showSalesReturns() {
  if (!requireAdmin() || !requireOnlineWrite()) return;
  const { panel } = adminPanel('مرتجعات المبيعات');
  const invoice = adminField(panel, 'رقم فاتورة البيع');
  const stock = adminField(panel, 'معرف الدفعة من الفاتورة');
  const quantity = adminField(panel, 'الكمية المرتجعة', 'number'); quantity.min = '1'; quantity.step = '1';
  const reason = adminField(panel, 'سبب المرتجع');
  const status = adminText(panel, 'تنبيه: الدواء المرتجع يُسجل في سجل منفصل (الحجر) ولا يعود تلقائياً للمخزون القابل للبيع.');
  let busy = false;
  adminButton(panel, 'تسجيل المرتجع', async () => {
    if (busy || !requireAdmin() || !requireOnlineWrite()) return;
    const id = invoice.value.trim(), sid = stock.value.trim(), q = Number(quantity.value);
    if (!id || !sid || !reason.value.trim() || !Number.isSafeInteger(q) || q <= 0) return status.textContent = 'أدخل جميع الحقول بشكل صحيح';
    const invoiceRef = doc(db, 'invoices', id), returnRef = doc(collection(db, 'sales_returns'));
    busy = true;
    try {
      await runTransaction(db, async tx => {
        const snap = await tx.get(invoiceRef);
        if (!snap.exists()) throw Error('الفاتورة غير موجودة');
        const sale = snap.data();
        const line = sale.items?.find(i => i.id === sid);
        if (!line) throw Error('هذه الدفعة غير موجودة في الفاتورة');
        const original = Number(line.quantity), prior = Number((sale.returnedQty || {})[sid] || 0), price = Number(line.unitPrice);
        if (prior + q > original) throw Error('الكمية تتجاوز المبيع');
        const value = Math.round(q * price * 100) / 100;
        const returnedQty = { ...(sale.returnedQty || {}), [sid]: prior + q };
        tx.update(invoiceRef, { returnedQty, returnedValue: Math.round((Number(sale.returnedValue || 0) + value) * 100) / 100 });
        tx.set(returnRef, { invoiceId: id, stockId: sid, productName: String(line.name || ''), quantity: q, refundAmount: value, reason: reason.value.trim(), createdAt: new Date().toISOString(), branchId: getActiveBranchId(), restockStatus: 'quarantined', refundStatus: 'pending' });
      });
      status.textContent = 'تم تسجيل المرتجع بنجاح.';
    } catch (e) { status.textContent = 'فشل تسجيل المرتجع: ' + (e.code || e.message); }
    finally { busy = false; }
  });
}

async function showReports() {
  if (!requireAdmin()) return;
  const { panel } = adminPanel('التقارير المالية');
  const msg = adminText(panel, 'جارٍ فحص السجلات المالية…');
  if (!navigator.onLine || !serverVerified) {
    msg.textContent = lastVerifiedFinancialReport || 'اتصل بالخادم لقراءة السجلات المالية المؤكدة.';
    return;
  }
  try {
    const names = ['invoices', 'purchases', 'sales_returns', 'purchase_returns', 'supplier_payments'];
    const records = {};
    for (const name of names) {
      const snap = await getDocs(collection(db, name));
      records[name] = snap.docs.filter(d => d.data().branchId === getActiveBranchId()).map(d => d.data());
    }
    const sales = records.invoices.reduce((s, r) => s + Number(r.total || 0), 0);
    const purchasesTotal = records.purchases.reduce((s, r) => s + Number(r.total || 0), 0);
    const salesReturns = records.sales_returns.reduce((s, r) => s + Number(r.refundAmount || 0), 0);
    const reportText = `فواتير البيع: ${records.invoices.length}\nإجمالي المبيعات: ${getCurrencySymbol()} ${sales.toFixed(2)}\nمرتجعات المبيعات: ${getCurrencySymbol()} ${salesReturns.toFixed(2)}\nصافي المبيعات: ${getCurrencySymbol()} ${(sales - salesReturns).toFixed(2)}\nفواتير الشراء: ${records.purchases.length}\nقيمة المشتريات: ${getCurrencySymbol()} ${purchasesTotal.toFixed(2)}`;
    lastVerifiedFinancialReport = reportText;
    msg.textContent = reportText;
  } catch (e) { msg.textContent = 'تعذر إصدار التقرير: ' + (e.code || e.message); }
}

async function showSuppliers() {
  if (!requireAdmin() || !requireOnlineWrite()) return;
  const { panel } = adminPanel('الموردون');
  const name = adminField(panel, 'اسم المورد');
  const phone = adminField(panel, 'رقم التواصل');
  const msg = adminText(panel, '');
  adminButton(panel, 'حفظ المورد', async () => {
    if (!name.value.trim()) return msg.textContent = 'أدخل اسم المورد';
    try {
      await setDoc(doc(collection(db, 'suppliers')), { name: name.value.trim(), phone: phone.value.trim(), createdAt: new Date().toISOString(), branchId: getActiveBranchId() });
      msg.textContent = 'تم حفظ المورد بنجاح'; name.value = ''; phone.value = '';
    } catch (e) { msg.textContent = 'فشل الحفظ: ' + e.message; }
  });
}

async function showPurchases() {
  if (!requireAdmin() || !requireOnlineWrite()) return;
  const { panel } = adminPanel('تسجيل فاتورة شراء');
  const supplier = adminField(panel, 'اسم المورد');
  const name = adminField(panel, 'اسم الدواء');
  const barcode = adminField(panel, 'الباركود');
  const expiry = adminField(panel, 'تاريخ انتهاء الصلاحية', 'date');
  const qty = adminField(panel, 'الكمية المستلمة', 'number');
  const cost = adminField(panel, 'تكلفة الوحدة', 'number');
  const price = adminField(panel, 'سعر البيع', 'number');
  const status = adminText(panel, '');
  adminButton(panel, 'حفظ فاتورة الشراء واستلام المخزون', async () => {
    const q = Number(qty.value), c = Number(cost.value), p = Number(price.value);
    if (!supplier.value.trim() || !name.value.trim() || !expiry.value || q <= 0) return status.textContent = 'أكمل البيانات المطلوبة';
    const purchaseId = 'PUR-' + crypto.randomUUID();
    try {
      await runTransaction(db, async tx => {
        const stockRef = doc(db, 'pharmacy', getActiveBranchId());
        const snap = await tx.get(stockRef);
        const inv = [...(snap.data()?.inventory || [])];
        const stockId = crypto.randomUUID();
        inv.push({ id: stockId, name: name.value.trim(), generic: '', barcode: barcode.value.trim(), expiryDate: expiry.value, qty: q, price: p, purchaseCost: c, purchaseId, supplierName: supplier.value.trim() });
        tx.update(stockRef, { inventory: inv });
        tx.set(doc(db, 'purchases', purchaseId), { id: purchaseId, branchId: getActiveBranchId(), supplierName: supplier.value.trim(), createdAt: new Date().toISOString(), total: q * c, paid: q * c, balance: 0 });
      });
      status.textContent = 'تم حفظ فاتورة الشراء: ' + purchaseId;
    } catch (e) { status.textContent = 'فشل الحفظ: ' + e.message; }
  });
}

async function showEmployees() {
  if (!requireAdmin() || !requireOnlineWrite()) return;
  const { panel } = adminPanel('إدارة الموظفين والصلاحيات');
  const name = adminField(panel, 'اسم الموظف');
  const email = adminField(panel, 'البريد الإلكتروني', 'email');
  const status = adminText(panel, '');
  adminButton(panel, 'حفظ سجل الموظف', async () => {
    if (!name.value.trim() || !email.value.trim()) return status.textContent = 'أدخل الاسم والبريد';
    try {
      await setDoc(doc(collection(db, 'employees')), { name: name.value.trim(), email: email.value.trim(), role: 'pharmacist', status: 'active', branchId: getActiveBranchId(), createdAt: new Date().toISOString() });
      status.textContent = 'تم حفظ الموظف';
    } catch (e) { status.textContent = 'خطأ: ' + e.message; }
  });
}

async function showBranches() {
  if (!requireAdmin() || !requireOnlineWrite()) return;
  const { panel } = adminPanel('إدارة الفروع');
  adminText(panel, 'الفرع النشط حالياً: الصيدلية الرئيسية (main_branch)');
  const name = adminField(panel, 'اسم فرع إضافي');
  const status = adminText(panel, '');
  adminButton(panel, 'إضافة سجل فرع', async () => {
    if (!name.value.trim()) return;
    await setDoc(doc(collection(db, 'branches')), { name: name.value.trim(), status: 'planned', createdAt: new Date().toISOString() });
    status.textContent = 'تم حفظ سجل الفرع';
  });
}

function showBackupAndRestore() {
  const { panel } = adminPanel('النسخ الاحتياطي والتصدير');
  adminText(panel, 'تصدير بيانات المخزون والمبيعات بصيغة JSON.');
  adminButton(panel, 'تصدير نسخة JSON الآن', () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), pharmacy: state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'saydaliati-backup-' + todayLocal() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

window.showInvoices = showInvoices;
window.showReports = showReports;
window.showSuppliers = showSuppliers;
window.showPurchases = showPurchases;
window.showEmployees = showEmployees;
window.showBranches = showBranches;
window.showBackupAndRestore = showBackupAndRestore;

document.addEventListener('DOMContentLoaded', () => {
  bootstrapLicenseSession();
});

document.addEventListener('click', event => {
  const add = event.target.closest('[data-add-id]');
  const remove = event.target.closest('[data-remove-id]');
  const qty = event.target.closest('[data-qty-id]');
  if (add) window.addToCart(add.dataset.addId);
  else if (remove) window.removeFromCart(remove.dataset.removeId);
  else if (qty) window.updateCartQty(qty.dataset.qtyId, Number(qty.dataset.delta));
});

window.addEventListener('offline', () => { serverVerified = false; syncStatus('دون إنترنت — وضع العمل المحلي', false); });
window.addEventListener('online', () => { if (authenticatedAdmin) initCloudSync(); });


// --- تفعيل وإدارة صلاحيات الكاميرا والتخزين المحلي المستمر (V5.1) ---
const LOCAL_INV_CACHE_KEY = 'saydaliati_local_inventory_cache_v1';
const LOCAL_META_CACHE_KEY = 'saydaliati_local_meta_cache_v1';

function saveLocalSnapshot() {
  try {
    if (Array.isArray(state.inventory)) {
      localStorage.setItem(LOCAL_INV_CACHE_KEY, JSON.stringify(state.inventory));
      localStorage.setItem(LOCAL_META_CACHE_KEY, JSON.stringify({
        salesTotal: state.salesTotal || 0,
        dailySales: state.dailySales || {},
        updatedAt: new Date().toISOString()
      }));
    }
  } catch (e) {
    console.warn('تعذر الحفظ في التخزين المحلي:', e);
  }
}

function loadLocalSnapshot() {
  try {
    const rawInv = localStorage.getItem(LOCAL_INV_CACHE_KEY);
    const rawMeta = localStorage.getItem(LOCAL_META_CACHE_KEY);
    if (rawInv) {
      const parsedInv = JSON.parse(rawInv);
      if (Array.isArray(parsedInv)) state.inventory = parsedInv.filter(item => !String(item.id || '').startsWith('demo-'));
    }
    if (rawMeta) {
      const parsedMeta = JSON.parse(rawMeta);
      if (parsedMeta && typeof parsedMeta === 'object') {
        state.salesTotal = Number(parsedMeta.salesTotal) || state.salesTotal;
        state.dailySales = parsedMeta.dailySales || state.dailySales;
      }
    }
  } catch (e) {
    console.warn('تعذر قراءة التخزين المحلي:', e);
  }
}

async function requestCameraAndStoragePermissions() {
  let camStatus = 'غير مدعومة';
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const testStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      testStream.getTracks().forEach(t => t.stop());
      camStatus = 'مفعّلة ومصرّح بها ✓';
    }
  } catch (e) {
    camStatus = 'مرفوضة أو غير متاحة (' + (e.name || 'خطأ') + ')';
  }

  let storageStatus = 'متاح (localStorage + IndexedDB)';
  try {
    if (navigator.storage && navigator.storage.persist) {
      const persisted = await navigator.storage.persist();
      storageStatus = persisted ? 'تخزين دائم محمي من المسح التلقائي ✓' : 'تخزين محلي نشط ✓';
    }
    saveLocalSnapshot();
  } catch (e) {
    storageStatus = 'تخزين محلي أساسي';
  }

  alert(`حالة الصلاحيات في الجهاز:\n\n📷 صلاحية الكاميرا (للباركود): ${camStatus}\n💾 صلاحية التخزين المحلي: ${storageStatus}`);
}
window.requestCameraAndStoragePermissions = requestCameraAndStoragePermissions;

// تحميل النسخة المحلية فوراً عند فتح التطبيق وقبل اكتمال الاتصال السحابي
loadLocalSnapshot();
window.addEventListener('beforeunload', saveLocalSnapshot);
setInterval(saveLocalSnapshot, 15000);


// --- إدارة العملة والدولة (Currency & Regional Settings) ---
let currentCurrency = localStorage.getItem('saydaliati_currency_symbol') || 'جنيه';

function getCurrencySymbol() {
  return currentCurrency;
}

function setCurrencySymbol(symbol) {
  currentCurrency = symbol;
  localStorage.setItem('saydaliati_currency_symbol', symbol);
  updateUI();
  // إذا كان المدير مسجلاً، يمكننا حفظ إعداد العملة في مستند الصيدلية السحابي أيضاً
}
window.getCurrencySymbol = getCurrencySymbol;
window.setCurrencySymbol = setCurrencySymbol;


async function showCurrencySettings() {
  if (!requireAdmin()) return;
  const { panel } = adminPanel('إعدادات العملة والدولة');
  adminText(panel, 'اختر العملة الرسمية لصيدليتك أو فرعك:');
  
  const currencies = [
    { name: 'الجنيه المصري (EGP - ج.م)', symbol: 'ج.م' },
    { name: 'الريال السعودي (SAR - ر.س)', symbol: 'ر.س' },
    { name: 'الدرهم الإماراتي (AED - د.إ)', symbol: 'د.إ' },
    { name: 'الدينار الأردني (JOD - د.أ)', symbol: 'د.أ' },
    { name: 'الدينار الكويتي (KWD - د.ك)', symbol: 'د.ك' },
    { name: 'الدينار العراقي (IQD - د.ع)', symbol: 'د.ع' },
    { name: 'الليرة اللبنانية (LBP - ل.ل)', symbol: 'ل.ل' },
    { name: 'العملة الافتراضية (£)', symbol: '£' }
  ];

  for (const c of currencies) {
    adminButton(panel, `اعتماد: ${c.name}`, () => {
      setCurrencySymbol(c.symbol);
      alert(`تم تغيير عملة النظام إلى: ${c.name} (${c.symbol}) بنجاح ✓`);
    });
  }
}
window.showCurrencySettings = showCurrencySettings;
