#!/usr/bin/env node
'use strict';
// Каталог моделей для вкладки «Маршруты»: цепочка источников и фильтр.
//
// Что доказываем и почему именно это:
//  1. Отвечает ПЕРВЫЙ ответивший источник, и порядок именно такой: живой ключ → ключ
//     аккаунта из пула → снимок с диска. Проверяем не «цепочка есть», а что каждая
//     ступень действительно спасает свой случай: у odyssey ключи в пуле без активации,
//     у gorouter и tabi шлюз живьём не отвечает, а снимок есть.
//  2. В списке ТОЛЬКО текстовые модели. Картинка целью тира — упавший запрос.
//     🪤 Тут же закреплён баг, из-за которого пустой `supported_endpoint_types` читался
//     как «медиа»: у odyssey он пуст у всех одиннадцати, и старый фильтр выбрасывал
//     каталог целиком — вкладка показывала одну строку вместо одиннадцати.
//  3. Снимок берётся по хосту шлюза и не путает разные домены.
//  4. Цепочка живёт В ОДНОМ месте. Клиентская копия (ROUTES_EP_OF / routesCatalogFromAccounts)
//     с серверной разошлась и врала — проверка не даёт ей вернуться.
//
// Сети не касается: фикстуры плюс чтение файлов, которые и так лежат на диске.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'routing', 'lib', 'routes-catalog.js'));

const failures = [];
const check = (name, fn) => {
    try { fn(); console.log(`PASS  ${name}`); }
    catch (e) { failures.push(name); console.log(`FAIL  ${name}  ← ${e.message}`); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rcat-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { } });

// ── 1. Фильтр медиа ──────────────────────────────────────────────────────────
check('картинки, видео и эмбеддинги отсеяны по имени', () => {
    for (const id of ['openai/gpt-image-2', 'openai/gpt-image-2.5-flare', 'x/flux-1',
                      'some/video-gen-2', 'qwen3-embedding-8b', 'openai/whisper-1',
                      // 🪤 Семьи, которые медиа в имени не признают (снимок aikeysapi).
                      'omni_flash_10s', 'omni_flash_abra_edit']) {
        assert.ok(!lib.isTextModel(id), `${id} прошёл как текстовая модель`);
    }
});

check('текстовые модели проходят, включая чужие префиксы и `flash`', () => {
    for (const id of ['anthropic/claude-sonnet-4-6', 'deepseek/deepseek-v4.1-flash',
                      'xai/grok-4.6', 'claude-haiku-4-5-20251001', 'openai/gpt-5.6-terra',
                      'auto', 'step-router-v1']) {
        assert.ok(lib.isTextModel(id), `${id} выброшен как медиа`);
    }
});

check('пустой список типов — это «нет данных», а не «медиа»', () => {
    // 🪤 Ровно на этом падал odyssey: `supported_endpoint_types: []` у всех моделей.
    assert.ok(lib.isTextModel('anthropic/claude-sonnet-4-6', []), 'пустой список типов выбросил модель');
    assert.ok(lib.isTextModel('anthropic/claude-sonnet-4-6', undefined), 'отсутствие поля выбросило модель');
    assert.ok(!lib.isTextModel('vision-model', ['openai-video']), 'тип с video не отсеян');
});

check('`textOnly` дедуплицирует и понимает обе формы ответа', () => {
    const out = lib.textOnly(['a', { id: 'b' }, 'a', { id: 'x-image-1' }, '', null, { id: 'c' }]);
    assert.deepStrictEqual(out, ['a', 'b', 'c'], `получилось ${JSON.stringify(out)}`);
});

// ── 2. Ступени выбора ключа ──────────────────────────────────────────────────
check('ключ аккаунта: активный вперёд, живой следом', () => {
    const l = [{ api_key: 'k1', status: 'dead' }, { api_key: 'k2', status: 'live' }, { api_key: 'k3' }];
    assert.strictEqual(lib.pickAccountKey(l), 'k2', 'живой ключ не выбран, когда активного нет');
    assert.strictEqual(lib.pickAccountKey([{ api_key: 'k1', active: true, status: 'dead' }]), 'k1');
});

check('ключ аккаунта: третья ступень берёт ЛЮБОЙ с ключом', () => {
    // 🪤 Случай odyssey: все четыре аккаунта `unknown`/`dead`, ни один не активирован.
    // На первых двух ступенях пул отдавал пустоту, хотя каталог по этим ключам приходит.
    const odyssey = [{ api_key: 'k1', status: 'dead' }, { api_key: 'k2', status: 'unknown' }];
    assert.strictEqual(lib.pickAccountKey(odyssey), 'k1', 'пул без активного и живого остался без ключа');
});

check('ключ аккаунта: пустой пул и записи без ключа дают пусто', () => {
    assert.strictEqual(lib.pickAccountKey([]), '');
    assert.strictEqual(lib.pickAccountKey([{ status: 'live' }, { api_key: '   ' }]), '');
    assert.strictEqual(lib.pickAccountKey(null), '');
});

