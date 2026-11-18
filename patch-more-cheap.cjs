// Elontopbot: arzon e'lonlarni ko'proq topish + OLX'ga so'rovlarni kamaytirish (bir marta ishga tushiring)
// Oldin patch-protection.cjs qo'llangan bo'lishi kerak.
//  - Arzonlik darajalari: 3% va undan ko'p (menyuda 3, 5, 6, 10, 15, 20)
//  - Bozor narxi (mediana) 6 soatga saqlanadi, keyingi qidiruvlarda faqat yangi e'lonlar so'raladi
//  - Davr tugashi bilan sahifalarni so'rash to'xtaydi (1 kunlik qidiruvda 2-3 sahifa)
//  - Xulosada OLX'ga nechta so'rov ketgani ko'rsatiladi
const fs = require('fs');
const must = (src, from, to) => {
  if (!src.includes(from)) throw new Error('Kodda kerakli joy topilmadi: ' + from.slice(0, 70));
  return src.replace(from, to);
};

let s = fs.readFileSync('bot.mjs', 'utf8');
let o = fs.readFileSync('botlib/olx.mjs', 'utf8');
if (!s.includes('strikes')) throw new Error('Avval patch-protection.cjs ni ishga tushiring.');
if (s.includes('marketCache')) { console.log('Bu yangilanish allaqachon qo‘llangan, hech narsa o‘zgarmadi.'); process.exit(0); }

// ---------- botlib/olx.mjs ----------
o = must(o, 'async function getJson(url) {', "export const olxStats = { requests: 0 }; // OLX'ga yuborilgan so'rovlar soni\n\nasync function getJson(url) {\n  olxStats.requests++;");
o = must(o, 'export async function fetchOffers(query, maxPages, { file, regionId, yearFrom, yearTo } = {}) {',
  'export async function fetchOffers(query, maxPages, { file, regionId, yearFrom, yearTo, sinceTs, minPages = 1 } = {}) {');
o = must(o, `  const all = [...(first.data ?? [])];
  let next = first.links?.next?.href ?? null;
  for (let page = 1; next && page < maxPages; page++) {
    await sleep(1200);
    const j = await getJson(next);
    all.push(...(j.data ?? []));
    next = j.links?.next?.href ?? null;
  }`,
`  // sinceTs berilsa: sahifada sinceTs'dan yangi e'lon qolmaganda to'xtaymiz (minPages dan keyin)
  const fresh = (list) => !sinceTs || list.some((a) => !a.created_time || Date.parse(a.created_time) >= sinceTs);
  const all = [...(first.data ?? [])];
  let next = first.links?.next?.href ?? null;
  let more = 1 < minPages || fresh(first.data ?? []);
  for (let page = 1; next && more && page < maxPages; page++) {
    await sleep(1200);
    const j = await getJson(next);
    all.push(...(j.data ?? []));
    next = j.links?.next?.href ?? null;
    more = page + 1 < minPages || fresh(j.data ?? []);
  }`);
fs.writeFileSync('botlib/olx.mjs', o);

// ---------- bot.mjs ----------
s = must(s, "import { fetchOffers, usdRate, normalize, fetchPhone, norm } from './botlib/olx.mjs';", "import { fetchOffers, usdRate, normalize, fetchPhone, norm, olxStats } from './botlib/olx.mjs';");
s = must(s, "import { evaluate } from './botlib/market.mjs';", "import { evaluate, periodStart } from './botlib/market.mjs';");
s = must(s, "cache_minutes: 10, phone_per_hour: 10, ...cfg.protection };", "cache_minutes: 10, market_cache_hours: 6, phone_per_hour: 10, ...cfg.protection };");

// darajalar: 3-6% biroz arzon, 6-10% arzon, 10%+ juda arzon
s = must(s, "  if (d >= 20) return '🔥 JUDA ARZON';\n  if (d >= 10) return '✅ ARZON';", "  if (d >= 10) return '🔥 JUDA ARZON';\n  if (d >= 6) return '✅ ARZON';");

s = must(s, "const fetchCache = new Map(); // so'rov kaliti -> { at, raw }: bir xil qidiruv qisqa vaqtda takrorlansa",
  "const marketCache = new Map(); // model+yil -> { at, recentAt, coveredDays, byId, regional }: bozor narxi uchun saqlangan e'lonlar");

// qidiruv: bozor narxi keshi + faqat yangi e'lonlarni so'rash
const a = s.indexOf('    const key = JSON.stringify([c.model.query, yr, c.regionId]);');
const b = s.indexOf('    const rate = usdRate(raw, cfg.usd_rate_fallback);');
if (a < 0 || b < a) throw new Error('Qidiruv bloki topilmadi');
s = s.slice(0, a) + `    const nowTs = Date.now();
    const since = periodStart(c.days, nowTs);
    const periodOpts = { ...yr, sinceTs: since };
    const maxP = cfg.max_pages_period ?? 10;
    const reqBefore = olxStats.requests;
    const mkey = JSON.stringify([c.model.query, yr]);
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
      const rk = \`\${c.regionId}:\${c.days}\`;
      let reg = market.regional.get(rk);
      if (!reg || nowTs - reg.at > PROT.cache_minutes * 60e3) {
        reg = { at: nowTs, list: await fetchOffers(c.model.query, maxP, { ...periodOpts, regionId: c.regionId }) };
        market.regional.set(rk, reg);
        fromCache = false;
      }
      raw = [...new Map([...reg.list, ...raw].map((x) => [x.id, x])).values()];
    }
    const used = olxStats.requests - reqBefore;
` + s.slice(b);
s = must(s, "      fromCache ? `ℹ️ ${PROT.cache_minutes} daqiqa ichidagi natija ishlatildi, OLX'ga qayta so‘rov yuborilmadi.` : null,",
  "      fromCache ? `ℹ️ Saqlangan natija ishlatildi: OLX'ga so‘rov yuborilmadi.` : `ℹ️ OLX'ga ${used} ta so‘rov yuborildi.`,");
fs.writeFileSync('bot.mjs', s);

// ---------- bot-config.json ----------
const c = JSON.parse(fs.readFileSync('bot-config.json', 'utf8'));
c.discounts = [3, 5, 6, 10, 15, 20];
c.defaults.discount = 3;
c.max_pages_period = 10;
c.protection = { ...c.protection, market_cache_hours: 6 };
fs.writeFileSync('bot-config.json', JSON.stringify(c, null, 2) + '\n');
console.log('Tayyor. Botni qayta ishga tushiring (Ctrl+C, so‘ng run-bot.cmd), menyuda "Arzonlik %" ni 3% qiling.');
