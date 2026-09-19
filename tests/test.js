'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

delete process.env.YOUTUBE_API_KEY;

const { createServer, getApiKey, mapYtError } = require('../server');

function request(server, urlPath) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data || '{}'); } catch (_) { json = {}; }
        resolve({ status: res.statusCode, json, raw: data });
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('Running Background Tube tests...');

  assert.strictEqual(getApiKey(), '');
  const quota = mapYtError(403, { error: { message: 'quotaExceeded', errors: [{ reason: 'quotaExceeded' }] } });
  assert.strictEqual(quota.code, 'quota_exceeded');
  const down = mapYtError(500, { error: { message: 'backend' } });
  assert.strictEqual(down.code, 'api_unavailable');

  const formatUrl = pathToFileURL(path.join(__dirname, '../public/js/format.js')).href;
  const { parseIsoDurationToSeconds, formatSeconds, formatIsoDuration } = await import(formatUrl);
  assert.strictEqual(parseIsoDurationToSeconds('PT4M13S'), 253);
  assert.strictEqual(formatSeconds(253), '4:13');
  assert.strictEqual(formatIsoDuration('PT1H2M3S'), '1:02:03');
  assert.strictEqual(formatSeconds(null), '--:--');

  const server = await new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const health = await request(server, '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.status, 'healthy');

    const status = await request(server, '/api/config-status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.json.apiKeyConfigured, false);
    assert.strictEqual(status.json.playback, 'youtube-iframe-api');
    assert.strictEqual(status.json.backgroundPlayback.supported, false);

    const search = await request(server, '/api/search?q=lofi');
    assert.strictEqual(search.status, 503);
    assert.strictEqual(search.json.code, 'missing_api_key');

    const popular = await request(server, '/api/popular');
    assert.strictEqual(popular.status, 503);

    const home = await request(server, '/');
    assert.strictEqual(home.status, 200);
    assert.ok(home.raw.includes('Background'));
    assert.ok(home.raw.includes('/js/main.js'));

    const css = await request(server, '/css/app.css');
    assert.strictEqual(css.status, 200);
    assert.ok(css.raw.includes('--brand'));

    console.log('All tests passed');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
