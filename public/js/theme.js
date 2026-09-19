import { getSettings, updateSettings } from './settings.js';

function systemDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(theme = getSettings().theme) {
  const mode = theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme;
  document.documentElement.classList.toggle('dark', mode === 'dark');
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
}

export function setTheme(theme) {
  updateSettings({ theme });
  applyTheme(theme);
}

export function initTheme() {
  applyTheme();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getSettings().theme === 'system') applyTheme('system');
    });
  }
}
