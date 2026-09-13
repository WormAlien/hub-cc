#!/usr/bin/env node
'use strict';
// Приёмка «имя без модели» и двух тир-карт.
//
// Заявка владельца 12.09: `/model agentrouter` вместо `/model agentrouter/gpt-6-astra`,
// модель выбирает вкладка «Маршруты». Плюс «для провайдера свой маппинг, для маршрутов
// свой» — до этого файл был один, и правка на одной вкладке меняла поведение другой.
//
// Что доказываем (и почему именно это):
//  1. Голое имя шлюза распознаётся и разворачивается в `default` из routes-карты.
//     До правки этот случай возвращал null → запрос МОЛЧА уезжал на активный шлюз,
//     то есть на чужой баланс. Тихий отказ, ради которого всё и делалось.
//  2. Читается именно `<prefix>-routes-modelmap.json`, а НЕ карта активного шлюза:
//     если перепутать файлы, вкладки снова начнут перетирать друг друга.
//  3. Заголовок `x-route-prefixed` уходит наверх (по нему keepalive берёт ту же
//     routes-карту) и снимается с непрефиксных запросов — иначе чужой запрос
//     притворится префиксным.
//  4. Пустой `default` → 400 с подсказкой, а не угадывание и не тихий уход.
//  5. Суффикс окна на голом имени (`agentrouter[1m]`) не ломает поиск в реестре.
//     normalizeCcModel вешает `[1m]` автоматически, так что случай неизбежен.
//  6. Сабагенты (sonnet/haiku) идут по СВОИМ тирам, а не по `default` — решение
//     владельца «вариант A»: haiku обязан остаться дешёвым.
//
// Живых шлюзов и платных запросов здесь нет: апстрим поддельный, он же и протокол.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-routes-'));
const FD_PORT = 21421;          // front-door под тестом
const UP_PORT = 21422;          // «шлюз» провайдера

const servers = [];
let child = null;
const cleanup = () => {
    for (const s of servers) { try { s.close(); } catch { } }
    if (child) { try { process.kill(child.pid); } catch { } }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
};
process.on('exit', cleanup);

const nap = ms => new Promise(r => setTimeout(r, ms));

function listen(server, port) {
    servers.push(server);
    return new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(port, '127.0.0.1', res);
    });
}

function post(port, urlPath, obj, timeout = 15000) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    return new Promise((resolve, reject) => {
        const rq = http.request({
            host: '127.0.0.1', port, method: 'POST', path: urlPath, timeout,
            headers: { 'content-type': 'application/json', 'content-length': payload.length },
        }, (r) => {
            const buf = [];
            r.on('data', c => buf.push(c));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(buf).toString('utf8') }));
        });
        rq.on('timeout', () => rq.destroy(new Error('timeout')));
        rq.on('error', reject);
        rq.end(payload);
    });
}

const ok = [];
const fails = [];
const check = (name, fn) => {
    try { fn(); ok.push(name); }
    catch (e) { fails.push(`${name}: ${e.message}`); }
};

