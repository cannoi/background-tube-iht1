'use strict';
/**
 * Reference AI panel controller (from Snake Arcade).
 * Host app may copy to public/ai-panel.js and adapt gameContext() / executeActions().
 * Depends on: UniversalAI, UniversalFeedback, markup in example/ui/ai-panel.html, styles in ai-panel.css.
 */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function flatten(src, prefix, out) {
  if (src == null) return;
  if (typeof src === 'string' || typeof src === 'number') {
    if (String(src).trim()) out.push([prefix || 'info', String(src)]);
    return;
  }
  if (Array.isArray(src)) { src.forEach((v, i) => flatten(v, prefix + ' ' + (i + 1), out)); return; }
  if (typeof src === 'object') Object.keys(src).forEach(k => flatten(src[k], prefix ? prefix + ' · ' + k : k, out));
}
function renderDonate(donate) {
  const box = document.getElementById('fbDonate');
  if (!box) return;
  const rows = [];
  flatten(donate, '', rows);
  if (!rows.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<strong>Ủng hộ tác giả</strong>' + rows.slice(0, 12).map(([k, v]) =>
    '<div class="fb-acc"><div class="fb-k">' + escapeHtml(k) + '</div><code class="fb-val">' + escapeHtml(v) + '</code></div>').join('');
}
function setUnread(n) {
  const badge = document.getElementById('aiBadge');
  const tabBadge = document.getElementById('fbTabBadge');
  const count = Number(n) || 0;
  if (badge) {
    if (count > 0) {
      badge.hidden = false;
      badge.style.display = '';
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
      badge.style.display = 'none';
      badge.textContent = '';
    }
  }
  if (tabBadge) {
    if (count > 0) {
      tabBadge.hidden = false;
      tabBadge.style.display = '';
      tabBadge.textContent = count > 9 ? '9+' : String(count);
    } else {
      tabBadge.hidden = true;
      tabBadge.style.display = 'none';
      tabBadge.textContent = '';
    }
  }
}
function setFabVisible(visible) {
  const fab = document.getElementById('aiFab');
  if (!fab) return;
  fab.hidden = !visible;
  fab.style.display = visible ? '' : 'none';
}
function gameContext() {
  // Background Tube — non-secret live music state for AI
  const tab = document.querySelector('.nav-btn.active');
  let playing = false, title = null, channel = null, videoId = null, queueLength = 0, index = -1, shuffle = false, repeat = 'off';
  try {
    if (window.__btPlayerState) {
      const p = window.__btPlayerState;
      playing = !!p.playing;
      title = p.active && p.active.title || null;
      channel = p.active && p.active.channelTitle || null;
      videoId = p.active && p.active.videoId || null;
      queueLength = (p.queue || []).length;
      index = p.index != null ? p.index : -1;
      shuffle = !!p.shuffle;
      repeat = p.repeat || 'off';
    }
  } catch (e) {}
  return {
    screen: tab ? tab.dataset.tab : 'home',
    playing, title, channel, videoId, queueLength, index, shuffle, repeat
  };
}
function executeActions(actions) {
  (actions || []).forEach(a => {
    if (!a || a.ok === false) return;
    const name = a.action || a.name;
    const value = a.value || (a.args && a.args.value) || '';
    const args = a.args || {};
    if (name === 'open_tab') {
      // AI panel tab OR main app tab
      const panelTab = document.querySelector('#panelTabs .tab[data-tab="' + (value || 'chat') + '"]');
      if (panelTab && ['chat','feedback','settings','logs'].includes(value)) panelTab.click();
      else document.querySelector('.nav-btn[data-tab="' + (value || 'home') + '"]')?.click();
    }
    if (name === 'open_player') document.querySelector('[data-action="open-player"]')?.click();
    // Music controls via custom event for module player
    if (['play','pause','toggle','next','previous','shuffle','repeat'].includes(name)) {
      window.dispatchEvent(new CustomEvent('bt-ai-action', { detail: { name, args } }));
    }
    if (name === 'queue_add' || name === 'play_next') {
      window.dispatchEvent(new CustomEvent('bt-ai-action', { detail: { name, args, items: args.items || a.items } }));
    }
    if (name === 'search' && (args.query || value)) {
      const input = document.getElementById('searchInput');
      if (input) {
        input.value = args.query || value;
        document.querySelector('.nav-btn[data-tab="search"]')?.click();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    }
  });
}

async function runMusicAI(message) {
  try {
    const res = await fetch('/api/music/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, context: gameContext() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'music AI failed');
    if (data.items && data.items.length) {
      window.dispatchEvent(new CustomEvent('bt-ai-action', {
        detail: { name: 'queue_add', items: data.items, autoPlay: data.intent && data.intent.autoPlay !== false }
      }));
    }
    executeActions(data.actions || []);
    return data.reply || data.error || 'OK';
  } catch (e) {
    return null; // fall through to normal AI chat
  }
}



/** Remote pair card — public IP:port for SoloHost phones */
let remoteCardReady = false;
async function ensureRemoteCard() {
  if (!aiChat) return;
  let card = document.getElementById('aiRemoteCard');
  if (!card) {
    card = document.createElement('div');
    card.id = 'aiRemoteCard';
    card.className = 'ai-remote-card';
    aiChat.insertBefore(card, aiChat.firstChild);
  }
  card.innerHTML = '<div class="ai-remote-loading">Loading remote link…</div>';
  try {
    const [pub, pair] = await Promise.all([
      fetch('/api/public-url').then(r => r.json()).catch(() => ({})),
      (async () => {
        // ensure session then pair
        let sid = null;
        try {
          const s = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
          sid = s.state && s.state.sessionId;
          try { localStorage.setItem('bt_session_id', sid); } catch (e) {}
        } catch (e) {}
        if (!sid) return null;
        const p = await fetch('/api/remote/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, role: 'remote' })
        }).then(r => r.json());
        return p;
      })()
    ]);
    const base = (pub && pub.baseUrl) ? String(pub.baseUrl).replace(/\/$/, '') : (location.origin || '');
    const path = (pair && pair.path) ? pair.path : '';
    const url = path ? (base + path) : base;
    const qr = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(url);
    card.innerHTML =
      '<div class="ai-remote-title"><i class="fa-solid fa-qrcode"></i> Remote · same session</div>' +
      '<p class="ai-remote-help">Scan QR or open the URL on your phone to control this player (play / pause / next · same track).</p>' +
      '<div class="ai-remote-qr"><img src="' + qr + '" width="160" height="160" alt="QR Remote" loading="lazy"></div>' +
      '<label class="ai-remote-label">URL</label>' +
      '<input type="text" class="ai-remote-url" readonly value="' + String(url).replace(/"/g, '&quot;') + '" onclick="this.select()">' +
      '<div class="ai-remote-actions">' +
      '<button type="button" class="ai-remote-copy" id="aiRemoteCopy">Copy URL</button>' +
      '<button type="button" class="ai-remote-refresh" id="aiRemoteRefresh">Refresh</button>' +
      '</div>' +
      '<p class="ai-remote-note">Uses public IP:port (SoloHost). Token expires ~15 min. No API keys in the link.</p>';
    document.getElementById('aiRemoteCopy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        const b = document.getElementById('aiRemoteCopy');
        if (b) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy URL'; }, 1500); }
      } catch (e) {
        const inp = card.querySelector('.ai-remote-url');
        if (inp) { inp.select(); document.execCommand('copy'); }
      }
    });
    document.getElementById('aiRemoteRefresh')?.addEventListener('click', () => {
      remoteCardReady = false;
      ensureRemoteCard();
    });
    remoteCardReady = true;
  } catch (e) {
    card.innerHTML = '<div class="ai-remote-title">Remote</div><p class="ai-remote-help">Could not build pair link. Check network / PUBLIC_BASE_URL.</p>';
  }
}


