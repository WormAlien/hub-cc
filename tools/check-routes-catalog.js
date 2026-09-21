#!/usr/bin/env node
'use strict';
// Каталог моделей для вкладки «Маршруты»: цепочка источников и фильтр.
//
// Что доказываем и почему именно это:
//  1. Отвечает ПЕРВЫЙ ответивший источник, и порядок именно такой: живой ключ → ключ
//     аккаунта из пула → каталог панели `/api/pricing` → снимок с диска. Проверяем не
//     «цепочка есть», а что каждая ступень действительно спасает свой случай: у odyssey
//     ключи в пуле без активации, у aikeysapi панельный каталог свежее снимка, у gorouter
//     и tabi шлюз живьём не отвечает, а снимок есть.
//  2. В списке ТОЛЬКО текстовые модели. Картинка целью тира — упавший запрос.
//     🪤 Тут же закреплён баг, из-за которого пустой `supported_endpoint_types` читался
//     как «медиа»: у odyssey он пуст у всех одиннадцати, и старый фильтр выбрасывал
//     каталог целиком — вкладка показывала одну строку вместо одиннадцати.
//  3. Снимок берётся по хосту шлюза и не путает разные домены.
//  4. Цепочка живёт В ОДНОМ месте. Клиентская копия (ROUTES_EP_OF / routesCatalogFromAccounts)
//     с серверной разошлась и врала — проверка не даёт ей вернуться.
//  5. 🪤 Песочница обязана быть ДЕТЕРМИНИРОВАННОЙ: `os.homedir()` подделывается на
//     временный каталог. До 21.09 она читала живой `~/.claude/odyssey-active-key.txt`,
//     живая ветка съедала пул аккаунтов, и проверка падала от наличия файла на машине,
//     а не от кода.
//
// Сети не касается: фикстуры, поддельный `fetch` и чтение файлов, которые и так лежат на диске.

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
                      // 🪤 Семьи, которые медиа в имени не признают (снимок aikeysapi,
                      // живой каталог budsin).
                      'omni_flash_10s', 'omni_flash_abra_edit',
                      'nano-banana-2', 'crax-gpt/krea-2-medium', 'seedream-5']) {
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

// ── 4. Каталог панели (`/api/pricing`) ───────────────────────────────────────
check('pricing: понимает обе формы `data` и режет медиа', () => {
    const asList = lib.pricingModels({ data: [
        { model_name: 'claude-opus-5', supported_endpoint_types: ['anthropic'] },
        { model_name: 'gpt-image-2', supported_endpoint_types: ['openai'] },
        { model_name: 'omni_flash_10s', supported_endpoint_types: ['openai-video'] },
        { id: 'claude-sonnet-5' },
        { model_name: 'claude-opus-5' },
    ] });
    assert.deepStrictEqual(asList, ['claude-opus-5', 'claude-sonnet-5'], `получилось ${JSON.stringify(asList)}`);
    // 🪤 Вторая форма: `data` - карта групп, как у aikeysapi (`auto_groups`).
    const asGroups = lib.pricingModels({ data: {
        'Claude-Opus-系列': [{ model_name: 'claude-opus-4-8' }, { model_name: 'claude-opus-5' }],
        '视频生成组': [{ model_name: 'grok-imagine-video-1.5', supported_endpoint_types: ['openai-video'] }],
        'gpt-image-2': [{ model_name: 'gpt-image-2' }],
    } });
    assert.deepStrictEqual(asGroups, ['claude-opus-4-8', 'claude-opus-5'], `получилось ${JSON.stringify(asGroups)}`);
});

check('pricing: битый ответ и пустота дают пустой список, а не падение', () => {
    for (const bad of [null, undefined, {}, { data: null }, { data: [] }, { data: 'нет' }, { data: [null, 7] }]) {
        assert.deepStrictEqual(lib.pricingModels(bad), [], `упало на ${JSON.stringify(bad)}`);
    }
});

// ── 5. Цепочка и её единственное место ───────────────────────────────────────
check('обработчик ведёт цепочку: живой ключ → пул → панель → снимок', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routing', 'transparent-proxy.js'), 'utf8');
    const head = src.indexOf('function handleRoutesModels(');
    assert.ok(head > 0, 'handleRoutesModels не найдена');
    const body = src.slice(head, src.indexOf('\nfunction handleRoutes', head));
    assert.ok(/activeKey/.test(body), 'живой ключ не участвует');
    assert.ok(/pickAccountKey/.test(body), 'ключа аккаунта из пула нет');
    assert.ok(/fromPricing/.test(body), 'каталога панели нет');
    assert.ok(/fromSnapshot/.test(body), 'снимка каталога нет');
    // 🪤 Порядок несущий: панель обязана спрашиваться ДО снимка, иначе месячная давность
    // снова выиграет у живого каталога.
    assert.ok(body.indexOf('fromPricing') < body.indexOf('const fromSnapshot'),
        'ступень панели стоит после снимка: свежее опять проиграет старому');
    assert.ok(/routesCatalogLib\.pricingFor/.test(body), 'панель спрашивается не через модуль');
    assert.ok(/routesCatalogLib\.textOnly/.test(body), 'фильтр медиа на пути каталога не применяется');
    assert.ok(/\/__switch\/api\/\$\{ep\}\/sessions/.test(body), 'пул аккаунтов спрашивается не той ручкой');
});

