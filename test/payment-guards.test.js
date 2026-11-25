import test from 'node:test';
import assert from 'node:assert/strict';
import { expireManualOrders, applyStripeSession, holdStripeIntent } from '../src/order-lifecycle.js';

test('manual expiry disabled or invalid does not access the database',async()=>{
 const pool={connect:async()=>{throw new Error('Unexpected database access');}};
 for(const hours of [0,-1,NaN,0.5,721])assert.equal(await expireManualOrders(pool,hours),0);
});
test('missing Stripe account or intent cannot alter payment state',async()=>{
 const pool={connect:async()=>{throw new Error('Unexpected database access');}};
 assert.equal(await applyStripeSession(pool,{id:'cs_test'},''),'ignored');
 assert.equal(await applyStripeSession(pool,{},'acct_test'),'ignored');
 assert.equal(await holdStripeIntent(pool,'acct_test',null,'evt_test','charge.refunded'),false);
});
