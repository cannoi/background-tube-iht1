import { initTheme } from './theme.js';
import {
  initPlayer, onPlayerChange, getPlayerState, playVideo, togglePlayPause,
  next, previous, cycleRepeat, toggleShuffle, addToQueue, seekTo,
  stopPlayback, pause, play, clearQueue, setSleepTimer, clearSleepTimer,
  setVolume, mute
} from './player.js';
import { initUi, render, renderMini, openPlayer, view, toast } from './ui.js';
import { initVoiceSearch } from './voice.js';
import { initRemoteUI } from './remote.js';
import { ensureSession, notifyLocalAction, publishLocalState, tryAutoJoinFromUrl, onLocalTrackMaybeChanged } from './session.js';

initTheme();
initPlayer();
initUi();
initVoiceSearch();
initRemoteUI();

function syncPlayerGlobal() {
  try {
    const p = getPlayerState();
    window.__btPlayerState = p;
  } catch (_) {}
}
syncPlayerGlobal();

let lastNotify = 0;
let lastPublishedTrack = null;
let lastPublishedPlaying = null;
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
  // Immediate sync when track or play/pause changes
  try {
    const p = getPlayerState();
    const tid = p.active && p.active.videoId;
    if (tid !== lastPublishedTrack || p.playing !== lastPublishedPlaying) {
      lastPublishedTrack = tid;
      lastPublishedPlaying = p.playing;
      lastNotify = Date.now();
      onLocalTrackMaybeChanged();
      publishLocalState().catch(() => {});
      return;
    }
  } catch (_) {}
  const now = Date.now();
  if (now - lastNotify > 5000) {
    lastNotify = now;
    publishLocalState().catch(() => {});
  }
});

/** Full AI music control surface */
window.addEventListener('bt-ai-action', (ev) => {
  const d = ev.detail || {};
  const name = d.name;
  const args = d.args || {};
  try {
    switch (name) {
      case 'next':
        next(); notifyLocalAction('next'); break;
      case 'previous':
        previous(); notifyLocalAction('previous'); break;
      case 'toggle':
        togglePlayPause(); notifyLocalAction('toggle'); break;
      case 'pause':
        pause(); notifyLocalAction('pause'); break;
      case 'play':
        play(); notifyLocalAction('play'); break;
      case 'stop':
        stopPlayback(); notifyLocalAction('pause'); break;
      case 'shuffle':
        toggleShuffle(); notifyLocalAction('shuffle'); break;
      case 'repeat':
        cycleRepeat(); notifyLocalAction('repeat'); break;
      case 'seek':
        seekTo(args.seconds != null ? args.seconds : args.position);
        notifyLocalAction('seek', { position: args.seconds || args.position });
        break;
      case 'volume':
        setVolume(args.level != null ? args.level : args.value);
        try { toast('Volume ' + (args.level != null ? args.level : args.value)); } catch (_) {}
        break;
      case 'mute':
        mute(true); break;
      case 'unmute':
        mute(false); break;
      case 'sleep': {
        const mins = args.minutes != null ? args.minutes : args.value;
        if (!mins) {
          clearSleepTimer();
          try { toast('Sleep timer off'); } catch (_) {}
        } else {
          setSleepTimer(mins);
          try { toast('Sleep ' + mins + ' min'); } catch (_) {}
        }
        break;
      }
      case 'queue_clear':
        clearQueue();
        publishLocalState().catch(() => {});
        try { toast('Queue cleared'); } catch (_) {}
        break;
      case 'now_playing':
      case 'queue_status':
        // reply already in chat; optional toast
        break;
      case 'queue_add':
      case 'play_next': {
        const items = d.items || args.items || [];
        if (!items.length) break;
        // autoPlay default true (DJ) unless explicitly false
        const autoPlay = !(args.autoPlay === false || d.autoPlay === false);
        if (name === 'play_next' || args.playNext) {
          addToQueue(items, { playNext: true });
          if (autoPlay) playVideo(items[0], getPlayerState().queue.concat(items));
        } else if (autoPlay) {
          playVideo(items[0], items);
        } else {
          addToQueue(items);
        }
        try { toast('▶ ' + (items[0].title || items.length + ' tracks')); } catch (_) {}
        publishLocalState().catch(() => {});
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.warn('bt-ai-action', e);
  }
});

tryAutoJoinFromUrl().then((sid) => {
  if (!sid) return ensureSession();
  return sid;
}).then(() => {
  // Push local state after join so room has something; peers receive via SSE
  return publishLocalState().catch(() => {});
}).catch(() => ensureSession().then(() => publishLocalState()).catch(() => {}));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
