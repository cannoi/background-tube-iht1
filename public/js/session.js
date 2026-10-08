/**
 * Multi-device playback session client (SSE + command API).
 * Near-synchronized: same track/queue/play state across windows/devices.
 */
import {
  getPlayerState, playVideo, togglePlayPause, next, previous,
  setQueue, seekTo, toggleShuffle, cycleRepeat, addToQueue
} from './player.js';

const CLIENT_ID = (() => {
  try {
    let id = localStorage.getItem('bt_client_id');
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
      localStorage.setItem('bt_client_id', id);
    }
    return id;
  } catch {
    return String(Date.now());
  }
})();

let sessionId = null;
let token = null;
let role = 'player';
let es = null;
let applyingRemote = false;
let lastVersion = 0;
let heartbeatTimer = null;
let onStateCb = null;

export function getSessionInfo() {
  return { sessionId, token, role, clientId: CLIENT_ID };
}

export function onSessionState(fn) {
  onStateCb = fn;
}

async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'session_error');
  return data;
}

export async function ensureSession() {
  if (sessionId) return sessionId;
  try {
    const saved = localStorage.getItem('bt_session_id');
    if (saved) {
      try {
        await api('/api/session/' + encodeURIComponent(saved) + '/join', 'POST', { clientId: CLIENT_ID });
        sessionId = saved;
        connectEvents();
        startHeartbeat();
        return sessionId;
      } catch (_) {
        localStorage.removeItem('bt_session_id');
      }
    }
  } catch (_) {}
  const out = await api('/api/session', 'POST', { leaderId: CLIENT_ID });
  sessionId = out.state.sessionId;
  lastVersion = out.state.version || 1;
  try { localStorage.setItem('bt_session_id', sessionId); } catch (_) {}
  connectEvents();
  startHeartbeat();
  return sessionId;
}

export async function joinSession(sid, tok, r) {
  sessionId = sid;
  token = tok || null;
  role = r || 'remote';
  await api('/api/session/' + encodeURIComponent(sid) + '/join', 'POST', { clientId: CLIENT_ID, token });
  try { localStorage.setItem('bt_session_id', sessionId); } catch (_) {}
  connectEvents();
  startHeartbeat();
  return sessionId;
}

function connectEvents() {
  if (!sessionId || typeof EventSource === 'undefined') return;
  if (es) {
    try { es.close(); } catch (_) {}
  }
  let url = '/api/session/' + encodeURIComponent(sessionId) + '/events?clientId=' + encodeURIComponent(CLIENT_ID);
  if (token) url += '&token=' + encodeURIComponent(token);
  es = new EventSource(url);
  es.addEventListener('sync.state', (ev) => {
    try {
      const state = JSON.parse(ev.data);
      applyRemoteState(state);
    } catch (_) {}
  });
  es.onerror = () => {
    // browser will retry EventSource automatically in most cases
  };
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!sessionId) return;
    const p = getPlayerState();
    pushCommand({
      type: 'heartbeat',
      position: p.currentTime || 0,
      playing: !!p.playing,
      baseVersion: lastVersion,
    }).catch(() => {});
  }, 12000);
}

export async function pushCommand(cmd) {
  if (!sessionId) return null;
  const body = { ...cmd, clientId: CLIENT_ID, token: token || undefined };
  const out = await api('/api/session/' + encodeURIComponent(sessionId) + '/command', 'POST', body);
  if (out.state) {
    lastVersion = out.state.version || lastVersion;
    if (onStateCb) onStateCb(out.state);
  }
  return out;
}

/** Push full local player snapshot as authoritative load */
export async function publishLocalState() {
  if (!sessionId || applyingRemote) return;
  const p = getPlayerState();
  await pushCommand({
    type: 'load',
    track: p.active,
    queue: p.queue || [],
    index: p.index || 0,
    position: p.currentTime || 0,
    playing: !!p.playing,
    shuffle: !!p.shuffle,
    repeat: p.repeat || 'off',
    baseVersion: lastVersion,
  });
}

function applyRemoteState(state) {
  if (!state || state.sessionId !== sessionId) return;
  if (state.version != null && state.version < lastVersion) return;
  lastVersion = state.version || lastVersion;
  if (onStateCb) onStateCb(state);

  applyingRemote = true;
  try {
    const p = getPlayerState();
    const remoteId = state.track && state.track.videoId;
    const localId = p.active && p.active.videoId;

    if (Array.isArray(state.queue) && state.queue.length) {
      const sameQueue =
        p.queue.length === state.queue.length &&
        p.queue.every((t, i) => t.videoId === (state.queue[i] && state.queue[i].videoId));
      if (!sameQueue) {
        setQueue(state.queue, state.index || 0, false);
      }
    }

    if (remoteId && remoteId !== localId) {
      playVideo(state.track, state.queue && state.queue.length ? state.queue : [state.track]);
    }

    // Play/pause sync
    if (state.playing && !p.playing) {
      try { togglePlayPause(); } catch (_) {}
    } else if (!state.playing && p.playing) {
      try { togglePlayPause(); } catch (_) {}
    }

    // Seek if drift > 2.5s
    if (state.position != null && Math.abs((p.currentTime || 0) - state.position) > 2.5) {
      try { seekTo(state.position); } catch (_) {}
    }
  } finally {
    setTimeout(() => { applyingRemote = false; }, 400);
  }
}

/** Call after local user play/pause/next so peers update */
export function notifyLocalAction(type, extra = {}) {
  if (!sessionId || applyingRemote) return;
  pushCommand({ type, ...extra, baseVersion: lastVersion }).catch(() => {});
}

// Auto-join from URL ?s=&t=&r=
export function tryAutoJoinFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const s = params.get('s');
    const t = params.get('t');
    const r = params.get('r') || 'remote';
    if (s) {
      return joinSession(s, t, r);
    }
  } catch (_) {}
  return Promise.resolve(null);
}

export { CLIENT_ID };
