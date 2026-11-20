import { auth, db, getSecondaryAuth } from './firebase.js';
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail,
  deleteUser, reauthenticateWithCredential, EmailAuthProvider, signOut
} from 'firebase/auth';
import {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction,
  query, where, orderBy, limit
} from 'firebase/firestore';
import { CONFIG } from './config.js';
import { S, hooks, isCloud, role, can, ROLE_LABELS, licenseActive, licenseTier, maxBranches, activeBranchCount, activeBranch, allowedBranches, requireCan, requireOnlineWrite, getCurrencySymbol } from './state.js';
import { adminPanel, adminText, adminField, adminSelect, adminCheckList, adminButton, adminRow, toast } from './ui.js';
import {
  userRef, pharmacyRef, membersCol, memberRef, suppliersCol, branchesCol, branchRef, branchCol, branchDoc,
  commitBatch, writeChunked, deleteAllDocs
} from './data.js';
import { todayLocal, uuid, round2, exportTextFile, isCancel } from './util.js';
import { isNativeApp, isBillingConfigured, getPackages, purchase, restore, wasCancelled, logoutBilling, BASE_PRODUCTS, UPGRADES, productKey } from './billing.js';
import { syncLicense, registerDevice, listDevices, removeDevice, getDeviceId } from './license.js';

const fmtDate = iso => { try { return new Date(iso).toLocaleDateString('ar-EG'); } catch { return String(iso || ''); } };
const pid = () => S.session.pharmacyId;
const bid = () => S.session.branchId;

function authErrorMessage(e) {
  const map = {
    'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة',
    'auth/wrong-password': 'كلمة المرور غير صحيحة',
    'auth/user-not-found': 'لا يوجد حساب بهذا البريد',
    'auth/invalid-email': 'صيغة البريد الإلكتروني غير صحيحة',
    'auth/email-already-in-use': 'هذا البريد مسجّل مسبقاً',
    'auth/weak-password': 'كلمة المرور ضعيفة (8 أحرف على الأقل)',
    'auth/network-request-failed': 'تعذر الاتصال بالإنترنت',
    'auth/too-many-requests': 'محاولات كثيرة، حاول لاحقاً',
    'auth/requires-recent-login': 'سجّل الدخول من جديد ثم أعد المحاولة',
    'permission-denied': 'لا تملك صلاحية لهذه العملية (تحقق من قواعد Firestore)'
  };
  return map[e?.code] || e?.message || 'حدث خطأ غير متوقع';
}
const looksLikeEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function legalLinks(panel) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:14px;justify-content:center;font-size:11px;font-weight:800;color:#0f766e';
  for (const [label, url] of [['سياسة الخصوصية', CONFIG.privacyUrl], ['شروط الاستخدام', CONFIG.termsUrl]]) {
    const a = document.createElement('a');
    a.textContent = label;
    if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.style.textDecoration = 'underline'; }
    else { a.style.opacity = '.5'; a.title = 'أضف الرابط في config.js'; }
    wrap.append(a);
  }
  panel.insertBefore(wrap, panel.lastChild);
}

// ================= الدخول وإنشاء الحساب =================
async function createPharmacy(user, { pharmacyName, ownerName }) {
  const pRef = doc(collection(db, 'pharmacies'));
  const id = pRef.id;
  const now = new Date().toISOString();
  await setDoc(pRef, { name: pharmacyName, ownerUid: user.uid, createdAt: now });
  try {
    // عضوية المالك أولاً: قواعد الأمان تتحقق من العضوية قبل السماح بإنشاء الفرع
    const batch = writeBatch(db);
    batch.set(memberRef(id, user.uid), { uid: user.uid, name: ownerName || user.email, email: user.email, role: 'owner', status: 'active', allBranches: true, branchIds: [], createdAt: now });
    batch.set(userRef(user.uid), { pharmacyId: id, role: 'owner' });
    await batch.commit();
  } catch (e) { await deleteDoc(pRef).catch(() => {}); throw e; }
  try {
    await setDoc(doc(branchesCol(id)), { name: 'الفرع الرئيسي', status: 'active', createdAt: now });
  } catch (e) { console.warn('تعذر إنشاء الفرع الرئيسي، يمكن إضافته من شاشة الفروع', e); }
  return id;
}

