import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {duration,elapsed} from '../lib/time.ts';
import {inspectImage} from '../lib/image-file.ts';
const initial=await readFile(new URL('../drizzle/0000_flaky_major_mapleleaf.sql',import.meta.url),'utf8');
const migration=await readFile(new URL('../drizzle/0001_adorable_dormammu.sql',import.meta.url),'utf8');
const recoveryMigration=await readFile(new URL('../drizzle/0002_open_gorilla_man.sql',import.meta.url),'utf8');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=','base64');
let now=Date.now();const realNow=Date.now;Date.now=()=>now;
const conn=new DatabaseSync(':memory:');conn.exec('PRAGMA foreign_keys=ON;'+initial+migration+recoveryMigration);
class Statement{constructor(query){this.query=query;this.args=[];}bind(...args){this.args=args;return this;}async first(){return conn.prepare(this.query).get(...this.args)||null;}async all(){return {results:conn.prepare(this.query).all(...this.args)};}async run(){return conn.prepare(this.query).run(...this.args);}}
const objects=new Map();let failDelete=false,solutionPutHook=null,solutionPutFailure=null,answerBatchFailure=null,solutionPuts=0;
globalThis.__taskbattleTestEnv={DB:{prepare:q=>new Statement(q),async batch(statements){
 // D1 batches are atomic: do not yield between statements in this SQLite mock.
 const fault=statements[0]?.query.includes('INSERT INTO answers(')?answerBatchFailure:null;
 if(fault)answerBatchFailure=null;
 conn.exec('BEGIN');let out;
 try{out=[];for(const s of statements){out.push(conn.prepare(s.query).run(...s.args));if(fault==='rollback')throw Error('simulated commit failure');}conn.exec('COMMIT');}
 catch(e){conn.exec('ROLLBACK');throw e;}
 if(fault==='committed')throw Error('simulated lost commit acknowledgement');
 return out;
}},BUCKET:{async put(k,v){
 const bytes=new Uint8Array(await new Response(v).arrayBuffer());
 if(k.startsWith('solutions/')){
   solutionPuts++;if(solutionPutHook)await solutionPutHook(k);
   const fault=solutionPutFailure;solutionPutFailure=null;
   if(fault==='before')throw Error('simulated upload failure');
   objects.set(k,bytes);
   if(fault==='after')throw Error('simulated lost upload acknowledgement');
 }else objects.set(k,bytes);
},async get(k){return objects.has(k)?{body:objects.get(k)}:null;},async delete(keys){if(failDelete)throw Error('simulated R2 outage');for(const k of Array.isArray(keys)?keys:[keys])objects.delete(k);}}};
let source=await readFile(new URL('../lib/server.ts',import.meta.url),'utf8');
source=source.replace("import { env } from 'cloudflare:workers';","const env=globalThis.__taskbattleTestEnv;").replace("'./normalization'",JSON.stringify(new URL('../lib/normalization.ts',import.meta.url).href)).replace("'./image-file'",JSON.stringify(new URL('../lib/image-file.ts',import.meta.url).href));
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {handle,cleanup}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const key=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
async function call(path,{method='GET',secret,teacher=false,body,file}={}){let payload;if(file){payload=new FormData();payload.set('payload',JSON.stringify(body));payload.set('solution',file,file.name);}else payload=body?JSON.stringify(body):undefined;const response=await handle(new Request('http://localhost/api'+path,{method,headers:{...(secret?{[teacher?'x-teacher-key':'x-attempt-key']:secret}:{}),...(body&&!file?{'content-type':'application/json'}:{})},body:payload}));const data=response.headers.get('content-type')?.startsWith('image/')?await response.arrayBuffer():await response.json();return {status:response.status,data};}
async function create(count=25){const form=new FormData(),teacherKey=key();form.set('requestId',crypto.randomUUID());form.set('teacherKey',teacherKey);form.set('title','25 испытаний');form.set('answers',JSON.stringify(Array(count).fill('5')));for(let i=0;i<count;i++)form.append('photos',new Blob([png],{type:'image/png'}),'task.png');const r=await handle(new Request('http://localhost/api/rooms',{method:'POST',body:form}));return {status:r.status,...await r.json(),teacherKey};}
async function start(room){const attemptId=crypto.randomUUID(),attemptKey=key();const r=await call(`/rooms/${room.roomId}/start`,{method:'POST',body:{attemptId,attemptKey}});assert.equal(r.status,200,JSON.stringify(r.data));return {...r.data,key:attemptKey};}
async function ready(a){const r=await call(`/attempts/${a.attemptId}/ready`,{method:'POST',secret:a.key,body:{position:a.position,taskId:a.tasks[a.position].id,startedAt:now,readyId:crypto.randomUUID()}});assert.equal(r.status,200,JSON.stringify(r.data));return {...r.data,key:a.key};}
const submit=(a,body,file)=>call(`/attempts/${a.attemptId}/answers`,{method:'POST',secret:a.key,body,file});

