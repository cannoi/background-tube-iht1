import { getSettings, updateSettings } from './settings.js';

const THEMES = ['dark', 'light', 'rainbow'];

function systemDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyTheme(theme = getSettings().theme) {
  let mode = theme || 'rainbow';
  if (mode === 'system') mode = systemDark() ? 'dark' : 'light';
  if (!THEMES.includes(mode)) mode = 'rainbow';

  const root = document.documentElement;
  root.classList.remove('dark', 'light', 'rainbow');
  if (mode === 'dark') root.classList.add('dark');
  else if (mode === 'rainbow') root.classList.add('rainbow');
  else root.classList.add('light');

  root.dataset.theme = mode;
  root.style.colorScheme = mode === 'light' ? 'light' : 'dark';

  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', mode === 'light' ? '#fffaf6' : mode === 'rainbow' ? '#1a0a2e' : '#120e16');
    }
  } catch (_) {}
}

export function setTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'rainbow';
  updateSettings({ theme: t });
  applyTheme(t);
}

export function initTheme() {
  const s = getSettings();
  if (!s.theme || s.theme === 'system') {
    updateSettings({ theme: 'rainbow' });
  }
  applyTheme(getSettings().theme);
}
