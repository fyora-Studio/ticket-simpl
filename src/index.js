'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Read .env without dotenv (one fewer runtime dependency).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !Object.hasOwn(process.env,m[1])) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const { Client, GatewayIntentBits, Partials, Events, Options, MessageFlags } = require('discord.js');
const { verifyBrand } = require('./brand-guard');
const H = require('./handlers');
try { verifyBrand(); } catch (error) { console.error(`[Fyora Studio] ${error.message}`); process.exit(1); }
if (!process.env.DISCORD_TOKEN) { console.error('ERROR: DISCORD_TOKEN is missing. Add it to .env.'); process.exit(1); }
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
  makeCache: Options.cacheWithLimits({ MessageManager: 0, PresenceManager: 0, ReactionManager: 0, GuildMemberManager: 0, ThreadManager: 0 }),
  sweepers: { messages: { interval: 300, lifetime: 180 }, users: { interval: 600, filter: () => user => user.bot } }
});
client.pendingImages = new Map();
client.pendingDelete = new Map();
client.voiceConnections = new Map();
const prefix = (process.env.PREFIX || '!').trim() || '!';
let maintenanceBusy = false;
client.once(Events.ClientReady, c => {
  console.log(`[Fyora Studio] Online as ${c.user.tag}`);
  console.log('[Fyora Studio] Lightweight mode enabled (JSON storage, limited cache).');
  H.restoreVoiceConnections(c).catch(e => console.error('[Voice restore]', e));
  const runMaintenance = async () => {
    if (maintenanceBusy) return;
    maintenanceBusy = true;
    try { await H.maintenance(c); } catch (e) { console.error('[Maintenance]', e); }
    finally { maintenanceBusy = false; }
  };
  setTimeout(runMaintenance, 15000);
  setInterval(runMaintenance, 300000).unref();
});
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild || message.content.trim().toLowerCase() !== `${prefix}ticket`) return;
  const isGuildOwner = message.guild.ownerId === message.author.id;
  const member = isGuildOwner ? null : await message.guild.members.fetch(message.author.id).catch(() => null);
  const hasAdministrator = Boolean(member?.permissions?.has?.('Administrator'));
  if (!isGuildOwner && !hasAdministrator) return message.reply('تحتاج صلاحية **Administrator** لفتح لوحة الإدارة.').catch(()=>{});
  return message.reply(require('./ui').homePanel()).catch(err => console.error('[Panel]', err));
});
client.on(Events.InteractionCreate, async i => {
  try {
    if (!i.guild) return;
    if (i.isButton()) {
      if (i.customId.startsWith('confirm_') || i.customId.startsWith('cancel_')) return H.handleConfirm(i);
      return H.handleButton(i);
    }
    if (i.isStringSelectMenu() || i.isChannelSelectMenu() || i.isRoleSelectMenu()) return H.handleSelect(i);
    if (i.isModalSubmit()) return H.handleModal(i);
  } catch (error) {
    console.error('[Interaction]', error);
    const payload = { content:'تعذر تنفيذ العملية. تحقق من صلاحيات البوت وإعداداته ثم حاول مجدداً.', flags: MessageFlags.Ephemeral };
    if (i.replied || i.deferred) await i.followUp(payload).catch(()=>{});
    else await i.reply(payload).catch(()=>{});
  }
});
client.on(Events.Error, e => console.error('[Discord client]', e));
process.on('unhandledRejection', e => console.error('[Unhandled rejection]', e));
process.on('uncaughtException', e => { console.error('[Uncaught exception]', e); process.exit(1); });
client.login(process.env.DISCORD_TOKEN).catch(error => { console.error('[Login failed]', error.message); process.exit(1); });
