// Discord and PostgreSQL cannot share a transaction. A session-level lock
// serializes cooperating workers, and ownership is committed before a role API call.
export async function reconcileRoleAccess(pool,bot,guildId,userId,roleId){
 const db=await pool.connect();
 let locked=false,destroy=false;
 const args=[guildId,userId,roleId],lock=guildId+':role:'+userId+':'+roleId;
 const activeSql="SELECT e.order_id,e.product_id,e.unit FROM entitlements e JOIN orders o ON o.id=e.order_id WHERE o.guild_id=$1 AND o.user_id=$2 AND e.kind='role' AND e.value=$3 AND o.status='paid' AND NOT o.payment_hold AND NOT e.revoked AND (e.expires_at IS NULL OR e.expires_at>now()) ORDER BY e.order_id,e.product_id,e.unit";
 const revokeSql="UPDATE entitlements e SET revoked=true FROM orders o WHERE e.order_id=o.id AND o.guild_id=$1 AND o.user_id=$2 AND e.kind='role' AND e.value=$3 AND (e.expires_at<=now() OR o.payment_hold OR o.status<>'paid')";
 const clearSql="UPDATE entitlements e SET role_granted=false FROM orders o WHERE e.order_id=o.id AND o.guild_id=$1 AND o.user_id=$2 AND e.kind='role' AND e.value=$3";
 try{
 await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock]);locked=true;
 const guild=await bot.guilds.fetch(guildId);
 let member;
 try{member=await guild.members.fetch({user:userId,force:true});}catch(e){if(e.code!==10007)throw e;}
 const role=await guild.roles.fetch(roleId,{force:true});
 const active=(await db.query(activeSql,args)).rows;
 const owned=(await db.query("SELECT 1 FROM entitlements e JOIN orders o ON o.id=e.order_id WHERE o.guild_id=$1 AND o.user_id=$2 AND e.kind='role' AND e.value=$3 AND e.role_granted LIMIT 1",args)).rowCount>0;
 if(!member||!role){
  await db.query(clearSql,args);await db.query(revokeSql,args);return 'unavailable';
 }
 if(active.length){
  if(role.id===guild.id||role.managed||!role.editable||role.permissions.bitfield!==0n)return 'unsafe';
  if(!member.roles.cache.has(role.id)){
   const first=active[0];
   // The flag is durable before sending the request; a crash cannot erase it.
   // Store owners must reserve this role exclusively for commerce delivery.
   await db.query('UPDATE entitlements SET role_granted=true WHERE order_id=$1 AND product_id=$2 AND unit=$3',[first.order_id,first.product_id,first.unit]);
   await member.roles.add(role);
  }
  await db.query("UPDATE entitlements e SET delivered_at=now() FROM orders o WHERE e.order_id=o.id AND o.guild_id=$1 AND o.user_id=$2 AND e.kind='role' AND e.value=$3 AND o.status='paid' AND NOT o.payment_hold AND NOT e.revoked AND (e.expires_at IS NULL OR e.expires_at>now())",args);
 }else if(owned){
  if(member.roles.cache.has(role.id)){
   if(!role.editable)throw new Error('Role hierarchy prevents access revocation');
   await member.roles.remove(role);
  }
  await db.query(clearSql,args);
 }
 await db.query(revokeSql,args);return active.length?'active':'inactive';
 }finally{
 if(locked){try{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}catch{destroy=true;}}
 else destroy=true;
 db.release(destroy);
 }
}
