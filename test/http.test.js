import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import Stripe from 'stripe';
import { createApi } from '../src/api.js';
import { payments } from '../src/payments.js';
import { licenseHash } from '../src/licenses.js';

test('HTTP API authorization, validation, rate limiting, and health',async()=>{
 const prev=process.env.DASHBOARD_TOKEN;
 process.env.DASHBOARD_TOKEN='test-token-only-'.repeat(3);
 const token=process.env.DASHBOARD_TOKEN,key='MF-'+'ab'.repeat(24),guild='123456789012345678';
 const calls=[];
 const pool={query:async(sql,args)=>{calls.push({sql,args});if(sql.includes('license_hash'))return {rows:args[0]===licenseHash(key)?[{expires_at:null,product_id:'1',guild_id:guild}]:[],rowCount:args[0]===licenseHash(key)?1:0};if(sql.includes('count(*)'))return {rows:[{paid_orders:'1'}]};return {rows:[]};}};
 const {app,dispose}=createApi(pool,()=>null);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 try{
 assert.deepEqual(await (await fetch(base+'/health')).json(),{status:'ok'});
 assert.equal((await fetch(base+'/api/admin/'+guild+'/summary')).status,401);
 assert.equal((await fetch(base+'/api/admin/not-a-guild/summary',{headers:{Authorization:'Bearer '+token}})).status,400);
 assert.equal((await fetch(base+'/api/admin/'+guild+'/summary',{headers:{Authorization:'Bearer '+token}})).status,200);
 assert.deepEqual(await (await post('/api/licenses/validate',{key:'invalid'})).json(),{valid:false});
 const response=await post('/api/licenses/validate',{key});
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await response.json()).valid,true);
 assert.ok(calls.some(c=>c.args?.[0]===licenseHash(key)));
 assert.ok(!calls.some(c=>c.args?.includes(key)));
 let rateLimited=false;
 for(let i=0;i<125;i++){const r=await post('/api/licenses/validate',{key:'invalid'});await r.arrayBuffer();if(r.status===429){rateLimited=true;break;}}
 assert.ok(rateLimited);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));dispose();if(prev===undefined)delete process.env.DASHBOARD_TOKEN;else process.env.DASHBOARD_TOKEN=prev;}
});
test('Stripe webhook rejects bad signatures and live events; accepts signed test events',async()=>{
 const saved={key:process.env.STRIPE_SECRET_KEY,webhook:process.env.STRIPE_WEBHOOK_SECRET};
 process.env.STRIPE_SECRET_KEY='sk_test_mock';process.env.STRIPE_WEBHOOK_SECRET='whsec_mock';
 const pool={query:async()=>({rows:[]}),connect:async()=>{throw Error('Unexpected database access');}};
 const bot=new EventEmitter(),{app,dispose}=createApi(pool,a=>payments(pool,bot,a));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:'+server.address().port+'/webhooks/stripe';
 const stripe=new Stripe('sk_test_mock');
 const send=(payload,signature)=>fetch(url,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});
 try{
 const payload=JSON.stringify({id:'evt_test',type:'unrelated.event',livemode:false,data:{object:{}}});
 assert.equal((await send(payload,'invalid')).status,400);
 const sign=p=>stripe.webhooks.generateTestHeaderString({payload:p,secret:'whsec_mock'});
 assert.equal((await send(payload,sign(payload))).status,200);
 const live=JSON.stringify({id:'evt_test',type:'unrelated.event',livemode:true,data:{object:{}}});
 assert.equal((await send(live,sign(live))).status,400);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));dispose();for(const [name,value] of [['STRIPE_SECRET_KEY',saved.key],['STRIPE_WEBHOOK_SECRET',saved.webhook]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});
