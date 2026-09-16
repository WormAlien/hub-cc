// _research/probe-pool-vs-odyssey.js
//
// Один вопрос: МОГУТ ли публичные прокси из пула вообще достучаться до Odyssey.
//
// Зачем именно так. Скрапер проверил 6904 кандидата против `odysseyapi.tech` и дал ноль
// живых. Из этого счётчика нельзя понять, в чём дело: публичные списки мертвы сами по себе
// или Cloudflare режет прокси на входе. Замер отвечает точно, потому что берёт адреса,
// которые ЗАВЕДОМО туннелируют - те 39, что уже лежат в файле пула и прошли проверку
// против agentrouter. Если они дают 403/503 на Odyssey, дело в защите площадки; если
// таймауты и обрывы - просто умерли с прошлой проверки.
//
// Читающий замер: ничего не пишет, привязок не трогает.
//
// Запуск: node _research/probe-pool-vs-odyssey.js

const pp = require('../routing/lib/proxy-pool.js');

const HOST = 'odysseyapi.tech';
const URL_PROBE = `https://${HOST}/api/auth/altcha/challenge`;
const LIMIT = Number(process.argv[2] || 39);

(async () => {
    const pool = pp.pool();
    const list = pool.proxies.slice(0, LIMIT);
    console.log(`в пуле разобрано ${pool.proxies.length}, проверяю ${list.length} по ${URL_PROBE}`);
    console.log('');

    const verdicts = new Map();
    let live = 0;

    // Последовательно, а не пачкой: замер идёт минуту, зато не создаёт всплеск запросов
    // к площадке с 39 адресов сразу - это само по себе выглядело бы как атака.
    for (const p of list) {
        const t0 = Date.now();
        let verdict;
        try {
            const r = await pp.fetchVia(p, URL_PROBE, { timeoutMs: 12000 });
            // 🪤 `text` здесь МЕТОД, как у fetch: `String(r.text)` вернул бы исходник
            // функции (`async () => text`), и проверка тела превратилась бы в проверку
            // самой себя. Первая версия этой пробы так и сделала - и записала живые
            // прокси в мёртвые.
            const body = String(await r.text()).slice(0, 220).replace(/\s+/g, ' ');
            verdict = `HTTP ${r.status}`;
            // 🔴 Живым считается только тот, кто отдал ОЖИДАЕМОЕ тело: боевому нужен
            // челлендж, а не код ответа.
            if (r.status === 200 && body.includes('PBKDF2')) {
                live++;
                verdict += ' (челлендж отдан)';
            } else if (r.status === 200) {
                verdict += ` (200, но тело не то: ${body.slice(0, 40)})`;
            }
        } catch (e) {
            verdict = String(e.message || e).split('\n')[0].slice(0, 60);
        }
        const ms = Date.now() - t0;
        const short = verdict.replace(/\d+\.\d+\.\d+\.\d+/g, 'ip');
        verdicts.set(short, (verdicts.get(short) || 0) + 1);
        console.log(`  ${p.label.padEnd(28)} ${String(ms).padStart(5)} мс  ${verdict}`);
    }

    console.log('');
    console.log('='.repeat(60));
    console.log(`живых до Odyssey: ${live} из ${list.length}`);
    for (const [v, n] of [...verdicts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(3)} × ${v}`);
    }
    console.log('='.repeat(60));
    // Вывод формулирую здесь же, чтобы он попал в лог замера, а не остался в голове.
    if (live > 0) {
        console.log('вывод: прокси ДОХОДЯТ до API площадки - ярус «скрапер» имеет смысл,');
        console.log('       остаётся вопрос, пройдёт ли с них Turnstile (проверяется окном записи)');
    } else if ([...verdicts.keys()].some(k => /HTTP 40|HTTP 50/.test(k))) {
        console.log('вывод: прокси доходят, но площадка отвечает отказом - это защита Cloudflare,');
        console.log('       и ярус «скрапер» для регистрации бесполезен by design');
    } else {
        console.log('вывод: до API не дошёл НИ ОДИН (таймауты, обрывы, чужое тело) - это не про');
        console.log('       Cloudflare, а про качество публичных списков: адреса мертвы сами по себе');
    }
})().catch(e => { console.log('ФАТАЛЬНО:', e.message); process.exit(1); });
