
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const REGION = (process.env.YOUTUBE_REGION || 'US').trim() || 'US';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_TTL_MS = 4 * 60 * 1000;
const cache = new Map();

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const adapter = require('./lib/app-adapter');
const musicEngine = require('./lib/music-engine');
const sessionManager = require('./lib/session-manager');
const { createAIService } = require('./lib/ai-module/ai-service');
const { createFeedbackService } = require('./lib/feedback-module/feedback-service');

const ai = createAIService({ dataDir: DATA_DIR, appName: 'Background Tube', adapter });
const fbOpts = {
  appId: 'background-tube',
  appName: 'Background Tube',
  version: '1.2.5',
  hubId: 'SHFH-CANNOI-0905428801',
  baseUrl: 'http://14.176.78.46:8090',
  ingestToken: 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9',
};
if (process.env.SHFH_HUB_ID) fbOpts.hubId = process.env.SHFH_HUB_ID;
if (process.env.SHFH_HUB_URL) fbOpts.baseUrl = process.env.SHFH_HUB_URL;
if (process.env.SHFH_BASE_URL) fbOpts.baseUrl = process.env.SHFH_BASE_URL;
if (process.env.SHFH_INGEST_TOKEN) fbOpts.ingestToken = process.env.SHFH_INGEST_TOKEN;
const feedback = createFeedbackService(fbOpts);

const rateMap = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  let e = rateMap.get(key);
  if (!e || t - e.start > windowMs) { e = { start: t, count: 0 }; rateMap.set(key, e); }
  e.count += 1;
  return e.count <= max;
}



/** Cached public base URL for QR pairing */
let cachedPublicIp = null;
let cachedPublicIpAt = 0;

