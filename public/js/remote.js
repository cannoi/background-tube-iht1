let sessionId = null;

export function initRemoteUI() {
  document.addEventListener('click', async (e) => {
    if (e.target.closest('#qrBtn, [data-action="qr"]')) {
      e.preventDefault();
      openQrModal();
    }
    if (e.target.closest('#qrClose')) {
      document.getElementById('qrModal').hidden = true;
    }
    if (e.target.closest('#qrRemote')) createPair('remote');
    if (e.target.closest('#qrPlayer')) createPair('player');
    if (e.target.closest('#karaokeBtn, [data-action="karaoke"]')) {
      e.preventDefault();
      karaokeCurrent();
    }
  });

  // Auto-join from URL
  const params = new URLSearchParams(location.search);
  if (params.get('s') && params.get('t')) {
    sessionId = params.get('s');
    // lightweight remote page behavior could be expanded
  }
}

async function createPair(role) {
  try {
    if (!sessionId) {
      const s = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
      sessionId = s.state?.sessionId;
    }
    const pair = await fetch('/api/remote/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, role }),
    }).then((r) => r.json());
    const url = location.origin + (pair.path || '');
    const box = document.getElementById('qrBox');
    const urlEl = document.getElementById('qrUrl');
    if (box) box.textContent = url;
    if (urlEl) urlEl.textContent = url + ' (expires)';
  } catch (e) {
    alert('Pairing failed');
  }
}

function openQrModal() {
  const m = document.getElementById('qrModal');
  if (m) m.hidden = false;
  createPair('remote');
}

async function karaokeCurrent() {
  const { getPlayerState } = await import('./player.js');
  const p = getPlayerState();
  const q = p.active?.title || 'karaoke';
  try {
    const data = await fetch('/api/music/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'karaoke ' + q }),
    }).then((r) => r.json());
    if (data.items?.[0]) {
      const { playVideo } = await import('./player.js');
      playVideo(data.items[0], data.items);
    }
  } catch (_) {}
}
