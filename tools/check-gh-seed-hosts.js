// tools/check-gh-seed-hosts.js
//
// Регресс на стык «вкладка предлагает заселить GitHub» ↔ «индекс профилей знает этот хост».
//
// Список хостов живёт в ДВУХ местах: таблица заселения в дашборде (`NEWAPI_SEED_PROV`,
// routing/proxy-dashboard.html) и индекс GitHub-куки (`PROFILE_ROOTS` в
// routing/lib/github-session.js). Разъехались - и пикер вкладки открывается, а ручка
// `/__switch/api/gh/available?host=…` отвечает `500 неизвестный хост`: у вкладки своя
// кнопка, ошибка приходит текстом в модалку, и «заселение не работает» выглядит как
// каприз, а не как пропущенная строка.
//
// Живой случай 21.09.2026: пять вкладок сразу - `fxqidian.de5.net`, `apichat.budsin.dev`,
// `nova.vcrauo.com`, `emtf.aipm9527.online`, `seekai.cc`. У seekai это было известно и
// записано комментарием в самом файле индекса («ровно так и осталось у seekai, которого
// здесь нет»), но стык никто не проверял.
//
// Сети здесь нет: читаем таблицу из дашборда и спрашиваем индекс.
// Запуск: node tools/check-gh-seed-hosts.js

const fs = require('fs');
const path = require('path');

const { hostToTag, PROFILE_ROOTS } = require('../routing/lib/github-session.js');

const ROOT = path.join(__dirname, '..');
const DASHBOARD = path.join(ROOT, 'routing', 'proxy-dashboard.html');

let failed = 0;
function ok(cond, msg) {
    console.log(`${cond ? '✅' : '❌'} ${msg}`);
    if (!cond) failed++;
}

// Таблица заселения: от `const NEWAPI_SEED_PROV = {` до закрывающей `};`.
// 🪤 Именно литералы `host: '…'` - остальное (label/color/reload) к индексу отношения не
// имеет, а `host` обязан совпадать с PROFILE_ROOTS байт в байт: у JustWoker это поддомен
// `api.justwoker.icu`, у AgentRouter - `agentrouter.org` без пути.
function seedHosts(src) {
    const m = src.match(/const NEWAPI_SEED_PROV = \{([\s\S]*?)\n\};/);
    if (!m) return null;
    return [...m[1].matchAll(/host:\s*'([^']+)'/g)].map(x => x[1]);
}

function main() {
    const src = fs.readFileSync(DASHBOARD, 'utf8');
    const hosts = seedHosts(src);
    if (!hosts || !hosts.length) {
        console.error('❌ не нашёл таблицу NEWAPI_SEED_PROV в proxy-dashboard.html - проверка устарела');
        process.exit(1);
    }
    console.log(`вкладок с заселением GitHub: ${hosts.length}`);

    const unknown = [];
    for (const host of hosts) {
        const tag = hostToTag(host);
        if (!tag) { unknown.push(host); continue; }
        const row = PROFILE_ROOTS.find(r => r.tag === tag);
        ok(path.isAbsolute(row.dir) && row.dir.startsWith(ROOT),
            `${host} → тег ${tag}, папка профилей внутри репозитория`);
    }
    ok(unknown.length === 0,
        unknown.length
            ? `индекс профилей не знает ${unknown.length} хост(ов): ${unknown.join(', ')}`
            : 'индекс профилей знает все хосты, которые предлагает таблица заселения');

    // Обратная сторона: строка в индексе без папки на диске молча выпадает из скана.
    // Это НЕ провал (на свежей установке папок ещё нет) - поэтому отдельной строкой.
    const noDir = PROFILE_ROOTS.filter(r => r.host && !fs.existsSync(r.dir)).map(r => r.tag);
    if (noDir.length) console.log(`ℹ️  строки без папки на диске (на свежей установке это норма): ${noDir.join(', ')}`);

    console.log(failed ? `\n❌ провалено проверок: ${failed}` : '\n✅ всё сошлось');
    process.exit(failed ? 1 : 0);
}

main();
