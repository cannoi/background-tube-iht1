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

    
  assert.strictEqual(music.localIntentParse('stop').action, 'stop');
  assert.strictEqual(music.localIntentParse('sleep 30').action, 'sleep');
  assert.strictEqual(music.localIntentParse('sleep 30').value, 30);
  assert.strictEqual(music.localIntentParse('volume 40').action, 'volume');
  assert.strictEqual(music.localIntentParse('clear queue').action, 'queue_clear');
  const sleepCmd = await request(server, '/api/music/ai', 'POST', { message: 'sleep 15' });
  assert.strictEqual(sleepCmd.status, 200);
  assert.strictEqual(sleepCmd.json.intent.action, 'sleep');
  const stopCmd = await request(server, '/api/music/ai', 'POST', { message: 'stop' });
  assert.strictEqual(stopCmd.json.intent.action, 'stop');

  // ——— v1.4.0: AI song request choice / playlists / queue commands ———
  // Parser: playlist commands (VI + EN)
  const pc1 = music.localIntentParse('tạo playlist Chill Tối gồm 10 bài nhạc Việt chill');
  assert.strictEqual(pc1.intent, 'playlist_operation');
  assert.strictEqual(pc1.action, 'playlist_create');
  assert.strictEqual(pc1.playlistName, 'Chill Tối');
  assert.strictEqual(pc1.limit, 10);
  assert.strictEqual(pc1.language, 'vi');
  const pc2 = music.localIntentParse('create playlist Study with lofi beats');
  assert.strictEqual(pc2.action, 'playlist_create');
  assert.strictEqual(pc2.playlistName, 'Study');
  assert.strictEqual(pc2.query, 'lofi beats');
  assert.strictEqual(music.localIntentParse('Tạo danh sách phát Gym').playlistName, 'Gym');
  assert.strictEqual(music.localIntentParse('tạo playlist từ hàng đợi tên Đi làm').fromQueue, true);
  const pc3 = music.localIntentParse('thêm bài này vào playlist Gym');
  assert.strictEqual(pc3.action, 'playlist_add');
  assert.strictEqual(pc3.current, true);
  assert.strictEqual(music.localIntentParse('add Lạc Trôi to playlist Gym').query, 'Lạc Trôi');
  assert.strictEqual(music.localIntentParse('phát playlist Gym').action, 'playlist_play');
  assert.strictEqual(music.localIntentParse('xóa playlist Gym').action, 'playlist_delete');
  const pc4 = music.localIntentParse('đổi tên playlist Gym thành Tập gym');
  assert.strictEqual(pc4.action, 'playlist_rename');
  assert.strictEqual(pc4.newName, 'Tập gym');
  assert.strictEqual(music.localIntentParse('liệt kê playlist').action, 'playlist_list');
  // Parser: queue / favorite commands
  assert.strictEqual(music.localIntentParse('phát bài số 3').action, 'play_index');
  assert.strictEqual(music.localIntentParse('phát bài số 3').value, 3);
  assert.strictEqual(music.localIntentParse('xóa bài số 2').action, 'queue_remove');
  assert.strictEqual(music.localIntentParse('thích bài này').action, 'favorite');
  const pn = music.localIntentParse('play next Shape of You');
  assert.strictEqual(pn.playNext, true);
  assert.strictEqual(pn.queueOnly, true);
  const aq = music.localIntentParse('thêm Lạc Trôi vào danh sách phát');
  assert.strictEqual(aq.queueOnly, true);
  assert.strictEqual(aq.query, 'Lạc Trôi');
  // Old behaviour must be untouched
  assert.strictEqual(music.localIntentParse('play Sơn Tùng').intent, 'music_search');
  assert.strictEqual(music.localIntentParse('play Sơn Tùng').autoPlay, true);
  assert.strictEqual(music.localIntentParse('danh sách phát').action, 'queue_status');
  // parseIntent: omitted autoPlay stays undefined (never overrides local default), unknown keys dropped
  const pi = music.parseIntent('{"intent":"music_search","query":"abc"}');
  assert.strictEqual(pi.autoPlay, undefined);
  assert.ok(!('action' in pi));
  assert.strictEqual(music.parseIntent('{"intent":"playlist_operation","action":"playlist_create","playlistName":"X"}').playlistName, 'X');

  // Server: playlist ops return client actions, never auto-play `items`
  const plList = await request(server, '/api/music/ai', 'POST', { message: 'liệt kê playlist' });
  assert.strictEqual(plList.status, 200);
  assert.strictEqual(plList.json.actions[0].name, 'playlist_list');
  assert.strictEqual(plList.json.actions[0].args.lang, 'vi');
  assert.deepStrictEqual(plList.json.items, []);
  const plDel = await request(server, '/api/music/ai', 'POST', { message: 'delete playlist Gym' });
  assert.strictEqual(plDel.json.actions[0].name, 'playlist_delete');
  assert.strictEqual(plDel.json.actions[0].args.name, 'Gym');
  assert.strictEqual(plDel.json.actions[0].args.lang, 'en');
  const plEmpty = await request(server, '/api/music/ai', 'POST', { message: 'tạo playlist Gym' });
  assert.strictEqual(plEmpty.json.actions[0].name, 'playlist_create');
  assert.strictEqual(plEmpty.json.actions[0].args.name, 'Gym');
  const plQ = await request(server, '/api/music/ai', 'POST', { message: 'create playlist Mix from queue' });
  assert.strictEqual(plQ.json.actions[0].args.fromQueue, true);
  const plCur = await request(server, '/api/music/ai', 'POST', { message: 'thêm bài này vào playlist Gym' });
  assert.strictEqual(plCur.json.actions[0].name, 'playlist_add');
  assert.strictEqual(plCur.json.actions[0].args.current, true);
  // With content but no YouTube key / cache: still a playlist action (empty) + clear warning, no crash
  const plFill = await request(server, '/api/music/ai', 'POST', { message: 'create playlist Focus with 5 lofi songs' });
  assert.strictEqual(plFill.status, 200);
  assert.strictEqual(plFill.json.actions[0].name, 'playlist_create');
  assert.deepStrictEqual(plFill.json.items, []);
  assert.ok(Array.isArray(plFill.json.actions[0].args.items));
  const plAddMiss = await request(server, '/api/music/ai', 'POST', { message: 'add zzqxv unknown song to playlist Gym' });
  assert.strictEqual(plAddMiss.status, 200);
  assert.deepStrictEqual(plAddMiss.json.actions, []);
  assert.ok(plAddMiss.json.reply);
  // Queue / favorite commands
  const pidx = await request(server, '/api/music/ai', 'POST', { message: 'phát bài số 2' });
  assert.strictEqual(pidx.json.actions[0].name, 'play_index');
  assert.strictEqual(pidx.json.actions[0].args.index, 2);
  const qrm = await request(server, '/api/music/ai', 'POST', { message: 'remove track 4' });
  assert.strictEqual(qrm.json.actions[0].name, 'queue_remove');
  assert.strictEqual(qrm.json.actions[0].args.index, 4);
  const fav = await request(server, '/api/music/ai', 'POST', { message: 'like this' });
  assert.strictEqual(fav.json.actions[0].name, 'favorite');
  // A normal song request still returns tracks via `items` + queue_add (the panel decides play-now vs choice card)
  const song = await request(server, '/api/music/ai', 'POST', { message: 'lofi hip hop radio' });
  assert.strictEqual(song.status, 200);
  assert.ok(song.json.intent.autoPlay !== false);
  assert.ok(song.json.items.length >= 1, 'known seed track should resolve without API key');
  assert.strictEqual(song.json.actions[0].name, 'queue_add');
  assert.strictEqual(song.json.replyIsGenerated, true);

  // Adapter: every new action is allowed and registered; delete is flagged for client confirmation
  ['queue_append', 'play_now', 'play_index', 'queue_remove', 'playlist_create', 'playlist_add', 'playlist_play',
   'playlist_queue', 'playlist_rename', 'playlist_delete', 'playlist_list', 'favorite'].forEach((n) => {
    assert.ok(adapter.ALLOWED.has(n), 'adapter must allow ' + n);
  });
  assert.ok(adapter.actions.find((a) => a.name === 'playlist_delete').confirmOnClient);
  const ctx = await adapter.getContext({ title: 'T', playing: true, queueLength: 3, queuePreview: ['a', 'b'], playlists: [{ name: 'Gym', count: 2 }] });
  assert.strictEqual(ctx.title, 'T');
  assert.strictEqual(ctx.queueLength, 3);
  assert.strictEqual(ctx.playlists[0].name, 'Gym');
  assert.ok((await adapter.executeAction({ name: 'playlist_create', args: {} })).ok);
  assert.strictEqual((await adapter.executeAction({ name: 'rm_rf', args: {} })).ok, false);

    console.log('All tests passed');
  } finally {
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