test('tenths, minute carry, raw mean and sleep-aware monotonic interval',()=>{for(const [ms,expected] of [[8400,'8,4 с'],[42000,'42,0 с'],[65700,'1 мин 05,7 с'],[59949,'59,9 с'],[59950,'1 мин 00,0 с'],[119999,'2 мин 00,0 с']])assert.equal(duration(ms),expected);assert.equal(elapsed({elapsed:150,wall:1000,mono:100},900,1600),1650);assert.equal(elapsed({elapsed:150,wall:1000,mono:100},11000,110),10150);});
test('actual image headers and dimensions reject a forged MIME and oversized pixels',()=>{assert.equal(inspectImage(png)?.mime,'image/png');assert.equal(inspectImage(Buffer.from('not a png')),null);const forged=Buffer.from(png);forged.writeUInt32BE(30000,16);assert.equal(inspectImage(forged),null);assert.equal(inspectImage(png.subarray(0,24)),null);});
test('additive migration keeps legacy rows and extends legacy report photos',()=>{const old=new DatabaseSync(':memory:');old.exec(initial);old.exec("INSERT INTO rooms VALUES('room','request','Title','hash',1,100,1); INSERT INTO tasks VALUES('task','room',1,'photo','image/png','5'); INSERT INTO attempts(id,room_id,secret_hash,order_json,position,started_at,task_started_at,finished_at) VALUES('attempt','room','secret','[\"task\"]',1,1,1,90); INSERT INTO blobs VALUES('photo',100);");old.exec(migration);assert.equal(old.prepare('SELECT answer FROM tasks').get().answer,'5');assert.equal(old.prepare('SELECT result_expires_at FROM attempts').get().result_expires_at,90+259200000);assert.equal(old.prepare('SELECT expires_at FROM blobs').get().expires_at,90+259200000);old.close();});

