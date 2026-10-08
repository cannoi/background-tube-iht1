import { initTheme } from './theme.js';
import {
  initPlayer, onPlayerChange, getPlayerState, playVideo, togglePlayPause,
  next, previous, cycleRepeat, toggleShuffle, addToQueue, seekTo
} from './player.js';
import { initUi, render, renderMini, openPlayer, view, toast } from './ui.js';
import { initVoiceSearch } from './voice.js';
import { initRemoteUI } from './remote.js';
import { ensureSession, notifyLocalAction, publishLocalState, tryAutoJoinFromUrl } from './session.js';

initTheme();
initPlayer();
initUi();
initVoiceSearch();
initRemoteUI();

function syncPlayerGlobal() {
  try { window.__btPlayerState = getPlayerState(); } catch (_) {}
}
syncPlayerGlobal();

let lastNotify = 0;
onPlayerChange(() => {
  syncPlayerGlobal();
  renderMini();
  const overlay = document.getElementById('playerOverlay');
  if (view.playerOpen && overlay && overlay.classList.contains('open')) {
    const title = document.getElementById('playerTitle');
    const channel = document.getElementById('playerChannel');
    const toggle = document.querySelector('[data-action="toggle"].main');
    const p = getPlayerState();
    if (title && p.active) title.textContent = p.active.title;
    if (channel && p.active) channel.textContent = p.active.channelTitle;
    if (toggle) toggle.innerHTML = `<i class="fa-solid ${p.playing ? 'fa-pause' : 'fa-play'}"></i>`;
    const err = document.getElementById('playerError');
    if (err) {
      err.hidden = !p.error;
      if (p.error) err.textContent = p.error.message;
    }
  }
  // Throttle session publish for multi-window
  const now = Date.now();
  if (now - lastNotify > 1500) {
    lastNotify = now;
    publishLocalState().catch(() => {});
  }
});

window.addEventListener('bt-ai-action', (ev) => {
  const d = ev.detail || {};
  const name = d.name;
  try {
    if (name === 'next') { next(); notifyLocalAction('next'); }
    else if (name === 'previous') { previous(); notifyLocalAction('previous'); }
    else if (name === 'toggle') { togglePlayPause(); notifyLocalAction('toggle'); }
    else if (name === 'pause') {
      if (getPlayerState().playing) togglePlayPause();
      notifyLocalAction('pause');
    }
    else if (name === 'play') {
      if (!getPlayerState().playing) togglePlayPause();
      notifyLocalAction('play');
    }
    else if (name === 'shuffle') { toggleShuffle(); notifyLocalAction('shuffle'); }
    else if (name === 'repeat') { cycleRepeat(); notifyLocalAction('repeat'); }
    else if (name === 'seek' && d.args) { seekTo(d.args.seconds || d.args.position); notifyLocalAction('seek', { position: d.args.seconds }); }
    else if ((name === 'queue_add' || name === 'play_next') && d.items && d.items[0]) {
      if (name === 'play_next') addToQueue(d.items, { playNext: true });
      playVideo(d.items[0], d.items);
      try { toast('AI: ' + d.items.length + ' track(s)'); } catch (_) {}
      publishLocalState().catch(() => {});
    }
  } catch (e) {
    console.warn('bt-ai-action', e);
  }
});

// Optional: create session early so QR is fast
tryAutoJoinFromUrl().then((sid) => {
  if (!sid) ensureSession().catch(() => {});
}).catch(() => ensureSession().catch(() => {}));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
