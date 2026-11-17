const apps = new Map();
export function initializeApp(cfg, name = '[DEFAULT]') { const a = { name, options: cfg }; apps.set(name, a); return a; }
export function getApp(name = '[DEFAULT]') { if (!apps.has(name)) throw new Error('no app ' + name); return apps.get(name); }
