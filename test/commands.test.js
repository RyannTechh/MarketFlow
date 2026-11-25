import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { commerce } from '../src/commerce.js';
import { payments } from '../src/payments.js';
test('market command definitions serialize with unique subcommands',()=>{
 const bot=new EventEmitter();const pool={query(){throw Error('Unexpected database access')}};
 const {command}=commerce(pool,bot,()=>{throw Error('Unexpected transaction')});
 const data=command.toJSON();assert.equal(data.name,'market');
 const names=data.options.map(x=>x.name);assert.ok(!names.includes('premium'));assert.ok(!names.includes('plan'));assert.equal(new Set(names).size,names.length);
 for(const name of ['panel','claim','support','support-role','coupon','delivery','license-revoke'])assert.ok(names.includes(name),name);
});
test('payment command definitions serialize without connecting to Stripe',()=>{
 const saved=process.env.STRIPE_SECRET_KEY;delete process.env.STRIPE_SECRET_KEY;
 try{const app={post(path,...handlers){assert.equal(path,'/webhooks/stripe');assert.ok(handlers.length>=2)}};
 const cmd=payments({},new EventEmitter(),app).toJSON();assert.equal(cmd.name,'payment');assert.deepEqual(cmd.options.map(x=>x.name),['stripe-account','stripe']);}
 finally{if(saved!==undefined)process.env.STRIPE_SECRET_KEY=saved;}
});
