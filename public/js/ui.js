import { escapeHtml, formatIsoDuration, formatPublished, formatViews, formatSeconds } from './format.js';
import { searchVideos, getPopular, getConfigStatus } from './api.js';
import {
  getHistory, clearHistory, getFavorites, isFavorite, toggleFavorite,
  getPlaylists, createPlaylist, renamePlaylist, deletePlaylist,
  addToPlaylist, removeFromPlaylist, movePlaylistItem
} from './library.js';
import { clearAppData } from './storage.js';
import { getSettings, updateSettings } from './settings.js';
import { setTheme } from './theme.js';
import {
  getPlayerState, playVideo, togglePlayPause, next, previous, cycleRepeat,
  toggleShuffle, stopPlayback
} from './player.js';

const DISCOVER = [
  { q: 'lofi hip hop radio', label: 'Lo-fi' },
  { q: 'official pop music 2026', label: 'Pop' },
  { q: 'chill acoustic songs', label: 'Acoustic' },
  { q: 'workout electronic mix', label: 'Workout' },
  { q: 'jazz piano relax', label: 'Jazz' },
  { q: 'vietnamese ballad official', label: 'V-Pop' }
];

const view = {
  tab: getSettings().lastTab || 'home',
  playerOpen: false,
  searchQuery: '',
  searchItems: [],
  nextPageToken: null,
  searchError: null,
  searching: false,
  popular: [],
  popularError: null,
  config: null,
  toastTimer: null,
  addTarget: null,
  libraryFilter: 'all'
};

function $(sel) { return document.querySelector(sel); }

export function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(view.toastTimer);
  view.toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2200);
}

function trackCard(item, extra = '') {
  return `
    <button class="track" data-play="${escapeHtml(item.videoId)}" type="button">
      <div class="thumb">
        <img loading="lazy" src="${escapeHtml(item.thumbnail || '')}" alt="">
        ${item.duration ? `<span class="badge">${escapeHtml(formatIsoDuration(item.duration))}</span>` : ''}
      </div>
      <div>
        <strong class="track-title">${escapeHtml(item.title)}</strong>
        <div class="muted">${escapeHtml(item.channelTitle)}${item.publishedAt ? ' · ' + formatPublished(item.publishedAt) : ''}${item.viewCount ? ' · ' + formatViews(item.viewCount) : ''}</div>
      </div>
      <span class="play-mini"><i class="fa-solid fa-play"></i></span>
    </button>${extra}`;
}

function emptyState(icon, title, text) {
  return `<div class="state"><i class="fa-solid ${icon}"></i><strong>${title}</strong><p>${text}</p></div>`;
}

function errorState(message, actionLabel, action) {
  return `<div class="error-box"><i class="fa-solid fa-triangle-exclamation"></i><p><strong>${escapeHtml(message)}</strong></p>
    ${action ? `<button class="primary" style="margin-top:10px" data-action="${action}">${escapeHtml(actionLabel)}</button>` : ''}</div>`;
}

