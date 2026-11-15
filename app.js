import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, collection, getDocs, setDoc, query, orderBy, limit, onSnapshot, runTransaction, enableIndexedDbPersistence } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBBsWY5RkBHoph7EQegUNCbwCjGNCeKF4g',
  authDomain: 'saydaliati-pro.firebaseapp.com', projectId: 'saydaliati-pro',
  storageBucket: 'saydaliati-pro.firebasestorage.app', messagingSenderId: '376696818740',
  appId: '1:376696818740:web:752f369fab6980894c4e61', measurementId: 'G-TBDGSVB0GN'
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const ADMIN_UID = 'RFJLGhcDeFStQ53ZcCpyBIZYDdJ3';
enableIndexedDbPersistence(db).catch(() => {});
let state = { salesTotal: 0, inventory: [] }, cart = [], checkoutInProgress = false;
let activeInventoryFilter = 'all', unsubscribeCloud = null, authenticatedAdmin = false, serverVerified = false;
// Offline draft: product IDs and quantities only. Not a sale, invoice, or payment.
const DRAFT_KEY='saydaliati_pos_draft_v1';
let draftRestored=false;
function saveCartDraft(){
  try { if(!authenticatedAdmin)return; const lines=cart.filter(c=>Number.isSafeInteger(c.quantity)&&c.quantity>0).map(c=>({id:String(c.id),quantity:c.quantity}));
    if(lines.length)localStorage.setItem(DRAFT_KEY,JSON.stringify({version:1,lines}));
    else localStorage.removeItem(DRAFT_KEY);
  } catch(e){ console.warn('تعذر حفظ مسودة السلة',e); }
}
function restoreCartDraft(){
  if(draftRestored || !authenticatedAdmin || !Array.isArray(state.inventory) || !state.inventory.length)return;
  draftRestored=true;
  try { const raw=localStorage.getItem(DRAFT_KEY);if(!raw)return;
    const draft=JSON.parse(raw);if(draft.version!==1||!Array.isArray(draft.lines)||draft.lines.length>200)throw Error('مسودة غير صالحة');
    const restored=[];const seen=new Set();
    for(const line of draft.lines){if(!line||typeof line.id!=='string'||seen.has(line.id)||!Number.isSafeInteger(line.quantity)||line.quantity<=0)continue;
      seen.add(line.id);const item=state.inventory.find(i=>i.id===line.id);
      if(item&&validStock(item)&&Number(item.qty)>=line.quantity)restored.push({...item,quantity:line.quantity});
    }
    cart=restored;saveCartDraft();
  }catch(e){console.warn('تعذر استعادة المسودة',e);localStorage.removeItem(DRAFT_KEY);}
}

