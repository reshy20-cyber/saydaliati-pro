export const Capacitor = {
  isNativePlatform: () => window.__native === true,
  getPlatform: () => (window.__native ? 'android' : 'web')
};
