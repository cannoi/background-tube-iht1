'use strict';
/**
 * Music engine: AI intent, candidate cache, resolve, preference, trends.
 * Quota-first: local → cache → history → minimal YouTube Search fallback.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'music-candidate-cache.json');
const PREF_FILE = path.join(DATA_DIR, 'user-preferences.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TREND_TTL_MS = 30 * 60 * 1000; // 30 min

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDir();
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('music-engine save:', e.message);
  }
}


/** Known popular mappings — resolve without Search API when possible */
const KNOWN_VIDEOS = [
  // Format: normalized query fragments → videoId (official embeds users commonly play)
  // These are well-known public YouTube video IDs used as last-resort offline seeds only when cache misses.
  { keys: ['lofi hip hop', 'lofi radio', 'beats to relax'], videoId: 'jfKfPfyJRdk', title: 'lofi hip hop radio', artist: 'Lofi Girl' },
  { keys: ['lofi girl', 'lofi study'], videoId: 'jfKfPfyJRdk', title: 'lofi hip hop radio', artist: 'Lofi Girl' },
];

function lookupKnown(query) {
  const n = normalizeQuery(query);
  if (!n || n.length < 4) return null;
  for (const row of KNOWN_VIDEOS) {
    // Only exact-ish match: query contains full key or key contains full query when query is long enough
    const hit = row.keys.some((k) => {
      const nk = normalizeQuery(k);
      if (!nk) return false;
      if (n === nk) return true;
      if (n.includes(nk) && nk.length >= 6) return true;
      if (nk.includes(n) && n.length >= 8) return true;
      return false;
    });
    if (hit) {
      return {
        videoId: row.videoId,
        title: row.title,
        channelTitle: row.artist,
        thumbnail: 'https://i.ytimg.com/vi/' + row.videoId + '/hqdefault.jpg',
        duration: null,
        source: 'known',
      };
    }
  }
  return null;
}


