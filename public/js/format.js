export function parseIsoDurationToSeconds(iso) {
  if (!iso) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return null;
  return (
    parseInt(match[1] || '0', 10) * 3600 +
    parseInt(match[2] || '0', 10) * 60 +
    parseInt(match[3] || '0', 10)
  );
}

export function formatSeconds(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return '--:--';
  totalSeconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

export function formatIsoDuration(iso) {
  return formatSeconds(parseIsoDurationToSeconds(iso));
}

export function formatPublished(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  const day = 86400000;
  if (diff < day) return 'Today';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`;
  return `${Math.floor(diff / (365 * day))}y ago`;
}

export function formatViews(count) {
  const n = Number(count);
  if (!Number.isFinite(n)) return '';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B views`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
  return `${n} views`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
