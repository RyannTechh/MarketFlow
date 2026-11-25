import express from 'express';
import { licenseHash } from './licenses.js';
import { timingSafeEqual, createHash } from 'node:crypto';
const digest=x=>createHash('sha256').update(x).digest();
export function startApi(pool,configure){
 const app=express();app.disable('x-powered-by');const paymentCommand=configure(app);app.use(express.json({limit:'16kb'}));
 app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const limits=new Map();const cleanup=setInterval(()=>{for(const [key,v] of limits)if(v.until<=Date.now())limits.delete(key);},60000);cleanup.unref();
 app.use('/api',(req,res,next)=>{const key=req.ip;const now=Date.now();let v=limits.get(key);if(!v||v.until<=now){if(limits.size>=10000&&!limits.has(key))return res.sendStatus(503);v={count:0,until:now+60000};limits.set(key,v);}if(++v.count>120){res.set('Retry-After',String(Math.ceil((v.until-now)/1000)));return res.sendStatus(429);}next();});
 const token=process.env.DASHBOARD_TOKEN;
 const admin=(req,res,next)=>{if(!token||token.length<32||!timingSafeEqual(digest(req.get('authorization')||''),digest('Bearer '+token)))return res.sendStatus(401);next();};
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){console.error('API error',e.code||e.name);res.sendStatus(500);}};
 app.get('/health',wrap(async(req,res)=>{await pool.query('SELECT 1');res.json({status:'ok'});}));
 app.post('/api/licenses/validate',wrap(async(req,res)=>{
 const key=req.body?.key;if(typeof key!=='string'||!/^MF-[a-f0-9]{48}$/.test(key))return res.json({valid:false});
 const r=await pool.query("SELECT e.expires_at,e.product_id,o.guild_id FROM entitlements e JOIN orders o ON o.id=e.order_id WHERE e.kind='license' AND e.license_hash=$1 AND NOT e.revoked AND o.status='paid' AND NOT o.payment_hold AND (e.expires_at IS NULL OR e.expires_at>now()) LIMIT 1",[licenseHash(key)]);
 res.set('Cache-Control','no-store').json(r.rowCount?{valid:true,product:r.rows[0].product_id,guild:r.rows[0].guild_id,expiresAt:r.rows[0].expires_at}:{valid:false});
 }));
 app.get('/api/admin/:guild/summary',admin,wrap(async(req,res)=>{
 const g=req.params.guild;if(!/^\d{17,20}$/.test(g))return res.sendStatus(400);
 const r=await pool.query("SELECT count(*) FILTER(WHERE status='paid' AND NOT payment_hold) AS paid_orders,coalesce(sum(total) FILTER(WHERE status='paid' AND NOT payment_hold),0) AS revenue,count(DISTINCT user_id) FILTER(WHERE status='paid' AND NOT payment_hold) AS customers FROM orders WHERE guild_id=$1",[g]);
 const p=await pool.query('SELECT id,name,category,price,stock FROM products WHERE guild_id=$1 ORDER BY id LIMIT 100',[g]);res.json({summary:r.rows[0],products:p.rows});
 }));
 app.get('/',(req,res)=>res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MarketFlow</title></head><body style="background:#101827;color:#e5e7eb;font:16px system-ui;max-width:900px;margin:40px auto;padding:20px"><h1>MarketFlow</h1><p>Operator dashboard — read-only</p><form id="f"><label>Guild ID <input id="g" required></label> <label>Operator token <input id="t" type="password" required></label> <button>Load</button></form><pre id="out" style="white-space:pre-wrap"></pre><script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const out=document.getElementById('out');try{const r=await fetch('/api/admin/'+encodeURIComponent(document.getElementById('g').value)+'/summary',{headers:{Authorization:'Bearer '+document.getElementById('t').value}});out.textContent=r.ok?JSON.stringify(await r.json(),null,2):'Request failed: '+r.status}catch{out.textContent='Connection failed'}};</script></body></html>`));
 app.get('/payment/success',(req,res)=>res.send('Payment submitted. Check your Discord order status.'));app.get('/payment/cancel',(req,res)=>res.send('Checkout cancelled. Contact the store to reconcile the order.'));
 app.listen(Number(process.env.PORT||3000),process.env.API_HOST||'127.0.0.1',()=>console.log('MarketFlow API listening'));return paymentCommand;
}
