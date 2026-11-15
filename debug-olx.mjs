// OLX sahifasi va API javobini faylga saqlaydi (tekshiruv uchun)
import { writeFile } from 'node:fs/promises';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
};

const targets = [
  ['olx-page.html', 'https://www.olx.uz/list/q-cobalt/'],
  ['olx-api.json', 'https://www.olx.uz/api/v1/offers/?offset=0&limit=40&query=cobalt'],
];

for (const [file, url] of targets) {
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    await writeFile(new URL('./' + file, import.meta.url), text, 'utf8');
    console.log(`${file}: HTTP ${res.status}, ${text.length} belgi saqlandi`);
  } catch (e) {
    console.log(`${file}: xato - ${e.message}`);
  }
}