export function showAuthDialog(mode = 'login') {
  const isReg = mode === 'register';
  const { panel, overlay } = adminPanel(isReg ? 'إنشاء حساب صيدلية جديد' : 'تسجيل الدخول');
  adminText(panel, isReg
    ? 'أنشئ حسابك كمالك للصيدلية، ثم أضف الفروع والموظفين من داخل التطبيق.'
    : 'سجّل الدخول بحسابك لعرض بيانات صيدليتك ومزامنتها بين أجهزتك.');
  const pharmacyName = isReg ? adminField(panel, 'اسم الصيدلية') : null;
  const ownerName = isReg ? adminField(panel, 'اسمك') : null;
  const email = adminField(panel, 'البريد الإلكتروني', 'email');
  const pw = adminField(panel, 'كلمة المرور' + (isReg ? ' (8 أحرف على الأقل)' : ''), 'password');
  const pw2 = isReg ? adminField(panel, 'تأكيد كلمة المرور', 'password') : null;
  const status = adminText(panel, '');
  status.style.cssText += ';color:#b91c1c;font-weight:800';

  const submit = adminButton(panel, isReg ? 'إنشاء الحساب' : 'دخول', async () => {
    status.textContent = '';
    const em = email.value.trim(), p = pw.value;
    if (!looksLikeEmail(em)) return status.textContent = 'أدخل بريداً إلكترونياً صحيحاً';
    if (!p) return status.textContent = 'أدخل كلمة المرور';
    if (isReg) {
      if (!pharmacyName.value.trim()) return status.textContent = 'أدخل اسم الصيدلية';
      if (p.length < 8) return status.textContent = 'كلمة المرور يجب ألا تقل عن 8 أحرف';
      if (p !== pw2.value) return status.textContent = 'كلمتا المرور غير متطابقتين';
    }
    if (!navigator.onLine) return status.textContent = 'تحتاج اتصالاً بالإنترنت لتسجيل الدخول أو إنشاء الحساب';
    submit.disabled = true;
    try {
      if (isReg) {
        // نوقف استجابة التطبيق لحدث تسجيل الدخول طوال إنشاء الحساب والصيدلية، ثم نبدأ الجلسة يدوياً
        hooks.setSuppressAuth(true);
        let cred;
        try {
          cred = await createUserWithEmailAndPassword(auth, em, p);
          await createPharmacy(cred.user, { pharmacyName: pharmacyName.value.trim(), ownerName: ownerName.value.trim() });
        } finally { hooks.setSuppressAuth(false); }
        overlay.remove();
        await hooks.startSession(cred.user);
      } else {
        await signInWithEmailAndPassword(auth, em, p);
        overlay.remove();
      }
    } catch (e) {
      console.warn('auth flow failed', e);
      status.textContent = authErrorMessage(e);
      if (isReg && auth.currentUser) { overlay.remove(); await hooks.startSession(auth.currentUser); }
    } finally { submit.disabled = false; }
  });
  if (!isReg) {
    adminButton(panel, 'نسيت كلمة المرور؟', async () => {
      const em = email.value.trim();
      if (!looksLikeEmail(em)) return status.textContent = 'أدخل بريدك أولاً ثم اضغط هذا الزر';
      try { await sendPasswordResetEmail(auth, em); status.style.color = '#047857'; status.textContent = 'أُرسل رابط إعادة تعيين كلمة المرور إلى بريدك'; }
      catch (e) { status.style.color = '#b91c1c'; status.textContent = authErrorMessage(e); }
    }, 'plain');
  }
  adminButton(panel, isReg ? 'لدي حساب — تسجيل الدخول' : 'إنشاء حساب صيدلية جديد', () => showAuthDialog(isReg ? 'login' : 'register'), 'teal');
  legalLinks(panel);
}

export function showCreatePharmacy() {
  const { panel, overlay } = adminPanel('إكمال إعداد الحساب');
  adminText(panel, 'حسابك غير مرتبط بصيدلية بعد. أنشئ صيدلية جديدة لتصبح مالكها، أو سجّل الخروج إن كنت موظفاً وانتظر من المالك إضافتك.');
  const name = adminField(panel, 'اسم الصيدلية');
  const status = adminText(panel, ''); status.style.cssText += ';color:#b91c1c;font-weight:800';
  const btn = adminButton(panel, 'إنشاء الصيدلية', async () => {
    if (!name.value.trim()) return status.textContent = 'أدخل اسم الصيدلية';
    btn.disabled = true;
    try {
      hooks.setSuppressAuth(true);
      try { await createPharmacy(auth.currentUser, { pharmacyName: name.value.trim(), ownerName: '' }); }
      finally { hooks.setSuppressAuth(false); }
      overlay.remove();
      await hooks.startSession(auth.currentUser);
    } catch (e) { status.textContent = authErrorMessage(e); } finally { btn.disabled = false; }
  });
  adminButton(panel, 'تسجيل الخروج', async () => { overlay.remove(); await hooks.logout(); }, 'plain');
  adminButton(panel, 'حذف حسابي', () => { overlay.remove(); showDeleteAccount(); }, 'danger');
}

// ================= الحساب =================
export function showAccount() {
  if (!S.session.user) return showAuthDialog('login');
  if (!isCloud()) return showCreatePharmacy();
  const { panel } = adminPanel('حسابي والإعدادات');
  const ph = S.session.pharmacy;
  const subText = licenseActive()
    ? `فعّال ✓ — ${licenseTier()} ${licenseTier() === 1 ? 'صيدلية' : 'صيدليات'}`
    : 'غير مفعّل';
  const info = adminText(panel,
    `البريد: ${S.session.user.email}\nالصيدلية: ${ph?.name || ''}\nالدور: ${ROLE_LABELS[role()] || ''}\nالفرع الحالي: ${activeBranch()?.name || '—'}\nالترخيص: ${subText}`);
  info.style.cssText += ';background:#ecfdf5;border:1px solid #a7f3d0;border-radius:14px;padding:12px;font-weight:700';

  adminButton(panel, '🏪 الفروع وتبديل الفرع', () => showBranches());
  if (can('employees')) adminButton(panel, '👥 الموظفون والصلاحيات', () => showEmployees());
  if (role() === 'owner') adminButton(panel, licenseActive() ? '⭐ إدارة الترخيص والترقية' : '⭐ تفعيل الترخيص', () => showPaywall(), licenseActive() ? 'primary' : 'gold');
  if (role() === 'owner') adminButton(panel, '📱 الأجهزة المصرح بها', () => showDevices(), 'primary');
  adminButton(panel, '💱 العملة (' + getCurrencySymbol() + ')', () => showCurrencySettings());
  adminButton(panel, '📷 فحص صلاحيات الكاميرا والتخزين', () => window.requestCameraAndStoragePermissions(), 'teal');
  adminButton(panel, 'تسجيل الخروج', async () => { document.getElementById('saydaliati-admin-panel')?.remove(); await hooks.logout(); }, 'plain');
  adminButton(panel, 'حذف حسابي نهائياً', () => showDeleteAccount(), 'danger');
}

