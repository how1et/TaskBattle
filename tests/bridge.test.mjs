import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './load-module.mjs';

const { canonicalBridgeOrigin, handleBridge, isBridgeStaticRequest, verifiedBridgeClientIp } =
  await loadModule('../lib/server/bridge.ts');
const source = 'https://old.chatgpt.site';
const target = 'https://new.example.test';
const key = 'a'.repeat(64);
const env = {
  MIGRATION_TARGET_ORIGIN: target,
  MIGRATION_SOURCE_ORIGIN: source,
  MIGRATION_BRIDGE_KEY: key,
};
const ip = '198.51.100.20';
const backend = { ...env, RUNTIME: 'yandex', MIGRATION_TARGET_ORIGIN: undefined };
function request(path = '/api/rooms/room', options = {}) {
  return new Request(source + path, {
    ...options,
    headers: { 'cf-connecting-ip': ip, 'sec-fetch-site': 'same-origin', ...options.headers },
  });
}
function forbiddenFetch() {
  throw new Error('The upstream must not be contacted');
}
async function code(response, status, expected) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).code, expected);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}

test('bridge disabled preserves the existing handler; configured invalid origins fail closed', async () => {
  assert.equal(await handleBridge(request(), {}, { fetcher: forbiddenFetch }), null);
  assert.equal(canonicalBridgeOrigin(target), target);
  for (const origin of [
    'http://new.example.test',
    target + '/',
    target + '/api',
    target + '?q=1',
    target + '#fragment',
    'https://user:password@new.example.test',
    'https://new.example.test:443',
    '//new.example.test',
    'not a URL',
  ]) {
    assert.throws(() => canonicalBridgeOrigin(origin));
    await code(
      await handleBridge(
        request(),
        { ...env, MIGRATION_TARGET_ORIGIN: origin },
        {
          fetcher: forbiddenFetch,
        },
      ),
      503,
      'bridge-configuration',
    );
  }
  for (const invalid of [
    { MIGRATION_TARGET_ORIGIN: source },
    { MIGRATION_SOURCE_ORIGIN: target },
    { MIGRATION_SOURCE_ORIGIN: undefined },
    { MIGRATION_BRIDGE_KEY: 'short' },
    { RUNTIME: 'yandex' },
  ])
    await code(
      await handleBridge(request(), { ...env, ...invalid }, { fetcher: forbiddenFetch }),
      503,
      'bridge-configuration',
    );
});

test('local migration status stays local and every accepted unfreeze spelling is retired', async () => {
  for (const path of ['/api/migration/status', '/api/migration/status/', '/api//migration//status'])
    assert.equal(await handleBridge(request(path), env, { fetcher: forbiddenFetch }), null);
  for (const path of [
    '/api/migration/unfreeze',
    '/api/migration/unfreeze/',
    '/api//migration//unfreeze/',
    '/api/migration/unfreeze/extra',
  ])
    await code(
      await handleBridge(request(path, { method: 'POST' }), env, {
        fetcher: forbiddenFetch,
      }),
      409,
      'bridge-source-retired',
    );
});

