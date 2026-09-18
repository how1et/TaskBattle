// LOCAL ONLY: change only the integration fixture deadlines in local D1.
import {readFile,readdir} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';
const state=JSON.parse(await readFile(process.env.TEST_STATE_FILE||'../integration-state.json','utf8'));assert.match(state.base,/^http:\/\/127\.0\.0\.1:/);
const dir='.wrangler/state/v3/d1/miniflare-D1DatabaseObject';const dbFile=(await readdir(dir)).find(n=>n.endsWith('.sqlite')&&n!=='metadata.sqlite');const db=new DatabaseSync(dir+'/'+dbFile);db.exec('PRAGMA busy_timeout=5000');
const s={'x-attempt-key':state.attemptKey},t={'x-teacher-key':state.teacherKey};const get=(path,headers={})=>fetch(state.base+path,{headers});
db.prepare('UPDATE rooms SET expires_at=? WHERE id=?').run(Date.now()-1,state.roomId);
assert.equal((await get('/api/rooms/'+state.roomId)).status,410);assert.equal((await get(state.photo)).status,410);
for(const [p,h] of [[`/api/attempts/${state.attemptId}`,s],[`/api/attempts/${state.attemptId}/report`,t],[`/api/rooms/${state.roomId}/teacher`,t],[state.solution,s],[state.solution,t]])assert.equal((await get(p,h)).status,200,p);
const keys=db.prepare('SELECT key FROM blobs WHERE key IN(SELECT file_key FROM tasks WHERE room_id=?) OR key IN(SELECT solution_key FROM answers WHERE attempt_id=?)').all(state.roomId,state.attemptId).map(x=>x.key);
for(const k of keys)db.prepare('UPDATE blobs SET expires_at=1 WHERE key=?').run(k);
db.exec("DELETE FROM rate_limits WHERE key LIKE 'cleanup:%'");assert.equal((await fetch(state.base+'/api/cleanup',{method:'POST'})).status,200);assert.equal((await get(state.solution,s)).status,200);for(const k of keys)assert.ok(db.prepare('SELECT key FROM blobs WHERE key=?').get(k));console.log('PASS expired room blocks new access; student/teacher report and files remain');
db.prepare('UPDATE attempts SET result_expires_at=? WHERE id=?').run(Date.now()-1,state.attemptId);
for(const [p,h] of [[`/api/attempts/${state.attemptId}`,s],[`/api/attempts/${state.attemptId}/report`,t],[state.solution,s]]){const r=await get(p,h);assert.equal(r.status,410);assert.equal((await r.json()).error,'Срок хранения результата истёк');}
db.exec("DELETE FROM rate_limits WHERE key LIKE 'cleanup:%'");assert.equal((await fetch(state.base+'/api/cleanup',{method:'POST'})).status,200);for(const k of keys)assert.equal(db.prepare('SELECT key FROM blobs WHERE key=?').get(k),undefined);assert.equal((await (await get(`/api/attempts/${state.attemptId}`,s)).json()).error,'Срок хранения результата истёк');console.log('PASS actual local D1/R2 cleanup and authenticated expiry tombstone');db.close();
