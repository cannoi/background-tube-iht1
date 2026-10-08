import { initTheme } from './theme.js';
import {
  initPlayer, onPlayerChange, getPlayerState, playVideo, togglePlayPause,
  next, previous, cycleRepeat, toggleShuffle, addToQueue, seekTo,
  stopPlayback, pause, play, clearQueue, setSleepTimer, clearSleepTimer,
  setVolume, mute, appendToQueue, insertAndPlay, playIndex, isMusicBusy, removeFromQueue
} from './player.js';
import {
  getPlaylists, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist,
  isFavorite, toggleFavorite
} from './library.js';
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

/* ——— AI music control surface ——— */
function aiLang(args) {
  return args && args.lang === 'vi' ? 'vi' : 'en';
}
function t(lang, vi, en) { return lang === 'vi' ? vi : en; }
function norm(x) {
  return String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
}
function findPlaylist(name) {
  const n = norm(name);
  if (!n) return null;
  const all = getPlaylists();
  return all.find((p) => norm(p.name) === n) || all.find((p) => norm(p.name).includes(n)) || all.find((p) => n.includes(norm(p.name)) && norm(p.name).length > 2) || null;
}
function refreshUi() {
  try { render(); } catch (_) {}
}
function cleanItems(items) {
  return (Array.isArray(items) ? items : []).filter((i) => i && i.videoId);
}

/** Read-only snapshot used by the AI panel (idle/busy decision, context for the model). */
window.btAI = {
  isBusy: () => { try { return isMusicBusy(); } catch (_) { return false; } },
  snapshot() {
    const p = getPlayerState();
    return {
      busy: isMusicBusy(),
      queue: (p.queue || []).slice(0, 15).map((q) => q.title),
      queueLength: (p.queue || []).length,
      playlists: getPlaylists().map((pl) => ({ name: pl.name, count: pl.items.length })),
      favorite: p.active ? isFavorite(p.active.videoId) : false
    };
  },
  run: (name, args, items) => runAiAction(name, args || {}, items),
};

/**
 * Executes one AI action. Returns { ok, message? } so the AI panel can report the REAL outcome.
 * Pre-existing cases keep their original behaviour.
 */
