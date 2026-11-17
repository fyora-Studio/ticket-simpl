'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  PermissionsBitField, ChannelType, AttachmentBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder
} = require('discord.js');
const MessageFlags = require('discord.js').MessageFlags || { Ephemeral: 64 };
const S = require('./store');
const UI = require('./ui');

const ADMIN = PermissionsBitField.Flags.Administrator;
const isAdmin = member => {
  try {
    if (member?.permissions?.has?.(ADMIN)) return true;
    if (typeof member?.permissions === 'string' || typeof member?.permissions === 'bigint') return new PermissionsBitField(BigInt(member.permissions)).has(ADMIN);
    return false;
  } catch { return false; }
};
const isInteractionAdmin = i => Boolean(i.guild?.ownerId === i.user?.id || i.memberPermissions?.has?.(ADMIN) || isAdmin(i.member));
const hasRole = (member, id) => Boolean(member?.roles?.cache?.has?.(id) || (Array.isArray(member?.roles) && member.roles.includes(id)));
const staffAllowed = (member, type) => isAdmin(member) || (type.roles || []).some(id => hasRole(member, id));
const safeImage = attachment => attachment && (attachment.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif)$/i.test(attachment.name || '')) && attachment.size <= 8 * 1024 * 1024;
const IMAGE_DIR = path.join(__dirname, '..', 'data', 'images');
function localImage(relative, label) {
  if (!relative) return null;
  const full = path.resolve(__dirname, '..', 'data', relative);
  if (!full.startsWith(path.resolve(IMAGE_DIR) + path.sep) || !fs.existsSync(full)) return null;
  return new AttachmentBuilder(full, { name: `${label}-${path.basename(full)}` });
}
async function saveImageAttachment(attachment, label) {
  if (!safeImage(attachment)) throw new Error('الملف ليس صورة صالحة أو حجمه أكبر من 8MB.');
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`تعذر تنزيل الصورة من Discord (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error('حجم الصورة غير صالح.');
  const extFromName = path.extname(attachment.name || '').toLowerCase();
  const ext = ['.png','.jpg','.jpeg','.gif','.webp','.avif'].includes(extFromName) ? extFromName : '.png';
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const filename = `${label}-${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(IMAGE_DIR, filename), buffer);
  return `images/${filename}`;
}
function panelFiles(settings) {
  return { panel: localImage(settings.panel_image, 'fyora-panel'), line: localImage(settings.line_image, 'fyora-line') };
}
async function publishPanel(guild, channel) {
  const settings = S.getSettings(guild.id);
  const payload = UI.ticketPanel(S.listTypes(guild.id), settings, panelFiles(settings));
  const sent = await channel.send(payload);
  const panels = [...(settings.panels || []).filter(p => p.message_id !== sent.id), { channel_id: channel.id, message_id: sent.id, v2: true }].slice(-20);
  S.setSetting(guild.id, 'panels', panels);
  return sent;
}
// Re-render every published panel so image/line/type edits show up without republishing.
async function refreshPanels(guild) {
  const refs = S.getSettings(guild.id).panels || [];
  if (!refs.length || !guild.channels?.fetch) return;
  const keep = [];
  for (const ref of refs) {
    const channel = await guild.channels.fetch(ref.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    let message;
    try { message = await channel.messages.fetch(ref.message_id); }
    catch (e) { if ([10008, 10003].includes(e?.code)) continue; keep.push(ref); continue; }
    try {
      if (ref.v2) { await message.edit({ ...panelPayload(guild), attachments: [] }); keep.push(ref); }
      else { // old classic panel cannot become a V2 message: replace it with the new layout
        const sent = await channel.send(panelPayload(guild));
        await message.delete().catch(() => {});
        keep.push({ channel_id: channel.id, message_id: sent.id, v2: true });
      }
    } catch (e) { console.error('[Panel refresh]', e.message); keep.push(ref); }
  }
  S.setSetting(guild.id, 'panels', keep);
}
const refresh = i => { refreshPanels(i.guild).catch(e => console.error('[Panel refresh]', e)); };
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice].filter(v => v !== undefined);
const voiceRetry = new Map();
function dropVoice(client, guildId) {
  const old = client.voiceConnections?.get(guildId);
  if (old) { try { old.destroy(); } catch {} client.voiceConnections.delete(guildId); }
}
async function connectVoice(guild, channelId, client) {
  client.voiceConnections ||= new Map();
  if (!channelId) { dropVoice(client, guild.id); return null; }
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !VOICE_TYPES.includes(channel.type)) throw new Error('قناة الفويس المحددة غير موجودة أو ليست قناة صوتية.');
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) throw new Error('تعذر جلب عضو البوت داخل السيرفر.');
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has(PermissionsBitField.Flags.ViewChannel) || !permissions?.has(PermissionsBitField.Flags.Connect)) throw new Error('البوت يحتاج صلاحيتي View Channel وConnect في قناة الفويس المحددة.');
  const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
  const previous = client.voiceConnections.get(guild.id);
  if (previous?.joinConfig?.channelId === channel.id && previous.state?.status === VoiceConnectionStatus.Ready) return previous;
  dropVoice(client, guild.id);
  const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: true });
  client.voiceConnections.set(guild.id, connection);
  connection.on('error', error => console.error(`[Voice ${guild.id}]`, error.message));
  // Auto-recover when Discord moves/drops the connection instead of staying dead until restart.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)]);
    } catch {
      if (client.voiceConnections.get(guild.id) !== connection) return;
      dropVoice(client, guild.id);
      const wanted = S.getSettings(guild.id).voice_channel_id;
      if (wanted) setTimeout(() => connectVoice(guild, wanted, client).catch(e => console.error(`[Voice ${guild.id}] Reconnect failed: ${e.message}`)), 5000).unref?.();
    }
  });
  try { await entersState(connection, VoiceConnectionStatus.Ready, 20000); }
  catch (error) { if (client.voiceConnections.get(guild.id) === connection) dropVoice(client, guild.id); throw new Error('تعذر إكمال الاتصال بقناة الفويس. تأكد من الصلاحيات وأن حزمة @discordjs/voice محدثة (npm install).'); }
  return connection;
}