export function renderHome() {
  const history = getHistory().slice(0, 8);
  const favorites = getFavorites().slice(0, 6);
  const playlists = getPlaylists();
  const continueItem = history[0];
  const popular = view.popular.slice(0, 10);

  return `
    <section class="hero">
      <span class="chip">Official YouTube playback</span>
      <h2>Listen in the moment</h2>
      <p>Search songs and play them through YouTube’s official embed. Nothing is downloaded or ripped.</p>
      <div class="chip-row" style="margin-top:14px">
        ${DISCOVER.map((d) => `<button class="chip" data-quick="${escapeHtml(d.q)}">${escapeHtml(d.label)}</button>`).join('')}
      </div>
    </section>

    ${continueItem ? `
      <section class="section">
        <div class="section-head"><h3>Continue listening</h3></div>
        ${trackCard(continueItem)}
      </section>` : ''}

    <section class="section">
      <div class="section-head"><h3>Discover</h3><button class="linkish" data-action="reload-popular">Refresh</button></div>
      ${view.popularError ? errorState(view.popularError, 'Retry', 'reload-popular') : ''}
      ${!view.popularError && !popular.length ? emptyState('fa-compact-disc', 'Popular tracks load after the API key is configured', 'Search still works once the owner adds a YouTube Data API key.') : ''}
      <div class="h-scroll card-row">
        ${popular.map((item) => `
          <button class="discover-card" data-play="${escapeHtml(item.videoId)}" type="button">
            <img loading="lazy" src="${escapeHtml(item.thumbnail || '')}" alt="">
            <div>
              <strong>${escapeHtml(item.title)}</strong>
              <div class="muted">${escapeHtml(item.channelTitle)}</div>
            </div>
          </button>`).join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h3>Recently played</h3>
        ${history.length ? '<button class="linkish" data-action="clear-history">Clear</button>' : ''}
      </div>
      ${history.length ? history.map((item) => trackCard(item)).join('') : emptyState('fa-clock-rotate-left', 'Nothing recent yet', 'Play a track and it will show up here.')}
    </section>

    <section class="section">
      <div class="section-head"><h3>Favorites</h3></div>
      ${favorites.length ? favorites.map((item) => trackCard(item)).join('') : emptyState('fa-heart', 'No favorites', 'Tap the heart in the player to save songs on this device.')}
    </section>

    <section class="section">
      <div class="section-head"><h3>Local playlists</h3><button class="linkish" data-go="library">Open</button></div>
      ${playlists.length ? playlists.map((pl) => `
        <div class="panel">
          <div class="row-between">
            <div><strong>${escapeHtml(pl.name)}</strong><div class="muted">${pl.items.length} tracks</div></div>
            ${pl.items[0] ? `<button class="setting-btn" data-play-list="${escapeHtml(pl.id)}">Play</button>` : ''}
          </div>
        </div>`).join('') : emptyState('fa-list', 'No playlists', 'Create one from Library.')}
    </section>
  `;
}

export function renderSearch() {
  return `
    <form class="search-box" data-action="search-form">
      <div class="search-wrap">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input id="searchInput" value="${escapeHtml(view.searchQuery)}" placeholder="Song, artist, keyword" enterkeyhint="search" />
      </div>
      <button class="primary" type="submit">Search</button>
    </form>
    <div class="chip-row" style="margin:12px 0">
      ${DISCOVER.map((d) => `<button class="setting-btn" data-quick="${escapeHtml(d.q)}">${escapeHtml(d.label)}</button>`).join('')}
    </div>
    <div id="searchResults">
      ${renderSearchResults()}
    </div>
  `;
}

function renderSearchResults() {
  if (view.searching) return emptyState('fa-spinner fa-spin', 'Searching YouTube…', 'Using the official Data API v3.');
  if (view.searchError) return errorState(view.searchError, 'Retry', 'retry-search');
  if (!view.searchQuery) return emptyState('fa-music', 'Find a track', 'Search by song, artist, or mood.');
  if (!view.searchItems.length) return emptyState('fa-ghost', 'No results', `Nothing matched “${escapeHtml(view.searchQuery)}”.`);
  return `
    ${view.searchItems.map((item) => trackCard(item)).join('')}
    ${view.nextPageToken ? `<button class="primary" style="width:100%;margin-top:8px" data-action="load-more">Load more</button>` : ''}
  `;
}