function showDeleteAccount() {
  const { panel, overlay } = adminPanel('حذف الحساب نهائياً');
  const owner = role() === 'owner';
  const warn = adminText(panel, owner
    ? 'سيتم حذف حسابك وكل بيانات الصيدلية (الفروع والأصناف والفواتير والموظفين) ولا يمكن التراجع.\nحذف الحساب لا يُرجع مبلغ الترخيص؛ طلبات الاسترداد تتم عبر المتجر وفق سياسته.'
    : 'سيتم حذف حسابك وإزالتك من الصيدلية. لن تتأثر بيانات الصيدلية.');
  warn.style.cssText += ';color:#991b1b;font-weight:800';
  const pw = adminField(panel, 'أدخل كلمة المرور للتأكيد', 'password');
  const status = adminText(panel, ''); status.style.cssText += ';color:#b91c1c;font-weight:800';
  const btn = adminButton(panel, 'حذف نهائياً', async () => {
    const user = auth.currentUser;
    if (!user) return;
    if (!pw.value) return status.textContent = 'أدخل كلمة المرور';
    if (!requireOnlineWrite()) return;
    if (!confirm('هل أنت متأكد؟ لا يمكن التراجع عن الحذف.')) return;
    btn.disabled = true;
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pw.value));
      status.textContent = 'جارٍ الحذف… لا تغلق التطبيق';
      const id = S.session.pharmacyId, ownerNow = role() === 'owner';
      hooks.stopSession();
      if (id) {
        if (ownerNow) {
          const branches = await getDocs(branchesCol(id));
          for (const b of branches.docs) {
            for (const name of ['stock', 'invoices', 'purchases', 'returns', 'daily']) await deleteAllDocs(branchCol(id, b.id, name));
            await deleteDoc(branchRef(id, b.id));
          }
          await deleteAllDocs(suppliersCol(id));
          const members = await getDocs(membersCol(id));
          for (const m of members.docs) {
            if (m.id === user.uid) continue;
            await deleteDoc(userRef(m.id)).catch(() => {});
            await deleteDoc(m.ref);
          }
          await deleteDoc(pharmacyRef(id));
        }
        await deleteDoc(memberRef(id, user.uid)).catch(() => {});
      }
      await deleteDoc(userRef(user.uid)).catch(() => {});
      await logoutBilling();
      await deleteUser(user);
      overlay.remove();
      alert('تم حذف حسابك وبياناتك.');
      await hooks.logout();
    } catch (e) { status.textContent = authErrorMessage(e); btn.disabled = false; }
  }, 'danger');
}

// ================= الترخيص =================
export async function showPaywall() {
  const { panel } = adminPanel('ترخيص صيدليتي PRO');
  const tier = licenseTier();
  const head = adminText(panel,
    'الترخيص يُدفع مرة واحدة بلا تجديد. يفتح: المزامنة السحابية، تعدد الصيدليات (الفروع)، الموظفون وصلاحياتهم، المبيعات والمشتريات والمرتجعات والتقارير.\nلكل صيدلية مرخّصة 3 أجهزة مصرح بها.');
  head.style.fontWeight = '700';
  const state = adminText(panel, licenseActive()
    ? `ترخيصك فعّال ✓ — ${tier} ${tier === 1 ? 'صيدلية' : 'صيدليات'} (حتى ${S.session.pharmacy?.license?.maxDevices || tier * 3} أجهزة)`
    : 'لا يوجد ترخيص — يمكنك عرض بياناتك وتصديرها، لكن لا يمكن إضافة عمليات جديدة.');
  state.style.cssText += ';background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:10px;font-weight:800';

  if (role() !== 'owner') { adminText(panel, 'الترخيص يديره مالك الصيدلية فقط.'); return; }
  if (!isNativeApp()) { adminText(panel, 'الشراء يتم من داخل تطبيق الجوال (Google Play أو App Store) فقط. افتح التطبيق على جوالك.'); return; }
  if (!isBillingConfigured()) { adminText(panel, 'لم تُضبط مفاتيح الدفع بعد. راجع ملف src/config.js.'); return; }

  const msg = adminText(panel, 'جارٍ تحميل الباقات…');
  // الخادم يتحقق من الشراء ويكتب الترخيص؛ نعيد المحاولة قليلاً لأن RevenueCat قد يتأخر ثوانٍ
  const activate = async () => {
    msg.textContent = 'جارٍ تفعيل الترخيص…';
    for (let i = 0; i < 4; i++) {
      try {
        const { license } = await syncLicense(pid());
        if (license && license.tier > tier) { msg.textContent = 'تم تفعيل الترخيص ✓'; return; }
      } catch (e) { console.warn('syncLicense', e); }
      await new Promise(r => setTimeout(r, 2500));
    }
    msg.textContent = 'تم الدفع، وسيظهر الترخيص خلال دقائق. إن تأخر فاضغط "استعادة مشترياتي".';
  };
  try {
    const packages = await getPackages();
    const byKey = new Map(packages.map(p => [productKey(p), p]));
    const offers = [];
    if (tier === 0) {
      for (const [id, n] of Object.entries(BASE_PRODUCTS)) offers.push({ id, label: `ترخيص ${n} ${n === 1 ? 'صيدلية' : 'صيدليات'}` });
    } else {
      const up = UPGRADES.find(u => u.from === tier);
      if (up) offers.push({ id: up.id, label: `ترقية إلى ${up.to} صيدليات` });
    }
    const available = offers.filter(o => byKey.has(o.id));
    msg.textContent = available.length ? (tier ? 'الترقية المتاحة:' : 'اختر الباقة:') : (tier && !offers.length ? 'لديك أعلى باقة ✓' : 'لا توجد باقات متاحة حالياً. تأكد من إعداد المنتجات في المتجر وRevenueCat.');
    for (const o of available) {
      const pkg = byKey.get(o.id);
      adminButton(panel, `${o.label} — ${pkg.product.priceString}`, async () => {
        try { await purchase(pkg); await activate(); }
        catch (e) { if (!wasCancelled(e)) msg.textContent = 'تعذر إتمام الشراء: ' + (e.message || e); }
      }, 'gold');
    }
  } catch (e) { msg.textContent = 'تعذر تحميل الباقات: ' + (e.message || e); }
  adminButton(panel, 'استعادة مشترياتي', async () => {
    try { await restore(); await activate(); } catch (e) { msg.textContent = 'تعذرت الاستعادة: ' + (e.message || e); }
  }, 'plain');
  adminText(panel, 'الدفع مرة واحدة عبر حسابك في المتجر ولا يتجدد. الترخيص مرتبط بحساب الصيدلية ويعمل على أجهزتها المصرح بها فقط.').style.cssText += ';font-size:11px;color:#475569';
  legalLinks(panel);
}

