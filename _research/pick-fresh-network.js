// _research/pick-fresh-network.js
//
// Ищет прокси из сети (ASN), которую мы ещё НЕ использовали под регистрацию, и проверяет,
// доходит ли он до Odyssey. Это и есть условие подарка: кабинет говорит «one account per
// network», поэтому второй аккаунт в той же сети видит `$0.00`.
//
// Учёт использованных сетей - `odyssey/networks-used.json`: его пишет авторега после каждой
// регистрации (сеть -> первый аккаунт). Файла нет - считаем, что сетей не тратили.
//
// Запуск: node _research/pick-fresh-network.js [сколько проверять]
//
// Печатает: сколько сетей в пуле, какие уже тратили, и первый ЖИВОЙ адрес из свежей сети -
// его метку и надо отдать автореге (`--proxy <label>`).

const fs = require('fs');
const path = require('path');
const pp = require('../routing/lib/proxy-pool.js');

const PROBE = 'https://odysseyapi.tech/api/auth/altcha/challenge';
const LEDGER = path.join(__dirname, '..', 'odyssey', 'networks-used.json');
const LIMIT = Number(process.argv[2] || 12);

function ledger() {
    try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; }
}

async function asnOf(ips) {
    const out = {};
    for (let i = 0; i < ips.length; i += 100) {
        const chunk = ips.slice(i, i + 100);
        try {
            const r = await fetch('http://ip-api.com/batch?fields=query,as,country,isp', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chunk),
            });
            for (const it of await r.json()) out[it.query] = it;
        } catch { /* без ASN адрес просто не попадёт в свежие */ }
    }
    return out;
}

(async () => {
    const used = ledger();
    const proxies = pp.pool().proxies;
    const info = await asnOf(proxies.map(p => p.hostname));
    const fresh = proxies.filter(p => {
        const asn = (info[p.hostname] || {}).as;
        return asn ? !used[asn] : false;
    });
    console.log(`в пуле ${proxies.length} адресов · сетей уже тратили: ${Object.keys(used).length}`);
    if (Object.keys(used).length) {
        for (const [asn, acc] of Object.entries(used)) console.log(`   тратили: ${asn} (${acc})`);
    }
    console.log(`свежих сетей: ${new Set(fresh.map(p => info[p.hostname].as)).size} · адресов: ${fresh.length}`);
    if (!fresh.length) {
        console.log('→ свежих сетей нет: подарок этим пулом больше не взять, нужен новый источник');
        return;
    }

    // Проверяем кандидатов по одному: первый живой из свежей сети и есть цель.
    let checked = 0;
    for (const p of fresh) {
        checked++;
        if (checked > LIMIT) break;
        const asn = info[p.hostname].as;
        let verdict;
        try {
            const r = await pp.fetchVia(p, PROBE, { timeoutMs: 15000 });
            const body = await r.text();     // 🪤 text - МЕТОД, как у fetch (см. грабли 16.09)
            verdict = (r.status === 200 && body.includes('PBKDF2'))
                ? `ЖИВОЙ · ${(info[p.hostname].country || '?')}`
                : `HTTP ${r.status}`;
        } catch (e) {
            verdict = String(e.message || e).split('\n')[0].slice(0, 50);
        }
        console.log(`  ${p.label.padEnd(30)} ${asn.slice(0, 28).padEnd(30)} ${verdict}`);
        if (verdict.startsWith('ЖИВОЙ')) {
            console.log(`\n→ брать этот: --proxy '${p.id.replace(/^(\w+):\/\//, '$1://')}'`);
            console.log(`   сеть ${asn} в списке траченных ${used[asn] ? 'ЕСТЬ (плохо)' : 'отсутствует (хорошо)'}`);
            return;
        }
    }
    console.log(`→ проверено ${Math.min(checked, LIMIT)} кандидатов, живого в свежих сетях нет`);
})();
