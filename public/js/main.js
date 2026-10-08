import { initTheme } from './theme.js';
import { initPlayer, onPlayerChange, getPlayerState, playVideo, togglePlayPause, next, previous, cycleRepeat, toggleShuffle } from './player.js';
import { initUi, render, renderMini, openPlayer, view, toast } from './ui.js';
import { initVoiceSearch } from './voice.js';
import { initRemoteUI } from './remote.js';

initTheme();
initPlayer();
initUi();
initVoiceSearch();
initRemoteUI();

// Expose live player state for Universal AI panel (gameContext)
function syncPlayerGlobal() {
  try { window.__btPlayerState = getPlayerState(); } catch (_) {}
}
syncPlayerGlobal();
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
});

// AI panel music actions (from public/ai-panel.js)
window.addEventListener('bt-ai-action', (ev) => {
  const d = ev.detail || {};
  const name = d.name;
  try {
    if (name === 'next') next();
    else if (name === 'previous') previous();
    else if (name === 'toggle') togglePlayPause();
    else if (name === 'pause') { if (getPlayerState().playing) togglePlayPause(); }
    else if (name === 'play') { if (!getPlayerState().playing) togglePlayPause(); }
    else if (name === 'shuffle') toggleShuffle();
    else if (name === 'repeat') cycleRepeat();
    else if ((name === 'queue_add' || name === 'play_next') && d.items && d.items[0]) {
      playVideo(d.items[0], d.items);
      try { toast('AI: ' + d.items.length + ' track(s)'); } catch (_) {}
    }
  } catch (e) {
    console.warn('bt-ai-action', e);
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
