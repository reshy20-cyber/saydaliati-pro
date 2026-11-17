import { initializeApp, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, initializeFirestore, persistentLocalCache } from 'firebase/firestore';

export const firebaseConfig = {
  apiKey: 'AIzaSyBBsWY5RkBHoph7EQegUNCbwCjGNCeKF4g',
  authDomain: 'saydaliati-pro.firebaseapp.com',
  projectId: 'saydaliati-pro',
  storageBucket: 'saydaliati-pro.firebasestorage.app',
  messagingSenderId: '376696818740',
  appId: '1:376696818740:web:752f369fab6980894c4e61',
  measurementId: 'G-TBDGSVB0GN'
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// التخزين المحلي لـ Firestore: يحفظ العمليات أثناء انقطاع الإنترنت ويرفعها تلقائياً عند عودته
let _db;
try { _db = initializeFirestore(app, { localCache: persistentLocalCache() }); }
catch (e) { console.warn('تعذر تفعيل التخزين المحلي لـ Firestore', e); _db = getFirestore(app); }
export const db = _db;

// نسخة ثانوية من Firebase لإنشاء حسابات الموظفين دون إخراج المالك من حسابه
export function getSecondaryAuth() {
  let secondary;
  try { secondary = getApp('secondary'); } catch { secondary = initializeApp(firebaseConfig, 'secondary'); }
  return getAuth(secondary);
}
