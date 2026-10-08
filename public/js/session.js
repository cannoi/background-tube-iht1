/**
 * Multi-device playback session client (SSE + command API).
 * Default: all devices share one server room → same track.
 * Opt-out: localStorage bt_sync_enabled=0 → private session.
 */
import {
  getPlayerState, playVideo, togglePlayPause, next, previous,
  setQueue, seekTo, toggleShuffle, cycleRepeat, addToQueue, pause as pausePlayer
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
let reconnectTimer = null;
let onStateCb = null;
let serverOnline = true;
let lastTrackId = null;
let reconnectAttempts = 0;
let roomLeaderId = null;

export function isRoomHost() {
  return !!(roomLeaderId && roomLeaderId === CLIENT_ID);
}

function updateLeaderFromState(state) {
  if (state && state.leaderId) roomLeaderId = state.leaderId;
}


export function getSessionInfo() {
  return { sessionId, token, role, clientId: CLIENT_ID, online: serverOnline, leaderId: roomLeaderId, isHost: isRoomHost() };
}

export function onSessionState(fn) {
  onStateCb = fn;
}

export function isSyncEnabled() {
  try {
    const v = localStorage.getItem('bt_sync_enabled');
    if (v === null || v === undefined) return true;
    return v !== '0' && v !== 'false';
  } catch (_) { return true; }
}

export function setSyncEnabled(on) {
  try { localStorage.setItem('bt_sync_enabled', on ? '1' : '0'); } catch (_) {}
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
  serverOnline = true;
  setOnlineUi(true);
  return data;
}

function setOnlineUi(online) {
  serverOnline = online;
  try {
    let el = document.getElementById('btSyncStatus');
    if (!el) {
      el = document.createElement('div');
      el.id = 'btSyncStatus';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    if (online) {
      el.className = 'bt-sync-status on';
      const roleTag = roomLeaderId
        ? (roomLeaderId === CLIENT_ID ? 'HOST' : 'GUEST')
        : '…';
      el.textContent = isSyncEnabled()
        ? ('Sync · ' + roleTag + ' · ' + (sessionId ? sessionId.slice(0, 6) : ''))
        : 'Sync OFF';
    } else {
      el.className = 'bt-sync-status off';
      el.textContent = 'Server offline · local playback only';
    }
  } catch (_) {}
}

/** Force join shared room (or private). Safe to call repeatedly. */
export async function ensureSession() {
  if (isSyncEnabled()) {
    try {
      const out = await api('/api/session/room', 'POST', { clientId: CLIENT_ID });
      const sid = out.sessionId || (out.state && out.state.sessionId);
      if (!sid) throw new Error('no_room');
      sessionId = sid;
      lastVersion = (out.state && out.state.version) || lastVersion || 1;
      try { localStorage.setItem('bt_session_id', sessionId); } catch (_) {}
      connectEvents();
      startHeartbeat();
      // Apply server snapshot (another device may already be playing)
      try {
        const snap = await api('/api/session/' + encodeURIComponent(sessionId), 'GET');
        if (snap && snap.state) {
          updateLeaderFromState(snap.state);
          applyRemoteState(snap.state, true);
        }
      } catch (_) {}
      // If no leader yet, claim host (first device / room creator)
      if (!roomLeaderId || roomLeaderId === CLIENT_ID) {
        try {
          const claim = await pushCommand({ type: 'claim_host' });
          if (claim && claim.state) updateLeaderFromState(claim.state);
        } catch (_) {}
        await publishLocalState().catch(() => {});
      }
      setOnlineUi(true);
      reconnectAttempts = 0;
      return sessionId;
    } catch (e) {
      console.warn('[session] room join failed', e.message || e);
      setOnlineUi(false);
      scheduleReconnect();
      return null;
    }
  }

  // Sync OFF — private session
  if (sessionId) return sessionId;
  try {
    const saved = localStorage.getItem('bt_session_id_private');
    if (saved) {
      try {
        await api('/api/session/' + encodeURIComponent(saved) + '/join', 'POST', { clientId: CLIENT_ID });
        sessionId = saved;
        connectEvents();
        startHeartbeat();
        return sessionId;
      } catch (_) {
        localStorage.removeItem('bt_session_id_private');
      }
    }
  } catch (_) {}
  try {
    const out = await api('/api/session', 'POST', { leaderId: CLIENT_ID });
    sessionId = out.state.sessionId;
    lastVersion = out.state.version || 1;
    try { localStorage.setItem('bt_session_id_private', sessionId); } catch (_) {}
    connectEvents();
    startHeartbeat();
    return sessionId;
  } catch (e) {
    setOnlineUi(false);
    scheduleReconnect();
    return null;
  }
}

export async function joinSession(sid, tok, r) {
  sessionId = sid;
  token = tok || null;
  role = r || 'remote';
  try {
    localStorage.setItem('bt_sync_enabled', '1');
    localStorage.setItem('bt_session_id', sessionId);
  } catch (_) {}
  try {
    await api('/api/session/' + encodeURIComponent(sid) + '/join', 'POST', { clientId: CLIENT_ID, token });
  } catch (e) {
    // Room may not exist yet — fall back to shared default room, then still use returned id if server maps it
    console.warn('[session] join failed, trying shared room', e.message || e);
    try {
      const out = await api('/api/session/room', 'POST', { clientId: CLIENT_ID });
      sessionId = out.sessionId || sid;
    } catch (_) {}
  }
  connectEvents();
  startHeartbeat();
  try {
    const snap = await api('/api/session/' + encodeURIComponent(sessionId), 'GET');
    if (snap && snap.state) applyRemoteState(snap.state, true);
  } catch (_) {}
  setOnlineUi(true);
  return sessionId;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(15000, 1000 * Math.pow(1.5, Math.min(reconnectAttempts, 8)));
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.info('[session] reconnect attempt', reconnectAttempts);
    // Clear stale id so we re-join current server room after SoloHost restart
    sessionId = null;
    ensureSession().catch(() => {});
  }, delay);
}