const aiChat = document.getElementById('aiChat');
const aiInput = document.getElementById('aiInput');
function appendMsg(role, html) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = html;
  if (aiChat) { aiChat.appendChild(div); aiChat.scrollTop = aiChat.scrollHeight; }
  return div;
}

const ai = window.UniversalAI.create({
  button: document.getElementById('aiFab'),
  onOpen() {
    const ov = document.getElementById('aiOverlay');
    if (ov) ov.hidden = false;
    setFabVisible(false);
    refreshStatus();
    loadSettings();
    ensureRemoteCard();
  },
  onActions: executeActions
});

function closeAIPanel() {
  const ov = document.getElementById('aiOverlay');
  if (ov) ov.hidden = true;
  setFabVisible(true);

/* ——— Multilingual voice command (AI Chat composer only) ——— */
const VOICE_AUTO_SEND_KEY = 'bt_voice_auto_send';
function voiceAutoSendEnabled() {
  try {
    const v = localStorage.getItem(VOICE_AUTO_SEND_KEY);
    if (v === null || v === undefined) return true; // default ON
    return v !== '0' && v !== 'false';
  } catch (_) { return true; }
}

let voiceRec = null;
let voiceState = 'idle'; // idle | listening | processing | error | unsupported | permission_denied

function setMicState(state, message) {
  voiceState = state;
  const btn = document.getElementById('aiMic');
  const st = document.getElementById('aiMicStatus');
  if (btn) {
    btn.classList.toggle('listening', state === 'listening');
    btn.classList.toggle('processing', state === 'processing');
    btn.setAttribute('aria-pressed', state === 'listening' ? 'true' : 'false');
    btn.disabled = state === 'unsupported';
  }
  if (st) {
    if (!message && (state === 'idle' || state === 'success')) {
      st.hidden = true;
      st.textContent = '';
      return;
    }
    st.hidden = false;
    st.className = 'ai-mic-status' + (state === 'error' || state === 'permission_denied' || state === 'unsupported' ? ' err' : state === 'success' ? ' ok' : '');
    st.textContent = message || state;
  }
}

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function stopVoice() {
  try { if (voiceRec) voiceRec.stop(); } catch (_) {}
  voiceRec = null;
  if (voiceState === 'listening') setMicState('idle', '');
}

function startVoiceCommand() {
  const SR = getSpeechRecognition();
  if (!SR) {
    setMicState('unsupported', 'Voice not supported in this browser. Type your command.');
    return;
  }
  if (voiceState === 'listening') {
    stopVoice();
    return;
  }
  const rec = new SR();
  voiceRec = rec;
  // Multilingual: let the engine auto-detect; prefer UI language as hint
  try {
    rec.lang = (navigator.language || 'en-US');
  } catch (_) {}
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  setMicState('listening', 'Listening…');

  rec.onresult = (ev) => {
    let interim = '';
    let finalText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript || '';
      if (ev.results[i].isFinal) finalText += t;
      else interim += t;
    }
    const input = document.getElementById('aiInput');
    if (input) input.value = (finalText || interim || '').trim();
    if (finalText) {
      setMicState('processing', 'Processing…');
      const text = finalText.trim();
      if (input) input.value = text;
      if (text && voiceAutoSendEnabled()) {
        // Local intent first happens inside sendAI → /api/music/ai localIntentParse
        setTimeout(() => { try { sendAI(); } catch (_) {} }, 80);
      } else {
        setMicState('success', text ? 'Edit or press send' : '');
        setTimeout(() => setMicState('idle', ''), 1500);
      }
    }
  };

  rec.onerror = (ev) => {
    const err = (ev && ev.error) || 'error';
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      setMicState('permission_denied', 'Microphone permission required.');
    } else if (err === 'no-speech') {
      setMicState('error', 'No speech detected.');
      setTimeout(() => setMicState('idle', ''), 2000);
    } else if (err === 'aborted') {
      setMicState('idle', '');
    } else {
      setMicState('error', 'Voice error: ' + err);
      setTimeout(() => setMicState('idle', ''), 2500);
    }
    voiceRec = null;
  };

  rec.onend = () => {
    voiceRec = null;
    if (voiceState === 'listening') setMicState('idle', '');
  };

  try {
    rec.start();
  } catch (e) {
    setMicState('error', e.message || 'Could not start microphone.');
    voiceRec = null;
  }
}

