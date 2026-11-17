export const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const round2 = n => Math.round(n * 100) / 100;
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

export const validStock = i => i && typeof i === 'object' && Number.isSafeInteger(Number(i.qty)) && Number(i.qty) > 0 && typeof i.expiryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(i.expiryDate) && i.expiryDate >= todayLocal() && Number.isFinite(Number(i.price)) && Number(i.price) >= 0;
export const fefoBatches = (inv, item) => inv.filter(i => (item.barcode && i.barcode === item.barcode) || i.id === item.id).filter(validStock).sort((a, b) => (a.expiryDate || '9999-12-31').localeCompare(b.expiryDate || '9999-12-31'));

// ===== مشاركة وتصدير: يعمل في المتصفح وداخل تطبيق Capacitor =====
export const isNative = () => !!window.Capacitor?.isNativePlatform?.();
export const nativePlugin = name => (isNative() ? window.Capacitor?.Plugins?.[name] : null);
export const isCancel = e => e && (e.name === 'AbortError' || /cancel/i.test(String(e.message || '')));

export async function shareText(title, text) {
  try {
    const Share = nativePlugin('Share');
    if (Share) { await Share.share({ title, text, dialogTitle: title }); return; }
    if (navigator.share) { await navigator.share({ title, text }); return; }
  } catch (e) { if (isCancel(e)) return; }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
}

export async function exportTextFile(filename, mime, content) {
  const FS = nativePlugin('Filesystem'), Share = nativePlugin('Share');
  if (FS && Share) {
    const res = await FS.writeFile({ path: filename, data: content, directory: 'CACHE', encoding: 'utf8' });
    await Share.share({ title: filename, url: res.uri, dialogTitle: 'حفظ الملف' });
    return;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
