// Who is calling, and may they write? The only source of truth is Yuvomi's
// GET /api/v1/auth/me, reached with the caller's own cookie. Nothing in a request
// body is trusted for identity. Answers are cached a few seconds per cookie so a
// page full of requests does not spend Yuvomi's per-IP rate limit.

const MODULE_KEY = 'ext:cleaningplan';
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export class HttpError extends Error {
  constructor(status, reason, message = reason) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.reason = reason;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const s = part.trim();
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

// Only household members get in: a split-expense guest or a paired wall display has a
// session too, but Yuvomi confines those to their own surfaces and this service must not
// be the way around that. A missing permission key (module disabled or not yet approved)
// fails closed rather than lifting a member's read/none restriction.
function accessFrom(me) {
  const scope = me?.user?.access_scope ?? 'family';
  if (scope !== 'family') return 'none';
  if (me?.user?.role === 'admin') return 'write';
  const level = me?.permissions?.modules?.[MODULE_KEY];
  return level === 'write' || level === 'read' ? level : 'none';
}

function originOf(value, name) {
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must be an absolute http(s) URL such as https://home.example, got ${JSON.stringify(value)}`);
  }
  return url.origin;
}

export function createAuth({ yuvomiUrl, publicOrigin, fetch = globalThis.fetch, cacheMs = 5000, now = Date.now }) {
  const base = originOf(yuvomiUrl, 'YUVOMI_INTERNAL_URL');
  const expectedOrigin = originOf(publicOrigin, 'PUBLIC_ORIGIN');
  const cache = new Map(); // cookie header -> { until, value }

  async function resolve(req) {
    const cookie = req.headers.cookie;
    if (!cookie) throw new HttpError(401, 'not_authenticated');
    const hit = cache.get(cookie);
    if (hit && hit.until > now()) {
      if (hit.value === null) throw new HttpError(401, 'not_authenticated');
      return hit.value;
    }

    // The caller's address travels along so Yuvomi's per-IP rate limit is spent by the
    // browser that made the request, not by this container for the whole household.
    const forwardedFor = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    const headers = { cookie, accept: 'application/json' };
    if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
    let res;
    try {
      res = await fetch(`${base}/api/v1/auth/me`, { headers });
    } catch {
      throw new HttpError(502, 'yuvomi_unavailable');
    }
    if (res.status === 401) {
      // A stale cookie hammering the service should not forward every hit to Yuvomi.
      cache.set(cookie, { until: now() + Math.min(cacheMs, 2000), value: null });
      throw new HttpError(401, 'not_authenticated');
    }
    if (!res.ok) throw new HttpError(502, 'yuvomi_unavailable');
    let me;
    try { me = await res.json(); } catch { throw new HttpError(502, 'yuvomi_unavailable'); }
    const userId = Number(me?.user?.id);
    if (!Number.isInteger(userId) || userId < 1) throw new HttpError(502, 'yuvomi_unavailable');

    const value = { userId, role: String(me.user.role || 'member'), access: accessFrom(me) };
    cache.set(cookie, { until: now() + cacheMs, value });
    if (cache.size > 1000) cache.clear();
    return value;
  }

  function assertCsrf(req) {
    if (!MUTATING.has(req.method)) return;
    const origin = req.headers.origin;
    const header = req.headers['x-csrf-token'];
    const cookie = parseCookies(req.headers.cookie)['csrf-token'];
    if (origin !== expectedOrigin || !header || header !== cookie) throw new HttpError(403, 'csrf_invalid');
  }

  return { resolve, assertCsrf };
}
