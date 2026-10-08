'use strict';
/**
 * Playback session — server-authoritative shared state + SSE broadcast.
 * Pairing tokens are short-lived and never include API keys.
 */

const crypto = require('crypto');

const sessions = new Map(); // sessionId → session
const tokens = new Map(); // token → { sessionId, role, exp, revoked }
const subscribers = new Map(); // sessionId → Set of { res, clientId }

const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function now() {
  return Date.now();
}

function createSession(leaderId) {
  const sessionId = id();
  const session = {
    sessionId,
    version: 1,
    track: null,
    queue: [],
    index: 0,
    position: 0,
    duration: 0,
    playing: false,
    shuffle: false,
    repeat: 'off',
    karaoke: false,
    updatedAt: now(),
    leaderId: leaderId || id(),
    clients: new Set(),
    serverTime: now(),
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    const subs = subscribers.get(sessionId);
    if (subs) {
      subs.forEach((sub) => { try { sub.res.end(); } catch (_) {} });
      subscribers.delete(sessionId);
    }
    return null;
  }
  return s;
}

function publicState(s) {
  if (!s) return null;
  return {
    sessionId: s.sessionId,
    version: s.version,
    track: s.track,
    queue: s.queue,
    index: s.index,
    position: s.position,
    duration: s.duration,
    playing: s.playing,
    shuffle: s.shuffle,
    repeat: s.repeat,
    karaoke: s.karaoke,
    updatedAt: s.updatedAt,
    leaderId: s.leaderId,
    serverTime: now(),
    clientCount: s.clients.size,
  };
}

function broadcast(sessionId, event, payload) {
  const subs = subscribers.get(sessionId);
  if (!subs || !subs.size) return;
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const sub of [...subs]) {
    try {
      sub.res.write(data);
    } catch (_) {
      subs.delete(sub);
    }
  }
}

function subscribe(sessionId, res, clientId) {
  const s = getSession(sessionId);
  if (!s) return false;
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  const sub = { res, clientId: clientId || id() };
  subscribers.get(sessionId).add(sub);
  s.clients.add(sub.clientId);
  res.on('close', () => {
    const set = subscribers.get(sessionId);
    if (set) set.delete(sub);
    const sess = getSession(sessionId);
    if (sess) sess.clients.delete(sub.clientId);
  });
  // initial state
  try {
    res.write(`event: sync.state\ndata: ${JSON.stringify(publicState(s))}\n\n`);
  } catch (_) {}
  return true;
}