export function renderLibrary() {
  const history = getHistory();
  const favorites = getFavorites();
  const playlists = getPlaylists();
  return `
    <div class="choices" style="margin-bottom:12px">
      ${['all', 'favorites', 'playlists', 'history'].map((f) => `
        <button class="choice" data-lib-filter="${f}" aria-pressed="${view.libraryFilter === f}">${f}</button>
      `).join('')}
    </div>

    ${view.libraryFilter !== 'playlists' && view.libraryFilter !== 'history' ? `
      <section class="section">
        <div class="section-head"><h3>Favorites</h3></div>
        ${favorites.length ? favorites.map((item) => trackCard(item)).join('') : emptyState('fa-heart', 'Empty', 'Hearts stay on this device only.')}
      </section>` : ''}

    ${view.libraryFilter !== 'favorites' && view.libraryFilter !== 'history' ? `
      <section class="section">
        <div class="section-head"><h3>Playlists</h3><button class="linkish" data-action="new-playlist">New</button></div>
        ${playlists.map((pl) => `
          <div class="panel">
            <div class="row-between">
              <div>
                <strong>${escapeHtml(pl.name)}</strong>
                <div class="muted">${pl.items.length} tracks</div>
              </div>
              <div>
                ${pl.items.length ? `<button class="setting-btn" data-play-list="${escapeHtml(pl.id)}">Play</button>` : ''}
                <button class="setting-btn" data-rename-list="${escapeHtml(pl.id)}">Rename</button>
                <button class="setting-btn" data-delete-list="${escapeHtml(pl.id)}">Delete</button>
              </div>
            </div>
            ${pl.items.map((item, idx) => `
              <div class="row-between" style="margin-top:8px">
                <button class="linkish" data-play="${escapeHtml(item.videoId)}" data-from-list="${escapeHtml(pl.id)}" style="text-align:left;flex:1">${escapeHtml(item.title)}</button>
                <button class="ghost" data-move="${escapeHtml(pl.id)}" data-from="${idx}" data-to="${Math.max(0, idx - 1)}">↑</button>
                <button class="ghost" data-move="${escapeHtml(pl.id)}" data-from="${idx}" data-to="${Math.min(pl.items.length - 1, idx + 1)}">↓</button>
                <button class="ghost" data-remove-item="${escapeHtml(item.videoId)}" data-from-list="${escapeHtml(pl.id)}">✕</button>
              </div>
            `).join('')}
          </div>
        `).join('') || emptyState('fa-list', 'No playlists yet', 'Create one to group local tracks.')}
      </section>` : ''}

    ${view.libraryFilter !== 'favorites' && view.libraryFilter !== 'playlists' ? `
      <section class="section">
        <div class="section-head"><h3>Recently played</h3>
          ${history.length ? '<button class="linkish" data-action="clear-history">Clear history</button>' : ''}
        </div>
        ${history.length ? history.map((item) => trackCard(item)).join('') : emptyState('fa-clock-rotate-left', 'No history', 'History never leaves this browser.')}
      </section>` : ''}
  `;
}

