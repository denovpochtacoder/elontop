// Elontopbot: admin tanlagan filtr bo'yicha OLX'dan bozordan arzon e'lonlarni topadi,
// adminga rasm + tugmalar bilan yuboradi, "Kanalga chiqarish" bosilsa kanalga joylaydi.
// Ishga tushirish: run-bot.cmd (token bot-token.txt faylidan o'qiladi).
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fetchOffers, usdRate, normalize, fetchPhone, norm } from './botlib/olx.mjs';
import { cyr, formatPhone, phonesFromText, positionFrom, paintClean } from './botlib/text.mjs';
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
// Adminga keladigan karta (solishtirish ma'lumotlari bilan)
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
  return lines.filter((l, i) => l !== '' || lines[i + 1] === extra).join('\n');
}
// Kanalga chiqadigan post (kirill shablon)
const comma = (n) => Math.round(n).toLocaleString('en-US');
function channelCaption(card) {
  const a = card.ad;
  const text = `${a.title} ${a.description ?? ''}`;
  const pos = positionFrom(text);
  const lines = [`${tag(a.modelLabel || card.modelName)}${pos ? ` ${pos}-позиция` : ''} сотилади`, '', `📅 йили: ${a.year}`];
  if (a.km) lines.push(`👣 пробег: ${comma(a.km)} км`);
  if (paintClean(text)) lines.push('💎 краскаси тоза');
  if (a.color) lines.push(`🎨 ранги: ${esc(cyr(a.color).toLowerCase())}`);
  if (a.fuel) lines.push(`⛽️ ёқилғи: ${esc(cyr(a.fuel).toLowerCase())}`);
  lines.push(`💰 ${comma(a.priceUsd)}$${a.negotiable ? ' келишилади' : ''}`);
  if (card.phone) lines.push(`☎️ ${card.phone}`);
  const region = (a.region ?? '').replace(/\s+(viloyati|Respublikasi)$/i, '');
  const city = a.city && norm(a.city) !== norm(region) ? a.city : '';
  const place = [region && tag(cyr(region)), city && cyr(city)].filter(Boolean).join(', ');
  if (place) lines.push(`🚩 ${esc(place)}`);
  if (!card.phone) lines.push(`🔗 <a href="${esc(a.url)}">Манба: OLX</a>`); // telefon topilmasa, havola
  return lines.join('\n');
}
// mode: 'card' (yangi karta), 'preview' (oldindan ko'rish), 'done' (chiqarilgan yoki o'tkazilgan)
function cardKeyboard(card, mode = 'card') {
  const id = card.ad.id;
  const view = { text: '🔗 Ko‘rish', url: card.ad.url };
  if (mode === 'preview') return { inline_keyboard: [[btn('⬅️ Qaytish', `back:${id}`), btn('📢 Kanalga chiqarish', `pub:${id}`)]] };
  if (mode === 'done') return { inline_keyboard: [[view]] };
  return { inline_keyboard: [[view, btn('👁 Oldindan ko‘rish', `prev:${id}`)], [btn('📢 Kanalga chiqarish', `pub:${id}`), btn('❌ O‘tkazish', `skip:${id}`)]] };
}

// Telefon: avval OLX so'rovi, bo'lmasa e'lon matnidan. Bir marta urinadi.
async function ensurePhone(card) {
  if (card.phoneTried) return;
  card.phoneTried = true;
  let phone = null;
  try { phone = formatPhone(await fetchPhone(card.ad.id)); } catch (e) { console.warn('Telefon so‘rovi xatosi:', e.message); }
  if (!phone) phone = phonesFromText(`${card.ad.title} ${card.ad.description ?? ''}`)[0] ?? null;
  card.phone = phone;
  await save();
}

// ---------- Qidiruv ----------
let busy = false;
let lastSearch = null; // { results, modelName }: "yana ko'rsatish" va "qayta ko'rsatish" uchun

