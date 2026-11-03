import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, HttpError, parseCookies } from '../app/auth.mjs';
import { startFakeYuvomi, accessFake, closedPortUrl } from './helpers.mjs';

const ORIGIN = 'http://localhost:3000';
const req = (headers = {}, method = 'GET') => ({ method, headers });

async function withFake(fn) {
  const fake = accessFake();
  const server = await startFakeYuvomi(fake.handler);
  try { await fn(server.url, fake); } finally { await server.close(); }
}

test('resolve maps write/read/none and admin', async () => {
  await withFake(async (url) => {
    const auth = createAuth({ yuvomiUrl: url, publicOrigin: ORIGIN });
    assert.deepEqual(await auth.resolve(req({ cookie: 'sid=write; uid=7' })), { userId: 7, role: 'member', access: 'write' });
    assert.equal((await auth.resolve(req({ cookie: 'sid=read' }))).access, 'read');
    assert.equal((await auth.resolve(req({ cookie: 'sid=none' }))).access, 'none');
    const admin = await auth.resolve(req({ cookie: 'sid=read; role=admin' }));
    assert.equal(admin.access, 'write');
    assert.equal(admin.role, 'admin');
  });
});

test('resolve without cookie throws 401 not_authenticated', async () => {
  await withFake(async (url, fake) => {
    const auth = createAuth({ yuvomiUrl: url, publicOrigin: ORIGIN });
    await assert.rejects(auth.resolve(req()), (e) => e instanceof HttpError && e.status === 401 && e.reason === 'not_authenticated');
    assert.equal(fake.calls(), 0);
  });
});

test('resolve when Yuvomi answers 401 throws 401', async () => {
  await withFake(async (url) => {
    const auth = createAuth({ yuvomiUrl: url, publicOrigin: ORIGIN });
    await assert.rejects(auth.resolve(req({ cookie: 'other=1' })), (e) => e.status === 401 && e.reason === 'not_authenticated');
  });
});

test('Yuvomi unreachable answers 502', async () => {
  const auth = createAuth({ yuvomiUrl: await closedPortUrl(), publicOrigin: ORIGIN });
  await assert.rejects(auth.resolve(req({ cookie: 'sid=write' })), (e) => e.status === 502 && e.reason === 'yuvomi_unavailable');
});

test('resolve caches per cookie for cacheMs', async () => {
  await withFake(async (url, fake) => {
    let now = 1_000_000;
    const auth = createAuth({ yuvomiUrl: url, publicOrigin: ORIGIN, cacheMs: 5000, now: () => now });
    await auth.resolve(req({ cookie: 'sid=write' }));
    await auth.resolve(req({ cookie: 'sid=write' }));
    assert.equal(fake.calls(), 1);
    await auth.resolve(req({ cookie: 'sid=read' }));
    assert.equal(fake.calls(), 2);
    now += 6000;
    await auth.resolve(req({ cookie: 'sid=write' }));
    assert.equal(fake.calls(), 3);
  });
});

test('assertCsrf accepts matching origin and token, refuses mismatch', () => {
  const auth = createAuth({ yuvomiUrl: 'http://unused', publicOrigin: ORIGIN });
  const ok = req({ origin: ORIGIN, 'x-csrf-token': 'tok1', cookie: 'sid=write; csrf-token=tok1' }, 'POST');
  assert.doesNotThrow(() => auth.assertCsrf(ok));
  const badOrigin = req({ origin: 'http://evil.example', 'x-csrf-token': 'tok1', cookie: 'csrf-token=tok1' }, 'POST');
  assert.throws(() => auth.assertCsrf(badOrigin), (e) => e.status === 403 && e.reason === 'csrf_invalid');
  const badToken = req({ origin: ORIGIN, 'x-csrf-token': 'tok2', cookie: 'csrf-token=tok1' }, 'DELETE');
  assert.throws(() => auth.assertCsrf(badToken), (e) => e.status === 403 && e.reason === 'csrf_invalid');
  const noToken = req({ origin: ORIGIN, cookie: 'csrf-token=' }, 'PATCH');
  assert.throws(() => auth.assertCsrf(noToken), (e) => e.status === 403);
  assert.doesNotThrow(() => auth.assertCsrf(req({ origin: 'http://evil.example' }, 'GET')));
});

test('parseCookies splits a header', () => {
  assert.deepEqual(parseCookies('a=1; csrf-token=x=y; b'), { a: '1', 'csrf-token': 'x=y' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('publicOrigin with a trailing slash still matches the Origin header', () => {
  const auth = createAuth({ yuvomiUrl: 'http://unused/', publicOrigin: 'http://localhost:3000/' });
  assert.doesNotThrow(() => auth.assertCsrf(req({ origin: ORIGIN, 'x-csrf-token': 't', cookie: 'csrf-token=t' }, 'POST')));
});

test('createAuth rejects an invalid publicOrigin', () => {
  assert.throws(() => createAuth({ yuvomiUrl: 'http://unused', publicOrigin: 'localhost:3000' }));
  assert.throws(() => createAuth({ yuvomiUrl: 'http://unused', publicOrigin: '' }));
});

test('non-family access scopes are denied even with write permission', async () => {
  await withFake(async (url) => {
    const auth = createAuth({ yuvomiUrl: url, publicOrigin: ORIGIN });
    assert.equal((await auth.resolve(req({ cookie: 'sid=write; scope=split_guest' }))).access, 'none');
    assert.equal((await auth.resolve(req({ cookie: 'sid=write; scope=display; role=admin' }))).access, 'none');
  });
});

test('a missing module permission key fails closed', async () => {
  await withFake(async (url) => {
    const auth = createAuth({ yuvomiUrl: url, publicOrigin: ORIGIN });
    assert.equal((await auth.resolve(req({ cookie: 'sid=write; nokey=1' }))).access, 'none');
    assert.equal((await auth.resolve(req({ cookie: 'sid=write; nokey=1; role=admin' }))).access, 'write');
  });
});

test('resolve forwards the client address to Yuvomi', async () => {
  await withFake(async (url, fake) => {
    const auth = createAuth({ yuvomiUrl: url, publicOrigin: ORIGIN });
    await auth.resolve({ method: 'GET', headers: { cookie: 'sid=write', 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '172.18.0.5' } });
    assert.equal(fake.headers().at(-1)['x-forwarded-for'], '203.0.113.9');
    await auth.resolve({ method: 'GET', headers: { cookie: 'sid=read' }, socket: { remoteAddress: '172.18.0.5' } });
    assert.equal(fake.headers().at(-1)['x-forwarded-for'], '172.18.0.5');
  });
});