// ================= الأجهزة المصرح بها =================
export async function showDevices({ blocked = false } = {}) {
  const { panel, close, overlay } = adminPanel('الأجهزة المصرح بها');
  if (blocked) close.remove();
  if (role() !== 'owner') { adminText(panel, 'يديرها مالك الصيدلية فقط.'); return; }
  const msg = adminText(panel, 'جارٍ التحميل…');
  const render = async () => {
    try {
      const { max, devices } = await listDevices(pid());
      msg.textContent = (blocked ? 'بلغت صيدليتك الحد الأقصى للأجهزة. احذف جهازاً لا تستخدمه ليعمل هذا الجهاز.\n' : '') + `الأجهزة: ${devices.length} من ${max}`;
      panel.querySelectorAll('[data-dev]').forEach(el => el.remove());
      const me = getDeviceId();
      for (const d of devices) {
        const label = (d.id === me ? '✓ هذا الجهاز — ' : '') + (d.name || d.id.slice(0, 8)) + (d.lastSeen ? ' · ' + fmtDate(d.lastSeen) : '');
        const btn = adminButton(panel, 'حذف: ' + label, async () => {
          if (!confirm('حذف هذا الجهاز من القائمة المصرح بها؟')) return;
          try {
            await removeDevice(pid(), d.id);
            if (blocked) { await registerDevice(pid()); S.session.deviceBlocked = false; overlay.remove(); toast('تم تفعيل هذا الجهاز'); return; }
            render();
          } catch (e) { msg.textContent = 'تعذر الحذف: ' + (e.message || e); }
        }, d.id === me ? 'plain' : 'danger');
        btn.dataset.dev = '1';
      }
    } catch (e) { msg.textContent = 'تعذر تحميل الأجهزة: ' + (e.message || e); }
  };
  if (blocked) adminButton(panel, 'تسجيل الخروج', async () => { overlay.remove(); await hooks.logout(); }, 'plain');
  render();
}

// يُستدعى بعد الدخول: يسجّل الجهاز ويمنع الاستخدام إذا بلغت الصيدلية حدّ أجهزتها
export async function enforceDeviceLimit() {
  try {
    await registerDevice(pid());
    S.session.deviceBlocked = false;
  } catch (e) {
    if (e.status !== 409) { console.warn('registerDevice', e); return; } // بلا إنترنت أو خطأ مؤقت: لا نقطع العمل
    S.session.deviceBlocked = true;
    if (role() === 'owner') showDevices({ blocked: true });
    else { alert(`بلغت الصيدلية الحد الأقصى للأجهزة المصرح بها (${e.data?.max || ''}). اطلب من مالك الصيدلية حذف جهاز قديم ثم سجّل الدخول من جديد.`); await hooks.logout(); }
  }
}

// ================= الفروع =================
export function showBranches() {
  if (!isCloud()) return showAuthDialog('login');
  const { panel, overlay } = adminPanel('الفروع');
  adminText(panel, 'الفرع الذي تعمل عليه الآن مُعلَّم بـ ✓. لكل فرع مخزونه وفواتيره ومبيعاته المستقلة.');
  const list = allowedBranches();
  if (!list.length) adminText(panel, 'لا توجد فروع متاحة لك. تواصل مع المالك.');
  for (const b of list) {
    const current = b.id === S.session.branchId;
    adminButton(panel, (current ? '✓ ' : '') + b.name, () => { hooks.selectBranch(b.id); overlay.remove(); }, current ? 'gold' : 'primary');
  }
  if (can('branches')) {
    adminText(panel, 'إضافة فرع جديد:').style.fontWeight = '800';
    const name = adminField(panel, 'اسم الفرع');
    const status = adminText(panel, ''); status.style.cssText += ';color:#b91c1c;font-weight:800';
    adminButton(panel, 'إضافة الفرع', async () => {
      if (!name.value.trim()) return status.textContent = 'أدخل اسم الفرع';
      if (!requireCan('branches') || !requireOnlineWrite()) return;
      if (activeBranchCount() >= maxBranches()) {
        status.textContent = `ترخيصك يسمح بـ ${maxBranches()} ${maxBranches() === 1 ? 'صيدلية' : 'صيدليات'} فقط. رقِّ الترخيص لإضافة المزيد.`;
        if (role() === 'owner') adminButton(panel, '⭐ ترقية الترخيص', () => showPaywall(), 'gold');
        return;
      }
      try {
        const ref = doc(branchesCol(pid()));
        await setDoc(ref, { name: name.value.trim(), status: 'active', createdAt: new Date().toISOString() });
        // ننتظر وصول الفرع الجديد إلى القائمة المحلية (مستمع الفروع) قبل إعادة رسم اللوحة
        for (let i = 0; i < 20 && !S.session.branches.some(b => b.id === ref.id); i++) await new Promise(r => setTimeout(r, 100));
        showBranches();
      } catch (e) { status.textContent = authErrorMessage(e); }
    }, 'teal');
  }
}

