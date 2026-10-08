import { formatSeconds } from './format.js';
import { getSettings, updateSettings } from './settings.js';
import { addToHistory, saveQueue, loadQueue } from './library.js';

const listeners = new Set();

const state = {
  ready: false,
  active: null,
  queue: [],
  index: -1,
  playing: false,
  currentTime: 0,
  duration: 0,
  shuffle: getSettings().shuffle,
  repeat: getSettings().repeat || 'off',
  error: null,
  lastAction: null
};

let ytPlayer = null;
let progressTimer = null;
let pendingVideoId = null;
let createAttempted = false;

function emit() {
  listeners.forEach((fn) => {
    try { fn(getPlayerState()); } catch (err) { console.warn(fn, err); }
  });
}

export function getPlayerState() {
  const sleep = (typeof getSleepTimer === 'function') ? getSleepTimer() : { active: false };
  return { ...state, queue: [...state.queue], sleep };
}

export function onPlayerChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setState(patch) {
  Object.assign(state, patch);
  emit();
}

window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  state.ready = true;
  if (pendingVideoId) createOrLoad(pendingVideoId);
};

function ensureIframeApi() {
  if (window.YT && window.YT.Player) {
    state.ready = true;
    return;
  }
  if (document.getElementById('yt-iframe-api')) return;
  const script = document.createElement('script');
  script.id = 'yt-iframe-api';
  script.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(script);
}

function createOrLoad(videoId) {
  if (!window.YT || !window.YT.Player) {
    pendingVideoId = videoId;
    ensureIframeApi();
    return;
  }

  const host = document.getElementById('yt-player-host');
  if (!host) {
    pendingVideoId = videoId;
    return;
  }

  if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
    ytPlayer.loadVideoById({ videoId, startSeconds: 0 });
    return;
  }

  if (createAttempted && !ytPlayer) return;
  createAttempted = true;

  ytPlayer = new window.YT.Player('yt-player-host', {
    width: '100%',
    height: '100%',
    videoId,
    host: 'https://www.youtube.com',
    playerVars: {
      autoplay: 1,
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      origin: window.location.origin,
      enablejsapi: 1,
      fs: 1
    },
    events: {
      onReady: () => {
        if (pendingVideoId && pendingVideoId !== videoId) {
          ytPlayer.loadVideoById(pendingVideoId);
        }
        startProgress();
      },
      onStateChange: onYtState,
      onError: onYtError
    }
  });
}

function onYtState(event) {
  const YT = window.YT;
  if (!YT) return;
  if (event.data === YT.PlayerState.PLAYING) {
    setState({ playing: true, error: null });
    startProgress();
    updateMediaSession();
  } else if (event.data === YT.PlayerState.PAUSED) {
    setState({ playing: false });
    updateMediaSession();
  } else if (event.data === YT.PlayerState.ENDED) {
    setState({ playing: false });
    handleEnded();
  } else if (event.data === YT.PlayerState.BUFFERING) {
    setState({ playing: true });
  }
}

function onYtError(event) {
  const messages = {
    2: 'This video request is invalid.',
    5: 'HTML5 playback is unavailable for this video.',
    100: 'This video is unavailable or was removed.',
    101: 'The owner disabled embedded playback.',
    150: 'The owner disabled embedded playback.'
  };
  const message = messages[event.data] || 'Playback is unavailable for this video.';
  setState({ playing: false, error: { code: 'playback_unavailable', message } });
  if (getSettings().autoplay) {
    setTimeout(() => next(true), 600);
  }
}

function handleEnded() {
  if (state.repeat === 'one' && state.active) {
    playAt(state.index, true);
    return;
  }
  if (getSettings().autoplay || state.repeat === 'all') {
    next(false);
  }
}

function startProgress() {
  stopProgress();
  progressTimer = setInterval(() => {
    if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
    const currentTime = ytPlayer.getCurrentTime() || 0;
    const duration = ytPlayer.getDuration() || state.duration || 0;
    state.currentTime = currentTime;
    state.duration = duration;
    updateSeekUi();
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: 1,
          position: Math.min(currentTime, duration)
        });
      } catch (_) {
        /* some browsers throw if values are inconsistent */
      }
    }
  }, 400);
}

function stopProgress() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function updateSeekUi() {
  const fill = document.getElementById('seekFill');
  const current = document.getElementById('seekCurrentLabel');
  const duration = document.getElementById('seekDurationLabel');
  const miniFill = document.getElementById('miniSeekFill');
  const ratio = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;
  if (fill) fill.style.width = `${ratio}%`;
  if (miniFill) miniFill.style.width = `${ratio}%`;
  if (current) current.textContent = formatSeconds(state.currentTime);
  if (duration) duration.textContent = formatSeconds(state.duration);
}

export function setQueue(items, startIndex = 0, play = true) {
  const queue = (items || []).filter((item) => item && item.videoId);
  state.queue = queue;
  saveQueue(queue, startIndex);
  if (play && queue[startIndex]) playAt(startIndex, true);
  else setState({ index: startIndex });
}

