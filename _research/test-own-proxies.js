// _research/test-own-proxies.js
//
// Проверка кандидатов в ярус «свои» для пула: жив ли прокси И доходит ли он до Odyssey.
//
// Тем же путём, что боевой: строки разбирает `proxy-pool.parseProxy`, запросы идут через
// `proxy-pool.fetchVia`. Своей копии туннеля тут нет намеренно - иначе проверка проходила
// бы мимо того кода, которым потом пользуется авторег (ровно этот класс провала в вике
// записан как «приёмка идёт тем же путём, что прод»).
//
// Запуск: node _research/test-own-proxies.js
//
// 🪤 Тело читать ТОЛЬКО через `await r.text()`. `shapeResponse` повторяет форму `fetch`,
// где `text` - метод; `String(r.text)` даёт исходник функции (`async () => text`), и
// проверка «дошёл ли до площадки» превращается в проверку самой себя. На этих граблях
// уже постояли 16.09: два прокси были записаны в мёртвые из-за неверного чтения тела.
//
// 🪤 Схема не всегда известна: магазинная форма `ip:port:user:pass` протокол не несёт, а
// портов у продавца бывает два (http и socks на разных). Поэтому каждая строка пробуется
// ОБЕИМИ схемами, и в пул идёт только то, что ответило ожидаемым телом.

const pp = require('../routing/lib/proxy-pool.js');

const PROBE = 'https://odysseyapi.tech/api/auth/altcha/challenge';
const IPECHO = 'https://api.ipify.org';

// Кандидаты от знакомого владельца (15.09). Формат магазинный / с указанием портов.
const CANDIDATES = [
    ['свой #1 http', 'http://5MVqczzJ:kWtuvZnN@154.221.51.42:64116'],
    ['свой #1 socks', 'socks5://5MVqczzJ:kWtuvZnN@154.221.51.42:64117'],
    ['свой #2 socks', 'socks5://WpUL16FvW:rYw2GBb2A@154.219.251.60:63848'],
    ['свой #2 http', 'http://WpUL16FvW:rYw2GBb2A@154.219.251.60:63848'],
    ['свой #3 socks', 'socks5://FSanaM1bk:Cm46C3cLn@185.104.150.84:63624'],
    ['свой #3 http', 'http://FSanaM1bk:Cm46C3cLn@185.104.150.84:63624'],
];

(async () => {
    const ok = [];
    for (const [name, raw] of CANDIDATES) {
        const p = pp.parseProxy(raw, 'http');
        if (!p) { console.log(`${name.padEnd(14)} строка не разобрана: ${raw}`); continue; }

        let verdict, exitIp = '', ms = 0;
        const t0 = Date.now();
        try {
            const r = await pp.fetchVia(p, PROBE, { timeoutMs: 15000 });
            ms = Date.now() - t0;
            const body = await r.text();          // см. шапку: text - метод, а не строка
            if (r.status === 200 && body.includes('PBKDF2')) {
                verdict = 'ДОХОДИТ до площадки';
                try {
                    const r2 = await pp.fetchVia(p, IPECHO, { timeoutMs: 12000 });
                    exitIp = String(await r2.text()).trim().slice(0, 20);
                } catch { exitIp = '(ip не прочитал)'; }
                ok.push({ name, raw });
            } else {
                // Тело печатаем: «200 без челленджа» один раз уже обмануло - там был мусор.
                verdict = `HTTP ${r.status}, тело: ${String(body).replace(/\s+/g, ' ').slice(0, 60) || '(пусто)'}`;
            }
        } catch (e) {
            ms = Date.now() - t0;
            verdict = String(e.message || e).split('\n')[0].slice(0, 70);
        }
        console.log(`${name.padEnd(14)} ${String(ms).padStart(6)} мс  ${verdict}${exitIp ? ' · выход ' + exitIp : ''}`);
    }

    console.log('');
    console.log('='.repeat(64));
    console.log(`годных: ${ok.length} из ${CANDIDATES.length}`);
    for (const o of ok) console.log('  ', o.name, '→', o.raw.replace(/:[^:@/]+@/, ':***@'));
    console.log('='.repeat(64));
    if (!ok.length) console.log('вывод: ни один кандидат не доходит до Odyssey - в ярус «свои» класть нечего');
    else console.log('эти строки можно класть в routing/own-proxies.txt (файл в .gitignore)');
})().catch(e => { console.log('ФАТАЛЬНО:', e.message); process.exit(1); });
