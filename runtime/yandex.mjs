import { createHash } from 'node:crypto';

export function metadataToken(fetcher = fetch) {
  let cached, pending;
  return async function token(refresh = false) {
    if (refresh) cached = null;
    if (cached && cached.until > Date.now()) return cached.value;
    if (!pending)
      pending = (async () => {
        const r = await fetcher(
          'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
          {
            headers: { 'Metadata-Flavor': 'Google' },
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          },
        );
        if (!r.ok) throw new Error('Yandex metadata authorization failed');
        const d = await r.json();
        if (
          typeof d.access_token !== 'string' ||
          !Number.isFinite(d.expires_in) ||
          d.expires_in < 120
        )
          throw new Error('Invalid metadata token response');
        cached = {
          value: d.access_token,
          until: Date.now() + Math.min(3600, d.expires_in - 60) * 1000,
        };
        return cached.value;
      })().finally(() => {
        pending = null;
      });
    return pending;
  };
}

export async function lockboxSecrets(secretId, token, fetcher = fetch) {
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(secretId)) throw new Error('Invalid Lockbox secret ID');
  const r = await fetcher(
    `https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/${secretId}/payload`,
    {
      headers: { Authorization: 'Bearer ' + (await token()) },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    },
  );
  if (!r.ok) throw new Error('Lockbox access failed');
  const result = Object.create(null);
  for (const entry of (await r.json()).entries || []) {
    if (
      [
        'CLEANUP_SECRET',
        'MIGRATION_SECRET',
        'YANDEX_DISK_TOKEN',
        'YANDEX_OAUTH_CLIENT_ID',
        'YANDEX_OAUTH_CLIENT_SECRET',
        'YANDEX_OAUTH_REFRESH_TOKEN',
      ].includes(entry.key) &&
      typeof entry.textValue === 'string'
    )
      result[entry.key] = entry.textValue;
  }
  return result;
}

export function objectStore(
  bucket,
  token,
  { fetcher = fetch, endpoint = 'https://storage.yandexcloud.net', allowLocalTest = false } = {},
) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error('Invalid private bucket name');
  const base = new URL(endpoint);
  if (
    base.origin !== 'https://storage.yandexcloud.net' &&
    !(allowLocalTest && ['127.0.0.1', 'localhost'].includes(base.hostname))
  )
    throw new Error('Untrusted storage endpoint');
  function url(key) {
    if (
      !key ||
      key.startsWith('/') ||
      key.split('/').some((x) => !x || x === '.' || x === '..') ||
      key.includes('\\')
    )
      throw new Error('Invalid object key');
    return `${base.origin}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  async function request(method, key, body, headers = {}) {
    for (let n = 0; n < 2; n++) {
      const response = await fetcher(url(key), {
        method,
        body,
        headers: { ...headers, Authorization: 'Bearer ' + (await token(n === 1)) },
        signal: AbortSignal.timeout(45000),
        redirect: 'error',
      });
      if (response.status === 401 && n === 0) {
        await response.body?.cancel();
        continue;
      }
      if (response.ok || response.status === 404) return response;
      await response.body?.cancel();
      const error = new Error('Object storage request failed');
      error.status = response.status;
      throw error;
    }
    throw new Error('Object storage authorization failed');
  }
  return {
    async put(key, source, options = {}) {
      const bytes = new Uint8Array(await new Response(source).arrayBuffer());
      const r = await request('PUT', key, bytes, {
        'Content-Type': options.httpMetadata?.contentType || 'application/octet-stream',
        'Content-MD5': createHash('md5').update(bytes).digest('base64'),
        'x-amz-meta-sha256': createHash('sha256').update(bytes).digest('hex'),
      });
      if (!r.ok) throw new Error('Object upload failed');
      await r.body?.cancel();
      return { key, etag: r.headers.get('etag'), versionId: r.headers.get('x-amz-version-id') };
    },
    async get(key) {
      const r = await request('GET', key);
      if (r.status === 404) {
        await r.body?.cancel();
        return null;
      }
      return {
        body: r.body,
        httpMetadata: { contentType: r.headers.get('content-type') },
        etag: r.headers.get('etag'),
      };
    },
    async delete(keys) {
      // Small bounded groups; DELETE is idempotent. A partial failure keeps the DB deletion journal.
      const list = Array.isArray(keys) ? keys : [keys];
      for (let i = 0; i < list.length; i += 5)
        await Promise.all(
          list.slice(i, i + 5).map(async (key) => {
            const r = await request('DELETE', key);
            await r.body?.cancel();
          }),
        );
    },
  };
}
