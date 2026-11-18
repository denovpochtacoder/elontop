// Elontopbot: OLX bloklanishiga qarshi kuchaytirilgan himoya (bir marta ishga tushiring)
// Qo'shadi: takroriy blokda to'xtash vaqti oshadi (2 soat -> 24 soat -> 48 soat),
// /olx_reset (IP almashtirgach blokni bekor qilish), /holat (hozirgi holat),
// sahifalar sonini kamaytiradi (max_pages 6, region_pages 4, telefon soatiga 10 ta).
const fs = require('fs');
const must = (src, from, to) => {
  if (!src.includes(from)) throw new Error("Kodda kerakli joy topilmadi: " + from.slice(0, 70));
  return src.replace(from, to);
};

let s = fs.readFileSync('bot.mjs', 'utf8');
if (s.includes('strikes')) { console.log('Bu yangilanish allaqachon qo‘llangan, hech narsa o‘zgarmadi.'); process.exit(0); }

// 1) holat
s = must(s, "cooldownUntil: 0, phoneCooldownUntil: 0, phoneLog: [] };", "cooldownUntil: 0, phoneCooldownUntil: 0, phoneLog: [], strikes: [] };");

// 2) himoya sozlamalari
s = must(s, "const PROT = { cooldown_minutes: 120, cache_minutes: 10, phone_per_hour: 15, ...cfg.protection };",
  "const PROT = { cooldown_steps_minutes: [120, 1440, 2880], strike_window_hours: 72, cache_minutes: 10, phone_per_hour: 10, ...cfg.protection };");

// 3) vaqt matni: uzoq blokda sana ham ko'rsatiladi
s = must(s, "const untilText = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' });",
`const untilText = (ts) => {
  const long = ts - Date.now() > 12 * 3600e3;
  return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', ...(long ? { day: '2-digit', month: '2-digit' } : {}), hour: '2-digit', minute: '2-digit' });
};`);

// 4) pog'onali to'xtash
s = must(s, `async function startCooldown(kind) {
  const until = Date.now() + PROT.cooldown_minutes * 60e3;
  if (kind === 'phone') state.phoneCooldownUntil = until; else state.cooldownUntil = until;
  await save();
  console.warn(\`OLX cheklov qo'ydi (\${kind}), \${untilText(until)} gacha to'xtatildi\`);
  return until;
}`,
`// Takroriy blokda to'xtash vaqti oshadi: 1-marta 2 soat, 2-marta 24 soat, 3-marta va undan keyin 48 soat
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
  console.warn(\`OLX cheklov qo'ydi (\${kind}, \${state.strikes.length}-marta), \${untilText(until)} gacha to'xtatildi\`);
  return until;
}`);

// 5) qidiruv paytida cheklov: /olx_reset haqida eslatma
s = must(s, "Bloklanish uzaymasligi uchun bot ${untilText(state.cooldownUntil)} gacha OLX'ga so‘rov yubormaydi.` });",
  "Bloklanish uzaymasligi uchun bot ${untilText(state.cooldownUntil)} gacha OLX'ga so‘rov yubormaydi.\\nIP manzilingiz almashgan bo‘lsa (router o‘chirib-yoqildi yoki telefon hotspot ulandi), /olx_reset yozing.` });");

// 6) blok xabari: nechanchi marta ekani
s = must(s, "Bloklanish uzaymasligi uchun bot ${untilText(until)} gacha OLX'ga so‘rov yubormaydi.\\nShu vaqtda brauzerda ham OLX'ni ko‘p ochmang.`;",
  "Bloklanish uzaymasligi uchun bot ${untilText(until)} gacha OLX'ga so‘rov yubormaydi.\\nBu ${state.lastStrike}-marta${state.lastStrike >= 2 ? ': takroriy bloklarda kutish vaqti uzayadi' : ''}. Shu vaqtda brauzerda ham OLX'ni ko‘p ochmang.\\nIP almashtirgan bo‘lsangiz, /olx_reset yozing.`;");

// 7) buyruqlar: /olx_reset va /holat
s = must(s, "  await tg('sendMessage', { chat_id: uid, ...menu() });\n}\n\nasync function onCallback",
`  if (msg.text?.startsWith('/olx_reset')) {
    state.cooldownUntil = 0;
    state.phoneCooldownUntil = 0;
    await save();
    return tg('sendMessage', { chat_id: uid, text: '✅ OLX bloki bekor qilindi, qidirish mumkin.\\nDiqqat: IP hali almashmagan bo‘lsa, OLX yana bloklaydi va kutish vaqti uzayadi.' });
  }
  if (msg.text?.startsWith('/holat')) {
    const now = Date.now();
    const strikes = (state.strikes ?? []).filter((t) => now - t < PROT.strike_window_hours * 3600e3).length;
    const phones = (state.phoneLog ?? []).filter((t) => now - t < 3600e3).length;
    return tg('sendMessage', { chat_id: uid, text: [
      '📋 <b>Holat</b>',
      now < (state.cooldownUntil ?? 0) ? \`⛔️ Qidiruv to‘xtatilgan: \${untilText(state.cooldownUntil)} gacha\` : '✅ Qidiruv ochiq',
      now < (state.phoneCooldownUntil ?? 0) ? \`⛔️ Telefon so‘rovi to‘xtatilgan: \${untilText(state.phoneCooldownUntil)} gacha\` : '✅ Telefon so‘rovi ochiq',
      \`Telefon: oxirgi soatda \${phones}/\${PROT.phone_per_hour}\`,
      \`Cheklovlar (oxirgi \${PROT.strike_window_hours} soat): \${strikes}\`,
    ].join('\\n'), parse_mode: 'HTML' });
  }
  await tg('sendMessage', { chat_id: uid, ...menu() });
}

async function onCallback`);

// 8) menyuda cheklov belgisi
s = must(s, "    `📉 Kamida: <b>${c.minDiscount}% arzon</b>`,\n  ].join('\\n');",
  "    `📉 Kamida: <b>${c.minDiscount}% arzon</b>`,\n    Date.now() < (state.cooldownUntil ?? 0) ? `\\n⛔️ OLX cheklovi: ${untilText(state.cooldownUntil)} gacha (IP almashgan bo‘lsa, /olx_reset)` : null,\n  ].filter((l) => l !== null).join('\\n');");

fs.writeFileSync('bot.mjs', s);

// sozlamalar fayli
const c = JSON.parse(fs.readFileSync('bot-config.json', 'utf8'));
c.max_pages = 6;
c.region_pages = 4;
c.protection = { cooldown_steps_minutes: [120, 1440, 2880], strike_window_hours: 72, cache_minutes: 10, phone_per_hour: 10 };
fs.writeFileSync('bot-config.json', JSON.stringify(c, null, 2) + '\n');
console.log('Tayyor: himoya kuchaytirildi. Botni qayta ishga tushiring.');
