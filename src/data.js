import { db } from './firebase.js';
import { doc, collection, writeBatch, getDocs, query, limit } from 'firebase/firestore';
import { toast } from './ui.js';

// ===== مسارات Firestore =====
// users/{uid}                              ← يحدد صيدلية المستخدم
// pharmacies/{pid}                         ← بيانات الصيدلية والترخيص (license يكتبه الخادم)
// pharmacies/{pid}/members/{uid}           ← الموظفون وأدوارهم
// pharmacies/{pid}/suppliers/{id}
// pharmacies/{pid}/branches/{bid}          ← الفروع
// pharmacies/{pid}/branches/{bid}/stock|invoices|purchases|returns|daily
export const userRef = uid => doc(db, 'users', uid);
export const pharmacyRef = pid => doc(db, 'pharmacies', pid);
export const membersCol = pid => collection(db, 'pharmacies', pid, 'members');
export const memberRef = (pid, uid) => doc(db, 'pharmacies', pid, 'members', uid);
export const suppliersCol = pid => collection(db, 'pharmacies', pid, 'suppliers');
export const branchesCol = pid => collection(db, 'pharmacies', pid, 'branches');
export const branchRef = (pid, bid) => doc(db, 'pharmacies', pid, 'branches', bid);
export const branchCol = (pid, bid, name) => collection(db, 'pharmacies', pid, 'branches', bid, name);
export const branchDoc = (pid, bid, name, id) => doc(db, 'pharmacies', pid, 'branches', bid, name, id);

// قواعد الأمان تسمح بعدد محدود من العمليات في الدفعة الواحدة
export const BATCH_MAX = 18;
export const MAX_INVOICE_LINES = 15;

function reportLateFailure(e) {
  console.warn('فشلت مزامنة عملية مع السحابة', e);
  toast('تعذرت مزامنة عملية مع السحابة: ' + (e.code || e.message));
}

// يحفظ الدفعة: دون إنترنت تُخزَّن محلياً وتُرفع تلقائياً عند عودة الاتصال (لا تضيع)
export async function commitBatch(batch) {
  const p = batch.commit();
  if (!navigator.onLine) { p.catch(reportLateFailure); return { queued: true }; }
  const TIMEOUT = Symbol('timeout');
  const r = await Promise.race([p.then(() => 'ok'), new Promise(res => setTimeout(() => res(TIMEOUT), 6000))]);
  if (r === TIMEOUT) { p.catch(reportLateFailure); return { queued: true }; }
  return { queued: false };
}

// كتابة عدد كبير من المستندات على دفعات صغيرة. ops: دوال (batch) => void
export async function writeChunked(ops, onProgress) {
  for (let i = 0; i < ops.length; i += BATCH_MAX) {
    const batch = writeBatch(db);
    ops.slice(i, i + BATCH_MAX).forEach(fn => fn(batch));
    await batch.commit();
    onProgress?.(Math.min(i + BATCH_MAX, ops.length), ops.length);
  }
}

// حذف كل مستندات مجموعة (عند حذف الحساب)
export async function deleteAllDocs(colRef) {
  for (;;) {
    const snap = await getDocs(query(colRef, limit(BATCH_MAX)));
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}
