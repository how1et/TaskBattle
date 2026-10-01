export const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;
const API = 'https://cloud-api.yandex.net/v1/disk';

export class DiskError extends Error {
  constructor(code, { status = 503, ambiguous = false } = {}) {
    super(code);
    this.name = 'DiskError';
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export function validateDiskPath(path) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('disk:/') ||
    !path.endsWith('.xlsx') ||
    path.length > 1024 ||
    /[\u0000-\u001f\\]/.test(path) ||
    path.split('/').some((part) => ['.', '..', ''].includes(part))
  )
    throw new DiskError('disk-setup', { status: 503 });
  return path;
}

export function diskWebUrl(path) {
  validateDiskPath(path);
  return `https://disk.yandex.ru/client/disk${path.slice(5).split('/').map(encodeURIComponent).join('/')}`;
}

export function validateTransferUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DiskError('disk-link');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !['.disk.yandex.net', '.disk.yandex.ru', '.disk.yandex.com'].some((suffix) =>
      url.hostname.endsWith(suffix),
    )
  )
    throw new DiskError('disk-link');
  return url.href;
}

async function boundedBytes(response, limit) {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) {
    await response.body?.cancel();
    throw new DiskError('disk-size', { status: 413 });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new DiskError('disk-size', { status: 413 });
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size);
}

/** Official Disk REST flow: obtain a link, then transfer bytes without OAuth on that URL.
 * https://yandex.com/dev/disk-api/doc/en/reference/upload
 * https://yandex.com/dev/disk-api/doc/en/reference/content
 */
export function createYandexDiskClient({
  tokenProvider,
  fetchImpl = fetch,
  timeoutMs = 15000,
  maxBytes = MAX_WORKBOOK_BYTES,
}) {
  if (typeof tokenProvider !== 'function') throw new DiskError('disk-setup');
  const request = async (url, options = {}) => {
    try {
      return await fetchImpl(url, {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DiskError('disk-network', { ambiguous: options.method === 'PUT' });
    }
  };
  const api = async (endpoint, parameters) => {
    let token;
    try {
      token = await tokenProvider();
    } catch {
      throw new DiskError('disk-auth', { status: 503 });
    }
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token))
      throw new DiskError('disk-setup');
    const response = await request(`${API}${endpoint}?${new URLSearchParams(parameters)}`, {
      headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiskError([401, 403].includes(response.status) ? 'disk-auth' : 'disk-api', {
        status: 503,
      });
    }
    try {
      return JSON.parse((await boundedBytes(response, 256 * 1024)).toString('utf8'));
    } catch (error) {
      if (error instanceof DiskError) throw error;
      throw new DiskError('disk-response');
    }
  };
  const link = (value, method) => {
    if (!value || value.method !== method || value.templated !== false)
      throw new DiskError('disk-link');
    return validateTransferUrl(value.href);
  };
  return {
    async stat(path) {
      validateDiskPath(path);
      const result = await api('/resources', { path, fields: 'type,size,sha256,resource_id' });
      if (result === null) return null;
      if (result.type !== 'file' || !Number.isSafeInteger(result.size) || result.size < 0)
        throw new DiskError('disk-resource');
      if (result.size > maxBytes) throw new DiskError('disk-size', { status: 413 });
      if (!/^[a-f0-9]{64}$/i.test(result.sha256 || '')) throw new DiskError('disk-hash');
      return {
        sha256: result.sha256.toLowerCase(),
        size: result.size,
        resourceId: result.resource_id,
      };
    },
    async download(path) {
      validateDiskPath(path);
      let url = link(await api('/resources/download', { path }), 'GET');
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await request(url);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (redirects === 3 || !response.headers.get('location'))
            throw new DiskError('disk-link');
          url = validateTransferUrl(new URL(response.headers.get('location'), url).href);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new DiskError('disk-download');
        }
        return boundedBytes(response, maxBytes);
      }
      throw new DiskError('disk-link');
    },
    async prepareUpload(path, overwrite) {
      validateDiskPath(path);
      const url = link(
        await api('/resources/upload', { path, overwrite: String(Boolean(overwrite)) }),
        'PUT',
      );
      return async (bytes) => {
        if (bytes.byteLength > maxBytes) throw new DiskError('disk-size', { status: 413 });
        // Never redirect or retry PUT. An unknown outcome must be reconciled by
        // full remote checksum before the durable queue can upload another file.
        const response = await request(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          },
          body: bytes,
        });
        await response.body?.cancel();
        if (![201, 202].includes(response.status))
          throw new DiskError('disk-upload', {
            status: 503,
            ambiguous: response.status < 400 || response.status >= 500 || response.status === 408,
          });
      };
    },
  };
}