async function promptMessage(i, text, { image = false, optional = false, timeout = 120000 } = {}) {
  await i.editReply({ content: `${text}\n${image ? 'ارفع الصورة كمرفق في نفس الروم من جهازك (الجوال) مباشرة.' : 'أرسل إجابتك كرسالة في نفس الروم.'}${optional ? '\nأرسل - للتخطي.' : ''}` , embeds: [], components: [] }).catch(() => {});
  const channel = i.channel;
  if (!channel?.isTextBased() || !channel.awaitMessages) return null;
  try {
    const collected = await channel.awaitMessages({
      filter: m => m.author.id === i.user.id && (image
        ? (m.attachments.some(safeImage) || (optional && m.content.trim() === '-'))
        : (m.content.trim().length > 0)),
      max: 1, time: timeout, errors: ['time']
    });
    const msg = collected.first();
    if (!msg) return null;
    if (image) {
      const attachment = msg.attachments.find(safeImage) || null;
      if (!attachment) { await msg.delete().catch(() => {}); return null; }
      return { attachment, message: msg };
    }
    const value = msg.content.trim();
    await msg.delete().catch(() => {});
    return value;
  } catch { return null; }
}
async function beginFlow(i, title) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply({ content: `**${title}**\nسأطلب منك المعلومات برسائل متتابعة. الرسائل التي ترسلها ستُحذف بعد قراءتها.`, embeds: [], components: [] });
}
function parseEmoji(raw) {
  if (raw && typeof raw === 'object' && raw.id && raw.name) return { id: raw.id, name: raw.name, animated: Boolean(raw.animated) };
  const s = String(raw || '').trim();
  if (!s || s === '-') return null;
  const custom = s.match(/^<(a?):([a-zA-Z0-9_]{2,32}):(\d{17,20})>$/);
  if (custom) return { id: custom[3], name: custom[2], animated: custom[1] === 'a' };
  // Reject text labels and unsupported multi-character strings; use a safe fallback at render time.
  if (/^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*$/u.test(s)) return s;
  return null;
}
function setButtonEmoji(button, emoji) {
  try { if (emoji) button.setEmoji(emoji); else button.setEmoji('🎫'); }
  catch { button.setEmoji('🎫'); }
  return button;
}
function panelPayload(guild) {
  const settings = S.getSettings(guild.id);
  return UI.ticketPanel(S.listTypes(guild.id), settings, panelFiles(settings));
}

