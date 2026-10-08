'use strict';
/**
 * Playback session manager — server-authoritative shared state.
 * Pairing tokens are short-lived and never include API keys.
 */

const crypto = require('crypto');

const sessions = new Map(); // sessionId → session
const tokens = new Map(); // token → { sessionId, role, exp, revoked }

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min
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
  };
}

function applyCommand(sessionId, cmd, clientId) {
  const s = getSession(sessionId);
  if (!s) return { ok: false, error: 'session_not_found' };
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'bad_command' };

  // Reject stale by version if provided
  if (cmd.baseVersion != null && Number(cmd.baseVersion) < s.version - 5) {
    return { ok: false, error: 'stale', state: publicState(s) };
  }

  const type = String(cmd.type || cmd.action || '').toLowerCase();
  const allowed = new Set([
    'play', 'pause', 'toggle', 'next', 'previous', 'seek', 'load',
    'queue.add', 'queue.remove', 'queue.reorder', 'queue.clear',
    'shuffle', 'repeat', 'sync.request', 'karaoke',
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
    case 'sync.request':
      return { ok: true, state: publicState(s) };
    default:
      break;
  }

  s.version += 1;
  s.updatedAt = now();
  s.serverTime = now();
  return { ok: true, state: publicState(s) };
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

// Periodic cleanup
setInterval(() => {
  const t = now();
  for (const [k, s] of sessions) {
    if (t - s.updatedAt > SESSION_TTL_MS) sessions.delete(k);
  }
  for (const [k, tok] of tokens) {
    if (tok.revoked || t > tok.exp) tokens.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

module.exports = {
  createSession,
  getSession,
  publicState,
  applyCommand,
  createPairingToken,
  validateToken,
  revokeToken,
  joinSession,
  id,
};
