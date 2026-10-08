'use strict';
/**
 * Background Tube — App Adapter for Universal AI Module
 * Whitelist music actions only. No shell/Docker/system ops.
 */

const knowledge = `Background Tube is a lightweight YouTube music player (SoloHost).

MAIN FEATURES
- Home: popular/trending tracks by region
- Search: type or voice-search YouTube music (official embed)
- Library: favorites, history, playlists (local)
- Player: play/pause/next/previous/seek, shuffle, repeat one/all, queue, autoplay
- AI Music Assistant (robot button): natural language play, recommend, queue, karaoke
- Voice Search (mic near search): fast speech → search
- QR Remote: pair another device as Remote or join same playback session
- Karaoke mode: prefer karaoke/instrumental versions
- Multi-window: shared playback session via WebSocket

HOW TO USE
1. Search or open Home → tap a track to play
2. Mic button → speak artist/song → instant search
3. Robot AI button → ask e.g. "Play relaxing Vietnamese music", "Next", "Add similar to queue"
4. Player overlay: controls, queue, favorites, karaoke, QR
5. Library tab: favorites, history, playlists
6. Settings: theme, region, autoplay, AI provider keys (server-side)

AI MUSIC FLOW
- AI understands intent (control / search / recommend / karaoke / help)
- For recommendations AI proposes candidates (artist + title)
- App resolves candidates to YouTube videoIds with cache-first (minimal Search API quota)
- Personal preference > local trend > global trend

CONTROLS
- play, pause, next, previous, seek, shuffle, repeat
- queue add / play next / remove
- favorite, playlist
- karaoke toggle
- remote session status

LIMITATIONS
- Official YouTube IFrame only (no download/rip)
- Background playback depends on browser/OS
- Voice recognition needs browser SpeechRecognition support
- YouTube API quota is limited — AI discovery prefers cache/local library
`;

const actions = [
  { name: 'play', description: 'Resume playback' },
  { name: 'pause', description: 'Pause playback' },
  { name: 'toggle', description: 'Toggle play/pause' },
  { name: 'next', description: 'Next track' },
  { name: 'previous', description: 'Previous track' },
  { name: 'seek', description: 'Seek to seconds', args: ['seconds'] },
  { name: 'shuffle', description: 'Toggle shuffle' },
  { name: 'repeat', description: 'Cycle repeat off/one/all' },
  { name: 'queue_add', description: 'Add track(s) to queue', args: ['items'] },
  { name: 'play_next', description: 'Insert track(s) after current', args: ['items'] },
  { name: 'queue_clear', description: 'Clear user queue' },
  { name: 'favorite', description: 'Toggle favorite for current or videoId', args: ['videoId'] },
  { name: 'search', description: 'Run normal YouTube search', args: ['query'] },
  { name: 'recommend', description: 'AI recommend by mood/language', args: ['mood', 'language', 'limit'] },
  { name: 'karaoke', description: 'Search/play karaoke version', args: ['query'] },
  { name: 'open_tab', description: 'Open UI tab: home, search, library, settings' },
  { name: 'open_player', description: 'Open full player overlay' },
  { name: 'session_status', description: 'Report playback session status' },
];

const ALLOWED = new Set(actions.map((a) => a.name));

/** Live player state is injected by server music engine when available */
let liveGetter = null;
function setLiveGetter(fn) {
  liveGetter = fn;
}

async function getContext(ctx) {
  const base = (typeof liveGetter === 'function' ? liveGetter() : null) || {};
  const c = ctx || {};
  return {
    screen: c.screen || base.screen || 'home',
    playing: !!base.playing,
    title: base.title || null,
    channel: base.channel || null,
    videoId: base.videoId || null,
    queueLength: base.queueLength || 0,
    index: base.index != null ? base.index : -1,
    shuffle: !!base.shuffle,
    repeat: base.repeat || 'off',
    sessionId: base.sessionId || null,
    karaoke: !!base.karaoke,
    language: c.language || null,
  };
}

async function executeAction({ name, args }) {
  const n = String(name || '').trim();
  if (!ALLOWED.has(n)) return { ok: false, error: 'Action not allowed', action: n };
  // Server-side: mark for client_execute; music engine may handle some
  return {
    ok: true,
    action: n,
    args: args || {},
    client_execute: true,
  };
}

async function localReply(message, live) {
  const m = String(message || '').toLowerCase().trim();
  const L = live || {};

  if (!m) {
    return 'Ask me to play music, recommend songs, control the player, or open Karaoke. Example: "Play chill Vietnamese music".';
  }

  if (/help|hướng dẫn|cách dùng|how to|manual|hướng dẫn sử dụng/.test(m)) {
    return 'Home = trending · Search = type or mic · Library = favorites/history · Robot AI = natural language music · Player = controls + karaoke + QR remote.';
  }
  if (/play|phát|bật|tiếp|next|pause|dừng|tạm dừng|previous|trước/.test(m)) {
    return 'I can play, pause, next, previous. Open the robot button and say e.g. "Next" or "Play Sơn Tùng". Player works even without AI key.';
  }
  if (/karaoke|hát|lyrics|lời/.test(m)) {
    return 'Say "Karaoke [song name]" or open the player and tap Karaoke. We prefer official karaoke/instrumental YouTube embeds.';
  }
  if (/remote|qr|điều khiển|đồng bộ|sync|session/.test(m)) {
    return 'Open the player → QR. Scan to use your phone as Remote or join the same session. Tokens expire and never include API keys.';
  }
  if (/search|tìm|mic|voice|giọng nói/.test(m)) {
    return 'Type in Search, or tap the mic for fast voice search. AI chat is for natural requests like "10 chill V-pop tracks tonight".';
  }
  if (/recommend|gợi ý|nhạc|music|chill|workout|relax/.test(m)) {
    return 'Ask AI: mood + language, e.g. "Give me 10 Vietnamese chill songs". Personal preference ranks above local/global trends. Quota-saving resolution is used.';
  }
  if (/favorite|yêu thích|playlist|thư viện|library|history|lịch sử/.test(m)) {
    return 'Library tab stores favorites, history and playlists on this device. Favorites help personal recommendations.';
  }
  if (/setting|api|key|provider|cài đặt|gemini|openai/.test(m)) {
    return 'AI Settings tab: choose provider (OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, Local), paste key, Save. Keys stay on the server and are masked.';
  }
  if (/feedback|góp ý|bug|donate|ủng hộ/.test(m)) {
    return 'Feedback tab: send bug / improvement / question. Donate info comes only from Feedback Hub sync — never hard-coded.';
  }
  if (/quota|api youtube|hết hạn mức/.test(m)) {
    return 'YouTube Search API is rate-limited. AI discovery uses candidate cache and local library first; broad search is last resort.';
  }

  const now = L.title
    ? `Now: ${L.title}${L.channel ? ' · ' + L.channel : ''}${L.playing ? ' (playing)' : ' (paused)'}.`
    : 'No track loaded.';
  return `${now} Ask me to play, recommend, karaoke, or control the queue. Without an AI key I still answer with this local guide.`;
}

module.exports = {
  knowledge,
  actions,
  getContext,
  executeAction,
  localReply,
  setLiveGetter,
  ALLOWED,
};
