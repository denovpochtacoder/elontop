import { readFile, writeFile } from 'node:fs/promises';

const cfg = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const SEEN_FILE = new URL('./seen.json', import.meta.url);
const { BOT_TOKEN, CHANNEL_ID } = process.env;
if (!BOT_TOKEN || !CHANNEL_ID) throw new Error('BOT_TOKEN yoki CHANNEL_ID yo‘q');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => n.toLocaleString('en-US').replace(/,/g, ' ');

async function loadSeen() {
  try { return JSON.parse(await readFile(SEEN_FILE, 'utf8')); } catch { return []; }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// OLX sahifasidagi __NEXT_DATA__ JSON ichidan e'lonlarni yig'adi
function extractAds(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  const found = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      if (typeof node.title === 'string' && typeof node.url === 'string' && node.url.includes('/d/')) {
        found.set(node.url, node);
      }
      Object.values(node).forEach(walk);
    }
  };
  walk(JSON.parse(m[1]));
  return [...found.values()];
}

const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function paramValue(ad, keys) {
  for (const list of [ad.params, ad.attributes, ad.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      const k = String(p.key ?? p.name ?? p.code ?? '').toLowerCase();
      if (keys.includes(k)) return p.value ?? p.displayValue ?? p.label;
    }
  }
  return undefined;
}

function getPrice(ad) {
  const p = ad.price;
  if (typeof p === 'number') return p;
  if (typeof p === 'string') return toNum(p);
  if (p && typeof p === 'object') {
    const cur = String(p.currency ?? p.currencyCode ?? '').toUpperCase();
    if (cur && cur !== 'USD') return null;
    return toNum(p.value ?? p.regularPrice?.value ?? p.displayValue);
  }
  return null;
}

function normalize(ad) {
  return {
    url: new URL(ad.url, 'https://www.olx.uz').href,
    title: String(ad.title).trim(),
    price: getPrice(ad),
    year: toNum(paramValue(ad, ['year'])),
    mileage: toNum(paramValue(ad, ['mileage'])),
  };
}

// Faqat to'liq ma'lumotli va filtrga tushgan e'lonlar
function passes(a) {
  if (a.price == null || a.year == null || a.mileage == null) return false;
  if (!cfg.models.some((m) => a.title.toLowerCase().includes(m.toLowerCase()))) return false;
  return a.year >= cfg.year_min && a.year <= cfg.year_max
      && a.mileage <= cfg.mileage_max && a.price <= cfg.price_max;
}

async function sendAd(ad) {
  const text = [
    `🚗 ${esc(ad.title)}`,
    `📅 Yil: ${ad.year}`,
    `🛣 Probeg: ${fmt(ad.mileage)} km`,
    `💰 Narx: ${fmt(ad.price)} $`,
    `📍 Manba: ${esc(ad.url)}`,
  ].join('\n');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHANNEL_ID, text, parse_mode: 'HTML' }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram xato: ${body.description}`);
}

// ---- asosiy qism ----
const seen = new Set(await loadSeen());
const all = new Map();

for (const url of cfg.search_urls) {
  try {
    const ads = extractAds(await fetchHtml(url));
    console.log(`${url}: ${ads.length} ta e'lon topildi`);
    if (ads.length === 0) console.warn('Diqqat: e‘lonlar topilmadi, OLX strukturasi o‘zgargan bo‘lishi mumkin');
    for (const ad of ads) {
      const n = normalize(ad);
      all.set(n.url, n);
    }
  } catch (e) {
    console.error(e.message);
  }
}

const candidates = [...all.values()]
  .filter((a) => !seen.has(a.url) && passes(a))
  .sort((a, b) => a.price - b.price)
  .slice(0, cfg.per_run);

for (const ad of candidates) {
  await sendAd(ad);
  seen.add(ad.url);
  console.log(`Yuborildi: ${ad.title} | ${ad.price}$`);
}

if (candidates.length === 0) console.log('Mos e‘lon yo‘q');

await writeFile(SEEN_FILE, JSON.stringify([...seen].slice(-500), null, 2) + '\n', 'utf8');
