import Stripe from 'stripe';
import express from 'express';
import { inTransaction, applyStripeSession, holdStripeIntent, expireManualOrders } from './order-lifecycle.js';
import { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits } from 'discord.js';
export function payments(pool,bot,app){
 const key=process.env.STRIPE_SECRET_KEY||'';
 const stripe=key.startsWith('sk_test_')?new Stripe(key,{timeout:15000,maxNetworkRetries:1}):null;
 const base=process.env.PUBLIC_BASE_URL;
 const command=new SlashCommandBuilder().setName('payment').setDescription('MarketFlow payment services').setContexts(InteractionContextType.Guild)
 .addSubcommand(s=>s.setName('stripe-account').setDescription('Configure connected Stripe account').addStringOption(o=>o.setName('account').setDescription('Connected account ID').setRequired(true)))
 .addSubcommand(s=>s.setName('stripe').setDescription('Pay your order with Stripe').addStringOption(o=>o.setName('order').setDescription('Order UUID').setRequired(true)));
 // Raw-body middleware must run before JSON parsing.
 app.post('/webhooks/stripe',express.raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
 if(!stripe||!process.env.STRIPE_WEBHOOK_SECRET)return res.sendStatus(503);
 let event;try{event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature'),process.env.STRIPE_WEBHOOK_SECRET);}catch{return res.sendStatus(400);}
 if(event.livemode)return res.sendStatus(400);
 try{
 const obj=event.data.object,account=event.account||'';
 if(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)){
 const result=await applyStripeSession(pool,obj,account,event.type==='checkout.session.async_payment_failed');
 return res.sendStatus(['unmatched','conflict'].includes(result)?409:200);
 }
 if(['charge.refunded','charge.dispute.created'].includes(event.type)){
 const intent=typeof obj.payment_intent==='string'?obj.payment_intent:obj.payment_intent?.id;
 await holdStripeIntent(pool,account,intent,event.id,event.type);
 }
 return res.sendStatus(200);
 }catch(e){console.error('Stripe settlement failed',e.code||e.name);return res.sendStatus(500);}
 });
 bot.on('interactionCreate',async i=>{
 if(!i.isChatInputCommand()||i.commandName!=='payment'||!i.inGuild())return;
 try{await i.deferReply({flags:64});const reply=t=>i.editReply({content:t,allowedMentions:{parse:[]}});if(!stripe||!base||!base.startsWith('https://')||!process.env.STRIPE_WEBHOOK_SECRET)return reply('Stripe unavailable. Operator configuration required.');
 const g=i.guildId,u=i.user.id,a=i.options.getSubcommand();
 if(a==='stripe-account'){if(i.guild.ownerId!==u)return reply('Server owner only.');const account=i.options.getString('account',true);if(!/^acct_[A-Za-z0-9]+$/.test(account))return reply('Invalid account.');const allowed=JSON.parse(process.env.STRIPE_ACCOUNT_ALLOWLIST||'{}');if(allowed[g]!==account)return reply('Account must be verified and approved by the platform operator.');const acct=await stripe.accounts.retrieve(account);if(!acct.charges_enabled)return reply('Account cannot accept payments.');await pool.query('INSERT INTO store_settings(guild_id,stripe_account) VALUES($1,$2) ON CONFLICT(guild_id) DO UPDATE SET stripe_account=EXCLUDED.stripe_account',[g,account]);return reply('Stripe account configured.');}
 const id=i.options.getString('order',true);
 const reserved=await inTransaction(pool,async db=>{
 const order=(await db.query("SELECT * FROM orders WHERE id=$1 AND guild_id=$2 AND user_id=$3 AND status='pending' AND NOT payment_hold FOR UPDATE",[id,g,u])).rows[0];if(!order)throw new Error('Order unavailable');
 const account=(await db.query('SELECT stripe_account FROM store_settings WHERE guild_id=$1',[g])).rows[0]?.stripe_account;
 if(!account||JSON.parse(process.env.STRIPE_ACCOUNT_ALLOWLIST||'{}')[g]!==account)throw new Error('Account unavailable');
 if(BigInt(order.total)<1n||BigInt(order.total)>99999999n)throw new Error('Unsupported amount');
 await db.query("INSERT INTO payment_attempts(order_id,provider,account) VALUES($1,'stripe',$2) ON CONFLICT DO NOTHING",[id,account]);
 const attempt=(await db.query('SELECT * FROM payment_attempts WHERE order_id=$1',[id])).rows[0];
 if(attempt.provider!=='stripe'||attempt.account!==account)throw new Error('Existing payment attempt');
 return {order,attempt,account};
 });
 const {order,attempt,account}=reserved;
 let session;
 if(attempt.external_id){session=await stripe.checkout.sessions.retrieve(attempt.external_id,{stripeAccount:account});}
 else{
 if(Date.now()-new Date(attempt.created_at).getTime()>20*3600000)throw new Error('Payment attempt requires operator reconciliation');
 session=await stripe.checkout.sessions.create({mode:'payment',line_items:[{quantity:1,price_data:{currency:order.currency.toLowerCase(),unit_amount:Number(order.total),product_data:{name:'MarketFlow order '+id}}}],success_url:base+'/payment/success',cancel_url:base+'/payment/cancel',metadata:{order:id}},{stripeAccount:account,idempotencyKey:'marketflow-'+id});
 const saved=await pool.query("UPDATE payment_attempts SET external_id=$2,checkout_url=$3 WHERE order_id=$1 AND (external_id IS NULL OR external_id=$2) RETURNING order_id",[id,session.id,session.url]);
 if(!saved.rowCount)throw new Error('Conflicting provider session');
 }
 const result=await applyStripeSession(pool,session,account);
 if(result==='paid')return reply('Payment confirmed.');
 if(result==='cancelled'||session.status!=='open'||!session.url)return reply('Checkout no longer open. Check your order status.');
 return reply('Secure Stripe test checkout: '+session.url);
 }catch(e){console.error('Payment command failed',e.code||e.name);if(i.deferred)await i.editReply('Payment unavailable. Contact the store.').catch(()=>{});}
 });
 let busy=false;const sweep=async()=>{if(busy)return;busy=true;try{await expireManualOrders(pool,Number(process.env.MANUAL_ORDER_EXPIRY_HOURS||0));if(stripe){const rows=(await pool.query("SELECT p.order_id,p.external_id,p.account FROM payment_attempts p JOIN orders o ON o.id=p.order_id WHERE p.provider='stripe' AND p.external_id IS NOT NULL AND o.status='pending' ORDER BY p.last_checked_at NULLS FIRST LIMIT 25")).rows;for(const p of rows){try{await pool.query('UPDATE payment_attempts SET last_checked_at=now() WHERE order_id=$1',[p.order_id]);const session=await stripe.checkout.sessions.retrieve(p.external_id,{stripeAccount:p.account});await applyStripeSession(pool,session,p.account);}catch(e){console.error('Stripe reconciliation failed',e.code||e.name);}}}}catch(e){console.error('Order cleanup failed',e.code||e.name);}finally{busy=false;}};
 bot.once('clientReady',()=>{void sweep();setInterval(sweep,60000).unref();});return command;
}