test('25 tasks, independent attempts, delays, photos, retries, expiry and cleanup',async()=>{
 const room=await create();assert.equal(room.status,200,JSON.stringify(room));assert.equal((await create(26)).status,400);const publicRoom=(await call('/rooms/'+room.roomId)).data;assert.equal(publicRoom.count,25);assert.equal(JSON.stringify(publicRoom).includes('answer'),false);
 let a=await start(room),b=await start(room);const unchanged=b;const order=a.tasks.map(t=>t.id);now+=12000;assert.equal((await call('/attempts/'+a.attemptId,{secret:a.key})).data.taskStartedAt,null);assert.equal(a.completedMs,0);
 let total=0,firstPayload,firstPhoto,firstTask;
 for(let i=0;i<25;i++){
   a=await ready(a);const start=a.taskStartedAt;
   const alternate=await call(`/attempts/${a.attemptId}/ready`,{method:'POST',secret:a.key,body:{position:i,taskId:a.tasks[i].id,startedAt:now+1,readyId:crypto.randomUUID()}});assert.equal(alternate.data.readyId,a.readyId);
   now+=i===0?8432:1234;const ms=i===0?8432:1234;total+=ms;
   const payload={requestId:crypto.randomUUID(),taskId:a.tasks[i].id,position:i,answer:i===1?'999':'5,00',readyId:a.readyId,durationMs:ms};const image=i===0?new File([png],'solution.png',{type:'image/png'}):undefined;
   if(i===0){assert.equal((await submit(a,{...payload,answer:' '})).status,400);assert.equal((await submit(a,payload,new File(['HEIC'],'image.heic',{type:'image/heic'}))).status,415);firstPayload=payload;firstPhoto=image;firstTask=a.tasks[i].id;}
   now+=9000; // delayed upload / last submission: captured interval is unchanged
   const r=await submit(a,payload,image);assert.equal(r.status,200,JSON.stringify(r.data));const again=await submit(a,payload,image);assert.equal(again.status,200);assert.equal(again.data.position,i+1);
   if(i===0){assert.equal((await submit(a,{...payload,durationMs:ms+1},image)).status,409);assert.equal((await submit(a,payload)).status,409);}
   a={...r.data,key:a.key};assert.equal(a.completedMs,total);assert.deepEqual(a.tasks.map(t=>t.id),order);
   if(i<24){assert.equal(a.taskStartedAt,null);assert.equal(JSON.stringify(a).includes('correctAnswer'),false);assert.equal(JSON.stringify(a).includes('solutionPhoto'),false);now+=17000;assert.equal((await call('/attempts/'+a.attemptId,{secret:a.key})).data.completedMs,total);}
   const row=conn.prepare('SELECT started_at,answered_at,duration_ms FROM answers WHERE attempt_id=? AND position=?').get(a.attemptId,i);assert.equal(row.started_at,start);assert.equal(row.answered_at-start,ms);
 }
 assert.equal(a.summary.totalMs,total);assert.equal(a.summary.averageMs,total/25);assert.equal(a.summary.correct,24);assert.equal(a.resultExpiresAt-a.finishedAt,259200000);assert.equal(a.summary.fastest.ordinals.length,24);
 const solution=a.report.find(t=>t.solutionPhoto).solutionPhoto;assert.equal((await call(solution.slice(4),{secret:a.key})).status,200);assert.equal((await call(solution.slice(4),{secret:room.teacherKey,teacher:true})).status,200);assert.equal((await call(solution.slice(4),{secret:b.key})).status,403);assert.equal((await call(solution.slice(4))).status,403);
 assert.equal((await call('/attempts/'+b.attemptId,{secret:b.key})).data.position,0);assert.equal((await call('/attempts/'+a.attemptId+'/report',{secret:room.teacherKey,teacher:true})).data.summary.totalMs,total);
 // A second, later result shares task files. Legacy worker finish after migration has NULL expiry.
 now=a.finishedAt+3600000;conn.prepare('UPDATE attempts SET finished_at=?,result_expires_at=NULL,position=25 WHERE id=?').run(now,b.attemptId);const bExpiry=now+259200000;
 now=room.expiresAt+1;assert.equal((await call('/rooms/'+room.roomId)).status,410);assert.equal((await call('/attempts/'+a.attemptId,{secret:a.key})).status,200);assert.equal((await call('/rooms/'+room.roomId+'/teacher',{secret:room.teacherKey,teacher:true})).data.attempts.length,2);
 // Force stale journal dates to prove references, not the journal, protect files.
 conn.exec('UPDATE blobs SET expires_at=1');await cleanup();assert.equal(objects.size,26);assert.equal((await call(solution.slice(4),{secret:a.key})).status,200);
 now=a.resultExpiresAt-1;assert.equal((await call('/attempts/'+a.attemptId,{secret:a.key})).status,200);
 now=a.resultExpiresAt;assert.equal((await call('/attempts/'+a.attemptId,{secret:a.key})).status,410);await cleanup();assert.equal(objects.size,25);assert.equal((await call('/attempts/'+a.attemptId,{secret:a.key})).data.error,'Срок хранения результата истёк');assert.equal((await call('/attempts/'+a.attemptId+'/report',{secret:room.teacherKey,teacher:true})).data.error,'Срок хранения результата истёк');assert.equal((await call('/attempts/'+b.attemptId+'/photos/'+b.tasks[0].id,{secret:b.key})).status,200);
 now=bExpiry;failDelete=true;await assert.rejects(cleanup());assert.equal(objects.size,25);failDelete=false;await cleanup();assert.equal(objects.size,0);assert.equal(conn.prepare('SELECT count(*) AS n FROM rooms').get().n,0);assert.equal((await call('/attempts/'+b.attemptId,{secret:b.key})).data.error,'Срок хранения результата истёк');
 Date.now=realNow;
});

