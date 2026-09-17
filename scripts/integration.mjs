import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
const base=process.env.TEST_URL||'http://127.0.0.1:5173';
const outcomes=[];const pass=name=>{outcomes.push(name);console.log('PASS',name);};
const key=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
async function call(path,{method='GET',secret,teacher=false,body}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(secret?{[teacher?'x-teacher-key':'x-attempt-key']:secret}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();return {status:r.status,data};}
const teacherKey=key(),requestId=crypto.randomUUID();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=','base64');
async function form(){const f=new FormData();f.set('title','Проверка TaskBattle');f.set('requestId',requestId);f.set('teacherKey',teacherKey);f.set('answers',JSON.stringify(['5','2.5','−5']));for(let i=1;i<=3;i++){const bytes=process.env.TEST_PHOTO_DIR?await readFile(process.env.TEST_PHOTO_DIR+`/task-${i}.png`):png;f.append('photos',new Blob([bytes],{type:'image/png'}),`task-${i}.png`);}return f;}
const createdResponse=await fetch(base+'/api/rooms',{method:'POST',body:await form()});const created=await createdResponse.json();assert.equal(createdResponse.status,200,JSON.stringify(created));const roomId=created.roomId;pass('create room with three photographs');
const repeated=await fetch(base+'/api/rooms',{method:'POST',body:await form()});assert.equal((await repeated.json()).roomId,roomId);pass('room creation retry is idempotent');
const room=(await call(`/rooms/${roomId}`)).data;assert.equal(room.count,3);assert.equal(room.expiresAt-room.createdAt,172800000);assert.equal(JSON.stringify(room).includes('correct'),false);assert.equal(JSON.stringify(room).includes('answer'),false);pass('48-hour lifetime and no answers in student room API');
assert.equal((await call(`/rooms/${roomId}/teacher`)).status,403);pass('teacher results require separate secret');
const attemptKey=key(),attemptId=crypto.randomUUID();let a=(await call(`/rooms/${roomId}/start`,{method:'POST',body:{attemptId,attemptKey}})).data;assert.equal(a.position,0);const original=a;
assert.equal((await call(`/rooms/${roomId}/start`,{method:'POST',body:{attemptId,attemptKey}})).data.startedAt,a.startedAt);pass('start retry retains attempt and timer');
const reload=await call(`/attempts/${attemptId}`,{secret:attemptKey});assert.deepEqual(reload.data.tasks,a.tasks);assert.equal(reload.data.startedAt,a.startedAt);assert.equal(JSON.stringify(reload.data).includes('correct'),false);pass('reload retains order, start and hidden answer keys');
assert.equal((await call(`/attempts/${attemptId}`,{secret:key()})).status,403);
const secondKey=key(),secondId=crypto.randomUUID();const other=await call(`/rooms/${roomId}/start`,{method:'POST',body:{attemptId:secondId,attemptKey:secondKey}});assert.equal(other.data.position,0);assert.equal((await call(`/attempts/${attemptId}`,{secret:secondKey})).status,403);pass('independent attempts and no cross-attempt access');
assert.equal((await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:{requestId:crypto.randomUUID(),position:0,taskId:a.tasks[0].id,answer:'  '}})).status,400);pass('empty answer rejected');
const values={1:'5,00',2:'999',3:'-5.0'};
let payload={requestId:crypto.randomUUID(),position:0,taskId:a.tasks[0].id,answer:values[a.tasks[0].ordinal]};
const parallel=await Promise.all([1,2].map(()=>call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:payload})));assert.ok(parallel.every(r=>r.status===200));a=(await call(`/attempts/${attemptId}`,{secret:attemptKey})).data;assert.equal(a.position,1);assert.equal(JSON.stringify(a).includes('correct'),false);pass('double submission records one answer, advances once, leaks no grade');
assert.equal((await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:{...payload,answer:'different'}})).status,409);pass('idempotency key cannot replace accepted answer');
payload={requestId:crypto.randomUUID(),position:1,taskId:a.tasks[1].id,answer:values[a.tasks[1].ordinal]};
// A real HTTP response is lost after upstream has committed the answer.
let upstreamResult;const proxy=createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);upstreamResult=await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:JSON.parse(Buffer.concat(parts).toString())});res.destroy();});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
await assert.rejects(fetch(`http://127.0.0.1:${proxy.address().port}`,{method:'POST',body:JSON.stringify(payload)}));await new Promise(resolve=>proxy.close(resolve));
const retry=await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:payload});assert.equal(retry.data.position,2);assert.equal(retry.data.taskStartedAt,upstreamResult.data.taskStartedAt);a=retry.data;pass('network response loss and safe retry preserve first accepted timestamp');
payload={requestId:crypto.randomUUID(),position:2,taskId:a.tasks[2].id,answer:values[a.tasks[2].ordinal]};a=(await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:payload})).data;
assert.equal(a.summary.correct,2);assert.equal(a.summary.count,3);assert.equal(a.report.reduce((s,r)=>s+r.durationMs,0),a.summary.totalMs);assert.equal(a.summary.averageMs,a.summary.totalMs/3);assert.deepEqual(a.report.map(r=>r.ordinal),[1,2,3]);pass('final report: 2/3 correct, original order, exact total and mean');
const teacher=await call(`/attempts/${attemptId}/report`,{secret:teacherKey,teacher:true});assert.deepEqual(teacher.data.report,a.report);const list=await call(`/rooms/${roomId}/teacher`,{secret:teacherKey,teacher:true});assert.equal(list.data.attempts.length,2);assert.equal((await call(`/attempts/${secondId}`,{secret:secondKey})).data.position,0);pass('teacher sees report; other attempt unchanged');
// Competing, different bodies with the SAME request id must not both succeed.
const sameRequest=crypto.randomUUID();const race=await Promise.all(['first','second'].map(answer=>call(`/attempts/${secondId}/answers`,{method:'POST',secret:secondKey,body:{requestId:sameRequest,position:0,taskId:other.data.tasks[0].id,answer}})));assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);pass('concurrent key/body conflict returns 409');
const badForm=new FormData();badForm.set('title','Invalid');badForm.set('requestId',crypto.randomUUID());badForm.set('teacherKey',key());badForm.set('answers','["5"]');badForm.append('photos',new Blob(['not an image'],{type:'image/png'}),'bad.png');const bad=await fetch(base+'/api/rooms',{method:'POST',body:badForm});assert.equal(bad.status,415);pass('forged image MIME rejected');
const forged=await fetch(base+room.tasks[0].photo.replace(roomId,roomId+'x'));assert.ok([404,410].includes(forged.status));pass('photographs require a valid room capability');
const output={base,roomId,attemptId,attemptKey,teacherKey,photo:room.tasks[0].photo,checks:outcomes};
if(process.env.TEST_STATE_FILE)await writeFile(process.env.TEST_STATE_FILE,JSON.stringify(output,null,2));console.log(`${outcomes.length} integration checks passed`);