document.getElementById('aiMic')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  startVoiceCommand();
});

if (!getSpeechRecognition()) {
  setMicState('unsupported', '');
  const b = document.getElementById('aiMic');
  if (b) b.title = 'Voice not supported in this browser';
}


ensureRemoteCard();
}
document.getElementById('aiClose')?.addEventListener('click', closeAIPanel);
document.getElementById('aiOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'aiOverlay') closeAIPanel();
});
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('tab-' + t.dataset.tab)?.classList.add('active');
  if (t.dataset.tab === 'settings') loadSettings();
  if (t.dataset.tab === 'logs') loadLogs();
  if (t.dataset.tab === 'feedback') setUnread(0);
}));

async function refreshStatus() {
  const bar = document.getElementById('aiStatusBar');
  const dot = document.getElementById('aiStatusDot');
  try {
    const j = await ai.status();
    const configured = !!(j.configured || (j.settings && j.settings.hasKey));
    const provider = (j.settings && j.settings.provider) || j.provider || '';
    if (bar) bar.textContent = configured ? ('AI ready · ' + provider) : 'Local guide ON · add key in Settings';
    if (dot) { dot.classList.toggle('on', configured); dot.classList.toggle('off', !configured); }
  } catch (e) {
    if (bar) bar.textContent = 'AI unavailable';
  }
}

