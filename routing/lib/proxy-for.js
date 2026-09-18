// routing/lib/proxy-for.js
//
// Мост: выдать прокси из общего пула в форме, которую понимает БРАУЗЕР (Playwright и
// Camoufox), а не http-агент Node. Печатает одну строку JSON и выходит.
//
// Зачем отдельный файл. Пул живёт в Node (`proxy-pool.js`): там разбор строк, ярусы,
// липкая привязка на диске, ёмкость по паре «прокси × хост» и preflight. Авторег Odyssey
// вынужден быть на Python - только Camoufox проходит Turnstile. Своя реализация пула на
// Python означала бы вторую копию правил распределения; в этом репозитории дубли уже
// приводили к тому, что правка в одном месте не касалась другого, а снаружи это выглядело
// как необъяснимый провал. Поэтому Python зовёт этот мост.
//
// Использование:
//   node routing/lib/proxy-for.js --key odyssey:mail@example.com --host odysseyapi.tech \
//        --path /api/auth/altcha/challenge --tier scraper
//
// Ответ (одна строка JSON):
//   {"ok":true,"direct":true,"reason":"…"}                       — идти без прокси
//   {"ok":true,"tier":"scraped","label":"http://1.2.3.4:8080",
//    "browser":{"server":"http://1.2.3.4:8080"}}                 — идти через него
//   {"ok":false,"error":"…"}                                     — НЕ ходить вообще
//
// 🪤 Ярус выбирается ДО первого обращения к пулу: `config()` читает env и мемоизирует,
// поэтому `PROXY_POOL_OWN` надо ставить раньше `require`. Пустая строка - документированный
// способ изолировать ярус «свои», он же используется в регрессах пула.
//
// 🪤 Про креды у SOCKS: публичные адреса скрапера идут без логина и пароля, поэтому для
// яруса «скрапер» вопрос не встаёт. Для «своих» (SOCKS5 из нод XGATE с логином) поддержку
// авторизации у Firefox-движка надо ПРОВЕРИТЬ живым прогоном, а не считать данной: у
// Playwright она заявлена для http и socks5, но у Firefox исторически хромает. Пока ярус
// «свои» пуст, проверять нечего - строка стоит здесь, чтобы вопрос не потерялся.

const argv = process.argv.slice(2);
const val = (name, def = null) => {
    const i = argv.indexOf(name);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    const eq = argv.find(a => a.startsWith(`${name}=`));
    return eq ? eq.slice(name.length + 1) : def;
};

const key = val('--key');
const host = val('--host');
const probePath = val('--path', '/api/status');
const tier = String(val('--tier', 'none')).toLowerCase();
// Привязка аккаунта к конкретному прокси: `--bind-key <ключ> --bind-label <прокси>`.
// Нужна, потому что авторега регистрирует аккаунт под СВОИМ ключом (профиль окна), а
// дашборд потом ищет прокси по ключу `accountId` (`stickyKey` возвращает сам id). Пока
// привязки разные, чек баланса идёт через ДРУГОЙ адрес, а `cf_clearance` привязан к IP -
// и кабинет отвечает 307. Выравниваем сразу после регистрации, когда id уже известен.
const bindKey = val('--bind-key');
const bindLabel = val('--bind-label');
// `--exclude a,b` - адреса, которые уже пробовали. Нужно автореге Odyssey: капча
// Turnstile на части IP не поддаётся вообще (виджет висит и не нажимается), и
// единственный выход - взять СЛЕДУЮЩИЙ адрес из пула и попробовать снова.
const exclude = String(val('--exclude', '')).split(',').map(s => s.trim()).filter(Boolean);
// `--skip-asn "AS123,AS456"` - сети, которые авторег Odyssey уже тратил. Пул про леджер
// (`odyssey/networks-used.json`) не знает и потому выдаёт адреса из траченных сетей: подарок
// там уже получен, аккаунт выйдет с нулём, драйвер его отвергает - а каждая такая попытка
// стоит полного preflight (замер 17.09: 2.5 минуты на адрес, четыре адреса подряд впустую).
const skipAsn = String(val('--skip-asn', '')).split(',').map(s => s.trim()).filter(Boolean);
// `--force` - проверять кандидата ЖИВЬЁМ, не веря кэшу здоровья. Замер 16.09: у пула
// проверка кэшируется на 10 минут, а публичный адрес умирает за минуты - прогон поднимал
// окно и получал `NS_ERROR_CONNECTION_REFUSED` на живой, по мнению пула, прокси.
const forceCheck = argv.includes('--force');