// ================= الموظفون =================
export async function showEmployees() {
  if (!requireCan('employees')) return;
  const { panel } = adminPanel('الموظفون والصلاحيات');
  adminText(panel, 'المدير: يبيع ويدير المخزون والمشتريات والتقارير.\nالكاشير: يبيع ويعرض الفواتير فقط.');
  const listMsg = adminText(panel, 'جارٍ تحميل الموظفين…');
  try {
    const snap = await getDocs(membersCol(pid()));
    listMsg.textContent = `عدد الأعضاء: ${snap.size}`;
    const branchName = id => S.session.branches.find(b => b.id === id)?.name || id;
    for (const d of snap.docs) {
      const m = d.data();
      const access = m.allBranches ? 'كل الفروع' : (m.branchIds || []).map(branchName).join('، ') || 'بلا فروع';
      adminRow(panel, `${m.name || m.email} — ${ROLE_LABELS[m.role] || m.role}\n${m.email}\nالحالة: ${m.status === 'active' ? 'نشط' : 'معطّل'} | الفروع: ${access}`);
      if (m.role === 'owner') continue;
      adminButton(panel, m.status === 'active' ? `تعطيل ${m.name || ''}` : `تفعيل ${m.name || ''}`, async () => {
        if (!requireCan('employees')) return;
        try { await updateDoc(d.ref, { status: m.status === 'active' ? 'inactive' : 'active' }); showEmployees(); }
        catch (e) { alert(authErrorMessage(e)); }
      }, 'plain');
      adminButton(panel, 'إرسال رابط تغيير كلمة المرور', async () => {
        try { await sendPasswordResetEmail(auth, m.email); toast('أُرسل الرابط إلى ' + m.email); } catch (e) { alert(authErrorMessage(e)); }
      }, 'teal');
      adminButton(panel, 'إزالة من الصيدلية', async () => {
        if (!requireCan('employees') || !confirm('إزالة ' + (m.name || m.email) + ' من الصيدلية؟')) return;
        try { const b = writeBatch(db); b.delete(d.ref); b.delete(userRef(d.id)); await b.commit(); showEmployees(); }
        catch (e) { alert(authErrorMessage(e)); }
      }, 'danger');
    }
  } catch (e) { listMsg.textContent = 'تعذر تحميل الموظفين: ' + authErrorMessage(e); }

  adminText(panel, 'إضافة موظف جديد (أنت تحدد كلمة مرور مؤقتة وتسلّمها له):').style.cssText += ';font-weight:900;margin-top:8px';
  const name = adminField(panel, 'اسم الموظف');
  const email = adminField(panel, 'بريد الموظف الإلكتروني', 'email');
  const pw = adminField(panel, 'كلمة مرور مؤقتة (8 أحرف على الأقل)', 'password');
  const roleSel = adminSelect(panel, 'الدور', [{ value: 'cashier', label: 'كاشير' }, { value: 'manager', label: 'مدير' }]);
  const branchChecks = adminCheckList(panel, 'الفروع المسموحة (اتركها فارغة لكل الفروع):',
    S.session.branches.filter(b => b.status !== 'archived').map(b => ({ value: b.id, label: b.name })));
  const status = adminText(panel, ''); status.style.cssText += ';color:#b91c1c;font-weight:800';
  const btn = adminButton(panel, 'إضافة الموظف', async () => {
    status.textContent = '';
    const em = email.value.trim().toLowerCase();
    if (!name.value.trim()) return status.textContent = 'أدخل اسم الموظف';
    if (!looksLikeEmail(em)) return status.textContent = 'أدخل بريداً صحيحاً';
    if (pw.value.length < 8) return status.textContent = 'كلمة المرور المؤقتة يجب ألا تقل عن 8 أحرف';
    if (!requireCan('employees') || !requireOnlineWrite()) return;
    const chosen = branchChecks();
    btn.disabled = true;
    try {
      const secAuth = getSecondaryAuth();
      let uid;
      try { uid = (await createUserWithEmailAndPassword(secAuth, em, pw.value)).user.uid; }
      catch (e) {
        // حساب أُنشئ سابقاً دون ربطه (محاولة فاشلة): نتبنّاه إن كانت كلمة المرور صحيحة
        if (e.code !== 'auth/email-already-in-use') throw e;
        try { uid = (await signInWithEmailAndPassword(secAuth, em, pw.value)).user.uid; }
        catch { throw Object.assign(new Error('هذا البريد مسجّل مسبقاً بحساب آخر، استخدم بريداً مختلفاً'), { code: 'custom' }); }
      }
      await signOut(secAuth);
      const batch = writeBatch(db);
      batch.set(memberRef(pid(), uid), { uid, name: name.value.trim(), email: em, role: roleSel.value, status: 'active', allBranches: chosen.length === 0, branchIds: chosen, createdAt: new Date().toISOString() });
      batch.set(userRef(uid), { pharmacyId: pid(), role: roleSel.value });
      await batch.commit();
      showEmployees();
    } catch (e) { status.textContent = authErrorMessage(e); btn.disabled = false; }
  }, 'teal');
}

// ================= الفواتير والمرتجعات =================
export async function showInvoices() {
  if (!isCloud()) return showAuthDialog('login');
  if (!can('invoices')) return alert('ليست لديك صلاحية لهذه العملية.');
  const { panel } = adminPanel('الفواتير الأخيرة — ' + (activeBranch()?.name || ''));
  if (can('returns')) adminButton(panel, 'تسجيل مرتجع مبيعات', showSalesReturns, 'teal');
  const msg = adminText(panel, 'جارٍ تحميل الفواتير…');
  try {
    const snaps = await getDocs(query(branchCol(pid(), bid(), 'invoices'), orderBy('createdAt', 'desc'), limit(50)));
    msg.textContent = snaps.empty ? 'لا توجد فواتير مسجلة' : `آخر ${snaps.size} فاتورة (اضغط لعرضها)`;
    snaps.forEach(s => {
      const d = s.data();
      adminRow(panel, `${s.id}\n${new Date(d.createdAt).toLocaleString('ar-EG')}\nالإجمالي: ${getCurrencySymbol()} ${Number(d.total || 0).toFixed(2)}${d.cashierName ? '\nالبائع: ' + d.cashierName : ''}`, () => hooks.showInvoice({ ...d, id: s.id }));
    });
  } catch (e) { msg.textContent = 'تعذر قراءة الفواتير: ' + authErrorMessage(e); }
}

