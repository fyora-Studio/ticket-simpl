'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;

class Builder {
  constructor() { this.data = {}; }
  setCustomId(v) { this.data.custom_id = v; return this; }
  setPlaceholder(v) { this.data.placeholder = v; return this; }
  setMinValues(v) { this.data.min_values = v; return this; }
  setMaxValues(v) { this.data.max_values = v; return this; }
  addOptions(v) { this.data.options = v; return this; }
  addComponents(...v) { this.data.components = v.map(x => x?.toJSON ? x.toJSON() : x); return this; }
  setLabel(v) { this.data.label = v; return this; }
  setStyle(v) { this.data.style = v; return this; }
  setDisabled(v) { this.data.disabled = v; return this; }
  setEmoji(v) { this.data.emoji = v; return this; }
  setChannelTypes(...v) { this.data.channel_types = v; return this; }
  setTitle(v) { this.data.title = v; return this; }
  setDescription(v) { this.data.description = v; return this; }
  setFooter(v) { this.data.footer = v; return this; }
  setTimestamp() { return this; }
  setColor(v) { this.data.color = v; return this; }
  addFields(...v) { this.data.fields = v; return this; }
  setImage(v) { this.data.image = v; return this; }
  setThumbnail(v) { this.data.thumbnail = v; return this; }
  setRequired(v) { this.data.required = v; return this; }
  setMaxLength(v) { this.data.max_length = v; return this; }
  setPlaceholder(v) { this.data.placeholder = v; return this; }
  toJSON() { return { ...this.data, type: this.constructor.type || 1 }; }
}
class ActionRowBuilder extends Builder { } ActionRowBuilder.type = 1;
class StringSelectMenuBuilder extends Builder { } StringSelectMenuBuilder.type = 3;
class RoleSelectMenuBuilder extends Builder { } RoleSelectMenuBuilder.type = 6;
class ChannelSelectMenuBuilder extends Builder { } ChannelSelectMenuBuilder.type = 8;
class ButtonBuilder extends Builder { } ButtonBuilder.type = 2;
class ModalBuilder extends Builder { }
class TextInputBuilder extends Builder { } TextInputBuilder.type = 4;
class EmbedBuilder extends Builder { }
class AttachmentBuilder { constructor(data, options) { this.data = data; this.options = options; } }
class PermissionsBitField {
  constructor(bits = 0n) { this.bitfield = BigInt(bits); }
  has(bit) { return (this.bitfield & BigInt(bit)) === BigInt(bit); }
}
PermissionsBitField.Flags = { Administrator: 8n, ViewChannel: 1n, SendMessages: 2n, ReadMessageHistory: 4n, AttachFiles: 16n, ManageChannels: 32n, ManageMessages: 64n };
const mock = {
  PermissionsBitField, ChannelType: { GuildText: 0, GuildVoice: 2, GuildCategory: 4 }, AttachmentBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle: { Short: 1, Paragraph: 2 }
};
Module._load = function(request, parent, isMain) { if (request === 'discord.js') return mock;
  if (request === '@discordjs/voice') return { joinVoiceChannel: () => ({ on(){}, destroy(){} }), entersState: async () => true, VoiceConnectionStatus: { Ready: 'ready' } };
  return originalLoad.call(this, request, parent, isMain); };

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'tickets.json');
const originalData = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null;
(async () => {
try {
  const UI = require('../src/ui');
  const S = require('../src/store');
  const H = require('../src/handlers');
  const home = UI.homePanel();
  assert.equal(home.flags, 32768, 'admin home uses Components V2');
  assert.equal(home.components[0].type, 17, 'admin home has a V2 container');
  assert.equal(home.components[0].components[1].type, 1, 'admin home has a select row');
  assert.equal(home.components[0].components[1].components[0].custom_id, 'admin_section');

  const types = [{ id: 1, name: 'الدعم', roles: ['456'], emoji: '🎫', image: null }];
  assert.equal(UI.typePanel(types).flags, 32768);
  assert.equal(UI.imagePanel({ panel_image: null, line_image: null }, types).flags, 32768);
  assert.equal(UI.automationPanel({ auto_delete: 0, auto_delete_minutes: 60, reminders: 1, reminder_minutes: 30 }).flags, 32768);

  const guildId = 'smoke-guild';
  const id = S.createType(guildId, 'Smoke Test', ['456'], '🎫', null);
  assert.equal(S.getType(guildId, id).name, 'Smoke Test');
  assert.equal(S.updateType(guildId, id, 'image', 'https://cdn.example/image.png'), true);
  assert.equal(S.getType(guildId, id).image, 'https://cdn.example/image.png');
  S.setSetting(guildId, 'voice_channel_id', 'voice123');
  assert.equal(S.getSettings(guildId).voice_channel_id, 'voice123');
  const payload = H.panelPayload({ id: guildId });
  assert.equal(payload.flags, 32768, 'ticket panel is a V2 message');
  assert.equal(payload.components[0].type, 17);
  assert.equal(H.isAdmin({ permissions: '8' }), true);
  assert.equal(H.isInteractionAdmin({ guild: { ownerId: 'owner' }, user: { id: 'owner' } }), true);

  const adminBase = { guild: { id: guildId, ownerId: 'owner' }, guildId, user: { id: 'owner' }, memberPermissions: { has: () => false }, client: { pendingImages: new Map() } };
  let updated;
  const voiceChannel = { id: 'voice456', type: 2, permissionsFor: () => ({ has: () => true }) };
  const voiceGuild = { id: guildId, ownerId: 'owner', voiceAdapterCreator: {}, channels: { fetch: async () => voiceChannel }, members: { me: {}, fetchMe: async () => ({}) } };
  const voiceClient = { voiceConnections: new Map() };
  await H.handleSelect({ ...adminBase, guild: voiceGuild, client: voiceClient, customId: 'pick_voice', values: ['voice456'], deferUpdate: async () => {}, editReply: async p => { updated = p; } });
  assert.equal(S.getSettings(guildId).voice_channel_id, 'voice456', 'voice selection persists after connecting');
  assert.ok(voiceClient.voiceConnections.has(guildId), 'voice connection is retained by guild');
  await H.handleSelect({ ...adminBase, customId: 'panel_mode', values: ['normal'], update: async p => { updated = p; } });
  assert.equal(S.getSettings(guildId).panel_image_mode, 'normal', 'panel image mode persists');
  const editImage = { ...adminBase, customId: 'confirm_image_' + id, client: { pendingImages: new Map([[`owner:${id}`, 'https://cdn.example/new.png']]) }, update: async p => { updated = p; } };
  await H.handleConfirm(editImage);
  assert.equal(S.getType(guildId, id).image, 'https://cdn.example/new.png', 'image confirmation updates the type');
  const editModal = { ...adminBase, customId: `edit_${id}_name`, fields: { getTextInputValue: () => 'Updated Name' }, reply: async p => { updated = p; } };
  await H.handleModal(editModal);
  assert.equal(S.getType(guildId, id).name, 'Updated Name', 'name edit persists');
  const rolesSelect = { ...adminBase, customId: `edit_roles_${id}`, values: ['staff789'], update: async p => { updated = p; } };
  await H.handleSelect(rolesSelect);
  assert.deepEqual(S.getType(guildId, id).roles, ['staff789'], 'role selection persists');
  S.deleteType(guildId, id);
  assert.equal(S.getType(guildId, id), null);
  console.log('SMOKE_OK: V2 payloads, select routes, image confirmation, type editing, voice settings, JSON CRUD, and admin permissions.');
} finally {
  Module._load = originalLoad;
  try {
    if (originalData) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(dataFile, originalData); }
    else fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
}
})().catch(error => { console.error(error); process.exitCode = 1; });