async function detectPublicIp() {
  if (cachedPublicIp && Date.now() - cachedPublicIpAt < 30 * 60 * 1000) return cachedPublicIp;
  const endpoints = [
    'https://api.ipify.org?format=json',
    'https://ifconfig.me/ip',
  ];
  for (const ep of endpoints) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const r = await fetch(ep, { signal: controller.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const j = await r.json();
        const ip = j.ip || j.query;
        if (ip) { cachedPublicIp = String(ip).trim(); cachedPublicIpAt = Date.now(); return cachedPublicIp; }
      } else {
        const text = (await r.text()).trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) {
          cachedPublicIp = text; cachedPublicIpAt = Date.now(); return cachedPublicIp;
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * External port SoloHost/proxy exposes to browsers — NEVER prefer container internal 8080.
 * Priority: PUBLIC_PORT / HOST_PORT / EXTERNAL_PORT / SOLOHOST_PORT env
 *           → X-Forwarded-Port → port in Host / X-Forwarded-Host
 *           → omit (80/443) rather than defaulting to process.env.PORT (often 8080 in Docker)
 */
function getExternalPort(req) {
  const envKeys = ['PUBLIC_PORT', 'HOST_PORT', 'EXTERNAL_PORT', 'SOLOHOST_PORT', 'SOLOHOST_HOST_PORT', 'APP_HOST_PORT'];
  for (const k of envKeys) {
    const v = process.env[k];
    if (v && String(v).trim() && String(v).trim() !== '0') return String(v).trim();
  }
  const xfPort = String(req.headers['x-forwarded-port'] || '').split(',')[0].trim();
  if (xfPort) return xfPort;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const m = host.match(/:(\d+)$/);
  if (m) return m[1];
  return null; // no port in host → standard 80/443
}

function requestBaseUrl(req) {
  const envBase = (process.env.PUBLIC_BASE_URL || process.env.SHFH_PUBLIC_URL || process.env.SOLOHOST_PUBLIC_URL || '').replace(/\/$/, '');
  if (envBase) return { baseUrl: envBase, source: 'env' };

  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const xfHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const hostHeader = xfHost || String(req.headers.host || '').trim();
  const proto = xfProto || (req.socket && req.socket.encrypted ? 'https' : 'http');

  // Client-facing host:port from proxy/browser (SoloHost published address)
  if (hostHeader && !/^localhost\b|^127\.0\.0\.1\b|^0\.0\.0\.0\b|\[::1\]/i.test(hostHeader)) {
    return { baseUrl: proto + '://' + hostHeader, source: 'forwarded_host' };
  }
  return null;
}

function getApiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  return key && key.trim() && key !== 'your_youtube_api_key_here' ? key.trim() : '';
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 80) cache.delete(cache.keys().next().value);
}

function mapYtError(status, body) {
  const raw = (body && body.error && (body.error.message || body.error.status)) || '';
  const reason = (((body && body.error && body.error.errors) || [])[0] || {}).reason || '';
  if (status === 403 && /quota/i.test(raw + reason)) {
    return { status: 429, code: 'quota_exceeded', message: 'YouTube API quota exceeded. Try again later.' };
  }
  if (status === 400 && /key/i.test(raw + reason)) {
    return { status: 400, code: 'invalid_api_key', message: 'The server YouTube API key is invalid.' };
  }
  if (status === 403) {
    return { status: 403, code: 'api_forbidden', message: raw || 'YouTube API rejected the request.' };
  }
  if (status >= 500) {
    return { status: 503, code: 'api_unavailable', message: 'YouTube API is temporarily unavailable.' };
  }
  return { status: status || 502, code: 'api_error', message: raw || 'YouTube API error.' };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const index = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(index, (readErr, data) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    };
    // Allow mic for AI voice on this origin (Chrome Permissions-Policy)
    if (ext === '.html' || ext === '.js') {
      headers['Permissions-Policy'] = 'microphone=(self), camera=()';
      headers['Feature-Policy'] = "microphone 'self'";
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

async function ytGet(pathname, params, apiKey) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + pathname);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  url.searchParams.set('key', apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const mapped = mapYtError(response.status, data);
      const err = new Error(mapped.message);
      err.mapped = mapped;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const mapped = { status: 504, code: 'timeout', message: 'YouTube API request timed out.' };
      const timeoutErr = new Error(mapped.message);
      timeoutErr.mapped = mapped;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function pickThumb(thumbnails) {
  if (!thumbnails) return '';
  return (thumbnails.high || thumbnails.medium || thumbnails.standard || thumbnails.default || {}).url || '';
}

function mapSearchItem(item) {
  const snippet = item.snippet || {};
  return {
    videoId: item.id && item.id.videoId ? item.id.videoId : item.id,
    title: snippet.title || 'Untitled',
    description: snippet.description || '',
    thumbnail: pickThumb(snippet.thumbnails),
    channelTitle: snippet.channelTitle || '',
    channelId: snippet.channelId || '',
    publishedAt: snippet.publishedAt || null,
    duration: null,
    viewCount: null
  };
}

function mapVideoItem(item) {
  const snippet = item.snippet || {};
  return {
    videoId: item.id,
    title: snippet.title || 'Untitled',
    description: snippet.description || '',
    thumbnail: pickThumb(snippet.thumbnails),
    channelTitle: snippet.channelTitle || '',
    channelId: snippet.channelId || '',
    publishedAt: snippet.publishedAt || null,
    duration: (item.contentDetails && item.contentDetails.duration) || null,
    viewCount: (item.statistics && item.statistics.viewCount) || null
  };
}

async function attachDetails(items, apiKey) {
  const ids = items.map((i) => i.videoId).filter(Boolean);
  if (!ids.length) return items;
  const data = await ytGet('videos', {
    part: 'contentDetails,statistics,status,snippet',
    id: ids.join(',')
  }, apiKey);
  const map = {};
  (data.items || []).forEach((v) => { map[v.id] = v; });
  return items
    .map((item) => {
      const extra = map[item.videoId];
      if (!extra) return null;
      return {
        ...item,
        title: extra.snippet && extra.snippet.title ? extra.snippet.title : item.title,
        thumbnail: pickThumb(extra.snippet && extra.snippet.thumbnails) || item.thumbnail,
        duration: extra.contentDetails && extra.contentDetails.duration ? extra.contentDetails.duration : null,
        viewCount: extra.statistics && extra.statistics.viewCount ? extra.statistics.viewCount : null,
        embeddable: extra.status && extra.status.embeddable === false ? false : true
      };
    })
    .filter(Boolean);
}

function requireKey(res) {
  const apiKey = getApiKey();
  if (!apiKey) {
    sendJson(res, 503, {
      error: 'API key not configured',
      code: 'missing_api_key',
      message: 'The app owner has not configured a YouTube Data API v3 key on the server yet.'
    });
    return null;
  }
  return apiKey;
}

async function handleSearch(url, res) {
  const apiKey = requireKey(res);
  if (!apiKey) return;
  const query = String(url.searchParams.get('q') || '').trim();
  const pageToken = String(url.searchParams.get('pageToken') || '').trim();
  const maxResults = Math.min(20, Math.max(5, Number(url.searchParams.get('maxResults') || 16)));
  if (!query) {
    sendJson(res, 400, { error: 'Query required', code: 'bad_request', message: 'Enter a song, artist, or keyword.' });
    return;
  }
  const cacheKey = `search:${query}:${pageToken}:${maxResults}`;
  const cached = cacheGet(cacheKey);
  if (cached) return sendJson(res, 200, cached);
  try {
    const data = await ytGet('search', {
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults,
      q: query,
      pageToken,
      safeSearch: 'moderate'
    }, apiKey);
    let items = (data.items || []).map(mapSearchItem).filter((i) => i.videoId);
    try { items = await attachDetails(items, apiKey); } catch (enrichErr) {
      console.error('Duration enrichment failed:', enrichErr.message);
    }
    const payload = {
      items,
      nextPageToken: data.nextPageToken || null,
      prevPageToken: data.prevPageToken || null,
      total: (data.pageInfo && data.pageInfo.totalResults) || items.length
    };
    cacheSet(cacheKey, payload);
    sendJson(res, 200, payload);
  } catch (err) {
    const mapped = err.mapped || { status: 500, code: 'network_error', message: 'Failed to reach YouTube API.' };
    console.error('search error:', mapped.code, err.message);
    sendJson(res, mapped.status, { error: mapped.message, code: mapped.code, message: mapped.message });
  }
}

async function handlePopular(url, res) {
  const apiKey = requireKey(res);
  if (!apiKey) return;
  const regionCode = String(url.searchParams.get('regionCode') || REGION).slice(0, 2).toUpperCase();
  const cacheKey = `popular:${regionCode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return sendJson(res, 200, cached);
  try {
    const data = await ytGet('videos', {
      part: 'snippet,contentDetails,statistics,status',
      chart: 'mostPopular',
      videoCategoryId: '10',
      maxResults: 12,
      regionCode
    }, apiKey);
    const items = (data.items || []).map(mapVideoItem).filter((i) => i.videoId);
    const payload = { items, regionCode };
    cacheSet(cacheKey, payload);
    sendJson(res, 200, payload);
  } catch (err) {
    const mapped = err.mapped || { status: 500, code: 'network_error', message: 'Failed to load popular music.' };
    sendJson(res, mapped.status, { error: mapped.message, code: mapped.code, message: mapped.message, items: [] });
  }
}

async function handleVideos(url, res) {
  const apiKey = requireKey(res);
  if (!apiKey) return;
  const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!ids.length) {
    sendJson(res, 400, { error: 'ids required', code: 'bad_request', message: 'Provide video ids.' });
    return;
  }
  try {
    const data = await ytGet('videos', { part: 'snippet,contentDetails,statistics,status', id: ids.join(',') }, apiKey);
    sendJson(res, 200, { items: (data.items || []).map(mapVideoItem) });
  } catch (err) {
    const mapped = err.mapped || { status: 500, code: 'network_error', message: 'Failed to load videos.' };
    sendJson(res, mapped.status, { error: mapped.message, code: mapped.code, message: mapped.message });
  }
}


function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error('body_too_large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function ytSearchMinimal(query, maxResults = 3) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('missing_api_key');
  const nq = musicEngine.normalizeQuery(query);
  const cached = musicEngine.cacheGet(nq);
  if (cached && cached.videoId) {
    return { items: [{ videoId: cached.videoId, title: cached.title, channelTitle: cached.artist, thumbnail: cached.thumbnail, duration: cached.duration }] };
  }
  const cacheKey = `resolve:${nq}:${maxResults}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;
  const data = await ytGet('search', {
    part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults, q: query, safeSearch: 'moderate'
  }, apiKey);
  let items = (data.items || []).map(mapSearchItem).filter((i) => i.videoId);
  try { items = await attachDetails(items, apiKey); } catch (_) {}
  const payload = { items };
  cacheSet(cacheKey, payload);
  return payload;
}

async function handleMusicAI(body, res) {
  const message = String(body.message || body.query || '').trim();
  if (!message) { sendJson(res, 400, { ok: false, error: 'message required' }); return; }

  let intent = null;
  let aiReply = null;
  let actions = [];
  let usedSearchApi = false;
  const history = Array.isArray(body.history) ? body.history : [];

  // 1) Local intent FIRST — DJ-like controls without AI lag
  intent = musicEngine.localIntentParse(message);

  // 2) AI only when local is weak (generic search with vague text still OK)
  const simpleControl = intent && intent.intent === 'player_control';
  const simpleQueue = intent && intent.intent === 'queue_operation';
  const needsAI = !simpleControl && !simpleQueue && ai.configured() && (
    /giống|similar|gợi ý|recommend|theo mood|buổi tối|thư giãn|dễ hát|đang hot|top|playlist/i.test(message)
  );

  if (needsAI) {
    try {
      const systemHint = 'You are a music DJ. Reply briefly in the user language. ALWAYS include a JSON line: {"intent":"music_search|recommendation|karaoke|player_control","query":"...","mood":"...","language":"vi|en|ja","limit":8,"autoPlay":true,"candidates":[{"artist":"","title":""}]}';
      const out = await ai.chat({
        message: message + '\n\n' + systemHint,
        history: history.slice(-6),
        context: body.context || {},
      });
      aiReply = out.reply || '';
      actions = out.actions || [];
      const parsed = musicEngine.parseIntent(aiReply) || null;
      if (parsed && parsed.intent && parsed.intent !== 'help') {
        // merge: keep local autoPlay default
        intent = Object.assign({ autoPlay: true }, intent || {}, parsed);
      }
      if (intent && !intent.candidates && /recommendation|music_search|karaoke/.test(intent.intent || '')) {
        const lines = String(aiReply).split('\n').map((l) => l.replace(/^\d+[).\s-]+/, '').trim()).filter(Boolean);
        const cands = [];
        for (const line of lines.slice(0, 12)) {
          if (line.length < 4 || line.length > 100) continue;
          if (/^(here|dưới|sau|i recommend|gợi ý|json|intent)/i.test(line)) continue;
          if (line.startsWith('{')) continue;
          const parts = line.split(/\s[-–—|]\s/);
          if (parts.length >= 2) cands.push({ artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() });
          else cands.push({ artist: '', title: line, query: line });
        }
        if (cands.length) intent.candidates = cands;
      }
    } catch (e) {
      console.warn('music AI provider', e.message || e);
    }
  }

  if (!intent) intent = musicEngine.localIntentParse(message);
  if (!intent) intent = { intent: 'music_search', query: message, limit: 8, autoPlay: true };

  const validIntents = new Set(['player_control', 'music_search', 'recommendation', 'queue_operation', 'karaoke', 'library', 'help']);
  if (!validIntents.has(intent.intent)) {
    intent = { intent: 'music_search', query: message, limit: 8, autoPlay: true };
  }

  // Default autoPlay for music requests (DJ behavior)
  if (intent.intent === 'music_search' || intent.intent === 'recommendation' || intent.intent === 'karaoke') {
    if (intent.autoPlay === undefined) intent.autoPlay = true;
  }

  if (intent.intent === 'player_control') {
    const act = intent.action || 'play';
    const args = {};
    if (intent.value != null) {
      if (act === 'seek') args.seconds = intent.value;
      else if (act === 'volume') args.level = intent.value;
      else if (act === 'sleep') args.minutes = intent.value;
      else args.value = intent.value;
    }
    let reply = aiReply;
    if (!reply) {
      if (act === 'now_playing') {
        const t = (body.context && body.context.title) || null;
        reply = t ? ('Now playing: ' + t + (body.context.channel ? ' · ' + body.context.channel : '')) : 'Nothing is playing.';
      } else if (act === 'queue_status') {
        reply = 'Queue has ' + ((body.context && body.context.queueLength) || 0) + ' track(s).';
      } else if (act === 'sleep') {
        reply = (intent.value === 0) ? 'Sleep timer cleared.' : ('Sleep timer: ' + intent.value + ' min.');
      } else {
        reply = 'OK · ' + act;
      }
    }
    sendJson(res, 200, {
      ok: true, intent, reply,
      actions: [{ name: act, args, client_execute: true }],
      items: [],
    });
    return;
  }

  if (intent.intent === 'queue_operation') {
    const act = intent.action || 'queue_clear';
    sendJson(res, 200, {
      ok: true, intent, reply: aiReply || ('OK · ' + act),
      actions: [{ name: act, args: {}, client_execute: true }],
      items: [],
    });
    return;
  }

  if (intent.intent === 'help') {
    sendJson(res, 200, {
      ok: true, intent,
      reply: aiReply || (await adapter.localReply(message, body.context || {})),
      items: [], actions: [],
    });
    return;
  }

  // Resolve playable tracks
  let candidates = intent.candidates && intent.candidates.length ? intent.candidates : musicEngine.seedCandidates(intent);
  if (intent.intent === 'music_search' && intent.query) {
    candidates = [{ artist: '', title: intent.query, query: intent.query }, ...candidates];
  }
  if (intent.intent === 'karaoke') {
    const q = intent.query || message;
    candidates = [
      { artist: '', title: q + ' karaoke', query: q + ' karaoke' },
      { artist: '', title: q, query: q },
      ...candidates,
    ];
  }

  let items = [];
  try {
    items = await musicEngine.resolveCandidates(
      candidates.slice(0, intent.limit || 8),
      async (q, n) => { usedSearchApi = true; return ytSearchMinimal(q, n); },
      { limit: intent.limit || 8, history }
    );
  } catch (e) {
    console.warn('resolveCandidates', e.message || e);
  }

  if (!items.length && (intent.query || message) && getApiKey()) {
    try {
      usedSearchApi = true;
      const q = intent.intent === 'karaoke'
        ? ((intent.query || message) + ' karaoke')
        : (intent.query || message);
      const data = await ytSearchMinimal(q, intent.limit || 8);
      items = data.items || [];
    } catch (e) {
      console.warn('yt fallback', e.message || e);
    }
  }

  items = musicEngine.rankWithTrends(items, { mood: intent.mood, region: intent.region || process.env.REGION || 'VN' });

  const autoPlay = intent.autoPlay !== false && !intent.queueOnly;
  const reply = aiReply
    || (items.length
      ? (autoPlay
          ? ('▶ ' + (items[0].title || 'Track') + (items.length > 1 ? ' · +' + (items.length - 1) + ' in queue' : ''))
          : ('Found ' + items.length + ' track(s).'))
      : 'No playable tracks. Add a YouTube API key in server env or try Search tab.');

  sendJson(res, 200, {
    ok: true,
    intent,
    reply,
    usedSearchApi,
    items,
    actions: items[0]
      ? [{ name: 'queue_add', args: { items, autoPlay, playNext: !!intent.playNext }, client_execute: true }]
      : actions,
  });
}


async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const ip = req.socket.remoteAddress || 'local';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { status: 'healthy', app: 'Background Tube', version: '1.2.5', timestamp: new Date().toISOString() });
  }

  if (url.pathname === '/api/config-status' && req.method === 'GET') {
    return sendJson(res, 200, {
      apiKeyConfigured: Boolean(getApiKey()),
      playback: 'youtube-iframe-api',
      backgroundPlayback: { supported: false, reason: 'Official YouTube IFrame embeds pause when the browser tab is backgrounded on most mobile browsers.' },
      oauthReady: false, region: REGION,
      features: { ai: true, feedback: true, voiceSearch: true, karaoke: true, remote: true, session: true }
    });
  }

  if (url.pathname === '/api/search' && req.method === 'GET') return handleSearch(url, res);
  if (url.pathname === '/api/popular' && req.method === 'GET') return handlePopular(url, res);
  if (url.pathname === '/api/videos' && req.method === 'GET') return handleVideos(url, res);

  // AI
  if (url.pathname === '/api/ai/status' && req.method === 'GET') return sendJson(res, 200, { ok: true, configured: ai.configured(), settings: ai.publicSettings() });
  if (url.pathname === '/api/ai/catalog' && req.method === 'GET') return sendJson(res, 200, { providers: ai.catalog() });
  if (url.pathname === '/api/ai/settings' && req.method === 'GET') return sendJson(res, 200, ai.publicSettings());
  if (url.pathname === '/api/ai/settings' && req.method === 'POST') {
    try { const body = await readBody(req); return sendJson(res, 200, { ok: true, settings: ai.saveSettings(body || {}) }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (url.pathname === '/api/ai/models' && req.method === 'GET') {
    try { return sendJson(res, 200, await ai.refreshModels()); }
    catch (e) { return sendJson(res, 502, { ok: false, error: String(e.message || e).slice(0, 200) }); }
  }
  if (url.pathname === '/api/ai/test' && req.method === 'POST') {
    try { return sendJson(res, 200, await ai.testConnection()); }
    catch (e) { return sendJson(res, 502, { ok: false, error: String(e.message || e).slice(0, 200) }); }
  }
  if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
    if (!rateLimit('ai:' + ip, 30, 60000)) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    try {
      const body = await readBody(req);
      if (!body.message) return sendJson(res, 400, { ok: false, error: 'message required' });
      const out = await ai.chat({ message: body.message, history: Array.isArray(body.history) ? body.history.slice(-8) : [], context: body.context || {} });
      return sendJson(res, 200, out);
    } catch (e) { return sendJson(res, 502, { ok: false, error: String(e.message || e).slice(0, 200) }); }
  }
  if (url.pathname === '/api/logs' && req.method === 'GET') return sendJson(res, 200, { logs: ai.readLogs() });
  if (url.pathname === '/api/logs' && req.method === 'DELETE') { ai.clearLogs(); return sendJson(res, 200, { ok: true }); }

  // Feedback
  if (url.pathname === '/api/feedback/config' && req.method === 'GET') return sendJson(res, 200, feedback.publicConfig());
  if (url.pathname === '/api/feedback/sync' && req.method === 'GET') {
    try { return sendJson(res, 200, await feedback.sync(String(url.searchParams.get('anonymous_id') || ''))); }
    catch { return sendJson(res, 502, { ok: false, error: 'Feedback Hub unavailable' }); }
  }
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    if (!rateLimit('fb:' + ip, 20, 60000)) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    try {
      const body = await readBody(req);
      const safe = Object.assign({}, body, { app_id: feedback.appId, app_name: feedback.appName, version: feedback.version });
      delete safe.apiKey; delete safe.token; delete safe.password; delete safe.ingestToken;
      return sendJson(res, 200, await feedback.send(safe));
    } catch { return sendJson(res, 502, { ok: false, error: 'Feedback Hub unavailable' }); }
  }
  if (url.pathname.startsWith('/api/feedback/read/') && req.method === 'POST') {
    const id = decodeURIComponent(url.pathname.replace('/api/feedback/read/', ''));
    try { return sendJson(res, 200, await feedback.markRead(id)); } catch { return sendJson(res, 502, { ok: false }); }
  }

  // Music AI
  if (url.pathname === '/api/music/ai' && req.method === 'POST') {
    if (!rateLimit('music:' + ip, 40, 60000)) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    try { return handleMusicAI(await readBody(req), res); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (url.pathname === '/api/music/resolve' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 15) : [];
      const items = await musicEngine.resolveCandidates(candidates, ytSearchMinimal, { limit: body.limit || 10, history: body.history || [] });
      return sendJson(res, 200, { ok: true, items });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (url.pathname === '/api/music/recommendations' && req.method === 'GET') {
    const mood = String(url.searchParams.get('mood') || 'general');
    const language = String(url.searchParams.get('language') || '');
    const intent = { intent: 'recommendation', mood, language, region: language === 'vi' ? 'VN' : undefined, limit: 8 };
    const seeds = musicEngine.seedCandidates(intent);
    let items = [];
    try { items = await musicEngine.resolveCandidates(seeds, getApiKey() ? ytSearchMinimal : null, { limit: 8 }); } catch (_) {}
    return sendJson(res, 200, { ok: true, items, preferences: musicEngine.getPreferences() });
  }
  if (url.pathname === '/api/music/trending/local' && req.method === 'GET') {
    url.searchParams.set('regionCode', url.searchParams.get('region') || REGION);
    return handlePopular(url, res);
  }
  if (url.pathname === '/api/music/trending/global' && req.method === 'GET') {
    const regions = ['US', 'GB', 'JP', 'KR', 'VN'];
    const all = []; const seen = new Set();
    for (const rc of regions) {
      const key = 'popular:' + rc;
      let payload = cacheGet(key) || musicEngine.trendCacheGet(key);
      if (!payload && getApiKey()) {
        try {
          const data = await ytGet('videos', { part: 'snippet,contentDetails,statistics,status', chart: 'mostPopular', videoCategoryId: '10', maxResults: 6, regionCode: rc }, getApiKey());
          payload = { items: (data.items || []).map(mapVideoItem), regionCode: rc };
          cacheSet(key, payload); musicEngine.trendCacheSet(key, payload);
        } catch (_) { payload = { items: [] }; }
      }
      (payload && payload.items || []).forEach((it) => { if (it.videoId && !seen.has(it.videoId)) { seen.add(it.videoId); all.push(it); } });
    }
    return sendJson(res, 200, { ok: true, items: all.slice(0, 24) });
  }
  if (url.pathname === '/api/music/preferences' && req.method === 'GET') return sendJson(res, 200, musicEngine.getPreferences());
  if (url.pathname === '/api/music/preferences/record' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      musicEngine.recordPlay(body.item, { completed: body.completed, skipped: body.skipped });
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  // Session
  
  // Shared default room — all clients join here when sync is ON
  if (url.pathname === '/api/session/room' && req.method === 'GET') {
    const room = sessionManager.getDefaultRoom();
    return sendJson(res, 200, { ok: true, state: sessionManager.publicState(room), sessionId: room.sessionId });
  }
  if (url.pathname === '/api/session/room' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const room = sessionManager.getDefaultRoom();
    const state = sessionManager.joinSession(room.sessionId, body.clientId || sessionManager.id());
    return sendJson(res, 200, { ok: true, state: state || sessionManager.publicState(room), sessionId: room.sessionId });
  }

  if (url.pathname === '/api/session' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const s = sessionManager.createSession(body.leaderId);
    return sendJson(res, 200, { ok: true, state: sessionManager.publicState(s) });
  }
  if (url.pathname.startsWith('/api/session/') && req.method === 'GET' && !url.pathname.includes('/command') && !url.pathname.includes('/join') && !url.pathname.includes('/events')) {
    const sid = url.pathname.split('/')[3];
    const s = sessionManager.getSession(sid);
    if (!s) return sendJson(res, 404, { ok: false, error: 'session_not_found' });
    return sendJson(res, 200, { ok: true, state: sessionManager.publicState(s) });
  }
  if (url.pathname.match(/^\/api\/session\/[^/]+\/join$/) && req.method === 'POST') {
    const sid = url.pathname.split('/')[3];
    const body = await readBody(req).catch(() => ({}));
    const state = sessionManager.joinSession(sid, body.clientId);
    if (!state) return sendJson(res, 404, { ok: false, error: 'session_not_found' });
    return sendJson(res, 200, { ok: true, state });
  }
  if (url.pathname.match(/^\/api\/session\/[^/]+\/command$/) && req.method === 'POST') {
    if (!rateLimit('cmd:' + ip, 120, 60000)) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    const sid = url.pathname.split('/')[3];
    const body = await readBody(req).catch(() => ({}));
    if (body.token) {
      const tok = sessionManager.validateToken(body.token);
      if (!tok || tok.sessionId !== sid) return sendJson(res, 403, { ok: false, error: 'invalid_token' });
    }
    const result = sessionManager.applyCommand(sid, body, body.clientId);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // Remote
  if (url.pathname === '/api/public-url' && req.method === 'GET') {
    try {
      const internalPort = Number(process.env.PORT || 8080);
      let base = null;
      let source = null;
      let externalPort = getExternalPort(req);
      const ip = await detectPublicIp();

      const fromReq = requestBaseUrl(req);
      // Host port from browser/proxy is the SoloHost published port when user is already connected
      if (!externalPort && fromReq && fromReq.baseUrl) {
        const pm = String(fromReq.baseUrl).match(/:(\d+)$/);
        if (pm) externalPort = pm[1];
      }

      if (ip && externalPort) {
        // Canonical remote URL: public IP + SoloHost external port (never force container PORT)
        base = 'http://' + ip + ':' + externalPort;
        source = 'public_ip_external_port';
      } else if (fromReq && fromReq.baseUrl) {
        base = fromReq.baseUrl;
        source = fromReq.source;
      } else if (ip) {
        base = 'http://' + ip;
        source = 'public_ip_no_port';
      } else {
        base = 'http://127.0.0.1' + (externalPort ? ':' + externalPort : '');
        source = 'fallback_local';
      }

      return sendJson(res, 200, {
        ok: true,
        baseUrl: String(base).replace(/\/$/, ''),
        source: source,
        externalPort: externalPort || null,
        internalPort: internalPort,
        publicIp: ip || null,
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }


  if (url.pathname === '/api/remote/pair' && req.method === 'POST') {
    if (!rateLimit('pair:' + ip, 20, 60000)) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    const body = await readBody(req).catch(() => ({}));
    let sid = body.sessionId;
    if (!sid || !sessionManager.getSession(sid)) {
      const s = sessionManager.createSession(body.leaderId);
      sid = s.sessionId;
    }
    const pairing = sessionManager.createPairingToken(sid, body.role || 'remote');
    if (!pairing) return sendJson(res, 400, { ok: false, error: 'pair_failed' });
    return sendJson(res, 200, {
      ok: true, sessionId: sid, token: pairing.token, exp: pairing.exp, role: pairing.role,
      path: '/remote?s=' + sid + '&t=' + pairing.token + '&r=' + pairing.role
    });
  }
  // SSE live session events
  if (url.pathname.match(/^\/api\/session\/[^/]+\/events$/) && req.method === 'GET') {
    const sid = url.pathname.split('/')[3];
    const clientId = String(url.searchParams.get('clientId') || sessionManager.id());
    const token = url.searchParams.get('token');
    if (token) {
      const tok = sessionManager.validateToken(token);
      if (!tok || tok.sessionId !== sid) {
        return sendJson(res, 403, { ok: false, error: 'invalid_token' });
      }
    }
    if (!sessionManager.getSession(sid)) {
      return sendJson(res, 404, { ok: false, error: 'session_not_found' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': ok\n\n');
    sessionManager.subscribe(sid, res, clientId);
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); }
    }, 25000);
    req.on('close', () => clearInterval(hb));
    return;
  }

  if (url.pathname === '/api/remote/revoke' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return sendJson(res, 200, { ok: sessionManager.revokeToken(body.token) });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  sendFile(res, filePath);
}

function createServer() {
  return http.createServer(handleRequest);
}

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log('Background Tube v1.3.0 running on 0.0.0.0:' + PORT);
  });
}

module.exports = { createServer, getApiKey, mapYtError, attachDetails };