export async function showSalesReturns() {
  if (!requireCan('returns') || !requireOnlineWrite()) return;
  const { panel } = adminPanel('مرتجعات المبيعات');
  const invoice = adminField(panel, 'رقم فاتورة البيع');
  adminButton(panel, 'عرض بنود الفاتورة', async () => {
    const invId = invoice.value.trim();
    if (!invId) { status.textContent = 'أدخل رقم الفاتورة أولاً'; return; }
    try {
      const snap = await getDoc(branchDoc(pid(), bid(), 'invoices', invId));
      if (!snap.exists()) { status.textContent = 'الفاتورة غير موجودة في هذا الفرع'; return; }
      linesBox.textContent = '';
      for (const it of snap.data().items || []) {
        const row = document.createElement('div');
        row.textContent = `${it.name} — الكمية المباعة: ${it.quantity}`;
        row.style.cssText = 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px;font-size:12px;font-weight:700;cursor:pointer';
        row.onclick = () => { stock.value = it.id; status.textContent = 'تم اختيار: ' + it.name; };
        linesBox.append(row);
      }
      status.textContent = 'اضغط على الصنف المراد إرجاعه من القائمة';
    } catch (e) { status.textContent = 'تعذر تحميل الفاتورة: ' + authErrorMessage(e); }
  });
  const linesBox = document.createElement('div');
  linesBox.style.cssText = 'display:grid;gap:6px';
  panel.insertBefore(linesBox, panel.lastChild);
  const stock = adminField(panel, 'الصنف المراد إرجاعه (يُملأ تلقائياً عند اختياره)');
  const quantity = adminField(panel, 'الكمية المرتجعة', 'number'); quantity.min = '1'; quantity.step = '1';
  const reason = adminField(panel, 'سبب المرتجع');
  const status = adminText(panel, 'تنبيه: الدواء المرتجع يُسجل في سجل منفصل (الحجر) ولا يعود تلقائياً للمخزون القابل للبيع.');
  let busy = false;
  adminButton(panel, 'تسجيل المرتجع', async () => {
    if (busy || !requireCan('returns') || !requireOnlineWrite()) return;
    const id = invoice.value.trim(), sid = stock.value.trim(), q = Number(quantity.value);
    if (!id || !sid || !reason.value.trim() || !Number.isSafeInteger(q) || q <= 0) return status.textContent = 'أدخل جميع الحقول بشكل صحيح';
    const invoiceRef = branchDoc(pid(), bid(), 'invoices', id), returnRef = doc(branchCol(pid(), bid(), 'returns'));
    busy = true;
    try {
      await runTransaction(db, async tx => {
        const snap = await tx.get(invoiceRef);
        if (!snap.exists()) throw Error('الفاتورة غير موجودة');
        const sale = snap.data();
        const line = sale.items?.find(i => i.id === sid);
        if (!line) throw Error('هذا الصنف غير موجود في الفاتورة');
        const original = Number(line.quantity), prior = Number((sale.returnedQty || {})[sid] || 0), price = Number(line.unitPrice);
        if (prior + q > original) throw Error('الكمية تتجاوز المباع');
        const value = round2(q * price);
        tx.update(invoiceRef, { returnedQty: { ...(sale.returnedQty || {}), [sid]: prior + q }, returnedValue: round2(Number(sale.returnedValue || 0) + value) });
        tx.set(returnRef, { invoiceId: id, stockId: sid, productName: String(line.name || ''), quantity: q, refundAmount: value, reason: reason.value.trim(), createdAt: new Date().toISOString(), branchId: bid(), createdBy: S.session.user.uid, restockStatus: 'quarantined', refundStatus: 'pending' });
      });
      status.textContent = 'تم تسجيل المرتجع بنجاح.';
    } catch (e) { status.textContent = 'فشل تسجيل المرتجع: ' + authErrorMessage(e); }
    finally { busy = false; }
  });
}

// ================= التقارير =================
export function showReports() {
  if (!isCloud()) return showAuthDialog('login');
  if (!can('reports')) return alert('ليست لديك صلاحية لهذه العملية.');
  const { panel } = adminPanel('التقارير المالية');
  const out = adminText(panel, 'اختر الفترة والنطاق ثم اضغط عرض التقرير.');
  out.style.cssText += ';background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:10px';
  const period = adminSelect(panel, 'الفترة', [{ value: '1', label: 'اليوم' }, { value: '7', label: 'آخر 7 أيام' }, { value: '30', label: 'آخر 30 يوماً' }]);
  const multi = allowedBranches().length > 1;
  const scope = adminSelect(panel, 'النطاق', multi
    ? [{ value: 'one', label: 'الفرع الحالي: ' + (activeBranch()?.name || '') }, { value: 'all', label: 'كل فروعي' }]
    : [{ value: 'one', label: 'الفرع الحالي: ' + (activeBranch()?.name || '') }]);
  adminButton(panel, 'عرض التقرير', async () => {
    out.textContent = 'جارٍ إعداد التقرير…';
    try {
      const days = Number(period.value);
      const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
      const sinceIso = since.toISOString();
      const branches = scope.value === 'all' ? allowedBranches() : [activeBranch()].filter(Boolean);
      let sales = 0, invCount = 0, refunds = 0, purchases = 0, purCount = 0;
      for (const b of branches) {
        const rd = async name => (await getDocs(query(branchCol(pid(), b.id, name), where('createdAt', '>=', sinceIso)))).docs.map(d => d.data());
        const [inv, ret, pur] = await Promise.all([rd('invoices'), rd('returns'), rd('purchases')]);
        sales += inv.reduce((s, r) => s + Number(r.total || 0), 0); invCount += inv.length;
        refunds += ret.reduce((s, r) => s + Number(r.refundAmount || 0), 0);
        purchases += pur.reduce((s, r) => s + Number(r.total || 0), 0); purCount += pur.length;
      }
      const c = getCurrencySymbol();
      out.textContent = `الفروع: ${branches.map(b => b.name).join('، ')}\nفواتير البيع: ${invCount}\nإجمالي المبيعات: ${c} ${round2(sales).toFixed(2)}\nمرتجعات المبيعات: ${c} ${round2(refunds).toFixed(2)}\nصافي المبيعات: ${c} ${round2(sales - refunds).toFixed(2)}\nفواتير الشراء: ${purCount}\nقيمة المشتريات: ${c} ${round2(purchases).toFixed(2)}`;
    } catch (e) { out.textContent = 'تعذر إصدار التقرير: ' + authErrorMessage(e); }
  });
}