async function sendAI() {
  const text = (aiInput.value || '').trim();
  if (!text) return;
  aiInput.value = '';
  appendMsg('user', escapeHtml(text));
  const loading = appendMsg('ai', '…');
  const musicLike = /play|pause|stop|next|prev|karaoke|nhạc|nhac|music|recommend|gợi|goi|chill|workout|phát|phat|dừng|dung|tiếp|tiep|hát|hat|shuffle|repeat|queue|similar|volume|âm lượng|mute|sleep|hẹn giờ|timer|seek|tua|lofi|bài|song|artist|now playing|đang phát|tắt nhạc/i.test(text);
  try {
    if (musicLike) {
      const musicReply = await runMusicAI(text);
      if (musicReply) {
        loading.remove();
        appendMsg('ai', escapeHtml(musicReply).replace(/\n/g, '<br>'));
        return;
      }
    }
    const out = await ai.chat(text, gameContext());
    loading.remove();
    executeActions(out.actions);
    const local = out.source === 'local' || out.configured === false;
    appendMsg('ai', escapeHtml(out.reply || 'No response').replace(/\n/g, '<br>') +
      (local ? '<div style="opacity:.55;font-size:.75rem">Local guide</div>' : ''));
  } catch (e) {
    loading.remove();
    appendMsg('ai', escapeHtml(e.message || 'AI connection failed'));
  }
}
document.getElementById('aiSend')?.addEventListener('click', sendAI);
aiInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendAI(); } });

function fillModelSelect(models, current) {
  const sel = document.getElementById('setModel');
  if (!sel) return;
  if (!Array.isArray(models) || !models.length) {
    if (sel.tagName === 'SELECT') {
      sel.outerHTML = '<input type="text" id="setModel" placeholder="auto" value="' + escapeHtml(current || 'auto') + '">';
    } else {
      sel.value = current || 'auto';
    }
    return;
  }
  const opts = ['<option value="auto">auto</option>'].concat(
    models.slice(0, 40).map(m => {
      const id = typeof m === 'string' ? m : (m.id || m.name || '');
      return '<option value="' + escapeHtml(id) + '">' + escapeHtml(id) + '</option>';
    })
  );
  if (sel.tagName !== 'SELECT') {
    sel.outerHTML = '<select id="setModel">' + opts.join('') + '</select>';
  } else {
    sel.innerHTML = opts.join('');
  }
  const el = document.getElementById('setModel');
  if (el) el.value = current || 'auto';
}

