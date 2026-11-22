// Elontopbot: admin tanlagan filtr bo'yicha OLX'dan bozordan arzon e'lonlarni topadi,
// adminga rasm + tugmalar bilan yuboradi, "Kanalga chiqarish" bosilsa kanalga joylaydi.
// Ishga tushirish: run-bot.cmd (token bot-token.txt faylidan o'qiladi).
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fetchOffers, usdRate, normalize, fetchPhone, norm, olxStats, findCarCategory, CAR_CATEGORY } from './botlib/olx.mjs';
import { cyr, formatPhone, phonesFromText, positionFrom, paintClean } from './botlib/text.mjs';
import { evaluate, periodStart } from './botlib/market.mjs';

const here = (f) => new URL('./' + f, import.meta.url);
const cfg = JSON.parse(await readFile(here('bot-config.json'), 'utf8'));
const TOKEN = process.env.BOT_TOKEN?.trim();
if (!TOKEN) { console.error('BOT_TOKEN yo‘q (bot-token.txt faylini tekshiring)'); process.exit(1); }

// ---------- Holat (state.json) ----------
let state = { offset: 0, admins: [], filters: { ...cfg.defaults }, cards: {}, published: [], shown: [], cooldownUntil: 0, phoneCooldownUntil: 0, phoneLog: [], strikes: [] };
try { state = { ...state, ...JSON.parse(await readFile(here('state.json'), 'utf8')) }; } catch {}
let saving = Promise.resolve();
function save() { // yozishlar navbat bilan (parallel ishlovchilar uchun)
  saving = saving.then(writeState).catch((e) => console.warn('state.json yozilmadi:', e.message));
  return saving;
}
async function writeState() {
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
// Yoqilg'i filtri (faqat xorijiy modellarda)
const FUELS = [{ key: '', name: 'Hammasi' }, { key: 'electric', name: '⚡ Elektr' }, { key: 'hybrid', name: '🔋 Gibrid' }, { key: 'ice', name: '⛽ Benzin/Dizel' }];
function current() {
  const f = state.filters;
  const y = cfg.years[f.year] ?? cfg.years[0];
  return {
    model: cfg.models[f.model] ?? cfg.models[0],
    yearLabel: y.label, yearFrom: y.from, yearTo: y.to,
    kmMax: cfg.km[f.km] ?? 0,
    region: cfg.regions[f.region]?.name ?? '',
    regionId: cfg.regions[f.region]?.id ?? 0,
    days: f.days,
    minDiscount: f.discount,
    // Narx: xorijiy modellarda "Hammasi" tanlansa qimmatlari ham chiqadi; Chevrolet'da doim faqat arzon
    allPrices: !!((cfg.models[f.model] ?? cfg.models[0]).foreign && f.allPrices),
    fuel: (cfg.models[f.model] ?? cfg.models[0]).foreign ? (FUELS[f.fuel]?.key ?? '') : '',
    fuelName: FUELS[f.fuel]?.name ?? 'Hammasi',
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
    c.model.foreign ? `⛽ Yoqilg‘i: <b>${c.fuel ? c.fuelName : 'Hammasi'}</b>` : null,
    c.allPrices ? '💲 Narx: <b>Hammasi (qimmati ham)</b>' : `📉 Kamida: <b>${c.minDiscount}% arzon</b>`,
    Date.now() < (state.cooldownUntil ?? 0) ? `\n⛔️ OLX cheklovi: ${untilText(state.cooldownUntil)} gacha (IP almashgan bo‘lsa, /olx_reset)` : null,
  ].filter((l) => l !== null).join('\n');
  const reply_markup = { inline_keyboard: [
    [btn('🚗 Model', 'set:model'), btn('📅 Yil', 'set:year')],
    [btn('👣 Probeg', 'set:km'), btn('📍 Viloyat', 'set:region')],
    [btn('🕒 Davr', 'set:days'), btn('📉 Arzonlik %', 'set:discount')],
    ...(c.model.foreign ? [[btn('⛽ Yoqilg‘i', 'set:fuel')]] : []),
    ...(c.model.foreign ? [[btn(c.allPrices ? '💲 Narx: Hammasi ✅ → Faqat arzon' : '💲 Narx: Faqat arzon ✅ → Hammasi', 'tog:allPrices')]] : []),
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
  if (kind === 'region') items = cfg.regions.map((r, i) => btn(mark(f.region === i, r.name || 'Hammasi'), `v:region:${i}`));
  if (kind === 'days') items = cfg.days.map((d) => btn(mark(f.days === d, dayLabel(d)), `v:days:${d}`));
  if (kind === 'fuel') items = FUELS.map((x, i) => btn(mark((f.fuel ?? 0) === i, x.name), `v:fuel:${i}`));
  if (kind === 'discount') items = cfg.discounts.map((d) => btn(mark(f.discount === d, `${d}%+`), `v:discount:${d}`));
  const rows = [];
  const per = kind === 'model' ? 2 : 3;
  for (let i = 0; i < items.length; i += per) rows.push(items.slice(i, i + per));
  rows.push([btn('⬅️ Orqaga', 'menu')]);
  return rows;
}

// ---------- Matnlar ----------
function level(d) {
  if (d >= 10) return '🔥 JUDA ARZON';
  if (d >= 6) return '✅ ARZON';
  return '🟡 BIROZ ARZON';
}
function when(ts) {
  return ts ? new Date(ts).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
}
// Adminga keladigan karta (solishtirish ma'lumotlari bilan)
function adminCaption(card, extra = '') {
  const a = card.ad;
  const lines = [
    card.discount == null ? '⚪️ NARX SOLISHTIRILMADI: o‘xshash e‘lon kam'
      : card.discount >= 0 ? `${level(card.discount)}: o‘rtachadan <b>${Math.round(card.discount)}%</b> arzon`
      : `🔴 QIMMAT: o‘rtachadan <b>${Math.round(-card.discount)}%</b> qimmat`,
    `${esc(tag(a.modelLabel || card.modelName))} · ${a.year} · ${a.km ? fmt(a.km) + ' km' : 'probeg yo‘q'}`,
    [a.gearbox, a.color, a.fuel, a.conditionLabel && `Holati: ${a.conditionLabel}`].filter(Boolean).map(esc).join(' · '),
    `💰 <b>${fmt(a.priceUsd)}$</b>${a.negotiable ? ' kelishiladi' : ''}`,
    card.median != null ? `📊 O‘xshash ${card.n} ta e‘lon o‘rtachasi: ${fmt(card.median)}$` : `📊 O‘xshash e‘lonlar: ${card.n} ta (kamida ${cfg.min_comparables} ta kerak)`,
    `🚩 ${esc([a.region, a.district].filter(Boolean).join(', '))}`,
    `🕒 ${when(a.createdAt)}`,
  ];
  if (card.suspicious) lines.push('⚠️ Narx juda past: bo‘lib to‘lash, xato yoki soxta e‘lon bo‘lishi mumkin');
  if (extra) lines.push('', extra);
  return lines.filter((l, i) => l !== '' || lines[i + 1] === extra).join('\n');
}
// Kanalga chiqadigan post (kirill shablon)
const comma = (n) => Math.round(n).toLocaleString('en-US');
// OLX: "Avtomatik" / "Mexanik" -> kanal uchun kirillda
function gearboxText(label) {
  if (!label) return '';
  if (/avto|авто|automat/i.test(label)) return 'Автомат';
  if (/mex|мех|manual/i.test(label)) return 'Механика';
  return esc(cyr(label));
}
// Xorijiy model: OLX sarlavhasidagi komplektatsiya ("BMW X5 i40 full" -> "i40 full")
const modelCfg = (card) => cfg.models.find((x) => x.name === card.modelName);
const TRIM_STOP = ['mercedes', 'benz', 'mercedesbenz', 'merc', 'bmw', 'byd', 'zeekr', 'chevrolet', 'sotiladi', 'sotaman', 'sotuvda', 'sotiladi', 'srochno', 'срочно', 'продаю', 'продается', 'продаётся', 'продам', 'продажа', 'mashina', 'avtomobil'];
function trimOf(card) {
  const m = modelCfg(card);
  if (!m?.foreign) return '';
  const drop = new Set([...m.name.split(/\s+/), ...m.query.split(/\s+/), ...TRIM_STOP].map((w) => norm(w)));
  const words = String(card.ad.title ?? '').replace(/[^\p{L}\p{N}\s.+\-]/gu, ' ').split(/\s+/)
    .filter((w) => w && norm(w) && !drop.has(norm(w)) && !/^\d{4,}$/.test(w.replace(/[.\s]/g, '')));
  let out = '';
  for (const w of words.slice(0, 5)) { if ((out + ' ' + w).trim().length > 32) break; out = (out + ' ' + w).trim(); }
  return out;
}
function channelCaption(card) {
  const a = card.ad;
  const text = `${a.title} ${a.description ?? ''}`;
  const pos = positionFrom(text);
  const gear = gearboxText(a.gearbox);
  const trim = trimOf(card);
  // Xorijiyda: model + OLX'dagi komplektatsiya (bo'lmasa uzatma qutisi); Chevrolet'da: model + uzatma + pozitsiya
  const head = trim ? `${tag(card.modelName)} ${esc(trim)}` : `${tag(modelCfg(card)?.foreign ? card.modelName : (a.modelLabel || card.modelName))}${gear ? ` ${gear}` : ''}`;
  const lines = [`${head}${pos ? ` ${pos}-позиция` : ''} сотилади`, '', `📅 йили: ${a.year}`];
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
// ---------- Karta ko'rinishi: karusel yoki albom ----------
// card.view: 'carousel' (rasmlar suriladi) | 'album' (kollaj: rasmlar setka bo'lib turadi). Ikkalasi ham bitta xabar.
// card.text: 'admin' (tahlil) | 'channel' (kanal shabloni, oldindan ko'rish)
// card.msgs: { kind: 'rich'|'photo'|'text'|'album', main, album: [], actions }
const photosOf = (card) => (card.ad.photos?.length ? card.ad.photos : card.ad.photo ? [card.ad.photo] : []);
const isDone = (card) => state.published.includes(card.ad.id) || card.skipped;
function textOf(card) {
  if (card.text === 'channel') return channelCaption(card);
  const note = state.published.includes(card.ad.id) ? '✅ <b>Kanalga chiqarildi</b>' : card.skipped ? '❌ O‘tkazib yuborildi' : '';
  return adminCaption(card, note);
}
function keyboard(card) {
  const id = card.ad.id;
  const view = { text: '🔗 Asl e‘lon', url: card.ad.url };
  const list = viewerRows(card);
  if (isDone(card)) return { inline_keyboard: [[view, ...(card.channelUrl ? [{ text: '📢 Kanaldagi post', url: card.channelUrl }] : [])], ...list] };
  const row1 = [btn('✅ Kanalga chiqarish', `pub:${id}`)];
  if (photosOf(card).length > 1) row1.push(card.view === 'album' ? btn('🎠 Karuselda ko‘rish', `car:${id}`) : btn('🖼 Kollajda ko‘rish', `alb:${id}`));
  const row2 = [card.text === 'channel' ? btn('⬅️ Qaytish', `back:${id}`) : btn('👁 Oldindan ko‘rish', `prev:${id}`), view];
  return { inline_keyboard: [row1, row2, ...list] };
}

// ---------- Ko'ruvchi post: bitta xabar, pastida e'lonlar tugmalari ----------
// state.viewers[vid] = { ids, cur, chatId }: tugma bosilsa shu xabarning o'zi boshqa e'longa tahrirlanadi
// Tugma rangi: yashil = arzon (3%+), qizil = qimmat (3%+), oddiy = o'rtacha yoki solishtirilmagan
function listButton(card, i, current) {
  const a = card.ad, d = card.discount;
  const mark = current ? '👉' : state.published.includes(a.id) ? '✅' : d == null ? '⚪️' : d >= 3 ? '🟢' : d <= -3 ? '🔴' : '🟡';
  const pos = positionFrom(`${a.title} ${a.description ?? ''}`);
  const gear = /avto|авто/i.test(a.gearbox ?? '') ? 'Avtomat' : /mex|мех/i.test(a.gearbox ?? '') ? 'Mexanika' : '';
  // Pozitsiya yozilgan bo'lsa o'sha, bo'lmasa uzatma qutisi; probeg to'liq
  const trim = trimOf(card);
  const parts = [trim ? `${card.modelName} ${trim}` : `${modelCfg(card)?.foreign ? card.modelName : (a.modelLabel || card.modelName)} ${pos ? `${pos}-poz` : gear}`.trim(), a.year, a.km ? `${fmt(a.km)} km` : '', `${fmt(a.priceUsd)}$`].filter(Boolean);
  const b = btn(`${mark} ${i + 1}. ${parts.join(' · ')}`, `pick:${card.viewer}:${a.id}`);
  if (d != null && d >= 3) b.style = 'success';
  else if (d != null && d <= -3) b.style = 'danger';
  return [b];
}
function viewerRows(card) {
  const v = card.viewer && state.viewers?.[card.viewer];
  if (!v || v.cur !== card.ad.id) return [];
  return v.ids.filter((x) => state.cards[x]).map((x, i) => listButton(state.cards[x], i, x === v.cur));
}
// Oddiy HTML matn -> rich message HTML: bo'sh qator = yangi paragraf, qator = <br/>
const richParas = (html) => html.split(/\n{2,}/).map((p) => '<p>' + p.split('\n').join('<br/>') + '</p>').join('');
function richHtml(card, html) {
  const ph = photosOf(card);
  const tagName = card.view === 'album' ? 'tg-collage' : 'tg-slideshow';
  const media = ph.length > 1 ? `<${tagName}>` + ph.map((u) => '<img src="' + esc(u) + '"/>').join('') + `</${tagName}>`
    : ph.length ? '<img src="' + esc(ph[0]) + '"/>' : '';
  return media + richParas(html);
}
// Albom: 10 tagacha rasm, matn birinchi rasm tagida. Xabar id'larini qaytaradi.
async function sendAlbum(chatId, card, caption) {
  const ph = photosOf(card);
  if (ph.length > 1) {
    const msgs = await tg('sendMediaGroup', { chat_id: chatId, media: ph.map((url, i) => ({ type: 'photo', media: url, ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}) })) });
    return msgs.map((x) => x.message_id);
  }
  if (ph.length) return [(await tg('sendPhoto', { chat_id: chatId, photo: ph[0], caption, parse_mode: 'HTML' })).message_id];
  return [(await tg('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', link_preview_options: { is_disabled: true } })).message_id];
}
// Karusel xabari: avval rich message, bo'lmasa bitta rasm, u ham bo'lmasa matn
async function sendCarousel(chatId, card, html, reply_markup) {
  try {
    const r = await tg('sendRichMessage', { chat_id: chatId, rich_message: { html: richHtml(card, html) }, ...(reply_markup ? { reply_markup } : {}) });
    return { kind: 'rich', main: r.message_id };
  } catch (e) { console.warn('Karusel/kollaj (rich message) yuborilmadi, oddiy rasm yuboriladi:', e.message); }
  const ph = photosOf(card);
  if (!reply_markup && card.view === 'album' && ph.length > 1) {
    try { return { kind: 'album', album: await sendAlbum(chatId, card, html) }; } catch (e) { console.warn('Albom yuborilmadi:', e.message); }
  }
  if (ph.length) {
    try { return { kind: 'photo', main: (await tg('sendPhoto', { chat_id: chatId, photo: ph[0], caption: html, parse_mode: 'HTML', ...(reply_markup ? { reply_markup } : {}) })).message_id }; }
    catch (e) { console.warn('Rasm yuborilmadi:', e.message); }
  }
  return { kind: 'text', main: (await tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(reply_markup ? { reply_markup } : {}) })).message_id };
}
// Kartani yangidan chizadi (card.view bo'yicha)
async function renderCard(chatId, card) {
  card.msgs = await sendCarousel(chatId, card, textOf(card), keyboard(card));
  const v = card.viewer && state.viewers?.[card.viewer];
  if (v && v.cur === card.ad.id) v.msgId = card.msgs.main;
}
async function clearCard(chatId, card) {
  const ids = card.msgs?.kind === 'album' ? [...card.msgs.album, card.msgs.actions] : [card.msgs?.main];
  for (const id of ids.filter(Boolean)) await tg('deleteMessage', { chat_id: chatId, message_id: id }).catch(() => {});
}
// Matn yoki tugmalar o'zgarganda kartani joyida yangilaydi
async function refreshCard(chatId, card) {
  const m = card.msgs ?? {};
  const html = textOf(card), reply_markup = keyboard(card);
  try {
    if (m.kind === 'album') {
      await tg('editMessageCaption', { chat_id: chatId, message_id: m.album[0], caption: html, parse_mode: 'HTML' }).catch((e) => { if (!/not modified/i.test(e.message)) throw e; });
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: m.actions, reply_markup });
    } else if (m.kind === 'rich') {
      await tg('editMessageText', { chat_id: chatId, message_id: m.main, rich_message: { html: richHtml(card, html) }, reply_markup });
    } else if (m.kind === 'photo') {
      const url = photosOf(card)[0];
      if (url) await tg('editMessageMedia', { chat_id: chatId, message_id: m.main, media: { type: 'photo', media: url, caption: html, parse_mode: 'HTML' }, reply_markup });
      else await tg('editMessageCaption', { chat_id: chatId, message_id: m.main, caption: html, parse_mode: 'HTML', reply_markup });
    } else {
      await tg('editMessageText', { chat_id: chatId, message_id: m.main, text: html, parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });
    }
  } catch (e) {
    if (/not modified/i.test(e.message)) return;
    console.warn('Karta yangilanmadi, qayta yuboriladi:', e.message);
    await clearCard(chatId, card);
    await renderCard(chatId, card);
  }
}

