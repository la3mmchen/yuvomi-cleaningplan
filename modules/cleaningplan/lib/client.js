// Client for the sidecar at /api/extensions/cleaningplan. Same origin, so the Yuvomi
// session cookie travels along; mutations carry the csrf-token cookie value as a header
// (double submit, the same pair /api.js uses for Yuvomi's own routes).
const BASE = '/api/extensions/cleaningplan';

export class ExtError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.name = 'ExtError';
    this.status = status;
    this.reason = reason;
  }
}

function csrfToken() {
  return document.cookie.split('; ').find((c) => c.startsWith('csrf-token='))?.slice('csrf-token='.length) ?? '';
}

// document.cookie can lag behind the real token in the iOS home-screen app after a
// resume (Yuvomi's own /api.js documents it): on a CSRF refusal the token is re-read from
// GET /api/v1/auth/me and the request retried once.
let freshToken = '';

async function refreshToken(signal) {
  const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin', cache: 'no-store', signal });
  const me = await res.json().catch(() => null);
  freshToken = me?.csrfToken || '';
  return freshToken;
}

async function request(method, path, body, { signal } = {}, retried = false) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = freshToken || csrfToken();
  const res = await fetch(BASE + path, {
    method, headers, credentials: 'same-origin', cache: 'no-store', signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty or non-JSON body */ }
  if (res.status === 403 && json?.reason === 'csrf_invalid' && !retried && await refreshToken(signal)) {
    return request(method, path, body, { signal }, true);
  }
  if (!res.ok) throw new ExtError(json?.error || `HTTP ${res.status}`, res.status, json?.reason ?? null);
  return json?.data;
}

export const ext = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  delete: (path, opts) => request('DELETE', path, undefined, opts),
};
