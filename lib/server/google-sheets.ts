import { env } from 'cloudflare:workers';
import { fail } from './context';
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const encoded = (v: unknown) => b64(new TextEncoder().encode(JSON.stringify(v)));
let cached: { value: string; expires: number } | undefined;
let pending: Promise<string> | undefined;
export function googleConfig() {
  const id = env.GOOGLE_SPREADSHEET_ID;
  if (!id || !env.GOOGLE_SERVICE_ACCOUNT_JSON)
    fail(
      503,
      'Экспорт ещё не подключён. Нужны доступ к таблице и настройка Google на сервере.',
      'google-setup',
    );
  if (!/^[\w-]{20,150}$/.test(id!))
    fail(503, 'Проверьте адрес Google-таблицы в настройках сайта.', 'google-setup');
  return { id: id!, credentials: env.GOOGLE_SERVICE_ACCOUNT_JSON! };
}
async function requestToken() {
  const { credentials } = googleConfig();
  let sa: { client_email: string; private_key: string; private_key_id?: string };
  try {
    sa = JSON.parse(credentials);
  } catch {
    fail(503, 'Нужно обновить подключение Google.', 'google-auth');
  }
  try {
    const der = Uint8Array.from(
      atob(
        sa!.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''),
      ),
      (c) => c.charCodeAt(0),
    );
    const key = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const now = Math.floor(Date.now() / 1000),
      unsigned =
        encoded({ alg: 'RS256', typ: 'JWT', kid: sa!.private_key_id }) +
        '.' +
        encoded({
          iss: sa!.client_email,
          scope: 'https://www.googleapis.com/auth/spreadsheets',
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3600,
        });
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      key,
      new TextEncoder().encode(unsigned),
    );
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: unsigned + '.' + b64(new Uint8Array(signature)),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      fail(503, 'Подключение Google недействительно. Обновите доступ на сервере.', 'google-auth');
    const token = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!token.access_token) throw Error('Missing token');
    cached = {
      value: token.access_token,
      expires: Date.now() + ((token.expires_in || 3600) - 60) * 1000,
    };
    return cached.value;
  } catch (e) {
    if (e instanceof Error && 'status' in e) throw e;
    return fail(503, 'Не удалось подключиться к Google. Повторите позже.', 'google-network');
  }
}
async function token() {
  if (cached && cached.expires > Date.now()) return cached.value;
  pending ||= requestToken().finally(() => {
    pending = undefined;
  });
  return pending;
}
export async function googleRequest(path: string, body?: unknown, retry = true): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer ' + (await token()),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    if (e instanceof Error && 'status' in e) throw e;
    fail(503, 'Связь с Google прервалась. Повторите сохранение.', 'google-network');
  }
  if (response!.status === 401 && retry) {
    cached = undefined;
    return googleRequest(path, body, false);
  }
  if (!response!.ok) {
    if (response!.status === 403 || response!.status === 404)
      fail(
        403,
        'Нет доступа к Google-таблице. Предоставьте служебному аккаунту право редактора.',
        'google-access',
      );
    if (response!.status === 429)
      fail(429, 'Google временно ограничил запросы. Подождите минуту и повторите.', 'google-quota');
    fail(503, 'Не удалось сохранить лист в Google. Повторите сохранение.', 'google-save');
  }
  return response!.json();
}