export function playVideo(video, queue = null) {
  if (!video || !video.videoId) return;
  if (queue) {
    setQueue(queue, Math.max(0, queue.findIndex((item) => item.videoId === video.videoId)), false);
  } else if (!state.queue.some((item) => item.videoId === video.videoId)) {
    state.queue = [...state.queue, video];
  }
  const index = state.queue.findIndex((item) => item.videoId === video.videoId);
  playAt(index === -1 ? state.queue.length - 1 : index, true);
}

function playAt(index, force) {
  if (index < 0 || index >= state.queue.length) {
    if (state.repeat === 'all' && state.queue.length) return playAt(0, true);
    setState({ playing: false });
    return;
  }
  const video = state.queue[index];
  state.index = index;
  state.active = video;
  state.error = null;
  state.currentTime = 0;
  addToHistory(video);
  saveQueue(state.queue, index);
  pendingVideoId = video.videoId;
  createOrLoad(video.videoId);
  setState({ active: video, index, playing: true });
  updateMediaSession();
  if (force && ytPlayer && typeof ytPlayer.playVideo === 'function') {
    try { ytPlayer.playVideo(); } catch (_) { /* autoplay policies */ }
  }
}

export function togglePlayPause() {
  if (!state.active) return;
  if (!ytPlayer) {
    createOrLoad(state.active.videoId);
    return;
  }
  if (state.playing) ytPlayer.pauseVideo();
  else ytPlayer.playVideo();
}

export function pause() {
  if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') ytPlayer.pauseVideo();
}

export function play() {
  if (ytPlayer && typeof ytPlayer.playVideo === 'function') ytPlayer.playVideo();
}

export function next(fromError = false) {
  if (!state.queue.length) return;
  if (state.shuffle) {
    if (state.queue.length === 1) return playAt(0, true);
    let nextIndex = state.index;
    while (nextIndex === state.index) nextIndex = Math.floor(Math.random() * state.queue.length);
    playAt(nextIndex, true);
    return;
  }
  playAt(state.index + 1, true);
  if (fromError) state.lastAction = 'skip-error';
}

export function previous() {
  if (state.currentTime > 3) {
    seekToRatio(0);
    return;
  }
  playAt(Math.max(0, state.index - 1), true);
}

export function seekToRatio(ratio) {
  if (!ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
  const duration = ytPlayer.getDuration() || state.duration || 0;
  if (duration <= 0) return;
  const nextTime = Math.max(0, Math.min(1, ratio)) * duration;
  ytPlayer.seekTo(nextTime, true);
  state.currentTime = nextTime;
  updateSeekUi();
}

export function stopPlayback() {
  if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
  stopProgress();
  setState({ playing: false, active: null, currentTime: 0 });
}

export function toggleShuffle() {
  state.shuffle = !state.shuffle;
  updateSettings({ shuffle: state.shuffle });
  setState({ shuffle: state.shuffle });
}

export function cycleRepeat() {
  const order = ['off', 'all', 'one'];
  const nextMode = order[(order.indexOf(state.repeat) + 1) % order.length];
  state.repeat = nextMode;
  updateSettings({ repeat: nextMode });
  setState({ repeat: nextMode });
}

export function restoreQueue() {
  const saved = loadQueue();
  if (saved.items.length) {
    state.queue = saved.items;
    state.index = Math.min(saved.index, saved.items.length - 1);
    state.active = saved.items[state.index] || null;
    setState({ queue: state.queue, index: state.index, active: state.active, playing: false });
  }
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !state.active) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.active.title || 'Background Tube',
      artist: state.active.channelTitle || 'YouTube',
      album: 'Background ❤️ Tube',
      artwork: state.active.thumbnail ? [{ src: state.active.thumbnail, sizes: '320x180', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play', () => play());
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => previous());
    navigator.mediaSession.setActionHandler('nexttrack', () => next());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (!details || details.seekTime == null || !state.duration) return;
      seekToRatio(details.seekTime / state.duration);
    });
  } catch (err) {
    console.warn('Media Session unavailable', err);
  }
}

export function bindSeekInteractions() {
  document.addEventListener('click', (event) => {
    const track = event.target.closest('[data-seek-track]');
    if (!track) return;
    const rect = track.getBoundingClientRect();
    seekToRatio((event.clientX - rect.left) / rect.width);
  });
}


export function addToQueue(items, { playNext = false } = {}) {
  const list = (Array.isArray(items) ? items : [items]).filter((i) => i && i.videoId);
  if (!list.length) return;
  if (playNext && state.index >= 0) {
    state.queue.splice(state.index + 1, 0, ...list);
  } else {
    list.forEach((item) => {
      if (!state.queue.some((q) => q.videoId === item.videoId)) state.queue.push(item);
    });
  }
  if (state.queue.length > 100) {
    // Keep the playing index pointing at the same track after trimming the head.
    const drop = state.queue.length - 100;
    state.queue = state.queue.slice(drop);
    if (state.index >= 0) state.index = Math.max(0, state.index - drop);
  }
  saveQueue(state.queue, state.index);
  setState({ queue: state.queue, index: state.index });
}

