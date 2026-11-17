'use strict';
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, ChannelType
} = require('discord.js');

const C = 0x7562D9;
const V2_FLAG = 1 << 15;
const btn = (id, label, style = ButtonStyle.Secondary, emoji) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
};
function panelEmbed(title, description) {
  // Classic embed is retained for the individual ticket conversation message.
  const { EmbedBuilder } = require('discord.js');
  return new EmbedBuilder().setColor(C).setTitle(`FYORA STUDIO • ${title}`)
    .setDescription(description).setFooter({ text: 'FYORA STUDIO • TICKET MANAGEMENT' }).setTimestamp();
}
function rowSelect(id, placeholder, options, min = 1, max = 1) {
  const menu = new StringSelectMenuBuilder().setCustomId(id).setPlaceholder(placeholder)
    .setMinValues(min).setMaxValues(max).addOptions(options.slice(0, 25));
  return new ActionRowBuilder().addComponents(menu);
}
function v2(title, description, rows = [], mediaUrl = null) {
  const children = [{ type: 10, content: `# FYORA STUDIO\n## ${title}\n${description}` }];
  if (mediaUrl) children.push({ type: 12, items: [{ media: { url: mediaUrl } }] });
  for (const row of rows) children.push(row?.toJSON ? row.toJSON() : row);
  return { flags: V2_FLAG, components: [{ type: 17, accent_color: C, components: children }] };
}
function homePanel() {
  return v2('لوحة إدارة التكتات', 'مرحباً بك في لوحة التحكم الخاصة بـ **Fyora Studio**.\n\nاختر القسم المطلوب من القائمة لإدارة نظام التكتات.', [
    rowSelect('admin_section', 'اختر قسم الإدارة', [
      { label: 'إعدادات التكت', value: 'types', description: 'إنشاء وتعديل وحذف الأنواع وتحديد الرتب', emoji: '🎫' },
      { label: 'تعيين الصور', value: 'images', description: 'رفع صور البانل والخط وصور التكتات', emoji: '🖼️' },
      { label: 'الإعداد التلقائي', value: 'automation', description: 'الحذف التلقائي والتذكير', emoji: '⏱️' },
      { label: 'تثبيت في فويس', value: 'voice', description: 'إدخال البوت لقناة صوتية وإبقاؤه متصلاً بها', emoji: '🔊' },
      { label: 'نشر لوحة التكت', value: 'publish', description: 'اختر الروم الذي تريد نشر اللوحة فيه', emoji: '📨' }
    ])
  ]);
}
function typePanel(types) {
  const summary = types.length ? types.slice(0, 18).map(t => `• **${t.name}** — ${t.roles.length} رتبة`).join('\n') : 'لا توجد أنواع تكتات حالياً. أنشئ أول نوع من القائمة.';
  return v2('إعدادات التكت', `**الأنواع الحالية: ${types.length}**\n${summary}\n\nاختر العملية المطلوبة:`, [
    rowSelect('type_action', 'اختر عملية التكت', [
      { label: 'إنشاء تكت', value: 'create', description: 'إنشاء نوع جديد برسائل متتابعة', emoji: '➕' },
      { label: 'تعديل تكت', value: 'edit', description: 'تعديل الاسم أو الصورة أو الإيموجي أو الرتب', emoji: '✏️' },
      { label: 'حذف تكت', value: 'delete', description: 'حذف نوع تكت بعد التأكيد', emoji: '🗑️' },
      { label: 'عرض التكتات', value: 'list', description: 'عرض الأنواع والرتب المخولة', emoji: '📋' },
      { label: 'تعيين كتاكوري', value: 'category', description: 'تحديد مكان إنشاء قنوات التكت', emoji: '📁' },
      { label: 'تعيين السجل', value: 'logs', description: 'تحديد روم السجلات وملف المحادثة', emoji: '🧾' }
    ]),
    new ActionRowBuilder().addComponents(btn('admin_home', 'رجوع', ButtonStyle.Secondary, '↩️'))
  ]);
}
function typeSelect(types, customId, placeholder = 'اختر نوع التكت') {
  return rowSelect(customId, placeholder, types.slice(0, 25).map(t => ({ label: t.name.slice(0, 100), value: String(t.id), description: `عدد الرتب المخولة: ${t.roles.length}` })));
}
function imagePanel(settings, types) {
  return v2('إدارة الصور', 'ارفع الصور كمرفقات من جهازك أو جوالك داخل الروم. لا تحتاج إلى نسخ روابط الصور.\n\n' +
    `**صورة البانل:** ${settings.panel_image ? 'مُعيّنة' : 'غير معيّنة'}\n` +
    `**صورة الخط:** ${settings.line_image ? 'مُعيّنة' : 'غير معيّنة'}\n` +
    `**صور أنواع التكت:** ${types.filter(t => t.image).length} من ${types.length}`, [
    rowSelect('image_action', 'اختر إعداد الصور', [
      { label: 'تعيين صورة البانل', value: 'panel', emoji: '🖼️' },
      { label: 'تعيين صورة الخط', value: 'line', emoji: '➖' },
      { label: 'تعديل صور التكتات', value: 'type', emoji: '🎫' },
      { label: 'إزالة صورة البانل', value: 'remove_panel', emoji: '❌' },
      { label: 'إزالة صورة الخط', value: 'remove_line', emoji: '❌' }
    ]),
    new ActionRowBuilder().addComponents(btn('admin_home', 'رجوع', ButtonStyle.Secondary, '↩️'))
  ]);
}
function automationPanel(s) {
  return v2('الإعداد التلقائي', `**الحذف التلقائي:** ${s.auto_delete ? 'مفعّل' : 'معطّل'} — بعد ${s.auto_delete_minutes} دقيقة\n**التذكير:** ${s.reminders ? 'مفعّل' : 'معطّل'} — كل ${s.reminder_minutes} دقيقة`, [
    rowSelect('auto_action', 'اختر الإعداد', [
      { label: 'تعيين مدة الحذف', value: 'delete', emoji: '🗑️' },
      { label: 'تعيين التذكير', value: 'reminder', emoji: '🔔' }
    ]),
    new ActionRowBuilder().addComponents(btn('admin_home', 'رجوع', ButtonStyle.Secondary, '↩️'))
  ]);
}
function modal(id, title, fields) {
  const m = new ModalBuilder().setCustomId(id).setTitle(title);
  m.addComponents(...fields.map(f => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(!!f.required).setMaxLength(f.max || 1000).setPlaceholder(f.placeholder || '')
  )));
  return m;
}
function ticketPanel(types, settings, files = {}) {
  // Single Components V2 message, in this exact order: panel image -> select menu -> line image.
  const options = types.slice(0, 25).map(t => ({ label: t.name.slice(0, 100), value: String(t.id), description: 'فتح تكت دعم جديد', emoji: t.emoji || '🎫' }));
  const text = settings.panel_text || (types.length ? 'اختر القسم المناسب لفتح تكت جديد.' : 'لا توجد أنواع تكت متاحة حالياً.');
  const gallery = file => ({ type: 12, items: [{ media: { url: `attachment://${file.name}` } }] });
  const children = [{ type: 10, content: text }];
  if (files.panel) children.push(gallery(files.panel));
  if (types.length) children.push(rowSelect('open_ticket', 'اختر نوع التكت لفتحه', options).toJSON());
  if (files.line) children.push(gallery(files.line));
  const components = settings.panel_image_mode === 'normal' ? children : [{ type: 17, accent_color: C, components: children }];
  return { flags: V2_FLAG, components, files: [files.panel, files.line].filter(Boolean) };
}

module.exports = { C, V2_FLAG, btn, panelEmbed, v2, homePanel, typePanel, typeSelect, imagePanel, automationPanel, ticketPanel, rowSelect, modal,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder, ChannelType };