// Telefon: avval OLX so'rovi, bo'lmasa e'lon matnidan. Bir marta urinadi.
async function ensurePhone(card) {
  if (card.phoneTried) return;
  let phone = null;
  const now = Date.now();
  state.phoneLog = (state.phoneLog ?? []).filter((t) => now - t < 3600e3);
  const blocked = now < (state.phoneCooldownUntil ?? 0);
  const overLimit = state.phoneLog.length >= PROT.phone_per_hour;
  if (blocked || overLimit) {
    card.phoneNote = blocked ? `OLX telefon berishni cheklagan, ${untilText(state.phoneCooldownUntil)} gacha kuting` : `Soatlik telefon chegarasi (${PROT.phone_per_hour} ta) tugadi`;
  } else {
    card.phoneTried = true;
    card.phoneNote = null;
    state.phoneLog.push(now);
    try { phone = formatPhone(await fetchPhone(card.ad.id)); }
    catch (e) {
      console.warn('Telefon so‘rovi xatosi:', e.message);
      if (isLimit(e)) { card.phoneTried = false; await startCooldown('phone'); card.phoneNote = `OLX telefon berishni cheklagan, ${untilText(state.phoneCooldownUntil)} gacha kuting`; }
    }
  }
  if (!phone) phone = phonesFromText(`${card.ad.title} ${card.ad.description ?? ''}`)[0] ?? null;
  card.phone = phone;
  await save();
}