(async () => {
    // ── Поддельный шлюз: запоминает, что ему прислали ────────────────────────
    const seen = [];
    await listen(http.createServer((req, res) => {
        const buf = [];
        req.on('data', c => buf.push(c));
        req.on('end', () => {
            let model = null;
            try { model = JSON.parse(Buffer.concat(buf).toString('utf8')).model; } catch { }
            seen.push({ model, prefixed: req.headers['x-route-prefixed'] || null, tier: req.headers['x-route-tier'] || null });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    }), UP_PORT);

    // ── Реестр и обе карты ───────────────────────────────────────────────────
    // `modelmap` в реестре указывает на карту АКТИВНОГО пути; routes-карту
    // front-door обязан вывести сам, подменив суффикс имени файла.
    // 🪤 Пути АБСОЛЮТНЫЕ: относительные readModelMap() резолвит от `routing/`, и тест
    // читал бы боевые карты вместо своих фикстур.
    const gwMap = path.join(TMP, 'tp-modelmap.json');
    const rtMap = path.join(TMP, 'tp-routes-modelmap.json');
    const bareMap = path.join(TMP, 'bare-modelmap.json');
    fs.writeFileSync(gwMap, JSON.stringify({
        default: 'ГАЗЕТА-НЕ-ЭТА', opus: 'gateway-opus', sonnet: 'gateway-sonnet', haiku: 'gateway-haiku', gpt: '',
    }), 'utf8');
    fs.writeFileSync(rtMap, JSON.stringify({
        default: 'routes-default', opus: 'routes-opus', sonnet: 'routes-sonnet', haiku: 'routes-haiku', gpt: 'routes-gpt',
    }), 'utf8');
    // Провайдер без routes-карты: `default` взять неоткуда → обязан быть 400.
    fs.writeFileSync(bareMap, JSON.stringify({ opus: 'x' }), 'utf8');

    const registry = path.join(TMP, 'backends.json');
    const active = path.join(TMP, 'active-backend.json');
    fs.writeFileSync(registry, JSON.stringify({
        version: 1,
        aliases: { tp: 'testprov' },
        providers: {
            testprov: { upstream: `http://127.0.0.1:${UP_PORT}`, keyFile: null, modelmap: gwMap },
            bare: { upstream: `http://127.0.0.1:${UP_PORT}`, keyFile: null, modelmap: bareMap },
        },
    }), 'utf8');
    fs.writeFileSync(active, JSON.stringify({
        backend: 'testprov', upstream: `http://127.0.0.1:${UP_PORT}`, updatedAt: Date.now(),
    }), 'utf8');

    // ── Front-door под тестом ────────────────────────────────────────────────
    child = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js')], {
        env: {
            ...process.env,
            PORT: String(FD_PORT),
            BACKENDS_FILE: registry, ACTIVE_BACKEND_FILE: active,
            LOG_FILE: path.join(TMP, 'fd.log'),
        },
        stdio: 'ignore',
    });
    for (let i = 0; i < 60; i++) {
        try { await post(FD_PORT, '/__ping', {}, 1000); break; } catch { await nap(100); }
    }

    // 1. Голое имя → default из routes-карты
    seen.length = 0;
    let r = await post(FD_PORT, '/v1/messages', { model: 'testprov', max_tokens: 1 });
    check('голое имя шлюза принято (200, не 502/400)', () => assert.strictEqual(r.status, 200, `status ${r.status}: ${r.body}`));
    check('модель развёрнута в default из ROUTES-карты', () => assert.strictEqual(seen[0] && seen[0].model, 'routes-default', JSON.stringify(seen[0])));
    check('карта активного шлюза НЕ использована', () => assert.notStrictEqual(seen[0] && seen[0].model, 'ГАЗЕТА-НЕ-ЭТА'));
    check('заголовок x-route-prefixed уехал наверх', () => assert.strictEqual(seen[0] && seen[0].prefixed, '1', JSON.stringify(seen[0])));
    check('тир помечен как default', () => assert.strictEqual(seen[0] && seen[0].tier, 'default'));

    // 2. Алиас и регистр
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'tp', max_tokens: 1 });
    check('алиас работает так же', () => assert.strictEqual(seen[0] && seen[0].model, 'routes-default'));
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'TestProv', max_tokens: 1 });
    check('регистр имени не важен', () => assert.strictEqual(seen[0] && seen[0].model, 'routes-default'));

    // 3. Суффикс окна на голом имени: normalizeCcModel вешает [1m] сам
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'testprov[1m]', max_tokens: 1 });
    check('суффикс [1m] на голом имени не ломает поиск', () => assert.strictEqual(seen[0] && seen[0].model, 'routes-default', JSON.stringify(seen[0])));

    // 4. Сабагенты идут по СВОИМ тирам (вариант A владельца)
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'testprov/claude-haiku-4-5-20251001', max_tokens: 1 });
    check('haiku помечен своим тиром, а не default', () => assert.strictEqual(seen[0] && seen[0].tier, 'haiku', JSON.stringify(seen[0])));
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'testprov/claude-sonnet-5', max_tokens: 1 });
    check('sonnet помечен своим тиром', () => assert.strictEqual(seen[0] && seen[0].tier, 'sonnet'));

    // 4b. Явное gpt-имя — НЕ метка спрашивающего, а физическая модель: тир не ставится,
    // имя уходит как названо. Иначе `/model agentrouter/gpt-6-astra` подменялся значением
    // ключа `gpt` routes-карты (заявка владельца 12.09, поймано на живом запросе).
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'testprov/gpt-6-astra', max_tokens: 1 });
    check('явное gpt-имя уходит как названо, без тира',
        () => assert.strictEqual(seen[0] && seen[0].tier, null, JSON.stringify(seen[0])));
    check('и само имя не подменено',
        () => assert.strictEqual(seen[0] && seen[0].model, 'gpt-6-astra', JSON.stringify(seen[0])));

    // 5. Пустой default → 400 с подсказкой, ничего никуда не уехало
    seen.length = 0;
    r = await post(FD_PORT, '/v1/messages', { model: 'bare', max_tokens: 1 });
    check('шлюз без default → 400', () => assert.strictEqual(r.status, 400, `status ${r.status}: ${r.body}`));
    check('400 объясняет, что чинить', () => assert.ok(/Маршруты|default/i.test(r.body), r.body));
    check('при 400 наверх не ушло ничего (денег не потрачено)', () => assert.strictEqual(seen.length, 0, JSON.stringify(seen)));

    // 6. Непрефиксный запрос: заголовок обязан отсутствовать, даже если клиент его подсунул
    seen.length = 0;
    await post(FD_PORT, '/v1/messages', { model: 'claude-opus-5', max_tokens: 1 });
    check('обычная модель едет на активный шлюз как есть', () => assert.strictEqual(seen[0] && seen[0].model, 'claude-opus-5'));
    check('без префикса заголовка нет (keepalive возьмёт обычную карту)', () => assert.strictEqual(seen[0] && seen[0].prefixed, null, JSON.stringify(seen[0])));

    // 7. Подделка заголовка клиентом снимается
    seen.length = 0;
    await new Promise((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify({ model: 'claude-opus-5', max_tokens: 1 }), 'utf8');
        const rq = http.request({
            host: '127.0.0.1', port: FD_PORT, method: 'POST', path: '/v1/messages', timeout: 15000,
            headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-route-prefixed': '1' },
        }, (res) => { res.resume(); res.on('end', resolve); });
        rq.on('error', reject);
        rq.end(payload);
    });
    check('подделанный клиентом x-route-prefixed снят', () => assert.strictEqual(seen[0] && seen[0].prefixed, null, JSON.stringify(seen[0])));

    // 8. Корень бага 12.09: реестр обязан давать карту и ЛОКАЛЬНЫМ шлюзам.
    //
    // Почему отдельная проверка, а не «тест и так это ловит». Все прогоны выше дают
    // фикстуру с готовым `modelmap` (gwMap), то есть проверяют ветку front-door. Прод
    // же получал `modelmap: null` — и баг жил в ГЕНЕРАЦИИ реестра, которую эти прогоны
    // не трогали вовсе. Отсюда симптом владельца: вкладка «Маршруты» показывает
    // `default`, а `/model agentrouter` отвечает «не задана».
    //
    // Проверяем двумя разными способами, потому что они ловят разное:
    //  а) исходник — регресс кода (локальная ветка обязана брать префикс из таблицы);
    //  б) живой реестр — фактическое состояние машины.
    const tpSrc = fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8');
    const seed = tpSrc.match(/function registrySeedEntry[\s\S]*?\n\}/);
    check('registrySeedEntry найден', () => assert.ok(seed, 'функции нет — тест устарел'));
    check('локальная ветка берёт карту из CC_MODEL_PREFIX, а не хардкодит null',
        () => assert.ok(/if \(isLocalBase\(base\)\) \{[\s\S]*?modelmap:\s*p\s*\?/.test(seed[0]),
            'локальный шлюз снова отдаёт modelmap: null → /model <шлюз> вернёт 400'));

    const regFile = path.join(os.homedir(), '.claude', 'backends.json');
    if (fs.existsSync(regFile)) {
        const reg = JSON.parse(fs.readFileSync(regFile, 'utf8').replace(/^﻿/, ''));
        const pre = {};
        const tbl = tpSrc.match(/const CC_MODEL_PREFIX = \{([\s\S]*?)\};/);
        if (tbl) for (const m of tbl[1].matchAll(/(\w+):\s*'([^']+)'/g)) pre[m[1]] = m[2];
        const broken = Object.entries(reg.providers || {})
            .filter(([name, e]) => /^https?:\/\/(127\.|localhost|\[::1\])/i.test(String(e.upstream || ''))
                && pre[name] && !e.modelmap)
            .map(([name]) => name);
        check('в живом реестре у локальных шлюзов с префиксом карта проставлена',
            () => assert.deepStrictEqual(broken, [], `без карты: ${broken.join(', ')}`));
    }

    // 9. Диагноз отказа обязан называть СЛОМАННОЕ, а не первое похожее (13.09).
    //
    // Корень 13.09 был в реестре (`modelmap: null` от ветки `extra` писателя), но текст
    // 400 отправлял владельца на вкладку «Маршруты» выбирать `default` — который он там
    // уже выбрал. Отсюда его «я уже выбрал, а она непонятно куда пошла»: подсказка вела
    // чинить исправное. Две поломки — два разных текста, и это проверяемо.
    const noMapReg = path.join(TMP, 'backends-nomap.json');
    const nmGw = path.join(TMP, 'nm-modelmap.json');
    const nmRt = path.join(TMP, 'nm-routes-modelmap.json');
    fs.writeFileSync(nmGw, JSON.stringify({ opus: 'x' }), 'utf8');
    fs.writeFileSync(nmRt, JSON.stringify({ default: '', opus: 'y' }), 'utf8');  // карта есть, тир пуст
    fs.writeFileSync(noMapReg, JSON.stringify({
        version: 1,
        providers: {
            // Ровно состояние прода до фикса: запись есть, карты не указано.
            nomap: { upstream: `http://127.0.0.1:${UP_PORT}`, keyFile: null, modelmap: null },
            hasmap: { upstream: `http://127.0.0.1:${UP_PORT}`, keyFile: null, modelmap: nmGw },
        },
    }), 'utf8');
    const FD2 = FD_PORT + 2;
    const child2 = spawn(process.execPath, [path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js')], {
        env: {
            ...process.env,
            PORT: String(FD2),
            BACKENDS_FILE: noMapReg, ACTIVE_BACKEND_FILE: active,
            LOG_FILE: path.join(TMP, 'fd-nomap.log'),
        },
        stdio: 'ignore',
    });
    const killChild2 = () => { try { process.kill(child2.pid); } catch { } };
    process.on('exit', killChild2);
    for (let i = 0; i < 60; i++) {
        try { await post(FD2, '/__ping', {}, 1000); break; } catch { await nap(100); }
    }

    seen.length = 0;
    r = await post(FD2, '/v1/messages', { model: 'nomap', max_tokens: 1 });
    check('modelmap: null → 400', () => assert.strictEqual(r.status, 400, `status ${r.status}: ${r.body}`));
    check('при modelmap: null текст винит РЕЕСТР, а не вкладку',
        // 🪤 Не грепать `backends.json`: сообщение печатает путь РЕЕСТРА, а под тестом это
        // фикстура `backends-nomap.json` во временной папке. Признак — `modelmap: null`
        // (имя поля реестра) плюс явное снятие вины с вкладки.
        () => assert.ok(/modelmap: null/.test(r.body) && /НЕ виновата/.test(r.body), r.body));
    check('при modelmap: null наверх не ушло ничего', () => assert.strictEqual(seen.length, 0, JSON.stringify(seen)));

    seen.length = 0;
    r = await post(FD2, '/v1/messages', { model: 'hasmap', max_tokens: 1 });
    check('карта есть, default пуст → 400', () => assert.strictEqual(r.status, 400, `status ${r.status}: ${r.body}`));
    check('пустой тир ведёт на вкладку «Маршруты» и НЕ винит реестр',
        () => assert.ok(/Маршруты/.test(r.body) && !/modelmap: null/.test(r.body), r.body));

    // Контроль к тому же состоянию: `modelmap: null` ломает ТОЛЬКО голое имя. Явное имя
    // routes-карту не читает вовсе (`routesMapFor` в той ветке не вызывается), поэтому
    // обязано доезжать. Без этой проверки фикс мог бы «вылечить» голое имя, попутно
    // сломав явное, и тест бы этого не увидел.
    seen.length = 0;
    r = await post(FD2, '/v1/messages', { model: 'nomap/glm-5.3', max_tokens: 1 });
    check('явное имя при modelmap: null доезжает (200)', () => assert.strictEqual(r.status, 200, `status ${r.status}: ${r.body}`));
    check('явное имя при modelmap: null не подменено', () => assert.strictEqual(seen[0] && seen[0].model, 'glm-5.3', JSON.stringify(seen[0])));
    killChild2();

    // 10. Корень 13.09 — в ПИСАТЕЛЕ реестра, и он проверяется исполнением, а не грепом.
    //
    // Проверка №8 выше грепает `registrySeedEntry` — она и была зелёной, пока баг жил во
    // ВТОРОЙ ветке (`extra`, «только что активированный бэкенд»). Греп её не покрывал,
    // поэтому 12.09 фикс сочли полным, а 13.09 первая же активация agentrouter снова
    // положила `/model agentrouter` в 400. Значит нужен прогон самой функции.
    //
    // `transparent-proxy.js` целиком не поднять (23,5 тыс. строк, поднимет серверы), поэтому
    // вырезаем блок писателя и исполняем его в песочнице с поддельными зависимостями —
    // тем же приёмом, что check-1m.js (см. там же 🪤 про внешние константы).
    check('ветка extra не обедняет запись: modelmap выводится из CC_MODEL_PREFIX', () => {
        const tblSrc = tpSrc.match(/const CC_MODEL_PREFIX = \{[\s\S]*?\n\};/);
        const fnSrc = tpSrc.match(/function writeBackendsRegistry\(extra\) \{[\s\S]*?\n\}\n/);
        assert.ok(tblSrc && fnSrc, 'блок writeBackendsRegistry/CC_MODEL_PREFIX не найден — тест устарел');

        const regOut = path.join(TMP, 'writer-out.json');
        const sandbox = `
            ${tblSrc[0]}
            const fs = require('fs');
            const BACKENDS_REGISTRY_FILE = ${JSON.stringify(regOut)};
            // Локальный шлюз с префиксом — ровно случай agentrouter.
            const BACKENDS = { agentrouter: { base_url: 'http://localhost:20133', label: 'AgentRouter (opus-5 1M)' } };
            const BACKEND_ALIASES = { ar: 'agentrouter' };
            const isLocalBase = (u) => /^https?:\\/\\/(127\\.|localhost|\\[::1\\])/i.test(String(u || ''));
            const logLine = () => {};
            function registrySeedEntry(name, base, label) {
                if (!base) return null;
                const p = CC_MODEL_PREFIX[name] || null;
                if (isLocalBase(base)) return { upstream: base, keyFile: null, modelmap: p ? p + '-modelmap.json' : null, label, source: 'backends' };
                return null;
            }
            ${fnSrc[0]}
            // Активация локального шлюза: ключа и карты она не знает — как в проде.
            writeBackendsRegistry({ backend: 'agentrouter', upstream: 'http://localhost:20133', keyFile: null, modelmap: null });
        `;
        require('child_process').execFileSync(process.execPath, ['-e', sandbox], { stdio: 'pipe' });
        const out = JSON.parse(fs.readFileSync(regOut, 'utf8'));
        const e = out.providers.agentrouter;
        assert.ok(e, 'запись agentrouter не создана');
        assert.strictEqual(e.modelmap, 'ar-modelmap.json',
            `активация снова обеднила карту (modelmap=${JSON.stringify(e.modelmap)}) → /model agentrouter вернёт 400`);
        assert.strictEqual(e.label, 'AgentRouter (opus-5 1M)',
            `активация затёрла человеческий label: ${JSON.stringify(e.label)}`);
        assert.strictEqual(out.aliases.ar, 'agentrouter', 'алиас ar потерян');
    });

    // ── Итог ─────────────────────────────────────────────────────────────────
    for (const n of ok) console.log(`  ok   ${n}`);
    for (const f of fails) console.log(`  FAIL ${f}`);
    if (fails.length) {
        console.log(`\n[FAIL] ${fails.length} из ${ok.length + fails.length}`);
        process.exit(1);
    }
    console.log(`\n[OK] имя без модели и две тир-карты работают (${ok.length} проверок)`);
    process.exit(0);
})().catch((e) => { console.error('тест упал:', e); process.exit(1); });