export function renderSettings() {
  const s = getSettings();
  const cfg = view.config;
  const apiOk = cfg && cfg.apiKeyConfigured;
  return `
    <div class="panel">
      <div class="row-between">
        <div>
          <strong>YouTube API</strong>
          <div class="muted">Developer-owned key. Never entered by listeners.</div>
        </div>
        <span class="setting-btn">${apiOk ? 'Configured' : 'Missing key'}</span>
      </div>
      <p class="muted" style="margin:10px 0 0">${cfg?.backgroundPlayback?.reason || ''}</p>
    </div>

    <div class="panel">
      <strong>Theme</strong>
      <div class="choices" style="margin-top:10px">
        ${['system', 'light', 'dark'].map((theme) => `
          <button class="choice" data-theme="${theme}" aria-pressed="${s.theme === theme}">${theme}</button>
        `).join('')}
      </div>
    </div>

    <div class="panel">
      <div class="row-between">
        <div><strong>Autoplay next</strong><div class="muted">Uses the current queue</div></div>
        <button class="switch ${s.autoplay ? 'on' : ''}" data-action="toggle-autoplay" aria-pressed="${s.autoplay}"></button>
      </div>
    </div>

    <div class="panel">
      <strong>Playback</strong>
      <p class="muted">Official YouTube IFrame Player only. No download, extraction, or unofficial stream.</p>
      <p class="muted">Background / lock-screen: Media Session metadata is sent when the browser allows it. The embed itself cannot keep playing after the tab is suspended.</p>
    </div>

    <div class="panel">
      <strong>Local data</strong>
      <div class="choices" style="margin-top:10px">
        <button class="setting-btn" data-action="clear-history">Clear history</button>
        <button class="setting-btn" data-action="clear-all">Clear all local data</button>
      </div>
    </div>

    <div class="panel">
      <strong>About</strong>
      <p class="muted">Background ❤️ Tube 1.1.0 — mobile-first discovery player. Search via YouTube Data API v3. Playback via YouTube IFrame Player API.</p>
    </div>

    <div class="panel">
      <strong>Privacy</strong>
      <p class="muted">Favorites, history, queues, and playlists stay in this browser’s local storage. This app does not create a user account and does not store Google passwords. Search queries are sent to YouTube through the app server.</p>
    </div>

    <div class="panel">
      <strong>Terms</strong>
      <p class="muted">YouTube content is provided by Google and remains subject to YouTube’s terms. This app does not claim ownership of videos or music.</p>
      <p><a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener">YouTube Terms of Service</a></p>
      <p><a href="https://www.google.com/policies/privacy" target="_blank" rel="noopener">Google Privacy Policy</a></p>
      <p><a href="https://developers.google.com/youtube/terms/api-services-terms-of-service" target="_blank" rel="noopener">YouTube API Services Terms</a></p>
    </div>
  `;
}

function ensurePlayerOverlay() {
  const overlay = document.getElementById('playerOverlay');
  if (overlay.dataset.ready === '1') return overlay;
  overlay.innerHTML = `
    <div class="player-stage">
      <div class="row-between">
        <button class="ghost" data-action="close-player"><i class="fa-solid fa-chevron-down"></i> Mini player</button>
        <span class="muted">Official embed</span>
      </div>
      <div class="artwork-wrap">
        <div id="yt-player-host"></div>
      </div>
      <div class="player-meta">
        <h2 id="playerTitle">No track</h2>
        <div class="muted" id="playerChannel">Choose something to play</div>
      </div>
      <div class="seek">
        <div class="seek-track" data-seek-track id="seekTrack"><span id="seekFill"></span></div>
        <div class="seek-times"><span id="seekCurrentLabel">0:00</span><span id="seekDurationLabel">--:--</span></div>
      </div>
      <div class="controls">
        <button class="round" data-action="prev" aria-label="Previous"><i class="fa-solid fa-backward-step"></i></button>
        <button class="round main" data-action="toggle" aria-label="Play or pause"><i class="fa-solid fa-play"></i></button>
        <button class="round" data-action="next" aria-label="Next"><i class="fa-solid fa-forward-step"></i></button>
      </div>
      <div class="actions-row">
        <button class="ghost" id="favBtn" data-action="favorite"><i class="fa-solid fa-heart"></i> Favorite</button>
        <button class="ghost" id="shuffleBtn" data-action="shuffle"><i class="fa-solid fa-shuffle"></i></button>
        <button class="ghost" id="repeatBtn" data-action="repeat"><i class="fa-solid fa-repeat"></i> off</button>
        <button class="ghost" data-action="add-playlist"><i class="fa-solid fa-plus"></i></button>
        <button class="ghost" data-action="share"><i class="fa-solid fa-share-nodes"></i></button>
      </div>
      <div id="playerError" class="error-box" style="margin-top:12px" hidden></div>
      <div class="limit-note">Background playback is not available through the official YouTube embed on most phones. Audio continues only while this page stays open. Lock-screen controls appear only if the browser allows Media Session.</div>
      <div class="queue">
        <div class="section-head"><h3>Queue</h3><span class="muted" id="queueCount">0 tracks</span></div>
        <div id="queueList"></div>
      </div>
    </div>`;
  overlay.dataset.ready = '1';
  return overlay;
}

