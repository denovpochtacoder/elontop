// Elontopbot: admin tanlagan filtr bo'yicha OLX'dan bozordan arzon e'lonlarni topadi,
// adminga rasm + tugmalar bilan yuboradi, "Kanalga chiqarish" bosilsa kanalga joylaydi.
// Ishga tushirish: run-bot.cmd (token bot-token.txt faylidan o'qiladi).
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fetchOffers, usdRate, normalize } from './botlib/olx.mjs';
import { evaluate } from './botlib/market.mjs';

const here = (f) => new URL('./' + f, import.meta.url);
const cfg = JSON.parse(await readFile(here('bot-config.json'), 'utf8'));
const TOKEN = process.env.BOT_TOKEN?.trim();
if (!TOKEN) { console.error('BOT_TOKEN yo‘q (bot-token.txt faylini tekshiring)'); process.exit(1); }

// ---------- Holat (state.json) ----------
let state = { offset: 0, admins: [], filters: { ...cfg.defaults }, cards: {}, published: [], shown: [] };
try { state = { ...state, ...JSON.parse(await readFile(here('state.json'), 'utf8')) }; } catch {}
async function save() {
  const ids = Object.keys(state.cards);
  if (ids.length > 300) for (const id of ids.slice(0, ids.length - 300)) delete state.cards[id];
  state.published = state.published.slice(-2000);
  state.shown = state.shown.slice(-3000);
  await writeFile(here('state.json.tmp'), JSON.stringify(state), 'utf8');
  await rename(here('state.json.tmp'), here('state.json'));
}

