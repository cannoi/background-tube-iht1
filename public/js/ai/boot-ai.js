/**
 * Background Tube — AI panel bootstrap + music action bridge
 */
import {
  getPlayerState, playVideo, togglePlayPause, next, previous, cycleRepeat,
  toggleShuffle, stopPlayback
} from '../player.js';
import { toast } from '../ui.js';

function musicContext() {
  const p = getPlayerState();
  return {
    screen: document.querySelector('.nav-btn.active')?.dataset?.tab || 'home',
    playing: !!p.playing,
    title: p.active?.title || null,
    channel: p.active?.channelTitle || null,
    videoId: p.active?.videoId || null,
    queueLength: (p.queue || []).length,
    index: p.index,
    shuffle: !!p.shuffle,
    repeat: p.repeat || 'off',
  };
}

async function applyMusicItems(items, autoPlay) {
  if (!items || !items.length) return;
  const first = items[0];
  if (autoPlay !== false && first?.videoId) {
    playVideo(first, items);
  } else if (first?.videoId) {
    // queue only via sequential playVideo with autoplay false is not in player —
    // play first for usability
    playVideo(first, items);
  }
  try {
    toast(`AI: ${items.length} track(s)`);
  } catch (_) {}
}

async function handleMusicAIMessage(message) {
  const res = await fetch('/api/music/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, context: musicContext() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'AI music failed');

  // Execute player controls
  for (const a of data.actions || []) {
    const name = a.name || a.action;
    if (name === 'next') next();
    else if (name === 'previous') previous();
    else if (name === 'pause') { const p = getPlayerState(); if (p.playing) togglePlayPause(); }
    else if (name === 'play') { const p = getPlayerState(); if (!p.playing) togglePlayPause(); }
    else if (name === 'toggle') togglePlayPause();
    else if (name === 'shuffle') toggleShuffle();
    else if (name === 'repeat') cycleRepeat();
    else if (name === 'queue_add' && data.items?.length) await applyMusicItems(data.items, data.intent?.autoPlay !== false);
  }

  if (data.items?.length && data.intent && ['music_search', 'recommendation', 'karaoke'].includes(data.intent.intent)) {
    await applyMusicItems(data.items, data.intent.autoPlay !== false);
  }

  return data;
}

function executeClientActions(actions) {
  (actions || []).forEach((a) => {
    if (!a || a.ok === false) return;
    const name = a.action || a.name;
    const value = a.value || (a.args && a.args.value) || '';
    if (name === 'open_tab') {
      document.querySelector(`.nav-btn[data-tab="${value || 'home'}"]`)?.click();
    }
    if (name === 'open_player') document.querySelector('[data-action="open-player"]')?.click();
    if (name === 'next') next();
    if (name === 'previous') previous();
    if (name === 'pause' || name === 'play' || name === 'toggle') togglePlayPause();
    if (name === 'shuffle') toggleShuffle();
    if (name === 'repeat') cycleRepeat();
  });
}

function setUnread(n) {
  const badge = document.getElementById('aiBadge');
  const tabBadge = document.getElementById('fbTabBadge');
  const count = Number(n) || 0;
  [badge, tabBadge].forEach((el) => {
    if (!el) return;
    if (count > 0) {
      el.hidden = false;
      el.style.display = '';
      el.textContent = count > 9 ? '9+' : String(count);
    } else {
      el.hidden = true;
      el.style.display = 'none';
      el.textContent = '';
    }
  });
}

function setFabVisible(visible) {
  const fab = document.getElementById('aiFab');
  if (!fab) return;
  fab.hidden = !visible;
  fab.style.display = visible ? '' : 'none';
}

function openPanel() {
  const overlay = document.getElementById('aiOverlay');
  if (overlay) {
    overlay.hidden = false;
    overlay.classList.add('open');
  }
  setFabVisible(false);
}

function closePanel() {
  const overlay = document.getElementById('aiOverlay');
  if (overlay) {
    overlay.hidden = true;
    overlay.classList.remove('open');
  }
  setFabVisible(true);
}

function switchTab(name) {
  document.querySelectorAll('#panelTabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('#aiPanel .tab-pane').forEach((p) => {
    p.classList.toggle('active', p.id === 'tab-' + name);
  });
}

function appendChat(role, text) {
  const box = document.getElementById('aiChat');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'ai-msg ' + role;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  const input = document.getElementById('aiInput');
  const msg = (input?.value || '').trim();
  if (!msg) return;
  input.value = '';
  appendChat('user', msg);

  // Prefer music AI endpoint for music-like queries
  const musicLike = /play|pause|next|prev|karaoke|nhạc|music|recommend|gợi|chill|workout|phát|dừng|tiếp|hát/i.test(msg);
  try {
    if (musicLike) {
      const data = await handleMusicAIMessage(msg);
      appendChat('assistant', data.reply || 'OK');
      executeClientActions(data.actions);
      return;
    }
  } catch (e) {
    console.warn('music AI path', e);
  }

  // General AI chat
  try {
    if (window.UniversalAI) {
      const client = window.__btAI || window.UniversalAI.create({
        onActions: executeClientActions,
      });
      window.__btAI = client;
      const out = await client.chat(msg, musicContext());
      appendChat('assistant', out.reply || out.error || 'No response');
      executeClientActions(out.actions);
    } else {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, context: musicContext() }),
      });
      const out = await res.json();
      appendChat('assistant', out.reply || out.error || 'No response');
      executeClientActions(out.actions);
    }
  } catch (e) {
    appendChat('assistant', 'Offline guide: use Search, Library, or player controls. AI key optional.');
  }
}

