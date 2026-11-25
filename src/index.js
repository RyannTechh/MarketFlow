import 'dotenv/config';
import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, InteractionContextType } from 'discord.js';
import pg from 'pg';
import { cancelLocked } from './order-lifecycle.js';
import { startApi } from './api.js';
import { payments } from './payments.js';
import { commerce } from './commerce.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
const cmd = new SlashCommandBuilder().setName('store').setDescription('MarketFlow store').setContexts(InteractionContextType.Guild);
const str = (s,n,d,max=100) => s.addStringOption(o=>o.setName(n).setDescription(d).setMaxLength(max).setRequired(true));
const int = (s,n,d,max=100) => s.addIntegerOption(o=>o.setName(n).setDescription(d).setMinValue(1).setMaxValue(max).setRequired(true));
const pid = s=>str(s,'product','Product ID',19);
cmd.addSubcommand(s=>s.setName('setup').setDescription('Initialize this store').addStringOption(o=>o.setName('currency').setDescription('Currency').setRequired(true).addChoices(...['EUR','USD','GBP'].map(v=>({name:v,value:v})))));
cmd.addSubcommand(s=>int(int(str(str(s.setName('product-add').setDescription('Create product'),'name','Product name'),'category','Category'),'price','Price in cents',100000000),'stock','Initial stock',1000000));
cmd.addSubcommand(s=>pid(s.setName('product-stock').setDescription('Set stock')).addIntegerOption(o=>o.setName('stock').setDescription('Available stock').setMinValue(0).setMaxValue(1000000).setRequired(true)));
cmd.addSubcommand(s=>s.setName('browse').setDescription('Browse products').addIntegerOption(o=>o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(100000)));
cmd.addSubcommand(s=>int(pid(s.setName('cart-add').setDescription('Set product quantity in cart')),'quantity','Quantity'));
for(const [name,description] of [['cart','View cart'],['cart-clear','Clear cart'],['checkout','Reserve stock and create order'],['orders','View orders']]) cmd.addSubcommand(s=>s.setName(name).setDescription(description));
for(const name of ['approve','cancel']) cmd.addSubcommand(s=>str(s.setName(name).setDescription(name==='approve'?'Confirm independently verified payment':'Cancel unpaid order'),'order','Order UUID',36));
const adminActions = new Set(['setup','product-add','product-stock','approve','cancel']);
const money=(c,v)=>new Intl.NumberFormat('en',{style:'currency',currency:c}).format(Number(v)/100);
const clean=s=>String(s).replace(/[\r\n]/g,' ').replace(/[@`*_~|<>]/g,'');
const safeReply=async(i,content)=>i.editReply({content:String(content).slice(0,1900),allowedMentions:{parse:[]}});
const transaction=async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
class UserError extends Error {}
const market=commerce(pool,bot,transaction);
let paymentCommand;
bot.once('clientReady',async()=>{try{await bot.application.commands.set([cmd.toJSON(),market.command.toJSON(),paymentCommand.toJSON()]);console.log('MarketFlow online');}catch(e){console.error('Command registration failed',e.message);process.exit(1);}});
bot.on('interactionCreate',async i=>{
 if(!i.isChatInputCommand()||i.commandName!=='store'||!i.inGuild())return;
 const a=i.options.getSubcommand(), g=i.guildId,u=i.user.id;
 const s=n=>i.options.getString(n,true), n=k=>i.options.getInteger(k,true);
 const admin=i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
 try{
 await i.deferReply({flags:64});
 if(adminActions.has(a)&&!admin)throw new UserError('Manage Server permission required.');
 if(a==='setup'){
 const r=await pool.query('INSERT INTO stores(guild_id,currency) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING currency',[g,s('currency')]);
 return await safeReply(i,r.rowCount?'Store initialized.':'Store already initialized; currency is locked.');
 }
 const store=(await pool.query('SELECT currency FROM stores WHERE guild_id=$1',[g])).rows[0];
 if(!store)throw new UserError('Ask an administrator to run /store setup.');
 const c=store.currency;
 const product=()=>{const v=s('product');if(!/^[1-9][0-9]{0,18}$/.test(v)||BigInt(v)>9223372036854775807n)throw new UserError('Invalid product ID.');return v;};
 const order=()=>{const v=s('order');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))throw new UserError('Invalid order ID.');return v;};
 if(a==='product-add'){
 const r=await transaction(async db=>{await db.query('SELECT guild_id FROM stores WHERE guild_id=$1 FOR UPDATE',[g]);return db.query('INSERT INTO products(guild_id,name,category,price,stock) VALUES($1,$2,$3,$4,$5) RETURNING id',[g,s('name'),s('category'),n('price'),n('stock')]);});
 return await safeReply(i,'Product created: #'+r.rows[0].id);
 }
 if(a==='product-stock'){
 const r=await pool.query('UPDATE products SET stock=$3 WHERE guild_id=$1 AND id=$2',[g,product(),n('stock')]);
 return await safeReply(i,r.rowCount?'Stock updated.':'Product not found.');
 }
 if(a==='browse'){
 const page=i.options.getInteger('page')??1;
 const r=await pool.query('SELECT * FROM products WHERE guild_id=$1 ORDER BY id LIMIT 8 OFFSET $2',[g,(page-1)*8]);
 return await safeReply(i,r.rows.map(p=>'#'+p.id+' | '+clean(p.name)+' | '+clean(p.category)+' | '+money(c,p.price)+' | '+p.stock+' available').join('\n')||'No products on this page.');
 }
 if(a==='cart-add'||a==='cart-clear'||a==='checkout'){
 const result=await transaction(async db=>{
 // Serialize cart modifications per guild and user.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[g+':'+u]);
 if(a==='cart-clear'){await db.query('DELETE FROM carts WHERE guild_id=$1 AND user_id=$2',[g,u]);await db.query('DELETE FROM cart_coupons WHERE guild_id=$1 AND user_id=$2',[g,u]);return 'Cart cleared.';}
 if(a==='cart-add'){
 const p=(await db.query('SELECT stock FROM products WHERE guild_id=$1 AND id=$2',[g,product()])).rows[0];
 if(!p||p.stock<n('quantity'))throw new UserError('Product unavailable or insufficient stock.');
 await db.query('INSERT INTO carts VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,user_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity',[g,u,product(),n('quantity')]);return 'Cart updated.';
 }
 const rows=(await db.query('SELECT p.id,p.name,p.price,p.stock,c.quantity FROM carts c JOIN products p ON p.id=c.product_id AND p.guild_id=c.guild_id WHERE c.guild_id=$1 AND c.user_id=$2 ORDER BY p.id FOR UPDATE OF p',[g,u])).rows;
 if(!rows.length)throw new UserError('Your cart is empty.');
 let total=0n;
 for(const p of rows){if(p.stock<p.quantity)throw new UserError('Insufficient stock for '+clean(p.name));total+=BigInt(p.price)*BigInt(p.quantity);}
 const coupon=(await db.query('SELECT c.code,c.percent,c.remaining,c.expires_at FROM cart_coupons x JOIN coupons c ON c.guild_id=x.guild_id AND c.code=x.code WHERE x.guild_id=$1 AND x.user_id=$2 FOR UPDATE OF c',[g,u])).rows[0];
 let discount=0n;if(coupon){if(coupon.remaining<=0||new Date(coupon.expires_at)<=new Date())throw new UserError('Coupon expired or exhausted. Clear and rebuild cart.');discount=total*BigInt(coupon.percent)/100n;await db.query('UPDATE coupons SET remaining=remaining-1 WHERE guild_id=$1 AND code=$2',[g,coupon.code]);total-=discount;}
 const id=randomUUID();
 await db.query("INSERT INTO orders(id,guild_id,user_id,currency,total,status,coupon_code,discount) VALUES($1,$2,$3,$4,$5,'pending',$6,$7)",[id,g,u,c,total.toString(),coupon?.code??null,discount.toString()]);
 for(const p of rows){
 await db.query('UPDATE products SET stock=stock-$2 WHERE id=$1 AND guild_id=$3',[p.id,p.quantity,g]);
 const d=(await db.query('SELECT kind,value,days FROM delivery_config WHERE guild_id=$1 AND product_id=$2',[g,p.id])).rows[0];await db.query('INSERT INTO order_items(order_id,product_id,name,price,quantity,delivery_kind,delivery_value,delivery_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,p.id,p.name,p.price,p.quantity,d?.kind||'manual',d?.value||'',d?.days||0]);
 }
 await db.query('DELETE FROM carts WHERE guild_id=$1 AND user_id=$2',[g,u]);
 await db.query('DELETE FROM cart_coupons WHERE guild_id=$1 AND user_id=$2',[g,u]);
 return 'Order '+id+' | '+money(c,total)+' | Pending payment. Contact the store administrator for payment instructions. Stock reserved.';
 });
 return await safeReply(i,result);
 }
 if(a==='cart'){
 const r=await pool.query('SELECT p.name,p.price,c.quantity FROM carts c JOIN products p ON p.id=c.product_id AND p.guild_id=c.guild_id WHERE c.guild_id=$1 AND c.user_id=$2 ORDER BY p.id',[g,u]);
 return await safeReply(i,r.rows.map(p=>clean(p.name)+' x'+p.quantity+' | '+money(c,p.price*p.quantity)).join('\n')||'Cart empty.');
 }
 if(a==='orders'){
 const r=await pool.query('SELECT id,total,currency,status,payment_hold FROM orders WHERE guild_id=$1 AND ($2::boolean OR user_id=$3) ORDER BY created_at DESC LIMIT 15',[g,Boolean(admin),u]);
 return await safeReply(i,r.rows.map(o=>o.id+' | '+money(o.currency,o.total)+' | '+(o.payment_hold?'payment hold':o.status)).join('\n')||'No orders.');
 }
 if(a==='approve'||a==='cancel'){
 const result=await transaction(async db=>{
 const o=(await db.query('SELECT id,guild_id,status,coupon_code,payment_hold FROM orders WHERE guild_id=$1 AND id=$2 FOR UPDATE',[g,order()])).rows[0];
 if(!o||o.status!=='pending'||o.payment_hold)throw new UserError('Pending order not found.');
 if(a==='approve'){const payment=await db.query('SELECT 1 FROM payment_attempts WHERE order_id=$1',[o.id]);if(payment.rowCount)throw new UserError('Provider payment must be settled by verified webhook.');}
 if(a==='cancel'){
 const payment=await db.query('SELECT 1 FROM payment_attempts WHERE order_id=$1',[o.id]);if(payment.rowCount)throw new UserError('Payment attempt exists; reconcile provider before cancellation.');
 await cancelLocked(db,o);
 }else await db.query("UPDATE orders SET status='paid' WHERE id=$1",[o.id]);
 await db.query('INSERT INTO audit_events(guild_id,actor,action,detail) VALUES($1,$2,$3,$4)',[g,u,a,o.id]);
 return a==='approve'?'Payment marked verified. Automated items are available via /market claim; manual items require staff.':'Order cancelled; inventory restored.';
 });
 return await safeReply(i,result);
 }
 }catch(e){if(!(e instanceof UserError))console.error('Interaction failed:',e.code||e.name);if(i.deferred||i.replied)await safeReply(i,e instanceof UserError?e.message:'MarketFlow encountered an error.').catch(()=>{});}
});
if(!process.env.DISCORD_TOKEN||!process.env.DATABASE_URL)throw new Error('Configure DISCORD_TOKEN and DATABASE_URL.');
await pool.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
paymentCommand=startApi(pool,app=>payments(pool,bot,app));
await bot.login(process.env.DISCORD_TOKEN);
