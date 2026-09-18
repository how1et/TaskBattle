"use client";
import {useEffect,useRef,useState} from 'react';
import {api,type AttemptData} from '@/lib/client';
import {elapsed,type ClockAnchor} from '@/lib/time';
import {readDraft,saveDraft,removeDraft,sendAnswer,checkSolutionPhoto,type AnswerDraft} from '@/lib/answer-draft';

export function useSolver(a:AttemptData|null,key:string,photoReady:boolean,accept:(data:AttemptData)=>void,onError:(e:unknown)=>void){
    const [draft,setDraft]=useState<AnswerDraft|null>(null),[busy,setBusy]=useState(false),[photoBusy,setPhotoBusy]=useState(false),[time,setTime]=useState(0),[preview,setPreview]=useState('');
    const record=useRef<AnswerDraft|null>(null),clock=useRef<ClockAnchor|null>(null),locked=useRef(false),registration=useRef<Promise<AttemptData>|null>(null),current=useRef(a),callbacks=useRef({accept,onError});current.current=a;callbacks.current={accept,onError};
    const id=a?`answer:${a.attemptId}:${a.position}`:'';
    function update(d:AnswerDraft){record.current=d;setDraft(d);return saveDraft(d);}
    function anchor(ms:number){clock.current={elapsed:ms,wall:Date.now(),mono:performance.now()};setTime(ms);}
    useEffect(()=>{let cancelled=false;record.current=null;clock.current=null;registration.current=null;setDraft(null);setTime(0);locked.current=false;setBusy(false);
        if(!a)return;
        for(let i=0;i<a.position;i++)void removeDraft(`answer:${a.attemptId}:${i}`).catch(()=>{});
        if(a.finishedAt!==null)return;
        readDraft(id).then(saved=>{if(cancelled)return;const d=saved||{id,position:a.position,answer:'',photo:null};record.current=d;setDraft(d);
            if(d.payload){setTime(d.payload.durationMs);return;}
            if(a.taskStartedAt!==null){
                const same=d.activation?.readyId===a.readyId;
                const ms=same?Math.max(0,Date.now()-d.activation!.wallStartedAt):Math.max(0,Date.now()+(a.clockOffset||0)-a.taskStartedAt);
                anchor(ms);if(!same){d.activation={readyId:a.readyId!,startedAt:a.taskStartedAt,wallStartedAt:Date.now()-ms};void update({...d}).catch(callbacks.current.onError);}
            }else if(d.activation)anchor(Math.max(0,Date.now()-d.activation.wallStartedAt));
        }).catch(callbacks.current.onError);return()=>{cancelled=true;};
    },[id,a?.finishedAt]);
    useEffect(()=>{if(!draft?.photo){setPreview('');return;}const url=URL.createObjectURL(draft.photo);setPreview(url);return()=>URL.revokeObjectURL(url);},[draft?.photo]);
    async function register(d:AnswerDraft){
        const value=current.current!;if(value.timingVersion===1)return value;
        if(registration.current)return registration.current;
        const act=d.activation!;
        const promise=(async()=>{
            const out=await api<AttemptData>(`/attempts/${value.attemptId}/ready`,key,false,{position:d.position,taskId:value.tasks[d.position].id,readyId:act.readyId,startedAt:act.startedAt});
            const live=record.current;
            if(out.position===d.position&&out.readyId!==act.readyId&&live?.id===d.id){
                const ms=Math.max(0,Date.now()+(out.clockOffset||0)-out.taskStartedAt!);
                const next={...live,activation:{readyId:out.readyId!,startedAt:out.taskStartedAt!,wallStartedAt:Date.now()-ms}};
                // A losing activation cannot have been accepted. Preserve its click instant
                // and typed/photo draft while adopting the first tab's canonical start.
                if(live.payload)next.payload={...live.payload,readyId:out.readyId!,durationMs:Math.max(0,live.activation!.startedAt+live.payload.durationMs-out.taskStartedAt!)};
                await update(next);
                if(next.payload){clock.current=null;setTime(next.payload.durationMs);}else anchor(ms);
            }
            callbacks.current.accept(out);return out;
        })();registration.current=promise;
        try{return await promise;}finally{if(registration.current===promise)registration.current=null;}
    }
    useEffect(()=>{const d=record.current;if(!a||a.finishedAt!==null||!photoReady||!d||d.id!==id||d.payload)return;
        let cancelled=false,frame2=0;
        const frame=requestAnimationFrame(()=>{frame2=requestAnimationFrame(()=>{if(cancelled||record.current?.payload)return;
            let next=record.current!;
            if(!next.activation){const wall=Date.now();next={...next,activation:{readyId:crypto.randomUUID(),startedAt:Math.round(wall+(a.clockOffset||0)),wallStartedAt:wall}};anchor(0);}
            void update(next).then(()=>register(next)).catch(callbacks.current.onError);
        });});return()=>{cancelled=true;cancelAnimationFrame(frame);cancelAnimationFrame(frame2);};
    },[id,photoReady,!!draft,a?.finishedAt]);
    useEffect(()=>{const tick=()=>{if(clock.current&&!record.current?.payload)setTime(elapsed(clock.current));};const timer=setInterval(tick,100);document.addEventListener('visibilitychange',tick);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick);};},[]);
    async function submit(){
        const value=current.current,d=record.current;if(locked.current||photoBusy||!value||!d||d.id!==id||!d.answer.trim()||!d.activation)return;
        locked.current=true;
        const frozen=d.payload?d:{...d,payload:{requestId:crypto.randomUUID(),position:d.position,taskId:value.tasks[d.position].id,answer:d.answer.trim(),durationMs:elapsed(clock.current!),readyId:d.activation.readyId}};
        record.current=frozen;setDraft(frozen);setTime(frozen.payload!.durationMs);clock.current=null;setBusy(true);
        try{
            await saveDraft(frozen);
            if(value.timingVersion===2&&value.readyId!==frozen.activation!.readyId){const out=await register(frozen);if(out.position!==frozen.position){await removeDraft(frozen.id);return;}}
            const reconciled=record.current;
            if(reconciled?.id!==frozen.id)return;
            const out=await sendAnswer(value.attemptId,key,reconciled);
            callbacks.current.accept(out);
            await removeDraft(frozen.id);
        }catch(e){callbacks.current.onError(e);}finally{if(record.current?.id===frozen.id){locked.current=false;setBusy(false);}}
    }
    function changeAnswer(answer:string){if(record.current&&!record.current.payload)void update({...record.current,answer}).catch(callbacks.current.onError);}
    async function selectPhoto(file:File|null){if(!record.current||record.current.payload||photoBusy)return;setPhotoBusy(true);try{if(file)await checkSolutionPhoto(file);await update({...record.current!,photo:file});}catch(e){callbacks.current.onError(e);}finally{setPhotoBusy(false);}}
    return {answer:draft?.id===id?draft.answer:'',preview,pending:!!draft?.payload,busy,photoBusy,elapsed:draft?.id===id?time:0,preparing:draft?.id!==id||!draft?.activation,changeAnswer,selectPhoto,submit};
}
