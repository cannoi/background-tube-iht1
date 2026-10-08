
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
  version: '1.2.0',
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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
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

  if (ai.configured()) {
    try {
      const systemHint = 'For music requests include JSON intent when possible: {"intent":"player_control|music_search|recommendation|karaoke|help","action":"...","query":"...","mood":"...","language":"...","limit":8,"autoPlay":true,"candidates":[{"artist":"...","title":"..."}]}';
      const out = await ai.chat({
        message: message + '\n\n' + systemHint,
        history: Array.isArray(body.history) ? body.history.slice(-6) : [],
        context: body.context || {},
      });
      aiReply = out.reply || '';
      actions = out.actions || [];
      intent = musicEngine.parseIntent(aiReply) || null;
      if (intent && !intent.candidates && /recommendation|music_search|karaoke/.test(intent.intent)) {
        const lines = String(aiReply).split('\n').map((l) => l.replace(/^\d+[\).\s-]+/, '').trim()).filter(Boolean);
        const cands = [];
        for (const line of lines.slice(0, 15)) {
          if (line.length < 4 || line.length > 120) continue;
          if (/^(here|duoi|sau|i recommend|goi y)/i.test(line)) continue;
          const parts = line.split(/\s[-–—|]\s/);
          if (parts.length >= 2) cands.push({ artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), query: line });
          else cands.push({ artist: '', title: line, query: line });
        }
        if (cands.length) intent.candidates = cands;
      }
    } catch (e) { console.error('AI music chat fail:', e.message); }
  }

  if (!intent) intent = musicEngine.localIntentParse(message);
  const validIntents = new Set(['player_control', 'music_search', 'recommendation', 'queue_operation', 'karaoke', 'library', 'help']);
  if (!intent || !validIntents.has(intent.intent)) {
    sendJson(res, 200, { ok: true, intent: { intent: 'help' }, reply: aiReply || (await adapter.localReply(message, body.context || {})), items: [], actions });
    return;
  }

  if (intent.intent === 'player_control') {
    sendJson(res, 200, { ok: true, intent, reply: aiReply || ('OK: ' + (intent.action || 'control')), actions: [{ name: intent.action || 'play', args: {}, client_execute: true }], items: [] });
    return;
  }
  if (intent.intent === 'help') {
    sendJson(res, 200, { ok: true, intent, reply: aiReply || (await adapter.localReply(message, body.context || {})), items: [], actions });
    return;
  }

  let candidates = intent.candidates && intent.candidates.length ? intent.candidates : musicEngine.seedCandidates(intent);
  if (intent.intent === 'music_search' && intent.query) candidates = [{ artist: '', title: intent.query, query: intent.query }, ...candidates];
  if (intent.intent === 'karaoke') {
    const q = intent.query || message;
    candidates = [{ artist: '', title: q, query: q + ' karaoke' }, { artist: '', title: q, query: q + ' karaoke beat' }, ...candidates];
  }

  const history = Array.isArray(body.historyTracks) ? body.historyTracks : [];
  let items = [];
  let usedSearchApi = false;
  try {
    items = await musicEngine.resolveCandidates(candidates.slice(0, intent.limit || 8), async (q, n) => { usedSearchApi = true; return ytSearchMinimal(q, n); }, { limit: intent.limit || 8, history });
  } catch (e) { console.error('resolve candidates:', e.message); }

  if (!items.length && (intent.query || message) && getApiKey()) {
    try {
      usedSearchApi = true;
      const data = await ytSearchMinimal(intent.intent === 'karaoke' ? ((intent.query || message) + ' karaoke') : (intent.query || message), intent.limit || 8);
      items = data.items || [];
    } catch (e) { console.error('fallback search:', e.message); }
  }

  items = items.map((it) => Object.assign({}, it, { _score: musicEngine.scoreItem(it, { mood: intent.mood }) })).sort((a, b) => (b._score || 0) - (a._score || 0));

  sendJson(res, 200, {
    ok: true, intent,
    reply: aiReply || (items.length ? ('Found ' + items.length + ' track(s).' + (intent.autoPlay ? ' Playing…' : '')) : 'No playable tracks resolved. Try Search.'),
    items,
    actions: actions.length ? actions : (intent.autoPlay && items[0] ? [{ name: 'queue_add', args: { items }, client_execute: true }] : []),
    quota: { usedSearchApi, cachedFirst: !usedSearchApi },
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
    return sendJson(res, 200, { status: 'healthy', app: 'Background Tube', version: '1.2.0', timestamp: new Date().toISOString() });
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
  if (url.pathname === '/api/session' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const s = sessionManager.createSession(body.leaderId);
    return sendJson(res, 200, { ok: true, state: sessionManager.publicState(s) });
  }
  if (url.pathname.startsWith('/api/session/') && req.method === 'GET' && !url.pathname.includes('/command') && !url.pathname.includes('/join')) {
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
    console.log('Background Tube v1.2.0 running on 0.0.0.0:' + PORT);
  });
}

module.exports = { createServer, getApiKey, mapYtError, attachDetails };