const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const validStock = i => i && typeof i === 'object' && Number.isSafeInteger(Number(i.qty)) && Number(i.qty) > 0 && typeof i.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.expiryDate) && i.expiryDate >= todayLocal() && Number.isFinite(Number(i.price)) && Number(i.price) >= 0;
const fefoBatches = (inv,item) => inv.filter(i => (item.barcode && i.barcode === item.barcode) || i.id === item.id).filter(validStock).sort((a,b)=>(a.expiryDate||'9999-12-31').localeCompare(b.expiryDate||'9999-12-31'));
function requireAdmin() { if (!authenticatedAdmin || !auth.currentUser || auth.currentUser.uid !== ADMIN_UID) { alert('سجّل دخول المدير من الإعدادات أولاً'); return false; } return true; }
function requireOnlineWrite() { if (!navigator.onLine || !serverVerified) { alert('لا يمكن إجراء معاملات حتى يتم تأكيد الاتصال المباشر بقاعدة البيانات. يمكن عرض البيانات المحفوظة فقط.'); return false; } return true; }
function syncStatus(message) { let e=document.getElementById('saydaliati-sync-status'); if(!e){e=document.createElement('div');e.id='saydaliati-sync-status';e.style.cssText='position:fixed;bottom:80px;left:10px;right:10px;z-index:80;text-align:center;pointer-events:none;font-size:11px;font-weight:bold;color:#07543b';(document.body || document.documentElement).append(e);} e.textContent=message; }
export function initCloudSync() {
  if (!authenticatedAdmin || !auth.currentUser || auth.currentUser.uid !== ADMIN_UID) return;
  if (unsubscribeCloud) unsubscribeCloud();
  serverVerified = false;
  unsubscribeCloud = onSnapshot(doc(db,'pharmacy','main_branch'), { includeMetadataChanges: true }, snapshot => {
    if (!snapshot.exists()) { serverVerified = false; syncStatus('مستند الصيدلية غير موجود'); return; }
    serverVerified = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
    const remote = snapshot.data();
    if (!remote || !Array.isArray(remote.inventory)) { serverVerified = false; syncStatus('بيانات المخزون غير صالحة — العمليات متوقفة'); return; }
    state = { salesTotal:0, inventory:[], ...remote };
    restoreCartDraft();
    cart = cart.filter(c => state.inventory.some(i => i.id === c.id && validStock(i) && Number(i.qty) >= c.quantity));
    saveCartDraft();
    updateUI(); syncStatus(snapshot.metadata.fromCache ? 'بيانات محفوظة محلياً — بانتظار الاتصال' : 'تم الاتصال بـ Firebase');
  }, error => { serverVerified = false; console.error('Firestore sync:',error); syncStatus('تعذرت المزامنة: '+(error.code||'خطأ')); alert('تعذرت مزامنة Firestore: '+(error.code||error.message)); });
}
function showAdminLogin() {
  document.getElementById('saydaliati-auth-dialog')?.remove();
  const overlay=document.createElement('div'); overlay.id='saydaliati-auth-dialog';
  overlay.style.cssText='position:fixed;inset:0;z-index:10000;background:#001b15b8;display:grid;place-items:center;padding:18px;direction:rtl';
  const panel=document.createElement('div');panel.style.cssText='background:white;width:min(100%,420px);padding:24px;border-radius:20px;display:grid;gap:12px;font-family:inherit';
  const heading=document.createElement('h2');heading.textContent='إعدادات اتصال المدير';heading.style.cssText='font-size:20px;font-weight:900;color:#00553b';panel.append(heading);
  if (auth.currentUser && authenticatedAdmin) {
    const info=document.createElement('p');info.textContent='متصل بحساب المدير: '+(auth.currentUser.email||'');panel.append(info);
    const logout=document.createElement('button');logout.textContent='تسجيل الخروج';logout.style.cssText='background:#991b1b;color:white;padding:12px;border-radius:12px';logout.onclick=async()=>{await signOut(auth);overlay.remove();};panel.append(logout);
  } else {
    const email=document.createElement('input');email.type='email';email.placeholder='بريد المدير';email.autocomplete='username';
    const password=document.createElement('input');password.type='password';password.placeholder='كلمة المرور';password.autocomplete='current-password';
    for(const input of [email,password])input.style.cssText='padding:12px;border:1px solid #cbd5e1;border-radius:12px;color:#111;width:100%';
    const status=document.createElement('p');status.style.cssText='color:#b91c1c;font-size:12px';
    const login=document.createElement('button');login.textContent='تسجيل الدخول';login.style.cssText='padding:12px;background:#006b3d;color:white;border-radius:12px;font-weight:bold';
    login.onclick=async()=>{login.disabled=true;status.textContent='';try{const result=await signInWithEmailAndPassword(auth,email.value.trim(),password.value);if(result.user.uid!==ADMIN_UID){await signOut(auth);throw Error('هذا الحساب غير مخوّل');}overlay.remove();}catch(e){status.textContent='تعذر الدخول: '+(e.code||e.message);}finally{login.disabled=false;}};
    panel.append(email,password,login,status);
  }
  const close=document.createElement('button');close.textContent='إغلاق';close.style.cssText='padding:10px;border:1px solid #ddd;border-radius:12px';close.onclick=()=>overlay.remove();panel.append(close);overlay.append(panel);document.body.append(overlay);
}
window.showAdminLogin=showAdminLogin;
onAuthStateChanged(auth, user=>{
  authenticatedAdmin=!!user && user.uid===ADMIN_UID;
  serverVerified = false;
  if(unsubscribeCloud){unsubscribeCloud();unsubscribeCloud=null;}
  if(authenticatedAdmin){syncStatus('جارٍ الاتصال بـ Firebase…');initCloudSync();}
  else {lastVerifiedFinancialReport=null;state={salesTotal:0,inventory:[]};cart=[];draftRestored=false;updateUI();syncStatus('المزامنة متوقفة — سجّل الدخول من الإعدادات');if(user && user.uid!==ADMIN_UID)signOut(auth).catch(console.error);}
});
function updateUI(){
  const sales=Number(state.dailySales?.[todayLocal()])||0;
  const set=(id,value)=>{const el=document.getElementById(id);if(el)el.innerText=value;};
  set('dash-sales',`£${sales.toFixed(2)}`);
  set('dash-items-count',String(state.inventory.length));
  set('dash-low-stock',`${state.inventory.filter(i=>Number.isFinite(Number(i.qty))&&Number(i.qty)<50).length} صنفاً`);
  set('dash-near-expiry',`${state.inventory.filter(i=>i.expiryDate&&new Date(i.expiryDate+'T23:59:59')-new Date()>0&&new Date(i.expiryDate+'T23:59:59')-new Date()<90*86400000).length} صنفاً`);
  renderInventoryList(state.inventory,activeInventoryFilter);renderCart();
}
function renderInventoryList(items,filter='all'){
  const container=document.getElementById('inventory-cards-container');if(!container)return;
  const filtered=items.filter(i=>filter==='near_expiry'?(i.expiryDate&&new Date(i.expiryDate+'T23:59:59')-new Date()>=0&&new Date(i.expiryDate+'T23:59:59')-new Date()<90*86400000):filter==='low_stock'?Number(i.qty)<50:true);
  container.innerHTML='';for(const item of filtered){const card=document.createElement('div');card.className='bg-white p-3.5 rounded-2xl shadow-sm border border-slate-100 flex justify-between items-center';
    card.innerHTML=`<div class="flex items-center gap-3"><div class="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-xs font-bold text-blue-500 shadow-inner">💊</div><div class="space-y-0.5"><h4 class="font-extrabold text-slate-800 text-sm">${escapeHtml(item.name)}</h4><p class="text-[11px] text-slate-400">${escapeHtml(item.generic)}</p><div class="text-emerald-600 font-extrabold text-xs">£${Number(item.price||0).toFixed(2)}</div>${item.expiryDate?`<div class="text-[10px] text-red-500 font-bold">📅 تنتهي: ${escapeHtml(item.expiryDate)}</div>`:''}</div></div><div class="flex items-center gap-2"><div class="bg-emerald-50 text-emerald-700 font-extrabold px-3 py-1.5 rounded-xl text-xs text-center"><div class="text-[9px] text-slate-400 font-normal">المخزون</div><div>${Number(item.qty)||0}</div></div><button data-add-id="${escapeHtml(item.id)}" class="bg-emerald-600 hover:bg-emerald-700 text-white w-9 h-9 rounded-xl font-bold flex items-center justify-center shadow transition text-sm">+</button></div>`;container.append(card);}
}
window.filterInventory=(type,btn)=>{document.querySelectorAll('.inv-filter-btn').forEach(b=>b.className='inv-filter-btn px-4 py-1.5 rounded-full text-xs font-bold bg-white text-slate-600 shadow-sm border border-slate-100');btn.className='inv-filter-btn px-4 py-1.5 rounded-full text-xs font-bold bg-emerald-600 text-white shadow';activeInventoryFilter=type;renderInventoryList(state.inventory,type);};
window.switchScreen=screenId=>{document.querySelectorAll('.screen-view').forEach(e=>e.classList.add('hidden'));document.getElementById(screenId)?.classList.remove('hidden');document.querySelectorAll('.nav-btn').forEach(b=>b.className='nav-btn flex flex-col items-center gap-1 text-slate-400 hover:text-white transition');const id=({'screen-home':'nav-home','screen-pos':'nav-pos','screen-inventory':'nav-inv'})[screenId];if(id){const el=document.getElementById(id);if(el)el.className='nav-btn flex flex-col items-center gap-1 text-amber-400 font-bold transition';}};
window.addToCart=id=>{if(checkoutInProgress)return;if(!requireAdmin())return;const item=state.inventory.find(i=>i.id===id);if(!item)return alert('الصنف غير موجود');const chosen=fefoBatches(state.inventory,item).find(i=>(cart.find(c=>c.id===i.id)?.quantity||0)<Number(i.qty));if(!chosen)return alert('لا توجد دفعة صالحة ومتاحة للبيع');const existing=cart.find(c=>c.id===chosen.id);if(existing)existing.quantity++;else cart.push({...chosen,quantity:1});renderCart();saveCartDraft();window.switchScreen('screen-pos');};
window.updateCartQty=(id,delta)=>{if(checkoutInProgress)return;const c=cart.find(i=>i.id===id),i=state.inventory.find(i=>i.id===id);if(!c)return;const qty=c.quantity+delta;if(qty>0&&(!i||!validStock(i)||qty>Number(i.qty)))return alert('الكمية تتجاوز المخزون الصالح والمتوفر');if(qty<=0)cart=cart.filter(i=>i.id!==id);else c.quantity=qty;renderCart();saveCartDraft();};
window.removeFromCart=id=>{if(checkoutInProgress)return;cart=cart.filter(i=>i.id!==id);renderCart();saveCartDraft();};
function renderCart(){const container=document.getElementById('cart-items-container');if(!container)return;const subtotal=cart.reduce((s,i)=>s+Number(i.price)*i.quantity,0);for(const id of ['cart-subtotal','cart-final-total']){const el=document.getElementById(id);if(el)el.innerText=`£${subtotal.toFixed(2)}`;}if(!cart.length){container.innerHTML='<p class="text-slate-400 text-sm text-center py-12">السلة فارغة حالياً... اختر أدوية من قسم المخزون أو المبيعات</p>';return;}container.innerHTML='';for(const i of cart){const div=document.createElement('div');div.className='flex justify-between items-center bg-white p-3.5 rounded-2xl shadow-sm border border-slate-100';div.innerHTML=`<div class="flex items-center gap-3"><button data-remove-id="${escapeHtml(i.id)}" class="text-red-400 hover:text-red-600 text-base">🗑️</button><div><h4 class="font-extrabold text-slate-800 text-sm">${escapeHtml(i.name)}</h4><span class="text-emerald-600 font-extrabold text-xs">£${Number(i.price).toFixed(2)}</span></div></div><div class="flex items-center gap-2.5 bg-slate-50 px-2.5 py-1.5 rounded-xl border border-slate-100"><button data-qty-id="${escapeHtml(i.id)}" data-delta="-1" class="w-6 h-6 rounded-lg bg-white shadow-sm font-bold">-</button><span class="font-extrabold text-sm w-5 text-center">${i.quantity}</span><button data-qty-id="${escapeHtml(i.id)}" data-delta="1" class="w-6 h-6 rounded-lg bg-emerald-600 text-white font-bold">+</button></div>`;container.append(div);}}
window.checkout=async()=>{if(!requireAdmin()||!requireOnlineWrite())return;if(checkoutInProgress)return;if(!cart.length)return alert('السلة فارغة!');checkoutInProgress=true;const saleItems=cart.map(c=>({id:c.id,quantity:c.quantity}));const invoiceId='INV-'+crypto.randomUUID();const saleDay=todayLocal();const docRef=doc(db,'pharmacy','main_branch');const invoiceRef=doc(db,'invoices',invoiceId);try{await runTransaction(db,async t=>{const prior=await t.get(invoiceRef);if(prior.exists())throw Error('الفاتورة مسجلة مسبقاً');const snap=await t.get(docRef);if(!snap.exists())throw Error('لا توجد بيانات مخزون محفوظة');const data=snap.data();if(!Array.isArray(data.inventory))throw Error('هيكل بيانات المخزون غير صالح');const inv=data.inventory.map(i=>({...i}));let total=0;const invoiceItems=[];for(const c of saleItems){if(!Number.isSafeInteger(c.quantity)||c.quantity<=0)throw Error('كمية غير صالحة');const item=inv.find(i=>i.id===c.id);if(!item)throw Error('الصنف غير موجود');if(!validStock(item))throw Error('الدفعة غير صالحة أو منتهية الصلاحية');if(!Number.isSafeInteger(Number(item.qty))||Number(item.qty)<c.quantity)throw Error('الكمية غير كافية: '+item.name);if(item.price===null||item.price===undefined||String(item.price).trim()===''||!Number.isFinite(Number(item.price))||Number(item.price)<0)throw Error('سعر غير صالح');item.qty=Number(item.qty)-c.quantity;total+=Number(item.price)*c.quantity;invoiceItems.push({id:item.id,name:item.name,barcode:item.barcode||'',expiryDate:item.expiryDate||'',quantity:c.quantity,unitPrice:Number(item.price)});}total=Math.round(total*100)/100;const day=saleDay;const dailySales={...(data.dailySales||{})};dailySales[day]=Math.round(((Number(dailySales[day])||0)+total)*100)/100;t.update(docRef,{inventory:inv,salesTotal:Math.round(((Number(data.salesTotal)||0)+total)*100)/100,dailySales});t.set(invoiceRef,{id:invoiceId,items:invoiceItems,total,createdAt:new Date().toISOString(),branchId:'main_branch'});});cart=[];saveCartDraft();renderCart();window.switchScreen('screen-home');alert('تم البيع وحفظ الفاتورة: '+invoiceId);}catch(e){alert('لم تُحفظ عملية البيع: '+(e.message||'خطأ في الاتصال'));}finally{checkoutInProgress=false;}};
window.addNewProduct=async e=>{e.preventDefault();if(!requireAdmin()||!requireOnlineWrite())return;const name=document.getElementById('new-name').value.trim(),generic=document.getElementById('new-generic').value.trim(),barcode=document.getElementById('new-barcode').value.trim(),expiryDate=document.getElementById('new-expiry').value,price=Number(document.getElementById('new-price').value),qtyRaw=document.getElementById('new-qty').value.trim(),qty=Number(qtyRaw);if(expiryDate&&expiryDate<todayLocal())return alert('لا يمكن إضافة دفعة منتهية الصلاحية');if(!name||!document.getElementById('new-price').value.trim()||!Number.isFinite(price)||price<0||!qtyRaw||!Number.isSafeInteger(qty)||qty<0||!expiryDate)return alert('يرجى إدخال بيانات صحيحة');try{await runTransaction(db,async t=>{const ref=doc(db,'pharmacy','main_branch'),snap=await t.get(ref);if(!snap.exists())throw Error('لم يتم تهيئة المخزون');if(!Array.isArray(snap.data().inventory))throw Error('هيكل بيانات المخزون غير صالح');const inv=[...snap.data().inventory];inv.push({id:crypto.randomUUID(),name,generic,barcode,expiryDate,price,qty});t.update(ref,{inventory:inv});});alert('تمت إضافة الدواء بنجاح');document.getElementById('add-product-form').reset();window.switchScreen('screen-inventory');}catch(e){alert('تعذر حفظ الدواء: '+(e.message||'خطأ'));}};
async function scanBarcode(){if(!('BarcodeDetector'in window)||!navigator.mediaDevices?.getUserMedia)return alert('المسح بالكاميرا غير مدعوم. أدخل الباركود يدوياً.');let stream,raf;const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:#000e;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;color:white';const video=document.createElement('video');video.autoplay=true;video.playsInline=true;video.style.cssText='width:100%;max-width:420px;border-radius:18px';const close=document.createElement('button');close.textContent='إغلاق الكاميرا';close.style.cssText='background:#047857;padding:12px 25px;border-radius:12px';const stop=()=>{cancelAnimationFrame(raf);stream?.getTracks().forEach(t=>t.stop());overlay.remove();};close.onclick=stop;overlay.append(video,close);document.body.append(overlay);try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});video.srcObject=stream;await video.play();const detector=new BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code']});let busy=false;const frame=async()=>{if(!overlay.isConnected)return;if(!busy&&video.readyState>=2){busy=true;try{const found=await detector.detect(video);if(found.length){document.getElementById('new-barcode').value=found[0].rawValue;stop();return;}}catch(e){console.warn(e);}finally{busy=false;}}raf=requestAnimationFrame(frame);};raf=requestAnimationFrame(frame);}catch(e){stop();alert('تعذر تشغيل الكاميرا');}}window.scanBarcode=scanBarcode;

// Administrative tools use a separate overlay; the approved HTML and styling remain untouched.
function adminPanel(title) {
  document.getElementById('saydaliati-admin-panel')?.remove();
  const overlay=document.createElement('div');overlay.id='saydaliati-admin-panel';overlay.style.cssText='position:fixed;inset:0;z-index:10001;background:#001b15c9;display:grid;place-items:center;padding:15px;direction:rtl';
  const panel=document.createElement('section');panel.style.cssText='background:#fff;border-radius:18px;padding:18px;width:min(100%,480px);max-height:88vh;overflow:auto;color:#123;display:grid;gap:12px';
  const header=document.createElement('h2');header.textContent=title;header.style.cssText='font-size:19px;font-weight:800;color:#065f46';panel.append(header);
  const close=document.createElement('button');close.textContent='إغلاق';close.style.cssText='padding:9px;border:1px solid #ccc;border-radius:10px';close.onclick=()=>overlay.remove();panel.append(close);overlay.append(panel);document.body.append(overlay);
  return {panel,close,overlay};
}
function adminText(panel,value) {const p=document.createElement('p');p.textContent=value;p.style.cssText='font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere';panel.insertBefore(p,panel.lastChild);return p;}
function adminField(panel,label,type='text') {const wrap=document.createElement('label');wrap.textContent=label;wrap.style.cssText='display:grid;gap:5px;font-size:13px';const input=document.createElement('input');input.type=type;input.style.cssText='border:1px solid #ccc;border-radius:9px;padding:10px;width:100%';wrap.append(input);panel.insertBefore(wrap,panel.lastChild);return input;}
function adminButton(panel,label,handler) {const b=document.createElement('button');b.textContent=label;b.style.cssText='background:#047857;color:white;padding:11px;border-radius:10px;font-weight:700';b.onclick=handler;panel.insertBefore(b,panel.lastChild);return b;}
async function showInvoices(){if(!requireAdmin()||!requireOnlineWrite())return;const {panel}=adminPanel('الفواتير الأخيرة');adminButton(panel,'مرتجعات المبيعات',showSalesReturns);const msg=adminText(panel,'جارٍ تحميل الفواتير…');try{const snaps=await getDocs(query(collection(db,'invoices'),orderBy('createdAt','desc'),limit(50)));msg.textContent=snaps.empty?'لا توجد فواتير مسجلة':`آخر ${snaps.size} فاتورة (حد العرض 50)`;snaps.forEach(s=>{const d=s.data();adminText(panel,`${d.id||s.id}\n${d.createdAt||''}\nالإجمالي: £${Number(d.total||0).toFixed(2)}\n${Array.isArray(d.items)?d.items.map(i=>`${i.name}: ${i.quantity} × £${i.unitPrice}`).join('، '):''}`);});}catch(e){msg.textContent='تعذر قراءة الفواتير: '+(e.code||e.message);}}

// A return is an explicit, auditable transaction. It does not silently overwrite the sale.
async function showSalesReturns(){
 if(!requireAdmin()||!requireOnlineWrite())return;
 const {panel}=adminPanel('مرتجعات المبيعات');
 const invoice=adminField(panel,'رقم فاتورة البيع');
 const stock=adminField(panel,'معرف الدفعة من الفاتورة');
 const quantity=adminField(panel,'الكمية المرتجعة','number');quantity.min='1';quantity.step='1';
 const reason=adminField(panel,'سبب المرتجع');
 const status=adminText(panel,'تنبيه: الدواء المرتجع يُسجل في سجل منفصل ولا يعود تلقائياً للمخزون القابل للبيع حفاظاً على سلامة الأدوية.');
 let busy=false;
 adminButton(panel,'تسجيل المرتجع',async()=>{
  if(busy||!requireAdmin()||!requireOnlineWrite())return;
  const id=invoice.value.trim(),sid=stock.value.trim(),q=Number(quantity.value);
  if(!id||!sid||!reason.value.trim()||!Number.isSafeInteger(q)||q<=0)return status.textContent='أدخل رقم الفاتورة ومعرف الدفعة والكمية والسبب';
  const invoiceRef=doc(db,'invoices',id),returnRef=doc(collection(db,'sales_returns'));
  busy=true;
  try{await runTransaction(db,async tx=>{
   const snap=await tx.get(invoiceRef);
   if(!snap.exists())throw Error('الفاتورة غير موجودة');
   const sale=snap.data();
   if(sale.branchId!=='main_branch'||!Array.isArray(sale.items))throw Error('الفاتورة لا تتبع هذا الفرع أو بياناتها غير صالحة');
   const line=sale.items.find(i=>i.id===sid);
   if(!line)throw Error('هذه الدفعة غير موجودة في الفاتورة');
   const original=Number(line.quantity),prior=Number((sale.returnedQty||{})[sid]||0),price=Number(line.unitPrice);
   if(!Number.isSafeInteger(original)||!Number.isSafeInteger(prior)||prior<0||prior+q>original||!Number.isFinite(price)||price<0)throw Error('الكمية تتجاوز المبيع أو السعر غير صالح');
   const value=Math.round(q*price*100)/100;
   const returnedQty={...(sale.returnedQty||{}),[sid]:prior+q};
   tx.update(invoiceRef,{returnedQty,returnedValue:Math.round((Number(sale.returnedValue||0)+value)*100)/100});
   tx.set(returnRef,{invoiceId:id,stockId:sid,productName:String(line.name||''),quantity:q,refundAmount:value,reason:reason.value.trim(),createdAt:new Date().toISOString(),branchId:'main_branch',restockStatus:'quarantined',refundStatus:'pending'});
  });status.textContent='تم تسجيل المرتجع. الدواء في الحجر، ورد المبلغ بانتظار التسوية المالية.';
  }catch(e){status.textContent='فشل تسجيل المرتجع: '+(e.code||e.message);}finally{busy=false;}
 });
}

// Financial figures are derived from source documents, never from an inferred stock valuation.
// Offline report viewing uses only this session's previously verified report; no private records
// are written to localStorage. Offline financial writes remain intentionally disabled.
let lastVerifiedFinancialReport = null;
const money2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const validMoney = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function sumFinancialRows(rows, field) {
 let total=0;
 for (const row of rows) {const n=row[field];if(!validMoney(n))throw Error('قيمة مالية غير صالحة في '+field);total=money2(total+n);}
 return total;
}
function summarizeFinances(records) {
 const {invoices,purchases,sales_returns,purchase_returns,supplier_payments}=records;
 const sales=sumFinancialRows(invoices,'total');
 const purchasesTotal=sumFinancialRows(purchases,'total');
 const purchaseReturns=sumFinancialRows(purchase_returns,'value');
 const supplierPayments=sumFinancialRows(supplier_payments,'amount');
 let salesReturns=0, returnsUnpriced=0;
 for(const r of sales_returns){if(validMoney(r.refundAmount))salesReturns=money2(salesReturns+r.refundAmount);else returnsUnpriced++;}
 let documentedCost=0, costMissing=0;
 for(const invoice of invoices){
  if(!Array.isArray(invoice.items)){costMissing++;continue;}
  for(const item of invoice.items){
   if(!Number.isSafeInteger(item.quantity)||item.quantity<=0){costMissing++;continue;}
   if(validMoney(item.unitCost))documentedCost=money2(documentedCost+item.quantity*item.unitCost);
   else costMissing++;
  }
 }
 const netSales=money2(sales-salesReturns);
 const grossProfit=costMissing===0 && returnsUnpriced===0 && sales_returns.length===0 ? money2(netSales-documentedCost) : null;
 return {sales,purchasesTotal,purchaseReturns,supplierPayments,salesReturns,netSales,documentedCost,costMissing,returnsUnpriced,grossProfit,invoiceCount:invoices.length,purchaseCount:purchases.length};
}
async function showReports(){
 if(!requireAdmin())return;
 const {panel}=adminPanel('التقارير المالية');
 const msg=adminText(panel,'جارٍ فحص السجلات المالية…');
 const show=(r,offline=false)=>{
  msg.textContent=(offline?'بيانات آخر تقرير متصل محفوظ في ذاكرة هذه الجلسة فقط؛ قد تكون قديمة.\n':'')+
   `فواتير البيع: ${r.invoiceCount}\nإجمالي المبيعات: £${r.sales.toFixed(2)}\nمرتجعات المبيعات المسجلة: £${r.salesReturns.toFixed(2)}\nالمبيعات بعد قيمة المرتجعات المسجلة (تسويتها معلّقة): £${r.netSales.toFixed(2)}\nفواتير الشراء: ${r.purchaseCount}\nقيمة المشتريات: £${r.purchasesTotal.toFixed(2)}\nمرتجعات المشتريات: £${r.purchaseReturns.toFixed(2)}\nسداد الموردين المسجل: £${r.supplierPayments.toFixed(2)}\nتكلفة البضاعة الموثقة في فواتير البيع: £${r.documentedCost.toFixed(2)}\n`+
   (r.grossProfit===null?'الربح الإجمالي: غير قابل للحساب بدقة (تكاليف بيع أو تسويات مرتجعات ناقصة).':`هامش إجمالي تقديري من التكلفة الموثقة: £${r.grossProfit.toFixed(2)}`)+
   `\nقيود التكلفة غير المكتملة: ${r.costMissing}\nمرتجعات دون قيمة مالية: ${r.returnsUnpriced}\n`+
   'هذه أرقام السجلات المحفوظة، وليست صافي الربح المحاسبي؛ لا تشمل الرواتب والمصاريف والضرائب أو تسويات المخزون. لا يُحسب رصيد الموردين من المدفوعات وحدها.';
 };
 if(!navigator.onLine||!serverVerified){
  if(lastVerifiedFinancialReport)show(lastVerifiedFinancialReport,true);
  else msg.textContent='لا يوجد تقرير مالي محفوظ في هذه الجلسة. اتصل بالخادم لقراءة السجلات أولاً. المخزون المخزن محلياً قد يظل متاحاً للعرض.';
  return;
 }
 try{
  const names=['invoices','purchases','sales_returns','purchase_returns','supplier_payments'];
  const records={};
  for(const name of names){
   const snap=await getDocs(collection(db,name));
   if(snap.metadata.fromCache)throw Error('لا يمكن إصدار تقرير مالي موثوق من ذاكرة Firestore المؤقتة');
   records[name]=snap.docs.filter(d=>d.data().branchId==='main_branch').map(d=>d.data());
  }
  const report=summarizeFinances(records);lastVerifiedFinancialReport=report;show(report);
 }catch(e){msg.textContent='تعذر إصدار التقرير المالي: '+(e.code||e.message)+'\nلم يتم عرض أرقام مالية غير مؤكدة.';}
}

async function showSuppliers(){if(!requireAdmin()||!requireOnlineWrite())return;const {panel}=adminPanel('الموردون');const name=adminField(panel,'اسم المورد');const phone=adminField(panel,'رقم التواصل');const msg=adminText(panel,'');adminButton(panel,'سداد مستحقات الموردين',showSupplierPayments);adminButton(panel,'حفظ المورد',async()=>{if(!name.value.trim())return msg.textContent='أدخل اسم المورد';if(!requireOnlineWrite())return;try{const ref=doc(collection(db,'suppliers'));await runTransaction(db,async t=>{t.set(ref,{name:name.value.trim(),phone:phone.value.trim(),createdAt:new Date().toISOString(),branchId:'main_branch'});});msg.textContent='تم حفظ المورد';name.value='';phone.value='';await load();}catch(e){msg.textContent='فشل الحفظ: '+(e.code||e.message);}});const list=adminText(panel,'');async function load(){try{const snaps=await getDocs(query(collection(db,'suppliers'),limit(100)));list.textContent=snaps.empty?'لا يوجد موردون':snaps.docs.map(d=>`${d.data().name} — ${d.data().phone||''}`).join('\n');}catch(e){list.textContent='تعذر تحميل الموردين: '+(e.code||e.message);}}await load();}

// Purchase receiving: one Firestore transaction updates stock and creates an auditable purchase document.
async function showPurchases(){
  if(!requireAdmin()||!requireOnlineWrite())return;
  const {panel}=adminPanel('تسجيل فاتورة شراء');
  const supplier=adminField(panel,'اسم المورد');
  const name=adminField(panel,'اسم الدواء');
  const barcode=adminField(panel,'الباركود (اختياري)');
  const expiry=adminField(panel,'تاريخ انتهاء الدفعة','date');
  const qty=adminField(panel,'الكمية المستلمة','number');qty.min='1';qty.step='1';
  const cost=adminField(panel,'تكلفة شراء الوحدة','number');cost.min='0';cost.step='0.01';
  const price=adminField(panel,'سعر بيع الوحدة','number');price.min='0';price.step='0.01';
  const paid=adminField(panel,'المبلغ المدفوع للمورد','number');paid.min='0';paid.step='0.01';
  const note=adminField(panel,'مرجع فاتورة المورد (اختياري)');
  const status=adminText(panel,'يُحفظ الشراء والمخزون معاً أو لا يُحفظ أي منهما.');adminButton(panel,'مرتجع مشتريات',showPurchaseReturns);adminButton(panel,'سداد مستحقات الموردين',showSupplierPayments);
  let saving=false;
  adminButton(panel,'حفظ فاتورة الشراء واستلام المخزون',async()=>{
    if(saving||!requireAdmin()||!requireOnlineWrite())return;
    const quantity=Number(qty.value),unitCost=Number(cost.value),salePrice=Number(price.value),payment=Number(paid.value||0);
    const total=Math.round(quantity*unitCost*100)/100;
    if(!supplier.value.trim()||!name.value.trim()||!/^\d{4}-\d{2}-\d{2}$/.test(expiry.value)||expiry.value<todayLocal()||!Number.isSafeInteger(quantity)||quantity<=0||!cost.value.trim()||!price.value.trim()||![unitCost,salePrice,payment,total].every(v=>Number.isFinite(v)&&v>=0)||payment>total){status.textContent='تحقق من المورد والدواء والصلاحية والكمية والتكلفة والسعر والمدفوع';return;}
    const purchaseId='PUR-'+crypto.randomUUID();const stockId=crypto.randomUUID();
    const purchaseRef=doc(db,'purchases',purchaseId),stockRef=doc(db,'pharmacy','main_branch');
    saving=true;status.textContent='جارٍ الحفظ…';
    try{
      await runTransaction(db,async tx=>{
        const existing=await tx.get(purchaseRef);if(existing.exists())throw Error('فاتورة الشراء موجودة مسبقاً');
        const snap=await tx.get(stockRef);if(!snap.exists()||!Array.isArray(snap.data().inventory))throw Error('مخزون الفرع غير متاح');
        const inv=[...snap.data().inventory];
        inv.push({id:stockId,name:name.value.trim(),generic:'',barcode:barcode.value.trim(),expiryDate:expiry.value,qty:quantity,price:salePrice,purchaseCost:unitCost,purchaseId,supplierName:supplier.value.trim()});
        tx.update(stockRef,{inventory:inv});
        tx.set(purchaseRef,{id:purchaseId,branchId:'main_branch',supplierName:supplier.value.trim(),supplierInvoice:note.value.trim(),createdAt:new Date().toISOString(),items:[{stockId,name:name.value.trim(),barcode:barcode.value.trim(),expiryDate:expiry.value,quantity,unitCost,salePrice}],total,paid:payment,balance:Math.round((total-payment)*100)/100});
      });
      status.textContent='تم حفظ فاتورة الشراء وإضافة الدفعة إلى المخزون: '+purchaseId;
    }catch(e){status.textContent='فشل الحفظ ولم يتم تأكيد إضافة الدفعة: '+(e.code||e.message);}
    finally{saving=false;}
  });
  adminButton(panel,'عرض آخر فواتير الشراء',async()=>{
    if(!requireAdmin()||!requireOnlineWrite())return;
    const out=adminText(panel,'جارٍ التحميل…');
    try{const docs=await getDocs(query(collection(db,'purchases'),orderBy('createdAt','desc'),limit(30)));
      out.textContent=docs.empty?'لا توجد مشتريات مسجلة':docs.docs.map(x=>{const d=x.data();return `${d.id||x.id} — ${d.supplierName||''}\nالإجمالي: £${Number(d.total||0).toFixed(2)} | المدفوع: £${Number(d.paid||0).toFixed(2)} | المتبقي: £${Number(d.balance||0).toFixed(2)}`;}).join('\n\n');
    }catch(e){out.textContent='تعذر عرض المشتريات: '+(e.code||e.message);}
  });
}

async function showBackup(){if(!requireAdmin()||!requireOnlineWrite())return;const {panel}=adminPanel('نسخة احتياطية للقراءة فقط');adminText(panel,'تنبيه: هذا تصدير محلي لبيانات المخزون والمبيعات المجمعة، وليس نسخة شاملة لجميع الفواتير والموردين. لا تتضمن هذه النسخة ميزة الاستعادة.');adminButton(panel,'تصدير JSON',()=>{const data={exportedAt:new Date().toISOString(),branchId:'main_branch',pharmacy:state};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='saydaliati-backup-'+todayLocal()+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);});}