// ---------- Telegram ----------
async function tg(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
const tag = (s) => '#' + String(s ?? '').trim().replace(/[\s\-–—.,’'‘]+/g, '_').replace(/_+$/, '');
const btn = (text, data) => ({ text, callback_data: data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Filtrlar ----------
function current() {
  const f = state.filters;
  const y = cfg.years[f.year] ?? cfg.years[0];
  return {
    model: cfg.models[f.model] ?? cfg.models[0],
    yearLabel: y.label, yearFrom: y.from, yearTo: y.to,
    kmMax: cfg.km[f.km] ?? 0,
    region: cfg.regions[f.region] ?? '',
    days: f.days,
    minDiscount: f.discount,
  };
}
const kmLabel = (v) => (v ? `${fmt(v)} km gacha` : 'Hammasi');
const dayLabel = (d) => (d === 1 ? 'Oxirgi 24 soat' : `Oxirgi ${d} kun`);

function menu() {
  const c = current();
  const text = [
    '⚙️ <b>Qidiruv sozlamalari</b>',
    '',
    `🚗 Model: <b>${esc(c.model.name)}</b>`,
    `📅 Yil: <b>${esc(c.yearLabel)}</b>`,
    `👣 Probeg: <b>${kmLabel(c.kmMax)}</b>`,
    `📍 Viloyat: <b>${esc(c.region || 'Hammasi')}</b>`,
    `🕒 Davr: <b>${dayLabel(c.days)}</b>`,
    `📉 Kamida: <b>${c.minDiscount}% arzon</b>`,
  ].join('\n');
  const reply_markup = { inline_keyboard: [
    [btn('🚗 Model', 'set:model'), btn('📅 Yil', 'set:year')],
    [btn('👣 Probeg', 'set:km'), btn('📍 Viloyat', 'set:region')],
    [btn('🕒 Davr', 'set:days'), btn('📉 Arzonlik %', 'set:discount')],
    [btn('🔍 Qidirish', 'go')],
  ] };
  return { text, reply_markup, parse_mode: 'HTML' };
}

function options(kind) {
  const f = state.filters;
  const mark = (on, t) => (on ? '✅ ' : '') + t;
  let items = [];
  if (kind === 'model') items = cfg.models.map((m, i) => btn(mark(f.model === i, m.name), `v:model:${i}`));
  if (kind === 'year') items = cfg.years.map((y, i) => btn(mark(f.year === i, y.label), `v:year:${i}`));
  if (kind === 'km') items = cfg.km.map((v, i) => btn(mark(f.km === i, kmLabel(v)), `v:km:${i}`));
  if (kind === 'region') items = cfg.regions.map((r, i) => btn(mark(f.region === i, r || 'Hammasi'), `v:region:${i}`));
  if (kind === 'days') items = cfg.days.map((d) => btn(mark(f.days === d, dayLabel(d)), `v:days:${d}`));
  if (kind === 'discount') items = cfg.discounts.map((d) => btn(mark(f.discount === d, `${d}%+`), `v:discount:${d}`));
  const rows = [];
  for (let i = 0; i < items.length; i += 3) rows.push(items.slice(i, i + 3));
  rows.push([btn('⬅️ Orqaga', 'menu')]);
  return rows;
}

// ---------- Matnlar ----------
function level(d) {
  if (d >= 20) return '🔥 JUDA ARZON';
  if (d >= 10) return '✅ ARZON';
  return '🟡 BIROZ ARZON';
}
function when(ts) {
  return ts ? new Date(ts).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}
function adminCaption(card, extra = '') {
  const a = card.ad;
  const lines = [
    `${level(card.discount)}: o‘rtachadan <b>${Math.round(card.discount)}%</b> arzon`,
    `${esc(tag(a.modelLabel || card.modelName))} · ${a.year} · ${a.km ? fmt(a.km) + ' km' : 'probeg yo‘q'}`,
    [a.gearbox, a.color, a.fuel, a.conditionLabel && `Holati: ${a.conditionLabel}`].filter(Boolean).map(esc).join(' · '),
    `💰 <b>${fmt(a.priceUsd)}$</b>${a.negotiable ? ' kelishiladi' : ''}`,
    `📊 O‘xshash ${card.n} ta e‘lon o‘rtachasi: ${fmt(card.median)}$`,
    `🚩 ${esc([a.region, a.district].filter(Boolean).join(', '))}`,
    `🕒 ${when(a.createdAt)}`,
  ];
  if (card.suspicious) lines.push('⚠️ Narx juda past: bo‘lib to‘lash, xato yoki soxta e‘lon bo‘lishi mumkin');
  if (extra) lines.push('', extra);
  return lines.filter((l) => l !== '').join('\n');
}
function channelCaption(card) {
  const a = card.ad;
  const lines = [`${tag(a.modelLabel || card.modelName)} sotiladi❗️`, `📅 Yili: ${a.year}`];
  if (a.km) lines.push(`👣 Probeg: ${fmt(a.km)} km`);
  if (a.color) lines.push(`🎨 Rangi: ${esc(a.color)}`);
  if (a.fuel) lines.push(`⛽️ Yoqilg‘i: ${esc(a.fuel)}`);
  if (a.gearbox) lines.push(`⚙️ Uzatma: ${esc(a.gearbox)}`);
  lines.push(`💰 ${fmt(a.priceUsd)}$${a.negotiable ? ' kelishiladi' : ''}`);
  lines.push(`📉 Bozor narxidan ~${Math.round(card.discount)}% arzon`);
  const place = a.city || a.region;
  if (place) lines.push(`🚩 ${esc(tag(place))}${a.district ? ', ' + esc(a.district) : ''}`);
  lines.push(`🔗 <a href="${esc(a.url)}">Manba: OLX</a>`);
  return lines.join('\n');
}
function cardKeyboard(card, published = false) {
  const rows = [[{ text: '🔗 Ko‘rish', url: card.ad.url }]];
  if (!published) rows.push([btn('📢 Kanalga chiqarish', `pub:${card.ad.id}`), btn('❌ O‘tkazish', `skip:${card.ad.id}`)]);
  return { inline_keyboard: rows };
}

// ---------- Qidiruv ----------
let busy = false;
async function search(chatId) {
  if (busy) return tg('sendMessage', { chat_id: chatId, text: '⏳ Qidiruv allaqachon ketyapti, kuting.' });
  busy = true;
  const c = current();
  const status = await tg('sendMessage', { chat_id: chatId, text: `⏳ ${c.model.name} bo‘yicha OLX'dan qidirilmoqda...` });
  try {
    const raw = await fetchOffers(c.model.query, cfg.max_pages);
    const rate = usdRate(raw, cfg.usd_rate_fallback);
    const ads = raw.map((a) => normalize(a, rate));
    const { stats, results } = evaluate(ads, c, { minComparables: cfg.min_comparables });
    const shown = new Set(state.shown);
    const fresh = results.filter((r) => !shown.has(r.ad.id));
    const toSend = fresh.slice(0, cfg.max_cards);

    const summary = [
      `🔎 <b>${esc(c.model.name)}</b> · ${esc(c.yearLabel)} · ${kmLabel(c.kmMax)} · ${esc(c.region || 'Hammasi')} · ${dayLabel(c.days)}`,
      `Tekshirildi: ${stats.fetched} e‘lon, model mos: ${stats.modelMatched}`,
      `Yili mos: ${stats.yearOk} → probegi mos: ${stats.kmOk} → viloyati mos: ${stats.regionOk} → davrga mos: ${stats.inFilter}`,
      stats.noComparables ? `Solishtirishga o‘xshashi kam: ${stats.noComparables}` : null,
      `Kamida ${c.minDiscount}% arzon: ${results.length}, yangi: ${fresh.length}`,
      toSend.length ? `Yuborilyapti: ${toSend.length}` : 'Yangi arzon variant topilmadi.',
    ].filter(Boolean).join('\n');
    await tg('editMessageText', { chat_id: chatId, message_id: status.message_id, text: summary, parse_mode: 'HTML' });

    for (const r of toSend) {
      const card = { ...r, modelName: c.model.name };
      state.cards[r.ad.id] = card;
      state.shown.push(r.ad.id);
      const caption = adminCaption(card);
      try {
        if (r.ad.photo) await tg('sendPhoto', { chat_id: chatId, photo: r.ad.photo, caption, parse_mode: 'HTML', reply_markup: cardKeyboard(card) });
        else throw new Error('rasm yo‘q');
      } catch (e) {
        await tg('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: cardKeyboard(card) });
      }
      await sleep(400);
    }
    await save();
    await tg('sendMessage', { chat_id: chatId, ...menu() });
  } catch (e) {
    console.error('Qidiruv xatosi:', e);
    await tg('editMessageText', { chat_id: chatId, message_id: status.message_id, text: `❌ Qidiruvda xato: ${e.message}` }).catch(() => {});
  } finally {
    busy = false;
  }
}

// ---------- Kanalga chiqarish ----------
async function publish(cq, id) {
  const card = state.cards[id];
  if (!card) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'E‘lon ma‘lumoti topilmadi, qayta qidiring', show_alert: true });
  if (state.published.includes(id)) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Bu e‘lon allaqachon chiqarilgan' });
  const caption = channelCaption(card);
  if (card.ad.photo) {
    try { await tg('sendPhoto', { chat_id: cfg.channel_id, photo: card.ad.photo, caption, parse_mode: 'HTML' }); }
    catch { await tg('sendMessage', { chat_id: cfg.channel_id, text: caption, parse_mode: 'HTML' }); }
  } else {
    await tg('sendMessage', { chat_id: cfg.channel_id, text: caption, parse_mode: 'HTML' });
  }
  state.published.push(id);
  await save();
  await updateCard(cq, card, '✅ <b>Kanalga chiqarildi</b>', true);
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kanalga chiqarildi ✅' });
}

async function updateCard(cq, card, note, published) {
  const m = cq.message;
  const caption = adminCaption(card, note);
  const reply_markup = cardKeyboard(card, published);
  if (m.photo) await tg('editMessageCaption', { chat_id: m.chat.id, message_id: m.message_id, caption, parse_mode: 'HTML', reply_markup }).catch(() => {});
  else await tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: caption, parse_mode: 'HTML', reply_markup }).catch(() => {});
}

// ---------- Update'larni qayta ishlash ----------
const isAdmin = (id) => state.admins.includes(id);

async function onMessage(msg) {
  const uid = msg.from?.id;
  if (!uid || msg.chat.type !== 'private') return;
  if (!state.admins.length && msg.text?.startsWith('/start')) {
    state.admins.push(uid);
    await save();
    console.log('Admin belgilandi:', uid);
    await tg('sendMessage', { chat_id: uid, text: `Siz admin qilib belgilandingiz (ID: ${uid}).` });
  }
  if (!isAdmin(uid)) return tg('sendMessage', { chat_id: uid, text: `Bu bot faqat admin uchun. Sizning ID: ${uid}` });
  await tg('sendMessage', { chat_id: uid, ...menu() });
}

async function onCallback(cq) {
  const uid = cq.from.id;
  if (!isAdmin(uid)) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Faqat admin uchun' });
  const [cmd, a, b] = cq.data.split(':');
  const m = cq.message;
  if (cmd === 'menu') {
    await tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...menu() });
    return tg('answerCallbackQuery', { callback_query_id: cq.id });
  }
  if (cmd === 'set') {
    await tg('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: options(a) } });
    return tg('answerCallbackQuery', { callback_query_id: cq.id });
  }
  if (cmd === 'v') {
    state.filters[a] = Number(b);
    await save();
    await tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...menu() });
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Saqlandi' });
  }
  if (cmd === 'go') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Qidiruv boshlandi' });
    return search(m.chat.id);
  }
  if (cmd === 'pub') return publish(cq, a);
  if (cmd === 'skip') {
    const card = state.cards[a];
    if (card) await updateCard(cq, card, '❌ O‘tkazib yuborildi', true);
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'O‘tkazildi' });
  }
  return tg('answerCallbackQuery', { callback_query_id: cq.id });
}

// ---------- Asosiy sikl (long polling) ----------
const me = await tg('getMe');
await tg('deleteWebhook'); // tgcloud webhook'i bo'lsa, o'chiriladi (aks holda getUpdates ishlamaydi)
console.log(`@${me.username} ishga tushdi. Adminlar: ${state.admins.join(', ') || 'hali yo‘q (birinchi /start yozgan admin bo‘ladi)'}`);

for (;;) {
  try {
    const updates = await tg('getUpdates', { offset: state.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    for (const u of updates) {
      state.offset = u.update_id + 1;
      try {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      } catch (e) {
        console.error('Xato:', e.message);
        if (u.callback_query) await tg('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: 'Xato: ' + e.message.slice(0, 150), show_alert: true }).catch(() => {});
      }
    }
    if (updates.length) await save();
  } catch (e) {
    console.error('Ulanish xatosi:', e.message);
    await sleep(5000);
  }
}