async function recoveryFixture(t){
 now=Math.max(now,realNow())+3600001;Date.now=()=>now;
 solutionPutHook=null;solutionPutFailure=null;answerBatchFailure=null;failDelete=false;
 t.after(()=>{Date.now=realNow;solutionPutHook=null;solutionPutFailure=null;answerBatchFailure=null;failDelete=false;});
 const room=await create(1);assert.equal(room.status,200,JSON.stringify(room));
 const a=await ready(await start(room));now+=5000;
 const payload={requestId:crypto.randomUUID(),taskId:a.tasks[0].id,position:0,answer:'5',readyId:a.readyId,durationMs:5000};
 const file=new File([png],'solution.png',{type:'image/png'});
 return {a,payload,file};
}
const cancel=(a,payload)=>call(`/attempts/${a.attemptId}/cancel-answer`,{method:'POST',secret:a.key,body:{requestId:payload.requestId,position:payload.position,taskId:payload.taskId}});
const answerRows=a=>conn.prepare('SELECT * FROM answers WHERE attempt_id=?').all(a.attemptId);
const solutionKeys=a=>[...objects.keys()].filter(k=>k.startsWith(`solutions/${a.attemptId}/`));
const solutionJournal=a=>conn.prepare("SELECT * FROM blobs WHERE key LIKE ?").all(`solutions/${a.attemptId}/%`);
function uploadGate(required=1){
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let hits=0;
 solutionPutHook=async()=>{if(++hits===required)entered.resolve();await release.promise;};
 return {entered:entered.promise,release:()=>release.resolve()};
}

test('cancelled answer cannot upload or commit; an edited answer has a new request id',async t=>{
 const {a,payload,file}=await recoveryFixture(t),puts=solutionPuts;
 const cancelled=await cancel(a,payload);assert.equal(cancelled.status,200);assert.equal(cancelled.data.cancelled,true);assert.equal(cancelled.data.snapshot.position,0);
 const stale=await submit(a,payload,file);assert.equal(stale.status,409);assert.equal(stale.data.code,'cancelled');assert.equal(solutionPuts,puts);assert.equal(answerRows(a).length,0);
 const fresh=await submit(a,{...payload,requestId:crypto.randomUUID(),answer:'6',durationMs:6000},file);
 assert.equal(fresh.status,200,JSON.stringify(fresh.data));assert.equal(fresh.data.summary.correct,0);assert.equal(fresh.data.summary.totalMs,6000);assert.equal(solutionKeys(a).length,1);
});

test('cancellation during an upload fences the late commit and removes its orphan photo',{timeout:5000},async t=>{
 const {a,payload,file}=await recoveryFixture(t),gate=uploadGate();
 const uploading=submit(a,payload,file);
 try{
   await gate.entered;
   const cancelled=await cancel(a,payload);assert.equal(cancelled.status,200);assert.equal(cancelled.data.cancelled,true);
 }finally{gate.release();}
 const late=await uploading;assert.equal(late.status,409);assert.equal(answerRows(a).length,0);assert.equal(solutionKeys(a).length,0);assert.equal(solutionJournal(a).length,0);
 assert.equal((await call('/attempts/'+a.attemptId,{secret:a.key})).data.position,0);
 solutionPutHook=null;
 const retry=await submit(a,{...payload,requestId:crypto.randomUUID()},file);assert.equal(retry.status,200);assert.equal(answerRows(a).length,1);assert.equal(solutionKeys(a).length,1);
});

test('cancellation after commit returns the accepted result and cannot reopen it',async t=>{
 const {a,payload,file}=await recoveryFixture(t);
 const accepted=await submit(a,payload,file);assert.equal(accepted.status,200);
 const cancelled=await cancel(a,payload);assert.equal(cancelled.status,200);assert.equal(cancelled.data.cancelled,false);assert.equal(cancelled.data.snapshot.position,1);assert.equal(cancelled.data.snapshot.report[0].answer,'5');
 assert.equal(conn.prepare('SELECT count(*) AS n FROM cancelled_answers WHERE attempt_id=?').get(a.attemptId).n,0);
 const editing=await submit(a,{...payload,requestId:crypto.randomUUID(),answer:'6'},file);assert.equal(editing.status,409);assert.equal(answerRows(a).length,1);assert.equal(solutionKeys(a).length,1);
});