// ================= الموردون والمشتريات =================
export async function showSuppliers() {
  if (!isCloud()) return showAuthDialog('login');
  if (!can('suppliers')) return alert('ليست لديك صلاحية لهذه العملية.');
  const { panel } = adminPanel('الموردون');
  const listMsg = adminText(panel, 'جارٍ تحميل الموردين…');
  try {
    const snap = await getDocs(query(suppliersCol(pid()), orderBy('createdAt', 'desc'), limit(100)));
    listMsg.textContent = snap.empty ? 'لا يوجد موردون بعد' : `عدد الموردين: ${snap.size}`;
    snap.forEach(d => adminRow(panel, `${d.data().name}${d.data().phone ? '\n' + d.data().phone : ''}`));
  } catch (e) { listMsg.textContent = 'تعذر تحميل الموردين: ' + authErrorMessage(e); }
  const name = adminField(panel, 'اسم المورد');
  const phone = adminField(panel, 'رقم التواصل');
  const msg = adminText(panel, '');
  adminButton(panel, 'حفظ المورد', async () => {
    if (!name.value.trim()) return msg.textContent = 'أدخل اسم المورد';
    if (!requireCan('suppliers')) return;
    try {
      const batch = writeBatch(db);
      batch.set(doc(suppliersCol(pid())), { name: name.value.trim(), phone: phone.value.trim(), createdAt: new Date().toISOString() });
      await commitBatch(batch);
      showSuppliers();
    } catch (e) { msg.textContent = 'فشل الحفظ: ' + authErrorMessage(e); }
  });
}

export async function showPurchases() {
  if (!requireCan('purchases')) return;
  const { panel } = adminPanel('تسجيل فاتورة شراء — ' + (activeBranch()?.name || ''));
  const supplier = adminField(panel, 'اسم المورد');
  const name = adminField(panel, 'اسم الدواء');
  const generic = adminField(panel, 'الاسم العلمي (اختياري)');
  const barcode = adminField(panel, 'الباركود');
  const expiry = adminField(panel, 'تاريخ انتهاء الصلاحية', 'date');
  const qty = adminField(panel, 'الكمية المستلمة', 'number'); qty.inputMode = 'numeric';
  const cost = adminField(panel, 'تكلفة الوحدة', 'number'); cost.inputMode = 'decimal';
  const price = adminField(panel, 'سعر البيع', 'number'); price.inputMode = 'decimal';
  const status = adminText(panel, '');
  adminButton(panel, 'حفظ فاتورة الشراء واستلام المخزون', async () => {
    const q = Number(qty.value), c = Number(cost.value), p = Number(price.value);
    if (!supplier.value.trim() || !name.value.trim() || !expiry.value) return status.textContent = 'أكمل البيانات المطلوبة';
    if (expiry.value < todayLocal()) return status.textContent = 'تاريخ الصلاحية منتهٍ';
    if (!Number.isSafeInteger(q) || q <= 0) return status.textContent = 'الكمية يجب أن تكون عدداً صحيحاً أكبر من صفر';
    if (cost.value === '' || !Number.isFinite(c) || c < 0) return status.textContent = 'أدخل تكلفة صحيحة للوحدة';
    if (price.value === '' || !Number.isFinite(p) || p <= 0) return status.textContent = 'أدخل سعر بيع صحيحاً';
    if (!requireCan('purchases')) return;
    const purchaseId = 'PUR-' + uuid(), stockId = uuid(), now = new Date().toISOString();
    try {
      const batch = writeBatch(db);
      batch.set(branchDoc(pid(), bid(), 'stock', stockId), { name: name.value.trim(), generic: generic.value.trim(), barcode: barcode.value.trim(), expiryDate: expiry.value, qty: q, price: p, purchaseCost: c, purchaseId, supplierName: supplier.value.trim(), createdAt: now });
      batch.set(branchDoc(pid(), bid(), 'purchases', purchaseId), { id: purchaseId, branchId: bid(), supplierName: supplier.value.trim(), createdAt: now, total: round2(q * c), paid: round2(q * c), balance: 0, createdBy: S.session.user.uid });
      const r = await commitBatch(batch);
      status.textContent = (r.queued ? 'حُفظت على الجهاز وستُرفع للسحابة عند عودة الاتصال: ' : 'تم حفظ فاتورة الشراء: ') + purchaseId;
    } catch (e) { status.textContent = 'فشل الحفظ: ' + authErrorMessage(e); }
  });
}

