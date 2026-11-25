import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
test('schema is repeatable and rejects cross-store carts',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const db=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await db.connect();
 try{await db.query('BEGIN');await db.query('CREATE SCHEMA marketflow_test');await db.query('SET LOCAL search_path TO marketflow_test');
 const sql=await readFile(new URL('../schema.sql',import.meta.url),'utf8');await db.query(sql);await db.query(sql);
 await db.query("INSERT INTO stores(guild_id,currency) VALUES ('a','EUR'),('b','USD')");
 const p=(await db.query("INSERT INTO products(guild_id,name,category,price,stock) VALUES('a','test','test',100,1) RETURNING id")).rows[0];
 await db.query('SAVEPOINT isolation');await assert.rejects(db.query("INSERT INTO carts VALUES('b','user',$1,1)",[p.id]),{code:'23503'});await db.query('ROLLBACK TO SAVEPOINT isolation');
 await db.query("INSERT INTO carts VALUES('a','user',$1,1)",[p.id]);
 await db.query('SAVEPOINT stock');await assert.rejects(db.query('UPDATE products SET stock=-1 WHERE id=$1',[p.id]),{code:'23514'});await db.query('ROLLBACK TO SAVEPOINT stock');
 }finally{await db.query('ROLLBACK');await db.end();}
});
