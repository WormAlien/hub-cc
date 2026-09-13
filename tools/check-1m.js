#!/usr/bin/env node
/**
 * check-1m.js — регресс-тест инварианта окна 1M.
 *
 * Инвариант одной строкой: после любой операции дашборда settings.model —
 * непустая строка, и если она claude-(opus|sonnet)-*, в ней есть [1m].
 * Без суффикса Claude Code считает окно 200k и режет историю втрое раньше.
 *
 * Почему файл существует: у записи модели в settings.json раньше не было единой
 * точки входа — 24 прямые записи, суффикс дотягивали 4 места. Каждый агент чинил
 * свой путь, симптом возвращался (см. docs/archive/HANDOFF-model-1m.md).
 *
 * Запуск:  node tools/check-1m.js        (exit 1 = инвариант нарушен)
 * Токены не печатаем: из settings.json берём только поле model.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROXY = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const FRONTDOOR = path.join(__dirname, '..', 'routing', 'frontdoor-proxy.js');
const TRANSPARENT_TEST_API = path.join(os.tmpdir(), 'check-1m-transparent-api.json');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
// Единственная разрешённая прямая запись: восстановление сырого текста из бэкапа
// (JSON.stringify его сломает — там строка, а не объект).
const ALLOWED_DIRECT_WRITE = "fs.writeFileSync(SETTINGS_FILE, raw, 'utf8');";

const fails = [];
const warns = [];
const ok = [];

function needsSuffix(m) {
    return /^claude-(opus|sonnet)-/.test(String(m || '')) && !String(m).includes('[');
}

// ---- 1. Живой settings.json -------------------------------------------------
let src = '';
try {
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    const s = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    const m = s.model;
    if (typeof m !== 'string' || !m.trim()) {
        fails.push('settings.json: поля model нет → Claude Code возьмёт свой дефолт, а он без [1m] = 200k');
    } else if (needsSuffix(m)) {
        fails.push(`settings.json: model = "${m}" без [1m] → окно 200k`);
    } else {
        ok.push(`settings.json: model = "${m}"`);
    }
    const em = s.env && s.env.ANTHROPIC_MODEL;
    if (typeof em === 'string' && needsSuffix(em)) {
        fails.push(`settings.json: env.ANTHROPIC_MODEL = "${em}" без [1m] (перебьёт top-level model)`);
    }
} catch (e) {
    warns.push(`settings.json не прочитан (${e.message}) — проверка живого файла пропущена`);
}

// ---- 2. Прямые записи мимо writeSettings() ---------------------------------
try {
    src = fs.readFileSync(PROXY, 'utf8');
} catch (e) {
    fails.push(`не прочитан ${PROXY}: ${e.message}`);
}

// Хелперы для песочниц ниже. Живут на верхнем уровне, а не внутри `if (src) {}`:
// блоков этих в файле три (63, 223, 355), и переменная из одного другому не видна —
// на этом тест уже спотыкался («fnBody is not defined» при живом коде).

// Таблица префиксов — из ИСХОДНИКА, а не копией: копия разъедется при добавлении шлюза.
const PREFIX_TBL = src ? src.match(/const CC_MODEL_PREFIX = \{[\s\S]*?\n\};/) : null;
const NO1M_DECL = src ? src.match(/const NO_1M_GATEWAYS = [^\n]*;\n/) : null;

// Тело функции по началу объявления.
// 🪤 Границу по `\n\}` брать НЕЛЬЗЯ: внутри есть строки, заканчивающиеся на `}` (закрытие
// if, return с replace), и регексп обрывался на первой такой — «функция не найдена» при
// живом коде. Идём до `}` в нулевой колонке: так закрывается сама функция.
const fnBody = (re) => {
    if (!src) return null;
    const m = src.match(re);
    if (!m) return null;
    const end = src.indexOf('\n}', m.index);
    return end < 0 ? null : src.slice(m.index, end + 2);
};
// Сигнатура `(m, activeBackend)` — второй параметр сохраняется для выбора активного
// шлюза; тест принимает обе формы, иначе валится на «функция не найдена».
const NORM_FN = fnBody(/function normalizeCcModel\(m/);
if (src) {
    // Таблица префиксов нужна трём разным песочницам ниже (normalize, cunResolveTiers,
    // серверная копия для сверки с фронтом), поэтому достаём её один раз здесь.
    // Берём ИЗ ИСХОДНИКА, а не копией в тесте: копия разъедется при добавлении шлюза.
    const prefixTbl = PREFIX_TBL;
    const no1mDecl = NO1M_DECL;
    src.split('\n').forEach((line, i) => {
        if (!line.includes('writeFileSync(SETTINGS_FILE')) return;
        if (line.trim() === ALLOWED_DIRECT_WRITE) return;
        fails.push(`transparent-proxy.js:${i + 1}: settings.json пишется напрямую, мимо writeSettings() → суффикс [1m] не дотянется\n    ${line.trim()}`);
    });

    // ---- 3. Чокпоинт на месте ---------------------------------------------
    const ws = src.match(/function writeSettings\(obj\) \{[\s\S]*?\n\}/);
    if (!ws) fails.push('transparent-proxy.js: функция writeSettings(obj) не найдена');
    else {
        if (!/obj\.model\s*=\s*normalizeCcModel\(/.test(ws[0])) {
            fails.push('writeSettings(): нет нормализации obj.model через normalizeCcModel() — чокпоинт разобран');
        }
        if (!/ANTHROPIC_MODEL\s*=\s*normalizeCcModel\(/.test(ws[0])) {
            fails.push('writeSettings(): нет нормализации env.ANTHROPIC_MODEL (cun/conduit пишут его рядом с model)');
        }
    }

    // ---- 4. Сам нормализатор: гоняем боевой код, не копию ------------------
    // 🪤 Функцию вырезаем регуляркой, поэтому всё, на что она ссылается, обязано
    // попасть в песочницу вместе с ней: `NO_1M_GATEWAYS` лежит рядом в исходнике,
    // `CC_MODEL_PREFIX` — выше по файлу (у реестра), поэтому подставляем его сами.
    // 🪤 Границу функции по `\n\}` брать НЕЛЬЗЯ: внутри есть строки, заканчивающиеся на `}`,
    // и регексп обрывался на первой такой — «функция не найдена» при живом коде. fnBody
    // объявлена выше (на верхнем уровне блока) и берёт до `}` в нулевой колонке.
    const normFn = fnBody(/function normalizeCcModel\(m/);
    const fn = (normFn && no1mDecl) ? [null, no1mDecl[0], normFn] : null;
    if (!fn) fails.push('transparent-proxy.js: функция normalizeCcModel(m) не найдена');
    else if (!prefixTbl) fails.push('transparent-proxy.js: таблица CC_MODEL_PREFIX не найдена');
    else {
        let normalize;
        try {
            normalize = new Function(`${prefixTbl[0]}\n${fn[1]}${fn[2]}; return normalizeCcModel;`)();
        } catch (e) {
            fails.push(`normalizeCcModel не исполняется: ${e.message}`);
        }
        if (normalize) {
            const cases = [
                ['claude-opus-5', 'claude-opus-5[1m]'],
                ['claude-sonnet-5', 'claude-sonnet-5[1m]'],
                ['claude-opus-5[1m]', 'claude-opus-5[1m]'],   // идемпотентность
                ['claude-opus-4-8[200k]', 'claude-opus-4-8[200k]'],   // чужой суффикс не трогаем
                ['ComboWombo', 'ComboWombo'],                 // виртуальная модель шлюза
                ['opus-4.8', 'opus-4.8'],                     // notion: не claude-*
                ['opus[1m]', 'opus[1m]'],
                ['gpt-5.6-sol', 'gpt-5.6-sol[1m]'],
                ['gpt-5.6-luna', 'gpt-5.6-luna[1m]'],
                ['gpt-5.6-terra', 'gpt-5.6-terra[1m]'],
                ['gpt-5.6-sol[1m]', 'gpt-5.6-sol[1m]'],
                ['glm-5.3', 'glm-5.3[1m]'],                   // 04.09: glm-5.3 — окно 1M
                ['glm-5.3[1m]', 'glm-5.3[1m]'],               // идемпотентность
                ['glm-5.2', 'glm-5.2'],                       // старые glm — окно не заявлено
                ['claude-haiku-4-5', 'claude-haiku-4-5'],     // у haiku 200k штатно
                // Голое имя шлюза (12.09): `/model agentrouter` — модель берёт routes-карта,
                // а окно клиента обязано быть 1M. До правки суффикс не вешался, и сессия
                // молча ехала на 200k — заявка владельца «выдаётся модель без 1m».
                ['agentrouter', 'agentrouter[1m]'],
                ['tabi', 'tabi[1m]'],
                // AIKeysAPI и rumeng — новые вкладки с `[1m]`, включая префиксные модели.
                ['aikeysapi', 'aikeysapi[1m]'],
                ['ak', 'ak[1m]'],
                ['aikeysapi/gpt-5.6-sol', 'aikeysapi/gpt-5.6-sol[1m]'],
                // Префиксный роутинг: `/model aipm/claude-opus-4-6` выбирает шлюз именем
                // в модели. Без поддержки префикса якорь ^ не матчился, [1m] не вешался,
                // и окно молча падало до 200k — ровно то, что этот чокпоинт и ловит.
                ['aipm/claude-opus-4-6', 'aipm/claude-opus-4-6[1m]'],
                ['agentrouter/claude-opus-4-8[1m]', 'agentrouter/claude-opus-4-8[1m]'],  // идемпотентность
                ['ar/claude-sonnet-5', 'ar/claude-sonnet-5[1m]'],                        // короткий алиас
                ['aipm/glm-5.3', 'aipm/glm-5.3[1m]'],
                ['aipm/glm-5.2', 'aipm/glm-5.2'],                                        // старые glm — как и без префикса
                ['justwoker/gpt-5.6-sol', 'justwoker/gpt-5.6-sol[1m]'],
                ['aipm/claude-haiku-4-5', 'aipm/claude-haiku-4-5'],                      // haiku 200k штатно
                ['', ''],
                [null, ''],
            ];
            for (const [input, want] of cases) {
                const got = normalize(input);
                if (got !== want) fails.push(`normalizeCcModel(${JSON.stringify(input)}) = ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)}`);
            }
            if (!fails.length) ok.push(`normalizeCcModel: ${cases.length} кейсов`);
        }
    }

    // Cun UI: три выделенных GPT 5.6 должны кликаться и копироваться уже с [1m].
    // Сторожим реальный путь бейджа, а не отдельную копию списка в тесте.
    try {
        const dashboard = fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8');
        // 🪤 Функции фронта вырезаются и исполняются в песочнице, поэтому всё, на что они
        // ссылаются, надо вырезать вместе с ними. С 10.09 регекс `[1m]` вынесен в общую
        // CC_1M_RE — ЗАЧЕМ: три копии (withCtxSuffix, FM_1M_RE, cunNormalizeCcModel)
        // успели разойтись и с сервером, и между собой на 159 именах из 337. Одна
        // константа на весь фронт — единственный способ, которым они больше не разъедутся.
        const shared = dashboard.match(/const CC_1M_RE = [^\n]+/);
        if (!shared) fails.push('proxy-dashboard.html: нет общей CC_1M_RE — копии регекса снова разойдутся с сервером');
        // 🪤 Зависимости withCtxSuffix, объявленные ВНЕ её текста: список исключений и
        // таблица шлюзов с keepalive. Без подстановки функция падает с ReferenceError —
        // тот же случай, что у серверной с CC_MODEL_PREFIX.
        const uiNo1m = dashboard.match(/const NO_1M_GATEWAYS = [^\n]+/);
        const uiKeepTbl = dashboard.match(/const KEEPALIVE_POLL_TABS = \{[\s\S]*?\n\};/);
        if (!uiNo1m) fails.push('proxy-dashboard.html: нет NO_1M_GATEWAYS — исключение AIKeysAPI на кнопках перестанет работать');
        if (!uiKeepTbl) fails.push('proxy-dashboard.html: нет KEEPALIVE_POLL_TABS — withCtxSuffix не узнает шлюзы с безусловной инъекцией [1m]');
        // Копия серверного списка исключений обязана быть БУКВАЛЬНОЙ: разойдутся — и
        // AIKeysAPI начнёт раздавать `[1m]` кнопкой, обходя решение владельца 12.09.
        const srvNo1mDecl = src && src.match(/const NO_1M_GATEWAYS = [^\n]+/);
        if (uiNo1m && srvNo1mDecl && uiNo1m[0].trim() !== srvNo1mDecl[0].trim()) {
            fails.push(`NO_1M_GATEWAYS разошлись: фронт "${uiNo1m[0].trim()}" ≠ сервер "${srvNo1mDecl[0].trim()}"`);
        }
        const preamble = shared ? shared[0] + '\n' : '';
        // Преамбула для withCtxSuffix — с её зависимостями (у cunNormalizeCcModel с 13.09
        // своего правила нет, она делегирует сюда же, поэтому преамбула одна на обе).
        const ctxPreamble = preamble + (uiNo1m ? uiNo1m[0] + '\n' : '') + (uiKeepTbl ? uiKeepTbl[0] + '\n' : '');
        const uiNormalize = dashboard.match(/function cunNormalizeCcModel\(m\) \{[\s\S]*?\n\}/);
        // 🪤 Сигнатура `(id, gw)` — второй аргумент появился 13.09 (вкладка-владелец имени).
        // Шаблон принимает ОБЕ формы: под жёстким `\(id\)` совпадения не стало бы,
        // `ctxSuffix` стал бы null, а сверка с сервером ниже спрятана за `if (ctxSuffix …)` —
        // то есть защита выключилась бы МОЛЧА, при зелёном тесте. Ровно тот класс тихой
        // потери, против которого весь этот файл.
        const ctxSuffix = dashboard.match(/function withCtxSuffix\(id(?:, gw)?\) \{[\s\S]*?\n\}/);
        if (!ctxSuffix) fails.push('proxy-dashboard.html: функция withCtxSuffix(id[, gw]) не найдена — сверка кнопок с сервером не выполнена');
        const chip = dashboard.match(/function cunModelChip\(id, tone\) \{[\s\S]*?\n\}/);
        if (!uiNormalize) {
            fails.push('proxy-dashboard.html: нет cunNormalizeCcModel() для GPT 5.6 бейджей');
        } else {
            const normalizeUi = new Function(`${ctxPreamble}${ctxSuffix ? ctxSuffix[0] : ''}\n${uiNormalize[0]}; return cunNormalizeCcModel;`)();
            for (const id of ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra']) {
                if (normalizeUi(id) !== `${id}[1m]`) fails.push(`cunNormalizeCcModel(${id}) не добавил [1m]`);
            }
            // Клиент обязан совпадать с сервером буквально: вкладка «Маршруты» раздаёт
            // готовые команды `/model <шлюз>/<модель>`, и потерянный здесь суффикс —
            // это молча выданное окно 200k вместо 1M. Серверную функцию вырезаем здесь
            // заново: `normalize` выше объявлен в чужом блоке и сюда не виден.
            // 🪤 NO_1M_GATEWAYS и CC_MODEL_PREFIX объявлены ВНЕ вырезаемого куска,
            // поэтому подставляем их сюда так же, как в блоке normalize выше: серверная
            // функция без них падает с ReferenceError.
            const srvFnSrc = fnBody(/function normalizeCcModel\(m/);
            const srvNo1m = src && src.match(/const NO_1M_GATEWAYS = [^\n]*;\n/);
            const srvNorm = (srvFnSrc && srvNo1m && prefixTbl)
                ? new Function(`${prefixTbl[0]}\n${srvNo1m[0]}${srvFnSrc}; return normalizeCcModel;`)()
                : null;
            if (ctxSuffix && srvNorm) {
                const withCtx = new Function(`${ctxPreamble}${ctxSuffix[0]}; return withCtxSuffix;`)();
                // 1) БЕЗ второго аргумента клиент и сервер обязаны совпадать буквально.
                for (const id of ['claude-opus-4-6', 'aipm/claude-opus-4-6', 'ar/claude-sonnet-5',
                    'glm-5.3', 'aipm/glm-5.3', 'gpt-5.6-sol', 'justwoker/gpt-5.6-sol',
                    'hcnsec/kimi-k3', 'claude-opus-5[1m]', 'ComboWombo',
                    'aikeysapi/gpt-5.6-sol', 'ak/claude-opus-5']) {
                    if (withCtx(id) !== srvNorm(id)) {
                        fails.push(`withCtxSuffix(${id}) = ${withCtx(id)}, а сервер даёт ${srvNorm(id)} — копии разошлись`);
                    }
                }
                // 2) Голое имя шлюза с вкладки — как серверная ветка CC_MODEL_PREFIX.
                // Заявка владельца 13.09: «[команда] из Маршрутизации копировалась с [1m]».
                for (const gw of ['agentrouter', 'tabi', 'gorouter', 'justwoker', 'aipm']) {
                    if (withCtx(gw, gw) !== srvNorm(gw)) {
                        fails.push(`withCtxSuffix(${gw}, ${gw}) = ${withCtx(gw, gw)}, сервер даёт ${srvNorm(gw)} — команда «Маршрутов» разошлась с settings.json`);
                    }
                }
                // 3) Вкладка шлюза с keepalive: echoModelFor() (keepalive-proxy.js:256) при
                // INJECT_1M дописывает [1m] в ответ клиенту БЕЗУСЛОВНО, любой модели.
                // Заявка владельца 13.09: «дипсик и мб другие модели копируются без 1m».
                for (const [id, gw] of [['deepseek-v4-pro', 'agentrouter'], ['deepseek-r1', 'agentrouter'],
                    ['kimi-k3', 'hcnsec'], ['glm-5.2', 'gorouter'], ['qwen3-max', 'tabi']]) {
                    if (withCtx(id, gw) !== `${id}[1m]`) {
                        fails.push(`withCtxSuffix(${id}, ${gw}) = ${withCtx(id, gw)} — keepalive шлюза ${gw} вернёт клиенту ${id}[1m], кнопка обязана совпадать`);
                    }
                }
                // AIKeysAPI и rumeng — новые вкладки с тем же решением `[1m]`, что и остальные
                // gateway tabs. Проверяем и имя модели, и оба идентификатора AIKeysAPI.
                for (const id of ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'claude-opus-5', 'claude-opus-5[1m]']) {
                    for (const gw of ['aikeysapi', 'ak', 'rumeng']) {
                        const got = withCtx(id, gw);
                        const want = id.includes('[1m]') ? id : `${id}[1m]`;
                        if (got !== want) {
                            fails.push(`withCtxSuffix(${id}, ${gw}) = ${got}, ожидалось ${want} — AIKeysAPI/rumeng должны быть 1M-вкладками`);
                        }
                    }
                }
                // Регресс: исключение не должно вернуться ни в сервере, ни во фронте.
                for (const gw of ['aikeysapi', 'ak', 'rumeng']) {
                    if (srvNorm(gw) !== `${gw}[1m]`) {
                        fails.push(`normalizeCcModel(${gw}) = ${srvNorm(gw)} — ${gw} должен получать [1m]`);
                    }
                }
                // Иначе появился бы третий закон, и фронт снова разъехался бы с settings.json.
                for (const [id, gw] of [['kimi-k3', 'cun'], ['ComboWombo', 'omniroute'], ['deepseek-r1', 'conduit']]) {
                    if (withCtx(id, gw) !== srvNorm(id)) {
                        fails.push(`withCtxSuffix(${id}, ${gw}) = ${withCtx(id, gw)}, сервер даёт ${srvNorm(id)} — у шлюза без keepalive правило обязано остаться серверным`);
                    }
                }
                ok.push('withCtxSuffix: паритет с сервером + ветки вкладок (голое имя, keepalive, AIKeysAPI, rumeng, без keepalive)');
            }
        }
        // Вкладка «Маршруты» раздаёт команду `/model <шлюз>`: без суффикса это тихий 200k
        // (заявка владельца 13.09). Сторожим и вызов, и то, что бейдж с буфером берут ОДНУ
        // строку — владелец вставляет буфер, а сверяется с бейджем.
        const routesCmd = dashboard.match(/function routesCmdHtml\(p\) \{[\s\S]*?\n\}/);
        if (!routesCmd) {
            fails.push('proxy-dashboard.html: routesCmdHtml() не найдена');
        } else {
            if (!/withCtxSuffix\(p\.name, p\.name\)/.test(routesCmd[0])) {
                fails.push('routesCmdHtml(): команда строится без withCtxSuffix(p.name, p.name) → `/model agentrouter` копируется без [1m] = окно 200k');
            }
            if (!/<code class="rt-badge">\$\{esc\(cmd\)\}<\/code>/.test(routesCmd[0])
                || !/JSON\.stringify\(cmd\)/.test(routesCmd[0])) {
                fails.push('routesCmdHtml(): бейдж и буфер собираются не из одной переменной cmd — владелец увидит одно, вставит другое');
            }
        }
        // Кнопки 📋 на вкладках шлюзов с keepalive обязаны передавать имя вкладки вторым
        // аргументом — без него `deepseek-*` копируется голым, а прокси вернёт его с [1m].
        // Список берём из KEEPALIVE_POLL_TABS самого фронта, чтобы новый шлюз попадал в
        // проверку сам, а не через правку теста.
        if (uiKeepTbl) {
            const keepGws = Object.keys(new Function(`${uiKeepTbl[0]}; return KEEPALIVE_POLL_TABS;`)());
            const missing = keepGws.filter(gw => !dashboard.includes(`copyModelCmd(\${JSON.stringify(id)}, "${gw}")`));
            if (missing.length) {
                fails.push(`кнопка 📋 не передаёт вкладку в copyModelCmd для шлюзов с keepalive: ${missing.join(', ')} → модели вроде deepseek-* копируются без [1m], хотя keepalive вернёт их с суффиксом`);
            } else {
                ok.push(`copyModelCmd: вкладка передана на всех ${keepGws.length} шлюзах с keepalive`);
            }
        }
        if (!chip || !/cunNormalizeCcModel\(id\)/.test(chip[0])) {
            fails.push('cunModelChip(): бейдж не нормализует GPT 5.6 в …[1m] перед выбором и копированием');
        }
    } catch (e) {
        fails.push(`proxy-dashboard.html не прочитан: ${e.message}`);
    }
}

// ---- вывод ------------------------------------------------------------------

// ---- 5. Окно для незнакомых CC моделей (gpt-*) ------------------------------
// Инвариант: модель есть в routing/model-windows.json → env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
// равен её окну; модель claude-* → ключа нет вовсе (залипшее значение = переполнение).
if (src) {
    // Реестр префиксов: без него front-door не знает имён провайдеров и `/model aipm/…`
    // молча уедет на активный бэкенд — то есть окно будет думать, что сидит на AIPM,
    // а жечь чужой баланс. Сторожим обе половины: саму функцию и её вызов в чокпоинте.
    if (!/function writeBackendsRegistry\(/.test(src)) {
        fails.push('transparent-proxy.js: нет writeBackendsRegistry() — front-door перестанет знать префиксы провайдеров');
    }
    const afd = src.match(/function applyFrontdoor\(obj\) \{[\s\S]*?\n\}/);
    if (afd && !/writeBackendsRegistry\(/.test(afd[0])) {
        fails.push('applyFrontdoor(): реестр не обновляется на активации — helper-режимы (conduit/ourtoken/…) выпадут из префиксного роутинга');
    }
    const ws = src.match(/function writeSettings\(obj\) \{[\s\S]*?\n\}/);
    if (ws && !/ccContextTokensFor\(obj\.model[,)]/.test(ws[0])) {
        fails.push('writeSettings(): нет ccContextTokensFor() — окно gpt-моделей снова не доедет до статуслайна');
    }
    const cunTiers = src.match(/function cunResolveTiers\(availableIds\) \{[\s\S]*?\n\}/);
    if (!cunTiers || !/normalizeCcModel\(/.test(cunTiers[0])) {
        fails.push('cunResolveTiers(): GPT 5.6 в автомэппинге тиров не получает [1m]');
    } else {
        try {
            const prefs = src.match(/const CUN_TIER_PREFS = \{[\s\S]*?\n\};/)[0];
            const pick = src.match(/function cunPickFromPrefs\(prefs, availableSet\) \{[\s\S]*?\n\}/)[0];
            const norm = fnBody(/function normalizeCcModel\(m/);
            // Зависимости нормализатора подставляем и сюда — он ссылается на таблицу
            // префиксов и на список исключений, объявленные вне вырезаемого куска.
            // Зависимости нормализатора достаём здесь же, а не из соседнего блока: блоки
            // в этом файле раздельные, и переменная из другого просто не видна.
            const deps = `${src.match(/const CC_MODEL_PREFIX = \{[\s\S]*?\n\};/)[0]}\n${src.match(/const NO_1M_GATEWAYS = [^\n]*;\n/)[0]}`;
            const saved = { opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-luna', haiku: 'gpt-5.6-terra' };
            const resolveTiers = new Function('cunReadTiers', `${deps}\n${norm}\n${prefs}\n${pick}\n${cunTiers[0]}; return cunResolveTiers;`)(() => saved);
            const got = resolveTiers(Object.values(saved));
            for (const tier of ['opus', 'sonnet', 'haiku']) {
                if (got[tier] !== `${saved[tier]}[1m]`) fails.push(`cunResolveTiers(saved).${tier} = ${got[tier]}, ожидалось ${saved[tier]}[1m]`);
            }
            const savedSuffixed = Object.fromEntries(Object.entries(saved).map(([tier, id]) => [tier, `${id}[1m]`]));
            const resolveSuffixed = new Function('cunReadTiers', `${deps}\n${norm}\n${prefs}\n${pick}\n${cunTiers[0]}; return cunResolveTiers;`)(() => savedSuffixed);
            const gotSuffixed = resolveSuffixed(Object.values(saved));
            for (const tier of ['opus', 'sonnet', 'haiku']) {
                if (gotSuffixed[tier] !== savedSuffixed[tier] || gotSuffixed.source !== 'saved') {
                    fails.push(`cunResolveTiers(saved [1m]).${tier} потерял сохранённый выбор: ${JSON.stringify(gotSuffixed)}`);
                }
            }
            const readActive = src.match(/function cunReadActiveModel\(\) \{[\s\S]*?\n\}/);
            if (!readActive || !/normalizeCcModel\(/.test(readActive[0])) {
                fails.push('cunReadActiveModel(): legacy GPT 5.6 без [1m] не канонизируется для активного бейджа');
            }
        } catch (e) {
            fails.push(`cunResolveTiers не исполняется: ${e.message}`);
        }
    }
    if (ws && !/delete .*CLAUDE_CODE_MAX_CONTEXT_TOKENS/.test(ws[0])) {
        fails.push('writeSettings(): ключ CLAUDE_CODE_MAX_CONTEXT_TOKENS не снимается для claude-* — залипнет и даст переполнение');
    }
    try {
        const frontdoor = fs.readFileSync(FRONTDOOR, 'utf8');
        const remapRemote = frontdoor.match(/function remapForRemote\(method, reqPath, body, mm, preserveGpt56Suffix\) \{[\s\S]*?\n\}/);
        if (!remapRemote || !/preserveGpt56Suffix && \/\^gpt-5\\\.6-/.test(remapRemote[0])) {
            fails.push('frontdoor remapForRemote(): Cun GPT 5.6 потеряет [1m] до шлюза');
        }
    } catch (e) {
        fails.push(`frontdoor-proxy.js не прочитан: ${e.message}`);
    }
    const i = src.indexOf('const MODEL_WINDOWS_FILE');
    const e = src.indexOf('\n}', src.indexOf('function ccContextTokensFor'));
    if (i < 0 || e < 0) fails.push('transparent-proxy.js: блок modelWindows()/ccContextTokensFor() не найден');
    else {
        let ctxFor;
        try {
            // 🪤 NO_1M_GATEWAYS объявлена рядом с нормализатором (выше по файлу), а не в
            // блоке modelWindows — значит в этот кусок текста она не попадает, и без
            // подстановки функция падает с ReferenceError. Берём из исходника.
            const no1m = src.match(/const NO_1M_GATEWAYS = [^\n]*;\n/);
            if (!no1m) throw new Error('константа NO_1M_GATEWAYS не найдена');
            ctxFor = new Function('fs', 'path', '__dirname',
                no1m[0] + src.slice(i, e + 2) + '; return ccContextTokensFor;',
            )(fs, path, path.join(__dirname, '..', 'routing'));
        } catch (e2) { fails.push(`ccContextTokensFor не исполняется: ${e2.message}`); }
        if (ctxFor) {
            const cases = [
                ['gpt-5.6-sol', 1050000],
                ['glm-5.3', 1050000],           // 04.09: единственный glm в таблице
                ['glm-5.3[1m]', 1050000],       // суффикс срезается до lookup
                ['glm-5.2', null],              // старые glm — не переопределяем
                ['claude-opus-5', null],
                ['claude-opus-5[1m]', null],   // claude любой формы — не переопределяем
                ['ComboWombo', null],          // виртуальная модель шлюза
                ['aikeysapi', 1050000],
                ['ak', 1050000],
                ['aikeysapi/gpt-5.6-sol', 1050000],
                ['ak/claude-opus-5', null],
                ['модели-нет-в-таблице', null],
                // Префиксный роутинг: имя шлюза перед моделью не должно прятать окно.
                // Без среза префикса `/^claude-/` не матчится И ключа нет в таблице —
                // возвращался бы null, и glm-5.3 теряла бы своё 1050000.
                ['aipm/glm-5.3', 1050000],
                ['ar/glm-5.3[1m]', 1050000],
                ['justwoker/gpt-5.6-sol', 1050000],
                ['aipm/claude-opus-5', null],        // claude любой формы — не переопределяем
                ['aipm/модели-нет', null],
                ['', null],
            ];
            for (const [input, want] of cases) {
                const got = ctxFor(input);
                if (got !== want) fails.push(`ccContextTokensFor(${JSON.stringify(input)}) = ${got}, ожидалось ${want}`);
            }
            ok.push(`ccContextTokensFor: ${cases.length} кейсов`);
        }
        // живой settings.json против таблицы
        try {
            const raw = fs.readFileSync(SETTINGS, 'utf8');
            const s = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
            const want = ctxFor ? ctxFor(s.model) : null;
            const got = s.env && s.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
            // Claude Code сам берёт окно из суффикса [1m]; override в env не обязателен.
            if (want && got && String(want) !== String(got)) {
                fails.push(`settings.json: model="${s.model}" → окно ${want}, а CLAUDE_CODE_MAX_CONTEXT_TOKENS=${got || '(нет)'}`);
            } else if (!want && got) {
                fails.push(`settings.json: model="${s.model}" не требует override, а CLAUDE_CODE_MAX_CONTEXT_TOKENS=${got} залип`);
            } else if (want) {
                ok.push(`settings.json: окно ${want} заявлено для "${s.model}"`);
            }
        } catch { /* уже предупредили выше */ }
    }
}


