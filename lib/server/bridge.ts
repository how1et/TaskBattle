/** Transitional transport only. This module deliberately cannot access D1 or R2. */
export type BridgeEnv = {
  MIGRATION_TARGET_ORIGIN?: string;
  MIGRATION_SOURCE_ORIGIN?: string;
  MIGRATION_BRIDGE_KEY?: string;
  RUNTIME?: string;
};
type BridgeOptions = {
  fetcher?: typeof fetch;
  assetFetch?: (request: Request) => Promise<Response>;
};
const keyHeader = 'x-taskbattle-bridge-key';
const sourceHeader = 'x-taskbattle-bridge-source';
const ipHeader = 'x-taskbattle-bridge-client-ip';
const secretPattern = /^[a-fA-F0-9]{64}$/;
const requestHeaders = [
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
  'x-attempt-key',
  'x-teacher-key',
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
  'next-url',
  'next-action',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
];
const responseHeaders = [
  'content-type',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'vary',
  'retry-after',
  'content-security-policy',
  'permissions-policy',
  'x-frame-options',
];
const safeHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function failure(status: number, code: string) {
  return Response.json(
    {
      error:
        status === 403
          ? 'Откройте полную ссылку TaskBattle и повторите действие.'
          : 'TaskBattle временно недоступен. Ваш черновик остаётся в этой вкладке. Повторите позже.',
      code,
    },
    { status, headers: safeHeaders },
  );
}

export function canonicalBridgeOrigin(value: string | undefined) {
  if (!value) throw new Error('Bridge origin is missing');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    throw new Error('Bridge origin must be a canonical HTTPS origin');
  return url.origin;
}

function validIp(value: string | null): value is string {
  if (!value || value.length > 45) return false;
  const ipv4 = (text: string) => {
    const pieces = text.split('.');
    return (
      pieces.length === 4 &&
      pieces.every((piece) => /^(0|[1-9]\d{0,2})$/.test(piece) && Number(piece) <= 255)
    );
  };
  if (ipv4(value)) return true;
  if (!/^[a-fA-F0-9:.]+$/.test(value) || !value.includes(':')) return false;
  let address = value;
  if (address.includes('.')) {
    const last = address.lastIndexOf(':');
    if (last === -1 || !ipv4(address.slice(last + 1))) return false;
    address = address.slice(0, last + 1) + '0:0';
  }
  const halves = address.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half ? half.split(':') : []));
  return (
    groups.every((group) => /^[a-fA-F0-9]{1,4}$/.test(group)) &&
    (halves.length === 2 ? groups.length < 8 : groups.length === 8)
  );
}

async function sameSecret(actual: string, expected: string) {
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** Backend use only: do not trust bridge IP headers without all three checks. */
export async function verifiedBridgeClientIp(
  request: Request,
  env: BridgeEnv,
): Promise<{ clientIp: string | null; error?: never } | { error: Response; clientIp?: never }> {
  const supplied = request.headers.get(keyHeader);
  const source = request.headers.get(sourceHeader);
  const ip = request.headers.get(ipHeader);
  if (supplied === null && source === null && ip === null) return { clientIp: null };
  let expectedSource: string;
  try {
    expectedSource = canonicalBridgeOrigin(env.MIGRATION_SOURCE_ORIGIN);
  } catch {
    return { error: failure(403, 'bridge-access') };
  }
  if (
    env.RUNTIME !== 'yandex' ||
    !secretPattern.test(env.MIGRATION_BRIDGE_KEY || '') ||
    !secretPattern.test(supplied || '') ||
    source !== expectedSource ||
    !validIp(ip) ||
    !(await sameSecret(supplied!, env.MIGRATION_BRIDGE_KEY!))
  )
    return { error: failure(403, 'bridge-access') };
  return { clientIp: ip!.toLowerCase() };
}

export function isBridgeStaticRequest(request: Request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const pathname = new URL(request.url).pathname;
  // Only build assets, never a framework renderer, API, user upload or source map.
  return (
    /^\/(?:_next\/static|assets)\/[A-Za-z0-9_./-]+\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|webp|svg|ico)$/.test(
      pathname,
    ) &&
    !pathname.includes('//') &&
    !pathname.split('/').some((piece) => piece === '.' || piece === '..')
  );
}

function validOriginalRequest(request: Request, source: string) {
  const url = new URL(request.url);
  if (url.origin !== source) return false;
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== source) return false;
  if (request.headers.get('sec-fetch-site') !== 'cross-site') return true;
  // Shared room/teacher links may be opened from a messenger or another site.
  // This exception only renders the page; all API requests remain protected.
  return (
    request.method === 'GET' &&
    !url.pathname.startsWith('/api') &&
    origin === null &&
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('sec-fetch-dest') === 'document'
  );
}