test('simultaneous identical photo submissions create one answer and retain one photo',{timeout:5000},async t=>{
 const {a,payload,file}=await recoveryFixture(t),gate=uploadGate(2);
 const first=submit(a,payload,file),second=submit(a,payload,file);
 try{await gate.entered;}finally{gate.release();}
 const responses=await Promise.all([first,second]);
 for(const response of responses){assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.position,1);assert.equal(response.data.summary.totalMs,5000);}
 assert.equal(answerRows(a).length,1);assert.equal(solutionKeys(a).length,1);assert.equal(solutionJournal(a).length,1);
 assert.equal(solutionKeys(a)[0],answerRows(a)[0].solution_key);
});

test('failed photo upload removes a partially stored object and permits the same safe retry',async t=>{
 const {a,payload,file}=await recoveryFixture(t);solutionPutFailure='after';
 const failed=await submit(a,payload,file);assert.equal(failed.status,503);assert.equal(failed.data.code,'photo-upload');
 assert.equal(answerRows(a).length,0);assert.equal(solutionKeys(a).length,0);assert.equal(solutionJournal(a).length,0);
 const retried=await submit(a,payload,file);assert.equal(retried.status,200);assert.equal(retried.data.summary.totalMs,5000);assert.equal(solutionKeys(a).length,1);
});

test('rolled back answer commit removes the upload and permits a retry without duplicates',async t=>{
 const {a,payload,file}=await recoveryFixture(t);answerBatchFailure='rollback';
 const failed=await submit(a,payload,file);assert.equal(failed.status,503);assert.equal(failed.data.code,'answer-save');
 assert.equal(answerRows(a).length,0);assert.equal(solutionKeys(a).length,0);assert.equal(solutionJournal(a).length,0);
 assert.equal((await call('/attempts/'+a.attemptId,{secret:a.key})).data.position,0);
 const retried=await submit(a,payload,file);assert.equal(retried.status,200);assert.equal(retried.data.summary.totalMs,5000);assert.equal(answerRows(a).length,1);assert.equal(solutionKeys(a).length,1);
});

test('lost database commit acknowledgement preserves the accepted photo and retry returns the saved result',async t=>{
 const {a,payload,file}=await recoveryFixture(t);answerBatchFailure='committed';
 const uncertain=await submit(a,payload,file);assert.equal(uncertain.status,503);assert.equal(uncertain.data.code,'answer-save');
 assert.equal(answerRows(a).length,1);assert.equal(solutionKeys(a).length,1);assert.equal(solutionKeys(a)[0],answerRows(a)[0].solution_key);
 const puts=solutionPuts;
 const retried=await submit(a,payload,file);assert.equal(retried.status,200);assert.equal(retried.data.summary.totalMs,5000);assert.equal(solutionPuts,puts);
 const cancelled=await cancel(a,payload);assert.equal(cancelled.data.cancelled,false);assert.equal(cancelled.data.snapshot.finishedAt,retried.data.finishedAt);
 assert.equal((await call(retried.data.report[0].solutionPhoto.slice(4),{secret:a.key})).status,200);
});

test('failed immediate orphan deletion leaves a journal entry for scheduled cleanup',async t=>{
 const {a,payload,file}=await recoveryFixture(t);solutionPutFailure='after';failDelete=true;
 const failed=await submit(a,payload,file);assert.equal(failed.status,503);assert.equal(answerRows(a).length,0);assert.equal(solutionKeys(a).length,1);assert.equal(solutionJournal(a)[0].state,'deleting');
 failDelete=false;await cleanup();assert.equal(solutionKeys(a).length,0);assert.equal(solutionJournal(a).length,0);
 const retried=await submit(a,payload,file);assert.equal(retried.status,200);assert.equal(solutionKeys(a).length,1);
});