// ---------- OLX'dan bloklanmaslik uchun himoya ----------
const PROT = { cooldown_steps_minutes: [120, 1440, 2880], strike_window_hours: 72, cache_minutes: 10, market_cache_hours: 6, phone_per_hour: 10, ...cfg.protection };
const isLimit = (e) => e?.status === 403 || e?.status === 429;
const untilText = (ts) => {
  const long = ts - Date.now() > 12 * 3600e3;
  return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', ...(long ? { day: '2-digit', month: '2-digit' } : {}), hour: '2-digit', minute: '2-digit' });
};
// Takroriy blokda to'xtash vaqti oshadi: 1-marta 2 soat, 2-marta 24 soat, 3-marta va undan keyin 48 soat
async function startCooldown(kind) {
  const now = Date.now();
  state.strikes = (state.strikes ?? []).filter((t) => now - t < PROT.strike_window_hours * 3600e3);
  state.strikes.push(now);
  const steps = PROT.cooldown_steps_minutes;
  const minutes = steps[Math.min(state.strikes.length, steps.length) - 1];
  const until = now + minutes * 60e3;
  if (kind === 'phone') state.phoneCooldownUntil = until; else state.cooldownUntil = until;
  state.lastStrike = state.strikes.length;
  await save();
  console.warn(`OLX cheklov qo'ydi (${kind}, ${state.strikes.length}-marta), ${untilText(until)} gacha to'xtatildi`);
  return until;
}
const marketCache = new Map(); // model+yil -> { at, recentAt, coveredDays, byId, regional }: bozor narxi uchun saqlangan e'lonlar

