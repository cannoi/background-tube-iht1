'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { createServer, getApiKey, mapYtError } = require('../server');

function request(server, p, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: p,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data || '{}'); } catch (_) {}
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
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

  // Music engine unit
  const music = require('../lib/music-engine');
  assert.ok(music.normalizeQuery('  Sơn Tùng  '));
  const intent = music.localIntentParse('Next');
  assert.strictEqual(intent.intent, 'player_control');
  assert.strictEqual(intent.action, 'next');
  const rec = music.localIntentParse('Cho tôi 10 bài nhạc Việt chill');
  assert.strictEqual(rec.intent, 'recommendation');
  const seeds = music.seedCandidates(rec);
  assert.ok(seeds.length > 0);

  // Session
  const sm = require('../lib/session-manager');
  const s = sm.createSession('leader1');
  assert.ok(s.sessionId);
  const pair = sm.createPairingToken(s.sessionId, 'remote');
  assert.ok(pair.token);
  assert.ok(sm.validateToken(pair.token));
  sm.revokeToken(pair.token);
  assert.strictEqual(sm.validateToken(pair.token), null);
  const cmd = sm.applyCommand(s.sessionId, { type: 'play', position: 10 });
  assert.ok(cmd.ok);
  assert.strictEqual(cmd.state.playing, true);

  // Adapter
  const adapter = require('../lib/app-adapter');
  const lr = await adapter.localReply('help', {});
  assert.ok(lr && lr.length > 10);

  const server = await new Promise((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => resolve(srv));
  });

  try {
    const health = await request(server, '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.status, 'healthy');

    const status = await request(server, '/api/config-status');
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.json.apiKeyConfigured, false);
    assert.ok(status.json.features.ai);

    const search = await request(server, '/api/search?q=lofi');
    assert.strictEqual(search.status, 503);
    assert.strictEqual(search.json.code, 'missing_api_key');

    const popular = await request(server, '/api/popular');
    assert.strictEqual(popular.status, 503);

    // AI
    const aiStatus = await request(server, '/api/ai/status');
    assert.strictEqual(aiStatus.status, 200);
    assert.strictEqual(aiStatus.json.ok, true);

    const catalog = await request(server, '/api/ai/catalog');
    assert.ok(catalog.json.providers.length >= 8);

    const settings = await request(server, '/api/ai/settings');
    assert.ok('maskedKey' in settings.json || 'hasKey' in settings.json);

    const chat = await request(server, '/api/ai/chat', 'POST', { message: 'help' });
    assert.strictEqual(chat.status, 200);
    assert.ok(chat.json.reply);

    // Feedback config must NOT leak ingest token
    const fbCfg = await request(server, '/api/feedback/config');
    assert.strictEqual(fbCfg.status, 200);
    assert.ok(!JSON.stringify(fbCfg.json).includes('cannoi_'));
    assert.ok(!('ingestToken' in fbCfg.json));

    // Music AI local intent
    const mai = await request(server, '/api/music/ai', 'POST', { message: 'pause' });
    assert.strictEqual(mai.status, 200);
    assert.strictEqual(mai.json.intent.intent, 'player_control');

    const mai2 = await request(server, '/api/music/ai', 'POST', { message: 'Cho tôi nhạc Việt chill' });
    assert.strictEqual(mai2.status, 200);
    assert.ok(mai2.json.intent);

    // Session API
    const sess = await request(server, '/api/session', 'POST', {});
    assert.strictEqual(sess.status, 200);
    assert.ok(sess.json.state.sessionId);
    const sid = sess.json.state.sessionId;
    const st = await request(server, '/api/session/' + sid);
    assert.strictEqual(st.status, 200);

    const pairApi = await request(server, '/api/remote/pair', 'POST', { sessionId: sid, role: 'remote' });
    assert.strictEqual(pairApi.status, 200);
    assert.ok(pairApi.json.token);
    assert.ok(!JSON.stringify(pairApi.json).includes('YOUTUBE'));
    assert.ok(!JSON.stringify(pairApi.json).includes('apiKey'));

    const home = await request(server, '/');
    assert.strictEqual(home.status, 200);
    assert.ok(home.raw.includes('Background'));
    assert.ok(home.raw.includes('aiFab') || home.raw.includes('ai-fab'));

    const css = await request(server, '/css/app.css');
    assert.strictEqual(css.status, 200);

    
  // Session SSE subscribe exists
  const sess2 = await request(server, '/api/session', 'POST', {});
  const sid2 = sess2.json.state.sessionId;
  const cmdLoad = await request(server, '/api/session/' + sid2 + '/command', 'POST', {
    type: 'load',
    track: { videoId: 'dQw4w9WgXcQ', title: 'Test' },
    queue: [{ videoId: 'dQw4w9WgXcQ', title: 'Test' }],
    index: 0,
    playing: true,
    position: 5
  });
  assert.ok(cmdLoad.json.ok);
  assert.strictEqual(cmdLoad.json.state.playing, true);
  assert.strictEqual(cmdLoad.json.state.track.videoId, 'dQw4w9WgXcQ');

  // Music engine known + rank
  assert.ok(typeof music.rankWithTrends === 'function');
  const ranked = music.rankWithTrends([
    { videoId: 'a', title: 'x', channelTitle: 'y' },
    { videoId: 'b', title: 'z', channelTitle: 'w' }
  ], { mood: 'relax' });
  assert.ok(Array.isArray(ranked));

  // Preference weights order documented
  const pref = music.getPreferences();
  assert.ok(pref.weights.personalPreference >= pref.weights.localTrend);
  assert.ok(pref.weights.localTrend >= pref.weights.globalTrend);

    console.log('All tests passed');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
