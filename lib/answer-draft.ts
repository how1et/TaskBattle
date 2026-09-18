import {inspectImage} from './image-file';
export type Activation = { readyId:string; startedAt:number; wallStartedAt:number };
export type AnswerPayload = {requestId:string;taskId:string;position:number;answer:string;durationMs:number;readyId:string};
export type AnswerDraft = {id:string;position:number;answer:string;photo:File|null;activation?:Activation;payload?:AnswerPayload};
let database:Promise<IDBDatabase>|undefined;
function open(){return database??=new Promise((resolve,reject)=>{const req=indexedDB.open('taskbattle-answers',1);req.onupgradeneeded=()=>req.result.createObjectStore('drafts',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(new Error('Не удалось подготовить ответ. Разрешите данные сайта и повторите.'));});}
let queue=Promise.resolve();
export async function readDraft(id:string):Promise<AnswerDraft|undefined>{const db=await open();return new Promise((resolve,reject)=>{const req=db.transaction('drafts','readonly').objectStore('drafts').get(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
export function saveDraft(draft:AnswerDraft){const run=queue.catch(()=>{}).then(async()=>{const db=await open();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(draft);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error('Не удалось сохранить ответ. Освободите место на устройстве и повторите.'));tx.onabort=tx.onerror;});});queue=run;return run;}
export async function removeDraft(id:string){await queue.catch(()=>{});const db=await open();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
export async function sendAnswer(attemptId:string,key:string,draft:AnswerDraft){
    const form=new FormData();form.set('payload',JSON.stringify(draft.payload));if(draft.photo)form.set('solution',draft.photo,draft.photo.name||'solution.jpg');
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),120000);
    try{const r=await fetch('/api/attempts/'+attemptId+'/answers',{method:'POST',headers:{'x-attempt-key':key},body:form,signal:controller.signal});const data=await r.json() as any;if(!r.ok){const e=new Error(data.error||'Не удалось отправить ответ. Повторите.') as Error&{status:number};e.status=r.status;throw e;}return data;}
    catch(e){if(e instanceof Error&&'status' in e)throw e;throw new Error('Не удалось отправить ответ. Проверьте связь и нажмите «Повторить».');}
    finally{clearTimeout(timeout);}
}
export async function checkSolutionPhoto(file:File){
    if(!file.size||file.size>3*1024*1024)throw new Error('Фото решения — до 3 МБ. Выберите другой файл.');
    const type=inspectImage(new Uint8Array(await file.arrayBuffer()))?.mime;
    if(!type||type!==file.type||!/\.(jpe?g|png|webp)$/i.test(file.name))throw new Error('Нужна фотография JPEG, PNG или WebP до 40 Мп. HEIC/HEIF сначала сохраните как JPEG.');
    const url=URL.createObjectURL(file),img=new Image();img.src=url;
    try{await img.decode();if(!img.naturalWidth||img.naturalWidth*img.naturalHeight>40000000)throw Error();}catch{throw new Error('Фотография не открывается или слишком большая. Выберите другую.');}finally{URL.revokeObjectURL(url);}
}
