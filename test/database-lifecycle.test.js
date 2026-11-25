import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { applyStripeSession, holdStripeIntent, expireManualOrders } from '../src/order-lifecycle.js';
import { licenseSecret, licenseHash, decryptLicense, migrateLicenses } from '../src/licenses.js';

test('PostgreSQL payment transitions, inventory restoration and license migration',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema='mf_test_'+randomUUID().replaceAll('-','');
 const admin=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
 await admin.connect();
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 try{
 await admin.query('CREATE SCHEMA '+schema);
 await pool.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 await pool.query("INSERT INTO stores VALUES ('guild','EUR')");
 const product=(await pool.query("INSERT INTO products(guild_id,name,category,price,stock) VALUES('guild','product','test',1000,0) RETURNING id")).rows[0].id;
 const a=randomUUID(),b=randomUUID(),c=randomUUID(),d=randomUUID();
 for(const id of [a,b,c,d]){
 await pool.query("INSERT INTO orders(id,guild_id,user_id,currency,total,status,created_at) VALUES($1,'guild','user','EUR',1000,'pending',now()-interval '2 days')",[id]);
 await pool.query("INSERT INTO order_items(order_id,product_id,name,price,quantity) VALUES($1,$2,'product',1000,1)",[id,product]);
 }
 await pool.query("INSERT INTO payment_attempts(order_id,provider,account,external_id) VALUES($1,'stripe','acct_test','cs_paid'),($2,'stripe','acct_test','cs_expired')",[a,b]);
 await pool.query("INSERT INTO payment_attempts(order_id,provider,account) VALUES($1,'stripe','acct_test')",[d]);
 const session={id:'cs_paid',metadata:{order:a},amount_total:1000,currency:'eur',payment_status:'paid',payment_intent:'pi_paid'};
 assert.equal(await applyStripeSession(pool,{...session,amount_total:1},'acct_test'),'unmatched');
 assert.equal(await applyStripeSession(pool,session,'acct_wrong'),'unmatched');
 assert.equal(await holdStripeIntent(pool,'acct_test','pi_paid','evt_refund','charge.refunded'),true);
 assert.equal(await applyStripeSession(pool,session,'acct_test'),'paid');
 assert.equal(await applyStripeSession(pool,session,'acct_test'),'paid');
 const paid=(await pool.query('SELECT status,payment_hold FROM orders WHERE id=$1',[a])).rows[0];
 assert.deepEqual(paid,{status:'paid',payment_hold:true});
 const expired={id:'cs_expired',metadata:{order:b},amount_total:1000,currency:'eur',payment_status:'unpaid',status:'expired'};
 assert.equal(await applyStripeSession(pool,expired,'acct_test'),'cancelled');
 await applyStripeSession(pool,expired,'acct_test');
 assert.equal((await pool.query('SELECT stock FROM products WHERE id=$1',[product])).rows[0].stock,1);
 assert.equal(await expireManualOrders(pool,24),1);
 assert.equal(await expireManualOrders(pool,24),0);
 assert.equal((await pool.query('SELECT stock FROM products WHERE id=$1',[product])).rows[0].stock,2);
 assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1',[d])).rows[0].status,'pending');
 const key=licenseSecret('ab'.repeat(32)), raw='MF-'+'cd'.repeat(24);
 await pool.query("INSERT INTO entitlements(order_id,product_id,unit,kind,value) VALUES($1,$2,1,'license',$3)",[a,product,raw]);
 await migrateLicenses(pool,key);await migrateLicenses(pool,key);
 const encrypted=(await pool.query('SELECT value,license_hash FROM entitlements WHERE order_id=$1',[a])).rows[0];
 assert.notEqual(encrypted.value,raw);assert.equal(decryptLicense(encrypted.value,key),raw);assert.equal(encrypted.license_hash,licenseHash(raw));
 }finally{await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
});
