// LOCAL ONLY: HTTP proxy for manually verifying the UI under real network delays.
// Change ../latency.json while running. Never import this module in the application.
import {createServer,request} from 'node:http';import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const config=new URL('../../latency.json',import.meta.url);const log=new URL('../../latency-events.jsonl',import.meta.url);
createServer(async(req,res)=>{let c={};try{c=JSON.parse(readFileSync(config,'utf8'));}catch{}const path=req.url,parts=[];for await(const p of req)parts.push(p);const body=Buffer.concat(parts);const photo=/\/photos\//.test(path),answer=/\/answers$/.test(path),ready=/\/ready$/.test(path);const delay=photo?c.photoMs||0:answer?c.answerMs||0:ready?c.readyMs||0:0;
if(answer&&c.dropAnswers){c.dropAnswers--;writeFileSync(config,JSON.stringify(c));appendFileSync(log,JSON.stringify({event:'dropped',at:Date.now(),bytes:body.length})+'\n');res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Не удалось отправить ответ. Нажмите «Повторить».'}));return;}
if(delay)await new Promise(r=>setTimeout(r,delay));const h={...req.headers,host:'127.0.0.1:5173'};if(h.origin)h.origin='http://127.0.0.1:5173';
const upstream=request({hostname:'127.0.0.1',port:5173,path,method:req.method,headers:h},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);if(answer||ready||photo)appendFileSync(log,JSON.stringify({event:answer?'answer':ready?'ready':'photo',at:Date.now(),delay,status:r.statusCode})+'\n');});upstream.on('error',()=>{res.writeHead(502);res.end();});upstream.end(body);
}).listen(5174,'127.0.0.1',()=>console.log('Delay proxy http://127.0.0.1:5174 (config ../latency.json)'));