function applyCommand(sessionId, cmd, clientId) {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: 'session_not_found' };
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'bad_command' };

  if (cmd.baseVersion != null && Number(cmd.baseVersion) < s.version - 5) {
    return { ok: false, error: 'stale', state: publicState(s) };
  }

  const type = String(cmd.type || cmd.action || '').toLowerCase();
  const allowed = new Set([
    'play', 'pause', 'toggle', 'next', 'previous', 'seek', 'load',
    'queue.add', 'queue.remove', 'queue.reorder', 'queue.clear',
    'shuffle', 'repeat', 'sync.request', 'karaoke', 'heartbeat',
  ]);
  if (!allowed.has(type)) return { ok: false, error: 'command_not_allowed' };

  switch (type) {
    case 'play':
      s.playing = true;
      if (cmd.position != null) s.position = Number(cmd.position) || 0;
      break;
    case 'pause':
      s.playing = false;
      if (cmd.position != null) s.position = Number(cmd.position) || 0;
      break;
    case 'toggle':
      s.playing = !s.playing;
      break;
    case 'seek':
      s.position = Math.max(0, Number(cmd.position) || Number(cmd.seconds) || 0);
      break;
    case 'load':
      if (cmd.track) s.track = cmd.track;
      if (Array.isArray(cmd.queue)) s.queue = cmd.queue.slice(0, 100);
      if (cmd.index != null) s.index = Number(cmd.index) || 0;
      s.position = Number(cmd.position) || 0;
      if (cmd.playing != null) s.playing = !!cmd.playing;
      if (cmd.shuffle != null) s.shuffle = !!cmd.shuffle;
      if (cmd.repeat) s.repeat = cmd.repeat;
      break;
    case 'next':
      if (s.queue.length) {
        s.index = Math.min(s.queue.length - 1, s.index + 1);
        s.track = s.queue[s.index] || s.track;
        s.position = 0;
        s.playing = true;
      }
      break;
    case 'previous':
      if (s.queue.length) {
        s.index = Math.max(0, s.index - 1);
        s.track = s.queue[s.index] || s.track;
        s.position = 0;
        s.playing = true;
      }
      break;
    case 'queue.add': {
      const items = Array.isArray(cmd.items) ? cmd.items : cmd.item ? [cmd.item] : [];
      items.slice(0, 20).forEach((it) => {
        if (it && it.videoId) s.queue.push(it);
      });
      if (s.queue.length > 100) s.queue = s.queue.slice(-100);
      break;
    }
    case 'queue.remove': {
      const idx = Number(cmd.index);
      if (!Number.isNaN(idx) && idx >= 0 && idx < s.queue.length) s.queue.splice(idx, 1);
      break;
    }
    case 'queue.clear':
      s.queue = s.track ? [s.track] : [];
      s.index = 0;
      break;
    case 'queue.reorder':
      if (Array.isArray(cmd.queue)) s.queue = cmd.queue.slice(0, 100);
      break;
    case 'shuffle':
      s.shuffle = cmd.value != null ? !!cmd.value : !s.shuffle;
      break;
    case 'repeat':
      if (cmd.value) s.repeat = ['off', 'one', 'all'].includes(cmd.value) ? cmd.value : s.repeat;
      else s.repeat = s.repeat === 'off' ? 'one' : s.repeat === 'one' ? 'all' : 'off';
      break;
    case 'karaoke':
      s.karaoke = cmd.value != null ? !!cmd.value : !s.karaoke;
      break;
    case 'heartbeat':
      if (cmd.position != null) s.position = Number(cmd.position) || s.position;
      if (cmd.playing != null) s.playing = !!cmd.playing;
      s.updatedAt = now();
      return { ok: true, state: publicState(s) };
    case 'sync.request':
      return { ok: true, state: publicState(s) };
    default:
      break;
  }

  s.version += 1;
  s.updatedAt = now();
  s.serverTime = now();
  const state = publicState(s);
  broadcast(sessionId, 'sync.state', state);
  return { ok: true, state };
}

function createPairingToken(sessionId, role) {
  const s = getSession(sessionId);
  if (!s) return null;
  const token = crypto.randomBytes(16).toString('hex');
  const exp = now() + TOKEN_TTL_MS;
  tokens.set(token, {
    sessionId,
    role: role === 'player' ? 'player' : 'remote',
    exp,
    revoked: false,
  });
  return { token, exp, sessionId, role: role === 'player' ? 'player' : 'remote' };
}

function validateToken(token) {
  const t = tokens.get(String(token || ''));
  if (!t) return null;
  if (t.revoked) return null;
  if (now() > t.exp) {
    tokens.delete(token);
    return null;
  }
  if (!getSession(t.sessionId)) return null;
  return t;
}

function revokeToken(token) {
  const t = tokens.get(String(token || ''));
  if (t) {
    t.revoked = true;
    return true;
  }
  return false;
}

function joinSession(sessionId, clientId) {
  const s = getSession(sessionId);
  if (!s) return null;
  s.clients.add(clientId || id());
  return publicState(s);
}

setInterval(() => {
  const t = now();
  for (const [k, s] of sessions) {
    if (t - s.updatedAt > SESSION_TTL_MS) {
      sessions.delete(k);
      const subs = subscribers.get(k);
      if (subs) {
        subs.forEach((sub) => { try { sub.res.end(); } catch (_) {} });
        subscribers.delete(k);
      }
    }
  }
  for (const [k, tok] of tokens) {
    if (tok.revoked || t > tok.exp) tokens.delete(k);
  }
}, 5 * 60 * 1000).unref?.();


/** One shared room so all devices hear the same track by default */
let defaultRoomId = null;
function getDefaultRoom() {
  if (defaultRoomId && sessions.has(defaultRoomId)) {
    return sessions.get(defaultRoomId);
  }
  const s = createSession('room-leader');
  defaultRoomId = s.sessionId;
  s.isDefaultRoom = true;
  return s;
}

module.exports = {
  getDefaultRoom,
  createSession,
  getSession,
  publicState,
  applyCommand,
  createPairingToken,
  validateToken,
  revokeToken,
  joinSession,
  subscribe,
  broadcast,
  id,
};
