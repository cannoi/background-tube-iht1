'use strict';
/**
 * AI-configured path (fake OpenAI-compatible LLM, no network, no YouTube key):
 * playlist creation/merge, autoPlay default, live context. Runs in a temp cwd so ./data is never touched.
 */
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ai-test-'));
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// Pre-seed the candidate cache so resolving needs no YouTube key (key: normalized "artist title")
const norm = (q) => String(q || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
const songs = [
  { artist: 'Den Vau', title: 'Doi Mat', id: 'id_doimat' },
  { artist: 'Chillies', title: 'Mong Mo', id: 'id_mongmo' },
  { artist: 'Hoang Dung', title: 'Ky Niem Xua', id: 'id_kyniem' },
];
const cache = { entries: {} };
songs.forEach((s) => { cache.entries[norm(s.artist + ' ' + s.title)] = { videoId: s.id, title: s.title, artist: s.artist, thumbnail: '', duration: '', updatedAt: Date.now(), normalizedQuery: norm(s.artist + ' ' + s.title) }; });
fs.writeFileSync(path.join(TMP, 'data', 'music-candidate-cache.json'), JSON.stringify(cache));

let lastPrompt = '';
let LLM_PORT = 0, APP_PORT = 0, llm = null, srv = null;
const llmHandler = (req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fake-1' }] })); }
    const body = JSON.parse(b || '{}');
    lastPrompt = (body.messages || []).map((m) => m.content).join('\n');
    const user = (body.messages || []).slice(-1)[0].content;
    let content;
    if (/playlist/i.test(user)) {
      // Model answers with the intent JSON the system hint asks for — NOTE: deliberately says "recommendation" and omits autoPlay
      const j = { intent: 'recommendation', playlistName: 'IGNORED', limit: 3, candidates: songs.map((s) => ({ artist: s.artist, title: s.title })) };
      content = JSON.stringify({ reply: 'Đây là 3 bài nhạc buồn:\n' + JSON.stringify(j), actions: [] });
    } else {
      const j = { intent: 'recommendation', mood: 'relax', limit: 3, candidates: songs.map((s) => ({ artist: s.artist, title: s.title })) };
      content = JSON.stringify({ reply: 'Gợi ý cho bạn:\n' + JSON.stringify(j), actions: [] });
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], model: 'fake-1' }));
  });
};
const post = (p, o) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: APP_PORT, path: p, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d || '{}')));
  }); r.on('error', reject); r.end(JSON.stringify(o));
});

(async () => {
  LLM_PORT = await freePort(); APP_PORT = await freePort();
  llm = http.createServer(llmHandler).listen(LLM_PORT, '127.0.0.1');
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { cwd: TMP, env: { ...process.env, PORT: String(APP_PORT), YOUTUBE_API_KEY: '' }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const s = await post('/api/ai/settings', { provider: 'custom', baseUrl: 'http://127.0.0.1:' + LLM_PORT + '/v1', apiKey: 'sk-test-123456789', model: 'fake-1', mode: 'cloud_enabled' });
  assert.ok(s.ok, JSON.stringify(s));

  // 1) AI + playlist create with fuzzy content → model gives candidates → resolved from cache → ONE playlist action, no auto-play items
  const r1 = await post('/api/music/ai', { message: 'tạo playlist Đêm Buồn gồm 3 bài nhạc buồn' });
  console.log('create →', JSON.stringify({ intent: r1.intent.intent, action: r1.intent.action, name: r1.actions[0] && r1.actions[0].args.name, n: r1.actions[0] && r1.actions[0].args.items.length, items: r1.items.length }));
  assert.strictEqual(r1.intent.intent, 'playlist_operation', 'model must NOT turn the playlist command into a normal recommendation');
  assert.strictEqual(r1.actions[0].name, 'playlist_create');
  assert.strictEqual(r1.actions[0].args.name, 'Đêm Buồn', 'local playlist name wins over model value');
  assert.deepStrictEqual(r1.actions[0].args.items.map((i) => i.videoId), ['id_doimat', 'id_mongmo', 'id_kyniem']);
  assert.deepStrictEqual(r1.items, [], 'playlist tracks must never be auto-played');
  assert.ok(!r1.warning);
  assert.ok(/playlist_operation/.test(lastPrompt), 'system hint advertises the playlist intent to the model');

  // 2) AI recommendation where the model omits autoPlay → must still be a normal play request (autoPlay not forced false)
  const r2 = await post('/api/music/ai', { message: 'gợi ý nhạc thư giãn buổi tối' });
  console.log('recommend →', JSON.stringify({ intent: r2.intent.intent, autoPlay: r2.intent.autoPlay, n: r2.items.length, act: r2.actions[0] && r2.actions[0].name, aargs: r2.actions[0] && r2.actions[0].args.autoPlay }));
  assert.strictEqual(r2.items.length, 3);
  assert.notStrictEqual(r2.intent.autoPlay, false);
  assert.strictEqual(r2.actions[0].args.autoPlay, true);

  // 3) playlist_add with a song query through AI-less local path still resolves from cache
  const r3 = await post('/api/music/ai', { message: 'add Den Vau Doi Mat to playlist Đêm Buồn' });
  console.log('add →', JSON.stringify({ act: r3.actions[0] && r3.actions[0].name, n: r3.actions[0] && r3.actions[0].args.items.map((i) => i.videoId) }));
  assert.strictEqual(r3.actions[0].name, 'playlist_add');
  assert.deepStrictEqual(r3.actions[0].args.items.map((i) => i.videoId), ['id_doimat']);

  // 4) Context reaches the model now (queue preview / playlists)
  await post('/api/ai/chat', { message: 'what is playing?', context: { title: 'Bài X', playing: true, queueLength: 2, queuePreview: ['a', 'b'], playlists: [{ name: 'Gym', count: 4 }] } });
  assert.ok(/Bài X/.test(lastPrompt) && /Gym/.test(lastPrompt), 'live context (title + playlists) must be in the system prompt');

  console.log('AI-configured path OK');
})().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; })
  .finally(() => { try { srv && srv.kill(); } catch (_) {} try { llm && llm.close(); } catch (_) {} try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