function updatePlayerChrome() {
  const p = getPlayerState();
  const video = p.active;
  const title = document.getElementById('playerTitle');
  const channel = document.getElementById('playerChannel');
  const toggle = document.querySelector('#playerOverlay [data-action="toggle"].main');
  if (title) title.textContent = video ? video.title : 'No track';
  if (channel) channel.textContent = video ? video.channelTitle : 'Choose something to play';
  if (toggle) toggle.innerHTML = `<i class="fa-solid ${p.playing ? 'fa-pause' : 'fa-play'}"></i>`;
  const favBtn = document.getElementById('favBtn');
  if (favBtn) favBtn.classList.toggle('on', !!(video && isFavorite(video.videoId)));
  const shuffleBtn = document.getElementById('shuffleBtn');
  if (shuffleBtn) shuffleBtn.classList.toggle('on', p.shuffle);
  const repeatBtn = document.getElementById('repeatBtn');
  if (repeatBtn) {
    repeatBtn.classList.toggle('on', p.repeat !== 'off');
    repeatBtn.innerHTML = `<i class="fa-solid fa-repeat"></i> ${p.repeat}`;
  }
  const err = document.getElementById('playerError');
  if (err) {
    err.hidden = !p.error;
    err.textContent = p.error ? p.error.message : '';
  }
  const count = document.getElementById('queueCount');
  if (count) count.textContent = `${p.queue.length} tracks`;
  const list = document.getElementById('queueList');
  if (list) {
    list.innerHTML = p.queue.map((item, idx) => `
      <button class="track" data-play="${escapeHtml(item.videoId)}" type="button" style="${idx === p.index ? 'box-shadow:0 0 0 1px var(--brand)' : ''}">
        <div class="thumb"><img loading="lazy" src="${escapeHtml(item.thumbnail || '')}" alt=""></div>
        <div><strong>${escapeHtml(item.title)}</strong><div class="muted">${escapeHtml(item.channelTitle)}</div></div>
        <span class="muted">${idx === p.index ? 'Now' : String(idx + 1).padStart(2, '0')}</span>
      </button>`).join('');
  }
  const dur = document.getElementById('seekDurationLabel');
  if (dur && video) dur.textContent = video.duration ? formatIsoDuration(video.duration) : formatSeconds(p.duration);
}

export function renderMini() {
  const p = getPlayerState();
  const bar = $('#miniPlayerBar');
  if (!bar) return;
  if (!p.active || view.playerOpen) {
    bar.classList.remove('visible');
    return;
  }
  bar.classList.add('visible');
  $('#miniTitle').textContent = p.active.title;
  $('#miniChannel').textContent = p.active.channelTitle;
  $('#miniThumbnail').src = p.active.thumbnail || '';
  $('#miniPlayPauseBtn').innerHTML = `<i class="fa-solid ${p.playing ? 'fa-pause' : 'fa-play'}"></i>`;
}

function setTab(tab) {
  view.tab = tab;
  updateSettings({ lastTab: tab });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  render();
}

export function render() {
  const root = $('#mainContainer');
  if (view.tab === 'search') root.innerHTML = renderSearch();
  else if (view.tab === 'library') root.innerHTML = renderLibrary();
  else if (view.tab === 'settings') root.innerHTML = renderSettings();
  else root.innerHTML = renderHome();
  renderMini();
  renderSheet();
}

function renderSheet() {
  const back = $('#sheetBack');
  if (!view.addTarget) {
    back.classList.remove('open');
    back.innerHTML = '';
    return;
  }
  const lists = getPlaylists();
  back.classList.add('open');
  back.innerHTML = `
    <div class="sheet">
      <h3>Add to playlist</h3>
      ${lists.map((pl) => `<button class="block" data-add-to="${escapeHtml(pl.id)}">${escapeHtml(pl.name)} · ${pl.items.length}</button>`).join('') || '<p class="muted">No playlists yet.</p>'}
      <button class="primary" style="width:100%;margin-top:8px" data-action="new-playlist">New playlist</button>
      <button class="ghost" style="width:100%;margin-top:8px" data-action="close-sheet">Cancel</button>
    </div>`;
}

