'use strict';
/**
 * Background Tube — App Adapter (AI Kernel knowledge + safe actions)
 */

const musicEngine = require('./music-engine');

const knowledgeBase = `Background Tube — lightweight YouTube music player (SoloHost).

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

RECOMMENDATION KERNEL — CURRENT
- Recommendation priority is strict product policy: Personal preference → Local trends → Global trends.
- Personal preference learns from plays, completed listens, skips, favorites/context supplied by the client, recent tracks, artists, languages, genres and moods.
- Local trends are cached regional music trends; global trends are cached cross-region trends.
- Recommendation must reuse known IDs, recent tracks and trend caches before any YouTube Search API fallback.
- Never perform a YouTube Search API call for every recommendation candidate.
- When AI is unavailable, the same local intent + recommendation engine continues to work and must explain what it can do instead of saying the app is broken.
- AI may recommend candidates, but the app resolves candidates through cache/history/trends first and uses the YouTube Search API only as a final targeted fallback.

PLAYER — CURRENT
- Official YouTube embedded playback only; no download/ripping.
- Full player: play/pause/stop, next/previous, seek, volume/mute, shuffle, repeat, sleep timer, Media Session, mini/full player.
- Queue is persisted locally, supports append/play-next/play-now, indexed playback, removal/clear, and playlist playback.
- History, favorites and playlists are local to the browser/device and remain available without an AI provider.
- Listening events feed the recommendation profile without sending raw listening history to AI.

AI KNOWLEDGE POLICY
- Treat this knowledge and LIVE APP CONTEXT as the current source of truth.
- Do not claim features that are not listed here or exposed as AVAILABLE ACTIONS.
- If AI is unavailable, give a useful local-guide answer and point to the exact action the user can take.

Answer in the user's language (English or Vietnamese). Be concise.
Without API key, still answer using this manual, local intent engine and live context.


SYNC / HOST
- The device that generates the QR/URL is always HOST. The scanner is GUEST (remote control).
- QR embeds ?s=ROOM&host=HOST_CLIENT_ID. Badge: Sync · HOST|GUEST · roomCode.
- Guest can pause, seek, next, previous, add/play tracks as a normal remote.
- Only host heartbeats keep continuous position. On lag/reconnect, guests pull host state and do not push stale position.
- Sync layers: SSE + host heartbeat + 10s poll + join snapshot.

THEME
- Default: Rainbow. Options: Dark, Light, Rainbow (Settings).
`;

function getKnowledge(context = {}) {
  const prefs = musicEngine.getPreferences();
  const top = (obj, n = 5) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  const dynamic = `\n\nLIVE KNOWLEDGE SNAPSHOT
- Knowledge revision: 1.4.4
- Current screen: ${String(context.screen || 'home').slice(0, 30)}
- Learned recent listening signals: ${Array.isArray(prefs.recentTracks) ? prefs.recentTracks.length : 0}
- Top learned artists: ${top(prefs.artists).join(', ') || 'not enough data yet'}
- Top learned languages: ${top(prefs.languages).join(', ') || 'not enough data yet'}
- Recommendation weights: personal ${prefs.weights?.personalPreference ?? 0.60}, local ${prefs.weights?.localTrend ?? 0.25}, global ${prefs.weights?.globalTrend ?? 0.15}
- This snapshot is advisory; use LIVE APP CONTEXT for the actual player state.`;
  return knowledgeBase + dynamic;
}

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
  const prefs = musicEngine.getPreferences();
  const top = (obj, n = 3) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  const artists = top(prefs.artists);
  const languages = top(prefs.languages);
  const now = L.title ? `${L.title}${L.channel ? ' · ' + L.channel : ''}${L.playing ? ' (playing)' : ' (paused)'}` : 'no track loaded';
  if (!m) return 'Try: Play [song], Pause, Next, add to queue, Favorite, or “recommend something for me”.';
  if (/help|hướng dẫn|what can|bạn làm được|cách dùng/.test(m)) {
    return 'I can control playback, manage the queue, favorites and playlists, search music, and recommend tracks. Recommendations prioritize your listening preferences, then local trends, then global trends.';
  }
  if (/recommend|gợi ý|đề xuất|nhạc.*cho tôi|suggest|more like|giống/.test(m)) {
    const pref = artists.length ? `your recent taste (${artists.join(', ')})` : 'your recent listening';
    const lang = languages.length ? ` · language: ${languages.join(', ')}` : '';
    return `I’ll prioritize ${pref}${lang}, then local trends, then global trends. Ask for a mood, language, artist, or “more like this”; AI is optional.`;
  }
  if (/history|lịch sử/.test(m)) return `Your local history is available in Library. ${prefs.recentTracks?.length || 0} recent listening signal(s) currently inform recommendations.`;
  if (/favorite|favourite|yêu thích/.test(m)) return `Favorites are stored locally on this device and can be played or added to playlists from Library.`;
  if (/playlist|danh sách phát/.test(m)) return 'Playlists are stored locally. You can create, rename, delete, play, queue, and add the current song or queue to a playlist.';
  if (/queue|hàng đợi|danh sách phát hiện/.test(m)) return `Queue: ${Number(L.queueLength || 0)} track(s). You can add to the end, play next, remove by number, clear, shuffle, or repeat.`;
  if (/sleep|hẹn giờ|timer/.test(m)) return 'Say “sleep 30” (minutes) or “hẹn giờ 20 phút”. “sleep off” cancels the timer.';
  if (/volume|âm lượng|mute/.test(m)) return 'Say “volume 50”, “mute”, or “unmute”. Support depends on the YouTube player/browser.';
  if (/karaoke/.test(m)) return 'Say “karaoke [song]” to find a karaoke-oriented version. The app does not download or rip audio.';
  if (/remote|qr/.test(m)) return 'Remote control and QR session sync are already available. Use the QR Remote entry in the player.';
  if (/play|phát|pause|dừng|next|tiếp|stop|tắt/.test(m)) return `Current player: ${now}. Use Play, Pause, Stop, Next, Previous, or name a song.`;
  return `Current player: ${now}. I can help with playback, queue, favorites, playlists, search, and preference-first recommendations.`;
}

module.exports = {
  knowledge: getKnowledge,
  actions,
  getContext,
  executeAction,
  localReply,
  setLiveGetter,
  ALLOWED,
};