// ---- 6. Резолв пустой модели (delete settings.model → 200k) -----------------
// Инвариант: writeSettings() не пропускает наружу settings.json без model, если
// модель вообще можно резолвить. 14 activate-обработчиков сносят её защитным
// сбросом (см. комментарий у resolveCcModel), и перекрывает их только чокпоинт.
if (src) {
    const ws = src.match(/function writeSettings\(obj\) \{[\s\S]*?\n\}/);
    if (ws && !/resolveCcModel\(obj\)/.test(ws[0])) {
        fails.push('writeSettings(): нет resolveCcModel() — снесённая activate-обработчиком model уедет в файл пустой = 200k');
    }
    const i = src.indexOf('const CC_MODEL_PREFIX');
    const e = src.indexOf('\n}', src.indexOf('function resolveCcModel'));
    const defM = src.match(/const CC_DEFAULT_MODEL = '[^']+';/);
    if (i < 0 || e < 0 || !defM) fails.push('transparent-proxy.js: блок CC_MODEL_PREFIX/resolveCcModel() не найден');
    else {
        // Фальшивый HOME (файлов моделей в нём нет), но НАСТОЯЩИЕ тир-карты из routing/:
        // так тест ловит и «карту почистили на вкладке, а пин остался».
        const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'check1m-'));
        fs.mkdirSync(path.join(fakeHome, '.claude'));
        const ROUTING = path.join(__dirname, '..', 'routing');
        const DEF = defM[0].match(/'([^']+)'/)[1];
        let resolve;
        const build = (backendName) => new Function(
            'fs', 'path', 'os', '__dirname', 'isFrontdoorBase', 'readActiveBackend', 'backendFromSettingsObj', 'logLine',
            `${defM[0]}\n${src.slice(i, e + 2)}; return resolveCcModel;`,
        )(
            fs, path, { homedir: () => fakeHome }, ROUTING,
            () => false, () => null, () => backendName, () => {},
        );
        try {
            // Модель, выбранную человеком на вкладке, уважаем как есть.
            fs.writeFileSync(path.join(fakeHome, '.claude', 'gorouter-active-model.txt'), 'claude-opus-5\n');
            const cases = [
                ['gorouter', 'claude-opus-5', 'файл провайдера'],
                ['tabi', DEF, 'файла нет, тир-карта умеет opus → пин'],
                // Пятый шлюз (22.08). У него в каталоге ТОЛЬКО opus-модели, поэтому
                // тир-карта обязана уметь opus — иначе пина нет и Claude Code стартует
                // на 200k. Красный тут = `routing/justwoker-modelmap.json` пустой или его нет.
                ['justwoker', DEF, 'файла нет, тир-карта умеет opus → пин'],
                ['xpeach', '', 'тир-карта пустая → вслепую не пиним'],
                ['official', DEF, 'официальный Claude'],
                ['unknown', '', 'провайдер не опознан'],
            ];
            for (const [backendName, want, why] of cases) {
                resolve = build(backendName);
                const got = resolve({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } });
                if (got !== want) fails.push(`resolveCcModel(${backendName}) = ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want)} (${why})`);
            }
            ok.push(`resolveCcModel: ${cases.length} кейсов`);
        } catch (e2) {
            fails.push(`resolveCcModel не исполняется: ${e2.message}`);
        } finally {
            try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
        }
    }
}

for (const s of ok) console.log(`  ok   ${s}`);
for (const s of warns) console.log(`  warn ${s}`);
for (const s of fails) console.log(`  FAIL ${s}`);
if (fails.length) {
    console.log(`\n[X] инвариант 1M нарушен: ${fails.length} проблем(ы). Как чинить — docs/archive/HANDOFF-model-1m.md`);
    process.exit(1);
}
console.log('\n[OK] инвариант 1M держится');
