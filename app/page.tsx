"use client";
import { useRef, useState } from "react";
import { Upload, Trash2, ArrowRight, Timer, ShieldCheck, Zap } from "lucide-react";
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
    const creation = useRef<{
        id: string;
        key: string;
    } | null>(null);
    const lock = useRef(false);
    function add(files: FileList | null) { if (!files)
        return; setError(""); const list = Array.from(files); if (tasks.length + list.length > 12) {
        setError("Можно добавить не больше 12 задач.");
        return;
    } if (list.some(f => !["image/jpeg", "image/png", "image/webp"].includes(f.type))) {
        setError("Поддерживаются только JPEG, PNG и WebP. HEIC и PDF сначала преобразуйте в изображение.");
        return;
    } if (list.some(f => f.size > 3 * 1024 * 1024) || [...tasks.map(t => t.file), ...list].reduce((s, f) => s + f.size, 0) > 18 * 1024 * 1024) {
        setError("Не больше 3 МБ на фотографию и 18 МБ на комнату.");
        return;
    } creation.current = null; setTasks(t => [...t, ...list.map(file => ({ file, url: URL.createObjectURL(file), answer: "", id: crypto.randomUUID() }))]); }
    async function create() { if (lock.current)
        return; lock.current = true; setBusy(true); setError(""); try {
        creation.current ??= { id: crypto.randomUUID(), key: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '') };
        const data = new FormData();
        data.set("requestId", creation.current.id);
        data.set("teacherKey", creation.current.key);
        data.set("title", title);
        data.set("answers", JSON.stringify(tasks.map(t => t.answer)));
        tasks.forEach(t => data.append("photos", t.file));
        const r = await fetch("/api/rooms", { method: "POST", body: data });
        const out = await r.json() as {
            error?: string;
            roomId: string;
            teacherKey: string;
        };
        if (!r.ok)
            throw new Error(out.error || "Не удалось создать комнату");
        location.href = `/teacher/${out.roomId}#${out.teacherKey}`;
    }
    catch (e) {
        setError(e instanceof Error ? e.message : "Ошибка сети. Фотографии и ответы остались в форме.");
    }
    finally {
        setBusy(false);
        lock.current = false;
    } }
    return <><header className="topbar"><a className="brand" href="/"><span className="brand-icon"><Zap size={22} fill="currentColor"/></span>TaskBattle</a><span className="header-note">Задачи. Время. Результат.</span><span className="pill">Без регистрации</span></header><main className="workspace"><div className="page-heading"><div><p className="eyebrow">ДЛЯ ПРЕПОДАВАТЕЛЯ</p><h1>Новое занятие</h1><p className="muted">Ваши задачи — в одну ссылку для ученика.</p></div><div className="duration-tag"><Timer size={20}/><span>Комната на <b>48 часов</b></span></div></div><div className="creator-grid"><section className="panel editor"><div className="section-title"><span className="step">01</span><h2>Название занятия</h2><span className="muted small">необязательно</span></div><Input className="text-input" aria-label="Название занятия" placeholder="Например, квадратные уравнения" maxLength={100} value={title} onChange={e => { creation.current = null; setTitle(e.target.value); }} disabled={busy}/><div className="section-title task-title"><span className="step">02</span><h2>Фотографии задач</h2><span className="counter">{tasks.length} / 12</span></div><label className={`upload-area ${busy ? "disabled" : ""}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy)
        add(e.dataTransfer.files); }}><input aria-label="Загрузить фотографии задач" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={e => { add(e.target.files); e.target.value = ""; }}/><span className="upload-icon"><Upload size={25}/></span><strong>Добавить фотографии</strong><span>Выберите файлы или перетащите сюда</span><small>JPEG, PNG, WebP · до 3 МБ каждый · до 18 МБ всего</small></label>{tasks.length > 0 && <div className="draft-list">{tasks.map((task, i) => <div className="draft-task" key={task.id}><img src={task.url} alt={`Задача ${i + 1}`}/><div className="draft-fields"><label htmlFor={task.id}>Задача {i + 1} · правильный ответ</label><Input id={task.id} className="text-input" placeholder="Введите короткий ответ" maxLength={200} value={task.answer} disabled={busy} onChange={e => { creation.current = null; setTasks(ts => ts.map(t => t.id === task.id ? { ...t, answer: e.target.value } : t)); }}/></div><Button type="button" variant="ghost" className="icon-button" aria-label={`Удалить задачу ${i + 1}`} disabled={busy} onClick={() => { creation.current = null; URL.revokeObjectURL(task.url); setTasks(ts => ts.filter(t => t.id !== task.id)); }}><Trash2 size={19}/></Button></div>)}</div>}{error && <p role="alert" className="error">{error}</p>}<div className="create-footer"><span className="muted small">Одна фотография — одна задача.<br />Укажите ответ для каждой.</span><Button className="primary" disabled={busy || !tasks.length || tasks.some(t => !t.answer.trim())} onClick={create}>{busy ? "Создаём комнату…" : "Создать комнату"}<ArrowRight size={19}/></Button></div></section><aside className="sidebar"><div className="guide-card"><span className="eyebrow">КАК ПРОХОДИТ ЗАНЯТИЕ</span><ol className="steps"><li><span>1</span><div><b>Соберите задачи</b><p>Загрузите фотографии и укажите правильные ответы.</p></div></li><li><span>2</span><div><b>Отправьте ссылку</b><p>Ученик откроет занятие на любом устройстве.</p></div></li><li><span>3</span><div><b>Посмотрите результат</b><p>Ответы, время и разбор каждой задачи — в одном отчёте.</p></div></li></ol></div><div className="rules-card"><ShieldCheck size={23}/><h3>Как проверяются ответы</h3><p>Пробелы по краям и регистр не важны. Числа 5, 5.0 и 5,00 равнозначны. Знаки − и - считаются одинаковыми.</p><p>Внутренние пробелы и выражения сравниваются буквально: 1/2 и 0.5 — разные ответы.</p></div><p className="privacy-note">Правильные ответы откроются ученику только после завершения попытки.</p></aside></div></main><footer className="footer"><span>TaskBattle</span><span>Меньше подготовки. Больше практики.</span></footer></>;
}
