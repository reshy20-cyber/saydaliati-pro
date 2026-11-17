// عناصر واجهة بسيطة للنوافذ الإدارية
export function toast(message) {
  let t = document.getElementById('saydaliati-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'saydaliati-toast';
    t.style.cssText = 'position:fixed;bottom:96px;left:14px;right:14px;max-width:360px;margin:auto;z-index:10010;background:#003a2c;color:#fff;padding:10px 14px;border-radius:14px;font-size:12px;font-weight:800;text-align:center;box-shadow:0 6px 18px rgba(0,0,0,.3);direction:rtl';
    document.body.append(t);
  }
  t.textContent = message;
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.display = 'none'; }, 4000);
}

export function adminPanel(title) {
  document.getElementById('saydaliati-admin-panel')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'saydaliati-admin-panel';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:#001b15c9;display:grid;place-items:center;padding:15px;direction:rtl';
  const panel = document.createElement('section');
  panel.style.cssText = 'background:#fff;border-radius:20px;padding:18px;width:min(100%,440px);max-height:86vh;overflow:auto;color:#123;display:grid;gap:11px;align-content:start';
  const header = document.createElement('h2');
  header.textContent = title;
  header.style.cssText = 'font-size:19px;font-weight:900;color:#004634';
  panel.append(header);
  const close = document.createElement('button');
  close.textContent = 'إغلاق';
  close.style.cssText = 'padding:10px;border:1px solid #cbd5e1;border-radius:12px;font-weight:800';
  close.onclick = () => overlay.remove();
  panel.append(close);
  overlay.append(panel);
  document.body.append(overlay);
  return { panel, close, overlay };
}
export function adminText(panel, value) {
  const p = document.createElement('p');
  p.textContent = value;
  p.style.cssText = 'font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6';
  panel.insertBefore(p, panel.lastChild);
  return p;
}
export function adminField(panel, label, type = 'text') {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  wrap.style.cssText = 'display:grid;gap:4px;font-size:12px;font-weight:800';
  const input = document.createElement('input');
  input.type = type;
  input.style.cssText = 'border:1px solid #cbd5e1;border-radius:10px;padding:10px;width:100%;font-weight:600;font-size:16px';
  if (type === 'email' || type === 'password') input.dir = 'ltr';
  wrap.append(input);
  panel.insertBefore(wrap, panel.lastChild);
  return input;
}
export function adminSelect(panel, label, options) {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  wrap.style.cssText = 'display:grid;gap:4px;font-size:12px;font-weight:800';
  const select = document.createElement('select');
  select.style.cssText = 'border:1px solid #cbd5e1;border-radius:10px;padding:10px;width:100%;font-weight:700;background:#fff;font-size:16px';
  for (const o of options) { const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; select.append(opt); }
  wrap.append(select);
  panel.insertBefore(wrap, panel.lastChild);
  return select;
}
// قائمة اختيار متعدد؛ تعيد دالة تُرجع القيم المحددة
export function adminCheckList(panel, label, items) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid;gap:6px;font-size:12px;font-weight:800';
  const title = document.createElement('div'); title.textContent = label; wrap.append(title);
  const boxes = items.map(it => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;font-weight:700;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = it.value; cb.checked = !!it.checked;
    row.append(cb, document.createTextNode(it.label)); wrap.append(row);
    return cb;
  });
  panel.insertBefore(wrap, panel.lastChild);
  return () => boxes.filter(b => b.checked).map(b => b.value);
}
const VARIANTS = { primary: '#00533c', danger: '#991b1b', teal: '#0f766e', plain: '#475569', gold: '#a16207' };
export function adminButton(panel, label, handler, variant = 'primary') {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = `background:${VARIANTS[variant] || VARIANTS.primary};color:white;padding:11px;border-radius:12px;font-weight:800;font-size:13px`;
  b.onclick = handler;
  panel.insertBefore(b, panel.lastChild);
  return b;
}
export function adminRow(panel, text, onClick) {
  const row = document.createElement('div');
  row.textContent = text;
  row.style.cssText = 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:9px;font-size:12px;font-weight:700;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6' + (onClick ? ';cursor:pointer' : '');
  if (onClick) row.onclick = onClick;
  panel.insertBefore(row, panel.lastChild);
  return row;
}