function connectEvents() {
  if (!sessionId || typeof EventSource === 'undefined') return;
  if (es) {
    try { es.close(); } catch (_) {}
    es = null;
  }
  let url = '/api/session/' + encodeURIComponent(sessionId) + '/events?clientId=' + encodeURIComponent(CLIENT_ID);
  if (token) url += '&token=' + encodeURIComponent(token);
  es = new EventSource(url);

  es.addEventListener('sync.state', (ev) => {
    try {
      const state = JSON.parse(ev.data);
      applyRemoteState(state, false);
      serverOnline = true;
      setOnlineUi(true);
      reconnectAttempts = 0;
    } catch (_) {}
  });

  es.onopen = () => {
    serverOnline = true;
    setOnlineUi(true);
  };

  es.onerror = () => {
    // EventSource failed — server may be down (Docker removed) or network blip
    setOnlineUi(false);
    try { if (es) es.close(); } catch (_) {}
    es = null;
    scheduleReconnect();
  };
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!sessionId || applyingRemote) return;
    // Only the room host maintains the timeline clock
    if (roomLeaderId && roomLeaderId !== CLIENT_ID) return;
    const p = getPlayerState();
    const payload = {
      type: 'heartbeat',
      position: p.currentTime || 0,
      playing: !!p.playing,
      track: p.active || null,
      queue: p.queue || [],
      index: p.index || 0,
      baseVersion: lastVersion,
    };
    pushCommand(payload).catch(() => {
      setOnlineUi(false);
      scheduleReconnect();
    });
  }, 8000);
}

export async function pushCommand(cmd) {
  if (!sessionId) {
    await ensureSession();
    if (!sessionId) return null;
  }
  try {
    const body = { ...cmd, clientId: CLIENT_ID, token: token || undefined };
    const out = await api('/api/session/' + encodeURIComponent(sessionId) + '/command', 'POST', body);
    if (out.state) {
      if (out.state.version != null) lastVersion = Math.max(lastVersion, out.state.version);
      if (onStateCb) onStateCb(out.state);
    }
    return out;
  } catch (e) {
    setOnlineUi(false);
    scheduleReconnect();
    return null;
  }
}

