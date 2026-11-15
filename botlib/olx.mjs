// OLX.uz ichki API'sidan e'lonlarni olish va soddalashtirish
import { readFile } from 'node:fs/promises';

export const CAR_CATEGORY = 983; // OLX: yengil avtomobillar

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) { const e = new Error(`OLX HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// query bo'yicha maxPages sahifagacha e'lon oladi (har sahifa ~40-50 ta), faqat avtomobil bo'limidan.
// opts: regionId (OLX viloyat ID), yearFrom/yearTo (yil chegarasi), file (internetsiz sinov uchun JSON).
export async function fetchOffers(query, maxPages, { file, regionId, yearFrom, yearTo } = {}) {
  if (file) return JSON.parse(await readFile(file, 'utf8')).data ?? [];
  const build = (withYearTo) => `https://www.olx.uz/api/v1/offers/?offset=0&limit=40&query=${encodeURIComponent(query)}`
    + `&category_id=${CAR_CATEGORY}&sort_by=created_at%3Adesc`
    + (regionId ? `&region_id=${regionId}` : '')
    + (yearFrom ? `&filter_float_motor_year%3Afrom=${yearFrom}` : '')
    + (withYearTo && yearTo ? `&filter_float_motor_year%3Ato=${yearTo}` : '');
  let first = await getJson(build(true));
  if (yearTo && !(first.data ?? []).length) { // yuqori yil chegarasi ishlamasa, usiz qayta so'raymiz
    await sleep(1200);
    first = await getJson(build(false));
  }
  const all = [...(first.data ?? [])];
  let next = first.links?.next?.href ?? null;
  for (let page = 1; next && page < maxPages; page++) {
    await sleep(1200);
    const j = await getJson(next);
    all.push(...(j.data ?? []));
    next = j.links?.next?.href ?? null;
  }
  // sahifalar bir-biriga biroz kirishadi: takrorlarni olib tashlaymiz
  return [...new Map(all.map((a) => [a.id, a])).values()];
}

const param = (ad, key) => ad.params?.find((p) => p.key === key)?.value;
export const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9а-яё]/g, '');

// Dollar kursi: dollarda qo'yilgan e'lonlarning so'mdagi qiymatidan (mediana)
export function usdRate(ads, fallback) {
  const r = ads.map((a) => param(a, 'price'))
    .filter((p) => p?.currency === 'UYE' && p.value > 0 && p.converted_value > 0)
    .map((p) => p.converted_value / p.value)
    .sort((a, b) => a - b);
  return r.length ? r[Math.floor(r.length / 2)] : fallback;
}

// OLX ba'zan holatni ukrain tilida qaytaradi, shuning uchun o'zimiz nomlaymiz
const CONDITION = { perfect: 'A‘lo', good: 'Yaxshi', mediocre: 'O‘rta', damaged: 'Ta’mirtalab' };

export function normalize(ad, rate) {
  const p = param(ad, 'price');
  let priceUsd = null;
  if (p?.currency === 'UYE' && p.value > 0) priceUsd = p.value;
  else if (p?.currency === 'UZS' && p.value > 0) priceUsd = p.value / rate;
  const year = Number(param(ad, 'motor_year')?.key) || null;
  let km = Number(param(ad, 'motor_mileage')?.key) || null;
  if (km && km < 1000) km *= 1000; // "250" deb yozilgan = 250 000 km
  const photo = ad.photos?.[0];
  return {
    id: String(ad.id),
    url: ad.url,
    title: ad.title?.trim() ?? '',
    description: String(ad.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
    category: ad.category?.id,
    modelKey: param(ad, 'model')?.key ?? null,
    modelLabel: param(ad, 'model')?.label ?? null,
    year,
    km,
    priceUsd,
    negotiable: !!p?.negotiable,
    color: param(ad, 'color')?.label ?? null,
    fuel: param(ad, 'fuel_type')?.label ?? null,
    gearbox: param(ad, 'transmission_type')?.label ?? null,
    condition: param(ad, 'condition')?.key ?? null,
    conditionLabel: CONDITION[param(ad, 'condition')?.key] ?? param(ad, 'condition')?.label ?? null,
    region: ad.location?.region?.name ?? null,
    city: ad.location?.city?.name ?? null,
    district: ad.location?.district?.name ?? null,
    createdAt: ad.created_time ? Date.parse(ad.created_time) : null,
    photo: photo ? photo.link.replace('{width}', photo.width).replace('{height}', photo.height) : null,
  };
}

// Sotuvchining telefon raqami (OLX "Ko'rsatish" tugmasi ortidagi so'rov).
// OLX buni login yoki captcha bilan cheklashi mumkin: unda null qaytadi.
export async function fetchPhone(id) {
  const res = await fetch(`https://www.olx.uz/api/v1/offers/${id}/limited-phones/`, { headers: HEADERS });
  if (res.status === 403 || res.status === 429) { const e = new Error(`OLX HTTP ${res.status}`); e.status = res.status; throw e; }
  if (!res.ok) return null;
  const j = await res.json();
  return j?.data?.phones?.[0] ?? null;
}
