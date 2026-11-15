// Elontopbot: OLX API'dan arzon e'lonlarni topib, @arzonelonkanal ga joylaydi.
// Sozlamalar: config.json. Yuborilganlar: seen.json.
// Test rejimi: DRY_RUN=1 (kanalga yubormaydi), OLX_FILE=olx-api.json (internetsiz sinov).
import { readFile, writeFile } from 'node:fs/promises';

const here = (f) => new URL('./' + f, import.meta.url);
const cfg = JSON.parse(await readFile(here('config.json'), 'utf8'));
const { BOT_TOKEN, CHANNEL_ID, DRY_RUN, OLX_FILE } = process.env;
if (!DRY_RUN && (!BOT_TOKEN || !CHANNEL_ID)) {
  console.error('BOT_TOKEN yoki CHANNEL_ID yo‘q');
  process.exit(1);
}

const CAR_CATEGORY = 983; // OLX: yengil avtomobillar
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
  'Accept': 'application/json',
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
const tag = (s) => '#' + String(s ?? '').trim().replace(/[\s\-–—.,’'‘]+/g, '_').replace(/_+$/, '');

// ---- OLX'dan ma'lumot olish ----
async function fetchOffers(query) {
  if (OLX_FILE) return JSON.parse(await readFile(here(OLX_FILE), 'utf8')).data ?? [];
  const all = [];
  let url = `https://www.olx.uz/api/v1/offers/?offset=0&limit=40&query=${encodeURIComponent(query)}`;
  for (let page = 0; url && page < cfg.max_pages; page++) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    const j = await res.json();
    all.push(...(j.data ?? []));
    url = j.links?.next?.href ?? null;
    await new Promise((r) => setTimeout(r, 1500)); // sahifalar orasida tanaffus
  }
  return all;
}

// ---- E'lonni soddalashtirish ----
const param = (ad, key) => ad.params?.find((p) => p.key === key)?.value;

// Kurs: dollar e'lonlaridagi so'mdagi qiymatdan hisoblanadi
function usdRate(ads) {
  const rates = ads
    .map((a) => param(a, 'price'))
    .filter((p) => p?.currency === 'UYE' && p.value > 0 && p.converted_value > 0)
    .map((p) => p.converted_value / p.value)
    .sort((a, b) => a - b);
  return rates.length ? rates[Math.floor(rates.length / 2)] : cfg.usd_rate_fallback;
}

function normalize(ad, rate) {
  const p = param(ad, 'price');
  let priceUsd = null;
  if (p?.currency === 'UYE') priceUsd = p.value;
  else if (p?.currency === 'UZS' && p.value > 0) priceUsd = p.value / rate;

  const year = Number(param(ad, 'motor_year')?.key) || null;
  let km = Number(param(ad, 'motor_mileage')?.key) || null;
  if (km && km < 1000) km *= 1000; // "250" deb yozilgan bo'lsa = 250 000 km

  const photo = ad.photos?.[0];
  return {
    id: `olx:${ad.id}`,
    url: ad.url,
    title: ad.title?.trim(),
    category: ad.category?.id,
    modelKey: param(ad, 'model')?.key,
    modelLabel: param(ad, 'model')?.label,
    year,
    km,
    priceUsd,
    negotiable: !!p?.negotiable,
    color: param(ad, 'color')?.label,
    fuel: param(ad, 'fuel_type')?.label,
    gearbox: param(ad, 'transmission_type')?.label,
    city: ad.location?.city?.name,
    district: ad.location?.district?.name,
    photo: photo ? photo.link.replace('{width}', photo.width).replace('{height}', photo.height) : null,
  };
}

function passes(a, s) {
  if (a.category !== CAR_CATEGORY) return false;
  if (!s.model_keys.includes(a.modelKey)) return false;
  if (a.priceUsd == null || a.year == null || a.km == null) return false;
  return a.year >= s.year_min && a.year <= s.year_max
      && a.km <= s.mileage_max && a.priceUsd <= s.price_max;
}

// ---- Telegram ----
function caption(a) {
  const lines = [
    `${tag(a.modelLabel)} sotiladi❗️`,
    `📅 Yili: ${a.year}`,
    `👣 Probeg: ${fmt(a.km)} km`,
  ];
  if (a.color) lines.push(`🎨 Rangi: ${esc(a.color)}`);
  if (a.fuel) lines.push(`⛽️ Yoqilg‘i: ${esc(a.fuel)}`);
  if (a.gearbox) lines.push(`⚙️ Uzatma: ${esc(a.gearbox)}`);
  lines.push(`💰 ${fmt(a.priceUsd)}$${a.negotiable ? ' kelishiladi' : ''}`);
  if (a.city) lines.push(`🚩 ${esc(tag(a.city))}${a.district ? ', ' + esc(a.district) : ''}`);
  lines.push(`🔗 <a href="${esc(a.url)}">Manba: OLX</a>`);
  return lines.join('\n');
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
}

async function post(a) {
  const text = caption(a);
  if (DRY_RUN) { console.log('---- (DRY_RUN) ----\n' + text + (a.photo ? `\n[rasm] ${a.photo}` : '')); return; }
  if (a.photo) {
    try { await tg('sendPhoto', { chat_id: CHANNEL_ID, photo: a.photo, caption: text, parse_mode: 'HTML' }); return; }
    catch (e) { console.warn('Rasm bilan yuborilmadi, matn yuboriladi:', e.message); }
  }
  await tg('sendMessage', { chat_id: CHANNEL_ID, text, parse_mode: 'HTML' });
}

// ---- Asosiy qism ----
let seen = [];
try { seen = JSON.parse(await readFile(here('seen.json'), 'utf8')); } catch {}
const seenSet = new Set(seen);

let failures = 0;
const candidates = [];
for (const s of cfg.searches) {
  try {
    const ads = await fetchOffers(s.query);
    const rate = usdRate(ads);
    const list = ads.map((ad) => normalize(ad, rate));
    const ok = list.filter((a) => passes(a, s) && !seenSet.has(a.id));
    console.log(`"${s.query}": ${ads.length} ta e'lon, filtrga mos (yangi): ${ok.length}, kurs: ${Math.round(rate)}`);
    candidates.push(...ok);
  } catch (e) {
    failures++;
    console.error(`"${s.query}" xato: ${e.message}`);
  }
}

const unique = [...new Map(candidates.map((a) => [a.id, a])).values()];
const toPost = unique.sort((a, b) => a.priceUsd - b.priceUsd).slice(0, cfg.per_run);

for (const a of toPost) {
  await post(a);
  seenSet.add(a.id);
  console.log(`Yuborildi: ${a.title} | ${fmt(a.priceUsd)}$`);
}
if (!toPost.length) console.log('Mos e‘lon yo‘q');

if (!DRY_RUN) await writeFile(here('seen.json'), JSON.stringify([...seenSet].slice(-1000), null, 2) + '\n', 'utf8');
if (failures === cfg.searches.length) process.exit(1); // hamma qidiruv xato bo'lsa
