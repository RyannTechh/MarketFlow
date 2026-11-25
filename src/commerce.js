import { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType } from 'discord.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
export const hash = v=>createHash('sha256').update(v).digest('hex');
export function commerce(pool,bot,transaction){
 const command=new SlashCommandBuilder().setName('market').setDescription('MarketFlow advanced commerce').setContexts(InteractionContextType.Guild);
 const str=(s,n,d,max=100)=>s.addStringOption(o=>o.setName(n).setDescription(d).setRequired(true).setMaxLength(max));
 const num=(s,n,d,min,max)=>s.addIntegerOption(o=>o.setName(n).setDescription(d).setRequired(true).setMinValue(min).setMaxValue(max));
 const sub=(n,d,f=s=>s)=>command.addSubcommand(s=>f(s.setName(n).setDescription(d)));
 sub('panel','Publish an interactive storefront');
 sub('brand','Set storefront branding',s=>str(str(s,'name','Store name'),'color','Six-digit hex color',6));
 sub('coupon-create','Create discount code',s=>num(num(num(str(s,'code','Coupon code',32),'percent','Discount percent',1,99),'uses','Maximum uses',1,100000),'days','Validity days',1,365));
 sub('coupon','Apply discount to your next checkout',s=>str(s,'code','Coupon code',32));
 sub('delivery','Configure product delivery',s=>num(str(str(str(s,'product','Product ID',19),'kind','link, role, license or manual',10),'value','HTTPS link, role ID, or none',500),'days','Access duration; zero means permanent',0,3650));
 sub('claim','Retrieve your paid order deliveries',s=>str(s,'order','Order UUID',36));
 sub('analytics','View store sales statistics');
 sub('support','Open a private purchase support channel',s=>str(s,'order','Order UUID',36));
 sub('support-close','Close current support channel');
 sub('support-role','Configure support staff role',s=>s.addRoleOption(o=>o.setName('role').setDescription('Support staff role').setRequired(true)));
 sub('license-revoke','Revoke a license key',s=>str(s,'key','License key',100));
 sub('plan','View store plan');
 sub('premium','Set premium duration (bot owner only)',s=>num(s,'days','Premium duration in days',0,3650));
 const adminSet=new Set(['panel','brand','coupon-create','delivery','analytics','support-close','support-role','license-revoke','premium']);
 const q=(sql,args)=>pool.query(sql,args);
 const settings=async g=>(await q('SELECT * FROM store_settings WHERE guild_id=$1',[g])).rows[0]||{};
 const audit=(g,u,a,d='')=>q('INSERT INTO audit_events(guild_id,actor,action,detail) VALUES($1,$2,$3,$4)',[g,u,a,d]);
 const fmt=(c,n)=>new Intl.NumberFormat('en',{style:'currency',currency:c}).format(Number(n)/100);
 const reply=(i,t)=>i.editReply({content:t.slice(0,1900),allowedMentions:{parse:[]}});
 const premium=async g=>{const x=await settings(g);return x.premium_until&&new Date(x.premium_until)>new Date();};
 async function fulfill(id){
  return transaction(async db=>{
   const order=(await db.query("SELECT * FROM orders WHERE id=$1 AND status='paid' FOR UPDATE",[id])).rows[0];
   if(!order)return;
   const items=(await db.query('SELECT * FROM order_items WHERE order_id=$1',[id])).rows;
   for(const p of items){if(p.delivery_kind==='manual')continue;
    for(let unit=1;unit<=p.quantity;unit++){
     const value=p.delivery_kind==='license'?'MF-'+randomBytes(24).toString('hex'):p.delivery_value;
     await db.query("INSERT INTO entitlements(order_id,product_id,unit,kind,value,expires_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6::integer=0 THEN NULL ELSE now()+$6*interval '1 day' END) ON CONFLICT DO NOTHING",[id,p.product_id,unit,p.delivery_kind,value,p.delivery_days]);
    }
   }
  });
 }
 async function grantRoles(id){
  const rows=(await q("SELECT e.*,o.guild_id,o.user_id FROM entitlements e JOIN orders o ON o.id=e.order_id WHERE o.id=$1 AND o.status='paid' AND e.kind='role' AND e.revoked=false AND (e.expires_at IS NULL OR e.expires_at>now())",[id])).rows;
  for(const x of rows){try{const guild=await bot.guilds.fetch(x.guild_id);const member=await guild.members.fetch(x.user_id);const role=await guild.roles.fetch(x.value);if(!role||role.id===guild.id||role.managed||!role.editable||role.permissions.bitfield!==0n)continue;if(!member.roles.cache.has(role.id)){await member.roles.add(role);await q('UPDATE entitlements SET role_granted=true WHERE order_id=$1 AND product_id=$2 AND unit=$3',[id,x.product_id,x.unit]);}await q('UPDATE entitlements SET delivered_at=now() WHERE order_id=$1 AND product_id=$2 AND unit=$3',[id,x.product_id,x.unit]);}catch(e){console.error('Role fulfillment failed',e.code||e.name);}}
 }
 async function sweep(){
  const paid=(await q("SELECT DISTINCT o.id FROM orders o JOIN order_items p ON p.order_id=o.id WHERE o.status='paid' AND p.delivery_kind<>'manual' AND NOT EXISTS(SELECT 1 FROM entitlements e WHERE e.order_id=o.id AND e.product_id=p.product_id) LIMIT 50",[])).rows;
  for(const o of paid){await fulfill(o.id);await grantRoles(o.id);}
  const roles=(await q("SELECT DISTINCT o.id FROM orders o JOIN entitlements e ON e.order_id=o.id WHERE o.status='paid' AND e.kind='role' AND e.delivered_at IS NULL AND NOT e.revoked AND (e.expires_at IS NULL OR e.expires_at>now()) LIMIT 50",[])).rows;
  for(const o of roles)await grantRoles(o.id);
  const expired=(await q("SELECT e.*,o.guild_id,o.user_id FROM entitlements e JOIN orders o ON o.id=e.order_id WHERE e.kind='role' AND e.expires_at<=now() AND NOT e.revoked LIMIT 50",[])).rows;
  for(const e of expired){try{const active=await q("SELECT 1 FROM entitlements x JOIN orders o ON o.id=x.order_id WHERE o.guild_id=$1 AND o.user_id=$2 AND x.kind='role' AND x.value=$3 AND NOT x.revoked AND (x.expires_at IS NULL OR x.expires_at>now()) LIMIT 1",[e.guild_id,e.user_id,e.value]);if(!active.rowCount&&e.role_granted){const guild=await bot.guilds.fetch(e.guild_id);const member=await guild.members.fetch(e.user_id).catch(()=>null);if(member)await member.roles.remove(e.value);}await q('UPDATE entitlements SET revoked=true WHERE order_id=$1 AND product_id=$2 AND unit=$3',[e.order_id,e.product_id,e.unit]);}catch(err){console.error('Expiry failed',err.code||err.name);}}
 }
 let running=false;bot.once('clientReady',()=>{const tick=async()=>{if(running)return;running=true;try{await sweep();}catch(e){console.error('Fulfillment sweep failed',e.code||e.name);}finally{running=false;}};void tick();setInterval(tick,60000).unref();});
 bot.on('interactionCreate',async i=>{
  if(!i.inGuild())return;
  const isPanel=i.isButton()&&i.customId==='mf:browse',isSelect=i.isStringSelectMenu()&&i.customId==='mf:product';
  if(!isPanel&&!isSelect&&(!i.isChatInputCommand()||i.commandName!=='market'))return;
  const g=i.guildId,u=i.user.id,a=isPanel?'browse':isSelect?'select':i.options.getSubcommand(),s=n=>i.options.getString(n,true),n=k=>i.options.getInteger(k,true);
  try{await i.deferReply({flags:64});
   const store=(await q('SELECT * FROM stores WHERE guild_id=$1',[g])).rows[0];if(!store)return reply(i,'Initialize with /store setup first.');
   const st=await settings(g),admin=i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
   if(adminSet.has(a)&&a!=='premium'&&!admin)return reply(i,'Manage Server required.');
   if(a==='panel'){const embed=new EmbedBuilder().setTitle(st.brand||'MarketFlow').setColor(parseInt(st.color||'5865F2',16)).setDescription('Browse products and add them to your cart. Use /store checkout to place an order.');await i.channel.send({embeds:[embed],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mf:browse').setLabel('Browse products').setStyle(ButtonStyle.Primary))]});return reply(i,'Storefront published.');}
   if(a==='browse'){const products=(await q('SELECT * FROM products WHERE guild_id=$1 AND stock>0 ORDER BY id LIMIT 25',[g])).rows;if(!products.length)return reply(i,'No products in stock.');return i.editReply({content:'Select a product to add one unit to your cart. Use /store browse for all products.',components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('mf:product').setPlaceholder('Choose a product').addOptions(products.map(p=>({label:p.name.slice(0,100),value:String(p.id),description:fmt(store.currency,p.price)+' | '+p.stock+' in stock'}))))]});}
   if(a==='select'){const id=i.values[0];await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[g+':'+u]);await db.query('INSERT INTO carts(guild_id,user_id,product_id,quantity) SELECT guild_id,$2,id,1 FROM products WHERE guild_id=$1 AND id=$3 AND stock>0 ON CONFLICT(guild_id,user_id,product_id) DO NOTHING',[g,u,id]);});return reply(i,'Selection processed. Check /store cart.');}
   if(a==='brand'){if(!await premium(g))return reply(i,'Premium required.');if(!/^[0-9a-f]{6}$/i.test(s('color')))return reply(i,'Invalid hex color.');await q('INSERT INTO store_settings(guild_id,brand,color) VALUES($1,$2,$3) ON CONFLICT(guild_id) DO UPDATE SET brand=EXCLUDED.brand,color=EXCLUDED.color',[g,s('name'),s('color')]);await audit(g,u,a);return reply(i,'Brand updated.');}
   if(a==='premium'){if(!(process.env.OWNER_IDS||'').split(',').map(x=>x.trim()).includes(u))return reply(i,'Bot owner only.');await q("INSERT INTO store_settings(guild_id,premium_until) VALUES($1,now()+$2*interval '1 day') ON CONFLICT(guild_id) DO UPDATE SET premium_until=EXCLUDED.premium_until",[g,n('days')]);await audit(g,u,a);return reply(i,'Plan updated.');}
   if(a==='plan')return reply(i,await premium(g)?'Premium active until '+st.premium_until:'Free plan.');
   if(a==='coupon-create'){const code=s('code').toUpperCase();if(!/^[A-Z0-9_-]+$/.test(code))return reply(i,'Invalid coupon code.');await transaction(async db=>{await db.query('SELECT guild_id FROM stores WHERE guild_id=$1 FOR UPDATE',[g]);const count=(await db.query('SELECT count(*)::int AS n FROM coupons WHERE guild_id=$1',[g])).rows[0].n;if(count>=3&&!await premium(g))throw new Error('Coupon limit reached');await db.query("INSERT INTO coupons VALUES($1,$2,$3,$4,now()+$5*interval '1 day')",[g,code,n('percent'),n('uses'),n('days')]);});await audit(g,u,a,code);return reply(i,'Coupon created.');}
   if(a==='coupon'){const code=s('code').toUpperCase();await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[g+':'+u]);const r=await db.query('SELECT 1 FROM coupons WHERE guild_id=$1 AND code=$2 AND remaining>0 AND expires_at>now()',[g,code]);if(!r.rowCount)throw new Error('Invalid coupon');await db.query('INSERT INTO cart_coupons VALUES($1,$2,$3) ON CONFLICT(guild_id,user_id) DO UPDATE SET code=EXCLUDED.code',[g,u,code]);});return reply(i,'Coupon applied to next checkout.');}
   if(a==='delivery'){const k=s('kind'),v=s('value');if(!['link','role','license','manual'].includes(k))return reply(i,'Invalid delivery kind.');if(k==='link'&&(!v.startsWith('https://')||!URL.canParse(v)))return reply(i,'HTTPS link required.');if(k==='role'){const role=await i.guild.roles.fetch(v);if(!role||role.id===g||role.managed||role.position>=i.member.roles.highest.position||role.permissions.bitfield!==0n)return reply(i,'Choose a non-managed role below your highest role with no guild-level permissions.');}const r=await q('INSERT INTO delivery_config(guild_id,product_id,kind,value,days) SELECT guild_id,id,$3,$4,$5 FROM products WHERE guild_id=$1 AND id=$2 ON CONFLICT(guild_id,product_id) DO UPDATE SET kind=EXCLUDED.kind,value=EXCLUDED.value,days=EXCLUDED.days',[g,s('product'),k,['manual','license'].includes(k)?'':v,n('days')]);await audit(g,u,a,s('product'));return reply(i,r.rowCount?'Delivery updated.':'Product not found.');}
   if(a==='claim'){const id=s('order');const r=await q("SELECT id FROM orders WHERE id=$1 AND guild_id=$2 AND user_id=$3 AND status='paid'",[id,g,u]);if(!r.rowCount)return reply(i,'Paid order not found.');await fulfill(id);await grantRoles(id);const items=(await q("SELECT kind,value,expires_at FROM entitlements WHERE order_id=$1 AND NOT revoked AND (expires_at IS NULL OR expires_at>now()) ORDER BY product_id,unit",[id])).rows;const body=items.map(x=>x.kind==='role'?'Discord role: '+x.value:x.kind+': '+x.value).join('\n');return i.editReply({content:body&&body.length<1800?body:body?'Delivery attached.':'No automated items; contact the store.',files:body.length>=1800?[{attachment:Buffer.from(body),name:'delivery.txt'}]:[],allowedMentions:{parse:[]}});}
   if(a==='analytics'){const r=(await q("SELECT count(*)::int AS orders,count(DISTINCT user_id)::int AS customers,coalesce(sum(total),0) AS revenue FROM orders WHERE guild_id=$1 AND status='paid'",[g])).rows[0];return reply(i,'Paid orders: '+r.orders+' | Customers: '+r.customers+' | Revenue: '+fmt(store.currency,r.revenue));}
   if(a==='support-role'){const role=i.options.getRole('role',true);if(role.id===g)return reply(i,'Everyone cannot be support staff.');await q('INSERT INTO store_settings(guild_id,support_role) VALUES($1,$2) ON CONFLICT(guild_id) DO UPDATE SET support_role=EXCLUDED.support_role',[g,role.id]);await audit(g,u,a,role.id);return reply(i,'Support role configured.');}
   if(a==='support'){const id=s('order');const r=await q('SELECT id FROM orders WHERE guild_id=$1 AND user_id=$2 AND id=$3',[g,u,id]);if(!r.rowCount)return reply(i,'Order not found.');const staff=st.support_role||process.env.SUPPORT_ROLE_ID;if(!staff||staff===g||!await i.guild.roles.fetch(staff))return reply(i,'Support role not configured for this server.');const caseId=randomUUID();const reserved=await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[g+':support:'+u]);const count=(await db.query('SELECT count(*)::int AS n FROM support_cases WHERE guild_id=$1 AND user_id=$2 AND closed_at IS NULL',[g,u])).rows[0].n;if(count>=3)return false;const exists=await db.query('SELECT 1 FROM support_cases WHERE guild_id=$1 AND order_id=$2 AND closed_at IS NULL',[g,id]);if(exists.rowCount)return false;await db.query('INSERT INTO support_cases(id,guild_id,user_id,order_id) VALUES($1,$2,$3,$4)',[caseId,g,u,id]);return true;});if(!reserved)return reply(i,'An open case already exists or your support limit has been reached.');let ch;try{ch=await i.guild.channels.create({name:'market-support-'+caseId.slice(0,8),type:ChannelType.GuildText,permissionOverwrites:[{id:g,deny:[PermissionFlagsBits.ViewChannel]},{id:u,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]},{id:staff,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]},{id:bot.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ManageChannels]}]});await q('UPDATE support_cases SET channel_id=$2 WHERE id=$1',[caseId,ch.id]);}catch(err){if(ch)await ch.delete().catch(()=>{});await q('UPDATE support_cases SET closed_at=now() WHERE id=$1',[caseId]);throw err;}return reply(i,'Support channel: <#'+ch.id+'>');}
   if(a==='support-close'){const r=await q('UPDATE support_cases SET closed_at=now() WHERE guild_id=$1 AND channel_id=$2 AND closed_at IS NULL RETURNING user_id',[g,i.channelId]);if(!r.rowCount)return reply(i,'Not an open support case.');await i.channel.permissionOverwrites.edit(r.rows[0].user_id,{SendMessages:false});return reply(i,'Support case closed.');}
   if(a==='license-revoke'){const r=await q("UPDATE entitlements e SET revoked=true FROM orders o WHERE e.order_id=o.id AND o.guild_id=$1 AND e.kind='license' AND e.value=$2",[g,s('key')]);await audit(g,u,a);return reply(i,r.rowCount?'License revoked.':'License not found.');}
  }catch(e){console.error('Market command error',e.code||e.name);if(i.deferred)await reply(i,'Unable to complete request. Check inputs, limits and bot permissions.').catch(()=>{});}
 });
 return {command,fulfill,grantRoles,premium,audit};
}