async function loadSettings() {
  const sel = document.getElementById('setProvider');
  const status = document.getElementById('setStatus');
  try {
    const [st, cat] = await Promise.all([ai.settings(), ai.catalog()]);
    const providers = (cat && cat.providers) || (Array.isArray(cat) ? cat : []);
    if (sel && providers.length) {
      sel.innerHTML = '<option value="none">— None —</option>' +
        providers.map(p => '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || p.id) + '</option>').join('');
      sel.value = st.provider || 'none';
    }
    const keyHint = document.getElementById('setKeyHint');
    if (keyHint) keyHint.textContent = st.hasKey ? ('Key hiện tại: ' + (st.maskedKey || '****')) : 'Key hiện tại: (chưa có)';
    const apiKey = document.getElementById('setApiKey');
    if (apiKey) apiKey.value = '';
    const base = document.getElementById('setBaseUrl');
    if (base) base.value = st.baseUrl || '';
    fillModelSelect([], st.model || 'auto');
    const mode = document.getElementById('setMode');
    if (mode) mode.value = st.mode || 'cloud_enabled';
    if (status) status.textContent = '';
  } catch (e) {
    if (status) status.textContent = 'Không tải được settings: ' + e.message;
  }
}

document.getElementById('setSave')?.addEventListener('click', async () => {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Saving…';
  try {
    const body = {
      provider: document.getElementById('setProvider')?.value,
      baseUrl: document.getElementById('setBaseUrl')?.value.trim(),
      model: document.getElementById('setModel')?.value.trim() || 'auto',
      mode: document.getElementById('setMode')?.value
    };
    const key = document.getElementById('setApiKey')?.value.trim();
    if (key) body.apiKey = key;
    const j = await ai.saveSettings(body);
    if (status) status.textContent = j.ok === false ? (j.error || 'Failed') : 'Saved ✓';
    await loadSettings();
    refreshStatus();
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

document.getElementById('setTest')?.addEventListener('click', async () => {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Checking token…';
  try {
    // save current form first so server tests the right provider/key
    const body = {
      provider: document.getElementById('setProvider')?.value,
      baseUrl: document.getElementById('setBaseUrl')?.value.trim(),
      model: document.getElementById('setModel')?.value.trim() || 'auto',
      mode: document.getElementById('setMode')?.value
    };
    const key = document.getElementById('setApiKey')?.value.trim();
    if (key) body.apiKey = key;
    await ai.saveSettings(body);
    const r = await ai.testConnection();
    if (r.ok) {
      const models = r.models || [];
      fillModelSelect(models, r.model || 'auto');
      if (status) status.textContent = 'Token OK' + (r.model ? ' · model: ' + r.model : '') + (models.length ? '. Models: ' + models.slice(0, 6).map(m => m.id || m).join(', ') : '. (server lists no models)') + (r.warning ? ' ⚠ ' + r.warning : '');
    } else {
      if (status) status.textContent = r.warning || r.error || 'Token check failed';
      if (r.suggested_provider) {
        const sel = document.getElementById('setProvider');
        if (sel) sel.value = r.suggested_provider;
      }
    }
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

async function refreshModelsClick() {
  const status = document.getElementById('setStatus');
  if (status) status.textContent = 'Refreshing models…';
  try {
    const r = await ai.models();
    fillModelSelect(r.models || r || [], document.getElementById('setModel')?.value || 'auto');
    if (status) status.textContent = r.warning || 'Models updated';
  } catch (e) {
    if (status) status.textContent = e.message;
  }
}
// HTML button is id="setModels"; keep the legacy id working too.
['setModels', 'setRefreshModels'].forEach(id => document.getElementById(id)?.addEventListener('click', refreshModelsClick));

async function loadLogs() {
  const view = document.getElementById('logsView');
  if (!view) return;
  try {
    const r = await fetch('/api/logs');
    const j = await r.json();
    view.textContent = (j.logs || []).map(l => (l.ts || '') + ' [' + l.level + '] ' + l.msg).join('\n') || '(no logs)';
  } catch (e) {
    view.textContent = e.message;
  }
}
document.getElementById('logsRefresh')?.addEventListener('click', loadLogs);
document.getElementById('logsClear')?.addEventListener('click', async () => {
  await fetch('/api/logs', { method: 'DELETE' });
  loadLogs();
});

const fb = window.UniversalFeedback.create({
  onUnread: setUnread,
  onSync(sync) {
    renderDonate(sync.donate);
    renderNotices(sync.notices);
  }
});
function renderNotices(notices) {
  const el = document.getElementById('fbNotices');
  if (!el) return;
  el.innerHTML = (notices || []).map(n =>
    '<div class="fb-notice"><strong>' + escapeHtml(n.title || 'Notice') + '</strong>' +
    (n.body ? '<div>' + escapeHtml(n.body) + '</div>' : '') +
    (n.id ? '<button type="button" data-mark="' + escapeHtml(n.id) + '">Đã đọc</button>' : '') +
    '</div>'
  ).join('');
  el.querySelectorAll('[data-mark]').forEach(btn => btn.addEventListener('click', async () => {
    await fb.markRead(btn.dataset.mark);
    btn.closest('.fb-notice')?.remove();
  }));
}
let fbRating = 0;
document.querySelectorAll('#fbStars button').forEach(b => b.addEventListener('click', () => {
  fbRating = Number(b.dataset.r);
  document.querySelectorAll('#fbStars button').forEach(x => x.classList.toggle('on', Number(x.dataset.r) <= fbRating));
}));
document.getElementById('fbSubmit')?.addEventListener('click', async () => {
  const status = document.getElementById('fbStatus');
  const msg = (document.getElementById('fbMessage')?.value || '').trim();
  if (!msg) { if (status) status.textContent = 'Vui lòng nhập nội dung.'; return; }
  if (status) status.textContent = 'Sending…';
  try {
    await fb.send({ type: document.getElementById('fbType')?.value, message: msg, rating: fbRating });
    if (status) status.textContent = 'Cảm ơn bạn!';
    const ta = document.getElementById('fbMessage');
    if (ta) ta.value = '';
  } catch (e) {
    if (status) status.textContent = e.message;
  }
});

refreshStatus();
loadSettings();
fb.sync().catch(e => {
  const st = document.getElementById('fbStatus');
  if (st) st.textContent = 'Hub: ' + e.message;
});
setUnread(0);
setFabVisible(true);

/* ——— Multilingual voice command (AI Chat composer only) ——— */
const VOICE_AUTO_SEND_KEY = 'bt_voice_auto_send';
function voiceAutoSendEnabled() {
  try {
    const v = localStorage.getItem(VOICE_AUTO_SEND_KEY);
    if (v === null || v === undefined) return true; // default ON
    return v !== '0' && v !== 'false';
  } catch (_) { return true; }
}

let voiceRec = null;
let voiceState = 'idle'; // idle | listening | processing | error | unsupported | permission_denied

function setMicState(state, message) {
  voiceState = state;
  const btn = document.getElementById('aiMic');
  const st = document.getElementById('aiMicStatus');
  if (btn) {
    btn.classList.toggle('listening', state === 'listening');
    btn.classList.toggle('processing', state === 'processing');
    btn.setAttribute('aria-pressed', state === 'listening' ? 'true' : 'false');
    btn.disabled = state === 'unsupported';
  }
  if (st) {
    if (!message && (state === 'idle' || state === 'success')) {
      st.hidden = true;
      st.textContent = '';
      return;
    }
    st.hidden = false;
    st.className = 'ai-mic-status' + (state === 'error' || state === 'permission_denied' || state === 'unsupported' ? ' err' : state === 'success' ? ' ok' : '');
    st.textContent = message || state;
  }
}

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function stopVoice() {
  try { if (voiceRec) voiceRec.stop(); } catch (_) {}
  voiceRec = null;
  if (voiceState === 'listening') setMicState('idle', '');
}

function startVoiceCommand() {
  const SR = getSpeechRecognition();
  if (!SR) {
    setMicState('unsupported', 'Voice not supported in this browser. Type your command.');
    return;
  }
  if (voiceState === 'listening') {
    stopVoice();
    return;
  }
  const rec = new SR();
  voiceRec = rec;
  // Multilingual: let the engine auto-detect; prefer UI language as hint
  try {
    rec.lang = (navigator.language || 'en-US');
  } catch (_) {}
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  setMicState('listening', 'Listening…');

  rec.onresult = (ev) => {
    let interim = '';
    let finalText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript || '';
      if (ev.results[i].isFinal) finalText += t;
      else interim += t;
    }
    const input = document.getElementById('aiInput');
    if (input) input.value = (finalText || interim || '').trim();
    if (finalText) {
      setMicState('processing', 'Processing…');
      const text = finalText.trim();
      if (input) input.value = text;
      if (text && voiceAutoSendEnabled()) {
        // Local intent first happens inside sendAI → /api/music/ai localIntentParse
        setTimeout(() => { try { sendAI(); } catch (_) {} }, 80);
      } else {
        setMicState('success', text ? 'Edit or press send' : '');
        setTimeout(() => setMicState('idle', ''), 1500);
      }
    }
  };

  rec.onerror = (ev) => {
    const err = (ev && ev.error) || 'error';
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      setMicState('permission_denied', 'Microphone permission required.');
    } else if (err === 'no-speech') {
      setMicState('error', 'No speech detected.');
      setTimeout(() => setMicState('idle', ''), 2000);
    } else if (err === 'aborted') {
      setMicState('idle', '');
    } else {
      setMicState('error', 'Voice error: ' + err);
      setTimeout(() => setMicState('idle', ''), 2500);
    }
    voiceRec = null;
  };

  rec.onend = () => {
    voiceRec = null;
    if (voiceState === 'listening') setMicState('idle', '');
  };

  try {
    rec.start();
  } catch (e) {
    setMicState('error', e.message || 'Could not start microphone.');
    voiceRec = null;
  }
}

document.getElementById('aiMic')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  startVoiceCommand();
});

if (!getSpeechRecognition()) {
  setMicState('unsupported', '');
  const b = document.getElementById('aiMic');
  if (b) b.title = 'Voice not supported in this browser';
}


ensureRemoteCard();