// ── 3. Снимок каталога ───────────────────────────────────────────────────────
const CACHE = path.join(TMP, 'cache.json');
fs.writeFileSync(CACHE, JSON.stringify({
    'https://gorouter.app/v1': { ts: Date.parse('2026-08-12T22:31:57Z'),
        data: [{ id: 'claude-opus-5-thinking' }, { id: 'gpt-image-2' }, { id: 'kimi-k3' }] },
    'https://api.rumeng-ai.com/v1': { ts: Date.parse('2026-09-13T00:00:00Z'),
        data: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-luna' }] },
    'https://www.aikeysapi.com/v1': { ts: Date.parse('2026-09-13T00:00:00Z'),
        data: [{ id: 'gpt-5.6-terra' }, { id: 'grok-imagine-video-1.5' }] },
    'https://emtf.aipm9527.xyz/v1': { ts: 0, data: [{ id: 'claude-opus-4-6' }] },
}));

check('снимок берётся по хосту и режет медиа', () => {
    const s = lib.snapshotFor('gorouter.app', { cacheFile: CACHE });
    assert.ok(s, 'снимок gorouter не найден');
    assert.deepStrictEqual(s.models, ['claude-opus-5-thinking', 'kimi-k3'], `получилось ${JSON.stringify(s && s.models)}`);
    assert.strictEqual(s.staleDays, Math.floor((Date.now() - Date.parse('2026-08-12T22:31:57Z')) / 86400000));
});

check('снимок находит поддомен, но не путает разные домены', () => {
    assert.ok(lib.snapshotFor('aikeysapi.com', { cacheFile: CACHE }), 'поддомен www не найден по корневому хосту');
    assert.strictEqual(lib.snapshotFor('aipm9527.online', { cacheFile: CACHE }), null,
        'хост aipm9527.online совпал со снимком aipm9527.xyz — это разные шлюзы');
    assert.strictEqual(lib.snapshotFor('', { cacheFile: CACHE }), null);
});

check('пустой или битый снимок не роняет, а даёт null', () => {
    const bad = path.join(TMP, 'bad.json');
    fs.writeFileSync(bad, '{ это не json');
    assert.strictEqual(lib.snapshotFor('gorouter.app', { cacheFile: bad }), null);
    assert.strictEqual(lib.snapshotFor('gorouter.app', { cacheFile: path.join(TMP, 'нет-такого.json') }), null);
});

// ── 4. Цепочка и её единственное место ───────────────────────────────────────
check('обработчик ведёт цепочку: живой ключ → пул → снимок', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
    const head = src.indexOf('function handleRoutesModels(');
    assert.ok(head > 0, 'handleRoutesModels не найдена');
    const body = src.slice(head, src.indexOf('\nfunction handleRoutes', head));
    assert.ok(/activeKey/.test(body), 'живой ключ не участвует');
    assert.ok(/pickAccountKey/.test(body), 'ключа аккаунта из пула нет');
    assert.ok(/fromSnapshot/.test(body), 'снимка каталога нет');
    assert.ok(/routesCatalogLib\.textOnly/.test(body), 'фильтр медиа на пути каталога не применяется');
    assert.ok(/\/__switch\/api\/\$\{ep\}\/sessions/.test(body), 'пул аккаунтов спрашивается не той ручкой');
});

check('клиентской копии цепочки больше нет', () => {
    const html = fs.readFileSync(path.join(ROOT, 'routing', 'proxy-dashboard.html'), 'utf8');
    assert.ok(!/routesCatalogFromAccounts/.test(html), 'клиентский фолбэк вернулся — две реализации разойдутся');
    assert.ok(!/ROUTES_EP_OF/.test(html), 'клиентская карта эндпоинтов вернулась');
    assert.ok(/routesMarkCatalogSource/.test(html), 'несвежесть списка на вкладке не помечается');
});

// ── 5. Реальные файлы на диске (только чтение) ───────────────────────────────
check('на боевом снимке шлюзы, которые молчат живьём, дают непустой список', () => {
    const hosts = ['gorouter.app', 'tabitoken.com', 'api.rumeng-ai.com'];
    const missing = hosts.filter(h => !lib.snapshotFor(h));
    assert.ok(!missing.length, `нет снимка для: ${missing.join(', ')}`);
});

// ── 6. Клей обработчика: песочница с поддельным `http` ───────────────────────
// Логика модуля проверена выше, но между ней и вкладкой лежит сам `handleRoutesModels`.
// Здесь он исполняется целиком, с поддельной сетью: видно, КАКУЮ ручку он спрашивает,
// что отвечает вкладке и не ходит ли на диск/в апстрим мимо.
const SRC_TP = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
const extractFn = (name) => {
    const head = SRC_TP.indexOf(`function ${name}(`);
    assert.ok(head > 0, `${name} не найдена в transparent-proxy.js`);
    const end = SRC_TP.indexOf('\n}\n', head);
    assert.ok(end > head, `не найден конец ${name}`);
    return SRC_TP.slice(head, end + 2);
};

