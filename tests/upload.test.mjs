import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadRoom, recoverRoom } from '../lib/room-upload.ts';

const saved = { roomId: 'saved-room', teacherKey: 'teacher-secret', expiresAt: 9999999999999 };
const missing = () => Response.json({error:'Не найдено'}, {status:404});
function form() { const data=new FormData();data.set('requestId','fixed-request-id');data.set('teacherKey',saved.teacherKey);data.append('photos',new Blob(['synthetic']),'test.png');return data; }

test('lost creation response recovers room without uploading photos twice', async t => {
    let posts=0; t.mock.method(globalThis,'fetch',async (url,init)=>{
        if(init.method==='POST'){ posts++; throw new TypeError('Failed to fetch'); }
        assert.equal(init.headers['x-teacher-key'],saved.teacherKey);
        return posts ? Response.json(saved) : missing();
    });
    assert.deepEqual(await uploadRoom(form(),()=>{}),saved);assert.equal(posts,1);
});
test('brief disconnection retries exactly the same creation payload', async t => {
    const bodies=[]; t.mock.method(globalThis,'fetch',async (url,init)=>{
        if(init.method!=='POST')return missing();
        bodies.push(init.body);if(bodies.length===1)throw new TypeError('Failed to fetch');
        return Response.json(saved);
    });
    assert.deepEqual(await uploadRoom(form(),()=>{}),saved);
    assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
    assert.equal(bodies[1].get('requestId'),'fixed-request-id');
});
test('persistent network failure is bounded and gives actionable Russian error', async t => {
    let posts=0;t.mock.method(globalThis,'fetch',async (url,init)=>{if(init.method==='POST')posts++;throw new TypeError('Failed to fetch');});
    await assert.rejects(uploadRoom(form(),()=>{}),e=>e.status===0&&e.message.includes('Повторить создание')&&!e.message.includes('Failed to fetch'));
    assert.equal(posts,2);
});
test('validation error is not retried or replaced by a network error', async t => {
    let posts=0;t.mock.method(globalThis,'fetch',async (url,init)=>{if(init.method!=='POST')return missing();posts++;return Response.json({error:'Нужен ответ'}, {status:400});});
    await assert.rejects(uploadRoom(form(),()=>{}),e=>e.status===400&&e.message==='Нужен ответ');assert.equal(posts,1);
});
test('manual retry can recover an existing room without resending files', async t => {
    t.mock.method(globalThis,'fetch',async (url,init)=>{assert.notEqual(init.method,'POST');return Response.json(saved);});
    assert.deepEqual(await uploadRoom(form(),()=>{}),saved);
});
test('recovery preserves expiry and handles non-JSON gateway failures', async t => {
    t.mock.method(globalThis,'fetch',async()=>Response.json({error:'Срок действия комнаты истёк'},{status:410}));
    await assert.rejects(recoverRoom('id','key'),e=>e.status===410);
    t.mock.method(globalThis,'fetch',async()=>new Response('<html>Bad gateway</html>',{status:502}));
    await assert.rejects(recoverRoom('id','key'),e=>e.status===502&&!e.message.includes('<html>'));
});
