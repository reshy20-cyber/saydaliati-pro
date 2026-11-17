import { CONFIG } from './config.js';

// حالة التطبيق المشتركة بين الملفات
export const S = {
  state: { inventory: [], dailySales: {} },
  cart: [],
  session: { user: null, pharmacyId: null, pharmacy: null, member: null, branches: [], branchId: null },
  currency: (() => { const c = localStorage.getItem('saydaliati_currency_symbol'); return c && c !== '£' ? c : 'ج.م'; })(),
  checkoutInProgress: false,
  activeFilter: 'all',
  invQuery: ''
};

// دوال تُسجَّل من app.js لتفادي الاستيراد الدائري
export const hooks = {};

// في الوضع السحابي تُوحَّد العملة لكل موظفي الصيدلية (يحددها المالك)
export const getCurrencySymbol = () => (S.session.pharmacyId && S.session.pharmacy?.currency) || S.currency;
export const isCloud = () => !!(S.session.user && S.session.pharmacyId && S.session.member && S.session.member.status === 'active');
export const role = () => (isCloud() ? S.session.member.role : null);

export const ROLE_LABELS = { owner: 'مالك', manager: 'مدير', cashier: 'كاشير' };
const ROLE_PERMS = {
  owner: ['sell', 'editStock', 'purchases', 'suppliers', 'returns', 'invoices', 'reports', 'backup', 'employees', 'branches'],
  manager: ['sell', 'editStock', 'purchases', 'suppliers', 'returns', 'invoices', 'reports', 'backup'],
  cashier: ['sell', 'invoices']
};
// عمليات تعدّل البيانات: تتوقف عند انتهاء الاشتراك (القراءة والتصدير تبقى متاحة)
export const WRITE_PERMS = new Set(['sell', 'editStock', 'purchases', 'suppliers', 'returns', 'employees', 'branches']);

export const can = perm => isCloud() && (ROLE_PERMS[role()] || []).includes(perm);

export const isReviewer = () => !!S.session.user?.email && (CONFIG.reviewerEmails || []).includes(S.session.user.email.toLowerCase());

export function subscriptionActive() {
  if (isReviewer()) return true;
  const sub = S.session.pharmacy?.subscription;
  if (!sub || !sub.active) return false;
  if (!sub.expiresAt) return true;
  return new Date(sub.expiresAt).getTime() + CONFIG.graceDays * 86400000 > Date.now();
}

export const activeBranch = () => S.session.branches.find(b => b.id === S.session.branchId) || null;
export function allowedBranches() {
  const m = S.session.member;
  if (!m) return [];
  const list = m.allBranches ? S.session.branches : S.session.branches.filter(b => (m.branchIds || []).includes(b.id));
  return list.filter(b => b.status !== 'archived');
}

// يتحقق من الدخول والصلاحية والاشتراك قبل أي عملية
export function requireCan(perm) {
  if (!isCloud()) { hooks.showAuthDialog?.('login'); return false; }
  if (!can(perm)) { alert('ليست لديك صلاحية لهذه العملية.'); return false; }
  if (WRITE_PERMS.has(perm) && !subscriptionActive()) {
    if (role() === 'owner') hooks.showPaywall?.();
    else alert('اشتراك الصيدلية غير فعّال حالياً. تواصل مع مالك الصيدلية.');
    return false;
  }
  return true;
}
export function requireOnlineWrite() {
  if (!navigator.onLine) { alert('هذه العملية تحتاج اتصالاً بالإنترنت.'); return false; }
  return true;
}