function normalizeQuery(q) {
  return String(q || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** In-memory + disk candidate cache */
let candidateCache = loadJson(CACHE_FILE, { entries: {} });
const trendCache = new Map();

function cacheGet(normalized) {
  const e = candidateCache.entries[normalized];
  if (!e) return null;
  if (Date.now() - (e.updatedAt || 0) > CACHE_TTL_MS) {
    delete candidateCache.entries[normalized];
    return null;
  }
  return e;
}

function cacheSet(normalized, entry) {
  candidateCache.entries[normalized] = {
    ...entry,
    normalizedQuery: normalized,
    updatedAt: Date.now(),
  };
  // Cap size
  const keys = Object.keys(candidateCache.entries);
  if (keys.length > 500) {
    keys
      .sort((a, b) => (candidateCache.entries[a].updatedAt || 0) - (candidateCache.entries[b].updatedAt || 0))
      .slice(0, keys.length - 400)
      .forEach((k) => delete candidateCache.entries[k]);
  }
  saveJson(CACHE_FILE, candidateCache);
}

/** Preference profile */
function defaultPrefs() {
  return {
    languages: {},
    genres: {},
    artists: {},
    moods: {},
    weights: { personalPreference: 0.6, localTrend: 0.25, globalTrend: 0.15 },
    updatedAt: 0,
  };
}

let prefs = { ...defaultPrefs(), ...loadJson(PREF_FILE, {}) };

function getPreferences() {
  return prefs;
}

function bump(map, key, amount) {
  if (!key) return;
  const k = String(key).toLowerCase().slice(0, 80);
  map[k] = Math.min(1, (map[k] || 0) + amount);
}

function recordPlay(item, opts = {}) {
  if (!item) return;
  const completed = opts.completed;
  const skipped = opts.skipped;
  const amount = completed ? 0.08 : skipped ? -0.03 : 0.04;
  if (item.channelTitle) bump(prefs.artists, item.channelTitle, Math.abs(amount) * (skipped ? -1 : 1));
  if (item.language) bump(prefs.languages, item.language, Math.abs(amount));
  if (item.genre) bump(prefs.genres, item.genre, Math.abs(amount));
  if (item.mood) bump(prefs.moods, item.mood, Math.abs(amount));
  // Heuristic language from title
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(item.title || '')) {
    bump(prefs.languages, 'vi', 0.05);
  }
  prefs.updatedAt = Date.now();
  saveJson(PREF_FILE, prefs);
}

function scoreItem(item, context = {}) {
  const w = prefs.weights || defaultPrefs().weights;
  let personal = 0;
  const artist = (item.channelTitle || '').toLowerCase();
  if (artist && prefs.artists[artist]) personal += prefs.artists[artist];
  if (item.language && prefs.languages[item.language]) personal += prefs.languages[item.language] * 0.5;
  if (context.mood && prefs.moods[context.mood]) personal += prefs.moods[context.mood] * 0.3;
  personal = Math.min(1, personal);

  const local = context.localBoost || 0;
  const global = context.globalBoost || 0;
  return w.personalPreference * personal + w.localTrend * local + w.globalTrend * global;
}

/**
 * Parse AI structured intent from model reply text or JSON.
 */
function parseIntent(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const intent = String(obj.intent || '').toLowerCase();
  const allowed = new Set([
    'player_control',
    'music_search',
    'recommendation',
    'queue_operation',
    'playlist_operation',
    'karaoke',
    'library',
    'help',
  ]);
  if (!allowed.has(intent)) return null;
  const out = {
    intent,
    action: obj.action ? String(obj.action).slice(0, 40) : undefined,
    query: obj.query ? String(obj.query).slice(0, 200) : undefined,
    mood: obj.mood ? String(obj.mood).slice(0, 40) : undefined,
    language: obj.language ? String(obj.language).slice(0, 10) : undefined,
    region: obj.region ? String(obj.region).slice(0, 5) : undefined,
    limit: Math.min(20, Math.max(1, Number(obj.limit) || 8)),
    // undefined when the model omits it, so it never overrides a local default
    autoPlay: obj.autoPlay === undefined ? undefined : !!obj.autoPlay,
    playlistName: obj.playlistName ? String(obj.playlistName).slice(0, 80) : undefined,
    newName: obj.newName ? String(obj.newName).slice(0, 80) : undefined,
    fromQueue: obj.fromQueue ? true : undefined,
    current: obj.current ? true : undefined,
    playNext: obj.playNext ? true : undefined,
    candidates: Array.isArray(obj.candidates)
      ? obj.candidates.slice(0, 20).map((c) => ({
          artist: String(c.artist || c.channel || '').slice(0, 80),
          title: String(c.title || c.name || '').slice(0, 120),
          query: String(c.query || `${c.artist || ''} ${c.title || ''}`).slice(0, 160),
        }))
      : undefined,
    videoId: obj.videoId ? String(obj.videoId).slice(0, 20) : undefined,
  };
  // Drop undefined keys so merging never erases values the local parser already found.
  Object.keys(out).forEach((k) => { if (out[k] === undefined) delete out[k]; });
  return out;
}

/** Intent for the song-list part of "create playlist X with <content>". */
function playlistContentIntent(content) {
  const c = String(content || '').trim();
  if (!c) return null;
  const sub = localIntentParse(c);
  const lim = (c.match(/(\d+)\s*(bài|bai|songs?|tracks?)/i) || [])[1];
  if (sub && sub.intent === 'recommendation') return { ...sub, limit: lim ? Math.min(20, Number(lim)) : 10 };
  const q = c.replace(/^\d+\s*(bài|bai|songs?|tracks?)\s*(của|cua|by|of)?\s*/i, '').trim() || c;
  return { intent: 'music_search', query: q, limit: lim ? Math.min(20, Number(lim)) : 8 };
}

/** Local parser for playlist commands (VI + EN). Returns null when the text is not a playlist command. */
function parsePlaylistCommand(message) {
  const m = String(message || '').trim();
  if (!m) return null;
  const PL = '(?:playlist|play list|danh sách phát|danh sach phat)';
  let r;
  // list
  if (new RegExp('^(?:liệt kê|liet ke|xem|show|list|các|cac|my)\\s*(?:các\\s+|my\\s+|all\\s+)?' + PL + 's?\\s*(?:của tôi|của mình|cua toi)?$', 'i').test(m)) {
    return { intent: 'playlist_operation', action: 'playlist_list' };
  }
  // rename
  r = m.match(new RegExp('^(?:đổi tên|doi ten|rename)\\s+' + PL + '\\s+(.+?)\\s+(?:thành|thanh|sang|to)\\s+(.+)$', 'i'));
  if (r) return { intent: 'playlist_operation', action: 'playlist_rename', playlistName: r[1].trim(), newName: r[2].trim() };
  // delete
  r = m.match(new RegExp('^(?:xóa|xoá|xoa|delete|remove)\\s+' + PL + '\\s+(.+)$', 'i'));
  if (r) return { intent: 'playlist_operation', action: 'playlist_delete', playlistName: r[1].trim() };
  // queue a playlist after the last track
  r = m.match(new RegExp('^(?:thêm|them|add|queue)\\s+' + PL + '\\s+(.+?)\\s+(?:vào|vao|to)\\s+(?:cuối|cuoi|(?:the )?(?:end|queue)|hàng đợi|danh sách|danh sach).*$', 'i'));
  if (r) return { intent: 'playlist_operation', action: 'playlist_queue', playlistName: r[1].trim() };
  // play a playlist
  r = m.match(new RegExp('^(?:phát|phat|mở|mo|nghe|play|open)\\s+(?:lại\\s+)?' + PL + '\\s+(.+)$', 'i'));
  if (r) return { intent: 'playlist_operation', action: 'playlist_play', playlistName: r[1].trim() };
  // create (optionally with content)
  r = m.match(new RegExp('^(?:tạo|tao|lập|lap|create|make|new|build)\\s+(?:cho (?:tôi|toi|mình|minh)\\s+)?(?:một|mot|1|a|an|new)?\\s*' + PL + '\\s*(.*)$', 'i'));
  if (r) {
    let rest = (r[1] || '').trim();
    rest = rest.replace(/^(?:tên|ten|named|called|name)\s+/i, '');
    // "<name> from queue" / "<name> từ hàng đợi" (name first)
    const tail = rest.match(/^(.+?)\s+(?:từ|tu|from)\s+(?:hàng đợi|hang doi|danh sách phát hiện tại|danh sach phat hien tai|(?:the |current )?queue)\s*$/i);
    if (tail) return { intent: 'playlist_operation', action: 'playlist_create', playlistName: tail[1].trim(), fromQueue: true };
    if (/^(?:từ|tu|from)\s+(?:hàng đợi|hang doi|danh sách phát hiện tại|danh sach phat hien tai|queue|the queue|current queue)/i.test(rest)) {
      const nm = rest.replace(/^(?:từ|tu|from)\s+(?:hàng đợi|hang doi|danh sách phát hiện tại|danh sach phat hien tai|(?:the |current )?queue)\s*(?:(?:tên|ten|named|called|là|la)\s+)?/i, '').trim();
      return { intent: 'playlist_operation', action: 'playlist_create', playlistName: nm || 'My queue', fromQueue: true };
    }
    const split = rest.match(/^(.+?)\s+(?:gồm|gom|với|voi|có|co|chứa|chua|including|containing|with|of|from|gồm có|toàn|toan)\s+(.+)$/i);
    let name = rest;
    let content = '';
    if (split) { name = split[1].trim(); content = split[2].trim(); }
    name = name.replace(/^["'“”‘’]|["'“”‘’]$/g, '').trim();
    const ci = playlistContentIntent(content);
    const base = { intent: 'playlist_operation', action: 'playlist_create', playlistName: name || (ci ? (ci.query || ci.mood || 'AI playlist') : 'AI playlist') };
    if (ci) Object.assign(base, { query: content, mood: ci.mood, language: ci.language, region: ci.region, limit: ci.limit });
    return base;
  }
  // add current / a song to a playlist
  r = m.match(new RegExp('^(?:thêm|them|add|cho)\\s+(.*?)\\s*(?:vào|vao|into|to)\\s+' + PL + '\\s+(.+)$', 'i'));
  if (r) {
    const what = r[1].trim();
    const current = !what || /^(?:bài này|bai nay|bài hiện tại|bai hien tai|bài đang phát|bai dang phat|this (?:song|track)|current(?: song| track)?|it|nó|no)$/i.test(what);
    const out = { intent: 'playlist_operation', action: 'playlist_add', playlistName: r[2].trim(), current };
    if (!current) {
      // A specific song title → exactly 1 track. A vague request ("3 bài nhạc buồn") → a small list.
      const ci = playlistContentIntent(what);
      out.query = what;
      if (ci && ci.intent === 'recommendation') { out.limit = ci.limit; out.mood = ci.mood; out.language = ci.language; out.region = ci.region; }
      else out.limit = /\d+\s*(bài|bai|songs?|tracks?)/i.test(what) ? ci.limit : 1;
    }
    return out;
  }
  return null;
}

/**
 * Lightweight local intent parser when AI is offline.
 */
function localIntentParse(message) {
  const m = String(message || '').trim();
  const lower = m.toLowerCase();
  if (!m) return { intent: 'help' };

  // Playlist management (create / add / play / rename / delete / list) — must come before generic "play ..."
  const plCmd = parsePlaylistCommand(m);
  if (plCmd) return plCmd;

  // "play track 3" / "phát bài số 3" — jump inside the current queue
  const idxM = m.match(/^(?:phát|phat|mở|mo|play|nghe)\s+(?:lại\s+)?(?:bài\s+)?(?:số|so|thứ|thu|track|number|no\.?|#)\s*(\d{1,3})$/i);
  if (idxM) return { intent: 'player_control', action: 'play_index', value: Number(idxM[1]) };
  // "remove track 3 from queue" / "xóa bài số 3"
  const rmM = m.match(/^(?:xóa|xoá|xoa|bỏ|bo|remove|delete)\s+(?:bài\s+)?(?:số|so|thứ|thu|track|number|#)\s*(\d{1,3})(?:\s+(?:khỏi|khoi|trong|from)\b.*)?$/i);
  if (rmM) return { intent: 'queue_operation', action: 'queue_remove', value: Number(rmM[1]) };
  // favorites on the current track
  if (/^(?:thích bài này|thich bai nay|yêu thích bài này|yeu thich bai nay|thả tim|tha tim|like (?:this|it)|favou?rite(?: this)?(?: song| track)?|fav|thêm (?:bài này )?vào yêu thích|them (?:bai nay )?vao yeu thich|bỏ yêu thích|bo yeu thich|unfavou?rite)$/i.test(m)) {
    return { intent: 'library', action: 'favorite' };
  }
  // "play next X" → insert right after the current track without interrupting it
  const pnM = m.match(/^(?:phát tiếp theo|phat tiep theo|phát ngay sau|chèn|chen|play next|queue next|insert)\s+(.+)$/i);
  if (pnM) return { intent: 'music_search', query: pnM[1].trim(), limit: 1, autoPlay: false, queueOnly: true, playNext: true };
  // "add X to queue" / "thêm X vào danh sách phát"
  const aqM = m.match(/^(?:thêm|them|add)\s+(.+?)\s+(?:vào|vao|to)\s+(?:the\s+)?(?:hàng đợi|hang doi|queue|danh sách phát|danh sach phat|danh sách chờ|danh sach cho)\s*$/i);
  if (aqM && !/^(?:bài này|bai nay|this (?:song|track))$/i.test(aqM[1].trim())) {
    return { intent: 'music_search', query: aqM[1].trim(), limit: 5, autoPlay: false, queueOnly: true };
  }

  if (/^(next|tiếp|bài tiếp|skip|bài sau)$/i.test(m)) return { intent: 'player_control', action: 'next' };
  if (/^(prev|previous|trước|bài trước|back)$/i.test(m)) return { intent: 'player_control', action: 'previous' };
  if (/^(pause|dừng|tạm dừng|pause music)$/i.test(m) || /^(dừng lại|tạm dừng nhạc)$/i.test(m))
    return { intent: 'player_control', action: 'pause' };
  if (/^(stop|dừng hẳn|tắt nhạc|stop music)$/i.test(m))
    return { intent: 'player_control', action: 'stop' };
  if (/^(play|phát|tiếp tục|resume|phát tiếp)$/i.test(m))
    return { intent: 'player_control', action: 'play' };
  if (/^(shuffle|xáo|xáo trộn)$/i.test(m) || /shuffle (on|off)/i.test(lower))
    return { intent: 'player_control', action: 'shuffle' };
  if (/^(repeat|lặp|lặp lại)$/i.test(m) || /repeat (one|all|off)/i.test(lower))
    return { intent: 'player_control', action: 'repeat' };

  const vol = lower.match(/(?:volume|âm lượng|loa)\s*(\d{1,3})/i) || lower.match(/set volume\s*(\d{1,3})/i);
  if (vol) return { intent: 'player_control', action: 'volume', value: Math.min(100, Number(vol[1])) };
  if (/mute|tắt tiếng/i.test(lower) && !/unmute|bật tiếng/i.test(lower))
    return { intent: 'player_control', action: 'mute' };
  if (/unmute|bật tiếng/i.test(lower)) return { intent: 'player_control', action: 'unmute' };

  const seekM = lower.match(/(?:seek|nhảy|tua)\s*(?:to\s*)?(\d+)\s*(s|sec|giây|m|min|phút)?/i);
  if (seekM) {
    let sec = Number(seekM[1]);
    if (/m|min|phút/i.test(seekM[2] || '')) sec *= 60;
    return { intent: 'player_control', action: 'seek', value: sec };
  }

  const sleep = lower.match(/(?:sleep|hẹn giờ|timer|tắt sau)\s*(\d+)\s*(m|min|phút|h|giờ|hour)?/i);
  if (sleep || /^(sleep off|tắt hẹn giờ|cancel sleep)$/i.test(m)) {
    if (/off|tắt hẹn|cancel/i.test(lower) && !sleep) return { intent: 'player_control', action: 'sleep', value: 0 };
    let mins = sleep ? Number(sleep[1]) : 30;
    if (sleep && /h|giờ|hour/i.test(sleep[2] || '')) mins *= 60;
    return { intent: 'player_control', action: 'sleep', value: mins };
  }

  if (/clear queue|xóa (hàng đợi|queue)|dọn queue/i.test(lower))
    return { intent: 'queue_operation', action: 'queue_clear' };
  if (/what('?s| is) playing|đang phát|bài nào|now playing|đang nghe/i.test(lower))
    return { intent: 'player_control', action: 'now_playing' };
  if (/(queue status|danh sách phát|có bao nhiêu bài)/i.test(lower) && !/add|thêm/i.test(lower))
    return { intent: 'player_control', action: 'queue_status' };

  if (/karaoke/i.test(lower)) {
    const q = m.replace(/karaoke/gi, '').replace(/cho (tôi|toi)/gi, '').trim() || 'karaoke';
    return { intent: 'karaoke', query: q, limit: 8, autoPlay: true };
  }

  if (/recommend|gợi ý|nhạc .* (chill|relax|workout|ngủ|gym|buổi tối)/i.test(lower) ||
      /cho (tôi|toi) \d* ?(bài|bai|nhạc|nhac)/i.test(lower) ||
      /play (some |me )?(chill|relax|workout|lofi|jazz)/i.test(lower)) {
    let mood = 'general';
    if (/chill|relax|thư giãn|ngủ|sleep|lofi/i.test(lower)) mood = 'relax';
    if (/workout|gym|tập|exercise/i.test(lower)) mood = 'workout';
    if (/party|sôi động|dance/i.test(lower)) mood = 'party';
    let language = /việt|vietnam|v-pop|nhạc việt/i.test(lower) ? 'vi' : undefined;
    if (/english|âu mỹ|us uk/i.test(lower)) language = 'en';
    const lim = (m.match(/(\d+)\s*(bài|bai|songs?)/i) || [])[1];
    return {
      intent: 'recommendation',
      mood,
      language,
      region: language === 'vi' ? 'VN' : undefined,
      limit: lim ? Math.min(15, Number(lim)) : 8,
      autoPlay: true,
    };
  }

  if (/similar|giống (bài )?này|more like|bài tương tự/i.test(lower)) {
    return { intent: 'recommendation', mood: 'similar', limit: 8, autoPlay: true, similar: true };
  }

  if (/add (to )?(queue|danh sách)|thêm (vào )?(queue|danh sách)/i.test(lower)) {
    const q = m.replace(/add (to )?(queue|danh sách)|thêm (vào )?(queue|danh sách)/gi, '').trim() || m;
    return { intent: 'music_search', query: q, limit: 5, autoPlay: false, queueOnly: true };
  }

  if (/^(play|phát|nghe|mở)\s+.+/i.test(m) || /son tung|đen vâu|blackpink|bts|lofi/i.test(lower)) {
    const q = m.replace(/^(play|phát|nghe|mở)\s+/i, '').trim() || m;
    return { intent: 'music_search', query: q, limit: 8, autoPlay: true };
  }

  if (/help|hướng dẫn|cách|what can you|bạn làm được gì/i.test(lower)) return { intent: 'help' };

  return { intent: 'music_search', query: m, limit: 8, autoPlay: true };
}

/**
 * Resolve a candidate {artist,title,query} to a playable item.
 * Uses: cache → optional history → ytSearchFn fallback (quota).
 */
async function resolveCandidate(candidate, ytSearchFn, opts = {}) {
  const query = normalizeQuery(
    candidate.query || `${candidate.artist || ''} ${candidate.title || ''}`.trim()
  );
  if (!query) return null;

  const cached = cacheGet(query);
  if (cached && cached.videoId) {
    return {
      videoId: cached.videoId,
      title: cached.title || candidate.title || query,
      channelTitle: cached.artist || candidate.artist || '',
      thumbnail: cached.thumbnail || '',
      duration: cached.duration || '',
      source: 'cache',
    };
  }

  const known = lookupKnown(query) || lookupKnown(candidate.title || '') || lookupKnown((candidate.artist || '') + ' ' + (candidate.title || ''));
  if (known) {
    cacheSet(query, {
      artist: known.channelTitle,
      title: known.title,
      videoId: known.videoId,
      thumbnail: known.thumbnail,
      source: 'known',
    });
    return known;
  }

  // Optional local history match (passed in opts.history)
  if (Array.isArray(opts.history)) {
    const hit = opts.history.find((h) => {
      const t = normalizeQuery(h.title || '');
      const a = normalizeQuery(h.channelTitle || '');
      return t.includes(normalizeQuery(candidate.title || '')) ||
        (candidate.title && t === normalizeQuery(candidate.title)) ||
        (query && t.includes(query.slice(0, 20)));
    });
    if (hit && hit.videoId) {
      cacheSet(query, {
        artist: hit.channelTitle,
        title: hit.title,
        videoId: hit.videoId,
        thumbnail: hit.thumbnail,
        duration: hit.duration,
        source: 'history',
      });
      return { ...hit, source: 'history' };
    }
  }

  if (typeof ytSearchFn !== 'function') {
    return null;
  }

  // Minimal Search API fallback — one targeted query
  try {
    const searchQ = [candidate.artist, candidate.title].filter(Boolean).join(' ') || candidate.query;
    const data = await ytSearchFn(searchQ, 3);
    const item = (data && data.items && data.items[0]) || null;
    if (item && item.videoId) {
      cacheSet(query, {
        artist: item.channelTitle,
        title: item.title,
        videoId: item.videoId,
        thumbnail: item.thumbnail,
        duration: item.duration,
        source: 'resolved',
      });
      return { ...item, source: 'youtube_search' };
    }
  } catch (e) {
    console.error('resolveCandidate search fallback:', e.message);
  }
  return null;
}

async function resolveCandidates(list, ytSearchFn, opts = {}) {
  const out = [];
  const seen = new Set();
  for (const c of list || []) {
    if (out.length >= (opts.limit || 10)) break;
    const item = await resolveCandidate(c, ytSearchFn, opts);
    if (item && item.videoId && !seen.has(item.videoId)) {
      seen.add(item.videoId);
      out.push(item);
    }
  }
  return out;
}

/** Static mood→seed candidates for offline / AI-less recommendation (no API) */
const MOOD_SEEDS = {
  relax: [
    { artist: 'Various', title: 'lofi hip hop radio', query: 'lofi hip hop radio beats to relax' },
    { artist: 'Various', title: 'chill acoustic', query: 'chill acoustic songs playlist' },
    { artist: 'Various', title: 'jazz piano relax', query: 'jazz piano relax instrumental' },
  ],
  workout: [
    { artist: 'Various', title: 'workout electronic', query: 'workout electronic mix 2024' },
    { artist: 'Various', title: 'gym motivation', query: 'gym motivation music high energy' },
  ],
  party: [
    { artist: 'Various', title: 'party mix', query: 'party dance mix official' },
  ],
  vi_relax: [
    { artist: 'Various', title: 'nhạc Việt chill', query: 'nhạc việt chill lofi' },
    { artist: 'Various', title: 'ballad Việt', query: 'nhạc ballad việt nam hay nhất' },
    { artist: 'Sơn Tùng M-TP', title: 'Chạy Ngay Đi', query: 'Sơn Tùng M-TP Chạy Ngay Đi official' },
    { artist: 'Đen', title: 'Trốn Tìm', query: 'Đen Trốn Tìm official' },
  ],
  karaoke: [
    { artist: 'Various', title: 'karaoke Việt', query: 'karaoke việt nam beat' },
  ],
  general: [
    { artist: 'Various', title: 'pop hits', query: 'official pop music hits' },
    { artist: 'Various', title: 'lofi', query: 'lofi hip hop radio' },
  ],
};

function seedCandidates(intent) {
  // Explicit search: only the user query — never pad with unrelated lofi seeds
  if (intent.intent === 'music_search' && intent.query) {
    const q = intent.query;
    return [
      { artist: '', title: q, query: q },
      { artist: '', title: q, query: q + ' official' },
      { artist: '', title: q, query: q + ' lyrics' },
    ];
  }
  if (intent.intent === 'karaoke') {
    const q = intent.query || 'karaoke';
    return [
      { artist: '', title: q, query: q + ' karaoke' },
      { artist: '', title: q, query: q + ' karaoke instrumental' },
      ...MOOD_SEEDS.karaoke,
    ];
  }
  if (intent.language === 'vi' || intent.region === 'VN') {
    if (intent.mood === 'relax') return MOOD_SEEDS.vi_relax;
    return [...MOOD_SEEDS.vi_relax, ...MOOD_SEEDS.general];
  }
  if (intent.mood && MOOD_SEEDS[intent.mood]) return MOOD_SEEDS[intent.mood];
  return MOOD_SEEDS.general;
}

function trendCacheGet(key) {
  const h = trendCache.get(key);
  if (!h) return null;
  if (Date.now() - h.at > TREND_TTL_MS) {
    trendCache.delete(key);
    return null;
  }
  return h.data;
}

function trendCacheSet(key, data) {
  trendCache.set(key, { at: Date.now(), data });
}


function rankWithTrends(items, context = {}) {
  const localIds = new Set();
  const globalIds = new Set();
  try {
    const local = trendCacheGet('popular:' + (context.region || 'US'));
    (local && local.items || []).forEach((it) => { if (it.videoId) localIds.add(it.videoId); });
  } catch (_) {}
  // any popular:* as weak global
  for (const [k, v] of trendCache.entries()) {
    if (String(k).startsWith('popular:')) {
      (v.data && v.data.items || []).forEach((it) => { if (it.videoId) globalIds.add(it.videoId); });
    }
  }
  return (items || [])
    .map((it) => {
      const localBoost = localIds.has(it.videoId) ? 1 : 0;
      const globalBoost = globalIds.has(it.videoId) ? 0.5 : 0;
      return Object.assign({}, it, {
        _score: scoreItem(it, Object.assign({}, context, { localBoost, globalBoost })),
      });
    })
    .sort((a, b) => (b._score || 0) - (a._score || 0));
}

module.exports = {
  normalizeQuery,
  cacheGet,
  cacheSet,
  getPreferences,
  recordPlay,
  scoreItem,
  rankWithTrends,
  parseIntent,
  localIntentParse,
  parsePlaylistCommand,
  playlistContentIntent,
  resolveCandidate,
  resolveCandidates,
  seedCandidates,
  trendCacheGet,
  trendCacheSet,
  MOOD_SEEDS,
  lookupKnown,
  KNOWN_VIDEOS,
};
