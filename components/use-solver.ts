"use client";
import {useEffect,useRef,useState} from 'react';
import {api,type AttemptData} from '@/lib/client';
import {readDraft,saveDraft,removeDraft} from '@/lib/answer-draft';
import {prepareSolutionPhoto} from '@/lib/solution-photo';
import {sendAnswer} from '@/lib/answer-upload';
import {SolverMachine,type SolverState} from '@/lib/solver-machine';
const initial:SolverState={draft:null,phase:'loading',photoBusy:false,error:'',warning:''};
export function useSolver(a:AttemptData|null,key:string,photoReady:boolean,accept:(data:AttemptData)=>void,onError:(e:unknown)=>void){
    const [state,setState]=useState(initial),[time,setTime]=useState(0),[preview,setPreview]=useState('');
    const machine=useRef<SolverMachine|null>(null),callbacks=useRef({accept,onError});callbacks.current={accept,onError};
    const id=a?`answer:${a.attemptId}:${a.position}`:'';
    useEffect(()=>{
        setState(initial);setTime(0);if(!a||a.finishedAt!==null){machine.current=null;return;}
        const m=new SolverMachine(a,{read:readDraft,save:saveDraft,remove:removeDraft,prepare:prepareSolutionPhoto,
            ready:(v,d)=>api(`/attempts/${v.attemptId}/ready`,key,false,{position:d.position,taskId:v.tasks[d.position].id,readyId:d.activation!.readyId,startedAt:d.activation!.startedAt}),
            check:v=>api(`/attempts/${v.attemptId}`,key),
            cancel:(v,d)=>api(`/attempts/${v.attemptId}/cancel-answer`,key,false,{requestId:d.payload!.requestId,position:d.position,taskId:d.payload!.taskId}),
            send:(v,d)=>sendAnswer(v.attemptId,key,d),accept:out=>callbacks.current.accept(out),fatal:e=>callbacks.current.onError(e),
            changed:s=>{setState(s);setTime(m.time);},wall:Date.now,mono:()=>performance.now(),uuid:()=>crypto.randomUUID()});
        machine.current=m;void m.init();for(let i=0;i<a.position;i++)void removeDraft(`answer:${a.attemptId}:${i}`);
        return()=>m.dispose();
    },[id,a?.finishedAt,key]);
    useEffect(()=>{if(a&&machine.current)machine.current.server={...a,clockOffset:a.clockOffset??machine.current.server.clockOffset};},[a]);
    useEffect(()=>{if(!photoReady||!state.draft||state.draft.id!==id||state.phase!=='editing')return;let second=0;const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{void machine.current?.show();});});return()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);};},[id,photoReady,!!state.draft]);
    useEffect(()=>{const tick=()=>setTime(machine.current?.time||0);const timer=setInterval(tick,100);document.addEventListener('visibilitychange',tick);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick);};},[]);
    useEffect(()=>{if(!state.draft?.photo){setPreview('');return;}const url=URL.createObjectURL(state.draft.photo);setPreview(url);return()=>URL.revokeObjectURL(url);},[state.draft?.photo]);
    return {answer:state.draft?.id===id?state.draft.answer:'',preview,pending:!!state.draft?.payload,busy:state.phase==='sending'||state.phase==='recovering',recovering:state.phase==='recovering',photoBusy:state.photoBusy,elapsed:state.draft?.id===id?time:0,preparing:state.draft?.id!==id||!state.draft?.activation,error:state.error,warning:state.warning,missingPhoto:!!state.draft?.photoExpected&&!state.draft?.photo,
        changeAnswer:(answer:string)=>machine.current?.changeAnswer(answer),selectPhoto:(file:File|null)=>machine.current?.selectPhoto(file),submit:()=>machine.current?.submit(),edit:()=>machine.current?.edit(),withoutPhoto:()=>machine.current?.withoutPhoto()};
}
