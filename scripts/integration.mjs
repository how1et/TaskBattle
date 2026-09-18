import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
const base=process.env.TEST_URL||'http://127.0.0.1:5173';
assert.match(base,/^http:\/\/127\.0\.0\.1:/,'Integration tests only create local data');
const key=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=','base64');
async function call(path,{method='GET',secret,teacher=false,body,file}={}){let payload;if(file){payload=new FormData();payload.set('payload',JSON.stringify(body));payload.set('solution',file,file.name);}else payload=body?JSON.stringify(body):undefined;const r=await fetch(base+'/api'+path,{method,headers:{...(secret?{[teacher?'x-teacher-key':'x-attempt-key']:secret}:{}),...(body&&!file?{'content-type':'application/json'}:{})},body:payload});return {status:r.status,data:await r.json()};}
const teacherKey=key(),requestId=crypto.randomUUID();
const count=25;
async function form(n=count){const f=new FormData();f.set('title','Проверка 25 задач');f.set('requestId',n===count?requestId:crypto.randomUUID());f.set('teacherKey',teacherKey);f.set('answers',JSON.stringify(Array.from({length:n},(_,i)=>['5','2.5','−5'][i%3])));for(let i=0;i<n;i++){const bytes=process.env.TEST_PHOTO_DIR?await readFile(process.env.TEST_PHOTO_DIR+`/task-${i%3+1}.png`):png;f.append('photos',new Blob([bytes],{type:'image/png'}),`task-${i+1}.png`);}return f;}
let r=await fetch(base+'/api/rooms',{method:'POST',body:await form()});const room=await r.json();assert.equal(r.status,200,JSON.stringify(room));const roomId=room.roomId;
assert.equal((await fetch(base+'/api/rooms',{method:'POST',body:await form(26)})).status,400);
r=await fetch(base+'/api/rooms',{method:'POST',body:await form()});assert.equal((await r.json()).roomId,roomId);console.log('PASS 25 tasks, reject 26, idempotent room creation');
const publicRoom=(await call('/rooms/'+roomId)).data;assert.equal(publicRoom.count,25);assert.equal(JSON.stringify(publicRoom).includes('answer'),false);assert.equal((await call('/rooms/'+roomId+'/teacher')).status,403);
const attemptKey=key(),attemptId=crypto.randomUUID(),secondKey=key(),secondId=crypto.randomUUID();
let a=(await call(`/rooms/${roomId}/start`,{method:'POST',body:{attemptId,attemptKey}})).data;await call(`/rooms/${roomId}/start`,{method:'POST',body:{attemptId:secondId,attemptKey:secondKey}});
const order=a.tasks;assert.equal(a.taskStartedAt,null);assert.equal((await call(`/attempts/${attemptId}`,{secret:secondKey})).status,403);
let total=0;
for(let position=0;position<count;position++){
 const ready=(await call(`/attempts/${attemptId}/ready`,{method:'POST',secret:attemptKey,body:{position,taskId:a.tasks[position].id,readyId:crypto.randomUUID(),startedAt:Date.now()}}));assert.equal(ready.status,200,JSON.stringify(ready.data));a=ready.data;
 const durationMs=1234+position,answer=position===1?'999':['5,00','2,50','-5.0'][(a.tasks[position].ordinal-1)%3];total+=durationMs;
 const payload={requestId:crypto.randomUUID(),position,taskId:a.tasks[position].id,answer,readyId:a.readyId,durationMs};
 const file=position===0?new File([png],'solution.png',{type:'image/png'}):undefined;
 if(position===0){const both=await Promise.all([1,2].map(()=>call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:payload,file})));assert.ok(both.every(x=>x.status===200),JSON.stringify(both));a=both[0].data;assert.equal((await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:{...payload,answer:'other'},file})).status,409);}
 else if(position===1){const proxy=createServer(async(req,res)=>{for await(const ignored of req){}await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:payload});res.destroy();});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));await assert.rejects(fetch(`http://127.0.0.1:${proxy.address().port}`,{method:'POST',body:'test'}));await new Promise(resolve=>proxy.close(resolve));a=(await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:payload})).data;}
 else{const out=await call(`/attempts/${attemptId}/answers`,{method:'POST',secret:attemptKey,body:payload});assert.equal(out.status,200,JSON.stringify(out));a=out.data;}
 assert.equal(a.position,position+1);assert.equal(a.completedMs,total);assert.deepEqual(a.tasks,order);if(position<24){assert.equal(a.taskStartedAt,null);assert.equal(JSON.stringify(a).includes('correctAnswer'),false);}
}
assert.equal(a.summary.totalMs,total);assert.equal(a.summary.averageMs,total/25);assert.equal(a.summary.correct,24);assert.equal(a.resultExpiresAt-a.finishedAt,259200000);console.log('PASS full 25-task report, exact milliseconds/mean, duplicate and lost-response retry, hidden answers and preserved order');
const teacher=(await call(`/attempts/${attemptId}/report`,{secret:teacherKey,teacher:true})).data;assert.deepEqual(teacher.report,a.report);assert.equal((await call(`/attempts/${secondId}`,{secret:secondKey})).data.position,0);
const solution=a.report.find(t=>t.solutionPhoto).solutionPhoto;
for(const headers of [{'x-attempt-key':attemptKey},{'x-teacher-key':teacherKey}])assert.equal((await fetch(base+solution,{headers})).status,200);
for(const headers of [{},{'x-attempt-key':secondKey}])assert.equal((await fetch(base+solution,{headers})).status,403);console.log('PASS private solution photo for student/teacher, independent attempt');
const state={base,roomId,attemptId,attemptKey,secondId,secondKey,teacherKey,photo:publicRoom.tasks[0].photo,solution,expiresAt:room.expiresAt,resultExpiresAt:a.resultExpiresAt};
await writeFile(process.env.TEST_STATE_FILE||'../integration-state.json',JSON.stringify(state,null,2));console.log('PASS local Worker + D1 + R2 integration');
