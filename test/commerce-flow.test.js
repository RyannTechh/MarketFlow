import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { createStore } from '../src/store.js';
import { commerce } from '../src/commerce.js';
import { licenseHash } from '../src/licenses.js';

test('commerce delivery, branding, storefront and support with PostgreSQL and simulated Discord',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema='mf_commerce_'+randomUUID().replaceAll('-','');
 const admin=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await admin.connect();
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
 const prior=process.env.LICENSE_ENCRYPTION_KEY;process.env.LICENSE_ENCRYPTION_KEY='ab'.repeat(32);
 const guild='100000000000000001',other='100000000000000002',buyer='200000000000000001',staff='200000000000000002',stranger='200000000000000003',supportRole='300000000000000001',channelId='400000000000000001';
 const {handle,transaction}=createStore(pool);
 const bot=new EventEmitter();bot.user={id:'500000000000000001'};commerce(pool,bot,transaction);
 const sent=[],created=[],overwrites=[];
 const role={id:supportRole,position:2,managed:false,permissions:{bitfield:0n}};
 const fakeGuild={ownerId:staff,roles:{fetch:async id=>id===supportRole?role:null},channels:{create:async opts=>{created.push(opts);return {id:channelId,delete:async()=>{}};}}};
 async function invoke(action,opts={},privileged=false,u=buyer,g=guild,kind='market'){
 let response;const i={isChatInputCommand:()=>kind!=='button'&&kind!=='select',isButton:()=>kind==='button',isStringSelectMenu:()=>kind==='select',inGuild:()=>true,customId:kind==='button'?'mf:browse':kind==='select'?'mf:product':undefined,values:opts.values,commandName:kind,guildId:g,user:{id:u},guild:fakeGuild,member:{roles:{highest:{position:10}}},memberPermissions:{has:()=>privileged},channelId,channel:{send:async v=>sent.push(v),permissionOverwrites:{edit:async(...args)=>overwrites.push(args)}},options:{getSubcommand:()=>action,getString:k=>opts[k]??null,getInteger:k=>opts[k]??null,getRole:()=>role},deferReply:async()=>{i.deferred=true;},editReply:async v=>{response=typeof v==='string'?{content:v}:v;}};
 if(kind==='store')await handle(i);else await Promise.all(bot.listeners('interactionCreate').map(fn=>fn(i)));
 return response;
 }
 const text=async(...args)=>(await invoke(...args)).content;
 try{
 await admin.query('CREATE SCHEMA '+schema);
 await pool.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 await text('setup',{currency:'EUR'},true,staff,guild,'store');await text('setup',{currency:'EUR'},true,staff,other,'store');
 assert.match(await text('brand',{name:'Demo',color:'00FF00'}),/required/i);
 assert.match(await text('brand',{name:'Demo',color:'bad'},true,staff),/invalid/i);
 assert.match(await text('brand',{name:'Demo',color:'00FF00'},true,staff),/updated/i);
 assert.match(await text('panel',{},true,staff),/published/i);
 assert.equal(sent[0].embeds[0].toJSON().title,'Demo');
 for(const [name,kind,value] of [['License','license','none'],['Download','link','https://example.com/download']]){
 await text('product-add',{name,category:'Demo',price:1000,stock:5},true,staff,guild,'store');
 const id=String((await pool.query('SELECT id FROM products WHERE name=$1',[name])).rows[0].id);
 assert.match(await text('delivery',{product:id,kind,value,days:0},true,staff),/updated/i);
 }
 const products=(await pool.query('SELECT id FROM products ORDER BY id')).rows.map(p=>String(p.id));
 assert.match(await text('delivery',{product:products[1],kind:'link',value:'http://example.com',days:0},true,staff),/HTTPS/i);
 const menu=await invoke('browse',{},false,buyer,guild,'button');assert.equal(menu.components[0].toJSON().components[0].options.length,2);
 await text('select',{values:[products[0]]},false,buyer,guild,'select');
 await text('select',{values:[products[1]]},false,buyer,guild,'select');
 await text('select',{values:[products[0]]},false,buyer,guild,'select');
 assert.equal((await pool.query('SELECT sum(quantity)::int AS n FROM carts')).rows[0].n,2);
 await text('checkout',{},false,buyer,guild,'store');
 const order=(await pool.query('SELECT id FROM orders')).rows[0].id;
 assert.match(await text('claim',{order}),/not found/i);
 await text('approve',{order},true,staff,guild,'store');
 assert.match(await text('claim',{order},false,stranger),/not found/i);
 const first=await text('claim',{order}),key=first.match(/MF-[a-f0-9]{48}/)?.[0];assert.ok(key);assert.match(first,/https:\/\/example\.com\/download/);
 assert.equal(await text('claim',{order}),first);
 const entitlement=(await pool.query("SELECT value,license_hash FROM entitlements WHERE kind='license'")).rows[0];assert.notEqual(entitlement.value,key);assert.equal(entitlement.license_hash,licenseHash(key));
 assert.match(await text('license-revoke',{key},true,staff,other),/not found/i);
 assert.match(await text('license-revoke',{key},true,staff),/revoked/i);
 assert.ok(!(await text('claim',{order})).includes(key));
 assert.match(await text('support-role',{},true,staff),/configured/i);
 assert.match(await text('support',{order},false,stranger),/not found/i);
 assert.match(await text('support',{order}),/Support channel/i);assert.equal(created.length,1);assert.equal(created[0].permissionOverwrites.length,4);
 assert.match(await text('support',{order}),/already exists/i);
 assert.match(await text('support-close',{},false,buyer),/required/i);
 assert.match(await text('support-close',{},true,staff),/closed/i);assert.deepEqual(overwrites[0],[buyer,{SendMessages:false}]);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM support_cases WHERE closed_at IS NOT NULL')).rows[0].n,1);
 }finally{if(prior===undefined)delete process.env.LICENSE_ENCRYPTION_KEY;else process.env.LICENSE_ENCRYPTION_KEY=prior;await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
});
