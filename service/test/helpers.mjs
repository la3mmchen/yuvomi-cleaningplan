// Test helpers: a fake Yuvomi that answers GET /api/v1/auth/me from the cookie.
//   Cookie "sid=<access>"  -> permissions.modules['ext:cleaningplan'] = <access>
//   Cookie "role=admin"    -> user.role = 'admin'
//   Cookie "uid=<n>"       -> user.id = n
//   no sid                 -> 401
import http from 'node:http';

export function meResponse({ id = 1, role = 'member', access = 'write', display_name = 'Test', access_scope = 'family', noKey = false } = {}) {
  const modules = noKey ? { tasks: 'write' } : { 'ext:cleaningplan': access };
  return { user: { id, role, display_name, access_scope }, permissions: { modules } };
}

export async function startFakeYuvomi(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

export function parseCookieHeader(header) {
  return Object.fromEntries((header || '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf('=');
    return [s.slice(0, i), s.slice(i + 1)];
  }));
}

export function accessFake() {
  let calls = 0;
  const headers = [];
  const handler = (req, res) => {
    calls += 1;
    headers.push(req.headers);
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/api/v1/auth/me') { res.statusCode = 404; return res.end('{"error":"Not found."}'); }
    const c = parseCookieHeader(req.headers.cookie);
    if (!c.sid) { res.statusCode = 401; return res.end('{"error":"Not authenticated.","code":401}'); }
    res.end(JSON.stringify(meResponse({ id: c.uid ? Number(c.uid) : 1, role: c.role || 'member', access: c.sid, access_scope: c.scope || 'family', noKey: c.nokey === '1' })));
  };
  return { handler, calls: () => calls, headers: () => headers };
}

export async function closedPortUrl() {
  const probe = await startFakeYuvomi(() => {});
  await probe.close();
  return probe.url;
}
