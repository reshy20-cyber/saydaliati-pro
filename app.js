import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";
import { getFirestore, doc, setDoc, onSnapshot, runTransaction, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBBsWY5RkBHoph7EQegUNCbwCjGNCeKF4g",
  authDomain: "saydaliati-pro.firebaseapp.com",
  projectId: "saydaliati-pro",
  storageBucket: "saydaliati-pro.firebasestorage.app",
  messagingSenderId: "376696818740",
  appId: "1:376696818740:web:752f369fab6980894c4e61",
  measurementId: "G-TBDGSVB0GN"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
enableIndexedDbPersistence(db).catch(() => {});

let state = {
  salesTotal: 0,
  inventory: []
};

let cart = [];
let checkoutInProgress = false;
function todayLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }

export function initCloudSync() {
  const docRef = doc(db, "pharmacy", "main_branch");
  onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      state = { salesTotal: 0, inventory: [], ...docSnap.data() };
      updateUI();
    } else {
      setDoc(docRef, { salesTotal: 0, inventory: [] }).catch(err => console.error("Firestore initialization failed", err));
    }
  }, (error) => { console.error("Firestore sync failed", error); alert("تعذر الاتصال بقاعدة البيانات. تحقق من الصلاحيات والإنترنت."); });
}

function updateUI() {
  const sales = state.salesTotal || 0;
  const dashSales = document.getElementById('dash-sales');
  if (dashSales) dashSales.innerText = `£${sales.toFixed(2)}`;
  
  const dashItems = document.getElementById('dash-items-count');
  if (dashItems) dashItems.innerText = String((state.inventory || []).length);

  const lowStock = (state.inventory || []).filter(i => i.qty < 50).length;
  const dashLow = document.getElementById('dash-low-stock');
  if (dashLow) dashLow.innerText = `${lowStock} صنفاً`;

  const nearExpiry = state.inventory.filter(i => {
    const diff = new Date(i.expiryDate + "T23:59:59") - new Date();
    return diff > 0 && diff < (90 * 24 * 60 * 60 * 1000);
  }).length;
  const dashNear = document.getElementById('dash-near-expiry');
  if (dashNear) dashNear.innerText = `${nearExpiry} صنفاً`;

  renderInventoryList(state.inventory);
  renderCart();
}

