import { getStorage, setStorage } from './storage.js';

const DEFAULTS = {
  theme: 'system',
  autoplay: true,
  repeat: 'off',
  shuffle: false,
  lastTab: 'home'
};

let settings = { ...DEFAULTS, ...getStorage('settings', {}) };

export function getSettings() {
  return { ...settings };
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  setStorage('settings', settings);
  return getSettings();
}
