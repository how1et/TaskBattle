"use client";
import {useState} from 'react';
import {Check, CircleCheck, CircleMinus, Copy, Gauge, Hourglass, LockKeyhole, Mail, Maximize2, Timer} from 'lucide-react';
import {SiteHeader} from '@/components/site-header';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose} from '@/components/ui/dialog';
import {date, duration, type AttemptData} from '@/lib/client';

export function Frame({children, focus=false}:{children:React.ReactNode;focus?:boolean}) {
    return <><SiteHeader/><main className={'workspace '+(focus?'battle-workspace':'')}><div className="content-narrow">{children}</div></main></>;
}

export function Photo({src,label,small=false}:{src:string;label:string;small?:boolean}) {
    const [zoom,setZoom]=useState(false);
    return <>
        <button className="image-button" type="button" onClick={()=>setZoom(true)} aria-label={'Увеличить: '+label}>
            <img src={src} alt={label} style={small?{height:220}:undefined}/>
            <span className="photo-caption"><Maximize2 size={14}/>Увеличить фотографию</span>
        </button>
        <Dialog open={zoom} onOpenChange={setZoom}><DialogContent className="zoom-content" showCloseButton={false}>
            <div className="row spread"><DialogTitle>{label}</DialogTitle><DialogClose asChild><Button className="secondary" variant="outline">Закрыть</Button></DialogClose></div>
            <DialogDescription>Разведите два пальца, чтобы приблизить фотографию.</DialogDescription>
            <img src={src} alt={label}/>
        </DialogContent></Dialog>
    </>;
}

export function Share({title,value,secret=false}:{title:string;value:string;secret?:boolean}) {
    const [copied,setCopied]=useState(false), [failed,setFailed]=useState(false);
    return <div className={'copy-box '+(secret?'secret-box':'')}>
        <h3 className="row">{secret?<LockKeyhole size={20}/>:<Mail size={20}/>} {title}</h3>
        <p className="muted small">{secret?'Сохраните её для просмотра результатов. Не отправляйте ученику.':'Отправьте ученику, чтобы начать занятие.'}</p>
        <Input className="text-input" readOnly aria-label={title} value={value} onFocus={e=>e.target.select()}/>
        <Button className="secondary" variant="outline" onClick={async()=>{try{await navigator.clipboard.writeText(value);setCopied(true);setFailed(false);}catch{setFailed(true);}}}>
            {copied?<Check size={18}/>:<Copy size={18}/>} {copied?'Ссылка скопирована':secret?'Скопировать секретную ссылку':'Скопировать ссылку'}
        </Button>
        {failed&&<p className="small muted">Выделите ссылку в поле и скопируйте вручную.</p>}
    </div>;
}

export function Report({data,photos}:{data:AttemptData;photos:Record<string,string>}) {
    const s=data.summary!;
    return <div className="stack">
        <section className="result-scroll" aria-label="Итоги попытки">
            <div className="result-heading"><div><p className="eyebrow">ИСПЫТАНИЕ ЗАВЕРШЕНО</p><h1>Свиток результатов</h1><p className="muted">{data.title}<br/>Начало: {date(data.startedAt)}</p></div><img src="/images/quest-emblem.webp" width="101" height="101" alt=""/></div>
            <div className="stat-grid">
                <div className="stat"><CircleCheck size={23}/><strong>{s.correct} из {s.count}</strong><span>Правильных ответов</span></div>
                <div className="stat"><Hourglass size={23}/><strong>{duration(s.totalMs)}</strong><span>Общее время</span></div>
                <div className="stat"><Timer size={23}/><strong>{duration(s.averageMs)}</strong><span>В среднем на задачу</span></div>
            </div>
            <div className="extrema"><div><Gauge size={20}/><div><strong>Быстрее всего</strong><p>№ {s.fastest.ordinals.join(', ')} · {duration(s.fastest.durationMs)}</p></div></div><div><Hourglass size={20}/><div><strong>Больше всего времени</strong><p>№ {s.slowest.ordinals.join(', ')} · {duration(s.slowest.durationMs)}</p></div></div></div>
        </section>
        <div className="report-intro"><h2>Разбор задач</h2><span className="muted small">Номера в исходном наборе</span></div>
        {data.report!.map(t=><article className="panel report-task stack" key={t.id}>
            <div className="row spread"><h3>Задача № {t.ordinal}</h3><span className={'status '+(t.correct?'correct':'wrong')}>{t.correct?<CircleCheck size={15}/>:<CircleMinus size={15}/>} {t.correct?'Верно':'Неверно'}</span></div>
            {photos[t.id]?<Photo src={photos[t.id]} label={'Задача № '+t.ordinal} small/>:<p className="muted">Загружаем фотографию…</p>}
            <dl className="answer-grid"><div><dt>Ответ ученика</dt><dd>{t.answer}</dd></div><div><dt>Правильный ответ</dt><dd>{t.correctAnswer}</dd></div><div><dt>Время решения</dt><dd>{duration(t.durationMs)}</dd></div></dl>
        </article>)}
    </div>;
}
