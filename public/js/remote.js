import { ensureSession, getSessionInfo, tryAutoJoinFromUrl, publishLocalState, joinSession } from './session.js';

export function initRemoteUI() {
  tryAutoJoinFromUrl().then((sid) => {
    if (sid) console.info('[session] joined', sid);
  }).catch(() => {});

  document.addEventListener('click', async (e) => {
    if (e.target.closest('#qrBtn, [data-action="qr"]')) {
      e.preventDefault();
      openQrModal();
    }
    if (e.target.closest('#qrClose')) {
      const m = document.getElementById('qrModal');
      if (m) m.hidden = true;
    }
    if (e.target.closest('#qrRemote')) createPair('remote');
    if (e.target.closest('#qrPlayer')) createPair('player');
    if (e.target.closest('#karaokeBtn, [data-action="karaoke"]')) {
      e.preventDefault();
      karaokeCurrent();
    }
  });
}

async function getPublicBase() {
  try {
    const j = await fetch('/api/public-url').then((r) => r.json());
    if (j && j.baseUrl) return String(j.baseUrl).replace(/\/$/, '');
  } catch (_) {}
  return location.origin;
}

async function createPair(role) {
  try {
    const sid = await ensureSession();
    const pair = await fetch('/api/remote/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, role }),
    }).then((r) => r.json());
    const base = await getPublicBase();
    const path = pair.path || ('/remote?s=' + sid + '&t=' + pair.token + '&r=' + role);
    const url = base + path;
    const box = document.getElementById('qrBox');
    const urlEl = document.getElementById('qrUrl');
    if (box) {
      // QR image via public chart API-free: use qrserver (http) or text fallback
      const qrImg = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(url);
      box.innerHTML =
        '<img src="' + qrImg + '" alt="QR" width="200" height="200" loading="lazy" />' +
        '<div style="margin-top:8px;font-size:11px;color:#111;word-break:break-all">' +
        '<strong>' + (role === 'player' ? 'PLAYER' : 'REMOTE') + '</strong><br>' +
        url.replace(/</g, '&lt;') + '</div>';
    }
    if (urlEl) urlEl.textContent = url + ' · expires ~15 min · same session';
    await publishLocalState();
  } catch (e) {
    alert('Pairing failed: ' + (e.message || e));
  }
}

function openQrModal() {
  const m = document.getElementById('qrModal');
  if (m) m.hidden = false;
  createPair('remote');
}

async function karaokeCurrent() {
  const { getPlayerState, playVideo } = await import('./player.js');
  const p = getPlayerState();
  const q = p.active?.title || 'karaoke';
  try {
    const data = await fetch('/api/music/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'karaoke ' + q }),
    }).then((r) => r.json());
    if (data.items?.[0]) playVideo(data.items[0], data.items);
  } catch (_) {}
}
