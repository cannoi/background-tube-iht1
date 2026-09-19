import { getStorage, setStorage } from './storage.js';
import { uid } from './format.js';

const HISTORY_LIMIT = 40;

let historyList = getStorage('history', []);
let favorites = getStorage('favorites', []);
let playlists = getStorage('playlists', []);
let queueSnapshot = getStorage('queue', { items: [], index: 0 });

if (!Array.isArray(playlists) || playlists.length === 0) {
  playlists = [{ id: 'liked-mix', name: 'Evening mix', items: [] }];
  persistPlaylists();
}

function persistHistory() {
  setStorage('history', historyList);
}

function persistFavorites() {
  setStorage('favorites', favorites);
}

function persistPlaylists() {
  setStorage('playlists', playlists);
}

function persistQueue() {
  setStorage('queue', queueSnapshot);
}

export function getHistory() {
  return [...historyList];
}

export function addToHistory(video) {
  if (!video || !video.videoId) return;
  historyList = [video, ...historyList.filter((item) => item.videoId !== video.videoId)].slice(0, HISTORY_LIMIT);
  persistHistory();
}

export function clearHistory() {
  historyList = [];
  persistHistory();
}

export function getFavorites() {
  return [...favorites];
}

export function isFavorite(videoId) {
  return favorites.some((item) => item.videoId === videoId);
}

export function toggleFavorite(video) {
  if (!video || !video.videoId) return false;
  if (isFavorite(video.videoId)) {
    favorites = favorites.filter((item) => item.videoId !== video.videoId);
    persistFavorites();
    return false;
  }
  favorites = [video, ...favorites];
  persistFavorites();
  return true;
}

export function getPlaylists() {
  return playlists.map((pl) => ({ ...pl, items: [...pl.items] }));
}

export function createPlaylist(name) {
  const playlist = { id: uid('pl'), name: name.trim(), items: [] };
  playlists = [playlist, ...playlists];
  persistPlaylists();
  return playlist;
}

export function renamePlaylist(id, name) {
  const playlist = playlists.find((pl) => pl.id === id);
  if (!playlist || !name.trim()) return null;
  playlist.name = name.trim();
  persistPlaylists();
  return playlist;
}

export function deletePlaylist(id) {
  playlists = playlists.filter((pl) => pl.id !== id);
  persistPlaylists();
}

export function addToPlaylist(playlistId, video) {
  const playlist = playlists.find((pl) => pl.id === playlistId);
  if (!playlist || !video?.videoId) return false;
  if (playlist.items.some((item) => item.videoId === video.videoId)) return false;
  playlist.items.push(video);
  persistPlaylists();
  return true;
}

export function removeFromPlaylist(playlistId, videoId) {
  const playlist = playlists.find((pl) => pl.id === playlistId);
  if (!playlist) return;
  playlist.items = playlist.items.filter((item) => item.videoId !== videoId);
  persistPlaylists();
}

export function movePlaylistItem(playlistId, fromIndex, toIndex) {
  const playlist = playlists.find((pl) => pl.id === playlistId);
  if (!playlist) return;
  const items = playlist.items;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return;
  const [moved] = items.splice(fromIndex, 1);
  items.splice(toIndex, 0, moved);
  persistPlaylists();
}

export function saveQueue(items, index) {
  queueSnapshot = { items: items || [], index: index || 0 };
  persistQueue();
}

export function loadQueue() {
  return {
    items: Array.isArray(queueSnapshot.items) ? queueSnapshot.items : [],
    index: Number(queueSnapshot.index) || 0
  };
}
