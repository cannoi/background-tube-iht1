import { ensureSession, getSessionInfo, tryAutoJoinFromUrl, publishLocalState } from './session.js';

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

async function createPair(role) {
  try {
    const sid = await ensureSession();
    const pair = await fetch('/api/remote/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, role }),
    }).then((r) => r.json());
    const url = location.origin + (pair.path || '');
    const box = document.getElementById('qrBox');
    const urlEl = document.getElementById('qrUrl');
    if (box) {
      // Lightweight QR via external image API-free: show URL + copy-friendly text
      box.innerHTML = '<div style="padding:8px;font-size:11px;word-break:break-all;color:#111">' +
        '<strong>' + (role === 'player' ? 'PLAYER' : 'REMOTE') + '</strong><br>' +
        url.replace(/</g, '&lt;') + '</div>';
    }
    if (urlEl) urlEl.textContent = url + ' · expires ~15 min';
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
