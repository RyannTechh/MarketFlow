import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionMatches, cancelLocked, applyStripeSession, holdStripeIntent } from '../src/order-lifecycle.js';
const order={id:'order-1',guild_id:'guild-1',status:'pending',currency:'EUR',total:'1000',coupon_code:'SAVE'};
const attempt={provider:'stripe',account:'acct_1',external_id:'cs_1'};
const session={id:'cs_1',metadata:{order:'order-1'},amount_total:1000,currency:'eur'};
test('settlement requires matching account, session, order, amount and currency',()=>{
 assert.equal(sessionMatches(order,attempt,session,'acct_1'),true);
 for(const patch of [{id:'cs_2'},{amount_total:999},{currency:'usd'},{metadata:{order:'other'}}])assert.equal(sessionMatches(order,attempt,{...session,...patch},'acct_1'),false);
 assert.equal(sessionMatches(order,attempt,session,'acct_2'),false);
});
test('cancellation restores stock and coupon only for pending orders',async()=>{
 const calls=[];const db={query:async(sql,args)=>{calls.push([sql,args]);return {rows:sql.startsWith('SELECT')?[{product_id:3,quantity:2}]:[]};}};
 assert.equal(await cancelLocked(db,{...order,status:'paid'}),false);assert.equal(calls.length,0);
 assert.equal(await cancelLocked(db,order),true);assert.equal(calls.length,4);assert.deepEqual(calls[1][1],[3,2,'guild-1']);assert.deepEqual(calls[2][1],['guild-1','SAVE']);
});
test('a matched paid event updates state and records a prior payment hold',async()=>{
 const calls=[];const db={release(){},async query(sql,args){calls.push([sql,args]);if(sql.includes('SELECT o.*'))return {rows:[{...order,...attempt}]};if(sql.includes('SELECT reason'))return {rows:[{reason:'charge.refunded'}]};return {rows:[]};}};
 const result=await applyStripeSession({connect:async()=>db},{...session,payment_status:'paid',payment_intent:'pi_1'},'acct_1');
 assert.equal(result,'paid');const update=calls.find(x=>x[0].includes("SET status='paid'"));assert.deepEqual(update[1],['order-1',true,'charge.refunded']);
});
test('refund incidents are persisted before applying holds',async()=>{
 const calls=[];const db={release(){},async query(sql,args){calls.push([sql,args]);return {rows:[]};}};
 assert.equal(await holdStripeIntent({connect:async()=>db},'acct_1','pi_1','evt_1','charge.refunded'),true);
 assert.ok(calls.some(x=>x[0].includes('INSERT INTO payment_incidents')));assert.ok(calls.some(x=>x[0].includes('SET payment_hold=true')));
});
