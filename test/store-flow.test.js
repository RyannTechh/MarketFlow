import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createStore } from '../src/store.js';
import { commerce } from '../src/commerce.js';
import { EventEmitter } from 'node:events';

test('store command lifecycle with PostgreSQL and simulated Discord interactions',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema='mf_store_'+randomUUID().replaceAll('-','');
 const admin=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await admin.connect();
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 const guild='100000000000000001',other='100000000000000002',buyer='200000000000000001',staff='200000000000000002',buyer2='200000000000000003';
 const {command,handle,transaction}=createStore(pool);
 const bot=new EventEmitter();commerce(pool,bot,transaction);
 assert.equal(command.toJSON().options.length,11);
 async function invoke(action,opts={},adminPerm=false,g=guild,u=buyer,market=false){
 let response;const i={isChatInputCommand:()=>true,isButton:()=>false,isStringSelectMenu:()=>false,inGuild:()=>true,commandName:market?'market':'store',guildId:g,user:{id:u},memberPermissions:{has:()=>adminPerm},options:{getSubcommand:()=>action,getString:k=>opts[k]??null,getInteger:k=>opts[k]??null},deferReply:async()=>{i.deferred=true;},editReply:async v=>{response=typeof v==='string'?v:v.content;}};
 if(market)await Promise.all(bot.listeners('interactionCreate').map(fn=>fn(i)));else await handle(i);
 return response;
 }
 try{
 await admin.query('CREATE SCHEMA '+schema);
 await pool.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 assert.match(await invoke('setup',{currency:'EUR'}),/permission/i);
 assert.match(await invoke('setup',{currency:'EUR'},true,guild,staff),/initialized/i);
 assert.match(await invoke('setup',{currency:'USD'},true,guild,staff),/already/i);
 await invoke('setup',{currency:'USD'},true,other,staff);
 assert.match(await invoke('product-add',{name:'Test item',category:'Demo',price:1000,stock:3},true,guild,staff),/created/i);
 const product=String((await pool.query('SELECT id FROM products WHERE guild_id=$1',[guild])).rows[0].id);
 assert.match(await invoke('browse'),/Test item/);
 assert.match(await invoke('browse',{},false,other),/No products/);
 assert.match(await invoke('product-stock',{product,stock:2},true,guild,staff),/updated/i);
 assert.match(await invoke('cart-add',{product,quantity:3}),/insufficient/i);
 assert.match(await invoke('cart-add',{product,quantity:1},false,other),/unavailable/i);
 assert.match(await invoke('cart-add',{product,quantity:2}),/updated/i);
 assert.match(await invoke('cart'),/Test item x2/);
 assert.match(await invoke('cart-clear'),/cleared/i);
 assert.match(await invoke('checkout'),/empty/i);
 await invoke('cart-add',{product,quantity:1});
 await invoke('cart-add',{product,quantity:2},false,guild,buyer2);
 assert.match(await invoke('coupon-create',{code:'SAVE',percent:25,uses:1,days:1},true,guild,staff,true),/created/i);
 assert.match(await invoke('coupon',{code:'SAVE'},false,guild,buyer,true),/applied/i);
 const checkout=await invoke('checkout');
 assert.match(checkout,/Pending payment/);
 const order=(await pool.query('SELECT * FROM orders WHERE user_id=$1',[buyer])).rows[0];
 assert.equal(String(order.total),'750');
 assert.match(await invoke('checkout',{},false,guild,buyer2),/Insufficient stock/i);
 assert.match(await invoke('orders',{},false,guild,buyer2),/No orders/i);
 assert.match(await invoke('orders'),new RegExp(order.id));
 assert.match(await invoke('approve',{order:order.id},false),/permission/i);
 assert.match(await invoke('cancel',{order:order.id},true,other,staff),/not found/i);
 assert.match(await invoke('cancel',{order:order.id},true,guild,staff),/cancelled/i);
 assert.equal((await pool.query('SELECT stock FROM products WHERE id=$1',[product])).rows[0].stock,2);
 assert.equal((await pool.query("SELECT remaining FROM coupons WHERE code='SAVE'")).rows[0].remaining,1);
 assert.match(await invoke('checkout',{},false,guild,buyer2),/Pending payment/);
 const second=(await pool.query('SELECT * FROM orders WHERE user_id=$1',[buyer2])).rows[0];
 assert.match(await invoke('approve',{order:second.id},true,guild,staff),/verified/i);
 assert.match(await invoke('cancel',{order:second.id},true,guild,staff),/not found/i);
 assert.match(await invoke('analytics',{},true,guild,staff,true),/Paid orders: 1/);
 assert.equal((await pool.query('SELECT stock FROM products WHERE id=$1',[product])).rows[0].stock,0);
 }finally{await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
});