function catalog() {
  return [
    ...view.searchItems,
    ...view.popular,
    ...getHistory(),
    ...getFavorites(),
    ...getPlaylists().flatMap((pl) => pl.items),
    ...getPlayerState().queue
  ];
}

function findVideo(id) {
  return catalog().find((item) => item.videoId === id);
}

function queueContext(video, fromList) {
  if (fromList) {
    const pl = getPlaylists().find((p) => p.id === fromList);
    if (pl) return pl.items;
  }
  if (view.tab === 'search' && view.searchItems.length) return view.searchItems;
  if (view.tab === 'home' && view.popular.some((i) => i.videoId === video.videoId)) return view.popular;
  if (view.tab === 'library' && view.libraryFilter === 'favorites') return getFavorites();
  if (view.tab === 'library' && view.libraryFilter === 'history') return getHistory();
  return getPlayerState().queue.length ? getPlayerState().queue : [video];
}

async function runSearch(loadMore = false) {
  const input = $('#searchInput');
  if (input) view.searchQuery = input.value.trim();
  if (!view.searchQuery) return;
  view.searching = true;
  view.searchError = null;
  if (!loadMore) {
    view.searchItems = [];
    view.nextPageToken = null;
  }
  const resultsBox = $('#searchResults');
  if (resultsBox) resultsBox.innerHTML = renderSearchResults();
  try {
    const data = await searchVideos(view.searchQuery, loadMore ? view.nextPageToken : '');
    view.searchItems = loadMore ? view.searchItems.concat(data.items || []) : (data.items || []);
    view.nextPageToken = data.nextPageToken || null;
  } catch (err) {
    view.searchError = err.message || 'Search failed.';
  } finally {
    view.searching = false;
    const box = $('#searchResults');
    if (box) box.innerHTML = renderSearchResults();
    else render();
  }
}

async function loadPopular() {
  try {
    const data = await getPopular();
    view.popular = data.items || [];
    view.popularError = null;
  } catch (err) {
    view.popularError = err.message || 'Could not load popular music.';
    view.popular = [];
  }
  if (view.tab === 'home') render();
}

async function loadConfig() {
  try {
    view.config = await getConfigStatus();
  } catch (_) {
    view.config = { apiKeyConfigured: false };
  }
  if (view.tab === 'settings') render();
}

function openPlayer() {
  view.playerOpen = true;
  const overlay = ensurePlayerOverlay();
  overlay.classList.add('open');
  updatePlayerChrome();
  renderMini();
}

function closePlayer() {
  view.playerOpen = false;
  $('#playerOverlay').classList.remove('open');
  renderMini();
}

async function shareActive() {
  const video = getPlayerState().active;
  if (!video) return;
  const url = `https://www.youtube.com/watch?v=${video.videoId}`;
  try {
    if (navigator.share) await navigator.share({ title: video.title, text: video.channelTitle, url });
    else {
      await navigator.clipboard.writeText(url);
      toast('YouTube link copied');
    }
  } catch (_) {
    toast('Share cancelled');
  }
}

