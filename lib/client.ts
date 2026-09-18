export type Photo = {
    id: string;
    ordinal: number;
    photo: string;
};
export type RoomData = {
    roomId: string;
    title: string;
    count: number;
    expiresAt: number;
    roomExpiresAt?: number;
    roomClosed?: boolean;
    clockOffset?: number;
    serverNow: number;
    tasks: Photo[];
    attempts?: {
        id: string;
        number: number;
        startedAt: number;
        finishedAt: number | null;
        position: number;
        resultExpiresAt?:number|null;
    }[];
};
export type ReportRow = Photo & {
    answer: string;
    correctAnswer: string;
    correct: boolean;
    durationMs: number;
    solutionPhoto?: string|null;
};
export type AttemptData = RoomData & {
    attemptId: string;
    position: number;
    startedAt: number;
    taskStartedAt: number|null;
    readyId: string|null;
    timingVersion: number;
    completedMs: number;
    resultExpiresAt:number|null;
    finishedAt: number | null;
    report?: ReportRow[];
    summary?: {
        totalMs: number;
        averageMs: number;
        correct: number;
        count: number;
        fastest: {
            ordinals: number[];
            durationMs: number;
        };
        slowest: {
            ordinals: number[];
            durationMs: number;
        };
    };
};
export class ApiError extends Error {
    constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, key?: string, teacher = false, body?: unknown): Promise<T> {
    const sentAt=Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal, headers: { ...(key ? { [teacher ? 'x-teacher-key' : 'x-attempt-key']: key } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json() as T & {serverNow?:number;clockOffset?:number;
            error?: string;
        };
        if (!response.ok)
            throw new ApiError(data.error || 'Не удалось выполнить действие. Попробуйте ещё раз.', response.status);
        if(data.serverNow)data.clockOffset=data.serverNow-(sentAt+Date.now())/2;
        return data;
    }
    catch (e) {
        if (e instanceof ApiError)
            throw e;
        throw new ApiError('Связь прервалась. Проверьте интернет и повторите действие, не закрывая страницу.', 0);
    }
    finally {
        clearTimeout(timeout);
    }
}
export const date = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
export {duration} from './time';
export const newKey = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
// Browser storage contains recovery tokens/drafts only; all results and clocks live in D1.
export function readLocal<T>(key: string): T | null { try {
    return JSON.parse(sessionStorage.getItem(key) || 'null');
}
catch {
    return null;
} }
export function writeLocal(key: string, value: unknown) { try {
    sessionStorage.setItem(key, JSON.stringify(value));
}
catch { /* Current tab still works when storage is disabled. */ } }
const pictures = new Map<string, {
    expires: number;
    promise: Promise<string>;
}>();
export function loadPhoto(path: string, expires: number,key?:string,teacher=false) {
    const cacheKey=path+':'+(teacher?'teacher':'student')+':'+(key||'');
    const existing = pictures.get(cacheKey);
    if (existing && existing.expires > Date.now()) return existing.promise;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const promise = fetch(path, { cache: 'no-store', signal: controller.signal,headers:key?{[teacher?'x-teacher-key':'x-attempt-key']:key}:{} }).then(async r => {
        if (!r.ok) {const message=await r.json().catch(()=>({})) as {error?:string};throw new ApiError(message.error||'Не удалось загрузить фотографию. Повторите загрузку.',r.status);}
        const url=URL.createObjectURL(await r.blob());
        const image=new Image();image.src=url;
        try{await image.decode();}catch{URL.revokeObjectURL(url);throw new ApiError('Фотография не открывается. Попросите преподавателя заменить её.',415);}
        return url;
    }).catch(error => {
        pictures.delete(cacheKey);
        throw error instanceof ApiError ? error : new ApiError('Связь прервалась при загрузке фотографии. Проверьте интернет и повторите загрузку.', 0);
    }).finally(() => clearTimeout(timeout));
    pictures.set(cacheKey, { expires, promise });
    return promise;
}
