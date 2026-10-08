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
  let queuePreview = [], playlists = [];
  try {
    if (window.btAI && window.btAI.snapshot) {
      const snap = window.btAI.snapshot();
      queuePreview = snap.queue || [];
      playlists = snap.playlists || [];
    }
  } catch (e) {}
  return {
    screen: tab ? tab.dataset.tab : 'home',
    playing, title, channel, videoId, queueLength, index, shuffle, repeat,
    queuePreview, playlists
  };
}
/** Every action the player/library side (main.js → runAiAction) understands. */
const CLIENT_ACTIONS = new Set([
  'play', 'pause', 'toggle', 'stop', 'next', 'previous', 'shuffle', 'repeat',
  'seek', 'volume', 'mute', 'unmute', 'sleep',
  'queue_clear', 'queue_add', 'play_next', 'queue_append', 'play_now', 'play_items', 'play_index', 'queue_remove',
  'now_playing', 'queue_status', 'favorite',
  'playlist_create', 'playlist_add', 'playlist_play', 'playlist_queue', 'playlist_rename', 'playlist_delete', 'playlist_list'
]);

/**
 * Runs AI actions. Returns the list of result messages produced by the player/library
 * (real outcomes: counts, "not found", cancelled…), so chat never claims success it did not get.
 * opts.skipItemActions: ignore queue_add/play_next (the caller handles the tracks itself).
 */
function executeActions(actions, opts) {
  const messages = [];
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
    // Music controls / queue / playlists via custom event for the module player
    if (CLIENT_ACTIONS.has(name)) {
      if (opts && opts.skipItemActions && (name === 'queue_add' || name === 'play_next')) return;
      const detail = {
        name, args, items: args.items || a.items,
        done: (r) => { if (r && r.message) messages.push(r.message); }
      };
      window.dispatchEvent(new CustomEvent('bt-ai-action', { detail }));
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
  return messages;
}

/* ——— "Play now / Add to queue" choice for AI song requests ——— */
const CHOICE_TIMEOUT_S = 15;
const pendingChoices = new Set();
const isViText = (s) => /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s || '') || /\b(phat|bai|nhac|them|tao|cho toi)\b/i.test(s || '');
function langOf(message, data) {
  const a = data && data.actions && data.actions[0];
  if (a && a.args && a.args.lang) return a.args.lang;
  return isViText(message) ? 'vi' : 'en';
}
function musicBusy() {
  try { return !!(window.btAI && window.btAI.isBusy()); } catch (e) { return false; }
}
function runAction(name, args, items) {
  let msg = '';
  window.dispatchEvent(new CustomEvent('bt-ai-action', {
    detail: { name, args: args || {}, items, done: (r) => { if (r && r.message) msg = r.message; } }
  }));
  return msg;
}
/** Resolve every unanswered choice card as "add after the last track" (the default). */
function resolvePendingChoices() {
  Array.from(pendingChoices).forEach((fn) => { try { fn('auto'); } catch (e) {} });
}
function renderChoiceCard(items, lang, introText) {
  const vi = lang === 'vi';
  const first = items[0] || {};
  const more = items.length - 1;
  const msg = appendMsg('ai', '');
  msg.classList.add('ai-choice');
  msg.innerHTML =
    (introText ? '<div class="ai-choice-intro">' + escapeHtml(introText).replace(/\n/g, '<br>') + '</div>' : '') +
    '<div class="ai-choice-track">' +
      (first.thumbnail ? '<img src="' + escapeHtml(first.thumbnail) + '" alt="" loading="lazy">' : '') +
      '<div><strong>' + escapeHtml(first.title || 'Track') + '</strong>' +
      '<small>' + escapeHtml(first.channelTitle || '') + (more > 0 ? ' · +' + more + (vi ? ' bài nữa' : ' more') : '') + '</small></div>' +
    '</div>' +
    '<button type="button" class="ai-choice-btn ai-choice-now" data-choice="now">▶ ' + (vi ? 'Phát ngay' : 'Play now') + '</button>' +
    '<button type="button" class="ai-choice-btn ai-choice-queue" data-choice="queue">＋ ' + (vi ? 'Thêm vào danh sách phát sau' : 'Add to queue') +
      ' <span class="ai-choice-timer"></span></button>' +
    '<div class="ai-choice-note">' + (vi ? 'Không chọn gì: tự thêm vào cuối danh sách phát.' : 'No choice: it is added after the last track.') + '</div>';
  aiChat && (aiChat.scrollTop = aiChat.scrollHeight);

  let left = CHOICE_TIMEOUT_S;
  let done = false;
  const timerEl = msg.querySelector('.ai-choice-timer');
  const paint = () => { if (timerEl) timerEl.textContent = '(' + left + 's)'; };
  paint();
  const tick = setInterval(() => {
    left -= 1;
    if (left <= 0) { choose('auto'); return; }
    paint();
  }, 1000);

  function choose(kind) {
    if (done) return;
    done = true;
    clearInterval(tick);
    pendingChoices.delete(choose);
    // Re-check the player: if the music ended while the card was open, "auto" simply starts playing.
    const busyNow = musicBusy();
    let result = '';
    if (kind === 'now') {
      result = runAction(busyNow ? 'play_now' : 'play_items', { lang }, items);
    } else if (kind === 'auto' && !busyNow) {
      result = runAction('play_items', { lang }, items);
    } else {
      result = runAction('queue_append', { lang }, items);
    }
    const mark = kind === 'auto' ? '⏱ ' : '✓ ';
    msg.classList.add('done');
    msg.innerHTML = '<div class="ai-choice-result">' + mark + escapeHtml(result || (vi ? 'Xong.' : 'Done.')) + '</div>';
  }
  pendingChoices.add(choose);
  msg.querySelectorAll('[data-choice]').forEach((btn) => {
    btn.addEventListener('click', () => choose(btn.dataset.choice));
  });
  return msg;
}