// Kartalarni adminga yuboradi va ko'rsatilgan deb belgilaydi
async function sendCards(chatId, list, modelName) {
  for (const r of list) {
    const card = { ...r, ...(state.cards[r.ad.id] ? { phone: state.cards[r.ad.id].phone, phoneTried: state.cards[r.ad.id].phoneTried } : {}), modelName };
    state.cards[r.ad.id] = card;
    if (!state.shown.includes(r.ad.id)) state.shown.push(r.ad.id);
    const caption = adminCaption(card);
    try {
      if (r.ad.photo) await tg('sendPhoto', { chat_id: chatId, photo: r.ad.photo, caption, parse_mode: 'HTML', reply_markup: cardKeyboard(card) });
      else throw new Error('rasm yo‘q');
    } catch (e) {
      await tg('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: cardKeyboard(card), link_preview_options: { is_disabled: true } });
    }
    await sleep(400);
  }
  await save();
}

// Qidiruvdan keyin: qolgan yoki oldin ko'rsatilgan variantlar uchun tugma
async function sendFollowUp(chatId) {
  if (!lastSearch) return;
  const shown = new Set(state.shown);
  const left = lastSearch.results.filter((r) => !shown.has(r.ad.id)).length;
  const old = lastSearch.results.length - left;
  const rows = [];
  if (left) rows.push([btn(`➡️ Yana ${Math.min(left, cfg.max_cards)} ta ko‘rsatish (qoldi: ${left})`, 'more')]);
  if (old) rows.push([btn(`🔁 Oldin ko‘rsatilgan ${old} tasini qayta ko‘rsatish`, 'again')]);
  if (rows.length) await tg('sendMessage', { chat_id: chatId, text: 'Shu qidiruv bo‘yicha:', reply_markup: { inline_keyboard: rows } });
}

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
    lastSearch = { results, modelName: c.model.name };
    const shown = new Set(state.shown);
    const fresh = results.filter((r) => !shown.has(r.ad.id));
    const toSend = fresh.slice(0, cfg.max_cards);

    let verdict;
    if (toSend.length) verdict = `Yuborilyapti: ${toSend.length}`;
    else if (results.length) verdict = `Arzon variantlar bor (${results.length} ta), lekin hammasi sizga oldin yuborilgan.`;
    else if (stats.inFilter < 5) verdict = `💡 Filtr juda tor: davrga mos atigi ${stats.inFilter} ta e‘lon qoldi. Davrni, probegni yoki viloyatni kengaytiring.`;
    else verdict = `Filtrga mos ${stats.inFilter} ta e‘lon ichida kamida ${c.minDiscount}% arzoni yo‘q. Arzonlik foizini kamaytirib ko‘ring.`;

    const summary = [
      `🔎 <b>${esc(c.model.name)}</b> · ${esc(c.yearLabel)} · ${kmLabel(c.kmMax)} · ${esc(c.region || 'Hammasi')} · ${dayLabel(c.days)}`,
      `Tekshirildi: ${stats.fetched} e‘lon, model mos: ${stats.modelMatched}`,
      `Yili mos: ${stats.yearOk} → probegi mos: ${stats.kmOk} → viloyati mos: ${stats.regionOk} → davrga mos: ${stats.inFilter}`,
      stats.noComparables ? `Solishtirishga o‘xshashi kam: ${stats.noComparables}` : null,
      `Kamida ${c.minDiscount}% arzon: ${results.length}, yangi: ${fresh.length}`,
      verdict,
    ].filter(Boolean).join('\n');
    await tg('editMessageText', { chat_id: chatId, message_id: status.message_id, text: summary, parse_mode: 'HTML' });

    await sendCards(chatId, toSend, c.model.name);
    await sendFollowUp(chatId);
    await tg('sendMessage', { chat_id: chatId, ...menu() });
  } catch (e) {
    console.error('Qidiruv xatosi:', e);
    await tg('editMessageText', { chat_id: chatId, message_id: status.message_id, text: `❌ Qidiruvda xato: ${e.message}` }).catch(() => {});
  } finally {
    busy = false;
  }
}

