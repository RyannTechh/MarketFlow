// All state transitions lock the order before changing inventory or payment status.
export async function inTransaction(pool,fn){
 const db=await pool.connect();
 try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}
 catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
export async function cancelLocked(db,order){
 if(order.status!=='pending')return false;
 const items=(await db.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1 ORDER BY product_id',[order.id])).rows;
 for(const item of items)await db.query('UPDATE products SET stock=stock+$2 WHERE id=$1 AND guild_id=$3',[item.product_id,item.quantity,order.guild_id]);
 if(order.coupon_code)await db.query('UPDATE coupons SET remaining=remaining+1 WHERE guild_id=$1 AND code=$2',[order.guild_id,order.coupon_code]);
 await db.query("UPDATE orders SET status='cancelled' WHERE id=$1",[order.id]);
 return true;
}
export async function expireManualOrders(pool,hours){
 if(!Number.isInteger(hours)||hours<1||hours>720)return 0;
 return inTransaction(pool,async db=>{
 const orders=(await db.query("SELECT o.* FROM orders o WHERE o.status='pending' AND o.created_at<now()-$1*interval '1 hour' AND NOT EXISTS(SELECT 1 FROM payment_attempts p WHERE p.order_id=o.id) ORDER BY o.created_at LIMIT 25 FOR UPDATE OF o SKIP LOCKED",[hours])).rows;
 let count=0;
 for(const o of orders){
 // Recheck in a new statement after acquiring the order lock.
 if((await db.query('SELECT 1 FROM payment_attempts WHERE order_id=$1',[o.id])).rowCount)continue;
 if(await cancelLocked(db,o))count++;
 }
 return count;
 });
}
export function sessionMatches(order,attempt,session,account){
 return Boolean(order&&attempt&&session&&attempt.provider==='stripe'&&attempt.account===account&&attempt.external_id===session.id&&session.metadata?.order===order.id&&String(session.amount_total)===String(order.total)&&session.currency===order.currency.toLowerCase());
}
export async function applyStripeSession(pool,session,account,terminalFailure=false){
 if(!account||!session?.id)return 'ignored';
 const intent=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
 return inTransaction(pool,async db=>{
 if(intent)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[account+':'+intent]);
 const row=(await db.query("SELECT o.*,p.provider,p.account,p.external_id FROM orders o JOIN payment_attempts p ON p.order_id=o.id WHERE p.external_id=$1 AND p.account=$2 FOR UPDATE OF o",[session.id,account])).rows[0];
 if(!sessionMatches(row,row,session,account))return 'unmatched';
 if(intent)await db.query('UPDATE payment_attempts SET payment_intent_id=$2 WHERE order_id=$1',[row.id,intent]);
 if(session.payment_status==='paid'){
 if(!intent)return 'unmatched';
 if(row.status==='cancelled')return 'conflict';
 const incident=(await db.query('SELECT reason FROM payment_incidents WHERE account=$1 AND payment_intent_id=$2 LIMIT 1',[account,intent])).rows[0];
 await db.query("UPDATE orders SET status='paid',payment_hold=payment_hold OR $2,payment_hold_reason=COALESCE(payment_hold_reason,$3) WHERE id=$1",[row.id,Boolean(incident),incident?.reason??null]);
 return 'paid';
 }
 if(session.status==='expired'||terminalFailure){
 if(row.status==='pending'){await cancelLocked(db,row);return 'cancelled';}
 }
 return 'ignored';
 });
}
export async function holdStripeIntent(pool,account,intent,eventId,reason){
 if(!account||!intent||!eventId)return false;
 return inTransaction(pool,async db=>{
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[account+':'+intent]);
 await db.query('INSERT INTO payment_incidents(account,payment_intent_id,event_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[account,intent,eventId,reason]);
 await db.query("UPDATE orders o SET payment_hold=true,payment_hold_reason=$3 FROM payment_attempts p WHERE p.order_id=o.id AND p.account=$1 AND p.payment_intent_id=$2",[account,intent,reason]);
 return true;
 });
}
