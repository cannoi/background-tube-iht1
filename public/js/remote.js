import {
  ensureSession, getSessionInfo, tryAutoJoinFromUrl, publishLocalState,
  joinSession, claimHostForced, getClientId
} from './session.js';

export function initRemoteUI() {
  tryAutoJoinFromUrl().then((sid) => {
    if (sid) console.info('[session] joined from URL', sid);
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
    await ensureSession();
    // QR creator becomes HOST
    await claimHostForced();
    const hostId = getClientId();
    const info = getSessionInfo();
    const sid = info.sessionId;
    const pair = await fetch('/api/remote/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, role, hostId, clientId: hostId }),
    }).then((r) => r.json());
    const base = await getPublicBase();
    const room = pair.sessionId || pair.roomCode || sid;
    const path = pair.path || (
      '/?s=' + encodeURIComponent(room) + '&sync=1&host=' + encodeURIComponent(hostId)
      + (pair.token ? '&t=' + encodeURIComponent(pair.token) + '&r=' + encodeURIComponent(role) : '')
    );
    const url = base + path;
    const box = document.getElementById('qrBox');
    const urlEl = document.getElementById('qrUrl');
    if (box) {
      const qrImg = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(url);
      box.innerHTML =
        '<img src="' + qrImg + '" alt="QR" width="200" height="200" loading="lazy" />' +
        '<div style="margin-top:8px;font-size:11px;color:#111;word-break:break-all">' +
        '<strong>HOST · ROOM ' + String(room).slice(0, 12) + '</strong><br>' +
        url.replace(/</g, '&lt;') + '</div>';
    }
    if (urlEl) urlEl.textContent = 'HOST ' + String(hostId).slice(0, 8) + ' · Room ' + room + ' · ' + url;
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
