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
  if (ad.category !== (model.categoryId ?? CAR_CATEGORY)) return false;
  const hay = norm(`${ad.modelLabel ?? ''} ${ad.modelKey ?? ''} ${ad.title}`);
  if (model.exclude?.some((t) => hay.includes(norm(t)))) return false; // masalan BMW 5 qidiruvida X5 chiqmasin
  return model.match.some((t) => hay.includes(norm(t)));
}

// Yoqilg'i guruhi: OLX yozuvi ("Elektr", "Gibrid", "Gaz/Benzin"...) -> electric | hybrid | ice
export function fuelGroup(label) {
  const t = String(label ?? '').toLowerCase();
  if (!t) return null;
  if (/gibrid|гибрид|hybrid/.test(t)) return 'hybrid';
  if (/elektr|электр|electr/.test(t)) return 'electric';
  if (/benzin|бензин|gaz|газ|dizel|дизел|metan|метан|propan|пропан/.test(t)) return 'ice';
  return null;
}

// O'xshash e'lonlar: yili ±1, probegi ±50 000 km, holati bir xil (yetarli bo'lsa)
function comparables(a, pool, minN) {
  let c = pool.filter((b) => b.id !== a.id && Math.abs(b.year - a.year) <= 1);
  if (a.km) {
    const WIDE_KM = 50000, TIGHT_KM = 30000, TIGHT_MIN = 12;
    const tight = c.filter((b) => b.km && Math.abs(b.km - a.km) <= TIGHT_KM);
    const wide = c.filter((b) => b.km && Math.abs(b.km - a.km) <= WIDE_KM);
    if (tight.length >= TIGHT_MIN) c = tight;
    else if (wide.length >= minN) c = wide;
  }
  const fg = fuelGroup(a.fuel);
  if (fg) {
    const sameFuel = c.filter((b) => fuelGroup(b.fuel) === fg);
    if (sameFuel.length >= minN) c = sameFuel;
  }
  if (a.condition) {
    const same = c.filter((b) => b.condition === a.condition);
    if (same.length >= minN) c = same;
  }
  const m0 = median(c.map((b) => b.priceUsd));
  if (m0 == null) return [];
  return c.filter((b) => b.priceUsd >= m0 * 0.5 && b.priceUsd <= m0 * 2); // keskin chetdagilarni olib tashlash
}

// Davr: hozirdan days*24 soat orqaga ("1 kun" = oxirgi 24 soat)
export function periodStart(days, now = Date.now()) {
  return now - days * 86400e3;
}

export function regionMatches(ad, region) {
  if (!region) return true;
  return norm(ad.region).includes(norm(region)) || norm(ad.city).includes(norm(region));
}

// f: { model, yearFrom, yearTo, kmMax, region, days, minDiscount }
// f.allPrices: qimmatlari va solishtirib bo'lmaydiganlari ham qaytadi (xorijiy mashinalar uchun)
export function evaluate(ads, f, { minComparables = 5, now = Date.now(), ignorePeriod = false } = {}) {
  const models = ads.filter((a) => modelMatches(a, f.model));
  const pool = models.filter((a) => a.priceUsd > 0 && a.year && (!f.fuel || fuelGroup(a.fuel) === f.fuel));
  const since = periodStart(f.days, now);
  const stats = { fetched: ads.length, modelMatched: models.length, withPrice: pool.length, yearOk: 0, kmOk: 0, regionOk: 0, inFilter: 0, noComparables: 0 };
  const results = [];
  for (const a of pool) {
    if (f.yearFrom && a.year < f.yearFrom) continue;
    if (f.yearTo && a.year > f.yearTo) continue;
    stats.yearOk++;
    if (f.kmMax && (!a.km || a.km > f.kmMax)) continue;
    stats.kmOk++;
    if (!regionMatches(a, f.region)) continue;
    stats.regionOk++;
    if (!ignorePeriod && (!a.createdAt || a.createdAt < since)) continue;
    stats.inFilter++;
    const comp = comparables(a, pool, minComparables);
    if (comp.length < minComparables) {
      stats.noComparables++;
      if (f.allPrices) results.push({ ad: a, median: null, n: comp.length, discount: null, suspicious: false });
      continue;
    }
    const med = median(comp.map((b) => b.priceUsd));
    const discount = ((med - a.priceUsd) / med) * 100;
    if (!f.allPrices && discount < f.minDiscount) continue;
    results.push({ ad: a, median: med, n: comp.length, discount, suspicious: a.priceUsd < med * 0.6 });
  }
  // Shubhali (juda past) narxlar oxirida, qolganlari arzonlik bo'yicha
  // Solishtirib bo'lmaganlari eng oxirida (yangilari oldin)
  results.sort((x, y) => ((x.discount == null) - (y.discount == null)) || (x.suspicious - y.suspicious) || ((y.discount ?? 0) - (x.discount ?? 0)) || ((y.ad.createdAt ?? 0) - (x.ad.createdAt ?? 0)));
  return { stats, results };
}