const out = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };
const log_line = (m) => process.stderr.write(`[proxy-for] ${m}\n`);

// Прокси пула → форма браузера. Схема уже нормализована пулом (`http`, `socks4`, `socks5`).
function browserProxy(p) {
    const cfg = { server: `${p.scheme}://${p.hostname}:${p.port}` };
    if (p.user) cfg.username = p.user;
    if (p.pass) cfg.password = p.pass;
    return cfg;
}

// ASN адреса по кэшу на диске: ip-api бесплатный и не любит частых запросов, а пул мы
// обходим по нескольку раз за прогон.
const ASN_CACHE_FILE = require('path').join(__dirname, '..', 'asn-cache.json');
let _asnCache = null;
function asnCache() {
    if (_asnCache) return _asnCache;
    try { _asnCache = JSON.parse(require('fs').readFileSync(ASN_CACHE_FILE, 'utf8')); }
    catch { _asnCache = {}; }
    return _asnCache;
}
async function asnOf(ip) {
    const c = asnCache();
    if (c[ip] !== undefined) return c[ip];
    try {
        const r = await fetch(`http://ip-api.com/json/${ip}?fields=as`);
        const j = await r.json();
        c[ip] = String(j.as || '').trim();
    } catch { c[ip] = ''; }
    try { require('fs').writeFileSync(ASN_CACHE_FILE, JSON.stringify(c, null, 1)); } catch { /* не критично */ }
    return c[ip];
}
// Оставляем только адреса из НЕтраченных сетей. Пустой результат - не повод молча идти в
// траченные: вызывающий сам решит, что делать.
async function dropSpentNetworks(list) {
    if (!skipAsn.length) return list;
    const keep = [];
    for (const p of list) {
        const asn = await asnOf(p.hostname);
        if (asn && skipAsn.includes(asn)) {
            log_line(`сеть ${asn} уже трачена - пропускаю ${p.label}`);
            continue;
        }
        keep.push(p);
    }
    return keep;
}

