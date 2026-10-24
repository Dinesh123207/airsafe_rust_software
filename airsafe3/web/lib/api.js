// Client-side helpers (token lives in localStorage; prototype-grade, see README).
export const TOKEN_KEY = 'airsafe_token';
export const USER_KEY = 'airsafe_user';

export const getToken = () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY));
export const getUser = () => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
};
export function saveSession(data) {
  localStorage.setItem(TOKEN_KEY, data.access_token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  constructor(status, detail) { super(typeof detail === 'string' ? detail : `Request failed (${status})`); this.status = status; this.detail = detail; }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const t = getToken();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Cannot reach the API. Is the API server running?');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && auth) { clearSession(); if (typeof window !== 'undefined') window.location.href = '/login'; }
    const d = data?.detail;
    throw new ApiError(res.status, Array.isArray(d) ? d.map((x) => x.msg).join('; ') : d);
  }
  return data;
}

export const VERTICALS = {
  hospital: { label: 'Hospital' },
  hotel: { label: 'Hotel' },
  corporate: { label: 'Corporate' },
};

export const isHardware = (r) => String(r.source || '').startsWith('device:');
export const isLiveHardware = (r) => isHardware(r) && !r.stale;