let busy = false;
let lastSearch = null; // { results, modelName }: "yana ko'rsatish" va "qayta ko'rsatish" uchun

// Kartalarni adminga yuboradi va ko'rsatilgan deb belgilaydi
async function sendCards(chatId, list, modelName) {
  if (!list.length) return;
  state.viewers ??= {};
  const vid = String(Date.now() % 1e9);
  for (const r of list) {
    const old = state.cards[r.ad.id];
    const card = { ...r, ...(old ? { phone: old.phone, phoneTried: old.phoneTried, channelUrl: old.channelUrl } : {}), modelName };
    card.view = 'carousel'; card.text = 'admin'; card.viewer = vid; card.msgs = null;
    state.cards[r.ad.id] = card;
    if (!state.shown.includes(r.ad.id)) state.shown.push(r.ad.id);
  }
  state.viewers[vid] = { ids: list.map((r) => r.ad.id), cur: list[0].ad.id, chatId };
  const vs = Object.keys(state.viewers);
  if (vs.length > 30) for (const k of vs.slice(0, vs.length - 30)) delete state.viewers[k];
  await renderCard(chatId, state.cards[list[0].ad.id]);
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
  if (Date.now() < (state.cooldownUntil ?? 0)) {
    return tg('sendMessage', { chat_id: chatId, text: `⛔️ OLX vaqtincha cheklov qo‘ygan. Bloklanish uzaymasligi uchun bot ${untilText(state.cooldownUntil)} gacha OLX'ga so‘rov yubormaydi.\nIP manzilingiz almashgan bo‘lsa (router o‘chirib-yoqildi yoki telefon hotspot ulandi), /olx_reset yozing.` });
  }
  busy = true;
  const c = current();
  const status = await tg('sendMessage', { chat_id: chatId, text: `⏳ ${c.model.name} bo‘yicha OLX'dan qidirilmoqda...` });
  try {
    // Yil chegarasini 1 yilga kengroq so'raymiz: solishtirish yili ±1 bo'yicha
    const yr = { yearFrom: c.yearFrom ? c.yearFrom - 1 : 0, yearTo: c.yearTo ? c.yearTo + 1 : 0 };
    // Marka kategoriyasi: configda bo'lsa o'sha, bo'lmasa bir marta OLX'dan aniqlanib saqlanadi
    state.categoryIds ??= {};
    let catId = c.model.category ?? state.categoryIds[c.model.query];
    if (!catId) {
      catId = await findCarCategory(c.model.query);
      if (!catId) throw Object.assign(new Error(`OLX'da "${c.model.name}" bo‘yicha mashina e‘lonlari topilmadi`), { userText: true });
      state.categoryIds[c.model.query] = catId;
      await save();
    }
    c.model = { ...c.model, categoryId: catId };
    const nowTs = Date.now();
    const since = periodStart(c.days, nowTs);
    const periodOpts = { ...yr, sinceTs: since, categoryId: catId };
    const maxP = cfg.max_pages_period ?? 10;
    const reqBefore = olxStats.requests;
    const mkey = JSON.stringify([c.model.query, yr, catId]);
    let market = marketCache.get(mkey);
    let fromCache = false;
    if (!market || nowTs - market.at > PROT.market_cache_hours * 3600e3) {
      // Bozor narxi uchun butun mamlakat bo'yicha ko'p sahifa (kuniga bir necha marta)
      const list = await fetchOffers(c.model.query, maxP, { ...periodOpts, minPages: cfg.max_pages });
      market = { at: nowTs, recentAt: nowTs, coveredDays: c.days, byId: new Map(list.map((x) => [x.id, x])), regional: new Map() };
      marketCache.set(mkey, market);
    } else if (nowTs - market.recentAt > PROT.cache_minutes * 60e3 || c.days > market.coveredDays) {
      // Faqat tanlangan davrdagi yangi e'lonlar: davr tugashi bilan to'xtaydi
      const list = await fetchOffers(c.model.query, maxP, periodOpts);
      for (const x of list) market.byId.set(x.id, x);
      market.recentAt = nowTs;
      market.coveredDays = Math.max(market.coveredDays, c.days);
    } else {
      fromCache = true;
    }
    let raw = [...market.byId.values()];
    if (c.regionId) { // tanlangan viloyat e'lonlari alohida so'raladi
      const rk = `${c.regionId}:${c.days}`;
      let reg = market.regional.get(rk);
      if (!reg || nowTs - reg.at > PROT.cache_minutes * 60e3) {
        reg = { at: nowTs, list: await fetchOffers(c.model.query, maxP, { ...periodOpts, regionId: c.regionId }) };
        market.regional.set(rk, reg);
        fromCache = false;
      }
      raw = [...new Map([...reg.list, ...raw].map((x) => [x.id, x])).values()];
    }
    const used = olxStats.requests - reqBefore;
    const rate = usdRate(raw, cfg.usd_rate_fallback);
    const ads = raw.map((a) => normalize(a, rate));
    const { stats, results } = evaluate(ads, c, { minComparables: cfg.min_comparables });
    lastSearch = { results, modelName: c.model.name };
    const shown = new Set(state.shown);
    const fresh = results.filter((r) => !shown.has(r.ad.id));
    const toSend = fresh.slice(0, cfg.max_cards);

    let verdict;
    if (toSend.length) verdict = `Yuborilyapti: ${toSend.length}`;
    else if (results.length) verdict = `${c.allPrices ? 'E‘lonlar' : 'Arzon variantlar'} bor (${results.length} ta), lekin hammasi sizga oldin yuborilgan.`;
    else if (stats.inFilter < 5) verdict = `💡 Filtr juda tor: davrga mos atigi ${stats.inFilter} ta e‘lon qoldi. Davrni, probegni yoki viloyatni kengaytiring.`;
    else verdict = `Filtrga mos ${stats.inFilter} ta e‘lon ichida kamida ${c.minDiscount}% arzoni yo‘q. Arzonlik foizini kamaytirib ko‘ring.`;

    const summary = [
      `🔎 <b>${esc(c.model.name)}</b>${c.fuel ? ` · ${c.fuelName}` : ''} · ${esc(c.yearLabel)} · ${kmLabel(c.kmMax)} · ${esc(c.region || 'Hammasi')} · ${dayLabel(c.days)}`,
      `Tekshirildi: ${stats.fetched} e‘lon, model mos: ${stats.modelMatched}`,
      `Yili mos: ${stats.yearOk} → probegi mos: ${stats.kmOk} → viloyati mos: ${stats.regionOk} → davrga mos: ${stats.inFilter}`,
      stats.noComparables ? `Solishtirishga o‘xshashi kam: ${stats.noComparables}` : null,
      c.allPrices ? `Barcha narxlar: ${results.length}, yangi: ${fresh.length}` : `Kamida ${c.minDiscount}% arzon: ${results.length}, yangi: ${fresh.length}`,
      verdict,
      fromCache ? `ℹ️ Saqlangan natija ishlatildi: OLX'ga so‘rov yuborilmadi.` : `ℹ️ OLX'ga ${used} ta so‘rov yuborildi.`,
    ].filter(Boolean).join('\n');
    await tg('editMessageText', { chat_id: chatId, message_id: status.message_id, text: summary, parse_mode: 'HTML' });

    await sendCards(chatId, toSend, c.model.name);
    await sendFollowUp(chatId);
    await tg('sendMessage', { chat_id: chatId, ...menu() });
  } catch (e) {
    console.error('Qidiruv xatosi:', e);
    let text = `❌ Qidiruvda xato: ${e.message}`;
    if (isLimit(e)) {
      const until = await startCooldown('search');
      text = `⛔️ OLX cheklov qo‘ydi (${e.message}). Bloklanish uzaymasligi uchun bot ${untilText(until)} gacha OLX'ga so‘rov yubormaydi.\nBu ${state.lastStrike}-marta${state.lastStrike >= 2 ? ': takroriy bloklarda kutish vaqti uzayadi' : ''}. Shu vaqtda brauzerda ham OLX'ni ko‘p ochmang.\nIP almashtirgan bo‘lsangiz, /olx_reset yozing.`;
    }
    await tg('editMessageText', { chat_id: chatId, message_id: status.message_id, text }).catch(() => {});
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
async function publish(cq, card) {
  const id = card.ad.id;
  if (state.published.includes(id)) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Bu e‘lon allaqachon chiqarilgan' });
  if (card.publishing) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Chiqarilyapti, kuting' });
  card.publishing = true;
  try { await publishNow(cq, card, id); } finally { delete card.publishing; }
}
async function publishNow(cq, card, id) {
  await ensurePhone(card);
  const caption = channelCaption(card);
  // Kanalga oddiy albom (rich message emas): har qanday admin Premiumsiz tahrirlay oladi, nusxalash buzilmaydi
  let ids;
  try { ids = await sendAlbum(cfg.channel_id, card, caption); }
  catch (e) {
    console.warn("Albom yuborilmadi, bitta rasm bilan chiqariladi:", e.message);
    const one = { ...card, ad: { ...card.ad, photos: photosOf(card).slice(0, 1) } };
    try { ids = await sendAlbum(cfg.channel_id, one, caption); }
    catch (e2) { ids = [(await tg("sendMessage", { chat_id: cfg.channel_id, text: caption, parse_mode: "HTML", link_preview_options: { is_disabled: true } })).message_id]; }
  }
  const postId = ids[0];
  if (postId) card.channelUrl = channelLink(postId);
  state.published.push(id);
  card.text = 'admin';
  await refreshCard(cq.message.chat.id, card);
  await save();
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Kanalga chiqarildi ✅' });
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
  if (msg.text?.startsWith('/olx_reset')) {
    state.cooldownUntil = 0;
    state.phoneCooldownUntil = 0;
    await save();
    return tg('sendMessage', { chat_id: uid, text: '✅ OLX bloki bekor qilindi, qidirish mumkin.\nDiqqat: IP hali almashmagan bo‘lsa, OLX yana bloklaydi va kutish vaqti uzayadi.' });
  }
  if (msg.text?.startsWith('/holat')) {
    const now = Date.now();
    const strikes = (state.strikes ?? []).filter((t) => now - t < PROT.strike_window_hours * 3600e3).length;
    const phones = (state.phoneLog ?? []).filter((t) => now - t < 3600e3).length;
    return tg('sendMessage', { chat_id: uid, text: [
      '📋 <b>Holat</b>',
      now < (state.cooldownUntil ?? 0) ? `⛔️ Qidiruv to‘xtatilgan: ${untilText(state.cooldownUntil)} gacha` : '✅ Qidiruv ochiq',
      now < (state.phoneCooldownUntil ?? 0) ? `⛔️ Telefon so‘rovi to‘xtatilgan: ${untilText(state.phoneCooldownUntil)} gacha` : '✅ Telefon so‘rovi ochiq',
      `Telefon: oxirgi soatda ${phones}/${PROT.phone_per_hour}`,
      `Cheklovlar (oxirgi ${PROT.strike_window_hours} soat): ${strikes}`,
    ].join('\n'), parse_mode: 'HTML' });
  }
  await tg('sendMessage', { chat_id: uid, ...menu() });
}

async function onCallback(cq) {
  const uid = cq.from.id;
  if (!isAdmin(uid)) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Faqat admin uchun' });
  const [cmd, a, b] = cq.data.split(':');
  const m = cq.message;
  const answer = (text, alert = false) => tg('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });
  if (cmd === 'menu') {
    answer().catch(() => {});
    return tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...menu() });
  }
  if (cmd === 'set') {
    answer().catch(() => {});
    return tg('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: options(a) } });
  }
  if (cmd === 'tog' && a === 'allPrices') {
    state.filters.allPrices = !state.filters.allPrices;
    answer(state.filters.allPrices ? 'Qimmatlari ham chiqadi' : 'Faqat arzonlari chiqadi').catch(() => {});
    save();
    return tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...menu() });
  }
  if (cmd === 'v') {
    state.filters[a] = Number(b);
    answer('Saqlandi').catch(() => {});
    save();
    return tg('editMessageText', { chat_id: m.chat.id, message_id: m.message_id, ...menu() });
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
  if (cmd === 'pick') { // ro'yxatdan e'lon tanlash: post joyida tahrirlanadi
    const v = state.viewers?.[a], next = state.cards[b];
    if (!v || !next) return answer('Bu ro‘yxat eskirgan, qayta qidiring', true);
    if (v.cur === b) return answer();
    answer().catch(() => {});
    const prevCard = state.cards[v.cur];
    v.cur = b;
    next.viewer = a; next.text = 'admin';
    next.msgs = { kind: prevCard?.msgs?.kind ?? (m.photo ? 'photo' : 'rich'), main: m.message_id };
    if (next.msgs.kind === 'album' || next.msgs.kind === 'text') next.msgs.kind = 'rich';
    if (prevCard) prevCard.msgs = null;
    await refreshCard(m.chat.id, next);
    v.msgId = next.msgs.main;
    save();
    return;
  }
  const card = state.cards[a];
  if (!card) return answer('E‘lon ma‘lumoti topilmadi, qayta qidiring', true);
  const chatId = m.chat.id;
  // Bot yangilanishidan oldingi kartalar: xabar ma'lumoti yo'q
  if (!card.msgs && cmd !== 'pick') { card.msgs = { kind: m.photo ? 'photo' : 'text', main: m.message_id }; card.view = 'carousel'; card.text = 'admin'; }
  if (cmd === 'pub') return publish(cq, card);
  if (cmd === 'prev') {
    await ensurePhone(card);
    card.text = 'channel';
    await refreshCard(chatId, card);
    await save();
    return answer(card.phone ? 'Kanalda shunday ko‘rinadi' : (card.phoneNote ? card.phoneNote + '. Postda OLX havolasi turadi' : 'Telefon topilmadi: postda OLX havolasi turadi'), !card.phone && !!card.phoneNote);
  }
  if (cmd === 'back') {
    card.text = 'admin';
    await refreshCard(chatId, card);
    await save();
    return answer();
  }
  if (cmd === 'alb' || cmd === 'car') { // ko'rinishni almashtirish: postning o'zi tahrirlanadi
    await answer(cmd === 'alb' ? 'Kollaj ko‘rinishi' : 'Karusel ko‘rinishi');
    card.view = cmd === 'alb' ? 'album' : 'carousel';
    if (card.msgs?.kind === 'rich') await refreshCard(chatId, card);
    else { await clearCard(chatId, card); await renderCard(chatId, card); } // eski turdagi karta
    await save();
    return;
  }
  return answer();
}

// ---------- Asosiy sikl (long polling) ----------
const me = await tg('getMe');
// Kanal manzili (t.me/arzonelonkanal/123 havolasi uchun)
const channelInfo = await tg('getChat', { chat_id: cfg.channel_id }).catch(() => null);
function channelLink(msgId) {
  if (channelInfo?.username) return `https://t.me/${channelInfo.username}/${msgId}`;
  return `https://t.me/c/${String(cfg.channel_id).replace(/^-100/, '')}/${msgId}`;
}
await tg('deleteWebhook'); // tgcloud webhook'i bo'lsa, o'chiriladi (aks holda getUpdates ishlamaydi)
console.log(`@${me.username} ishga tushdi. Adminlar: ${state.admins.join(', ') || 'hali yo‘q (birinchi /start yozgan admin bo‘ladi)'}`);

for (;;) {
  try {
    const updates = await tg('getUpdates', { offset: state.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    for (const u of updates) {
      state.offset = u.update_id + 1;
      // kutmasdan ishga tushiramiz: uzoq qidiruv boshqa tugmalarni to'xtatib turmaydi
      (async () => {
        if (u.message) await onMessage(u.message);
        else if (u.callback_query) await onCallback(u.callback_query);
      })().catch((e) => {
        console.error('Xato:', e.message);
        if (u.callback_query && !/query is too old|not modified/i.test(e.message)) tg('answerCallbackQuery', { callback_query_id: u.callback_query.id, text: 'Xato: ' + e.message.slice(0, 150), show_alert: true }).catch(() => {});
      });
    }
    if (updates.length) await save();
  } catch (e) {
    console.error('Ulanish xatosi:', e.message);
    await sleep(5000);
  }
}
