'use strict';
/**
 * Background Tube — App Adapter (AI Kernel knowledge + safe actions)
 */

const knowledge = `Background Tube — lightweight YouTube music player (SoloHost).

AI MUSIC CONTROL (robot button · Chat tab)
You are a music assistant. Prefer structured actions over long chat when the user wants playback.

PLAYBACK
- play / pause / stop / next / previous
- seek to N seconds ("seek 90", "tua 1 phút")
- shuffle, repeat (off → one → all)
- volume 0–100, mute / unmute (browser/IFrame permitting)
- sleep timer: "sleep 30", "hẹn giờ 20 phút", "sleep off"
- now playing / queue status

QUEUE
- Play a song or list → resolve → play (autoPlay)
- "Add to queue [song]" → queue without replacing current
- clear queue

DISCOVERY
- "Play chill Vietnamese music" / "10 bài V-pop" → recommendation
- Ranking: personal preference → local trend → global trend
- Resolve path: cache → known map → history → YouTube Search API last
- Karaoke: "karaoke [song]"
- Similar: "more like this"


SEARCH TAB
- Default mode: AI search (describe mood/artist → recommend → play)
- Toggle to YouTube for classic Data API search
- Speak via the phone keyboard mic: tap the search field, then use the keyboard microphone (no separate floating mic button)

VOICE
- Keyboard mic on the search field (OS voice typing)
- AI Chat for full natural-language control
- AI Chat text (and voice-typed into chat) = full intent above

UI
- Home · Search · Library (favorites, history, playlists) · Settings
- Player: mini + full, Karaoke, QR multi-device remote
- Multi-device: same session, near-sync play/pause/queue

FEEDBACK / SETTINGS
- Feedback tab · AI Settings (providers + keys server-side, masked)

Answer in the user's language (English or Vietnamese). Be concise.
Without API key, still answer using this manual and live context.
`;

const actions = [
  { name: 'play', description: 'Resume playback' },
  { name: 'pause', description: 'Pause playback' },
  { name: 'stop', description: 'Stop playback' },
  { name: 'toggle', description: 'Toggle play/pause' },
  { name: 'next', description: 'Next track' },
  { name: 'previous', description: 'Previous track' },
  { name: 'seek', description: 'Seek to seconds', args: ['seconds'] },
  { name: 'shuffle', description: 'Toggle shuffle' },
  { name: 'repeat', description: 'Cycle repeat off/one/all' },
  { name: 'volume', description: 'Set volume 0-100', args: ['level'] },
  { name: 'mute', description: 'Mute audio' },
  { name: 'unmute', description: 'Unmute audio' },
  { name: 'sleep', description: 'Sleep timer minutes (0=off)', args: ['minutes'] },
  { name: 'queue_add', description: 'Add tracks; autoPlay optional', args: ['items', 'autoPlay'] },
  { name: 'play_next', description: 'Insert after current', args: ['items'] },
  { name: 'queue_clear', description: 'Clear queue' },
  { name: 'now_playing', description: 'Report current track' },
  { name: 'queue_status', description: 'Report queue length' },
  { name: 'favorite', description: 'Toggle favorite', args: ['videoId'] },
  { name: 'search', description: 'Open search with query', args: ['query'] },
  { name: 'recommend', description: 'Recommend by mood/language', args: ['mood', 'language', 'limit'] },
  { name: 'karaoke', description: 'Karaoke search/play', args: ['query'] },
  { name: 'open_tab', description: 'UI tab home|search|library|settings' },
  { name: 'open_player', description: 'Open full player' },
  { name: 'session_status', description: 'Multi-device session status' },
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
    sleep: base.sleep || null,
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
  if (!m) {
    return 'Try: Play [song], Pause, Next, Sleep 30, Volume 50, Clear queue, Karaoke [song], or "10 chill V-pop tracks".';
  }
  if (/help|hướng dẫn|what can|bạn làm được|cách dùng/.test(m)) {
    return 'Controls: play/pause/stop/next/prev, seek, shuffle, repeat, volume, mute, sleep timer, queue add/clear. Discovery: recommend by mood, karaoke, similar. Mic on Search = fast search; Chat = full AI control.';
  }
  if (/sleep|hẹn giờ|timer/.test(m)) {
    return 'Say "sleep 30" (minutes) or "hẹn giờ 20 phút". "sleep off" cancels. Playback pauses when the timer ends.';
  }
  if (/volume|âm lượng|mute/.test(m)) {
    return 'Say "volume 50" (0–100), "mute", or "unmute". Support depends on the YouTube player in your browser.';
  }
  if (/queue|danh sách|clear/.test(m)) {
    return 'Say "add to queue [song]", "clear queue", or "queue status". AI can also play a full recommended list.';
  }
  if (/play|phát|pause|dừng|next|tiếp|stop|tắt/.test(m)) {
    return 'Say Play, Pause, Stop, Next, Previous — or "Play Sơn Tùng". Recommendations go to the queue and can auto-play.';
  }
  if (/karaoke|remote|qr|recommend|gợi/.test(m)) {
    return 'Karaoke: say "karaoke [title]" in Chat. Remote: open AI panel — QR/URL at top of Chat (public IP:port). Recommend: mood + language.';
  }
  const now = L.title
    ? `Now: ${L.title}${L.channel ? ' · ' + L.channel : ''}${L.playing ? ' (playing)' : ' (paused)'}.`
    : 'No track loaded.';
  return `${now} Ask for play, pause, sleep timer, volume, queue, or recommendations. Works offline as a local guide.`;
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
