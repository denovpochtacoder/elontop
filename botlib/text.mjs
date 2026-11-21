// Matn yordamchilari: lotin -> kirill (o'zbekcha), telefon, pozitsiya, kraska
const APOS = /[‘’'`ʻʼ]/g;
const MAP = { a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'й', z: 'з', "'": 'ъ', c: 'с', w: 'в' };
const PAIRS = [["o'", 'ў'], ["g'", 'ғ'], ['sh', 'ш'], ['ch', 'ч'], ['yo', 'ё'], ['yu', 'ю'], ['ya', 'я'], ['ye', 'е'], ['ts', 'ц']];
const VOWELS = 'aeiou';

// O'zbekcha lotin yozuvini kirillga o'giradi (qisqa nomlar uchun: rang, yoqilg'i, joy nomlari)
export function cyr(input) {
  const s = String(input ?? '').replace(APOS, "'");
  let out = '';
  for (let i = 0; i < s.length;) {
    const lower = s.slice(i, i + 2).toLowerCase();
    const upper = s[i] !== s[i].toLowerCase();
    const cap = (c) => (upper ? c.toUpperCase() : c);
    const pair = PAIRS.find(([lat]) => lower === lat);
    if (pair) { out += cap(pair[1]); i += 2; continue; }
    const ch = s[i].toLowerCase();
    if (ch === 'e') {
      const prev = i > 0 ? s[i - 1].toLowerCase() : ' ';
      out += cap(!/[a-z']/.test(prev) || VOWELS.includes(prev) ? 'э' : 'е'); // so'z boshida va unlidan keyin "э"
    } else {
      out += MAP[ch] ? cap(MAP[ch]) : s[i];
    }
    i++;
  }
  return out;
}

// O'zbekiston mobil kodlari
const CODES = new Set(['20', '33', '50', '55', '77', '88', '90', '91', '93', '94', '95', '97', '98', '99']);
export function formatPhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('998')) d = d.slice(3);
  if (d.length !== 9 || !CODES.has(d.slice(0, 2))) return null;
  return `+998${d}`; // bo'shliqsiz: +998917171011
}
// Matn ichidan telefon raqamlarini topadi
export function phonesFromText(text) {
  const found = String(text ?? '').match(/(?:\+?998[\s\-.()]*)?\(?\d{2}\)?[\s\-.]*\d{3}[\s\-.]*\d{2}[\s\-.]*\d{2}(?!\d)/g) ?? [];
  return [...new Set(found.map(formatPhone).filter(Boolean))];
}

// "3-pozitsiya", "2 позиция", "3 poz" kabi yozuvdan pozitsiya raqami
export function positionFrom(text) {
  const m = String(text ?? '').match(/(?<!\d)([1-5])\s*[-–]?\s*(?:poz|поз)/i); // "3-pozitsiya", "4 poziciya", "2 поз"
  return m ? Number(m[1]) : null;
}

// E'lon matnida kraskasi toza ekani aytilganmi
export function paintClean(text) {
  return /(kraska(si)?\s*(top\s*)?toza|краска(си)?\s*(топ\s*)?тоза|toza\s*kraska|kraska\s*yo['‘’ʻ]?q|краска\s*й[ўу]қ|petno\s*yo['‘’ʻ]?q|петно\s*й[ўу]қ|без\s*окраса|не\s*крашен)/i.test(String(text ?? ''));
}
