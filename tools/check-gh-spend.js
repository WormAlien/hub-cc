#!/usr/bin/env node
// Регресс: сумма трат на GitHub-аккаунты хранится на СЕРВЕРЕ и с поставки равна нулю.
//
// Дефект, ради которого тест написан (11.09.2026): в `proxy-dashboard.html` стоял
// литерал `value="1200"`, а обработчик `oninput` только пересчитывал цифры и никуда
// не писал. Итог — введённая сумма исчезала по F5, а «с поставки» показывалось 1200,
// которых никто не вводил.
//
// Гоняем боевой код вырезкой, а не копию: если функции переименуют или уберут
// валидацию, тест обязан упасть.
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'routing', 'transparent-proxy.js');
const HTML = path.join(ROOT, 'routing', 'proxy-dashboard.html');

const fails = [];
const ok = [];

// ---- 1. Разметка не содержит зашитой суммы --------------------------------
let html = '';
try { html = fs.readFileSync(HTML, 'utf8'); }
catch (e) { fails.push(`не прочитан ${HTML}: ${e.message}`); }

if (html) {
    const m = html.match(/<input id="rub" value="([^"]*)"/);
    if (!m) fails.push('proxy-dashboard.html: поле #rub не найдено');
    else if (m[1] !== '0') fails.push(`proxy-dashboard.html: #rub с поставки = "${m[1]}", должно быть "0" (зашитая сумма — это не данные)`);
    else ok.push('#rub с поставки = 0');

    if (!/fetch\('\/__switch\/api\/gh\/spend'/.test(html)) fails.push('proxy-dashboard.html: поле не читает сумму с сервера');
    else ok.push('поле читает сумму с сервера');

    if (!/rubSaved/.test(html)) fails.push('proxy-dashboard.html: нет отката к подтверждённому значению при отказе записи');
    else ok.push('откат при отказе записи на месте');
}

// ---- 2. Хранилище: боевые ghSpendLoad/ghSpendSave --------------------------
let src = '';
try { src = fs.readFileSync(PROXY, 'utf8'); }
catch (e) { fails.push(`не прочитан ${PROXY}: ${e.message}`); }

if (src) {
    const load = src.match(/function ghSpendLoad\(\) \{[\s\S]*?\n\}/);
    const save = src.match(/function ghSpendSave\(rub\) \{[\s\S]*?\n\}/);
    if (!load) fails.push('transparent-proxy.js: функция ghSpendLoad() не найдена');
    if (!save) fails.push('transparent-proxy.js: функция ghSpendSave(rub) не найдена');

    if (load && save) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-spend-'));
        const file = path.join(dir, 'github-spend.json');
        let api;
        try {
            // Функции вырезаются из файла и исполняются в изоляции, поэтому их внешние
            // зависимости надо передать явно. `durableWriteJson` — именно такая: запись
            // идёт через общий durable-хелпер (tmp + fsync + rename), см.
            // routing/lib/durable-write.js. Без него вырезка падает ReferenceError.
            const { writeJsonSync } = require(path.join(ROOT, 'routing/lib/durable-write.js'));
            api = new Function('fs', 'GH_SPEND_FILE', 'durableWriteJson',
                `${load[0]}\n${save[0]}\nreturn { ghSpendLoad, ghSpendSave };`)(fs, file, writeJsonSync);
        } catch (e) {
            fails.push(`хранилище не исполняется: ${e.message}`);
        }

        if (api) {
            const cases = [];
            // с поставки — ноль, файла ещё нет
            cases.push(['файла нет → 0', api.ghSpendLoad() === 0]);
            // битый JSON не должен ронять дашборд
            fs.writeFileSync(file, '{не json', 'utf8');
            cases.push(['битый JSON → 0', api.ghSpendLoad() === 0]);
            // отрицательное в файле — мусор, читаем как 0
            fs.writeFileSync(file, JSON.stringify({ rub: -5 }), 'utf8');
            cases.push(['отрицательное в файле → 0', api.ghSpendLoad() === 0]);
            // круг записи-чтения
            api.ghSpendSave(1200);
            cases.push(['1200 сохранено и прочитано', api.ghSpendLoad() === 1200]);
            api.ghSpendSave(0);
            cases.push(['0 сохраняется как 0, а не теряется', api.ghSpendLoad() === 0]);
            api.ghSpendSave(2499.5);
            cases.push(['дробная сумма переживает круг', api.ghSpendLoad() === 2499.5]);
            // атомарность: временный файл за собой не оставляем
            cases.push(['временный файл убран', !fs.existsSync(file + '.tmp')]);

            for (const [name, pass] of cases) {
                if (pass) ok.push(name); else fails.push(`хранилище: ${name}`);
            }
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
    }

    // ---- 3. Ручка отвергает мусор ------------------------------------------
    const h = src.match(/async function handleGhSpend\(req, res\) \{[\s\S]*?\n\}/);
    if (!h) fails.push('transparent-proxy.js: функция handleGhSpend() не найдена');
    else {
        if (!/Number\.isFinite\(rub\)\s*\|\|\s*rub\s*<\s*0/.test(h[0]))
            fails.push('handleGhSpend(): нет отбраковки нечислового и отрицательного — опечатка запишется молча');
        else ok.push('handleGhSpend отвергает нечисловое и отрицательное');

        if (!/jsonRes\(res,\s*400/.test(h[0]))
            fails.push('handleGhSpend(): мусор не отвечает 400');
        else ok.push('handleGhSpend отвечает 400 на мусор');
    }

    // ---- 4. Маршрут зарегистрирован ----------------------------------------
    if (!/'\/__switch\/api\/gh\/spend'\)\s*return handleGhSpend/.test(src))
        fails.push('transparent-proxy.js: маршрут /__switch/api/gh/spend не зарегистрирован');
    else ok.push('маршрут /__switch/api/gh/spend зарегистрирован');
}

for (const s of ok) console.log(`  OK   ${s}`);
for (const s of fails) console.log(`  FAIL ${s}`);
console.log(fails.length ? `\n${fails.length} провал(ов) из ${ok.length + fails.length}` : `\nвсё чисто: ${ok.length}/${ok.length}`);
process.exit(fails.length ? 1 : 0);
