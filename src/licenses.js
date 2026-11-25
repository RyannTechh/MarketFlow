import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export const licenseHash=key=>createHash('sha256').update(key).digest('hex');
export function licenseSecret(raw=process.env.LICENSE_ENCRYPTION_KEY){
 if(typeof raw!=='string'||! /^[0-9a-f]{64}$/i.test(raw))throw new Error('LICENSE_ENCRYPTION_KEY must be 64 hexadecimal characters');
 return Buffer.from(raw,'hex');
}
export function encryptLicense(value,key){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
 return [iv.toString('hex'),cipher.getAuthTag().toString('hex'),data.toString('hex')].join('.');
}
export function decryptLicense(value,key){
 const [iv,tag,data]=value.split('.');
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));
 decipher.setAuthTag(Buffer.from(tag,'hex'));
 return Buffer.concat([decipher.update(Buffer.from(data,'hex')),decipher.final()]).toString('utf8');
}
export async function migrateLicenses(pool,key){
 const db=await pool.connect();
 try{
 await db.query('BEGIN');
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('marketflow-license-migration',0))");
 const rows=(await db.query("SELECT order_id,product_id,unit,value FROM entitlements WHERE kind='license' AND license_hash IS NULL FOR UPDATE")).rows;
 for(const row of rows)await db.query("UPDATE entitlements SET value=$4,license_hash=$5 WHERE order_id=$1 AND product_id=$2 AND unit=$3",[row.order_id,row.product_id,row.unit,encryptLicense(row.value,key),licenseHash(row.value)]);
 await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
