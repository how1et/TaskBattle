// LOCAL ONLY: changes test data in the local D1 database, never production.
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const state=JSON.parse(await readFile(process.env.TEST_STATE_FILE||'../integration-state.json','utf8'));
assert.match(state.base,/^http:\/\/127\.0\.0\.1:/);assert.match(state.roomId,/^[a-zA-Z0-9.]+$/);
function sql(query){execFileSync(process.execPath,['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js','d1','execute','DB','--local','--config','dist/server/wrangler.json','--persist-to','.wrangler/state','--command',query],{stdio:'pipe'});}
sql(`UPDATE rooms SET expires_at=1 WHERE id='${state.roomId}'`);
for(const [path,headers] of [[`/api/rooms/${state.roomId}`,{}],[state.photo,{}],[`/api/rooms/${state.roomId}/teacher`,{'x-teacher-key':state.teacherKey}],[`/api/attempts/${state.attemptId}`,{'x-attempt-key':state.attemptKey}],[`/api/attempts/${state.attemptId}/report`,{'x-teacher-key':state.teacherKey}]]){
 const r=await fetch(state.base+path,{headers});assert.equal(r.status,410,path);assert.equal((await r.json()).error,'Срок действия комнаты истёк');
}
console.log('PASS expiry blocks room, photos, progress, teacher list and report on server');
sql(`UPDATE blobs SET expires_at=1 WHERE key IN (SELECT file_key FROM tasks WHERE room_id='${state.roomId}')`);
const response=await fetch(state.base+'/api/cleanup',{method:'POST'});assert.equal(response.status,200);assert.equal((await response.json()).deletedFiles,3);
assert.equal((await fetch(state.base+`/api/attempts/${state.attemptId}`,{headers:{'x-attempt-key':state.attemptKey}})).status,404);
const oldRoom=state.roomId.split('.')[0]+'.1';assert.equal((await fetch(state.base+`/api/rooms/${oldRoom}`)).status,410);console.log('PASS cleanup removes expired photos and cascades records; expired links remain understandable');
sql('DELETE FROM rate_limits');
// Verify creation limit with tiny invalid requests: each attempt is counted before parsing.
for(let i=0;i<5;i++)await fetch(state.base+'/api/rooms',{method:'POST',body:'bad'});
assert.equal((await fetch(state.base+'/api/rooms',{method:'POST',body:'bad'})).status,429);console.log('PASS persistent creation rate limit');sql('DELETE FROM rate_limits');
