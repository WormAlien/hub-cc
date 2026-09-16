// _research/probe-odyssey-candidates.js
//
// ДЕШЁВАЯ проба кандидатов пула под регистрацию Odyssey - без браузера.
//
// 🔴 Зачем. Замер 16.09 вечером показал, что провалы прогонов валились в одну кучу
// «капча не пройдена», хотя причины были разные: часть адресов вообще не открывала
// odysseyapi.tech (прогон 14:38: `Page.goto: Timeout 60000ms exceeded` - страница не
// загрузилась, а пул при этом считал адрес живым, потому что проверял только
// `/api/auth/altcha/challenge`). Прежде чем поднимать браузер (это ~10 с на окно плюс
// профиль), кандидатов надо отсеять запросом: доходит ли адрес до САМОЙ СТРАНИЦЫ, а не
// только до ручки ALTCHA.
//
// 🪤 Читать тело через `await r.text()`, а не `String(r.text)`: у `fetchVia` форма fetch,
// где `text` - метод. На этом уже стоял замер 16.09 («0 живых из 12», потому что в теле
// оказывался исходник функции).
//
// Запуск: node _research/probe-odyssey-candidates.js [параллельно]

const fs = require('fs');
const path = require('path');
const pp = require('../routing/lib/proxy-pool.js');

const BASE = 'https://odysseyapi.tech';
const PATHS = ['/api/auth/altcha/challenge', '/sign-up'];
// 🔴 Третий адрес - почтовый сервис, и он тут ТОЛЬКО для справки. Замер 16.09 15:50:
// 22.do отдаёт `403` от Cloudflare на голый запрос через ЛЮБОЙ прокси (и через живой
// `89.189.132.154`, с которого почта в прогоне работала), а живой браузер напрямую берёт
// ящик за полминуты. То есть по коду ответа «прокси не пускает» от «Cloudflare не пускает
// бота» не отличить, и гейтом этот столбец быть не может - шаг почты теперь идёт БЕЗ прокси.
const MAIL_URL = 'https://22.do/';
const LEDGER = path.join(__dirname, '..', 'odyssey', 'networks-used.json');
const CONC = Number(process.argv[2] || 6);
const WANT = Number(process.argv[3] || 3);   // хватит стольких годных - дальше не перебираем
const TIMEOUT = 15000;

function ledger() {
    try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; }
}

// ASN батчами: бесплатный ip-api отдаёт до 100 адресов за запрос.
async function asnOf(ips) {
    const out = {};
    for (let i = 0; i < ips.length; i += 100) {
        const chunk = ips.slice(i, i + 100);
        try {
            const r = await fetch('http://ip-api.com/batch?fields=query,as,isp,country', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chunk),
            });
            for (const it of await r.json()) out[it.query] = it;
        } catch { /* без ASN адрес уедет в «сеть неизвестна» */ }
    }
    return out;
}

async function probeOne(p) {
    const row = { label: p.label, ip: p.hostname, tier: null, as: '', country: '', res: {} };
    try { row.tier = pp.tierOf(p.id); } catch { /* ярус не критичен */ }
    for (const path_ of [...PATHS, MAIL_URL]) {
        const url = path_.startsWith('http') ? path_ : BASE + path_;
        const t0 = Date.now();
        try {
            const r = await pp.fetchVia(p, url, {
                timeoutMs: TIMEOUT,
                headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
                           'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
            });
            const body = await r.text();
            row.res[path_] = { status: r.status, ms: Date.now() - t0, len: body.length };
        } catch (e) {
            row.res[path_] = { err: String(e.message || e).slice(0, 60), ms: Date.now() - t0 };
        }
    }
    return row;
}

(async () => {
    const pool = pp.pool();
    const used = ledger();
    const all = pool.proxies;

    const asn = await asnOf([...new Set(all.map(p => p.hostname))]);
    const fresh = [];
    const spent = [];
    for (const p of all) {
        const info = asn[p.hostname] || {};
        const key = String(info.as || '').trim();
        const rec = { p, key, country: info.country || '?' };
        (key && used[key] ? spent : fresh).push(rec);
    }
    console.log(`в пуле ${all.length} · сетей трачено ${Object.keys(used).length} · ` +
                `свежих кандидатов ${fresh.length} · отсеяно как траченые ${spent.length}`);

    const out = [];
    const good = [];
    for (let i = 0; i < fresh.length; i += CONC) {
        const chunk = fresh.slice(i, i + CONC);
        const rows = await Promise.all(chunk.map(x => probeOne(x.p)));
        rows.forEach((r, j) => {
            r.as = chunk[j].key; r.country = chunk[j].country;
            out.push(r);
            if (r.res[PATHS[1]].status === 200) good.push(r);
            const mark = (v) => v.err ? `✗ ${v.err}` : `${v.status} ${v.len}b`;
            console.log(`  ${r.ip.padEnd(16)} ${(r.as || 'ASN неизвестен').slice(0, 30).padEnd(30)} ` +
                        `${r.country.padEnd(3)} altcha: ${mark(r.res[PATHS[0]]).padEnd(22)} ` +
                        `страница: ${mark(r.res[PATHS[1]]).padEnd(22)} ящик(справка): ${mark(r.res[MAIL_URL])}`);
        });
        // Рано выходим: проба стоит по 2-8 с на адрес, а на 33 кандидатах это минуты.
        // Обёртке нужно 2-3 годных адреса, остальной перебор - трата времени впустую.
        if (good.length >= WANT) {
            console.log(`  … хватит: годных уже ${good.length} (проверено ${out.length} из ${fresh.length})`);
            break;
        }
    }

    const page = (r) => r.res[PATHS[1]], mail = (r) => r.res[MAIL_URL];
    const ok = good.filter(r => page(r).status === 200);
    const half = out.filter(r => page(r).status !== 200 && mail(r).status === 200);
    console.log(`\n🔴 ГОДНЫХ (страница регистрации отвечает 200): ${ok.length}`);
    for (const r of ok) {
        console.log(`  --proxy '${r.label}'   # ${r.as} · ${r.country} · страница ${page(r).ms}мс · ящик ${mail(r).ms}мс`);
    }
    if (half.length) {
        console.log(`\n⚠️ страница не открылась, а 22.do отвечает (${half.length}) - для нас не годятся:`);
        for (const r of half) console.log(`  ${r.label}   # ${r.as} · ${r.country}`);
    }
    // Машинный список для обёртки: годится только то, где жива САМА страница. Один адрес
    // на сеть: подарок даётся один раз на ASN, и второй адрес того же провайдера в том же
    // прогоне смысла не имеет (замер: два адреса AS60404 Liteserver попали в годные разом).
    const cand = [];
    const seenAs = new Set();
    for (const r of ok.sort((a, b) => page(a).ms - page(b).ms)) {
        if (seenAs.has(r.as)) continue;
        seenAs.add(r.as);
        cand.push({ label: r.label, as: r.as, country: r.country, pageMs: page(r).ms, mailMs: mail(r).ms });
    }
    fs.writeFileSync(path.join(__dirname, '..', 'odyssey', 'candidates.json'),
                     JSON.stringify({ at: new Date().toISOString(), candidates: cand }, null, 1));
    console.log(`\nсписок для обёртки: odyssey/candidates.json (${cand.length})`);
    fs.writeFileSync(path.join(__dirname, 'probe-odyssey-candidates.json'),
                     JSON.stringify(out, null, 1));
    console.log('полная таблица: _research/probe-odyssey-candidates.json');
})().catch(e => { console.error('упало:', e.message); process.exit(1); });