/**
 * Sends the message to the music AI and applies the result.
 * Returns { text, card } for the chat, or null when the music endpoint failed (caller falls back to generic AI chat).
 * Song requests:  player idle  → play immediately
 *                 player busy  → choice card (Play now / Add to queue; default = add after the last track)
 */
async function runMusicAI(message) {
  try {
    const res = await fetch('/api/music/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, context: gameContext() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'music AI failed');
    const lang = langOf(message, data);
    const vi = lang === 'vi';
    const intent = data.intent || {};
    const items = data.items || [];
    const acts = data.actions || [];
    const results = [];
    let card = null;
    let text = data.reply || data.error || 'OK';

    if (items.length) {
      // Tracks are handled here (once) — never again through the generic actions loop.
      const wantsPlay = !(intent.autoPlay === false) && !intent.queueOnly;
      if (wantsPlay) {
        if (musicBusy()) {
          const intro = data.replyIsGenerated
            ? (vi ? 'Đang có nhạc phát. Bạn muốn phát bài này thế nào?' : 'Music is already playing. How do you want this one?')
            : data.reply;
          card = { items, lang, intro };
          text = null;
        } else {
          const r = runAction('play_items', { lang }, items);
          if (data.replyIsGenerated && r) text = r + (items.length > 1 ? (vi ? ' · +' + (items.length - 1) + ' bài trong danh sách phát' : ' · +' + (items.length - 1) + ' in queue') : '');
        }
      } else {
        // Explicit "add to queue" / "play next": never interrupts the current track.
        const r = intent.playNext
          ? (runAction('queue_add', { lang, autoPlay: false, playNext: true }, items), vi ? 'Đã chèn ngay sau bài hiện tại: ' + items[0].title : 'Inserted right after the current track: ' + items[0].title)
          : runAction('queue_append', { lang }, items);
        if (data.replyIsGenerated) text = r;
      }
    }

    // Non-track actions: player controls, queue edits, playlists, favorites…
    const msgs = executeActions(acts, { skipItemActions: items.length > 0 });
    msgs.forEach((m) => results.push(m));

    if (results.length) {
      const base = (data.replyIsGenerated || !data.reply || data.reply === 'OK' || /^OK · /.test(data.reply)) ? '' : data.reply;
      text = (base ? base + '\n' : '') + results.join('\n');
    } else if (card) {
      text = null;
    }
    if (data.warning) text = (text ? text + '\n' : '') + '⚠ ' + data.warning;
    return { text, card };
  } catch (e) {
    console.warn('[BT Music AI]', e.message || e);
    return null;
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
        // ALWAYS shared room — never POST /api/session (that created a private room)
        let sid = null;
        try {
          const room = await fetch('/api/session/room', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: localStorage.getItem('bt_client_id') || 'ai-panel' })
          }).then(r => r.json());
          sid = room.sessionId || (room.state && room.state.sessionId);
          try {
            localStorage.setItem('bt_session_id', sid);
            localStorage.setItem('bt_sync_enabled', '1');
          } catch (e) {}
        } catch (e) { console.warn('[remote] room', e); }
        const p = await fetch('/api/remote/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, role: 'remote' })
        }).then(r => r.json());
        return p;
      })()
    ]);
    const base = (pub && pub.baseUrl) ? String(pub.baseUrl).replace(/\/$/, '') : (location.origin || '');
    const roomCode = (pair && (pair.roomCode || pair.sessionId)) || '';
    // Prefer server path (includes ?s=room); fallback builds same shape
    let path = (pair && pair.path) ? pair.path : '';
    if (!path && roomCode) {
      path = '/?s=' + encodeURIComponent(roomCode) + '&sync=1';
      if (pair && pair.token) path += '&t=' + encodeURIComponent(pair.token) + '&r=remote';
    }
    const url = path ? (base + path) : base;
    const qr = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(url);
    card.innerHTML =
      '<div class="ai-remote-title"><i class="fa-solid fa-qrcode"></i> Remote · room <code>' + String(roomCode).slice(0, 12) + '</code></div>' +
      '<p class="ai-remote-help">Scan QR or open URL — joins the <strong>same room code</strong> and plays the same track.</p>' +
      '<div class="ai-remote-qr"><img src="' + qr + '" width="160" height="160" alt="QR Remote" loading="lazy"></div>' +
      '<label class="ai-remote-label">Room code</label>' +
      '<input type="text" class="ai-remote-url" readonly value="' + String(roomCode).replace(/"/g, '&quot;') + '" onclick="this.select()">' +
      '<label class="ai-remote-label">URL (has room id)</label>' +
      '<input type="text" class="ai-remote-url" id="aiRemoteUrlInput" readonly value="' + String(url).replace(/"/g, '&quot;') + '" onclick="this.select()">' +
      '<div class="ai-remote-actions">' +
      '<button type="button" class="ai-remote-copy" id="aiRemoteCopy">Copy URL</button>' +
      '<button type="button" class="ai-remote-refresh" id="aiRemoteRefresh">Refresh</button>' +
      '</div>' +
      '<p class="ai-remote-note">QR embeds room code. Token ~15 min. No API keys in the link.</p>' +
      '<label class="ai-sync-row"><input type="checkbox" id="aiSyncToggle" ' + (localStorage.getItem('bt_sync_enabled') === '0' ? '' : 'checked') + '> <span>Sync all devices (same track)</span></label>';
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
    const syncEl = document.getElementById('aiSyncToggle');
    if (syncEl) {
      syncEl.addEventListener('change', () => {
        try { localStorage.setItem('bt_sync_enabled', syncEl.checked ? '1' : '0'); } catch (e) {}
        // force re-join room or private on next reload path
        try {
          localStorage.removeItem('bt_session_id');
          localStorage.removeItem('bt_session_id_private');
        } catch (e) {}
        location.reload();
      });
    }
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
  // A new request closes any open "play now / add to queue" card with its default (add after last track).
  resolvePendingChoices();
  appendMsg('user', escapeHtml(text));
  const loading = appendMsg('ai', '…');
  // Prefer music DJ path for almost all chat (except pure settings/help/feedback)
  const nonMusic = /^(help|hướng dẫn|settings|cài đặt|feedback|góp ý|api key|provider|donate)/i.test(text);
  const musicLike = !nonMusic;
  try {
    if (musicLike) {
      const musicReply = await runMusicAI(text);
      if (musicReply) {
        loading.remove();
        if (musicReply.text) appendMsg('ai', escapeHtml(musicReply.text).replace(/\n/g, '<br>'));
        if (musicReply.card) renderChoiceCard(musicReply.card.items, musicReply.card.lang, musicReply.card.intro);
        return;
      }
    }
    // ai.chat() already forwards out.actions to executeActions (onActions) — do not run them twice.
    const out = await ai.chat(text, gameContext());
    loading.remove();
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


ensureRemoteCard();


/* ——— Multilingual voice (AI Chat mic only) ———
 * Chrome/Opera require a secure context (HTTPS or localhost) for mic + SpeechRecognition.
 * We request getUserMedia in the same user gesture, then start STT.
 */
(function initAiVoice() {
  const AUTO_KEY = 'bt_voice_auto_send';
  let voiceRec = null;
  let voiceState = 'idle';
  let mediaStream = null;

  function autoSendOn() {
    try {
      const v = localStorage.getItem(AUTO_KEY);
      if (v == null) return true;
      return v !== '0' && v !== 'false';
    } catch (_) { return true; }
  }

  function SR() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function isSecureOk() {
    try {
      if (window.isSecureContext) return true;
    } catch (_) {}
    const h = location.hostname || '';
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  }

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
        st.className = 'ai-mic-status';
        return;
      }
      st.hidden = false;
      st.className = 'ai-mic-status' + (
        (state === 'error' || state === 'permission_denied' || state === 'unsupported' || state === 'insecure')
          ? ' err' : state === 'success' ? ' ok' : ''
      );
      st.textContent = message || '';
    }
  }

  function stopTracks() {
    if (mediaStream) {
      try { mediaStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      mediaStream = null;
    }
  }

  function stopVoice() {
    try { if (voiceRec) voiceRec.stop(); } catch (_) {}
    try { if (voiceRec) voiceRec.abort(); } catch (_) {}
    voiceRec = null;
    stopTracks();
    if (voiceState === 'listening' || voiceState === 'processing') setMicState('idle', '');
  }

  async function ensureMicPermission() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, reason: 'no_media_devices' };
    }
    try {
      // Must run inside user gesture; unlocks mic for SpeechRecognition on many browsers
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      // Keep tracks briefly so permission stays granted; STT uses its own capture
      // Stop after short delay so the recording indicator does not stick
      setTimeout(stopTracks, 800);
      return { ok: true };
    } catch (e) {
      const name = (e && e.name) || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        return { ok: false, reason: 'denied' };
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return { ok: false, reason: 'no_device' };
      }
      if (name === 'SecurityError' || name === 'NotSupportedError') {
        return { ok: false, reason: 'security' };
      }
      return { ok: false, reason: name || 'error', message: e && e.message };
    }
  }

  function beginRecognition() {
    const Ctor = SR();
    if (!Ctor) {
      setMicState('unsupported', 'Speech recognition not available. Type your command.');
      return;
    }
    const rec = new Ctor();
    voiceRec = rec;
    try {
      // empty / default lets some engines auto-detect; hint with UI language
      rec.lang = navigator.language || document.documentElement.lang || 'en-US';
    } catch (_) {}
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    setMicState('listening', 'Listening… speak now');

    rec.onresult = (ev) => {
      let interim = '';
      let finalText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = (ev.results[i][0] && ev.results[i][0].transcript) || '';
        if (ev.results[i].isFinal) finalText += t;
        else interim += t;
      }
      const input = document.getElementById('aiInput');
      const shown = (finalText || interim || '').trim();
      if (input && shown) input.value = shown;
      if (finalText && finalText.trim()) {
        setMicState('processing', 'Processing…');
        const text = finalText.trim();
        if (input) input.value = text;
        if (autoSendOn()) {
          setTimeout(() => {
            try {
              if (typeof sendAI === 'function') sendAI();
            } catch (_) {}
            setMicState('idle', '');
          }, 60);
        } else {
          setMicState('success', 'Edit text or press send');
          setTimeout(() => setMicState('idle', ''), 2000);
        }
      }
    };

    rec.onerror = (ev) => {
      const err = (ev && ev.error) || 'error';
      voiceRec = null;
      stopTracks();
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        if (!isSecureOk()) {
          setMicState('insecure', 'Mic needs HTTPS (or localhost). Open the SoloHost HTTPS URL, not plain http://IP.');
        } else {
          setMicState('permission_denied', 'Allow microphone for this site in browser settings, then try again.');
        }
      } else if (err === 'no-speech') {
        setMicState('error', 'No speech heard — tap mic and try again.');
        setTimeout(() => setMicState('idle', ''), 2500);
      } else if (err === 'aborted' || err === 'network') {
        // network: Chrome STT cloud sometimes fails
        if (err === 'network') {
          setMicState('error', 'Speech service network error. Check connection or type the command.');
        } else {
          setMicState('idle', '');
        }
        setTimeout(() => { if (voiceState === 'error') setMicState('idle', ''); }, 3000);
      } else if (err === 'audio-capture') {
        setMicState('error', 'No microphone found.');
      } else {
        setMicState('error', 'Voice: ' + err);
        setTimeout(() => setMicState('idle', ''), 3000);
      }
    };

    rec.onend = () => {
      voiceRec = null;
      if (voiceState === 'listening') setMicState('idle', '');
    };

    try {
      rec.start();
    } catch (e) {
      voiceRec = null;
      setMicState('error', (e && e.message) || 'Could not start listening.');
    }
  }

  async function startVoiceCommand() {
    if (voiceState === 'listening') {
      stopVoice();
      return;
    }
    if (!SR()) {
      setMicState('unsupported', 'This browser has no Speech Recognition. Use Chrome/Edge or type.');
      return;
    }
    // Secure context check (Chrome/Opera block mic on http://public-ip)
    if (!isSecureOk()) {
      setMicState(
        'insecure',
        'Microphone blocked on HTTP. Use HTTPS URL from SoloHost, or open via localhost. Typing still works.'
      );
      return;
    }

    setMicState('processing', 'Requesting microphone…');
    const perm = await ensureMicPermission();
    if (!perm.ok) {
      if (perm.reason === 'denied') {
        setMicState('permission_denied', 'Microphone blocked. Site settings → allow Microphone, reload, try again.');
      } else if (perm.reason === 'no_device') {
        setMicState('error', 'No microphone detected.');
      } else if (perm.reason === 'security' || perm.reason === 'no_media_devices') {
        setMicState('insecure', 'Mic requires HTTPS or localhost in this browser.');
      } else {
        setMicState('error', 'Mic error: ' + (perm.message || perm.reason || 'unknown'));
      }
      return;
    }
    beginRecognition();
  }

  function applyMicAvailability() {
    const btn = document.getElementById('aiMic');
    const st = document.getElementById('aiMicStatus');
    if (!btn) return;

    const secure = isSecureOk();
    const hasSR = !!SR();
    const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

    console.info('[BT Voice] context', {
      isSecureContext: !!(window.isSecureContext),
      protocol: location.protocol,
      host: location.host,
      hostname: location.hostname,
      secureOk: secure,
      speechRecognition: hasSR,
      getUserMedia: hasGUM,
    });

    if (!hasSR) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('mic-disabled');
      btn.title = 'Voice not supported — type your command';
      setMicState('unsupported', 'Speech recognition unavailable. Type your command.');
      console.warn('[BT Voice] SpeechRecognition API missing — mic disabled');
      return;
    }

    if (!secure) {
      // Disable / soft-hide immediately — do not wait for click
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('mic-disabled');
      btn.title = 'Microphone needs HTTPS or localhost';
      btn.style.opacity = '0.45';
      btn.style.cursor = 'not-allowed';
      setMicState(
        'insecure',
        'Mic unavailable on HTTP. Use HTTPS or localhost. Typing still works.'
      );
      console.warn(
        '[BT Voice] Microphone disabled: page is not a secure context.',
        'Chrome/Opera block getUserMedia + SpeechRecognition on http://IP.',
        'Open via https://… or http://localhost / http://127.0.0.1'
      );
      return;
    }

    // Secure context — enable mic
    btn.disabled = false;
    btn.removeAttribute('aria-disabled');
    btn.classList.remove('mic-disabled');
    btn.style.opacity = '';
    btn.style.cursor = '';
    btn.title = 'Voice command';
    if (st && voiceState === 'insecure') setMicState('idle', '');
    console.info('[BT Voice] Microphone ready (secure context)');
  }

  function bind() {
    const btn = document.getElementById('aiMic');
    if (!btn) return;
    applyMicAvailability();
    if (btn.dataset.voiceBound === '1') return;
    btn.dataset.voiceBound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isSecureOk()) {
        applyMicAvailability();
        return;
      }
      startVoiceCommand();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
  // Panel / DOM may appear slightly later
  setTimeout(bind, 300);
  setTimeout(bind, 1200);
})();
