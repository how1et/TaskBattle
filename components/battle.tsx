"use client";
import {useSolver} from '@/components/use-solver';
import {Frame, Photo, Share, Report} from "@/components/quest-presentation";
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, RotateCw, ArrowLeft, Hourglass, Swords, ScrollText, Gem, Camera, ImagePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api, date, duration, newKey, readLocal, writeLocal, loadPhoto, type RoomData, type AttemptData } from '@/lib/client';
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
    const [starting, setBusy] = useState(false);
    const [photos, setPhotos] = useState<Record<string, string>>({});
    const [photoError, setPhotoError] = useState('');
    const [now, setNow] = useState(Date.now());
    const [offset, setOffset] = useState(0);
    const lock = useRef(false);
    const input = useRef<HTMLInputElement>(null);
    const latest = useRef(data);
    latest.current = data;
    const a = (kind === 'attempt' || reportId) ? data as AttemptData | null : null;
    const position = a?.position;
    const solver=useSolver(kind==='attempt'?a:null,key,!!a&&!!photos[a.tasks[a.position]?.id],accept,onError);
    const busy=starting||solver.busy,answer=solver.answer,pending=solver.pending;
    useEffect(() => { if (a?.finishedAt) window.scrollTo({top:0,behavior:'auto'}); }, [a?.finishedAt]);
    function onError(e: unknown) { if (e instanceof Error && 'status' in e && e.status === 410)
        setExpired(true); setError(e instanceof Error ? e.message : 'Не удалось открыть занятие. Попробуйте ещё раз.'); }
    function accept(d: RoomData | AttemptData) { const old=latest.current as AttemptData|null;if('attemptId' in d&&old?.attemptId===d.attemptId&&old.position>d.position)return;d.clockOffset??=old?.clockOffset??(d.serverNow-Date.now());setData(d); setOffset(d.clockOffset); setNow(d.serverNow); setError(''); }
    async function refresh() { try {
        const path = kind === 'room' ? `/rooms/${id}` : kind === 'teacher' && !reportId ? `/rooms/${id}/teacher` : `/attempts/${reportId || id}${reportId ? '/report' : ''}`;
        accept(await api(path, key, kind === 'teacher'));
    }
    catch (e) {
        onError(e);
    } }
    useEffect(() => { setKey(location.hash.slice(1)); setOrigin(location.origin); setData(null); setPhotos({}); setExpired(false); setError(''); }, [id, kind, reportId]);
    useEffect(() => { if (kind === 'room' || key)
        void refresh();
    else if (origin)
        setError('Откройте полную секретную ссылку. Возможно, при копировании потерялась её часть.'); }, [id, kind, key, reportId, origin]);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now() + offset), 200); return () => clearInterval(timer); }, [offset]);
    useEffect(() => { if (data && now >= data.expiresAt) {
        setExpired(true);
        setPhotos({});
    } }, [now, data?.expiresAt]);
    useEffect(()=>{if(!data||kind==='room')return;let cancelled=false;setPhotoError('');
        const active=kind==='attempt'&&a?.finishedAt===null;
        const tasks=active?data.tasks.slice(a.position,a.position+3):data.tasks;
        const items=tasks.map(t=>({id:t.id,path:t.photo}));
        if(a?.report)for(const t of a.report)if(t.solutionPhoto)items.push({id:'solution:'+t.id,path:t.solutionPhoto});
        Promise.all(items.map(async t=>{const src=await loadPhoto(t.path,data.expiresAt,key,kind==='teacher');if(!cancelled)setPhotos(p=>({...p,[t.id]:src}));})).catch(e=>{if(!cancelled){setPhotoError(e.message);if(e.status===410){setExpired(true);setError(e.message);}}});return()=>{cancelled=true;};
    },[data?.roomId,a?.position,a?.finishedAt,key]);
    useEffect(() => { if (kind === 'teacher' && !reportId && key) {
        const interval = setInterval(() => { if (document.visibilityState === 'visible')
            void refresh(); }, 15000);
        return () => clearInterval(interval);
    } }, [kind, id, key, reportId]);
    useEffect(()=>{if(kind==='attempt'&&!busy&&!solver.preparing&&a?.finishedAt===null&&photos[a.tasks[a.position]?.id])input.current?.focus();},[position,busy,solver.preparing,photos[a?.tasks[a.position]?.id||'']]);
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
    useEffect(() => { const ctx = (document as any).modelContext; if (!ctx?.registerTool || kind !== 'attempt')
        return; const lifecycle = new AbortController(); try {
        Promise.resolve(ctx.registerTool({ name: 'taskbattle_get_progress', title: 'Текущая попытка', description: 'Прочитать номер текущей задачи, прогресс и состояние текущей попытки TaskBattle. Без правильных ответов до завершения.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute(input: unknown) { if (!input || typeof input !== 'object' || Object.keys(input).length)
                throw new Error('Ожидается пустой объект'); const d = latest.current as AttemptData | null; return d ? { position: d.position, count: d.count, finished: d.finishedAt !== null } : null; } }, { signal: lifecycle.signal })).catch(() => { });
    }
    catch { } return () => lifecycle.abort(); }, [kind, id]);
    if (expired) return <Frame><div className="panel state-card stack"><Hourglass size={38}/><h1>{error.includes('Срок хранения')||a?.finishedAt!=null||data?.roomClosed?'Срок хранения результата истёк':'Срок действия комнаты истёк'}</h1><p className="muted">Попросите преподавателя создать новое занятие.</p><a className="link-text" href="/">На главную</a></div></Frame>;
    if (!data) return <Frame><div className="panel state-card stack">{error?<><ScrollText size={34}/><h1>Не удалось открыть занятие</h1><p role="alert" className="error">{error}</p><Button className="secondary" variant="outline" onClick={refresh}>Повторить</Button></>:<><p role="status">Загружаем занятие…</p><Skeleton className="h-10 w-3/4"/><Skeleton className="h-60 w-full"/></>}</div></Frame>;
    const common=<>{error&&<div className="error" role="alert">{error}{kind==='attempt'&&<Button variant="outline" className="secondary" onClick={refresh}>Продолжить</Button>}</div>}{photoError&&<div className="error" role="alert">{photoError}<Button variant="outline" className="secondary" onClick={()=>{setData(null);void refresh();}}>Повторить загрузку фото</Button></div>}</>;
    if (kind==='room') return <Frame><section className="start-scene" aria-label="Начать испытание">
        <div className="start-title"><p className="eyebrow">ТВОЁ ИСПЫТАНИЕ</p><h1>{data.title}</h1></div>
        <div className="guide-portrait"><img className="character-art" src="/images/adventure-guide.webp" width="640" height="640" alt="Искатель приключений приглашает начать испытание" fetchPriority="high"/></div>
        <div className="start-invitation"><p className="guide-line">Пора в путь.<br/><span>Все задачи тебе по силам!</span></p>
            <div className="start-count"><span className="start-number">{data.count}</span><span>{data.count%10===1&&data.count!==11?'задача':data.count%10>=2&&data.count%10<=4&&(data.count<10||data.count>20)?'задачи':'задач'}</span></div>
            {common}<Button className="primary start-button" disabled={busy} onClick={start}><Swords size={25}/>{busy?'Готовим задачи…':'Старт'}</Button>
        </div>
        <p className="start-expiry">Доступ до {date(data.expiresAt)}</p>
    </section></Frame>;
    if(kind==='teacher'&&!reportId) return <Frame><div className="stack">
        <div className="teacher-heading"><img src="/images/quest-emblem.webp" width="75" height="85" alt=""/><div><p className="eyebrow"><Check size={14}/>КОМНАТА ГОТОВА</p><h1>{data.title}</h1><p className="teacher-meta">Задач: {data.count}<span aria-hidden="true">·</span>{data.roomClosed?'Комната закрыта':'Доступ до '+date(data.roomExpiresAt||data.expiresAt)}</p></div></div>
        <div className="copy-grid">{!data.roomClosed&&<Share title="Ссылка для ученика" value={origin+'/room/'+id}/>}<Share title="Секретная ссылка преподавателя" value={origin+'/teacher/'+id+'#'+key} secret/></div>
        <div className="row spread"><h2>Попытки <span className="muted small">{data.attempts?.length||0} / 120</span></h2><Button variant="outline" className="secondary" onClick={refresh}><RotateCw size={17}/>Обновить</Button></div>
        {common}<div className="panel page-card stack">{!data.attempts?.length?<div className="empty-message"><img src="/images/spellbook.webp" width="78" height="78" alt=""/><strong>Всё готово к первому испытанию</strong><p className="small">Здесь появятся попытки учеников.</p></div>:data.attempts.map(t=><a className="attempt-link" href={'/teacher/'+id+'/attempt/'+t.id+'#'+key} key={t.id}><div><b>Попытка № {t.number}</b><small>{date(t.startedAt)}</small></div><span className="small row">{t.finishedAt?'Открыть отчёт':'Решает · '+t.position+' из '+data.count}<ArrowRight size={16}/></span></a>)}</div>
    </div></Frame>;
    if(a?.finishedAt!==null&&a?.report) return <Frame><div className="stack">{reportId&&<a className="link-text row" href={'/teacher/'+id+'#'+key}><ArrowLeft size={16}/>Все попытки</a>}{common}<Report data={a} photos={photos}/>{!reportId&&now<(a.roomExpiresAt||0)&&<Button variant="outline" className="secondary" onClick={()=>{writeLocal('start:'+a.roomId,null);router.push('/room/'+a.roomId);}}><Swords size={19}/>Решить ещё раз</Button>}<p className="small muted">Отчёт доступен до {date(data.expiresAt)}.</p></div></Frame>;
    if(reportId) return <Frame><div className="panel state-card stack"><Hourglass size={36}/><h1>Испытание продолжается</h1><p className="muted">Решено {a?.position} из {data.count} задач. Отчёт появится после завершения.</p>{common}<Button variant="outline" className="secondary" onClick={refresh}>Обновить</Button><a className="link-text" href={'/teacher/'+id+'#'+key}>Все попытки</a></div></Frame>;
    if(!a||!a.tasks[a.position]) return <Frame><div className="panel state-card stack"><h1>Страница не найдена</h1><p className="muted">Проверьте ссылку на занятие.</p><a className="link-text" href="/">На главную</a></div></Frame>;
    const task=a.tasks[a.position];
    return <Frame focus><div className="panel page-card solve-card">
        <div className="row spread solve-heading"><div><p className="eyebrow">{a.title}</p><h2>Задача {a.position+1} из {a.count}</h2></div><div className="timer-box"><Hourglass size={23}/><div><small>Общее время</small><span className="timer" aria-label="Общий таймер">{duration(a.completedMs+solver.elapsed)}</span></div></div></div>
        <div className="progress-area"><Progress className="progress-line" value={a.position/a.count*100} aria-label="Прогресс попытки"/><div className="rune-track" aria-hidden="true">{a.tasks.map((t,i)=><span key={t.id} className={'rune '+(i<a.position?'complete':i===a.position?'current':'')}>{i<a.position?<Check size={13}/>:i===a.position?<Gem size={15}/>:i+1}</span>)}</div></div>
        {photos[task.id]?<Photo src={photos[task.id]} label={'Задача '+(a.position+1)}/>:<Skeleton className="h-64 w-full"/>}
        <div className="solution-attachment">
            {solver.preview&&<div className="solution-preview"><img src={solver.preview} alt="Фото вашего решения"/><span>Фото решения</span><Button type="button" variant="ghost" className="icon-button" aria-label="Удалить фото решения" disabled={busy||pending||solver.photoBusy} onClick={()=>void solver.selectPhoto(null)}><Trash2 size={18}/></Button></div>}
            <div className="solution-actions">
                <label className={'photo-choice '+(busy||pending?'disabled':'')}><ImagePlus size={18}/>{solver.preview?'Заменить фото':'Добавить фото решения'}<input type="file" accept="image/*" aria-label={solver.preview?'Заменить фото решения':'Добавить фото решения'} disabled={busy||pending||solver.photoBusy||solver.preparing} onChange={e=>{const f=e.target.files?.[0];if(f)void solver.selectPhoto(f);e.target.value='';}}/></label>
                <label className={'photo-choice '+(busy||pending?'disabled':'')}><Camera size={18}/>Камера<input type="file" accept="image/*" capture="environment" aria-label="Снять фото решения камерой" disabled={busy||pending||solver.photoBusy||solver.preparing} onChange={e=>{const f=e.target.files?.[0];if(f)void solver.selectPhoto(f);e.target.value='';}}/></label>
            </div><span className="small muted">Необязательно · JPEG, PNG, WebP · до 3 МБ и 40 Мп</span>{solver.photoBusy&&<p role="status">Готовим фото…</p>}
        </div>
        <form className="answer-form" onSubmit={e=>{e.preventDefault();void solver.submit();}}>
            <Input ref={input} className="text-input" aria-label="Ваш ответ" placeholder="Ваш ответ" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="text" enterKeyHint="send" maxLength={200} value={answer} disabled={busy||pending||solver.preparing||!photos[task.id]} onChange={e=>solver.changeAnswer(e.target.value)}/>
            <Button type="submit" className="primary" disabled={busy||solver.photoBusy||solver.preparing||!answer.trim()||!photos[task.id]}>{busy?(solver.preview?'Загружаем фото…':'Сохраняем ответ…'):pending?'Повторить':'Ответить'}<ArrowRight size={19}/></Button>
        </form>{common}
    </div></Frame>;
}