check('клиентской копии цепочки больше нет', () => {
    const html = fs.readFileSync(path.join(ROOT, 'routing', 'proxy-dashboard.html'), 'utf8');
    assert.ok(!/routesCatalogFromAccounts/.test(html), 'клиентский фолбэк вернулся — две реализации разойдутся');
    assert.ok(!/ROUTES_EP_OF/.test(html), 'клиентская карта эндпоинтов вернулась');
    assert.ok(/routesRefreshHints/.test(html), 'несвежесть списка и неподтверждённая цель на вкладке не помечаются');
});

// ── 6. Что вкладка показывает в селекте ──────────────────────────────────────
const htmlSrc = fs.readFileSync(path.join(ROOT, 'routing', 'proxy-dashboard.html'), 'utf8');
const bodyOf = (src, head) => {
    const at = src.indexOf(head);
    assert.ok(at > 0, `${head} не найдена`);
    let i = src.indexOf('{', at), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`не найден конец ${head}`);
};

check('селект тира собирается ТОЛЬКО из подтверждённого каталога', () => {
    const body = bodyOf(htmlSrc, 'function routesOptions');
    // 🪤 До 21.09 сюда подмешивались значения карты ШЛЮЗА (`gatewayTiers`), и владелец видел
    // в списке модели, которых шлюз не отдаёт: hcnsec - `kimi-k3` и `step-explore`, justwoker
    // - три `gpt-5.6-*`, agentrouter - `glm-5.3`. Карта маршрутов правится ТУТ ЖЕ, поэтому
    // её собственные значения в опции тоже не идут.
    assert.ok(!/gatewayTiers/.test(body), 'в опции вернулись значения карты шлюза');
    assert.ok(!/routesProviders\[/.test(body), 'опции снова берутся из карт, а не из каталога');
    assert.ok(/routesCatalog\[name\]/.test(body), 'каталог в опциях не участвует');
    assert.ok(/— как есть —/.test(body), 'нет пустой опции «как есть»');
});

check('неподтверждённая цель тира помечена, а не показана как выбор', () => {
    // Значение карты, которого нет в каталоге, из СПИСКА уходит (решение владельца 21.09),
    // но строка обязана сказать, что цель стоит, иначе селект молча врёт «как есть»,
    // а запрос на самом деле уедет на несуществующую модель.
    assert.ok(/routesUnconfirmed|rt-unconf/.test(htmlSrc), 'пометки неподтверждённой цели нет');
    assert.ok(/dataset\.prev/.test(bodyOf(htmlSrc, 'async function routesLoadCatalogs')),
        'перерисовка после загрузки каталога берёт значение из селекта, а не из карты - выбор потеряется');
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

function runHandler(provider, answer, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
        const asked = [];
        const http = {
            get(url, opts2, cb) {
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
        // 🪤 Панель спрашивается тем же `fetch`, что и в бою. В песочнице он поддельный:
        // проба сети не касается, а без подмены здесь пошёл бы настоящий запрос.
        const askedFetch = [];
        const fetchFake = async (url) => {
            askedFetch.push(url);
            const body = o.fetchAnswer ? o.fetchAnswer(url) : undefined;
            if (body === undefined) throw new Error('сеть молчит');
            return { ok: true, json: async () => body };
        };
        // 🪤 `os` подделываем на временный каталог: с живым `homedir()` обработчик находит
        // настоящий файл активного ключа, уходит в живую ветку и пул аккаунтов не спрашивает.
        const osFake = { homedir: () => path.join(TMP, 'home') };
        const res = {};
        const factory = new Function('ROUTE_EP', 'CC_MODEL_PREFIX', 'MONEY_GW', 'LISTEN_PORT',
            'jsonRes', 'routesCatalogLib', 'fs', 'path', 'os', 'http', 'fetch',
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
            moneyGw, 8200, (r, code, obj) => { r.captured = obj; }, lib, fs, path, osFake, http, fetchFake);
        const req = { url: `/__switch/api/routes/models?provider=${provider}`, headers: { host: '127.0.0.1:8200' } };
        handler(req, res);
        setTimeout(() => resolve({ out: res.captured, asked, askedFetch }), 200);
    });
}

(async () => {
    const sandbox = async (name, fn) => {
        try { await fn(); console.log(`PASS  ${name}`); }
        catch (e) { failures.push(name); console.log(`FAIL  ${name}  ← ${e.message}`); }
    };

    await sandbox('pricing: спрашивает `/api/pricing` хоста и берёт модели из ответа', async () => {
        const asked = [];
        const fake = async (url) => {
            asked.push(url);
            return { ok: true, json: async () => ({ data: [
                { model_name: 'claude-opus-5' }, { model_name: 'gpt-image-2' }, { model_name: 'claude-opus-4-8' },
            ] }) };
        };
        const p = await lib.pricingFor('panel-check-1.example', { fetch: fake, ttlMs: 0 });
        assert.deepStrictEqual(p && p.models, ['claude-opus-5', 'claude-opus-4-8'],
            `получилось ${JSON.stringify(p && p.models)}`);
        assert.strictEqual(asked[0], 'https://panel-check-1.example/api/pricing', `спросил ${asked[0]}`);
        assert.strictEqual(p.cached, false);
    });

    await sandbox('pricing: отказ, обрыв, пустой каталог и пустой хост дают null', async () => {
        const no = async () => ({ ok: false, status: 401, json: async () => ({}) });
        assert.strictEqual(await lib.pricingFor('panel-check-2.example', { fetch: no, ttlMs: 0 }), null,
            'HTTP 401 не превратился в «источника нет»');
        const boom = async () => { throw new Error('сеть'); };
        assert.strictEqual(await lib.pricingFor('panel-check-3.example', { fetch: boom, ttlMs: 0 }), null,
            'обрыв не превратился в «источника нет»');
        const empty = async () => ({ ok: true, json: async () => ({ data: [] }) });
        assert.strictEqual(await lib.pricingFor('panel-check-4.example', { fetch: empty, ttlMs: 0 }), null,
            'пустой каталог отдан как источник');
        assert.strictEqual(await lib.pricingFor('', { fetch: empty, ttlMs: 0 }), null, 'пустой хост не отсеян');
    });

    await sandbox('pricing: второй заход берётся из кеша, а не из сети', async () => {
        let calls = 0;
        const fake = async () => { calls++; return { ok: true, json: async () => ({ data: [{ model_name: 'claude-opus-5' }] }) }; };
        await lib.pricingFor('panel-check-5.example', { fetch: fake });
        const p = await lib.pricingFor('panel-check-5.example', { fetch: fake });
        assert.strictEqual(calls, 1, `сходил в панель ${calls} раз вместо одного`);
        assert.ok(p && p.cached, 'кеш не отмечен флагом');
    });

    await sandbox('обработчик: активного ключа нет → спрашивает пул аккаунтов', async () => {
        const { out, asked, askedFetch } = await runHandler('odyssey', (url) => {
            if (url.includes('/od/sessions')) return { sessions: [{ api_key: 'k1', status: 'unknown' }] };
            if (url.includes('/od/models')) return { models: [{ id: 'anthropic/claude-sonnet-4-6' }, { id: 'openai/gpt-image-2' }] };
            return {};
        });
        assert.ok(asked.some(u => u.includes('/od/sessions')), `пул аккаунтов не спрошен: ${asked.join(' ')}`);
        assert.ok(asked.some(u => u.includes('api_key=k1')), 'ключ из пула не доехал до каталога');
        assert.strictEqual(out && out.source, 'accounts', `источник ${out && out.source}`);
        assert.deepStrictEqual(out.models, ['anthropic/claude-sonnet-4-6'], 'медиа не отсеяно на пути вкладки');
        // 🪤 Живой ключ сильнее панельного каталога: спросили - значит ступень панели
        // перебивала точный ответ и могла принести модель чужой группы.
        assert.deepStrictEqual(askedFetch, [], `панель спрошена зря: ${askedFetch.join(' ')}`);
    });

    await sandbox('обработчик: пул пуст → каталог панели', async () => {
        const { out, askedFetch } = await runHandler('nova', () => ({ sessions: [] }), {
            fetchAnswer: () => ({ data: [
                { model_name: 'claude-opus-5', supported_endpoint_types: ['anthropic'] },
                { model_name: 'nano-banana-2', supported_endpoint_types: ['openai'] },
            ] }),
        });
        assert.ok(askedFetch.some(u => u === 'https://nova.vcrauo.com/api/pricing'),
            `панель спрошена не по адресу: ${askedFetch.join(' ')}`);
        assert.strictEqual(out && out.source, 'pricing', `источник ${out && out.source}`);
        assert.deepStrictEqual(out.models, ['claude-opus-5'], 'медиа панели не отсеяно');
        assert.strictEqual(out.staleDays, 0, 'свежесть панельного каталога не отдана вкладке');
    });

    await sandbox('обработчик: панель молчит → снимок с диска', async () => {
        const { out, askedFetch } = await runHandler('tabi', () => ({ sessions: [] }));
        assert.ok(askedFetch.length, 'панель не спрошена вовсе');
        assert.strictEqual(out && out.source, 'snapshot', `источник ${out && out.source}`);
        assert.ok(out.models.length > 0, 'снимок пуст');
        assert.ok(out.staleDays > 0, 'несвежесть снимка не отдана вкладке');
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