async function oldStatic(request: Request, options: BridgeOptions) {
  if (!options.assetFetch || !isBridgeStaticRequest(request)) return null;
  try {
    const headers = new Headers();
    for (const name of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const result = await options.assetFetch(
      new Request(request.url, { method: request.method, headers }),
    );
    const type = result.headers.get('content-type')?.toLowerCase() || '';
    if (
      (result.ok || result.status === 304) &&
      !type.includes('text/html') &&
      !type.includes('application/json')
    )
      return relayResponse(result, request, new URL(request.url).origin);
    await result.body?.cancel();
  } catch {
    /* A missing static file must never invoke the old application. */
  }
  return null;
}

function relayResponse(response: Response, request: Request, target: string) {
  const headers = new Headers(safeHeaders);
  for (const name of responseHeaders) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (isBridgeStaticRequest(request) && (response.ok || response.status === 304))
    headers.set(
      'Cache-Control',
      response.headers.get('cache-control') || 'public, max-age=31536000, immutable',
    );
  const location = response.headers.get('location');
  if (location !== null) {
    const sourceUrl = new URL(request.url);
    const base = new URL(target);
    base.pathname = sourceUrl.pathname;
    base.search = sourceUrl.search;
    let redirect: URL;
    try {
      redirect = new URL(location, base);
    } catch {
      return failure(502, 'bridge-redirect');
    }
    if (redirect.origin !== target || redirect.username || redirect.password)
      return failure(502, 'bridge-redirect');
    headers.set('Location', sourceUrl.origin + redirect.pathname + redirect.search + redirect.hash);
  } else if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    return failure(502, 'bridge-redirect');
  }
  // Cookies, authentication headers and transport lengths/encoding are not relayed.
  // TaskBattle uses the existing secret URL/header protocol, not cookies.
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Worker entry must call this before Vinext. With a configured target, null
 * is reserved for local migration administration; failures never reach D1.
 */
export async function handleBridge(
  request: Request,
  env: BridgeEnv,
  options: BridgeOptions = {},
): Promise<Response | null> {
  if (!env.MIGRATION_TARGET_ORIGIN) return null;
  const sourceUrl = new URL(request.url);
  // Match the application's normalization, including trailing/repeated slashes.
  const path = sourceUrl.pathname.split('/').filter(Boolean);
  if (path[0] === 'api' && path[1] === 'migration') {
    if (path[2] === 'unfreeze') return failure(409, 'bridge-source-retired');
    return null;
  }
  let target: string, source: string;
  try {
    target = canonicalBridgeOrigin(env.MIGRATION_TARGET_ORIGIN);
    source = canonicalBridgeOrigin(env.MIGRATION_SOURCE_ORIGIN);
    if (
      target === source ||
      env.RUNTIME === 'yandex' ||
      !secretPattern.test(env.MIGRATION_BRIDGE_KEY || '')
    )
      throw new Error('Invalid bridge configuration');
  } catch {
    return failure(503, 'bridge-configuration');
  }
  if (!validOriginalRequest(request, source)) return failure(403, 'bridge-origin');
  const ip = request.headers.get('cf-connecting-ip');
  if (!validIp(ip)) return failure(503, 'bridge-client-address');
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method))
    return failure(405, 'bridge-method');
  const upstream = new URL(target);
  // Assignment avoids interpreting a //path as a different origin.
  upstream.pathname = sourceUrl.pathname;
  upstream.search = sourceUrl.search;
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (request.headers.has('origin')) headers.set('origin', target);
  headers.set('accept-encoding', 'identity');
  headers.set(keyHeader, env.MIGRATION_BRIDGE_KEY!);
  headers.set(sourceHeader, source);
  headers.set(ipHeader, ip!);
  try {
    // Node's Request implementation needs duplex for streaming bodies; Workers
    // ignore this extension. Never clone/buffer or retry a possibly committed POST.
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(85000)]),
    };
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
      init.body = request.body;
      init.duplex = 'half';
    }
    const response = await (options.fetcher || fetch)(new Request(upstream, init));
    if (response.status === 404 || response.status >= 500) {
      const fallback = await oldStatic(request, options);
      if (fallback) {
        await response.body?.cancel();
        return fallback;
      }
    }
    const relayed = relayResponse(response, request, target);
    if (
      relayed.status === 502 &&
      relayed.headers.get('content-type')?.includes('application/json') &&
      response.status >= 300 &&
      response.status < 400
    )
      await response.body?.cancel();
    return relayed;
  } catch {
    return (await oldStatic(request, options)) || failure(503, 'bridge-upstream');
  }
}