function renderInventoryList(items, filter = 'all') {
  const container = document.getElementById('inventory-cards-container');
  if (!container) return;

  let filtered = items;
  if (filter === 'near_expiry') {
    filtered = items.filter(i => new Date(i.expiryDate + "T23:59:59") - new Date() < (90 * 24 * 60 * 60 * 1000));
  } else if (filter === 'low_stock') {
    filtered = items.filter(i => i.qty < 50);
  }

  container.innerHTML = '';
  filtered.forEach(item => {
    const card = document.createElement('div');
    card.className = "bg-white p-3.5 rounded-2xl shadow-sm border border-slate-100 flex justify-between items-center";
    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-xs font-bold text-blue-500 shadow-inner">💊</div>
        <div class="space-y-0.5">
          <h4 class="font-extrabold text-slate-800 text-sm">${item.name}</h4>
          <p class="text-[11px] text-slate-400">${item.generic}</p>
          <div class="text-emerald-600 font-extrabold text-xs">£${item.price.toFixed(2)}</div>
          ${item.qty <= 24 ? `<div class="text-[10px] text-red-500 font-bold flex items-center gap-1">📅 تنتهي: ${item.expiryDate}</div>` : ''}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <div class="bg-emerald-50 text-emerald-700 font-extrabold px-3 py-1.5 rounded-xl text-xs text-center">
          <div class="text-[9px] text-slate-400 font-normal">المخزون</div>
          <div>${item.qty}</div>
        </div>
        <button onclick="window.addToCart('${item.id}')" class="bg-emerald-600 hover:bg-emerald-700 text-white w-9 h-9 rounded-xl font-bold flex items-center justify-center shadow transition text-sm">+</button>
      </div>
    `;
    container.appendChild(card);
  });
}

window.filterInventory = function(type, btn) {
  document.querySelectorAll('.inv-filter-btn').forEach(b => {
    b.className = "inv-filter-btn px-4 py-1.5 rounded-full text-xs font-bold bg-white text-slate-600 shadow-sm border border-slate-100";
  });
  btn.className = "inv-filter-btn px-4 py-1.5 rounded-full text-xs font-bold bg-emerald-600 text-white shadow";
  renderInventoryList(state.inventory, type);
};

window.switchScreen = function(screenId) {
  document.querySelectorAll('.screen-view').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById(screenId);
  if (target) target.classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(b => b.className = "nav-btn flex flex-col items-center gap-1 text-slate-400 hover:text-white transition");
  if (screenId === 'screen-home') document.getElementById('nav-home').className = "nav-btn flex flex-col items-center gap-1 text-amber-400 font-bold transition";
  if (screenId === 'screen-pos') document.getElementById('nav-pos').className = "nav-btn flex flex-col items-center gap-1 text-amber-400 font-bold transition";
  if (screenId === 'screen-inventory') document.getElementById('nav-inv').className = "nav-btn flex flex-col items-center gap-1 text-amber-400 font-bold transition";
};

window.addToCart = function(id) {
  const item = state.inventory.find(i => i.id === id);
  if (!item || item.qty <= 0) return alert('نفد المخزون!');
  if (item.expiryDate && item.expiryDate < todayLocal()) return alert('لا يمكن بيع دواء منتهي الصلاحية');
  const exist = cart.find(c => c.id === id);
  if (exist) {
    if (exist.quantity < item.qty) exist.quantity++;
  } else {
    cart.push({ ...item, quantity: 1 });
  }
  renderCart();
  window.switchScreen('screen-pos');
};

window.updateCartQty = function(id, delta) {
  const exist = cart.find(c => c.id === id);
  const item = state.inventory.find(i => i.id === id);
  if (!exist) return;
  const newQty = exist.quantity + delta;
  if (!item || newQty > item.qty) return alert('الكمية تتجاوز المخزون المتوفر!');
  if (newQty <= 0) {
    cart = cart.filter(c => c.id !== id);
  } else {
    exist.quantity = newQty;
  }
  renderCart();
};

window.removeFromCart = function(id) {
  cart = cart.filter(c => c.id !== id);
  renderCart();
};

function renderCart() {
  const container = document.getElementById('cart-items-container');
  const subTotalEl = document.getElementById('cart-subtotal');
  const finalTotalEl = document.getElementById('cart-final-total');
  if (!container) return;

  const subtotal = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
  if (subTotalEl) subTotalEl.innerText = `£${subtotal.toFixed(2)}`;
  if (finalTotalEl) finalTotalEl.innerText = `£${subtotal.toFixed(2)}`;

  if (cart.length === 0) {
    container.innerHTML = `<p class="text-slate-400 text-sm text-center py-12">السلة فارغة حالياً... اختر أدوية من قسم المخزون أو المبيعات</p>`;
    return;
  }

  container.innerHTML = '';
  cart.forEach(i => {
    const div = document.createElement('div');
    div.className = "flex justify-between items-center bg-white p-3.5 rounded-2xl shadow-sm border border-slate-100";
    div.innerHTML = `
      <div class="flex items-center gap-3">
        <button onclick="window.removeFromCart('${i.id}')" class="text-red-400 hover:text-red-600 text-base">🗑️</button>
        <div>
          <h4 class="font-extrabold text-slate-800 text-sm">${i.name}</h4>
          <span class="text-emerald-600 font-extrabold text-xs">£${i.price.toFixed(2)}</span>
        </div>
      </div>
      <div class="flex items-center gap-2.5 bg-slate-50 px-2.5 py-1.5 rounded-xl border border-slate-100">
        <button onclick="window.updateCartQty('${i.id}', -1)" class="w-6 h-6 rounded-lg bg-white shadow-sm font-bold text-slate-700 flex items-center justify-center text-xs">-</button>
        <span class="font-extrabold text-sm w-5 text-center text-slate-800">${i.quantity}</span>
        <button onclick="window.updateCartQty('${i.id}', 1)" class="w-6 h-6 rounded-lg bg-emerald-600 text-white font-bold flex items-center justify-center text-xs shadow-sm">+</button>
      </div>
    `;
    container.appendChild(div);
  });
}

window.checkout = async function() {
  if (checkoutInProgress) return;
  if (cart.length === 0) return alert('السلة فارغة!');
  checkoutInProgress = true;
  const saleItems = cart.map(c => ({ id: c.id, quantity: c.quantity }));
  const invoiceId = 'INV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const docRef = doc(db, 'pharmacy', 'main_branch');
  const invoiceRef = doc(db, 'invoices', invoiceId);
  try {
    await runTransaction(db, async (t) => {
      const snap = await t.get(docRef);
      if (!snap.exists()) throw new Error('لا توجد بيانات مخزون محفوظة');
      const data = snap.data();
      const inv = (data.inventory || []).map(i => ({ ...i }));
      let total = 0;
      const invoiceItems = [];
      for (const c of saleItems) {
        if (!Number.isSafeInteger(c.quantity) || c.quantity <= 0) throw new Error('كمية غير صالحة');
        const item = inv.find(i => i.id === c.id);
        if (!item) throw new Error('الصنف غير موجود في المخزون');
        if (item.expiryDate && item.expiryDate < todayLocal()) throw new Error('لا يمكن بيع دواء منتهي الصلاحية');
        if (!Number.isSafeInteger(item.qty) || item.qty < c.quantity) throw new Error('الكمية المتاحة غير كافية: ' + item.name);
        if (!Number.isFinite(item.price) || item.price < 0) throw new Error('سعر غير صالح');
        item.qty -= c.quantity;
        total += item.price * c.quantity;
        invoiceItems.push({ id: item.id, name: item.name, quantity: c.quantity, unitPrice: item.price });
      }
      total = Math.round(total * 100) / 100;
      t.update(docRef, { inventory: inv, salesTotal: Math.round(((data.salesTotal || 0) + total) * 100) / 100 });
      t.set(invoiceRef, { id: invoiceId, items: invoiceItems, total, createdAt: new Date().toISOString(), branchId: 'main_branch' });
    });
    cart = [];
    renderCart();
    window.switchScreen('screen-home');
    alert('تمت عملية البيع وحفظ الفاتورة: ' + invoiceId);
  } catch (e) {
    alert('لم تُحفظ عملية البيع: ' + (e.message || 'خطأ في الاتصال'));
  } finally { checkoutInProgress = false; }
};

window.addNewProduct = async function(e) {
  e.preventDefault();
  const name = document.getElementById('new-name').value.trim();
  const generic = document.getElementById('new-generic').value;
  const barcode = document.getElementById('new-barcode').value;
  const expiryDate = document.getElementById('new-expiry').value;
  const price = parseFloat(document.getElementById('new-price').value);
  const qty = parseInt(document.getElementById('new-qty').value);

  if (!name || !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(qty) || qty < 0 || !expiryDate) return alert('يرجى إدخال بيانات صحيحة');
  const docRef = doc(db, "pharmacy", "main_branch");
  try { await runTransaction(db, async (t) => {
    const snap = await t.get(docRef);
    if (!snap.exists()) throw new Error('لم يتم تهيئة المخزون');
    let inv = snap.data().inventory || [];
    inv.push({ id: 'item_' + Date.now(), name, generic, barcode, expiryDate, price, qty });
    t.update(docRef, { inventory: inv });
  }); } catch (e) { alert('تعذر حفظ الدواء: ' + (e.message || 'خطأ')); return; }
  alert('تمت إضافة الدواء بنجاح للمخزون والسحابة! 📥');
  document.getElementById('add-product-form').reset();
  window.switchScreen('screen-inventory');
};

document.addEventListener('DOMContentLoaded', () => initCloudSync());