function onClick(event) {
  const t = event.target.closest('[data-tab],[data-play],[data-quick],[data-action],[data-theme],[data-lib-filter],[data-play-list],[data-rename-list],[data-delete-list],[data-add-to],[data-move],[data-remove-item],[data-go]');
  if (!t) return;

  if (t.dataset.tab) setTab(t.dataset.tab);
  if (t.dataset.go) setTab(t.dataset.go);
  if (t.dataset.quick) {
    setTab('search');
    view.searchQuery = t.dataset.quick;
    render();
    runSearch();
  }
  if (t.dataset.play) {
    const video = findVideo(t.dataset.play);
    if (video) {
      playVideo(video, queueContext(video, t.dataset.fromList));
      openPlayer();
    }
  }
  if (t.dataset.playList) {
    const pl = getPlaylists().find((p) => p.id === t.dataset.playList);
    if (pl?.items[0]) {
      playVideo(pl.items[0], pl.items);
      openPlayer();
    }
  }
  if (t.dataset.theme) {
    setTheme(t.dataset.theme);
    render();
  }
  if (t.dataset.libFilter) {
    view.libraryFilter = t.dataset.libFilter;
    render();
  }
  if (t.dataset.renameList) {
    const nextName = prompt('Rename playlist');
    if (nextName) renamePlaylist(t.dataset.renameList, nextName);
    render();
  }
  if (t.dataset.deleteList) {
    if (confirm('Delete this playlist?')) deletePlaylist(t.dataset.deleteList);
    render();
  }
  if (t.dataset.addTo && view.addTarget) {
    const added = addToPlaylist(t.dataset.addTo, view.addTarget);
    toast(added ? 'Added to playlist' : 'Already in that playlist');
    view.addTarget = null;
    render();
  }
  if (t.dataset.move) {
    movePlaylistItem(t.dataset.move, Number(t.dataset.from), Number(t.dataset.to));
    render();
  }
  if (t.dataset.removeItem) {
    removeFromPlaylist(t.dataset.fromList, t.dataset.removeItem);
    render();
  }

  switch (t.dataset.action) {
    case 'search-form':
      event.preventDefault();
      runSearch();
      break;
    case 'retry-search':
      runSearch();
      break;
    case 'load-more':
      runSearch(true);
      break;
    case 'reload-popular':
      loadPopular();
      break;
    case 'clear-history':
      clearHistory();
      toast('History cleared');
      render();
      break;
    case 'clear-all':
      if (confirm('Clear favorites, playlists, history, and settings on this device?')) {
        clearAppData();
        location.reload();
      }
      break;
    case 'toggle-autoplay':
      updateSettings({ autoplay: !getSettings().autoplay });
      render();
      break;
    case 'new-playlist': {
      const name = prompt('Playlist name');
      if (name && name.trim()) {
        const created = createPlaylist(name);
        if (view.addTarget) addToPlaylist(created.id, view.addTarget);
        view.addTarget = null;
        toast('Playlist created');
        render();
      }
      break;
    }
    case 'close-sheet':
      view.addTarget = null;
      render();
      break;
    case 'close-player':
      closePlayer();
      break;
    case 'open-player':
      openPlayer();
      break;
    case 'toggle':
      togglePlayPause();
      break;
    case 'next':
      next();
      break;
    case 'prev':
      previous();
      break;
    case 'favorite': {
      const active = getPlayerState().active;
      if (active) toast(toggleFavorite(active) ? 'Saved to favorites' : 'Removed from favorites');
      if (view.playerOpen) openPlayer();
      render();
      break;
    }
    case 'shuffle':
      toggleShuffle();
      if (view.playerOpen) openPlayer();
      break;
    case 'repeat':
      cycleRepeat();
      if (view.playerOpen) openPlayer();
      break;
    case 'add-playlist':
      view.addTarget = getPlayerState().active;
      render();
      break;
    case 'share':
      shareActive();
      break;
    case 'stop':
      stopPlayback();
      closePlayer();
      render();
      break;
    default:
      break;
  }
}

export async function initUi() {
  ensurePlayerOverlay();
  document.addEventListener('click', onClick);
  document.addEventListener('submit', (event) => {
    if (event.target.matches('[data-action="search-form"]')) {
      event.preventDefault();
      runSearch();
    }
  });
  setTab(view.tab === 'player' ? 'home' : view.tab);
  loadConfig();
  loadPopular();
}

export { openPlayer, view };