(async () => {
    // Режим привязки: ничего не выдаём, только связываем ключ с прокси.
    if (bindKey && bindLabel) {
        let pp;
        try { pp = require('./proxy-pool.js'); }
        catch (e) { return out({ ok: false, error: `пул не загрузился: ${e.message}` }); }
        const p = pp.pool().proxies.find(x => x.label === bindLabel || x.id === bindLabel);
        if (!p) return out({ ok: false, error: `прокси «${bindLabel}» в пуле не найден` });
        const re = pp.reassign(bindKey, p.id);
        return out(re.ok
            ? { ok: true, bound: true, key: bindKey, proxy: re.proxy.label || re.proxy.id }
            : { ok: false, error: re.error });
    }

    if (tier === 'none') return out({ ok: true, direct: true, reason: 'ярус none - прогон идёт напрямую' });
    if (!key) return out({ ok: false, error: '--key обязателен: без ключа привязки прокси вслепую не выдаётся' });
    if (!host) return out({ ok: false, error: '--host обязателен' });

    // Ярус «скрапер» = изолировать «свои». Ставим до require, см. шапку.
    if (tier === 'scraper') process.env.PROXY_POOL_OWN = '';

    let pp;
    try { pp = require('./proxy-pool.js'); }
    catch (e) { return out({ ok: false, error: `пул не загрузился: ${e.message}` }); }

    if (!pp.enabledForHost(host)) {
        return out({ ok: true, direct: true, reason: `пул выключен для ${host} (нет в hosts конфига)` });
    }

    // Ярус «свои»: привязку явно переводим на own-прокси, иначе липкость могла бы
    // оставить аккаунт на скрапере, назначенном прошлым прогоном.
    if (tier === 'own') {
        const own = pp.pool().proxies.filter(p => {
            try { return pp.tierOf(p.id) === 'own'; } catch { return false; }
        });
        if (!own.length) {
            return out({ ok: false, error: 'ярус «свои» пуст: нет routing/own-proxies.txt или в нём нет разобранных строк' });
        }
        const cur = pp.assignmentFor(key);
        const curIsOwn = cur && cur.proxy && own.some(p => p.id === cur.proxy);
        if (!curIsOwn) {
            const assign = { ...pp.assignments() };
            delete assign[key];
            const next = pp.leastLoaded(own, assign);
            const re = pp.reassign(key, next.id);
            if (!re.ok) return out({ ok: false, error: `не удалось привязать «свой» прокси: ${re.error}` });
        }
    }

    // Ротация: если попросили исключить уже пробованные - берём следующего кандидата и
    // ПЕРЕПРИВЯЗЫВАЕМ ключ (липкость остаётся, меняется только адрес аккаунта).
    if (exclude.length) {
        // 🪤 Ротация обязана оставаться ВНУТРИ запрошенного яруса: первая версия брала
        // «любой, кроме исключённых», и на ярусе «свои» выдавала публичный адрес скрапера -
        // то есть молча меняла ярус, а это ровно тот класс подмены, от которого пул и
        // защищается.
        const all = await dropSpentNetworks(pp.pool().proxies.filter(p => {
            if (exclude.includes(p.label)) return false;
            if (tier === 'own') {
                try { return pp.tierOf(p.id) === 'own'; } catch { return false; }
            }
            if (tier === 'scraper') {
                try { return pp.tierOf(p.id) !== 'own'; } catch { return true; }
            }
            return true;
        }));
        if (!all.length) return out({ ok: false, error: `в ярусе ${tier} больше нет непробованных прокси (исключено ${exclude.length})` });
        const assign = { ...pp.assignments() };
        delete assign[key];
        const next = pp.leastLoaded(all, assign);
        const re = pp.reassign(key, next.id);
        if (!re.ok) return out({ ok: false, error: `перепривязать не вышло: ${re.error}` });
        log_line(`ротация: ключ ${key} → ${re.proxy.label}`);
    }

    let r;
    try { r = await pp.forAccount(key, { host, preflightPath: probePath, force: forceCheck }); }
    catch (e) { return out({ ok: false, error: `пул упал: ${e.message}` }); }

    // 🔴 Липкая привязка на МЁРТВЫЙ адрес - это не приговор, а повод перебрать кандидатов.
    // Пул по своему правилу отвечает «назначен и мёртв → не ходить вообще» (и правильно:
    // молча уйти напрямую нельзя), но у соседних авторег на этот случай есть цикл
    // «исключить отработавшего → взять следующего → перепривязать». Без него прогон падал
    // сразу: пул однажды привязал ключ к адресу, который сегодня не отвечает, и каждая
    // следующая попытка упиралась в ту же привязку (замер 16.09, ярус скрапера).
    if (!r.ok) {
        const dead = new Set(exclude);
        const m = /(?:socks5?|https?):\/\/[^\s,]+/.exec(String(r.error || ''));
        if (m) dead.add(m[0]);
        // Перебор глубокий намеренно: публичные адреса скрапера в большинстве мертвы или
        // требуют авторизации, и трёх попыток не хватало - прогон падал на «пул отказал».
        for (let i = 0; i < 12 && !r.ok; i++) {
            const pool = await dropSpentNetworks(pp.pool().proxies.filter(p => !dead.has(p.label)));
            if (!pool.length) break;
            const assign = { ...pp.assignments() };
            delete assign[key];
            const next = pp.leastLoaded(pool, assign);
            const re = pp.reassign(key, next.id);
            if (!re.ok) break;
            log_line(`мёртвый адрес, беру следующий: ${re.proxy.label}`);
            dead.add(re.proxy.label);
            r = await pp.forAccount(key, { host, preflightPath: probePath, force: true });
        }
    }
    if (!r.ok) return out({ ok: false, error: r.error });
    if (!r.proxy) return out({ ok: true, direct: true, reason: r.reason || 'пул не дал прокси' });

    let tierName = null;
    try { tierName = pp.tierOf(r.proxy.id); } catch { /* не критично */ }
    out({
        ok: true,
        direct: false,
        how: r.how || null,
        tier: tierName,
        label: r.proxy.label,
        browser: browserProxy(r.proxy),
    });
})().catch(e => out({ ok: false, error: `мост упал: ${e.message}` }));
