import { initTheme } from './theme.js';
import { initPlayer, onPlayerChange, getPlayerState } from './player.js';
import { initUi, render, renderMini, openPlayer, view } from './ui.js';

initTheme();
initPlayer();
initUi();

onPlayerChange(() => {
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
