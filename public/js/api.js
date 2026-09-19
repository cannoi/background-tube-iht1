async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || data.error || 'Request failed');
    error.code = data.code || 'api_error';
    error.status = res.status;
    throw error;
  }
  return data;
}

export async function getConfigStatus() {
  const res = await fetch('/api/config-status');
  return readJson(res);
}

export async function searchVideos(query, pageToken = '') {
  const params = new URLSearchParams({ q: query });
  if (pageToken) params.set('pageToken', pageToken);
  const res = await fetch(`/api/search?${params.toString()}`);
  return readJson(res);
}

export async function getPopular() {
  const res = await fetch('/api/popular');
  return readJson(res);
}