async function sendTranscript(channel, ticket, settings) {
  const messages = []; let before;
  for (let page = 0; page < 5; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch?.size) break;
    messages.push(...batch.values()); before = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = messages.map(m => `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag}: ${m.content || ''}${m.attachments.size ? ` | Attachments: ${[...m.attachments.values()].map(a => a.url).join(', ')}` : ''}`).join('\n');
  const file = new AttachmentBuilder(Buffer.from(lines || 'No messages', 'utf8'), { name: `ticket-${channel.id}-transcript.txt` });
  const log = settings.log_channel_id ? await channel.guild.channels.fetch(settings.log_channel_id).catch(() => null) : null;
  if (log?.isTextBased()) await log.send({ content: `سجل التكت **${ticket.type_name}** • صاحب التكت: <@${ticket.owner_id}> • القناة: <#${channel.id}>`, files: [file] }).catch(() => {});
}
function ticketControls(state = 'open') {
  const claimed = state !== 'open', closed = state === 'closed';
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_claim').setLabel(claimed ? 'تم الاستلام' : 'استلام').setStyle(claimed ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji('📥').setDisabled(claimed),
    new ButtonBuilder().setCustomId('ticket_close').setLabel(closed ? 'مغلق' : 'إغلاق').setStyle(ButtonStyle.Secondary).setEmoji('🔒').setDisabled(closed)
  )];
}
function ticketText(type, ticket, settings) {
  const closed = ticket.status === 'closed';
  const mentions = [`<@${ticket.owner_id}>`, ...(type.roles || []).map(r => `<@&${r}>`)].join(' ');
  const lines = [mentions, '', `🎫 **${type.name}**`, `مرحباً <@${ticket.owner_id}>، اشرح طلبك وسيقوم فريق الدعم بمساعدتك.`, '',
    `**الحالة:** ${closed ? 'مغلق' : ticket.staff_id ? 'تم الاستلام' : 'بانتظار الاستلام'}`];
  if (ticket.staff_id) lines.push(`**المستلم:** <@${ticket.staff_id}>`);
  if (settings.voice_channel_id) lines.push(`**الدعم الصوتي:** <#${settings.voice_channel_id}>`);
  return lines.join('\n');
}
// Re-render the main ticket message (status / claimer) without pinging anyone again.
async function refreshTicketMessage(channel, ticket, message) {
  try {
    const msg = message || (ticket.message_id ? await channel.messages.fetch(ticket.message_id) : null);
    if (!msg) return;
    const type = S.getType(channel.guildId, ticket.type_id) || { name: ticket.type_name, roles: [] };
    const state = ticket.status === 'closed' ? 'closed' : ticket.staff_id ? 'claimed' : 'open';
    await msg.edit({ content: ticketText(type, ticket, S.getSettings(channel.guildId)), components: ticketControls(state), allowedMentions: { parse: [] } });
  } catch (e) { console.error('[Ticket message]', e.message); }
}
const openingNow = new Set();
async function openTicket(i, type) {
  if (openingNow.has(i.user.id)) return i.reply({ content: 'جاري إنشاء تكتك، انتظر لحظة.', flags: MessageFlags.Ephemeral });
  openingNow.add(i.user.id);
  try { return await openTicketInner(i, type); } finally { openingNow.delete(i.user.id); }
}
async function openTicketInner(i, type) {
  const existing = S.listTickets(i.guildId).find(t => t.owner_id === i.user.id && t.status === 'open');
  if (existing) {
    const channel = i.guild.channels.cache.get(existing.channel_id);
    if (channel) return i.reply({ content: `لديك تكت مفتوح بالفعل: ${channel}`, flags: MessageFlags.Ephemeral });
    S.removeTicket(existing.channel_id);
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = S.getSettings(i.guildId);
  const parent = settings.category_id ? await i.guild.channels.fetch(settings.category_id).catch(() => null) : null;
  const overwrites = [
    { id: i.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks] },
    { id: i.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks] }
  ];
  for (const roleId of type.roles || []) if (i.guild.roles.cache.has(roleId)) overwrites.push({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] });
  const channel = await i.guild.channels.create({
    name: `${type.name}-${i.user.username}`.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || `ticket-${i.user.id}`,
    type: ChannelType.GuildText, parent: parent?.id,
    permissionOverwrites: overwrites,
    topic: `Fyora ticket | owner=${i.user.id} | type=${type.id}`
  });
  S.createTicket({ channelId: channel.id, guildId: i.guildId, ownerId: i.user.id, typeId: type.id, typeName: type.name });
  const ticket = S.getTicket(channel.id);
  const typeImage = localImage(type.image, 'fyora-ticket');
  let content = ticketText(type, ticket, settings);
  if (!typeImage && type.image && /^https:\/\//i.test(type.image)) content += `\n${type.image}`;
  const sent = await channel.send({ content, files: typeImage ? [typeImage] : [], components: ticketControls('open'), allowedMentions: { users: [i.user.id], roles: type.roles || [] } });
  S.updateTicket(channel.id, 'message_id', sent.id);
  await i.editReply({ content: `تم إنشاء تكتك بنجاح: ${channel}` });
}
async function updatePanel(i, payload) { return i.update(payload); }
async function handleButton(i) {
  const id = i.customId;
  if (id.startsWith('open_')) { // legacy panel support
    const type = S.getType(i.guildId, Number(id.slice(5)));
    return type ? openTicket(i, type) : i.reply({ content: 'هذا النوع لم يعد متاحاً.', flags: MessageFlags.Ephemeral });
  }
  if (id === 'ticket_claim' || id === 'ticket_close' || id === 'ticket_delete') {
    const t = S.getTicket(i.channelId);
    if (!t) return i.reply({ content: 'هذه القناة ليست تكت مسجلاً.', flags: MessageFlags.Ephemeral });
    const type = S.getType(i.guildId, t.type_id) || { roles: [] };
    if (!staffAllowed(i.member, type)) return i.reply({ content: 'ليس لديك صلاحية استخدام هذا الزر.', flags: MessageFlags.Ephemeral });
    if (id === 'ticket_claim') {
      if (t.staff_id) return i.reply({ content: `تم استلام التكت مسبقاً بواسطة <@${t.staff_id}>.`, flags: MessageFlags.Ephemeral });
      await i.deferUpdate();
      S.updateTicket(i.channelId, 'staff_id', i.user.id);
      for (const roleId of type.roles || []) await i.channel.permissionOverwrites.edit(roleId, { ViewChannel: false, SendMessages: false }).catch(() => {});
      await i.channel.permissionOverwrites.edit(i.user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      return refreshTicketMessage(i.channel, S.getTicket(i.channelId), i.message);
    }
    if (t.staff_id && t.staff_id !== i.user.id && !isAdmin(i.member)) return i.reply({ content: 'فقط مستلم التكت أو الإدارة يمكنه تنفيذ هذا الإجراء.', flags: MessageFlags.Ephemeral });
    if (id === 'ticket_close') {
      if (t.status === 'closed') return i.reply({ content: 'التكت مغلق بالفعل.', flags: MessageFlags.Ephemeral });
      S.updateTicket(i.channelId, 'status', 'closed'); S.updateTicket(i.channelId, 'closed_at', Date.now());
      await i.channel.permissionOverwrites.edit(t.owner_id, { ViewChannel: false, SendMessages: false }).catch(() => {});
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_delete').setLabel('حذف التكت').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
      await refreshTicketMessage(i.channel, S.getTicket(i.channelId));
      return i.reply({ content: `تم إغلاق التكت بواسطة <@${i.user.id}>.`, components: [row] });
    }
    await i.reply({ content: 'سيتم حذف التكت وإرسال سجله.', flags: MessageFlags.Ephemeral });
    await sendTranscript(i.channel, t, S.getSettings(i.guildId)); S.removeTicket(i.channelId);
    return i.channel.delete('Ticket deleted by staff').catch(() => {});
  }
  if (!isInteractionAdmin(i)) return i.reply({ content: 'تحتاج صلاحية Administrator.', flags: MessageFlags.Ephemeral });
  if (id === 'admin_home') return updatePanel(i, UI.homePanel());
  if (id.startsWith('roles_skip_')) return i.update({ content: 'تم إنشاء نوع التكت بدون رتب مخولة. يمكنك تعيينها لاحقاً.', embeds: [], components: [] });
  if (id === 'publish_panel') return i.reply({ content: 'اختر قسم «نشر لوحة التكت» وحدد الروم المطلوب.', flags: MessageFlags.Ephemeral });
  if (id === 'voice_remove') { S.setSetting(i.guildId, 'voice_channel_id', null); dropVoice(i.client, i.guildId); return updatePanel(i, UI.homePanel()); }
  return i.reply({ content: 'هذا الخيار لم يعد مستخدماً. افتح القائمة الرئيسية وحاول مجدداً.', flags: MessageFlags.Ephemeral });
}
async function handleSelect(i) {
  if (i.customId === 'open_ticket') {
    const type = S.getType(i.guildId, Number(i.values[0]));
    // Reset the dropdown so the same type can be picked again.
    { const p = panelPayload(i.guild); i.message?.edit?.({ flags: p.flags, components: p.components }).catch?.(() => {}); }
    return type ? openTicket(i, type) : i.reply({ content: 'نوع التكت غير موجود.', flags: MessageFlags.Ephemeral });
  }
  if (!isInteractionAdmin(i)) return i.reply({ content: 'تحتاج صلاحية Administrator.', flags: MessageFlags.Ephemeral });
  const id = i.customId, gid = i.guildId;
  if (id === 'admin_section') {
    const value = i.values[0];
    if (value === 'types') return updatePanel(i, UI.typePanel(S.listTypes(gid)));
    if (value === 'images') return updatePanel(i, UI.imagePanel(S.getSettings(gid), S.listTypes(gid)));
    if (value === 'automation') return updatePanel(i, UI.automationPanel(S.getSettings(gid)));
    if (value === 'publish') return i.reply({ content: 'اختر روم نشر لوحة التكت:', components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('pick_publish_channel').setPlaceholder('اختر روم النشر').setChannelTypes(ChannelType.GuildText))], flags: MessageFlags.Ephemeral });
    if (value === 'voice') return i.update(UI.v2('تثبيت في فويس', `القناة الحالية: ${S.getSettings(gid).voice_channel_id ? `<#${S.getSettings(gid).voice_channel_id}>` : 'غير محددة'}\nاختر قناة صوتية ليدخلها البوت ويبقى متصلاً بها، أو أزل الاتصال.`, [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('pick_voice').setPlaceholder('اختر قناة فويس').setChannelTypes(ChannelType.GuildVoice)), new ActionRowBuilder().addComponents(UI.btn('voice_remove', 'إزالة التثبيت', ButtonStyle.Danger, '🗑️'), UI.btn('admin_home', 'رجوع'))]));
  }
  if (id === 'type_action') {
    const action = i.values[0], types = S.listTypes(gid);
    if (action === 'create') return createTypeFlow(i);
    if (action === 'list') {
      const text = types.length ? types.slice(0, 12).map(t => `**${t.name}**\nالرتب: ${t.roles.map(r => `<@&${r}>`).join('، ') || 'لا توجد'}\nالمعرّف: ${t.id}`).join('\n\n') : 'لا توجد أنواع تكتات.';
      return i.reply({ embeds: [UI.panelEmbed('قائمة التكتات', text)], flags: MessageFlags.Ephemeral });
    }
    if ((action === 'edit' || action === 'delete') && !types.length) return i.reply({ content: 'لا توجد أنواع تكتات حالياً.', flags: MessageFlags.Ephemeral });
    const custom = action === 'edit' ? 'pick_edit_type' : action === 'delete' ? 'pick_delete_type' : action === 'category' ? 'pick_category' : 'pick_logs';
    if (action === 'category' || action === 'logs') {
      const menu = new ChannelSelectMenuBuilder().setCustomId(custom).setPlaceholder(action === 'category' ? 'اختر كتاكوري التكتات' : 'اختر روم السجلات').setChannelTypes(action === 'category' ? ChannelType.GuildCategory : ChannelType.GuildText);
      return i.reply({ content: 'حدد القناة المطلوبة:', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    return i.reply({ content: action === 'edit' ? 'اختر نوع التكت الذي تريد تعديله:' : 'اختر نوع التكت الذي تريد حذفه:', components: [UI.typeSelect(types, custom)], flags: MessageFlags.Ephemeral });
  }
  if (id === 'panel_mode') {
    S.setSetting(gid, 'panel_image_mode', i.values[0]);
    refresh(i);
    if (i.values[0] === 'embed') {
      await i.update({ content: 'اكتب النص الذي سيظهر أعلى صورة البانل داخل الـ Embed. أرسل - لاستخدام النص الافتراضي.', embeds: [], components: [] });
      const text = await promptMessage(i, 'أرسل نص البانل:', { optional: true });
      if (text !== null) { S.setSetting(gid, 'panel_text', text === '-' ? 'اختر القسم المناسب لفتح تكت جديد.' : text.slice(0, 4000)); refresh(i); }
      return i.editReply({ content: 'تم حفظ وضع الـ Embed ونص البانل.' });
    }
    S.setSetting(gid, 'panel_text', 'اختر القسم المناسب لفتح تكت جديد.');
    return i.update({ content: 'تم حفظ طريقة عرض صورة البانل.', embeds: [], components: [] });
  }
  if (id === 'image_action') {
    const action = i.values[0];
    if (action === 'remove_panel' || action === 'remove_line') {
      S.setSetting(gid, action === 'remove_panel' ? 'panel_image' : 'line_image', null);
      refresh(i);
      return i.update(UI.imagePanel(S.getSettings(gid), S.listTypes(gid)));
    }
    if (action === 'type') {
      const types = S.listTypes(gid);
      if (!types.length) return i.reply({ content: 'لا توجد أنواع تكتات.', flags: MessageFlags.Ephemeral });
      return i.reply({ content: 'اختر نوع التكت الذي تريد تغيير صورته:', components: [UI.typeSelect(types, 'pick_image_type')], flags: MessageFlags.Ephemeral });
    }
    return uploadSettingImage(i, action);
  }
  if (id === 'auto_action') {
    const isDelete = i.values[0] === 'delete', s = S.getSettings(gid);
    return i.showModal(UI.modal(isDelete ? 'set_auto_delete' : 'set_auto_reminder', isDelete ? 'إعداد الحذف التلقائي' : 'إعداد التذكير', [
      { id: 'enabled', label: 'التفعيل: 1 تشغيل / 0 إيقاف', required: true, placeholder: String(isDelete ? s.auto_delete : s.reminders) },
      { id: 'minutes', label: 'المدة بالدقائق', required: true, placeholder: String(isDelete ? s.auto_delete_minutes : s.reminder_minutes) }
    ]));
  }
  if (id === 'pick_edit_type') {
    const type = S.getType(gid, Number(i.values[0]));
    if (!type) return i.reply({ content: 'نوع التكت غير موجود.', flags: MessageFlags.Ephemeral });
    return i.reply({ content: `تعديل **${type.name}** — اختر الخاصية:`, components: [UI.rowSelect(`edit_field_${type.id}`, 'اختر ما تريد تعديله', [
      { label: 'الاسم', value: 'name', emoji: '✏️' }, { label: 'الصورة', value: 'image', emoji: '🖼️' },
      { label: 'الإيموجي', value: 'emoji', emoji: '😀' }, { label: 'الرتب المخولة', value: 'roles', emoji: '👥' }
    ])], flags: MessageFlags.Ephemeral });
  }
  if (id === 'pick_delete_type') {
    const tid = Number(i.values[0]);
    return i.reply({ content: 'هل أنت متأكد من حذف نوع التكت؟', components: [new ActionRowBuilder().addComponents(UI.btn(`confirm_delete_${tid}`, 'تأكيد الحذف', ButtonStyle.Danger), UI.btn('cancel_delete', 'إلغاء'))], flags: MessageFlags.Ephemeral });
  }
  if (id.startsWith('edit_field_')) {
    const tid = Number(id.slice('edit_field_'.length)), field = i.values[0];
    if (field === 'roles') {
      const menu = new RoleSelectMenuBuilder().setCustomId(`edit_roles_${tid}`).setPlaceholder('اختر الرتب المخولة').setMinValues(0).setMaxValues(10);
      return i.reply({ content: 'اختر رتبة أو أكثر (يمكن تركها فارغة):', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
    }
    if (field === 'image') return uploadTypeImage(i, tid);
    return i.showModal(UI.modal(`edit_${tid}_${field}`, 'تعديل نوع التكت', [{ id: 'value', label: field === 'emoji' ? 'الإيموجي أو - لإزالته' : 'الاسم الجديد', required: true }]));
  }
  if (id === 'pick_category' || id === 'pick_logs' || id === 'pick_voice') {
    const channelId = i.values[0];
    const key = id === 'pick_category' ? 'category_id' : id === 'pick_logs' ? 'log_channel_id' : 'voice_channel_id';
    if (id === 'pick_voice') {
      await i.deferUpdate();
      const back = new ActionRowBuilder().addComponents(UI.btn('admin_home', 'رجوع', ButtonStyle.Secondary, '↩️'));
      try { await connectVoice(i.guild, channelId, i.client); S.setSetting(gid, key, channelId); return i.editReply(UI.v2('تثبيت في فويس', `✅ تم توصيل البوت بقناة الفويس <#${channelId}> وسيبقى متصلاً بها.`, [back])); }
      catch (error) { return i.editReply(UI.v2('تثبيت في فويس', `❌ لم يتم توصيل البوت: ${error.message}`, [back])); }
    }
    S.setSetting(gid, key, channelId);
    return i.update({ content: 'تم حفظ الإعداد بنجاح.', embeds: [], components: [] });
  }
  if (id === 'pick_publish_channel') {
    const channel = await i.guild.channels.fetch(i.values[0]).catch(() => null);
    if (!channel?.isTextBased()) return i.reply({ content: 'الروم المحدد غير صالح.', flags: MessageFlags.Ephemeral });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try { await publishPanel(i.guild, channel); return i.editReply({ content: `تم نشر لوحة التكت في ${channel}.` }); }
    catch (error) { console.error('[Publish panel]', error); return i.editReply({ content: `تعذر نشر اللوحة: ${error.message}` }); }
  }
  if (id === 'pick_image_type') return uploadTypeImage(i, Number(i.values[0]));
  if (id.startsWith('edit_roles_') || id.startsWith('create_roles_')) {
    const tid = Number(id.slice(id.indexOf('_', id.indexOf('_') + 1) + 1));
    S.updateType(gid, tid, 'roles', i.values);
    refresh(i);
    return i.update({ content: 'تم حفظ الرتب المخولة بنجاح.', embeds: [], components: [] });
  }
}
async function createTypeFlow(i) {
  await beginFlow(i, 'إنشاء نوع تكت جديد');
  const name = await promptMessage(i, '1/3 — أرسل اسم التكت:', { timeout: 120000 });
  if (!name || name.length > 80) return i.editReply({ content: 'تم إلغاء الإنشاء أو الاسم أطول من 80 حرفاً.' });
  const emojiRaw = await promptMessage(i, '2/3 — أرسل إيموجي التكت (أو - لاستخدام الافتراضي):', { optional: true });
  const emoji = parseEmoji(emojiRaw);
  const imageAttachment = await promptMessage(i, '3/3 — ارفع صورة نوع التكت من جهازك أو أرسل - بدون صورة:', { image: true, optional: true });
  let image = null;
  if (imageAttachment) { try { image = await saveImageAttachment(imageAttachment.attachment, 'ticket-type'); await imageAttachment.message.delete().catch(() => {}); } catch (e) { return i.editReply({ content: `تعذر حفظ الصورة: ${e.message}` }); } }
  const tid = S.createType(gidOf(i), name, [], emoji, image);
  refresh(i);
  const roles = new RoleSelectMenuBuilder().setCustomId(`create_roles_${tid}`).setPlaceholder('اختر الرتب المخولة (اختياري)').setMinValues(0).setMaxValues(10);
  return i.editReply({ content: `تم إنشاء **${name}**. اختر الرتب المخولة لهذا النوع:`, components: [new ActionRowBuilder().addComponents(roles), new ActionRowBuilder().addComponents(UI.btn(`roles_skip_${tid}`, 'تخطي', ButtonStyle.Secondary))] });
}
function gidOf(i) { return i.guildId; }
async function uploadSettingImage(i, action) {
  await beginFlow(i, 'رفع صورة');
  const upload = await promptMessage(i, 'ارفع الصورة الآن كمرفق من جوالك:', { image: true });
  if (!upload) return i.editReply({ content: 'لم يتم استلام صورة صالحة خلال دقيقتين.' });
  let relative;
  try { relative = await saveImageAttachment(upload.attachment, action === 'panel' ? 'panel' : 'line'); await upload.message.delete().catch(() => {}); }
  catch (error) { return i.editReply({ content: `تعذر حفظ الصورة: ${error.message}` }); }
  const key = action === 'panel' ? 'panel_image' : 'line_image';
  S.setSetting(i.guildId, key, relative);
  refresh(i);
  if (action === 'panel') return i.editReply({ content: 'اختر طريقة عرض صورة البانل:', components: [UI.rowSelect('panel_mode', 'طريقة عرض صورة البانل', [
    { label: 'داخل Embed', value: 'embed', emoji: '🖼️' }, { label: 'رسالة عادية', value: 'normal', emoji: '💬' }
  ])] });
  return i.editReply({ content: 'تم حفظ صورة الخط محلياً، وستظهر كفاصل مع لوحة النشر والتكتات الجديدة.' });
}
async function uploadTypeImage(i, tid) {
  if (!S.getType(i.guildId, tid)) return i.reply({ content: 'نوع التكت غير موجود.', flags: MessageFlags.Ephemeral });
  await beginFlow(i, 'تعديل صورة التكت');
  const upload = await promptMessage(i, 'ارفع الصورة الجديدة من جهازك:', { image: true });
  if (!upload) return i.editReply({ content: 'لم يتم استلام صورة صالحة خلال دقيقتين. لم يتم تغيير الصورة.' });
  let relative;
  try { relative = await saveImageAttachment(upload.attachment, 'ticket-type'); await upload.message.delete().catch(() => {}); }
  catch (error) { return i.editReply({ content: `تعذر حفظ الصورة: ${error.message}` }); }
  const key = `${i.user.id}:${tid}`;
  i.client.pendingImages ||= new Map();
  i.client.pendingImages.set(key, relative);
  return i.editReply({ content: 'تم حفظ الصورة محلياً. هل تريد اعتمادها لهذا النوع؟', components: [new ActionRowBuilder().addComponents(
    UI.btn(`confirm_image_${tid}`, 'تأكيد التغيير', ButtonStyle.Success, '✅'),
    UI.btn('cancel_image', 'إلغاء', ButtonStyle.Danger, '✖️')
  )] });
}

async function handleModal(i) {
  const id = i.customId;
  if (id.startsWith('edit_')) {
    const match = id.match(/^edit_(\d+)_(name|emoji)$/);
    if (!match) return i.reply({ content: 'طلب تعديل غير صالح.', flags: MessageFlags.Ephemeral });
    const tid = Number(match[1]), field = match[2], value = i.fields.getTextInputValue('value').trim();
    if (field === 'name' && (!value || value.length > 80)) return i.reply({ content: 'الاسم يجب أن يكون بين 1 و80 حرفاً.', flags: MessageFlags.Ephemeral });
    const parsed = field === 'emoji' ? parseEmoji(value) : value;
    if (field === 'emoji' && value !== '-' && !parsed) return i.reply({ content: 'إيموجي غير صالح. أرسل إيموجي عادي أو مخصص من السيرفر، أو - لإزالته.', flags: MessageFlags.Ephemeral });
    S.updateType(i.guildId, tid, field, parsed);
    refresh(i);
    return i.reply({ content: 'تم تعديل نوع التكت بنجاح.', flags: MessageFlags.Ephemeral });
  }
  if (id === 'set_auto_delete' || id === 'set_auto_reminder') {
    const enabled = Number(i.fields.getTextInputValue('enabled'));
    const minutes = Number(i.fields.getTextInputValue('minutes'));
    if (![0, 1].includes(enabled) || !Number.isInteger(minutes) || minutes < 1 || minutes > 525600)
      return i.reply({ content: 'أدخل 1 أو 0 ومدة صحيحة بالدقائق (1 إلى 525600).', flags: MessageFlags.Ephemeral });
    const del = id === 'set_auto_delete';
    S.setSetting(i.guildId, del ? 'auto_delete' : 'reminders', enabled);
    S.setSetting(i.guildId, del ? 'auto_delete_minutes' : 'reminder_minutes', minutes);
    return i.reply({ content: 'تم حفظ إعدادات الأتمتة.', flags: MessageFlags.Ephemeral });
  }
}
async function handleConfirm(i) {
  if (!isInteractionAdmin(i)) return i.reply({ content: 'غير مصرح.', flags: MessageFlags.Ephemeral });
  const id = i.customId;
  if (id.startsWith('confirm_delete_')) {
    S.deleteType(i.guildId, Number(id.slice('confirm_delete_'.length)));
    refresh(i);
    return i.update({ content: 'تم حذف نوع التكت.', embeds: [], components: [] });
  }
  if (id.startsWith('confirm_image_')) {
    const tid = Number(id.slice('confirm_image_'.length));
    const key = `${i.user.id}:${tid}`;
    const image = i.client.pendingImages?.get(key);
    if (!image || !S.getType(i.guildId, tid)) return i.update({ content: 'انتهت صلاحية الصورة أو نوع التكت غير موجود.', components: [] });
    S.updateType(i.guildId, tid, 'image', image);
    refresh(i);
    i.client.pendingImages.delete(key);
    return i.update({ content: 'تم اعتماد الصورة وتحديث نوع التكت بنجاح.', components: [] });
  }
  if (id.startsWith('cancel_')) {
    const match = id.match(/^cancel_image$/);
    if (match && i.client.pendingImages) {
      for (const key of i.client.pendingImages.keys()) if (key.startsWith(`${i.user.id}:`)) i.client.pendingImages.delete(key);
    }
    return i.update({ content: 'تم الإلغاء، لم يتم تغيير الصورة.', embeds: [], components: [] });
  }
  if (id.startsWith('roles_skip_')) return i.update({ content: 'تم إنشاء نوع التكت بدون رتب مخولة. يمكنك تعيينها لاحقاً.', components: [] });
}
async function restoreVoiceConnections(client) {
  for (const guild of client.guilds.cache.values()) {
    const channelId = S.getSettings(guild.id).voice_channel_id;
    if (!channelId) continue;
    try { await connectVoice(guild, channelId, client); console.log(`[Voice] Connected to configured channel in ${guild.name}`); }
    catch (error) { console.error(`[Voice ${guild.id}] Could not restore connection: ${error.message}`); }
  }
}
async function maintenance(client) {
  for (const guild of client.guilds.cache.values()) {
    const settings = S.getSettings(guild.id);
    if (settings.voice_channel_id) {
      const conn = client.voiceConnections?.get(guild.id);
      const status = conn?.state?.status;
      if (!conn || status === 'destroyed') { client.voiceConnections?.delete(guild.id); await connectVoice(guild, settings.voice_channel_id, client).catch(e => console.error(`[Voice ${guild.id}] Self-heal failed: ${e.message}`)); }
    }
    for (const ticket of S.listTickets(guild.id)) {
      const channel = guild.channels.cache.get(ticket.channel_id);
      if (!channel) { S.removeTicket(ticket.channel_id); continue; }
      if (settings.auto_delete && ticket.status === 'closed' && ticket.closed_at && Date.now() - ticket.closed_at > settings.auto_delete_minutes * 60000) {
        await sendTranscript(channel, ticket, settings); S.removeTicket(channel.id); await channel.delete('Fyora automatic ticket cleanup').catch(() => {}); continue;
      }
      if (settings.reminders && ticket.status === 'open' && Date.now() - ticket.created_at > settings.reminder_minutes * 60000 && (!ticket.last_reminder || Date.now() - ticket.last_reminder > settings.reminder_minutes * 60000)) {
        const owner = await client.users.fetch(ticket.owner_id).catch(() => null);
        if (owner) await owner.send(`تذكير من **${guild.name}**: لديك تكت مفتوح في ${guild.name}.`).catch(() => {});
        if (ticket.staff_id) { const staff = await client.users.fetch(ticket.staff_id).catch(() => null); if (staff) await staff.send(`تذكير: التكت المسند إليك في **${guild.name}** ما زال مفتوحاً.`).catch(() => {}); }
        S.updateTicket(channel.id, 'last_reminder', Date.now());
      }
    }
  }
}
module.exports = { handleButton, handleSelect, handleModal, handleConfirm, maintenance, panelPayload, isAdmin, isInteractionAdmin, restoreVoiceConnections };