async function loadSettingsUI() {
  try {
    const [cat, st] = await Promise.all([
      fetch('/api/ai/catalog').then((r) => r.json()),
      fetch('/api/ai/settings').then((r) => r.json()),
    ]);
    const sel = document.getElementById('aiProvider');
    if (sel && cat.providers) {
      sel.innerHTML = cat.providers.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
      sel.value = st.provider || 'none';
    }
    const key = document.getElementById('aiApiKey');
    if (key) key.placeholder = st.maskedKey || '••••';
    const base = document.getElementById('aiBaseUrl');
    if (base) base.value = st.baseUrl || '';
    const model = document.getElementById('aiModel');
    if (model) model.value = st.model || 'auto';
    const mode = document.getElementById('aiMode');
    if (mode) mode.value = st.mode || 'cloud_enabled';
    const bar = document.getElementById('aiStatusBar');
    if (bar) bar.textContent = st.hasKey || st.provider === 'local' ? `AI: ${st.provider}` : 'AI: not configured (local guide still works)';
  } catch (_) {}
}

async function saveSettings() {
  const body = {
    provider: document.getElementById('aiProvider')?.value,
    apiKey: document.getElementById('aiApiKey')?.value,
    baseUrl: document.getElementById('aiBaseUrl')?.value,
    model: document.getElementById('aiModel')?.value,
    mode: document.getElementById('aiMode')?.value,
  };
  const res = await fetch('/api/ai/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json();
  const st = document.getElementById('aiSettingsStatus');
  if (st) st.textContent = out.ok ? 'Saved' : (out.error || 'Failed');
  loadSettingsUI();
}

export function initAI() {
  const fab = document.getElementById('aiFab');
  const close = document.getElementById('aiClose');
  fab?.addEventListener('click', () => { openPanel(); loadSettingsUI(); });
  close?.addEventListener('click', closePanel);
  document.getElementById('aiOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'aiOverlay') closePanel();
  });
  document.querySelectorAll('#panelTabs .tab').forEach((t) => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });
  document.getElementById('aiSend')?.addEventListener('click', sendChat);
  document.getElementById('aiInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  document.getElementById('aiSaveSettings')?.addEventListener('click', saveSettings);
  document.getElementById('aiTestProvider')?.addEventListener('click', async () => {
    const st = document.getElementById('aiSettingsStatus');
    try {
      const r = await fetch('/api/ai/test', { method: 'POST' });
      const j = await r.json();
      if (st) st.textContent = j.ok !== false ? 'Token OK' : (j.error || 'Failed');
    } catch (e) {
      if (st) st.textContent = e.message;
    }
  });
  document.getElementById('aiRefreshModels')?.addEventListener('click', async () => {
    try {
      const j = await fetch('/api/ai/models').then((r) => r.json());
      const st = document.getElementById('aiSettingsStatus');
      if (st) st.textContent = j.models ? `${j.models.length} models` : (j.error || 'No models');
    } catch (e) {}
  });
  document.getElementById('aiClearLogs')?.addEventListener('click', async () => {
    await fetch('/api/logs', { method: 'DELETE' });
    const box = document.getElementById('aiLogs');
    if (box) box.innerHTML = '';
  });

  // Feedback
  let rating = 0;
  document.querySelectorAll('#fbStars button').forEach((b) => {
    b.addEventListener('click', () => {
      rating = Number(b.dataset.r);
      document.querySelectorAll('#fbStars button').forEach((x) => {
        x.classList.toggle('on', Number(x.dataset.r) <= rating);
      });
    });
  });
  document.getElementById('fbSend')?.addEventListener('click', async () => {
    const st = document.getElementById('fbStatus');
    try {
      if (window.UniversalFeedback) {
        const fb = window.__btFB || window.UniversalFeedback.create({ onUnread: setUnread });
        window.__btFB = fb;
        await fb.send({
          type: document.getElementById('fbType')?.value || 'improvement',
          rating,
          message: document.getElementById('fbMessage')?.value || '',
        });
        if (st) st.textContent = 'Sent';
        const msg = document.getElementById('fbMessage');
        if (msg) msg.value = '';
      }
    } catch (e) {
      if (st) st.textContent = e.message || 'Failed';
    }
  });

  try {
    if (window.UniversalFeedback) {
      const fb = window.UniversalFeedback.create({
        onUnread: setUnread,
        onSync: (sync) => {
          const donate = document.getElementById('fbDonate');
          if (donate && sync?.donate) {
            donate.hidden = false;
            donate.textContent = typeof sync.donate === 'string' ? sync.donate : JSON.stringify(sync.donate);
          }
        },
      });
      window.__btFB = fb;
      fb.sync().catch(() => {});
    }
  } catch (_) {}

  loadSettingsUI();
  appendChat('assistant', 'Hi! Ask me to play music, recommend songs, karaoke, or control the player. Voice search is on the Search tab.');
}

export { handleMusicAIMessage, musicContext, applyMusicItems };
