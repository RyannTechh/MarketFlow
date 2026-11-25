import Stripe from 'stripe';
import express from 'express';
import { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits } from 'discord.js';
export function payments(pool,bot,app){
 const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
 const base=process.env.PUBLIC_BASE_URL;
 const command=new SlashCommandBuilder().setName('payment').setDescription('MarketFlow payment services').setContexts(InteractionContextType.Guild)
 .addSubcommand(s=>s.setName('stripe-account').setDescription('Configure connected Stripe account').addStringOption(o=>o.setName('account').setDescription('Connected account ID').setRequired(true)))
 .addSubcommand(s=>s.setName('stripe').setDescription('Pay your order with Stripe').addStringOption(o=>o.setName('order').setDescription('Order UUID').setRequired(true)));
 // Raw-body middleware must run before JSON parsing.
 app.post('/webhooks/stripe',express.raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
 if(!stripe||!process.env.STRIPE_WEBHOOK_SECRET)return res.sendStatus(503);
 let event;try{event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature'),process.env.STRIPE_WEBHOOK_SECRET);}catch{return res.sendStatus(400);}
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))return res.sendStatus(200);
 const s=event.data.object;if(s.payment_status!=='paid')return res.sendStatus(200);
 try{const r=await pool.query("UPDATE orders o SET status='paid' FROM payment_attempts p WHERE p.order_id=o.id AND p.provider='stripe' AND p.account=$1 AND p.external_id=$2 AND o.id::text=$3 AND o.total=$4 AND lower(o.currency)=$5 AND o.status='pending' RETURNING o.id",[event.account||'',s.id,s.metadata?.order||'',s.amount_total,s.currency]);if(!r.rowCount){const known=await pool.query("SELECT 1 FROM payment_attempts p JOIN orders o ON o.id=p.order_id WHERE p.account=$1 AND p.external_id=$2 AND o.status='paid' AND o.id::text=$3 AND o.total=$4 AND lower(o.currency)=$5",[event.account||'',s.id,s.metadata?.order||'',s.amount_total,s.currency]);if(!known.rowCount)return res.sendStatus(409);}res.sendStatus(200);}catch(e){console.error('Stripe settlement failed',e.code||e.name);res.sendStatus(500);}
 });
 bot.on('interactionCreate',async i=>{
 if(!i.isChatInputCommand()||i.commandName!=='payment'||!i.inGuild())return;
 try{await i.deferReply({flags:64});const reply=t=>i.editReply({content:t,allowedMentions:{parse:[]}});if(!stripe||!base||!base.startsWith('https://')||!process.env.STRIPE_WEBHOOK_SECRET)return reply('Stripe unavailable. Operator configuration required.');
 const g=i.guildId,u=i.user.id,a=i.options.getSubcommand();
 if(a==='stripe-account'){if(i.guild.ownerId!==u)return reply('Server owner only.');const account=i.options.getString('account',true);if(!/^acct_[A-Za-z0-9]+$/.test(account))return reply('Invalid account.');const allowed=JSON.parse(process.env.STRIPE_ACCOUNT_ALLOWLIST||'{}');if(allowed[g]!==account)return reply('Account must be verified and approved by the platform operator.');const acct=await stripe.accounts.retrieve(account);if(!acct.charges_enabled)return reply('Account cannot accept payments.');await pool.query('INSERT INTO store_settings(guild_id,stripe_account) VALUES($1,$2) ON CONFLICT(guild_id) DO UPDATE SET stripe_account=EXCLUDED.stripe_account',[g,account]);return reply('Stripe account configured.');}
 const id=i.options.getString('order',true);const db=await pool.connect();let url;
 try{await db.query('BEGIN');const order=(await db.query("SELECT * FROM orders WHERE id=$1 AND guild_id=$2 AND user_id=$3 AND status='pending' FOR UPDATE",[id,g,u])).rows[0];if(!order)throw new Error('Order unavailable');const account=(await db.query('SELECT stripe_account FROM store_settings WHERE guild_id=$1',[g])).rows[0]?.stripe_account;if(!account||JSON.parse(process.env.STRIPE_ACCOUNT_ALLOWLIST||'{}')[g]!==account)throw new Error('Account unavailable');
 const old=(await db.query('SELECT * FROM payment_attempts WHERE order_id=$1',[id])).rows[0];if(old){if(old.provider!=='stripe'||old.account!==account||!old.checkout_url)throw new Error('Existing payment attempt');url=old.checkout_url;}else{const session=await stripe.checkout.sessions.create({mode:'payment',line_items:[{quantity:1,price_data:{currency:order.currency.toLowerCase(),unit_amount:Number(order.total),product_data:{name:'MarketFlow order '+id}}}],success_url:base+'/payment/success',cancel_url:base+'/payment/cancel',metadata:{order:id}},{stripeAccount:account,idempotencyKey:'marketflow-'+id});url=session.url;await db.query('INSERT INTO payment_attempts(order_id,provider,account,external_id,checkout_url) VALUES($1,$2,$3,$4,$5)',[id,'stripe',account,session.id,url]);}await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}return reply('Secure Stripe checkout: '+url);
 }catch(e){console.error('Payment command failed',e.code||e.name);if(i.deferred)await i.editReply('Payment unavailable. Contact the store.').catch(()=>{});}
 });return command;
}
