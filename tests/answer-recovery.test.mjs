import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import ts from 'typescript';
async function module(path){let s=await readFile(new URL(path,import.meta.url),'utf8');s=s.replace("'./time'",JSON.stringify(new URL('../lib/time.ts',import.meta.url).href));return import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText+'\n//'+crypto.randomUUID()).toString('base64'));}
const {SolverMachine}=await module('../lib/solver-machine.ts');
const photo=new File(['camera bytes'],'solution.jpg',{type:'image/jpeg'});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(overrides={}){
 let wall=100000,mono=0,sends=[],accepted=[],stored;const advance=n=>{wall+=n;mono+=n;};
 const server={attemptId:'test-attempt',position:0,count:1,timingVersion:2,readyId:null,taskStartedAt:null,finishedAt:null,completedMs:0,clockOffset:0,tasks:[{id:'task'}]};
 const io={read:async()=>({}),save:async d=>{stored=structuredClone(d);},remove:async()=>{},ready:async(a,d)=>({...a,readyId:d.activation.readyId,taskStartedAt:d.activation.startedAt}),check:async()=>({...m.server}),cancel:async()=>({cancelled:true,snapshot:{...m.server}}),send:async(a,d)=>{sends.push(structuredClone(d));return {...a,position:1,finishedAt:wall};},prepare:async f=>f,accept:a=>accepted.push(a),changed:()=>{},fatal:()=>{},wall:()=>wall,mono:()=>mono,uuid:()=>crypto.randomUUID(),...overrides};const m=new SolverMachine(server,io);
 return {m,io,advance,sends,accepted,get stored(){return stored;},async ready(){await m.init();await m.show();m.changeAnswer('5');await m.selectPhoto(photo);}};
}
test('local write/read failures never prevent camera photo submission',async()=>{
 const f=fixture({read:async()=>{throw new DOMException('Disabled','SecurityError');},save:async()=>{throw new DOMException('Full','QuotaExceededError');}});await f.ready();f.advance(4200);await f.m.submit();assert.equal(f.sends.length,1);assert.ok(f.sends[0].photo);assert.equal(f.sends[0].payload.durationMs,4200);assert.equal(f.m.state.phase,'finished');assert.ok(f.m.state.warning);
});
test('network failure freezes interval; same photo/text retry and double click are idempotent',async()=>{
 const f=fixture();await f.ready();f.advance(5000);let fail=true,pending=defer();f.io.send=async(a,d)=>{f.sends.push(structuredClone(d));if(fail){f.advance(8000);throw Error('Нет соединения');}await pending.promise;return {...a,position:1,finishedAt:1};};await f.m.submit();assert.equal(f.m.state.phase,'failed');assert.equal(f.m.time,5000);const id=f.m.state.draft.payload.requestId;f.advance(6000);fail=false;const retry=f.m.submit();await Promise.resolve();const double=f.m.submit();pending.resolve();await Promise.all([retry,double]);assert.equal(f.sends.length,2);assert.equal(f.sends[1].payload.requestId,id);assert.equal(f.sends[1].payload.durationMs,5000);assert.equal(f.m.time,5000);
});
test('editing after an error fences old request, resumes accumulated time and survives reload',async()=>{
 const f=fixture();await f.ready();f.advance(5000);f.io.send=async()=>{f.advance(8000);throw Error('failed');};await f.m.submit();let cancelled=0;f.io.cancel=async()=>{cancelled++;f.advance(3000);return {cancelled:true,snapshot:f.m.server};};assert.equal(await f.m.edit(),true);f.m.changeAnswer('6');f.advance(2000);await f.m.selectPhoto(null);assert.equal(f.m.time,7000);assert.equal(f.m.state.draft.answer,'6');assert.equal(f.m.state.draft.photo,null);assert.equal(cancelled,1);
 const d=structuredClone(f.m.state.draft);const g=fixture({read:async()=>({draft:d})});g.io.wall=()=>d.resume.wallStartedAt+4000;await g.m.init();assert.equal(g.m.time,9000);
});
test('server accepted but acknowledgement lost: retry advances without reupload or edit',async()=>{
 const f=fixture();await f.ready();let commits=0;f.io.send=async()=>{commits++;throw Error('confirmation timeout');};await f.m.submit();f.io.check=async()=>({...f.m.server,position:1,finishedAt:1});await f.m.submit();assert.equal(commits,1);assert.equal(f.m.state.phase,'finished');
 const g=fixture();await g.ready();g.io.send=async()=>{throw Error('timeout');};await g.m.submit();g.io.cancel=async()=>({cancelled:false,snapshot:{...g.m.server,position:1,finishedAt:1}});assert.equal(await g.m.edit(),false);assert.equal(g.m.state.phase,'finished');assert.equal(g.m.state.draft.answer,'5');
});
test('stale replacement cannot restore a removed photo; processing failure retains old photo',async()=>{
 const f=fixture();await f.ready();const pending=defer();f.io.prepare=()=>pending.promise;const replacement=f.m.selectPhoto(new File(['new'],'new.jpg'));await Promise.resolve();await f.m.selectPhoto(null);pending.resolve(photo);await replacement;assert.equal(f.m.state.draft.photo,null);assert.equal(f.m.state.photoBusy,false);
 f.io.prepare=async x=>x;await f.m.selectPhoto(photo);f.io.prepare=async()=>{throw Error('Не удалось обработать фото');};await f.m.selectPhoto(new File(['bad'],'bad.jpg'));assert.equal(f.m.state.draft.photo,photo);assert.equal(f.m.state.photoBusy,false);assert.equal(f.m.state.phase,'editing');
});
test('reload with frozen pending photo preserves time; missing attachment requires explicit opt-out',async()=>{
 const f=fixture();await f.ready();f.advance(3100);f.io.send=async()=>{throw Error('failed');};await f.m.submit();const draft=structuredClone(f.m.state.draft);const g=fixture({read:async()=>({draft})});await g.m.init();g.advance(20000);assert.equal(g.m.time,3100);assert.ok(g.m.state.draft.photo);await g.m.submit();assert.equal(g.sends[0].payload.durationMs,3100);
 const missing={...draft,photo:null,photoExpected:true};const h=fixture({read:async()=>({draft:missing})});await h.m.init();await h.m.submit();assert.equal(h.sends.length,0);assert.match(h.m.state.error,/Фото не сохранилось/);await h.m.withoutPhoto();assert.equal(h.sends.length,1);assert.equal(h.sends[0].photo,null);assert.equal(h.sends[0].payload.durationMs,3100);assert.notEqual(h.sends[0].payload.requestId,draft.payload.requestId);
});
test('cleanup failure after success cannot turn success into a retry',async()=>{const f=fixture({remove:async()=>{throw Error('cache denied');}});await f.ready();await f.m.submit();assert.equal(f.m.state.phase,'finished');assert.equal(f.m.state.error,'');});
test('real draft-cache transaction QuotaExceededError falls back to memory and small metadata',async()=>{
 const values=new Map(),logs=[];const warn=console.warn;console.warn=v=>logs.push(v);globalThis.sessionStorage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const db={transaction(){const tx={error:null,abort(){},objectStore(){return {put(){queueMicrotask(()=>{tx.error=new DOMException('Disk quota','QuotaExceededError');tx.onerror?.();});},delete(){},get(){return {};}};}};return tx;}};
 globalThis.indexedDB={open(){const request={result:db};queueMicrotask(()=>request.onsuccess?.());return request;}};
 try{const cache=await module('../lib/answer-draft.ts');const d={id:'quota',position:0,answer:'5',photo,photoId:'image-id',photoExpected:true};assert.match(await cache.saveDraft(d),/этой вкладке/);assert.equal((await cache.readDraft('quota')).draft.photo,photo);const meta=JSON.parse(values.get('draft-meta:quota'));assert.equal(meta.photo,null);assert.ok(meta.photoExpected);assert.equal(JSON.stringify(meta).includes('camera bytes'),false);assert.ok(logs.some(x=>x.includes('QuotaExceededError')));
 globalThis.indexedDB={open(){throw new DOMException('Denied','SecurityError');}};const reload=await module('../lib/answer-draft.ts');const restored=await reload.readDraft('quota');assert.equal(restored.draft.answer,'5');assert.equal(restored.draft.photo,null);assert.ok(restored.draft.photoExpected);
 const f=fixture({save:cache.saveDraft,read:cache.readDraft});await f.ready();await f.m.submit();assert.equal(f.sends.length,1);assert.ok(f.sends[0].photo);
 }finally{console.warn=warn;delete globalThis.indexedDB;delete globalThis.sessionStorage;}
});