// V4.9: supplier settlements and purchase returns use atomic Firestore transactions.
async function showSupplierPayments(){
 if(!requireAdmin()||!requireOnlineWrite())return;
 const {panel}=adminPanel('سداد مستحقات الموردين');
 const invoice=adminField(panel,'رقم فاتورة الشراء');
 const amount=adminField(panel,'قيمة السداد','number');amount.min='0.01';amount.step='0.01';
 const result=adminText(panel,'يجب استخدام رقم فاتورة شراء محفوظة.');let busy=false;
 adminButton(panel,'تسجيل السداد',async()=>{
  if(busy||!requireAdmin()||!requireOnlineWrite())return;
  const id=invoice.value.trim(),sum=Number(amount.value);
  if(!/^PUR-[a-z0-9-]{20,}$/i.test(id)||!Number.isFinite(sum)||sum<=0||!amount.value.trim())return result.textContent='رقم الفاتورة أو المبلغ غير صالح';
  busy=true;const purchaseRef=doc(db,'purchases',id),paymentRef=doc(collection(db,'supplier_payments'));
  try{await runTransaction(db,async tx=>{
   const snap=await tx.get(purchaseRef);if(!snap.exists())throw Error('فاتورة الشراء غير موجودة');
   const d=snap.data(),balance=Number(d.balance);
   if(!Number.isFinite(balance)||balance<sum-0.001)throw Error('المبلغ يتجاوز الرصيد المستحق');
   const next=Math.round((balance-sum)*100)/100;
   tx.update(purchaseRef,{paid:Math.round((Number(d.paid||0)+sum)*100)/100,balance:next});
   tx.set(paymentRef,{purchaseId:id,amount:sum,createdAt:new Date().toISOString(),branchId:'main_branch'});
  });result.textContent='تم تسجيل السداد بنجاح';amount.value='';}
  catch(e){result.textContent='لم يُحفظ السداد: '+(e.code||e.message);}finally{busy=false;}
 });
}
async function showPurchaseReturns(){
 if(!requireAdmin()||!requireOnlineWrite())return;
 const {panel}=adminPanel('مرتجع مشتريات إلى المورد');
 const purchase=adminField(panel,'رقم فاتورة الشراء');
 const stock=adminField(panel,'معرف دفعة المخزون');
 const quantity=adminField(panel,'الكمية المرتجعة','number');quantity.min='1';quantity.step='1';
 const status=adminText(panel,'تُخصم الكمية من المخزون وتُسجل حركة المرتجع معاً.');let busy=false;
 adminButton(panel,'تسجيل مرتجع المشتريات',async()=>{
  if(busy||!requireAdmin()||!requireOnlineWrite())return;
  const pid=purchase.value.trim(),sid=stock.value.trim(),q=Number(quantity.value);
  if(!pid||!sid||!Number.isSafeInteger(q)||q<=0)return status.textContent='بيانات المرتجع غير صالحة';
  const pRef=doc(db,'purchases',pid),sRef=doc(db,'pharmacy','main_branch'),rRef=doc(collection(db,'purchase_returns'));
  busy=true;try{await runTransaction(db,async tx=>{
   const [p,s]=await Promise.all([tx.get(pRef),tx.get(sRef)]);
   if(!p.exists()||!s.exists())throw Error('الفاتورة أو المخزون غير موجود');
   const pd=p.data(),inv=s.data().inventory;
   if(!Array.isArray(inv)||!Array.isArray(pd.items))throw Error('بيانات غير صالحة');
   const line=pd.items.find(i=>i.stockId===sid),item=inv.find(i=>i.id===sid);
   if(!line||!item)throw Error('الدفعة لا تنتمي إلى الفاتورة');
   const prior=Number((pd.returnedQty||{})[sid]||0),original=Number(line.quantity),available=Number(item.qty);
   if(!Number.isSafeInteger(prior)||!Number.isSafeInteger(original)||!Number.isSafeInteger(available)||prior+q>original||q>available)throw Error('الكمية تتجاوز المتاح أو ما تم شراؤه');
   const value=Math.round(q*Number(line.unitCost)*100)/100;
   if(!Number.isFinite(value)||value<0)throw Error('تكلفة الدفعة غير صالحة');
   const next=inv.map(i=>i.id===sid?{...i,qty:available-q}:i);
   const returnedQty={...(pd.returnedQty||{}),[sid]:prior+q};
   tx.update(sRef,{inventory:next});tx.update(pRef,{returnedQty,returnedValue:Math.round((Number(pd.returnedValue||0)+value)*100)/100});
   tx.set(rRef,{purchaseId:pid,stockId:sid,quantity:q,value,createdAt:new Date().toISOString(),branchId:'main_branch',settlementStatus:'pending'});
  });status.textContent='تم تسجيل المرتجع وخصم الكمية. تسوية المبلغ مع المورد معلّقة.';}
  catch(e){status.textContent='فشل المرتجع: '+(e.code||e.message);}finally{busy=false;}
 });
}
async function showCompleteExport(){
 if(!requireAdmin()||!requireOnlineWrite())return;
 const {panel}=adminPanel('تصدير نسخة احتياطية شاملة');
 const status=adminText(panel,'تصدير للقراءة فقط. الاستعادة غير متاحة، ولا يُعد هذا بديلاً عن النسخ الاحتياطي على الخادم.');
 adminButton(panel,'تصدير بيانات الفرع والفواتير',async()=>{
  if(!requireOnlineWrite())return;
  status.textContent='جارٍ جمع السجلات…';
  try{
   const names=['invoices','purchases','suppliers','supplier_payments','purchase_returns','sales_returns','employees','branches'];
   const result={schemaVersion:1,exportedAt:new Date().toISOString(),branchId:'main_branch',pharmacy:state,collections:{}};
   for(const name of names){const snap=await getDocs(collection(db,name));result.collections[name]=snap.docs.filter(d=>d.data().branchId==='main_branch').map(d=>({id:d.id,...d.data()}));}
   const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
   a.href=url;a.download='saydaliati-full-export-'+todayLocal()+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
   status.textContent='اكتمل إنشاء ملف التصدير. احتفظ به في مكان آمن.';
  }catch(e){status.textContent='فشل التصدير: '+(e.code||e.message);}
 });
}
// V4.11: Manager-only employee directory. Firebase Auth accounts and security rules are managed separately.
const EMPLOYEE_ROLES = Object.freeze({pharmacist:'صيدلي',cashier:'أمين صندوق',inventory:'مسؤول مخزون',supervisor:'مشرف'});
const EMPLOYEE_STATUS = Object.freeze({active:'نشط',inactive:'موقوف'});
function staffChoice(panel,label,options){
 const wrap=document.createElement('label');wrap.textContent=label;wrap.style.cssText='display:grid;gap:5px;font-size:13px';
 const select=document.createElement('select');select.style.cssText='border:1px solid #ccc;border-radius:9px;padding:10px;width:100%';
 for(const [value,title] of Object.entries(options)){const opt=document.createElement('option');opt.value=value;opt.textContent=title;select.append(opt);}
 wrap.append(select);panel.insertBefore(wrap,panel.lastChild);return select;
}
async function showEmployees(){
 if(!requireAdmin()||!requireOnlineWrite())return;
 const {panel}=adminPanel('إدارة الموظفين والصلاحيات');
 adminText(panel,'هذه الشاشة لإدارة سجلات الموظفين وأدوارهم فقط. لا تنشئ حساب تسجيل دخول ولا تمنح صلاحيات Firebase تلقائياً. يجب إعداد الحسابات وقواعد Firestore بصورة منفصلة قبل السماح للموظفين بالدخول.');
 const name=adminField(panel,'اسم الموظف');name.maxLength=100;
 const email=adminField(panel,'البريد الإلكتروني','email');email.maxLength=254;
 const uid=adminField(panel,'معرّف حساب Firebase UID (اختياري للربط لاحقاً)');uid.maxLength=128;
 const role=staffChoice(panel,'الوظيفة',EMPLOYEE_ROLES);
 const status=staffChoice(panel,'الحالة',EMPLOYEE_STATUS);
 const note=adminText(panel,'اترك UID فارغاً لإنشاء سجل موظف دون حساب دخول.');
 let busy=false;
 const output=adminText(panel,'');
 async function refresh(){
  output.textContent='جارٍ تحميل الموظفين…';
  try{
   const snaps=await getDocs(collection(db,'employees'));
   const records=snaps.docs.map(d=>({id:d.id,...d.data()})).filter(d=>d.branchId==='main_branch').sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'ar'));
   output.textContent=records.length?`عدد الموظفين المسجلين: ${records.length}`:'لا يوجد موظفون مسجلون';
   for(const old of [...panel.querySelectorAll('[data-staff-row]')])old.remove();
   for(const e of records){
    const line=document.createElement('div');line.dataset.staffRow='1';line.style.cssText='padding:10px;border:1px solid #d1d5db;border-radius:12px;display:grid;gap:6px;font-size:12px';
    const summary=document.createElement('div');summary.textContent=`${e.name||'بدون اسم'} — ${EMPLOYEE_ROLES[e.role]||'دور غير معروف'} — ${EMPLOYEE_STATUS[e.status]||'حالة غير معروفة'}\n${e.email||''}\n${e.authUid?'UID: '+e.authUid:'غير مرتبط بحساب دخول'}`;summary.style.whiteSpace='pre-wrap';line.append(summary);
    const edit=document.createElement('button');edit.textContent='تحميل للتعديل';edit.style.cssText='background:#e5f3ed;padding:8px;border-radius:8px';
    edit.onclick=()=>{name.value=e.name||'';email.value=e.email||'';uid.value=e.authUid||'';role.value=EMPLOYEE_ROLES[e.role]?e.role:'pharmacist';status.value=EMPLOYEE_STATUS[e.status]?e.status:'inactive';name.dataset.employeeId=e.id;note.textContent='تعديل السجل المحدد. حفظ التغييرات لا يعدّل حساب Firebase Auth.';};line.append(edit);
    panel.insertBefore(line,panel.lastChild);
   }
  }catch(err){output.textContent='تعذر قراءة الموظفين: '+(err.code||err.message);}
 }
 adminButton(panel,'حفظ بيانات الموظف',async()=>{
  if(busy||!requireAdmin()||!requireOnlineWrite())return;
  const fullName=name.value.trim(),mail=email.value.trim().toLowerCase(),authUid=uid.value.trim();
  if(fullName.length<2||fullName.length>100||!(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))||!EMPLOYEE_ROLES[role.value]||!EMPLOYEE_STATUS[status.value])return note.textContent='يرجى إدخال اسم وبريد صحيحين وتحديد الدور والحالة.';
  if(authUid && (!/^[A-Za-z0-9_-]{6,128}$/.test(authUid)||authUid===ADMIN_UID))return note.textContent='معرّف UID غير صالح أو محجوز لحساب المدير.';
  busy=true;
  try{
   const existing=await getDocs(collection(db,'employees'));
   const id=name.dataset.employeeId||crypto.randomUUID();
   const collision=existing.docs.some(d=>d.id!==id && (d.data().email||'').toLowerCase()===mail);
   const uidCollision=authUid && existing.docs.some(d=>d.id!==id && d.data().authUid===authUid);
   if(collision||uidCollision)throw Error('البريد أو UID مستخدم في سجل موظف آخر');
   const current=existing.docs.find(d=>d.id===id)?.data();
   await setDoc(doc(db,'employees',id),{name:fullName,email:mail,authUid,role:role.value,status:status.value,branchId:'main_branch',createdAt:current?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),updatedBy:auth.currentUser.uid});
   note.textContent='تم حفظ سجل الموظف. لا يعني ذلك تفعيل الدخول أو الصلاحيات على الخادم.';
   delete name.dataset.employeeId;name.value='';email.value='';uid.value='';await refresh();
  }catch(err){note.textContent='فشل حفظ الموظف: '+(err.code||err.message);}finally{busy=false;}
 });
 adminButton(panel,'موظف جديد',()=>{delete name.dataset.employeeId;name.value='';email.value='';uid.value='';role.value='pharmacist';status.value='active';note.textContent='إنشاء سجل جديد دون منح صلاحيات دخول.';});
 adminButton(panel,'تحديث القائمة',refresh);
 await refresh();
}