/** Append tracks after the LAST track of the queue (no replace, no interrupt). Returns number added. */
export function appendToQueue(items) {
  const list = (Array.isArray(items) ? items : [items]).filter((i) => i && i.videoId);
  const before = state.queue.length;
  addToQueue(list);
  return Math.max(0, state.queue.length - before);
}

/**
 * Play tracks NOW without destroying the existing queue:
 * the new tracks are inserted right after the current one and the first starts immediately.
 */
export function insertAndPlay(items) {
  const list = (Array.isArray(items) ? items : [items]).filter((i) => i && i.videoId);
  if (!list.length) return false;
  const ids = new Set(list.map((i) => i.videoId));
  const current = state.active && state.index >= 0 ? state.queue[state.index] : null;
  // Drop older copies of the incoming tracks (except the one currently playing) to avoid duplicates.
  let kept = state.queue.filter((q, i) => !(ids.has(q.videoId) && !(current && i === state.index)));
  let at = current ? kept.findIndex((q) => q === current) : -1;
  const insertAt = at >= 0 ? at + 1 : kept.length;
  const fresh = list.filter((i) => !(current && i.videoId === current.videoId));
  kept.splice(insertAt, 0, ...fresh);
  state.queue = kept;
  const target = current && list[0].videoId === current.videoId ? at : insertAt;
  saveQueue(state.queue, target);
  playAt(Math.max(0, target), true);
  return true;
}

/** Jump to the N-th queue entry (0-based). */
export function playIndex(index) {
  const i = Number(index);
  if (Number.isNaN(i) || i < 0 || i >= state.queue.length) return false;
  playAt(i, true);
  return true;
}

/** True when music is really being listened to (playing, or paused mid-track). Idle after stop / end of queue. */
export function isMusicBusy() {
  if (!state.active) return false;
  if (state.playing) return true;
  const remaining = (state.duration || 0) - (state.currentTime || 0);
  return state.currentTime > 1 && !(state.duration > 0 && remaining < 2);
}

export function removeFromQueue(index) {
  const i = Number(index);
  if (Number.isNaN(i) || i < 0 || i >= state.queue.length) return;
  state.queue.splice(i, 1);
  if (state.index >= state.queue.length) state.index = state.queue.length - 1;
  if (state.index >= 0 && state.queue[state.index]) state.active = state.queue[state.index];
  else { state.active = null; state.index = -1; }
  saveQueue(state.queue, state.index);
  setState({ queue: state.queue, index: state.index, active: state.active });
}

export function clearQueue() {
  const keep = state.active ? [state.active] : [];
  state.queue = keep;
  state.index = keep.length ? 0 : -1;
  saveQueue(state.queue, state.index);
  setState({ queue: state.queue, index: state.index });
}

export function seekTo(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
    try { ytPlayer.seekTo(t, true); } catch (_) {}
  }
  state.currentTime = t;
  setState({ currentTime: t });
  updateSeekUi();
}


let sleepTimerId = null;
let sleepEndsAt = null;

export function setSleepTimer(minutes) {
  clearSleepTimer();
  const m = Math.max(0, Number(minutes) || 0);
  if (m <= 0) {
    setState({ lastAction: 'sleep_off' });
    return { ok: true, minutes: 0 };
  }
  sleepEndsAt = Date.now() + m * 60 * 1000;
  sleepTimerId = setTimeout(() => {
    sleepTimerId = null;
    sleepEndsAt = null;
    try { pause(); } catch (_) {}
    setState({ lastAction: 'sleep_fired', playing: false });
  }, m * 60 * 1000);
  setState({ lastAction: 'sleep_on' });
  return { ok: true, minutes: m, endsAt: sleepEndsAt };
}

export function clearSleepTimer() {
  if (sleepTimerId) clearTimeout(sleepTimerId);
  sleepTimerId = null;
  sleepEndsAt = null;
  return { ok: true };
}

export function getSleepTimer() {
  if (!sleepEndsAt) return { active: false, remainingMs: 0 };
  const remainingMs = Math.max(0, sleepEndsAt - Date.now());
  return { active: remainingMs > 0, remainingMs, endsAt: sleepEndsAt };
}

export function setVolume(level) {
  // 0–100; YouTube IFrame supports setVolume when available
  const v = Math.max(0, Math.min(100, Number(level)));
  if (Number.isNaN(v)) return { ok: false };
  if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
    try { ytPlayer.setVolume(v); } catch (_) {}
  }
  if (ytPlayer && typeof ytPlayer.isMuted === 'function' && v > 0) {
    try { if (ytPlayer.isMuted()) ytPlayer.unMute(); } catch (_) {}
  }
  setState({ lastAction: 'volume' });
  return { ok: true, volume: v };
}

export function mute(on) {
  if (!ytPlayer) return { ok: false };
  try {
    if (on === false || on === 'off' || on === 0) {
      if (typeof ytPlayer.unMute === 'function') ytPlayer.unMute();
    } else if (typeof ytPlayer.mute === 'function') {
      ytPlayer.mute();
    }
  } catch (_) {}
  return { ok: true };
}

export function initPlayer() {
  ensureIframeApi();
  restoreQueue();
  bindSeekInteractions();
}
