import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {duration,elapsed} from '../lib/time.ts';
import {inspectImage} from '../lib/image-file.ts';
const initial=await readFile(new URL('../drizzle/0000_flaky_major_mapleleaf.sql',import.meta.url),'utf8');
const migration=await readFile(new URL('../drizzle/0001_adorable_dormammu.sql',import.meta.url),'utf8');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=','base64');
let now=Date.now();const realNow=Date.now;Date.now=()=>now;
const conn=new DatabaseSync(':memory:');conn.exec('PRAGMA foreign_keys=ON;'+initial+migration);
class Statement{constructor(query){this.query=query;this.args=[];}bind(...args){this.args=args;return this;}async first(){return conn.prepare(this.query).get(...this.args)||null;}async all(){return {results:conn.prepare(this.query).all(...this.args)};}async run(){return conn.prepare(this.query).run(...this.args);}}
const objects=new Map();let failDelete=false;
globalThis.__taskbattleTestEnv={DB:{prepare:q=>new Statement(q),async batch(statements){conn.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());conn.exec('COMMIT');return out;}catch(e){conn.exec('ROLLBACK');throw e;}}},BUCKET:{async put(k,v){objects.set(k,new Uint8Array(await new Response(v).arrayBuffer()));},async get(k){return objects.has(k)?{body:objects.get(k)}:null;},async delete(keys){if(failDelete)throw Error('simulated R2 outage');for(const k of Array.isArray(keys)?keys:[keys])objects.delete(k);}}};
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
