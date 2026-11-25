import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRoleAccess } from '../src/role-access.js';
function fixture({active=true,owned=false,present=false,privileged=false,failAdd=false}={}){
 const calls=[];
 const role={id:'role',managed:false,editable:true,permissions:{bitfield:privileged?8n:0n}};
 const member={roles:{cache:{has:()=>present},add:async()=>{calls.push('add');if(failAdd)throw new Error('Discord unavailable');present=true;},remove:async()=>{calls.push('remove');present=false;}}};
 const bot={guilds:{fetch:async()=>({id:'guild',roles:{fetch:async()=>role},members:{fetch:async()=>member}})}};
 const db={release:destroy=>calls.push('release:'+destroy),query:async(sql,args)=>{
 if(sql.includes('pg_advisory_unlock'))calls.push('unlock');
 else if(sql.includes('pg_advisory_lock'))calls.push('lock');
 else if(sql.startsWith('SELECT e.order_id'))return {rows:active?[{order_id:'order',product_id:1,unit:1}]:[]};
 else if(sql.startsWith('SELECT 1'))return {rowCount:owned?1:0};
 else if(sql.includes('role_granted=true')){owned=true;calls.push('ownership');}
 else if(sql.includes('role_granted=false')){owned=false;calls.push('clear');}
 else if(sql.includes('delivered_at'))calls.push('delivered');
 else if(sql.includes('revoked=true'))calls.push('revoke');
 return {rows:[],rowCount:0};
 }};
 return {pool:{connect:async()=>db},bot,calls};
}
const run=x=>reconcileRoleAccess(x.pool,x.bot,'guild','user','role');
test('grant records durable ownership before calling Discord',async()=>{
 const x=fixture();assert.equal(await run(x),'active');assert.ok(x.calls.indexOf('ownership')<x.calls.indexOf('add'));assert.ok(x.calls.includes('delivered'));assert.ok(x.calls.includes('unlock'));
});
test('overlapping paid entitlements keep an already granted role',async()=>{
 const x=fixture({active:true,owned:true,present:true});assert.equal(await run(x),'active');assert.ok(!x.calls.includes('remove'));assert.ok(!x.calls.includes('clear'));
});
test('last expired entitlement removes only a managed purchase role',async()=>{
 const x=fixture({active:false,owned:true,present:true});assert.equal(await run(x),'inactive');assert.ok(x.calls.includes('remove'));assert.ok(x.calls.includes('clear'));
 const external=fixture({active:false,owned:false,present:true});await run(external);assert.ok(!external.calls.includes('remove'));
});
test('privileged roles cannot be granted and failed Discord calls release locks',async()=>{
 const unsafe=fixture({privileged:true});assert.equal(await run(unsafe),'unsafe');assert.ok(!unsafe.calls.includes('add'));
 const failed=fixture({failAdd:true});await assert.rejects(run(failed),/Discord unavailable/);assert.ok(failed.calls.includes('ownership'));assert.ok(failed.calls.includes('unlock'));assert.ok(!failed.calls.includes('delivered'));
});
