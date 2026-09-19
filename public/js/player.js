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
  return { ...state, queue: [...state.queue] };
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

export function initPlayer() {
  ensureIframeApi();
  restoreQueue();
  bindSeekInteractions();
}