// "Yana ko'rsatish" (again=false) yoki "qayta ko'rsatish" (again=true)
async function showMore(chatId, again) {
  if (!lastSearch) return false;
  const shown = new Set(state.shown);
  const list = lastSearch.results.filter((r) => (again ? shown.has(r.ad.id) : !shown.has(r.ad.id))).slice(0, cfg.max_cards);
  await sendCards(chatId, list, lastSearch.modelName);
  if (!again) await sendFollowUp(chatId);
  return true;
}

// ---------- Kanalga chiqarish ----------
async function publish(cq, id) {
  const card = state.cards[id];
  if (!card) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'E‘lon ma‘lumoti topilmadi, qayta qidiring', show_alert: true });
  if (state.published.includes(id)) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Bu e‘lon allaqachon chiqarilgan' });
  await ensurePhone(card);
  const caption = channelCaption(card);
  if (card.ad.photo) {
    try { await tg('sendPhoto', { chat_id: cfg.channel_id, photo: card.ad.photo, caption, parse_mode: 'HTML' }); }
    catch { await tg('sendMessage', { chat_id: cfg.channel_id, text: caption, parse_mode: 'HTML' }); }
  } else {
    await tg('sendMessage', { chat_id: cfg.channel_id, text: caption, parse_mode: 'HTML' });
  }
  state.published.push(id);
  await save();
  await editCard(cq, adminCaption(card, '✅ <b>Kanalga chiqarildi</b>'), cardKeyboard(card, 'done'));
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kanalga chiqarildi ✅' });
}

// Kartadagi matn va tugmalarni almashtiradi (rasmli xabarda caption, rasmsizda text)
async function editCard(cq, caption, reply_markup) {
  const m = cq.message;
  if (m.photo) await tg('editMessageCaption', { chat_id: m.chat.id, message_id: m.message_id, caption, parse_mode: 'HTML', reply_markup });
  else await tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, text: caption, parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });
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
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });
  if (cmd === 'menu') {
    await tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...menu() });
    return answer();
  }
  if (cmd === 'set') {
    await tg('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: options(a) } });
    return answer();
  }
  if (cmd === 'v') {
    state.filters[a] = Number(b);
    await save();
    await tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...menu() });
    return answer('Saqlandi');
  }
  if (cmd === 'go') {
    await answer('Qidiruv boshlandi');
    return search(m.chat.id);
  }
  if (cmd === 'more' || cmd === 'again') {
    if (busy) return answer('Qidiruv ketyapti, kuting');
    await answer('Yuborilyapti');
    await tg('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (!(await showMore(m.chat.id, cmd === 'again'))) await tg('sendMessage', { chat_id: m.chat.id, text: 'Bot qayta ishga tushgan, shuning uchun oldingi natija saqlanmagan. Qaytadan 🔍 Qidirish ni bosing.' });
    return;
  }
  if (cmd === 'pub') return publish(cq, a);

  const card = state.cards[a];
  if (!card) return answer('E‘lon ma‘lumoti topilmadi, qayta qidiring', true);
  if (cmd === 'prev') {
    await ensurePhone(card);
    await editCard(cq, channelCaption(card), cardKeyboard(card, 'preview'));
    return answer(card.phone ? 'Kanalda shunday ko‘rinadi' : 'Telefon topilmadi: postda OLX havolasi turadi');
  }
  if (cmd === 'back') {
    await editCard(cq, adminCaption(card), cardKeyboard(card, state.published.includes(a) ? 'done' : 'card'));
    return answer();
  }
  if (cmd === 'skip') {
    await editCard(cq, adminCaption(card, '❌ O‘tkazib yuborildi'), cardKeyboard(card, 'done'));
    return answer('O‘tkazildi');
  }
  return answer();
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
