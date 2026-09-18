"use client";
import { SiteHeader } from "@/components/site-header";
import { useEffect, useRef, useState } from "react";
import { uploadRoom, recoverRoom, UploadError } from "@/lib/room-upload";
import { readLocal, writeLocal } from "@/lib/client";
import { Trash2, ArrowRight, Hourglass, ShieldCheck, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
type Draft = {
    file: File;
    url: string;
    answer: string;
    id: string;
};
export default function Home() {
    const [title, setTitle] = useState("");
    const [tasks, setTasks] = useState<Draft[]>([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState("");
    const [recovering, setRecovering] = useState(false);
    const leaving = useRef(false);
    const creation = useRef<{
        id: string;
        key: string;
    } | null>(null);
    const lock = useRef(false);
    function resetCreation() { creation.current = null; writeLocal('pending-room', null); setRecovering(false); }
    function openRoom(out: {roomId: string; teacherKey: string}) {
        leaving.current = true; writeLocal('pending-room', null);
        location.href = `/teacher/${out.roomId}#${out.teacherKey}`;
    }
    async function checkPending() {
        const pending = readLocal<{id: string; key: string}>('pending-room');
        if (!pending || lock.current) return;
        lock.current = true; setBusy(true); setError(''); setProgress('Проверяем предыдущее создание…');
        try {
            const out = await recoverRoom(pending.id, pending.key);
            if (out) { openRoom(out); return; }
            resetCreation(); setRecovering(false);
            setError('Предыдущее создание не завершилось. Добавьте фотографии и ответы ещё раз.');
        } catch (e) {
            if (e instanceof UploadError && e.status === 410) { resetCreation(); setRecovering(false); setError(e.message); }
            else { setRecovering(true); setError('Не удалось проверить предыдущее создание. Нажмите «Проверить создание», когда восстановится связь.'); }
        } finally { lock.current = false; setBusy(false); setProgress(''); }
    }
    useEffect(() => { void checkPending(); }, []);
    useEffect(() => {
        if (!tasks.length) return;
        const warn = (event: BeforeUnloadEvent) => { if (!leaving.current) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [tasks.length]);
    function add(files: FileList | null) { if (!files)
        return; setError(""); const list = Array.from(files); if (tasks.length + list.length > 25) {
        setError("Можно добавить не больше 25 задач.");
        return;
    } if (list.some(f => !["image/jpeg", "image/png", "image/webp"].includes(f.type))) {
        setError("Поддерживаются только JPEG, PNG и WebP. HEIC и PDF сначала преобразуйте в изображение.");
        return;
    } if (list.some(f => f.size > 3 * 1024 * 1024) || [...tasks.map(t => t.file), ...list].reduce((s, f) => s + f.size, 0) > 18 * 1024 * 1024) {
        setError("Не больше 3 МБ на фотографию и 18 МБ на комнату.");
        return;
    } resetCreation(); setTasks(t => [...t, ...list.map(file => ({ file, url: URL.createObjectURL(file), answer: "", id: crypto.randomUUID() }))]); }
    async function create() { if (lock.current)
        return; lock.current = true; setBusy(true); setError(""); try {
        creation.current ??= { id: crypto.randomUUID(), key: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '') };
        writeLocal('pending-room', creation.current);
        const data = new FormData();
        data.set("requestId", creation.current.id);
        data.set("teacherKey", creation.current.key);
        data.set("title", title);
        data.set("answers", JSON.stringify(tasks.map(t => t.answer)));
        tasks.forEach(t => data.append("photos", t.file));
        const out = await uploadRoom(data, setProgress);
        openRoom(out);
    }
    catch (e) {
        setError(e instanceof UploadError ? e.message : "Не удалось создать комнату. Фотографии и ответы остались в форме — повторите создание.");
    }
    finally {
        setBusy(false);
        setProgress("");
        lock.current = false;
    } }

    return <>
        <SiteHeader/>
        <main className="workspace creator-workspace">
            <div className="page-heading">
                <div><p className="eyebrow">ПРЕПОДАВАТЕЛЮ</p><h1>Подготовка комнаты</h1></div>
                <div className="duration-tag"><Hourglass size={21}/><span>Комната на <b>48 часов</b></span></div>
            </div>
            <div className="creator-grid">
                <section className="panel editor" aria-label="Подготовка занятия">
                    <div className="section-title"><span className="step">01</span><h2>Название занятия</h2><span className="muted small">необязательно</span></div>
                    <Input className="text-input" aria-label="Название занятия" placeholder="Например, квадратные уравнения" maxLength={100} value={title} onChange={e => { resetCreation(); setTitle(e.target.value); }} disabled={busy}/>
                    <div className="section-title task-title"><span className="step">02</span><h2>Задачи</h2><span className="counter">{tasks.length} / 25</span></div>
                    <label className={'upload-area ' + (busy ? 'disabled' : '')} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) add(e.dataTransfer.files); }}>
                        <input aria-label="Загрузить фотографии задач" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={e => { add(e.target.files); e.target.value = ""; }}/>
                        <img className="upload-book" src="/images/spellbook.webp" width="112" height="112" alt=""/>
                        <div className="upload-copy"><strong>Добавить задачи</strong><span>Выберите фотографии или перетащите сюда</span><small>JPEG, PNG, WebP · до 3 МБ и 40 Мп на файл<br/>До 25 задач и 18 МБ на комнату</small></div>
                    </label>
                    {tasks.length > 0 && <div className="draft-list">{tasks.map((task, i) => <div className="draft-task" key={task.id}>
                        <div className="draft-photo"><img src={task.url} alt={'Задача ' + (i + 1)}/><span>{String(i+1).padStart(2,'0')}</span></div>
                        <div className="draft-fields"><label htmlFor={task.id}>Задача {i+1} · правильный ответ</label><Input id={task.id} className="text-input" placeholder="Короткий ответ" maxLength={200} value={task.answer} disabled={busy} onChange={e => { resetCreation(); setTasks(ts => ts.map(t => t.id===task.id ? {...t,answer:e.target.value} : t)); }}/></div>
                        <Button type="button" variant="ghost" className="icon-button" aria-label={'Удалить задачу ' + (i + 1)} disabled={busy} onClick={() => { resetCreation(); URL.revokeObjectURL(task.url); setTasks(ts => ts.filter(t => t.id !== task.id)); }}><Trash2 size={19}/></Button>
                    </div>)}</div>}
                    {progress && <p role="status" className="notice">{progress}</p>}
                    {error && <p role="alert" className="error">{error}</p>}
                    {recovering && <Button className="secondary" disabled={busy} onClick={checkPending}>Проверить создание</Button>}
                    <div className="create-footer">
                        <span className="muted small row"><Check size={16}/>{tasks.length ? 'Ответы: ' + tasks.filter(t => t.answer.trim()).length + ' из ' + tasks.length : 'Одна фотография — одна задача'}</span>
                        <Button className="primary" disabled={busy || !tasks.length || tasks.some(t => !t.answer.trim())} onClick={create}>{busy ? 'Создаём комнату…' : error && creation.current ? 'Повторить создание' : 'Создать комнату'}<ArrowRight size={19}/></Button>
                    </div>
                </section>
                <aside className="sidebar">
                    <div className="adventure-card">
                        <img src="/images/quest-landscape.webp" className="adventure-landscape" width="768" height="512" alt="Замок над озером в ночных горах"/>
                    </div>
                    <div className="rules-card"><h3><ShieldCheck size={20}/>Правила проверки</h3><p>Пробелы по краям и регистр не важны. 5, 5.0 и 5,00 — один ответ; − и - равнозначны.</p><p>Выражения сравниваются буквально: 1/2 и 0.5 — разные ответы.</p></div>
                    <p className="room-lifetime"><Hourglass size={18}/>Комната — 48 часов. Отчёт — 72 часа после завершения.</p>
                </aside>
            </div>
        </main>
        <footer className="footer"><span>TaskBattle</span><span>Задачи на время</span></footer>
    </>;
}