function showBackupAndRestore(){const {panel}=adminPanel('النسخ الاحتياطي والاستعادة');adminButton(panel,'تصدير نسخة JSON',showCompleteExport);adminButton(panel,'استعادة بيانات الفرع الرئيسي',showRestore);}
// V4.12: Branch directory is metadata only; all financial operations remain bound to main_branch.
async function showBranches(){
 if(!requireAdmin()||!requireOnlineWrite())return;
 const {panel}=adminPanel('إدارة الفروع');
 adminText(panel,'سجل الفروع الإداري. العمليات المالية والمخزون ما زالت مرتبطة بالفرع الرئيسي فقط؛ لا يمكن التبديل إلى فرع آخر من هذه الشاشة.');
 const name=adminField(panel,'اسم الفرع');const address=adminField(panel,'عنوان الفرع');const phone=adminField(panel,'رقم الهاتف');const note=adminText(panel,'');const list=adminText(panel,'');
 const refresh=async()=>{try{const snap=await getDocs(collection(db,'branches'));const records=snap.docs.map(d=>({id:d.id,...d.data()}));list.textContent=records.length?records.map(b=>`${b.id==='main_branch'?'الرئيسي: ':''}${b.name||b.id} — ${b.address||''} — ${b.phone||''}`).join('\n'):'لا توجد سجلات فروع';}catch(e){list.textContent='تعذر عرض الفروع: '+(e.code||e.message);}};
 adminButton(panel,'حفظ فرع جديد',async()=>{if(!requireOnlineWrite())return;if(!name.value.trim())return note.textContent='اسم الفرع مطلوب';try{const ref=doc(collection(db,'branches'));await setDoc(ref,{name:name.value.trim(),address:address.value.trim(),phone:phone.value.trim(),status:'planned',createdAt:new Date().toISOString(),createdBy:auth.currentUser.uid});name.value='';address.value='';phone.value='';note.textContent='تم حفظ سجل الفرع. لم يتم تفعيل عمليات البيع فيه.';await refresh();}catch(e){note.textContent='فشل الحفظ: '+(e.code||e.message);}});
 adminButton(panel,'تحديث قائمة الفروع',refresh);await refresh();
}
// Restore is deliberately limited to the main pharmacy document. Other collections are never overwritten.
async function showRestore(){
 if(!requireAdmin()||!requireOnlineWrite())return;
 const {panel}=adminPanel('استعادة بيانات الفرع الرئيسي');
 adminText(panel,'استعادة المخزون وملخص المبيعات فقط من تصدير صيدليتي. لا تُستعاد الفواتير والموردون والموظفون أو سجلات المشتريات بهذه العملية. يتم حفظ نسخة من الحالة الحالية قبل الاستبدال. لا تستخدمها أثناء عمل الصيدلية.');
 const file=document.createElement('input');file.type='file';file.accept='.json,application/json';file.style.cssText='width:100%;padding:12px;border:1px solid #ddd;border-radius:10px';panel.insertBefore(file,panel.lastChild);
 const note=adminText(panel,'اختر ملف JSON ثم اضغط فحص النسخة.');let candidate=null;
 const validBackup=data=>{
  if(!data||data.schemaVersion!==1||data.branchId!=='main_branch'||!data.pharmacy||!Array.isArray(data.pharmacy.inventory))throw Error('الملف ليس نسخة متوافقة للفرع الرئيسي');
  if(data.pharmacy.inventory.length>20000)throw Error('عدد أصناف غير متوقع');
  const ids=new Set();for(const item of data.pharmacy.inventory){if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id)||typeof item.name!=='string'||!item.name.trim()||!Number.isSafeInteger(Number(item.qty))||Number(item.qty)<0||!Number.isFinite(Number(item.price))||Number(item.price)<0||typeof item.expiryDate!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(item.expiryDate))throw Error('النسخة تحتوي صنفاً غير صالح أو مكرراً');ids.add(item.id);}
  if(!Number.isFinite(Number(data.pharmacy.salesTotal))||Number(data.pharmacy.salesTotal)<0)throw Error('إجمالي المبيعات غير صالح');
  if(data.pharmacy.dailySales && (typeof data.pharmacy.dailySales!=='object'||Array.isArray(data.pharmacy.dailySales)||Object.values(data.pharmacy.dailySales).some(v=>!Number.isFinite(Number(v))||Number(v)<0)))throw Error('سجل المبيعات اليومية غير صالح');
  return {inventory:data.pharmacy.inventory,salesTotal:Number(data.pharmacy.salesTotal),dailySales:data.pharmacy.dailySales||{}};
 };
 adminButton(panel,'فحص النسخة دون تغيير البيانات',async()=>{candidate=null;try{if(!file.files?.[0])throw Error('اختر ملفاً');if(file.files[0].size>8*1024*1024)throw Error('الملف أكبر من الحد المسموح');const data=JSON.parse(await file.files[0].text());candidate=validBackup(data);note.textContent=`النسخة صالحة بنيوياً: ${candidate.inventory.length} صنف. سيُستبدل مخزون الفرع الرئيسي وملخص المبيعات فقط. لم تتغير أي بيانات.`;}catch(e){note.textContent='فشل الفحص: '+e.message;}});
 adminButton(panel,'استعادة بعد التأكيد',async()=>{
  if(!candidate||!requireOnlineWrite())return note.textContent='افحص النسخة أولاً وتأكد من الاتصال';
  if(!confirm('تحذير: ستُستبدل بيانات المخزون والمبيعات المجمعة للفرع الرئيسي. هل أنت متأكد؟'))return;
  const typed=prompt('للتأكيد اكتب: استعادة');if(typed!=='استعادة')return note.textContent='تم إلغاء الاستعادة';
  try{const source=JSON.parse(await file.files[0].text());const restore=validBackup(source);const main=doc(db,'pharmacy','main_branch'),backup=doc(collection(db,'restore_snapshots'));
   await runTransaction(db,async tx=>{const current=await tx.get(main);if(!current.exists()||!Array.isArray(current.data().inventory))throw Error('تعذر قراءة بيانات الفرع الحالية');tx.set(backup,{branchId:'main_branch',createdAt:new Date().toISOString(),createdBy:auth.currentUser.uid,pharmacy:current.data(),source:'before_restore'});tx.update(main,restore);});
   candidate=null;note.textContent='تمت استعادة المخزون وملخص المبيعات. حُفظت نسخة من الحالة السابقة في restore_snapshots. بقية السجلات لم تتغير.';
  }catch(e){note.textContent='فشلت الاستعادة ولم تُعتمد: '+(e.code||e.message);}
 });
}
function showUnfinished(label){const {panel}=adminPanel(label);adminText(panel,'هذه الوظيفة ليست جاهزة للاستخدام الفعلي. لن يتم عرض زر وهمي يوحي بأنها تعمل.');}