test('original browser origin and cross-site API access are checked before any rewriting', async () => {
  for (const headers of [
    { origin: 'https://attacker.test' },
    { origin: target },
    { origin: 'null' },
    { origin: source, 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  ])
    await code(
      await handleBridge(request('/api/rooms', { method: 'POST', headers }), env, {
        fetcher: forbiddenFetch,
      }),
      403,
      'bridge-origin',
    );
  await code(
    await handleBridge(new Request(target + '/api/health'), env, {
      fetcher: forbiddenFetch,
    }),
    403,
    'bridge-origin',
  );
  await code(
    await handleBridge(
      request('/api/rooms/room', {
        headers: {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      }),
      env,
      { fetcher: forbiddenFetch },
    ),
    403,
    'bridge-origin',
  );

  let calls = 0;
  const response = await handleBridge(
    request('/r/room#secret-never-sent', {
      headers: {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    }),
    env,
    {
      fetcher: async (outgoing) => {
        calls++;
        assert.equal(outgoing.url, target + '/r/room');
        assert.equal(outgoing.headers.get('origin'), null);
        return new Response('<html>shared link</html>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
});

test('fixed upstream streams photo bytes, preserves auth protocol and replaces spoofed bridge headers', async () => {
  const body = Uint8Array.from([0, 255, 1, 127, 2]);
  const req = request('/api/attempts/attempt/answer?revision=2#private', {
    method: 'POST',
    body,
    headers: {
      origin: source,
      'content-type': 'image/png',
      'x-attempt-key': 'attempt-secret',
      'x-teacher-key': 'teacher-secret',
      'x-migration-key': 'migration-secret',
      'x-cleanup-key': 'cleanup-secret',
      'x-taskbattle-bridge-key': 'forged',
      'x-taskbattle-bridge-source': 'https://forged.test',
      'x-taskbattle-bridge-client-ip': '1.1.1.1',
      'x-taskbattle-client-ip': '2.2.2.2',
      'x-forwarded-for': '3.3.3.3',
      forwarded: 'for=4.4.4.4',
      cookie: 'session=private',
      authorization: 'Bearer private',
      referer: source + '/teacher/secret',
    },
  });
  let calls = 0;
  const response = await handleBridge(req, env, {
    fetcher: async (outgoing) => {
      calls++;
      assert.equal(outgoing.url, target + '/api/attempts/attempt/answer?revision=2');
      assert.equal(outgoing.redirect, 'manual');
      assert.equal(outgoing.method, 'POST');
      assert.equal(outgoing.headers.get('origin'), target);
      assert.equal(outgoing.headers.get('content-type'), 'image/png');
      assert.equal(outgoing.headers.get('accept-encoding'), 'identity');
      assert.equal(outgoing.headers.get('x-attempt-key'), 'attempt-secret');
      assert.equal(outgoing.headers.get('x-teacher-key'), 'teacher-secret');
      assert.equal(outgoing.headers.get('x-taskbattle-bridge-key'), key);
      assert.equal(outgoing.headers.get('x-taskbattle-bridge-source'), source);
      assert.equal(outgoing.headers.get('x-taskbattle-bridge-client-ip'), ip);
      for (const name of [
        'cf-connecting-ip',
        'x-taskbattle-client-ip',
        'x-forwarded-for',
        'forwarded',
        'cookie',
        'authorization',
        'referer',
        'x-migration-key',
        'x-cleanup-key',
      ])
        assert.equal(outgoing.headers.get(name), null, name);
      assert.deepEqual(new Uint8Array(await outgoing.arrayBuffer()), body);
      assert.deepEqual(await verifiedBridgeClientIp(outgoing, backend), { clientIp: ip });
      return Response.json({ saved: true }, { status: 201 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { saved: true });
});

test('a double-slash path and query can never select another upstream host', async () => {
  const response = await handleBridge(
    request('//attacker.test/api?next=https://attacker.test'),
    env,
    {
      fetcher: async (outgoing) => {
        const url = new URL(outgoing.url);
        assert.equal(url.origin, target);
        assert.equal(url.pathname, '//attacker.test/api');
        return new Response('safe');
      },
    },
  );
  assert.equal(await response.text(), 'safe');
});

test('backend IP is accepted only with the dedicated key, exact source and a valid address', async () => {
  assert.deepEqual(await verifiedBridgeClientIp(new Request(target), backend), { clientIp: null });
  const trusted = {
    'x-taskbattle-bridge-key': key,
    'x-taskbattle-bridge-source': source,
    'x-taskbattle-bridge-client-ip': ip,
  };
  for (const valid of [ip, '2001:DB8::1', '::1', '::ffff:192.0.2.1'])
    assert.deepEqual(
      await verifiedBridgeClientIp(
        new Request(target, {
          headers: {
            ...trusted,
            'x-taskbattle-bridge-client-ip': valid,
          },
        }),
        backend,
      ),
      { clientIp: valid.toLowerCase() },
    );
  for (const change of [
    { 'x-taskbattle-bridge-key': 'b'.repeat(64) },
    { 'x-taskbattle-bridge-key': 'not-a-key' },
    { 'x-taskbattle-bridge-source': source + '/' },
    { 'x-taskbattle-bridge-source': target },
    { 'x-taskbattle-bridge-client-ip': '198.51.100.20, 1.1.1.1' },
    { 'x-taskbattle-bridge-client-ip': '999.1.1.1' },
    { 'x-taskbattle-bridge-client-ip': '127.00.0.1' },
    { 'x-taskbattle-bridge-client-ip': 'localhost' },
    { 'x-taskbattle-bridge-client-ip': '::ffff:999.1.1.1' },
    { 'x-taskbattle-bridge-client-ip': '1:2:3:4:5:6:7:8::' },
  ]) {
    const result = await verifiedBridgeClientIp(
      new Request(target, { headers: { ...trusted, ...change } }),
      backend,
    );
    await code(result.error, 403, 'bridge-access');
  }
  for (const missing of Object.keys(trusted)) {
    const headers = { ...trusted };
    delete headers[missing];
    await code(
      (await verifiedBridgeClientIp(new Request(target, { headers }), backend)).error,
      403,
      'bridge-access',
    );
  }
  for (const invalid of [
    { RUNTIME: undefined },
    { MIGRATION_BRIDGE_KEY: undefined },
    { MIGRATION_SOURCE_ORIGIN: undefined },
  ])
    await code(
      (
        await verifiedBridgeClientIp(new Request(target, { headers: trusted }), {
          ...backend,
          ...invalid,
        })
      ).error,
      403,
      'bridge-access',
    );
});

test('the source refuses missing or malformed Cloudflare client IP instead of trusting browser headers', async () => {
  for (const address of ['', '198.51.100.20, 1.1.1.1', '1234', '1.2.3.999'])
    await code(
      await handleBridge(
        request('/api/health', {
          headers: {
            'cf-connecting-ip': address,
            'x-taskbattle-client-ip': ip,
          },
        }),
        env,
        { fetcher: forbiddenFetch },
      ),
      503,
      'bridge-client-address',
    );
});

test('API failures never invoke old assets or retry a possibly committed POST', async () => {
  for (const kind of ['network', '404', '503']) {
    let calls = 0;
    let assets = 0;
    const response = await handleBridge(
      request('/api/attempts/attempt/answer', {
        method: 'POST',
        body: 'answer',
        headers: { origin: source },
      }),
      env,
      {
        fetcher: async (outgoing) => {
          calls++;
          assert.equal(await outgoing.text(), 'answer');
          if (kind === 'network') throw new Error('private upstream detail');
          return Response.json({ code: 'upstream' }, { status: Number(kind) });
        },
        assetFetch: async () => {
          assets++;
          return new Response('old application');
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(assets, 0);
    assert.equal(response.status, kind === 'network' ? 503 : Number(kind));
    assert.doesNotMatch(await response.text(), /private upstream detail/);
  }
});

test('bridge deadline is 85 seconds and browser cancellation reaches the only upstream attempt', async (t) => {
  const originalTimeout = AbortSignal.timeout;
  const timeoutSignal = new AbortController().signal;
  t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
    assert.equal(milliseconds, 85_000);
    return timeoutSignal;
  });
  const browser = new AbortController();
  let calls = 0;
  const response = await handleBridge(
    request('/api/attempts/attempt/export', {
      method: 'POST',
      body: '{}',
      signal: browser.signal,
    }),
    env,
    {
      fetcher: async (outgoing) => {
        calls++;
        assert.equal(outgoing.signal.aborted, false);
        browser.abort();
        assert.equal(outgoing.signal.aborted, true);
        throw new DOMException('Aborted', 'AbortError');
      },
    },
  );
  assert.equal(calls, 1);
  await code(response, 503, 'bridge-upstream');
  assert.notEqual(AbortSignal.timeout, originalTimeout);
});

test('only known build assets can fall back; application routes, uploads and source maps cannot', async () => {
  for (const path of [
    '/_next/static/chunks/old-build.js',
    '/_next/static/css/theme.css',
    '/_next/static/build-id/_buildManifest.js',
    '/assets/font.woff2',
  ])
    assert.equal(isBridgeStaticRequest(request(path)), true, path);
  for (const path of [
    '/api/photos/a.png',
    '/r/room',
    '/',
    '/_next/static/index.html',
    '/_next/static/chunks/build.js.map',
    '/_next/static/secrets.json',
    '/_next/static//a.js',
    '/_next/static/%2fapi.js',
    '/_next/static/../../api/a.js',
    '/photos/a.png',
  ]) {
    assert.equal(isBridgeStaticRequest(request(path)), false, path);
    let assets = 0;
    await code(
      await handleBridge(request(path), env, {
        fetcher: async () => {
          throw new Error('offline');
        },
        assetFetch: async () => {
          assets++;
          return new Response('old application');
        },
      }),
      503,
      'bridge-upstream',
    );
    assert.equal(assets, 0);
  }
  assert.equal(isBridgeStaticRequest(request('/_next/static/a.js', { method: 'POST' })), false);
});

test('old build chunks survive upstream misses without relaying private request headers to ASSETS', async () => {
  for (const kind of ['network', '404', '503']) {
    let assets = 0;
    const response = await handleBridge(
      request('/_next/static/chunks/old.js', {
        headers: {
          origin: source,
          'x-attempt-key': 'private',
          cookie: 'private',
          range: 'bytes=0-10',
        },
      }),
      env,
      {
        fetcher: async () => {
          if (kind === 'network') throw new Error('offline');
          return new Response('missing', { status: Number(kind) });
        },
        assetFetch: async (assetRequest) => {
          assets++;
          assert.equal(assetRequest.url, source + '/_next/static/chunks/old.js');
          assert.deepEqual([...assetRequest.headers], [['range', 'bytes=0-10']]);
          return new Response('old chunk', {
            headers: {
              'content-type': 'application/javascript',
              'cache-control': 'public, max-age=31536000, immutable',
              'set-cookie': 'must-not-pass',
            },
          });
        },
      },
    );
    assert.equal(assets, 1);
    assert.equal(await response.text(), 'old chunk');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.match(response.headers.get('cache-control'), /immutable/);
  }
});

test('a missing old asset never becomes a successful HTML or JSON renderer fallback', async () => {
  for (const [status, type] of [
    [200, 'text/html; charset=utf-8'],
    [200, 'application/json'],
    [404, 'application/javascript'],
  ]) {
    const response = await handleBridge(request('/_next/static/chunks/missing.js'), env, {
      fetcher: async () => new Response('upstream missing', { status: 404 }),
      assetFetch: async () =>
        new Response('old renderer', { status, headers: { 'content-type': type } }),
    });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'upstream missing');
  }
});

test('same-target redirects preserve old browser origin, while other hosts and malformed redirects fail', async () => {
  for (const location of [target + '/r/room?mode=1#fragment', '/r/room?mode=1#fragment']) {
    const response = await handleBridge(request('/'), env, {
      fetcher: async (outgoing) => {
        assert.equal(outgoing.redirect, 'manual');
        return new Response(null, { status: 307, headers: { location } });
      },
    });
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), source + '/r/room?mode=1#fragment');
  }
  for (const location of [
    'https://attacker.test/private',
    '//attacker.test/private',
    'https://name:password@new.example.test/private',
    'http://new.example.test/private',
    'http://[bad',
  ]) {
    await code(
      await handleBridge(request('/'), env, {
        fetcher: async () =>
          new Response(null, {
            status: 302,
            headers: { location },
          }),
      }),
      502,
      'bridge-redirect',
    );
  }
  await code(
    await handleBridge(request('/'), env, {
      fetcher: async () =>
        new Response(null, {
          status: 302,
        }),
    }),
    502,
    'bridge-redirect',
  );
});

test('photo responses stay streaming and private; backend cookie/auth/transport headers are removed', async () => {
  const photo = Uint8Array.from([137, 80, 78, 71, 255]);
  const response = await handleBridge(request('/api/photos/private'), env, {
    fetcher: async () =>
      new Response(photo, {
        headers: {
          'content-type': 'image/png',
          'set-cookie': 'session=private',
          'www-authenticate': 'private',
          'x-taskbattle-bridge-key': key,
          'content-length': '5',
          'content-encoding': 'identity',
          'cache-control': 'public, max-age=1000',
        },
      }),
  });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), photo);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  for (const name of [
    'set-cookie',
    'www-authenticate',
    'x-taskbattle-bridge-key',
    'content-length',
    'content-encoding',
  ])
    assert.equal(response.headers.get(name), null);
});

test('HEAD and conditional assets preserve status without fabricating a body', async () => {
  const head = await handleBridge(request('/_next/static/a.js', { method: 'HEAD' }), env, {
    fetcher: async () =>
      new Response(null, { headers: { 'content-type': 'application/javascript' } }),
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const unchanged = await handleBridge(request('/_next/static/a.js'), env, {
    fetcher: async () => new Response(null, { status: 304, headers: { etag: 'unchanged' } }),
  });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get('etag'), 'unchanged');
  assert.equal(await unchanged.text(), '');
});
