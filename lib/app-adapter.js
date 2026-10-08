'use strict';
/**
 * Background Tube — App Adapter (AI Kernel knowledge + safe actions)
 */

const knowledge = `Background Tube — lightweight YouTube music player (SoloHost).

AI MUSIC CONTROL (robot button · Chat tab)
VOICE: one 🎤 inside Chat input only (not on Player/Search). Speak → transcript → local intent (next/pause without AI) or AI recommendation. Browser Web Speech API, multilingual.
You are a music assistant. Prefer structured actions over long chat when the user wants playback.

PLAYBACK
- play / pause / stop / next / previous
- seek to N seconds ("seek 90", "tua 1 phút")
- shuffle, repeat (off → one → all)
- volume 0–100, mute / unmute (browser/IFrame permitting)
- sleep timer: "sleep 30", "hẹn giờ 20 phút", "sleep off"
- now playing / queue status

QUEUE
- Play a song or list → resolve → play
  · Nothing playing → the requested song starts immediately.
  · Music already playing → the panel shows two big buttons: "Play now" (starts it, keeps the rest of the queue)
    and "Add to queue" (goes after the LAST track). If the user chooses nothing within ~15 s it is added after the last track.
- "Add to queue [song]" / "thêm [bài] vào danh sách phát" → queue without replacing current
- "play next [song]" / "phát tiếp theo [bài]" → insert right after the current track
- "play track 3" / "phát bài số 3" → jump inside the queue; "remove track 3" / "xóa bài số 3"
- clear queue

PLAYLISTS (local to this browser; the AI may manage them)
- "tạo playlist Chill gồm 10 bài nhạc Việt chill" / "create playlist Study with lofi" → create and fill
- "tạo playlist Gym" (empty) · "tạo playlist từ hàng đợi tên Đi làm" (from current queue)
- "thêm bài này vào playlist Gym" · "add [song] to playlist Gym"
- "phát playlist Gym" · "đổi tên playlist A thành B" · "liệt kê playlist"
- "xóa playlist Gym" always asks the user to confirm
- "thích bài này" / "like this" toggles favorite on the current track

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


SYNC / HOST
- The device that generates the QR/URL is always HOST. The scanner is GUEST (remote control).
- QR embeds ?s=ROOM&host=HOST_CLIENT_ID. Badge: Sync · HOST|GUEST · roomCode.
- Guest can pause, seek, next, previous, add/play tracks as a normal remote.
- Only host heartbeats keep continuous position. On lag/reconnect, guests pull host state and do not push stale position.
- Sync layers: SSE + host heartbeat + 10s poll + join snapshot.

THEME
- Default: Rainbow. Options: Dark, Light, Rainbow (Settings).
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
  { name: 'queue_append', description: 'Add tracks after the LAST queue track (no interruption)', args: ['items'] },
  { name: 'play_now', description: 'Play tracks immediately, keep queue (inserted after current)', args: ['items'] },
  { name: 'play_index', description: 'Play the N-th track of the queue (1-based)', args: ['index'] },
  { name: 'queue_remove', description: 'Remove the N-th queue track (1-based)', args: ['index'] },
  { name: 'queue_clear', description: 'Clear queue' },
  { name: 'playlist_create', description: 'Create (and optionally fill) a local playlist', args: ['name', 'items', 'fromQueue', 'current', 'play'] },
  { name: 'playlist_add', description: 'Add tracks (or the current track) to a playlist', args: ['name', 'items'] },
  { name: 'playlist_play', description: 'Play a playlist', args: ['name'] },
  { name: 'playlist_queue', description: 'Append a playlist after the last queue track', args: ['name'] },
  { name: 'playlist_rename', description: 'Rename a playlist', args: ['name', 'newName'] },
  { name: 'playlist_delete', description: 'Delete a playlist (host asks the user to confirm)', args: ['name'], confirmOnClient: true },
  { name: 'playlist_list', description: 'List playlists' },
  { name: 'now_playing', description: 'Report current track' },
  { name: 'queue_status', description: 'Report queue length' },
  { name: 'favorite', description: 'Toggle favorite on the current track', args: ['videoId'] },
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
  const pick = (k, dflt) => (base[k] != null ? base[k] : (c[k] != null ? c[k] : dflt));
  return {
    screen: c.screen || base.screen || 'home',
    playing: !!pick('playing', false),
    title: pick('title', null),
    channel: pick('channel', null),
    videoId: pick('videoId', null),
    queueLength: pick('queueLength', 0),
    index: pick('index', -1),
    shuffle: !!pick('shuffle', false),
    repeat: pick('repeat', 'off'),
    sessionId: pick('sessionId', null),
    karaoke: !!pick('karaoke', false),
    sleep: pick('sleep', null),
    queuePreview: Array.isArray(c.queuePreview) ? c.queuePreview.slice(0, 15).map((x) => String(x).slice(0, 80)) : [],
    playlists: Array.isArray(c.playlists) ? c.playlists.slice(0, 30).map((p) => ({ name: String(p && p.name || '').slice(0, 60), count: Number(p && p.count) || 0 })) : [],
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
