"use client";
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Zap, ArrowRight, Copy, Timer, Check, Maximize2, RotateCw, LockKeyhole, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/dialog';
import { api, ApiError, date, duration, newKey, readLocal, writeLocal, loadPhoto, type RoomData, type AttemptData } from '@/lib/client';
function Frame({ children }: {
    children: React.ReactNode;
}) { return <><header className="topbar"><a className="brand" href="/"><span className="brand-icon"><Zap size={22} fill="currentColor"/></span>TaskBattle</a><span className="header-note">Задачи. Время. Результат.</span><span className="pill">Без регистрации</span></header><main className="workspace"><div className="content-narrow">{children}</div></main></>; }
function Photo({ src, label, small = false }: {
    src: string;
    label: string;
    small?: boolean;
}) { const [zoom, setZoom] = useState(false); return <><button className="image-button" type="button" onClick={() => setZoom(true)} aria-label={`Увеличить: ${label}`}><img src={src} alt={label} style={small ? { height: 220 } : undefined}/><span className="row muted small" style={{ justifyContent: 'center', marginTop: 10 }}><Maximize2 size={15}/>Увеличить фотографию</span></button><Dialog open={zoom} onOpenChange={setZoom}><DialogContent className="zoom-content" showCloseButton={false}><div className="row spread"><DialogTitle>{label}</DialogTitle><DialogClose asChild><Button variant="outline">Закрыть</Button></DialogClose></div><DialogDescription>Масштабируйте фотографию жестом двумя пальцами или средствами браузера.</DialogDescription><img src={src} alt={label}/></DialogContent></Dialog></>; }
function Share({ title, value, secret = false }: {
    title: string;
    value: string;
    secret?: boolean;
}) { const [copied, setCopied] = useState(false); const [failed, setFailed] = useState(false); return <div className={`copy-box ${secret ? 'secret-box' : ''}`}><h3 className="row">{secret && <LockKeyhole size={18}/>} {title}</h3><p className="muted small">{secret ? 'Сохраните эту ссылку. Не отправляйте её ученику: она открывает все результаты.' : 'Отправьте ученику. По одной ссылке можно решать с разных устройств.'}</p><Input className="text-input" readOnly aria-label={title} value={value} onFocus={e => e.target.select()}/><Button className="secondary" variant="outline" onClick={async () => { try {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setFailed(false);
}
catch {
    setFailed(true);
} }}>{copied ? <Check size={18}/> : <Copy size={18}/>} {copied ? 'Ссылка скопирована' : secret ? 'Скопировать секретную ссылку' : 'Скопировать ссылку'}</Button>{failed && <p className="small muted">Выделите ссылку в поле и скопируйте вручную.</p>}</div>; }
function Report({ data, photos }: {
    data: AttemptData;
    photos: Record<string, string>;
}) { const s = data.summary!; return <div className="stack"><div><p className="eyebrow">ПОПЫТКА ЗАВЕРШЕНА</p><h1>Ваш результат</h1><p className="muted">{data.title} · начало {date(data.startedAt)}</p></div><div className="stat-grid"><div className="stat"><strong>{s.correct} из {s.count}</strong><span>Правильных ответов</span></div><div className="stat"><strong>{duration(s.totalMs)}</strong><span>Общее время</span></div><div className="stat"><strong>{duration(s.averageMs)}</strong><span>В среднем на задачу</span></div></div><div className="panel page-card stack"><p><b>Самые быстрые:</b> № {s.fastest.ordinals.join(', ')} · {duration(s.fastest.durationMs)}</p><p><b>Самые долгие:</b> № {s.slowest.ordinals.join(', ')} · {duration(s.slowest.durationMs)}</p><p className="time-note">Время в формате минуты:секунды,миллисекунды. При равном времени показаны все задачи. Номера соответствуют исходному набору преподавателя.</p></div><h2>Разбор задач</h2>{data.report!.map(t => <article className="panel report-task stack" key={t.id}><div className="row spread"><h3>Задача № {t.ordinal}</h3><span className={`status ${t.correct ? 'correct' : 'wrong'}`}>{t.correct ? 'Верно' : 'Неверно'}</span></div>{photos[t.id] ? <Photo src={photos[t.id]} label={`Задача № ${t.ordinal}`} small/> : <p className="muted">Фотография загружается…</p>}<dl className="answer-grid"><div><dt>Ответ ученика</dt><dd>{t.answer}</dd></div><div><dt>Правильный ответ</dt><dd>{t.correctAnswer}</dd></div><div><dt>Время решения</dt><dd>{duration(t.durationMs)}</dd></div></dl></article>)}</div>; }
export default function Battle({ view }: {
    view: string[];
}) {
    const router = useRouter();
    const kind = view[0], id = view[1];
    const reportId = kind === 'teacher' && view[2] === 'attempt' ? view[3] : undefined;
    const [key, setKey] = useState('');
    const [origin, setOrigin] = useState('');
    const [data, setData] = useState<RoomData | AttemptData | null>(null);
    const [error, setError] = useState('');
    const [expired, setExpired] = useState(false);
    const [busy, setBusy] = useState(false);
    const [photos, setPhotos] = useState<Record<string, string>>({});
    const [photoError, setPhotoError] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [answer, setAnswer] = useState('');
    const [pending, setPending] = useState(false);
    const [now, setNow] = useState(Date.now());
    const [offset, setOffset] = useState(0);
    const lock = useRef(false);
    const input = useRef<HTMLInputElement>(null);
    const latest = useRef(data);
    latest.current = data;
    const a = (kind === 'attempt' || reportId) ? data as AttemptData | null : null;
    const position = a?.position;
    function onError(e: unknown) { if (e instanceof ApiError && e.status === 410)
        setExpired(true); setError(e instanceof Error ? e.message : 'Не удалось загрузить данные.'); }
    function accept(d: RoomData | AttemptData) { setData(d); setOffset(d.serverNow - Date.now()); setNow(d.serverNow); setError(''); }
    async function refresh() { try {
        const path = kind === 'room' ? `/rooms/${id}` : kind === 'teacher' && !reportId ? `/rooms/${id}/teacher` : `/attempts/${reportId || id}${reportId ? '/report' : ''}`;
        accept(await api(path, key, kind === 'teacher'));
    }
    catch (e) {
        onError(e);
    } }
    useEffect(() => { setKey(location.hash.slice(1)); setOrigin(location.origin); setData(null); setPhotos({}); setLoaded(false); setExpired(false); setError(''); }, [id, kind, reportId]);
    useEffect(() => { if (kind === 'room' || key)
        void refresh();
    else if (origin)
        setError('Нужна полная секретная ссылка, включая часть после #.'); }, [id, kind, key, reportId, origin]);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now() + offset), 200); return () => clearInterval(timer); }, [offset]);
    useEffect(() => { if (data && now >= data.expiresAt) {
        setExpired(true);
        setPhotos({});
    } }, [now, data?.expiresAt]);
    useEffect(() => { if (!data)
        return; let cancelled = false; setPhotoError(''); setLoaded(false); Promise.all(data.tasks.map(async (t) => { const src = await loadPhoto(t.photo, data.expiresAt); if (!cancelled)
        setPhotos(p => ({ ...p, [t.id]: src })); })).then(() => { if (!cancelled)
        setLoaded(true); }).catch(e => { if (!cancelled) {
        setPhotoError(e.message);
        if (e.status === 410)
            setExpired(true);
    } }); return () => { cancelled = true; }; }, [data?.roomId]);
    useEffect(() => { if (kind === 'teacher' && !reportId && key) {
        const interval = setInterval(() => { if (document.visibilityState === 'visible')
            void refresh(); }, 15000);
        return () => clearInterval(interval);
    } }, [kind, id, key, reportId]);
    useEffect(() => { if (!a || a.finishedAt !== null)
        return; const draft = readLocal<{
        answer: string;
        requestId?: string;
    }>(`draft:${a.attemptId}:${a.position}`); setAnswer(draft?.answer || ''); setPending(!!draft?.requestId); }, [position, a?.attemptId]);
    useEffect(() => { if (kind === 'attempt' && !busy && a?.finishedAt === null && photos[a.tasks[a.position]?.id])
        input.current?.focus(); }, [position, busy, photos]);
    async function start() { if (lock.current)
        return; lock.current = true; setBusy(true); setError(''); try {
        let session = readLocal<{
            id: string;
            key: string;
        }>(`start:${id}`);
        if (!session) {
            session = { id: crypto.randomUUID(), key: newKey() };
            writeLocal(`start:${id}`, session);
        }
        await api(`/rooms/${id}/start`, undefined, false, { attemptId: session.id, attemptKey: session.key });
        router.push(`/attempt/${session.id}#${session.key}`);
    }
    catch (e) {
        onError(e);
    }
    finally {
        setBusy(false);
        lock.current = false;
    } }
    async function submit(value = answer) { const current = latest.current as AttemptData | null; if (lock.current || !current || current.finishedAt !== null || !value.trim())
        return; lock.current = true; setBusy(true); setError(''); const draftKey = `draft:${current.attemptId}:${current.position}`; const old = readLocal<{
        answer: string;
        requestId?: string;
        taskId?: string;
        position?: number;
    }>(draftKey); const payload = old?.requestId ? old : { answer: value, requestId: crypto.randomUUID(), taskId: current.tasks[current.position].id, position: current.position }; writeLocal(draftKey, payload); setPending(true); try {
        const next = await api<AttemptData>(`/attempts/${id}/answers`, key, false, payload);
        writeLocal(draftKey, null);
        accept(next);
        setAnswer('');
        setPending(false);
    }
    catch (e) {
        onError(e);
    }
    finally {
        setBusy(false);
        lock.current = false;
    } }
    useEffect(() => { const ctx = (document as any).modelContext; if (!ctx?.registerTool || kind !== 'attempt')
        return; const lifecycle = new AbortController(); try {
        Promise.resolve(ctx.registerTool({ name: 'taskbattle_get_progress', title: 'Текущая попытка', description: 'Прочитать номер текущей задачи, прогресс и состояние текущей попытки TaskBattle. Без правильных ответов до завершения.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute(input: unknown) { if (!input || typeof input !== 'object' || Object.keys(input).length)
                throw new Error('Ожидается пустой объект'); const d = latest.current as AttemptData | null; return d ? { position: d.position, count: d.count, finished: d.finishedAt !== null } : null; } }, { signal: lifecycle.signal })).catch(() => { });
    }
    catch { } return () => lifecycle.abort(); }, [kind, id]);
    if (expired)
        return <Frame><div className="panel page-card stack"><Timer size={36} color="#345be8"/><h1>Срок действия комнаты истёк</h1><p className="muted">Комната доступна 48 часов с момента создания. Попросите преподавателя создать новое занятие.</p><a className="link-text" href="/">На главную</a></div></Frame>;
    if (!data)
        return <Frame><div className="panel page-card stack">{error ? <><h1>Не удалось открыть занятие</h1><p role="alert" className="error">{error}</p><Button className="secondary" variant="outline" onClick={refresh}>Повторить</Button></> : <><p>Загружаем занятие…</p><Skeleton className="h-10 w-3/4"/><Skeleton className="h-60 w-full"/></>}</div></Frame>;
    const common = <>{error && <p className="error" role="alert">{error}{kind === 'attempt' && <Button variant="outline" className="secondary" onClick={refresh}>Обновить состояние</Button>}</p>}{photoError && <div className="error" role="alert">{photoError}<Button variant="outline" className="secondary" onClick={() => { setData(null); void refresh(); }}>Повторить загрузку фото</Button></div>}</>;
    if (kind === 'room')
        return <Frame><div className="panel page-card stack"><p className="eyebrow">ГОТОВЫ К ПРАКТИКЕ?</p><h1>{data.title}</h1><div className="row"><span className="start-number">{data.count}</span><span className="muted">задач в занятии<br />в случайном порядке</span></div><ol className="start-rules"><li>После старта начнётся общий таймер.</li><li>Решайте задачи по одной и вводите короткий ответ.</li><li>Ответьте на все задачи, чтобы увидеть результат.</li></ol><p className="notice">Таймер продолжает идти при обновлении, сворачивании и потере сети. Возвращайтесь в эту вкладку, чтобы продолжить.</p><p className="time-note">Время фиксируется сервером: от получения «Старт» до получения последнего ответа. Следующая задача начинается при принятии предыдущего ответа. Сетевые задержки входят во время; фотографии загружаются заранее. Если ответ уже принят, его безопасный повтор не меняет время.</p>{common}<Button className="primary" disabled={busy || !loaded} onClick={start}>{busy ? 'Запускаем…' : loaded ? 'Старт' : 'Загружаем фотографии…'}<ArrowRight size={20}/></Button><p className="small muted">Доступ до {date(data.expiresAt)}. До 120 попыток на комнату.</p></div></Frame>;
    if (kind === 'teacher' && !reportId)
        return <Frame><div className="stack"><div><p className="eyebrow">КАБИНЕТ ПРЕПОДАВАТЕЛЯ</p><h1>{data.title}</h1><p className="muted">{data.count} задач · доступ до {date(data.expiresAt)}</p></div><div className="panel page-card stack"><Share title="Ссылка для ученика" value={`${origin}/room/${id}`}/><Share title="Секретная ссылка преподавателя" value={`${origin}/teacher/${id}#${key}`} secret/></div><div className="row spread"><h2>Попытки · {data.attempts?.length || 0} / 120</h2><Button variant="outline" className="secondary" onClick={refresh}><RotateCw size={17}/> Обновить</Button></div>{common}<div className="panel page-card stack">{!data.attempts?.length ? <p className="empty-message">Здесь появятся попытки учеников.<br />Список обновляется каждые 15 секунд.</p> : data.attempts.map(t => <a className="attempt-link" href={`/teacher/${id}/attempt/${t.id}#${key}`} key={t.id}><div><b>Попытка № {t.number}</b><small>{date(t.startedAt)}</small></div><span className="small">{t.finishedAt ? 'Открыть отчёт' : `Решает · ${t.position} из ${data.count}`} →</span></a>)}</div></div></Frame>;
    if (a?.finishedAt !== null && a?.report)
        return <Frame><div className="stack">{reportId && <a className="link-text row" href={`/teacher/${id}#${key}`}><ArrowLeft size={16}/>Все попытки</a>}{common}<Report data={a} photos={photos}/>{!reportId && <Button variant="outline" className="secondary" onClick={() => { writeLocal(`start:${a.roomId}`, null); router.push(`/room/${a.roomId}`); }}>Решить ещё раз</Button>}<p className="small muted">Отчёт доступен до {date(data.expiresAt)}.</p></div></Frame>;
    if (reportId)
        return <Frame><div className="panel page-card stack"><h1>Ученик решает задачи</h1><p>Пройдено {a?.position} из {data.count}. Отчёт появится после завершения.</p>{common}<Button variant="outline" className="secondary" onClick={refresh}>Обновить</Button><a className="link-text" href={`/teacher/${id}#${key}`}>Все попытки</a></div></Frame>;
    if (!a || !a.tasks[a.position])
        return <Frame><p className="error">Страница не найдена.</p></Frame>;
    const task = a.tasks[a.position];
    return <Frame><div className="panel page-card"><div className="row spread"><div><p className="eyebrow">{a.title}</p><h2 style={{ marginTop: 8 }}>Задача {a.position + 1} из {a.count}</h2></div><div className="row"><Timer size={21}/><span className="timer" aria-label="Общий таймер">{duration(now - a.startedAt, false)}</span></div></div><div className="progress-area"><Progress value={a.position / a.count * 100} aria-label="Прогресс попытки"/></div>{photos[task.id] ? <Photo src={photos[task.id]} label={`Задача ${a.position + 1}`}/> : <Skeleton className="h-64 w-full"/>}<form className="answer-form" onSubmit={e => { e.preventDefault(); void submit(); }}><Input ref={input} className="text-input" aria-label="Ваш ответ" placeholder="Ваш ответ" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="text" enterKeyHint="send" maxLength={200} value={answer} disabled={busy || pending || !photos[task.id]} onChange={e => { setAnswer(e.target.value); writeLocal(`draft:${a.attemptId}:${a.position}`, { answer: e.target.value }); }}/><Button type="submit" className="primary" disabled={busy || !answer.trim() || !photos[task.id]}>{busy ? 'Сохраняем…' : pending ? 'Повторить отправку' : 'Ответить'}<ArrowRight size={19}/></Button></form>{common}<p className="time-note" style={{ marginTop: 18 }}>Enter — отправить ответ. Проверка и правильные ответы появятся в конце. Время продолжает идти, даже если закрыть экран.</p></div></Frame>;
}