/** Push full local player snapshot — HOST ONLY (followers never rewrite host timeline) */
export async function publishLocalState() {
  if (applyingRemote) return;
  if (!sessionId) {
    await ensureSession();
    if (!sessionId) return;
  }
  // Followers must not push load snapshots (reconnect/latency would seek the host)
  if (roomLeaderId && roomLeaderId !== CLIENT_ID) {
    return;
  }
  const p = getPlayerState();
  lastTrackId = p.active && p.active.videoId;
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

/**
 * Apply remote state. force=true ignores version (initial join).
 */
function applyRemoteState(state, force) {
  if (!state) return;
  if (state.sessionId && sessionId && state.sessionId !== sessionId && !force) {
    sessionId = state.sessionId;
  }
  updateLeaderFromState(state);

  // Host keeps local clock: do not seek/pause self from follower-originated echoes
  const amHost = roomLeaderId && roomLeaderId === CLIENT_ID;
  if (amHost && !force) {
    // Still track version for commands; timeline stays local on host machine
    if (state.version != null) lastVersion = Math.max(lastVersion, state.version);
    if (onStateCb) onStateCb(state);
    setOnlineUi(true);
    return;
  }

  if (!force && state.version != null && state.version < lastVersion) return;
  if (state.version != null) lastVersion = Math.max(lastVersion, state.version);
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

    const p2 = getPlayerState();
    if (state.playing && !p2.playing) {
      try { togglePlayPause(); } catch (_) {}
    } else if (!state.playing && p2.playing) {
      try { pausePlayer(); } catch (_) {}
    }

    // Follow host position (clients only) — threshold avoids jitter
    if (state.position != null && Math.abs((p2.currentTime || 0) - state.position) > 2.5) {
      try { seekTo(state.position); } catch (_) {}
    }
  } catch (e) {
    console.warn('[session] applyRemote', e);
  } finally {
    setTimeout(() => { applyingRemote = false; }, 500);
  }
}

export function notifyLocalAction(type, extra = {}) {
  if (applyingRemote) return;
  const map = {
    play: 'play', pause: 'pause', toggle: 'toggle',
    next: 'next', previous: 'previous',
    seek: 'seek', shuffle: 'shuffle', repeat: 'repeat',
  };
  const t = map[type] || type;
  pushCommand({ type: t, ...extra, baseVersion: lastVersion }).catch(() => {});
  // Also push full snapshot so peers get track metadata
  if (t === 'play' || t === 'next' || t === 'previous' || t === 'load') {
    publishLocalState().catch(() => {});
  }
}

export function tryAutoJoinFromUrl() {
  try {
    const u = new URL(location.href);
    const s = u.searchParams.get('s');
    const t = u.searchParams.get('t');
    const r = u.searchParams.get('r');
    const sync = u.searchParams.get('sync');
    if (s) {
      // QR / link carries the room code — force sync ON and join THAT room
      try {
        localStorage.setItem('bt_sync_enabled', '1');
        localStorage.setItem('bt_session_id', s);
      } catch (_) {}
      console.info('[session] joining room from URL', s);
      return joinSession(s, t, r || 'remote').then(async (sid) => {
        // Stay on this room; do not let a later ensureSession switch rooms
        sessionId = sid || s;
        try {
          // Clean query from address bar without reload (optional)
          if (sync === '1' || t) {
            const clean = location.pathname || '/';
            history.replaceState({}, '', clean);
          }
        } catch (_) {}
        await publishLocalState().catch(() => {});
        return sessionId;
      });
    }
  } catch (_) {}
  return Promise.resolve(null);
}

/** Call when local track changes — immediate publish (not throttled) */
export function onLocalTrackMaybeChanged() {
  if (applyingRemote) return;
  const p = getPlayerState();
  const id = p.active && p.active.videoId;
  if (id && id !== lastTrackId) {
    lastTrackId = id;
    publishLocalState().catch(() => {});
  }
}

// Visibility: re-sync when tab becomes active
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensureSession().then(() => {
        if (isRoomHost()) return publishLocalState();
        // Follower: request snapshot only — never push timeline
        return pushCommand({ type: 'sync.request' });
      }).catch(() => {});
    }
  });
}
