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
// 🔴 Проверяем РОВНО ДВЕ вещи: отдаёт ли адрес страницу регистрации и приезжают ли её чанки
// пачкой. Раньше в пробе было ещё две колонки - ручка ALTCHA и 22.do, - и обе оказались
// бесполезны: 22.do отдаёт 403 от Cloudflare через любой прокси (ящик теперь берётся напрямую,
// см. `auto-add.py`), а ALTCHA-ручка - это слабый зонд пула, на котором «живые» адреса не
// открывали страницу вовсе. Зато каждая из колонок стоила до 15 секунд на кандидата: проба
// из-за них шла шесть минут, и владелец справедливо спросил, почему в панели тихо.
const PATHS = ['/sign-up'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0';
const LEDGER = path.join(__dirname, '..', 'odyssey', 'networks-used.json');
// Журнал плохих АДРЕСОВ (не сетей): те, где приложение не собралось или не приехал виджет
// Turnstile. Пишет его драйвер, а проба по нему фильтрует - второй раз такой адрес пробовать
// незачем, каждая попытка стоит две минуты.
const BAD_FILE = path.join(__dirname, '..', 'odyssey', 'addresses-bad.json');
const CONC = Number(process.argv[2] || 6);
const WANT = Number(process.argv[3] || 3);   // хватит стольких годных - дальше не перебираем
const TIMEOUT = 15000;

function ledger() {
    try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; }
}

function badAddresses() {
    try { return JSON.parse(fs.readFileSync(BAD_FILE, 'utf8')); } catch { return {}; }
}

// ASN батчами: бесплатный ip-api отдаёт до 100 адресов за запрос.
async function asnOf(ips) {
    const out = {};
    for (let i = 0; i < ips.length; i += 100) {
        const chunk = ips.slice(i, i + 100);
        try {
            const r = await fetch('http://ip-api.com/batch?fields=query,as,isp,country,org', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chunk),
            });
            for (const it of await r.json()) out[it.query] = it;
        } catch { /* без ASN адрес уедет в «сеть неизвестна» */ }
    }
    return out;
}

