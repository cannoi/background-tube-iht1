'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const REGION = (process.env.YOUTUBE_REGION || 'US').trim() || 'US';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_TTL_MS = 4 * 60 * 1000;
const cache = new Map();

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

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'healthy',
      app: 'Background Tube',
      version: '1.1.0',
      timestamp: new Date().toISOString()
    });
  }

  if (url.pathname === '/api/config-status') {
    return sendJson(res, 200, {
      apiKeyConfigured: Boolean(getApiKey()),
      playback: 'youtube-iframe-api',
      backgroundPlayback: {
        supported: false,
        reason: 'Official YouTube IFrame embeds pause when the browser tab is backgrounded on most mobile browsers. Lock-screen controls work only while the page remains active and the platform allows Media Session.'
      },
      oauthReady: false,
      region: REGION
    });
  }

  if (url.pathname === '/api/search') return handleSearch(url, res);
  if (url.pathname === '/api/popular') return handlePopular(url, res);
  if (url.pathname === '/api/videos') return handleVideos(url, res);

  const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  sendFile(res, filePath);
}

function createServer() {
  return http.createServer(handleRequest);
}

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`Background Tube running on port ${PORT}`);
  });
}

module.exports = { createServer, getApiKey, mapYtError, attachDetails };