document.addEventListener('DOMContentLoaded',()=>{updateUI();const barcode=document.getElementById('new-barcode');if(barcode){let timer;barcode.addEventListener('touchstart',()=>{timer=setTimeout(scanBarcode,650);},{passive:true});for(const event of ['touchend','touchcancel','touchmove'])barcode.addEventListener(event,()=>clearTimeout(timer),{passive:true});barcode.addEventListener('dblclick',scanBarcode);}});
document.addEventListener('click',event=>{const purchaseButton=event.target.closest('button[onclick="window.switchScreen(\'screen-add-product\')"]');if(purchaseButton && purchaseButton.textContent.includes('المشتريات')){event.preventDefault();event.stopImmediatePropagation();showPurchases();return;}const settings=event.target.closest('button[onclick="alert(\'الإعدادات العامة\')"]');if(settings){event.preventDefault();event.stopImmediatePropagation();showAdminLogin();return;}
  const adminActions={"شاشة الفواتير":showInvoices,"قسم الموردين":showSuppliers,"التقارير والأرباح":showReports,"قسم التقارير والأرباح المالية":showReports,"النسخ الاحتياطي السحابي":showBackupAndRestore,"إدارة الفروع":showBranches,"إدارة الموظفين والصلاحيات":showEmployees,"ماسح الباركود السريع":scanBarcode};
  const btn=event.target.closest('button[onclick]');if(btn){const action=btn.getAttribute('onclick')?.match(/^alert\('([^']+)'\)$/)?.[1];if(action&&adminActions[action]){event.preventDefault();event.stopImmediatePropagation();adminActions[action]();return;}}
  const add=event.target.closest('[data-add-id]'),remove=event.target.closest('[data-remove-id]'),qty=event.target.closest('[data-qty-id]');if(add)window.addToCart(add.dataset.addId);else if(remove)window.removeFromCart(remove.dataset.removeId);else if(qty)window.updateCartQty(qty.dataset.qtyId,Number(qty.dataset.delta));},true);

window.addEventListener('offline', () => { serverVerified = false; syncStatus('دون إنترنت — يمكن تجهيز السلة كمسودة فقط، ولا يتم تسجيل أي بيع'); });
window.addEventListener('online', () => { serverVerified = false; syncStatus('جارٍ التحقق من الاتصال بالخادم…'); if(authenticatedAdmin) initCloudSync(); });