// 🔴 Замер 16.09 16:12 (HAR провального прогона): HTML `/sign-up` приходит за 4 с с кодом 200,
// а ДВАДЦАТЬ ПЯТЬ параллельных запросов за чанками `/_next/static/chunks/*.js`, стилями и
// Clerk висят без ответа навсегда - в HAR у них нет ответа вовсе. Приложение не гидрируется,
// форма Clerk не рисуется, на экране остаётся заставка «Loading verification…», и прогон
// встаёт на «формы нет». Снаружи это выглядит как «капча не прошла», хотя капча тут ни при чём.
// Поэтому проба, которая проверяет только HTML, пропускает такие адреса: она обязана
// попробовать ту же ПАЧКУ параллельно и убедиться, что чанки приезжают.
async function burstCheck(p, html) {
    const urls = [...new Set([...html.matchAll(/\/_next\/static\/(?:chunks|media)\/[^"'\\]+\.(?:js|css)/g)]
        .map(m => m[0]))].slice(0, 20);
    if (!urls.length) return { ok: 0, total: 0, ms: 0, note: 'ссылок на чанки в HTML не нашлось' };
    const t0 = Date.now();
    const got = await Promise.all(urls.map(u =>
        pp.fetchVia(p, BASE + u, {
            timeoutMs: 12000,
            headers: { 'user-agent': UA, 'accept': '*/*' },
        }).then(async r => (r.status === 200 && (await r.text()).length > 500) ? 1 : 0).catch(() => 0)));
    const ok = got.filter(Boolean).length;
    return { ok, total: urls.length, ms: Date.now() - t0 };
}

// 🔴 ТРЕТЬИ СТОРОНЫ - и это была дыра в пробе. Удачный прогон тянет не только сайт: по HAR
// `clerk.odysseyapi.tech` даёт 57 запросов (SDK Clerk, БЕЗ него форма не рисуется вовсе),
// `challenges.cloudflare.com` - 6 (Turnstile). Проба проверяла один лишь odysseyapi.tech,
// поэтому адрес, у которого сайт открывается, а Clerk недоступен, проходил пробу и падал в
// прогоне строкой «форма регистрации не появилась» (замер 17.09 22:38: адрес netcup - 19/20
// чанков у пробы и пустая страница в браузере).
const THIRDS = [
    'https://clerk.odysseyapi.tech/npm/@clerk/clerk-js@6/dist/clerk.browser.js',
    'https://clerk.odysseyapi.tech/npm/@clerk/ui@1/dist/ui.browser.js',
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
];

async function thirdsCheck(p) {
    const t0 = Date.now();
    // 🔴 Критерий - «хост ОТВЕЧАЕТ», а не «отвечает 200 с телом». Живой замер 18.09:
    // `clerk.odysseyapi.tech` отдаёт **307**, а `challenges.cloudflare.com` - **302**, оба с
    // пустым телом. Требуя 200 с телом, проверка браковала ВСЕ адреса подряд (19 из 19
    // «чужие 0/3»), и поток остался бы без адресов вовсе. Редирект доказывает доступность:
    // браузер по нему пойдёт и скрипт получит.
    const got = await Promise.all(THIRDS.map(u =>
        pp.fetchVia(p, u, { timeoutMs: 12000, headers: { 'user-agent': UA, 'accept': '*/*' } })
            .then(r => (r.status >= 200 && r.status < 400) ? 1 : 0)
            .catch(() => 0)));
    return { ok: got.filter(Boolean).length, total: THIRDS.length, ms: Date.now() - t0 };
}

// 🔴 Датацентровые сети уходят в КОНЕЦ очереди, и это замер, а не вкусовщина. Подарок даётся
// «одна сеть - один аккаунт», где сеть - провайдер целиком (наши три прокси одного хостера
// оказались одной сетью). Леджер знает только НАШИ регистрации, а у популярного хостера
// (netcup, Hetzner и прочие) адресный пул общий: сеть выглядит свежей, а подарок по ней уже
// забрал другой клиент. Живой случай 17.09: адрес netcup прошёл всё, аккаунт создался, баланс $0.
// У ISP-адресов такой беды нет: домашние сети никто под реги не раздаёт, и наши удачные
// регистрации шли именно с них (Уфанет, Ростелеком, Cogetel, BrainStorm).
const HOSTING_RE = /hosting|cloud|vps|server|datacenter|data center|dedicat|colo|netcup|hetzner|amazon|google|microsoft|oracle|digitalocean|contabo|ovh|leaseweb|linode|vultr|akamai|cloudflare/i;

async function probeOne(p) {
    const row = { label: p.label, ip: p.hostname, tier: null, as: '', country: '', res: {} };
    try { row.tier = pp.tierOf(p.id); } catch { /* ярус не критичен */ }
    for (const path_ of PATHS) {
        const url = path_.startsWith('http') ? path_ : BASE + path_;
        const t0 = Date.now();
        try {
            const r = await pp.fetchVia(p, url, {
                timeoutMs: TIMEOUT,
                headers: { 'user-agent': UA,
                           'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
            });
            const body = await r.text();
            row.res[path_] = { status: r.status, ms: Date.now() - t0, len: body.length };
            if (path_ === PATHS[0] && r.status === 200) {
                // 🔴 Две проверки идут ПАРАЛЛЕЛЬНО, а не друг за другом: каждая - это
                // несколько запросов через прокси, и последовательно кандидат занимал до
                // сорока секунд. Запуск прогона от этого растягивался, а владелец ждёт
                // первую регистрацию, а не полную таблицу.
                const [burst, thirds] = await Promise.all([burstCheck(p, body), thirdsCheck(p)]);
                row.burst = burst;
                row.thirds = thirds;
            }
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
    const bad = badAddresses();
    // `isp` из ответа ip-api нужен для признака «датацентр» - вместе с ASN он и решает очередь.
    const fresh = [];
    const spent = [];
    let skippedOwn = 0;
    for (const p of all) {
        // 🔴 СВОИ адреса в Odyssey не берём вовсе - решение владельца 25.09: «одисей только из
        // прокси скрапера, свой (наш) пул там не должен быть». И это не вкусовщина: выходы наших
        // нод - это хостинги (Private Layer, HOSTKEY, VPSPay), по ним подарок $5 давно разобран
        // чужими клиентами, и прогон на таком адресе стоит созданного и выброшенного аккаунта.
        // Замер 25.09 16:44-16:54: три адреса из четырёх дали $0, четвёртый встал на капче.
        // Ярус при этом и есть тот признак, по которому пул отличает свои от скрапера, - берём
        // его тут же, а не отдельным списком адресов, который рано или поздно разъедется.
        let tier = null;
        try { tier = pp.tierOf(p.id); } catch { /* ярус не критичен */ }
        if (tier === 'own') { skippedOwn += 1; continue; }
        const info = asn[p.hostname] || {};
        const key = String(info.as || '').trim();
        if (bad[p.label]) continue;   // адрес уже проваливался по нашей вине - не пробуем
        const rec = { p, key, country: info.country || '?', isp: info.isp || '' };
        (key && used[key] ? spent : fresh).push(rec);
    }
    console.log(`в пуле ${all.length} · своих отсеяно ${skippedOwn} · сетей трачено ${Object.keys(used).length} · ` +
                `свежих кандидатов ${fresh.length} · отсеяно как траченые ${spent.length}`);

    const out = [];
    const good = [];
    // «Годен» теперь значит: HTML 200 И чанки приехали пачкой. Раньше хватало HTML, и такие
    // адреса уходили в прогон, где браузер не мог поднять приложение (см. burstCheck).
    // Порог поднят с 80 % до 90 %, и ссылок теперь двадцать: правило простое - не приехало
    // почти всё, значит и браузер приложение не соберёт.
    // Годен = страница 200 + почти все свои чанки + ВСЕ три чужих хоста (Clerk и Turnstile).
    const usable = (r) => r.res[PATHS[0]].status === 200 && r.burst && r.burst.total >= 8
        && r.burst.ok >= Math.ceil(r.burst.total * 0.9)
        && r.thirds && r.thirds.ok === r.thirds.total;
    for (let i = 0; i < fresh.length; i += CONC) {
        const chunk = fresh.slice(i, i + CONC);
        const rows = await Promise.all(chunk.map(x => probeOne(x.p)));
        rows.forEach((r, j) => {
            r.as = chunk[j].key; r.country = chunk[j].country;
            r.hosting = HOSTING_RE.test(String(chunk[j].key || '') + ' ' + String(chunk[j].isp || ''));
            out.push(r);
            if (usable(r)) good.push(r);
            const mark = (v) => v.err ? `✗ ${v.err}` : `${v.status} ${v.len}b`;
            const b = (r.burst ? `${r.burst.ok}/${r.burst.total} чанков` : 'чанки не проверялись')
                + (r.thirds ? ` · чужие хосты ${r.thirds.ok}/${r.thirds.total}` : '');
            console.log(`  ${r.ip.padEnd(16)} ${(r.as || 'ASN неизвестен').slice(0, 28).padEnd(28)} ` +
                        `${r.country.padEnd(3)} стр: ${mark(r.res[PATHS[0]]).padEnd(20)} ${b}`);
        });
        // Рано выходим: проба стоит по 2-8 с на адрес, а на 33 кандидатах это минуты.
        // Обёртке нужно 2-3 годных адреса, остальной перебор - трата времени впустую.
        if (good.length >= WANT) {
            console.log(`  … хватит: годных уже ${good.length} (проверено ${out.length} из ${fresh.length})`);
            break;
        }
    }

    const page = (r) => r.res[PATHS[0]];
    const ok = good.filter(usable);
    const half = out.filter(r => page(r).status === 200 && !usable(r));
    console.log(`\n🔴 ГОДНЫХ (HTML + чанки пачкой): ${ok.length}`);
    for (const r of ok) {
        console.log(`  --proxy '${r.label}'   # ${r.as} · ${r.country} · страница ${page(r).ms}мс · ` +
                    `чанки ${r.burst.ok}/${r.burst.total} за ${r.burst.ms}мс`);
    }
    if (half.length) {
        console.log(`\n⚠️ HTML отдали, а чанки не приехали (${half.length}) - браузер на них не поднимет приложение:`);
        for (const r of half) {
            const b = r.burst ? `${r.burst.ok}/${r.burst.total}` : 'не проверялись';
            console.log(`  ${r.label}   # ${r.as} · ${r.country} · чанки ${b}`);
        }
    }
    // Машинный список для обёртки: годится только то, где жива САМА страница. Один адрес
    // на сеть: подарок даётся один раз на ASN, и второй адрес того же провайдера в том же
    // прогоне смысла не имеет (замер: два адреса AS60404 Liteserver попали в годные разом).
    const cand = [];
    const seenAs = new Set();
    for (const r of ok.sort((a, b) => (a.hosting - b.hosting) || (page(a).ms - page(b).ms))) {
        if (seenAs.has(r.as)) continue;
        seenAs.add(r.as);
        cand.push({ label: r.label, as: r.as, country: r.country, pageMs: page(r).ms,
                    hosting: !!r.hosting });
    }
    fs.writeFileSync(path.join(__dirname, '..', 'odyssey', 'candidates.json'),
                     JSON.stringify({ at: new Date().toISOString(), candidates: cand }, null, 1));
    console.log(`\nсписок для обёртки: odyssey/candidates.json (${cand.length})`);
    fs.writeFileSync(path.join(__dirname, 'probe-odyssey-candidates.json'),
                     JSON.stringify(out, null, 1));
    console.log('полная таблица: _research/probe-odyssey-candidates.json');
})().catch(e => { console.error('упало:', e.message); process.exit(1); });