function runHandler(provider, answer) {
    return new Promise((resolve) => {
        const asked = [];
        const http = {
            get(url, opts, cb) {
                asked.push(url);
                const rq = { on() { return rq; }, destroy() { } };
                const body = answer(url);
                setImmediate(() => {
                    if (body === undefined) {
                        const errs = rq._errs || [];
                        errs.forEach(fn => fn(new Error('сеть недоступна')));
                        return;
                    }
                    const r = {
                        on(ev, fn) {
                            if (ev === 'data') this._data = fn;
                            if (ev === 'end') { this._data(Buffer.from(JSON.stringify(body))); fn(); }
                            return r;
                        },
                    };
                    cb(r);
                });
                // `error` обработчик навешивают ПОСЛЕ возврата из get — держим список.
                const origOn = rq.on;
                rq.on = (ev, fn) => { if (ev === 'error') (rq._errs = rq._errs || []).push(fn); return origOn.call(rq, ev, fn); };
                return rq;
            },
        };
        const res = {};
        const factory = new Function('ROUTE_EP', 'CC_MODEL_PREFIX', 'MONEY_GW', 'LISTEN_PORT',
            'jsonRes', 'routesCatalogLib', 'fs', 'path', 'os', 'http',
            `${extractFn('handleRoutesModels')}; return handleRoutesModels;`);
        const parsePairs = (block) => {
            const out = {};
            const re = /(\w+):\s*'([^']+)'/g;
            let m;
            while ((m = re.exec(block))) out[m[1]] = m[2];
            return out;
        };
        const blockOf = (name) => {
            const at = SRC_TP.indexOf(`const ${name} = {`);
            return SRC_TP.slice(at, SRC_TP.indexOf('\n};', at));
        };
        // 🪤 Форма та же, что в бою: `MONEY_GW` — это `{ короткий_тег: { tag, host } }`,
        // а обработчик ищет хост по `tag`. Плоская карта `tag → host` дала бы «источника
        // нет» на живой ветке снимка, и проба упала бы на исправном коде.
        const moneyGw = {};
        for (const m of blockOf('MONEY_GW').matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
            const tag = /tag:\s*'([^']+)'/.exec(m[2]);
            const host = /host:\s*'([^']+)'/.exec(m[2]);
            if (tag && host) moneyGw[m[1]] = { tag: tag[1], host: host[1] };
        }
        const handler = factory(parsePairs(blockOf('ROUTE_EP')), parsePairs(blockOf('CC_MODEL_PREFIX')),
            moneyGw, 8200, (r, code, obj) => { r.captured = obj; }, lib, fs, path, os, http);
        const req = { url: `/__switch/api/routes/models?provider=${provider}`, headers: { host: '127.0.0.1:8200' } };
        handler(req, res);
        setTimeout(() => resolve({ out: res.captured, asked }), 120);
    });
}

(async () => {
    const sandbox = async (name, fn) => {
        try { await fn(); console.log(`PASS  ${name}`); }
        catch (e) { failures.push(name); console.log(`FAIL  ${name}  ← ${e.message}`); }
    };

    await sandbox('обработчик: активного ключа нет → спрашивает пул аккаунтов', async () => {
        const { out, asked } = await runHandler('odyssey', (url) => {
            if (url.includes('/od/sessions')) return { sessions: [{ api_key: 'k1', status: 'unknown' }] };
            if (url.includes('/od/models')) return { models: [{ id: 'anthropic/claude-sonnet-4-6' }, { id: 'openai/gpt-image-2' }] };
            return {};
        });
        assert.ok(asked.some(u => u.includes('/od/sessions')), `пул аккаунтов не спрошен: ${asked.join(' ')}`);
        assert.ok(asked.some(u => u.includes('api_key=k1')), 'ключ из пула не доехал до каталога');
        assert.strictEqual(out && out.source, 'accounts', `источник ${out && out.source}`);
        assert.deepStrictEqual(out.models, ['anthropic/claude-sonnet-4-6'], 'медиа не отсеяно на пути вкладки');
    });

    await sandbox('обработчик: живого нет и пул пуст → снимок с диска', async () => {
        const { out } = await runHandler('gorouter', (url) => {
            if (url.includes('/go/sessions')) return { sessions: [] };
            return undefined;                                    // сеть молчит
        });
        assert.strictEqual(out && out.source, 'snapshot', `источник ${out && out.source}`);
        assert.ok(out.models.length > 0, 'снимок пуст');
        assert.ok(out.staleDays > 0, 'несвежесть снимка не отдана вкладке');
    });

    await sandbox('обработчик: нет источника — честный ноль, а не выдумка', async () => {
        const { out } = await runHandler('justwoker', () => undefined);
        assert.deepStrictEqual(out.models, [], 'выдал список без источника');
        assert.strictEqual(out.source, 'none');
        assert.ok(/снимк/.test(out.note || ''), `note не объясняет причину: ${out.note}`);
    });

    console.log(failures.length
        ? `\n[FAIL] провалено ${failures.length}: ${failures.join('; ')}`
        : '\n[OK] цепочка источников держится, медиа отсеяно');
    process.exit(failures.length ? 1 : 0);
})();
