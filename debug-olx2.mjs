// OLX API qaysi filtrlarni qo'llab-quvvatlashini tekshiradi va natijani olx-debug.json ga yozadi.
// Token kerak emas, Telegram'ga hech narsa yubormaydi.
import { writeFile } from 'node:fs/promises';

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
};
const BASE = 'https://www.olx.uz/api/v1/offers/?offset=0&limit=40&query=gentra';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (a, k) => a.params?.find((p) => p.key === k)?.value;
const count = (list, f) => list.reduce((m, a) => { const k = String(f(a)); m[k] = (m[k] || 0) + 1; return m; }, {});

async function probe(name, url) {
  await sleep(1200);
  try {
    const res = await fetch(url, { headers: H });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    const d = j?.data;
    const out = { url, status: res.status };
    if (Array.isArray(d)) {
      out.count = d.length;
      out.total = j.metadata?.total_elements;
      out.categories = count(d, (a) => a.category?.id);
      out.regions = count(d, (a) => `${a.location?.region?.id}:${a.location?.region?.name}`);
      out.cities = count(d, (a) => `${a.location?.city?.id}:${a.location?.city?.name}`);
      out.years = count(d, (a) => P(a, 'motor_year')?.key);
      out.firstCreated = d.slice(0, 5).map((a) => a.created_time);
      out.firstId = d[0]?.id;
    } else {
      out.body = text.slice(0, 400);
    }
    console.log(`${name}: HTTP ${res.status}${out.count != null ? ', ' + out.count + ' ta' : ''}`);
    return out;
  } catch (e) {
    console.log(`${name}: xato - ${e.message}`);
    return { url, error: e.message };
  }
}

const report = {};
report.base = await probe('base', BASE);
report.sorted = await probe('sorted', BASE + '&sort_by=created_at%3Adesc');
report.category = await probe('category', BASE + '&category_id=983');
const regionId = Object.keys(report.base.regions ?? {}).map((k) => k.split(':')[0]).find((id) => id && id !== '5' && id !== 'undefined') ?? '5';
report.regionTested = regionId;
report.region = await probe('region', BASE + '&category_id=983&region_id=' + regionId);
report.yearFrom = await probe('yearFrom', BASE + '&category_id=983&filter_float_motor_year%3Afrom=2020');
report.model = await probe('model', 'https://www.olx.uz/api/v1/offers/?offset=0&limit=40&category_id=983&filter_enum_model%5B0%5D=gentra');
report.page2 = await probe('page2', 'https://www.olx.uz/api/v1/offers/?offset=40&limit=40&query=gentra&category_id=983&sort_by=created_at%3Adesc');
const id = report.base.firstId;
if (id) {
  await sleep(1200);
  try {
    const res = await fetch(`https://www.olx.uz/api/v1/offers/${id}/limited-phones/`, { headers: H });
    report.phone = { status: res.status, body: (await res.text()).slice(0, 400) };
    console.log(`phone: HTTP ${res.status}`);
  } catch (e) { report.phone = { error: e.message }; console.log('phone: xato - ' + e.message); }
}
await writeFile(new URL('./olx-debug.json', import.meta.url), JSON.stringify(report, null, 1), 'utf8');
console.log('Tayyor: olx-debug.json saqlandi');