// ================= النسخ الاحتياطي والاستيراد =================
export function showBackupAndRestore() {
  const { panel } = adminPanel('النسخ الاحتياطي والاستيراد');
  const status = adminText(panel, 'تصدير مخزون الفرع الحالي بصيغة JSON، أو استيراد نسخة سابقة إلى الفرع الحالي.');
  adminButton(panel, 'تصدير نسخة JSON الآن', async () => {
    try {
      const content = JSON.stringify({ exportedAt: new Date().toISOString(), branch: activeBranch()?.name || null, pharmacy: { inventory: S.state.inventory, dailySales: S.state.dailySales } }, null, 2);
      await exportTextFile('saydaliati-backup-' + todayLocal() + '.json', 'application/json', content);
      status.textContent = 'تم تجهيز النسخة الاحتياطية ✓';
    } catch (e) { if (!isCancel(e)) status.textContent = 'تعذر التصدير: ' + (e.message || e); }
  });
  if (can('editStock')) {
    adminButton(panel, 'استيراد أصناف من ملف JSON', () => {
      if (!requireCan('editStock')) return;
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'application/json,.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          const rawItems = Array.isArray(data) ? data : (data.pharmacy?.inventory || data.inventory || []);
          const ops = []; let skipped = 0;
          for (const it of rawItems) {
            const price = Number(it?.price), q = Number(it?.qty);
            if (!it || typeof it.name !== 'string' || !it.name.trim() || !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(q) || q < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(it.expiryDate || ''))) { skipped++; continue; }
            const id = typeof it.id === 'string' && it.id && !it.id.startsWith('demo-') && !it.id.includes('/') ? it.id : uuid();
            const item = { name: it.name.trim(), generic: String(it.generic || ''), barcode: String(it.barcode || ''), expiryDate: it.expiryDate, price, qty: q, importedAt: new Date().toISOString() };
            ops.push(b => b.set(branchDoc(pid(), bid(), 'stock', id), item));
          }
          if (!ops.length) return status.textContent = 'لا توجد أصناف صالحة في الملف';
          if (!confirm(`سيتم استيراد ${ops.length} صنف إلى الفرع الحالي${skipped ? ` (تجاهل ${skipped} غير صالح)` : ''}. المتابعة؟`)) return;
          if (!requireOnlineWrite()) return;
          await writeChunked(ops, (done, total) => { status.textContent = `جارٍ الاستيراد… ${done}/${total}`; });
          status.textContent = `تم استيراد ${ops.length} صنف ✓`;
        } catch (e) { status.textContent = 'تعذر الاستيراد: ' + authErrorMessage(e); }
      };
      input.click();
    }, 'teal');
  }
}

// ================= العملة =================
const CURRENCIES = [
  { name: 'الجنيه المصري (EGP)', symbol: 'ج.م' },
  { name: 'الريال السعودي (SAR)', symbol: 'ر.س' },
  { name: 'الدرهم الإماراتي (AED)', symbol: 'د.إ' },
  { name: 'الريال القطري (QAR)', symbol: 'ر.ق' },
  { name: 'الدينار الكويتي (KWD)', symbol: 'د.ك' },
  { name: 'الدينار البحريني (BHD)', symbol: 'د.ب' },
  { name: 'الريال العماني (OMR)', symbol: 'ر.ع' },
  { name: 'الدينار الأردني (JOD)', symbol: 'د.أ' },
  { name: 'الليرة اللبنانية (LBP)', symbol: 'ل.ل' },
  { name: 'الدينار العراقي (IQD)', symbol: 'د.ع' },
  { name: 'الليرة السورية (SYP)', symbol: 'ل.س' },
  { name: 'الريال اليمني (YER)', symbol: 'ر.ي' },
  { name: 'الدينار الليبي (LYD)', symbol: 'د.ل' },
  { name: 'الدينار التونسي (TND)', symbol: 'د.ت' },
  { name: 'الدينار الجزائري (DZD)', symbol: 'د.ج' },
  { name: 'الدرهم المغربي (MAD)', symbol: 'د.م' },
  { name: 'الجنيه السوداني (SDG)', symbol: 'ج.س' },
  { name: 'الأوقية الموريتانية (MRU)', symbol: 'أ.م' },
  { name: 'الشلن الصومالي (SOS)', symbol: 'ش.ص' },
  { name: 'الفرنك الجيبوتي (DJF)', symbol: 'ف.ج' },
  { name: 'الفرنك القمري (KMF)', symbol: 'ف.ق' },
  { name: 'الشيكل (ILS) - فلسطين', symbol: '₪' }
];

export function showCurrencySettings() {
  const { panel, overlay } = adminPanel('إعدادات العملة');
  const cloud = isCloud();
  const staff = cloud && role() !== 'owner';
  adminText(panel, staff
    ? 'عملة الصيدلية يحددها المالك: ' + getCurrencySymbol()
    : (cloud ? 'العملة الرسمية لصيدليتك (تُطبَّق على كل الموظفين والفروع):' : 'اختر العملة:'));
  if (staff) return;
  for (const c of CURRENCIES) {
    adminButton(panel, `${c.symbol === getCurrencySymbol() ? '✓ ' : ''}${c.name}`, async () => {
      try {
        if (cloud) {
          if (!requireOnlineWrite()) return;
          await updateDoc(pharmacyRef(S.session.pharmacyId), { currency: c.symbol });
        }
        S.currency = c.symbol;
        localStorage.setItem('saydaliati_currency_symbol', c.symbol);
        hooks.updateUI();
        overlay.remove();
        toast('تم تغيير العملة إلى ' + c.name);
      } catch (e) { alert('تعذر تغيير العملة: ' + authErrorMessage(e)); }
    }, c.symbol === getCurrencySymbol() ? 'gold' : 'primary');
  }
}

hooks.showAuthDialog = showAuthDialog;
hooks.showPaywall = showPaywall;
hooks.showCreatePharmacy = showCreatePharmacy;
