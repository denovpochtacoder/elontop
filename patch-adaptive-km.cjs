// Elontopbot: moslashuvchan probeg oynasi (bir marta ishga tushiring)
// O'xshash e'lon >= 12 bo'lsa probeg ±30 000 km, aks holda ±50 000 km.
const fs = require('fs');
let m = fs.readFileSync('botlib/market.mjs', 'utf8');
if (m.includes('WIDE_KM')) { console.log('Allaqachon qo‘llangan.'); process.exit(0); }
const from = `    const near = c.filter((b) => b.km && Math.abs(b.km - a.km) <= 50000);
    if (near.length >= minN) c = near;`;
if (!m.includes(from)) throw new Error('market.mjs da kerakli joy topilmadi');
m = m.replace(from, `    const WIDE_KM = 50000, TIGHT_KM = 30000, TIGHT_MIN = 12;
    const tight = c.filter((b) => b.km && Math.abs(b.km - a.km) <= TIGHT_KM);
    const wide = c.filter((b) => b.km && Math.abs(b.km - a.km) <= WIDE_KM);
    if (tight.length >= TIGHT_MIN) c = tight;
    else if (wide.length >= minN) c = wide;`);
fs.writeFileSync('botlib/market.mjs', m);
console.log('Tayyor. Botni qayta ishga tushiring (Ctrl+C, so‘ng run-bot.cmd).');
