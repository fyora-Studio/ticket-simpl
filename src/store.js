'use strict';
// Lightweight JSON persistence: no native SQLite addon or database compilation.
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'data', 'tickets.json');
const dir = path.dirname(file);
const defaults = { category_id:null, log_channel_id:null, panel_image:null, panel_image_mode:'embed', panel_text:'اختر القسم المناسب لفتح تكت جديد.', line_image:null, auto_delete:0, auto_delete_minutes:1440, reminders:0, reminder_minutes:1440, voice_channel_id:null, panels:[] };
let data;
function load() {
  fs.mkdirSync(dir, { recursive:true });
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; data = { settings:{}, types:[], tickets:[], nextTypeId:1 }; save(); }
  data.settings ||= {}; data.types ||= []; data.tickets ||= []; data.nextTypeId ||= 1;
}
function save() {
  fs.mkdirSync(dir, { recursive:true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data));
  fs.renameSync(temp, file);
}
load();
function getSettings(guildId) { return { guild_id:guildId, ...defaults, ...(data.settings[guildId] || {}) }; }
function setSetting(guildId, key, value) { if (!Object.hasOwn(defaults,key)) throw new Error('Invalid setting'); data.settings[guildId] ||= {}; data.settings[guildId][key]=value; save(); }
function listTypes(guildId) { return data.types.filter(x=>x.guild_id===guildId).map(x=>({...x,roles:[...x.roles]})); }
function getType(guildId,id) { const x=data.types.find(x=>x.guild_id===guildId&&x.id===Number(id)); return x?{...x,roles:[...x.roles]}:null; }
function createType(guildId,name,roles,emoji,image) { const id=data.nextTypeId++; data.types.push({id,guild_id:guildId,name,roles:[...roles],emoji:emoji||null,image:image||null,created_at:Date.now()}); save(); return id; }
function updateType(guildId,id,field,value) { if(!['name','roles','emoji','image'].includes(field)) throw new Error('Invalid type field'); const x=data.types.find(x=>x.guild_id===guildId&&x.id===Number(id)); if(!x) return false; x[field]=field==='roles'?[...value]:value; save(); return true; }
function deleteType(guildId,id) { data.types=data.types.filter(x=>!(x.guild_id===guildId&&x.id===Number(id))); save(); }
function createTicket(t) { data.tickets.push({channel_id:t.channelId,guild_id:t.guildId,owner_id:t.ownerId,type_id:t.typeId,type_name:t.typeName,staff_id:null,message_id:null,status:'open',created_at:Date.now(),closed_at:null,last_reminder:null}); save(); }
function getTicket(channelId) { const t=data.tickets.find(x=>x.channel_id===channelId); return t?{...t}:null; }
function updateTicket(channelId,field,value) { if(!['staff_id','message_id','status','closed_at','last_reminder'].includes(field)) throw new Error('Invalid ticket field'); const t=data.tickets.find(x=>x.channel_id===channelId); if(!t) return false; t[field]=value; save(); return true; }
function removeTicket(channelId) { data.tickets=data.tickets.filter(x=>x.channel_id!==channelId); save(); }
function listTickets(guildId) { return data.tickets.filter(x=>x.guild_id===guildId).map(x=>({...x})); }
module.exports={getSettings,setSetting,listTypes,getType,createType,updateType,deleteType,createTicket,getTicket,updateTicket,removeTicket,listTickets};
