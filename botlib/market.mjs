// Bozor narxi bilan solishtirish: har bir e'lon o'ziga o'xshash e'lonlar medianasi bilan
import { CAR_CATEGORY, norm } from './olx.mjs';

export function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Model mosligi: OLX'dagi model nomi (yoki u bo'lmasa sarlavha) match so'zlaridan birini o'z ichiga olsin
export function modelMatches(ad, model) {
  if (ad.category !== CAR_CATEGORY) return false;
  const hay = norm(ad.modelLabel || ad.modelKey || ad.title);
  return model.match.some((t) => hay.includes(norm(t)));
}

// O'xshash e'lonlar: yili ±1, probegi ±50 000 km, holati bir xil (yetarli bo'lsa)
function comparables(a, pool, minN) {
  let c = pool.filter((b) => b.id !== a.id && Math.abs(b.year - a.year) <= 1);
  if (a.km) {
    const near = c.filter((b) => b.km && Math.abs(b.km - a.km) <= 50000);
    if (near.length >= minN) c = near;
  }
  if (a.condition) {
    const same = c.filter((b) => b.condition === a.condition);
    if (same.length >= minN) c = same;
  }
  const m0 = median(c.map((b) => b.priceUsd));
  if (m0 == null) return [];
  return c.filter((b) => b.priceUsd >= m0 * 0.5 && b.priceUsd <= m0 * 2); // keskin chetdagilarni olib tashlash
}

// Toshkent vaqti bo'yicha "bugun" boshidan hisoblab, days kun oldingi chegara
export function periodStart(days, now = Date.now()) {
  const off = 5 * 3600e3;
  const todayStart = Math.floor((now + off) / 86400e3) * 86400e3 - off;
  return todayStart - (days - 1) * 86400e3;
}

export function regionMatches(ad, region) {
  if (!region) return true;
  return norm(ad.region).includes(norm(region)) || norm(ad.city).includes(norm(region));
}

// f: { model, yearFrom, yearTo, kmMax, region, days, minDiscount }
export function evaluate(ads, f, { minComparables = 5, now = Date.now(), ignorePeriod = false } = {}) {
  const models = ads.filter((a) => modelMatches(a, f.model));
  const pool = models.filter((a) => a.priceUsd > 0 && a.year);
  const since = periodStart(f.days, now);
  const stats = { fetched: ads.length, modelMatched: models.length, inFilter: 0, noComparables: 0 };
  const results = [];
  for (const a of pool) {
    if (f.yearFrom && a.year < f.yearFrom) continue;
    if (f.yearTo && a.year > f.yearTo) continue;
    if (f.kmMax && (!a.km || a.km > f.kmMax)) continue;
    if (!regionMatches(a, f.region)) continue;
    if (!ignorePeriod && (!a.createdAt || a.createdAt < since)) continue;
    stats.inFilter++;
    const comp = comparables(a, pool, minComparables);
    if (comp.length < minComparables) { stats.noComparables++; continue; }
    const med = median(comp.map((b) => b.priceUsd));
    const discount = ((med - a.priceUsd) / med) * 100;
    if (discount < f.minDiscount) continue;
    results.push({ ad: a, median: med, n: comp.length, discount, suspicious: a.priceUsd < med * 0.6 });
  }
  // Shubhali (juda past) narxlar oxirida, qolganlari arzonlik bo'yicha
  results.sort((x, y) => (x.suspicious - y.suspicious) || (y.discount - x.discount));
  return { stats, results };
}
