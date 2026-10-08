'use strict';
/**
 * Background Tube — App Adapter for Universal AI Module
 */

const knowledge = `Background Tube is a lightweight YouTube music player (SoloHost / Pi).

VERSION: 1.2.x — AI Music + Multi-device

MAIN TABS
- Home: regional popular / trending music
- Search: type or microphone voice search (fast, not AI)
- Library: favorites, play history, playlists (stored on this device)
- Settings: theme, region, autoplay

PLAYER
- Official YouTube IFrame embed only (no download/rip)
- Controls: play, pause, next, previous, seek, shuffle, repeat one/all
- Queue: add, play next, remove, clear; survives refresh (local)
- Favorites & playlists & history in Library
- Mini player + full player overlay
- Media Session where the browser supports it

AI MUSIC ASSISTANT (robot button, bottom-right)
Panel tabs: Chat | Feedback | Settings | Logs
Natural language examples:
- "Play relaxing Vietnamese music" → recommend → resolve (cache-first) → queue → play
- "Next" / "Pause" / "Shuffle" → player control
- "Karaoke [song]" → karaoke-oriented resolve
- "Songs like this" → similar recommendation
AI proposes artist+title candidates. App resolves to videoId using:
  1) candidate cache  2) known mappings  3) local history/library  4) YouTube Search API only as last resort
Personal preference ranks above local trend, which ranks above global trend.
Without an API key, Chat still answers with this local guide.

VOICE SEARCH (mic near Search field)
- Speaks artist/song → fills search → normal YouTube search
- Different from AI chat voice/text commands

MULTI-DEVICE / QR REMOTE
- Player → QR: create short-lived pairing link (session id + token, NO API keys)
- Modes: Remote (control another device) or Player (join same session)
- Shared session: same track, queue, play/pause, seek (near-sync via SSE)
- Open the pair URL on another phone/window to join
- Token expires (~15 min) and can be revoked

KARAOKE
- Button on player or ask AI "karaoke …"
- Prefers karaoke/instrumental YouTube results
- Lyrics panel is graceful fallback (no fake sync)

FEEDBACK
- Feedback tab: bug / improvement / question / playback / AI / karaoke / remote
- Notices badge on robot button; donate info only from Feedback Hub sync

AI SETTINGS
- Providers: OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, Local
- Keys stored server-side only, masked when read back

LIMITATIONS
- YouTube quota limits Search API — AI discovery is cache-first
- Background playback depends on mobile browser policy
- Multi-device sync is near-sync (not sample-perfect) due to IFrame timing
- Voice recognition needs browser SpeechRecognition support
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
  { name: 'queue_add', description: 'Add track(s) to queue and optionally play', args: ['items'] },
  { name: 'play_next', description: 'Insert track(s) after current', args: ['items'] },
  { name: 'queue_clear', description: 'Clear user queue' },
  { name: 'favorite', description: 'Toggle favorite for current or videoId', args: ['videoId'] },
  { name: 'search', description: 'Run normal YouTube search', args: ['query'] },
  { name: 'recommend', description: 'AI recommend by mood/language', args: ['mood', 'language', 'limit'] },
  { name: 'karaoke', description: 'Search/play karaoke version', args: ['query'] },
  { name: 'open_tab', description: 'Open UI tab: home, search, library, settings' },
  { name: 'open_player', description: 'Open full player overlay' },
  { name: 'session_status', description: 'Report multi-device session status' },
];

const ALLOWED = new Set(actions.map((a) => a.name));

let liveGetter = null;
function setLiveGetter(fn) { liveGetter = fn; }

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
  };
}

async function executeAction({ name, args }) {
  const n = String(name || '').trim();
  if (!ALLOWED.has(n)) return { ok: false, error: 'Action not allowed', action: n };
  return { ok: true, action: n, args: args || {}, client_execute: true };
}

async function localReply(message, live) {
  const m = String(message || '').toLowerCase().trim();
  const L = live || {};
  if (!m) return 'Ask me to play music, recommend songs, control the player, karaoke, or QR remote. Example: "Play chill Vietnamese music".';
  if (/help|hướng dẫn|cách dùng|how to|manual/.test(m)) {
    return 'Home = trending · Search / mic = find songs · Library = favorites & playlists · Robot AI = natural language music · Player QR = multi-device remote.';
  }
  if (/play|phát|bật|next|tiếp|pause|dừng|previous|trước|shuffle|repeat/.test(m)) {
    return 'Say Next, Pause, Play, Shuffle, or "Play Sơn Tùng". AI can also queue recommendations. Player works without an AI key.';
  }
  if (/karaoke|hát|lyrics|lời/.test(m)) {
    return 'Say "Karaoke [song]" or tap Karaoke on the player. We prefer official karaoke/instrumental embeds.';
  }
  if (/remote|qr|điều khiển|đồng bộ|sync|session|multi/.test(m)) {
    return 'Open player → QR. Share the link with another phone/window. Same session = same track, queue, play/pause (near-sync). Tokens expire; no API keys in the link.';
  }
  if (/search|tìm|mic|voice|giọng/.test(m)) {
    return 'Search tab: type or tap the mic for fast voice search. AI chat is for natural requests like "10 chill V-pop tracks".';
  }
  if (/recommend|gợi ý|nhạc|music|chill|workout|relax|quota/.test(m)) {
    return 'Ask for mood + language. Ranking: your preference → local trend → global trend. Resolving tracks uses cache first to save YouTube Search quota.';
  }
  if (/favorite|yêu thích|playlist|library|history|lịch sử/.test(m)) {
    return 'Library stores favorites, history, and playlists on this device. They improve personal recommendations.';
  }
  if (/setting|api|key|provider|cài đặt|gemini|openai/.test(m)) {
    return 'AI Settings: choose provider, paste key, Save. Keys stay on the server and are masked. Custom/Local need Base URL.';
  }
  if (/feedback|góp ý|bug|donate|ủng hộ/.test(m)) {
    return 'Feedback tab: send bug or idea. Donate accounts come only from Feedback Hub sync.';
  }
  const now = L.title
    ? `Now: ${L.title}${L.channel ? ' · ' + L.channel : ''}${L.playing ? ' (playing)' : ' (paused)'}.`
    : 'No track loaded.';
  return `${now} Ask me to play, recommend, karaoke, or control the queue. Local guide works without an AI key.`;
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
