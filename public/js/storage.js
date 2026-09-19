const PREFIX = 'bg_tube_';

function store() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch (_) {}
  return null;
}

export function getStorage(key, fallback) {
  try {
    const ls = store();
    if (!ls) return fallback;
    const raw = ls.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn('storage read failed', key, err);
    return fallback;
  }
}

export function setStorage(key, value) {
  try {
    const ls = store();
    if (!ls) return false;
    ls.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('storage write failed', key, err);
    return false;
  }
}

export function removeStorage(key) {
  try {
    const ls = store();
    if (ls) ls.removeItem(PREFIX + key);
  } catch (_) {}
}

export function clearAppData() {
  const ls = store();
  if (!ls) return;
  const keys = [];
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (key && key.startsWith(PREFIX)) keys.push(key);
  }
  keys.forEach((key) => ls.removeItem(key));
}