function runAiAction(name, args, itemsArg) {
  const lang = aiLang(args);
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
      case 'now_playing': {
        const p = getPlayerState();
        return { ok: true, message: p.active
          ? t(lang, 'Đang phát: ', 'Now playing: ') + p.active.title + (p.active.channelTitle ? ' · ' + p.active.channelTitle : '') + (p.playing ? '' : t(lang, ' (tạm dừng)', ' (paused)'))
          : t(lang, 'Chưa phát bài nào.', 'Nothing is playing.') };
      }
      case 'queue_status': {
        const p = getPlayerState();
        const n = (p.queue || []).length;
        const lines = (p.queue || []).slice(0, 10).map((q, i) => (i === p.index ? '▶ ' : (i + 1) + '. ') + q.title);
        return { ok: true, message: t(lang, 'Danh sách phát hiện có ', 'Queue has ') + n + t(lang, ' bài.', ' track(s).') + (lines.length ? '\n' + lines.join('\n') : '') };
      }
      // —— Play / queue with explicit mode (used by the AI panel choice card) ——
      case 'play_items': {            // idle player: replace queue and start immediately
        const items = cleanItems(itemsArg || args.items);
        if (!items.length) break;
        playVideo(items[0], items);
        try { toast('▶ ' + (items[0].title || items.length + ' tracks')); } catch (_) {}
        publishLocalState().catch(() => {});
        return { ok: true, message: t(lang, 'Đang phát: ', 'Playing: ') + items[0].title };
      }
      case 'play_now': {              // busy player: play now, keep the rest of the queue
        const items = cleanItems(itemsArg || args.items);
        if (!items.length) break;
        insertAndPlay(items);
        try { toast('▶ ' + (items[0].title || items.length + ' tracks')); } catch (_) {}
        publishLocalState().catch(() => {});
        return { ok: true, message: t(lang, 'Đang phát: ', 'Playing: ') + items[0].title };
      }
      case 'queue_append': {          // add after the LAST track
        const items = cleanItems(itemsArg || args.items);
        if (!items.length) break;
        const added = appendToQueue(items);
        try { toast(t(lang, 'Đã thêm ' + added + ' bài vào cuối danh sách phát', 'Added ' + added + ' to end of queue')); } catch (_) {}
        publishLocalState().catch(() => {});
        return { ok: true, added, message: t(lang, 'Đã thêm ' + added + ' bài vào cuối danh sách phát.', 'Added ' + added + ' track(s) to the end of the queue.') };
      }
      case 'queue_add':
      case 'play_next': {
        const items = itemsArg || args.items || [];
        if (!items.length) break;
        // autoPlay default true (DJ) unless explicitly false
        const autoPlay = !(args.autoPlay === false);
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
      case 'play_index': {
        const n = Number(args.index != null ? args.index : args.value);
        const ok = playIndex(n - 1);          // user-facing numbers are 1-based
        return { ok, message: ok ? t(lang, 'Đang phát bài số ' + n, 'Playing track #' + n) : t(lang, 'Không có bài số ' + n + ' trong danh sách phát.', 'There is no track #' + n + ' in the queue.') };
      }
      case 'queue_remove': {
        const n = Number(args.index != null ? args.index : args.value);
        const p = getPlayerState();
        if (!(n >= 1 && n <= p.queue.length)) return { ok: false, message: t(lang, 'Không có bài số ' + n + ' trong danh sách phát.', 'There is no track #' + n + ' in the queue.') };
        const title = p.queue[n - 1].title;
        removeFromQueue(n - 1);
        publishLocalState().catch(() => {});
        return { ok: true, message: t(lang, 'Đã xóa khỏi danh sách phát: ', 'Removed from queue: ') + title };
      }
      case 'favorite': {
        const p = getPlayerState();
        const v = p.active;
        if (!v) return { ok: false, message: t(lang, 'Chưa có bài nào đang phát.', 'No track is loaded.') };
        const on = toggleFavorite(v);
        refreshUi();
        return { ok: true, message: on ? t(lang, '❤ Đã thêm vào yêu thích: ', '❤ Added to favorites: ') + v.title : t(lang, 'Đã bỏ khỏi yêu thích: ', 'Removed from favorites: ') + v.title };
      }
      // —— Playlists ——
      case 'playlist_create': {
        const nm = String(args.name || '').trim();
        if (!nm) return { ok: false, message: t(lang, 'Cần có tên playlist.', 'A playlist name is required.') };
        let items = cleanItems(itemsArg || args.items);
        if (args.fromQueue) items = cleanItems(getPlayerState().queue);
        else if (args.current && getPlayerState().active) items = [getPlayerState().active].concat(items);
        const existing = findPlaylist(nm);
        const exact = existing && norm(existing.name) === norm(nm);
        const pl = exact ? existing : createPlaylist(nm);
        let added = 0;
        items.forEach((it) => { if (addToPlaylist(pl.id, it)) added += 1; });
        refreshUi();
        try { toast(t(lang, 'Playlist "' + pl.name + '" · +' + added, 'Playlist "' + pl.name + '" · +' + added)); } catch (_) {}
        if (args.play && items[0]) { playVideo(items[0], getPlaylists().find((x) => x.id === pl.id).items); }
        return { ok: true, id: pl.id, added, message: (exact ? t(lang, 'Playlist đã có sẵn, ', 'Playlist already existed, ') : t(lang, 'Đã tạo playlist ', 'Created playlist ')) + '"' + pl.name + '"' + t(lang, ' với ', ' with ') + added + t(lang, ' bài.', ' track(s).') };
      }
      case 'playlist_add': {
        const nm = String(args.name || '').trim();
        let pl = findPlaylist(nm);
        let created = false;
        if (!pl && nm) { pl = createPlaylist(nm); created = true; }
        if (!pl) return { ok: false, message: t(lang, 'Không tìm thấy playlist.', 'Playlist not found.') };
        let items = cleanItems(itemsArg || args.items);
        if (!items.length && getPlayerState().active) items = [getPlayerState().active];
        if (!items.length) return { ok: false, message: t(lang, 'Không có bài nào để thêm.', 'Nothing to add.') };
        let added = 0;
        items.forEach((it) => { if (addToPlaylist(pl.id, it)) added += 1; });
        refreshUi();
        return { ok: true, added, message: (created ? t(lang, 'Đã tạo playlist "' + pl.name + '" và thêm ', 'Created "' + pl.name + '" and added ') : t(lang, 'Đã thêm ', 'Added ')) + added + t(lang, ' bài vào "' + pl.name + '".', ' track(s) to "' + pl.name + '".') };
      }
      case 'playlist_play': {
        const pl = findPlaylist(args.name);
        if (!pl) return { ok: false, message: t(lang, 'Không tìm thấy playlist "' + (args.name || '') + '".', 'Playlist "' + (args.name || '') + '" not found.') };
        if (!pl.items.length) return { ok: false, message: t(lang, 'Playlist "' + pl.name + '" đang trống.', 'Playlist "' + pl.name + '" is empty.') };
        playVideo(pl.items[0], pl.items);
        publishLocalState().catch(() => {});
        return { ok: true, message: t(lang, 'Đang phát playlist "' + pl.name + '" (' + pl.items.length + ' bài).', 'Playing playlist "' + pl.name + '" (' + pl.items.length + ' tracks).') };
      }
      case 'playlist_queue': {        // append a whole playlist to the end of the queue
        const pl = findPlaylist(args.name);
        if (!pl) return { ok: false, message: t(lang, 'Không tìm thấy playlist "' + (args.name || '') + '".', 'Playlist "' + (args.name || '') + '" not found.') };
        const added = appendToQueue(pl.items);
        publishLocalState().catch(() => {});
        return { ok: true, added, message: t(lang, 'Đã thêm ' + added + ' bài của "' + pl.name + '" vào cuối danh sách phát.', 'Added ' + added + ' track(s) of "' + pl.name + '" to the end of the queue.') };
      }
      case 'playlist_rename': {
        const pl = findPlaylist(args.name);
        const to = String(args.newName || '').trim();
        if (!pl || !to) return { ok: false, message: t(lang, 'Không đổi tên được (thiếu playlist hoặc tên mới).', 'Cannot rename (missing playlist or new name).') };
        renamePlaylist(pl.id, to);
        refreshUi();
        return { ok: true, message: t(lang, 'Đã đổi tên thành "' + to + '".', 'Renamed to "' + to + '".') };
      }
      case 'playlist_delete': {
        const pl = findPlaylist(args.name);
        if (!pl) return { ok: false, message: t(lang, 'Không tìm thấy playlist "' + (args.name || '') + '".', 'Playlist "' + (args.name || '') + '" not found.') };
        // Destructive → host confirmation (same pattern as the Library screen)
        if (!confirm(t(lang, 'Xóa playlist "' + pl.name + '"?', 'Delete playlist "' + pl.name + '"?'))) {
          return { ok: false, cancelled: true, message: t(lang, 'Đã hủy, playlist được giữ nguyên.', 'Cancelled, playlist kept.') };
        }
        deletePlaylist(pl.id);
        refreshUi();
        return { ok: true, message: t(lang, 'Đã xóa playlist "' + pl.name + '".', 'Deleted playlist "' + pl.name + '".') };
      }
      case 'playlist_list': {
        const all = getPlaylists();
        if (!all.length) return { ok: true, message: t(lang, 'Chưa có playlist nào.', 'No playlists yet.') };
        return { ok: true, message: t(lang, 'Playlist của bạn:\n', 'Your playlists:\n') + all.map((pl) => '• ' + pl.name + ' (' + pl.items.length + ')').join('\n') };
      }
      default:
        break;
    }
  } catch (e) {
    console.warn('bt-ai-action', e);
    return { ok: false, message: String(e && e.message || e) };
  }
  return { ok: true };
}

window.addEventListener('bt-ai-action', (ev) => {
  const d = ev.detail || {};
  let args = d.args || {};
  if (d.autoPlay === false && args.autoPlay === undefined) args = { ...args, autoPlay: false };
  const out = runAiAction(d.name, args, d.items || args.items);
  // Optional callback so the sender can show the real result in chat.
  if (typeof d.done === 'function') { try { d.done(out); } catch (_) {} }
});

tryAutoJoinFromUrl().then((sid) => {
  if (sid) {
    console.info('[main] using room from QR/URL', sid);
    return sid;
  }
  return ensureSession();
}).then(() => publishLocalState().catch(() => {}))
  .catch(() => ensureSession().then(() => publishLocalState()).catch(() => {}));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
