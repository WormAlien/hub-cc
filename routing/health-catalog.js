// health-catalog.js — «какие модели у нас в принципе есть».
//
// Чистое чтение файлов с диска: ни одного сетевого запроса, ни одной пробы модели.
// Пробы — работа другого модуля; здесь только инвентарь и его происхождение.
//
// Четыре источника, и они НЕ равноценны:
//   1. `*-modelmap.json` — тир-карты. Это НАШЕ ПОЖЕЛАНИЕ («хочу, чтобы sonnet ехал
//      на claude-opus-4-8»), а не факт наличия модели у шлюза. Ровно об этом
//      предупреждает keepalive-proxy.js в `tierTargetFor`:
//        «Карта — пожелание, каталог шлюза — факт. Если цели у шлюза нет, берём
//         живую замену: иначе запрос гарантированно умрёт на 503 model_not_found
//         (03.09: justwoker убрал claude-opus-4-8, и 255 запросов сабагентов легли).»
//   2. `custom-models-cache.json` — каталоги, снятые с самих шлюзов (`GET /v1/models`).
//      Это факт, но факт НА МОМЕНТ СНЯТИЯ: отсюда `catalog_ts`/`catalog_stale_days`.
//   3. `custom-providers.json` — кастом-провайдеры со своими modelMap.
//   4. `MONEY_GW` в `transparent-proxy.js` — реестр десяти денежных шлюзов
//      (тег → label → host). Host нужен для тарифа: он же ключ `FLAT_RATE_HOSTS`.
//
// ─────────────────────────────────────────────────────────────────────────────────
// 🔴 ГЛАВНОЕ: ЧТО ЛЕЖИТ В `token-usage.jsonl` — ИМЯ КЛИЕНТА, А НЕ АПСТРИМА
// ─────────────────────────────────────────────────────────────────────────────────
// Вопрос не праздный: имя модели по дороге ПОДМЕНЯЕТСЯ (тир-карта), и если бы в
// журнал попадало имя апстрима, то ключи тир-карт и ключи журнала разошлись бы ровно
// на подменяемых моделях — а join по ним молча потерял бы самый горячий трафик.
//
// Ответ: **в журнал попадает имя, которое просил КЛИЕНТ.** Три звена, все проверены
// по коду, и каждое обязательно:
//
//   (а) Счётчик висит на front-door и берёт имя из ТЕЛА ОТВЕТА апстрима —
//       `usage-tap.js:363` пишет `m: state.model`, где `state.model` набит из
//       `o.model || (o.message && o.message.model)` (`usage-tap.js:325-326`).
//       Врезка — `frontdoor-proxy.js:483` (`createTap`), слушатель рядом с трубой.
//
//   (б) Ответ до счётчика уже ПОЧИНЕН обратно. keepalive-proxy.js держит
//       `clientModel` — «модель, которую просил КЛИЕНТ (до ремапа)»
//       (`keepalive-proxy.js:1386`, набивается из сырого тела на `:2207`) — и
//       переписывает поле `model` в ответе на него:
//         `keepalive-proxy.js:180-184`
//           function rewriteModelJson(text, clientModel) {
//             if (!MODEL_ECHO || !clientModel) return text;
//             if (!MODEL_FIELD_RE.test(text)) return text;
//             return text.replace(MODEL_FIELD_RE, `"model":${JSON.stringify(clientModel)}`);
//           }
//       `MODEL_ECHO` включён по умолчанию (`keepalive-proxy.js:168`:
//       `process.env.MODEL_ECHO !== '0'`), вызовы — на SSE (`:1587`) и на JSON (`:1684`).
//       Сделано ради статусбара Claude Code, но побочный эффект ровно тот, что нам нужен.
//
//   (в) Front-door при этом сам НИЧЕГО не подменяет — в живой конфигурации.
//       Его ремап заперт за гейтом `if (!state.local)` (`frontdoor-proxy.js:440`), а в
//       `~/.claude/backends.json` ВСЕ 15 бэкендов — `http://localhost:201xx`, то есть
//       `local: true` (`isLocalHost`, `frontdoor-proxy.js:77`). Вдобавок у всех
//       `modelmap: null`, а `readModelMap(null)` возвращает null и `tierTargetFor`
//       сразу отдаёт null. Значит `remapForRemote` (`frontdoor-proxy.js:452-259`) в
//       бою не срабатывает вовсе: подмена целиком живёт в keepalive-прокси, ниже
//       врезки счётчика, и наверх её результат не всплывает.
//
// Порядок звеньев: клиент → front-door (не трогает) → keepalive (ПОДМЕНЯЕТ имя в
// запросе) → шлюз → keepalive (ВОЗВРАЩАЕТ имя клиента в ответе) → front-door (тап
// читает уже возвращённое) → журнал.
//
// Доказательство из данных (`token-usage.jsonl`, снимок 2026-09-10, 51 581 строка):
//   • `kktoken|claude-opus-5-thinking` — 5 766 записей. Тир-карта kktoken:
//     `{"opus":"claude-opus-5","sonnet":"claude-opus-4-8","haiku":"claude-opus-4-8"}`.
//     Имя `claude-opus-5-thinking` матчится opus-регекспом → наверх уехало
//     `claude-opus-5`. В журнале лежит `claude-opus-5-thinking` — имя КЛИЕНТА.
//   • `kktoken|claude-sonnet-5` — 13 записей при sonnet → `claude-opus-4-8`.
//   • `gorouter|claude-sonnet-5` — 27 записей при sonnet → `claude-opus-4-8`.
//   • `agentrouter|claude-opus-4-8` — 385 записей, хотя вся карта agentrouter
//     (`ar-modelmap.json`) — `claude-opus-5` во всех трёх тирах.
//   • `kktoken|claude-sonnet-5[1m]` — контрольный выстрел: суффикс `[1m]` — чисто
//     клиентская метка окна, и ремап её СРЕЗАЕТ (`frontdoor-proxy.js:250-252`,
//     `mapped.replace(/\s*\[[^\]]*\]\s*$/, '')`). Апстрим такого имени не видел
//     никогда и вернуть его не мог.
//
// Практический вывод для потребителя: `m` из журнала — это ЗАПРОС, а не то, что
// реально считал шлюз. Поэтому у записей каталога есть `aliases`: имена, под
// которыми клиент может попросить эту модель. Джойнить так —
//   exact `${bk}|${m}` → иначе поиск `m` в `aliases` (со снятым `[1m]`).
// Совпадение по `aliases` означает «шлюз выполнил это ДРУГОЙ моделью».
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const rd = f => fs.readFileSync(path.join(DIR, f), 'utf8');
const rdJson = (f) => {
    const raw = rd(f);
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
};

const norm = s => String(s == null ? '' : s).trim().toLowerCase();
const strip1m = s => String(s || '').replace(/\s*\[[^\]]*\]\s*$/, '');

// ── Тир-карты: файл → бэкенд-ключ журнала ────────────────────────────────────────
// 🪤 Ключ здесь — ТЕГ шлюза, а не префикс файла. У agentrouter карта называется
// `ar-modelmap.json`, а в журнале `bk` = `agentrouter` (`state.backend` из
// `~/.claude/backends.json`, `frontdoor-proxy.js:484`). Ключ `ar|...` не сматчился бы
// ни с одной строкой журнала — а это 2 388 + 705 + 385 + … записей.
const TIER_MAP_FILES = {
    agentrouter: 'ar-modelmap.json',
    gorouter: 'gorouter-modelmap.json',
    tabi: 'tabi-modelmap.json',
    justwoker: 'justwoker-modelmap.json',
    kktoken: 'kktoken-modelmap.json',
    aipm: 'aipm-modelmap.json',
    hcnsec: 'hcnsec-modelmap.json',
    seekai: 'seekai-modelmap.json',
    truesota: 'truesota-modelmap.json',
    xpeach: 'xpeach-modelmap.json',
};

// Регекспы тиров — КОПИЯ `TIER_RE` из keepalive-proxy.js:132 (и такая же в
// frontdoor-proxy.js). Именно они решают, попадёт ли имя клиента под подмену,
// поэтому переписывать «покрасивее» нельзя: разойдётся с боем.
const TIER_RE = [
    { tier: 'opus', re: /(^|[-_.\/])?opus([-\/]|$)/i },
    { tier: 'sonnet', re: /(^|[-_.\/])?sonnet([-\/]|$)/i },
    { tier: 'haiku', re: /(^|[-_.\/])?haiku([-\/]|$)/i },
];
const TIERS = ['opus', 'sonnet', 'haiku'];

// Имена, под которыми клиент реально просит модели. Нужны только для `aliases`:
// тир-регекспы матчат ОТКРЫТОЕ множество строк, перечислить его нельзя, поэтому
// берём наблюдаемое. Список снят с `token-usage.jsonl` (все `m` за 25.08–10.09)
// плюс канонические имена Claude Code, которых в журнале ещё не было.
// Пополнять руками: журнал в рантайме не читаем — он 8.4 МБ.
const CANONICAL_CLIENT_MODELS = [
    'claude-opus-5', 'claude-opus-5-thinking',
    'claude-opus-4-8', 'claude-opus-4-8-thinking',
    'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-6-thinking',
    'claude-opus-4-5-20251101', 'claude-opus-4.5',
    'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-6-thinking',
    'claude-sonnet-4-5', 'claude-sonnet-4-20250514', 'claude-sonnet-4.5',
    'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4.5',
    'claude-haiku-4-5-instant', 'claude-3-5-haiku-20241022',
    'claude-fable-5',
];

// ── MONEY_GW: реестр шлюзов ──────────────────────────────────────────────────────
// Читаем из `transparent-proxy.js` (там он объявлен и там же оговорено, что host
// обязан совпадать байт в байт с `GW_BY_HOST` в keepalive-proxy.js). Зашитая копия —
// только фолбэк: если парсер промахнётся, лучше отдать инвентарь с предупреждением,
// чем упасть. Расхождение копии с файлом попадает в `warnings`, молча не проходит.
const MONEY_GW_FALLBACK = [
    { key: 'ar', bk: 'agentrouter', label: 'AgentRouter', host: 'agentrouter.org' },
    { key: 'go', bk: 'gorouter', label: 'GoRouter', host: 'gorouter.app' },
    { key: 'tb', bk: 'tabi', label: 'Tabi Token', host: 'tabitoken.com' },
    { key: 'xp', bk: 'xpeach', label: 'XPeach', host: 'xpeach.codes' },
    { key: 'jw', bk: 'justwoker', label: 'JustWoker', host: 'api.justwoker.icu' },
    { key: 'sk', bk: 'seekai', label: 'SeekAi', host: 'seekai.cc' },
    { key: 'ts', bk: 'truesota', label: 'TrueSOTA', host: 'true-sota.com' },
    { key: 'kk', bk: 'kktoken', label: 'KKtoken', host: 'kktoken.cc' },
    { key: 'ap', bk: 'aipm', label: 'AIPM', host: 'emtf.aipm9527.online' },
    { key: 'hn', bk: 'hcnsec', label: 'HCNsec', host: 'api.hcnsec.cn' },
];

function parseMoneyGw(warnings) {
    try {
        const src = rd('transparent-proxy.js');
        const at = src.indexOf('const MONEY_GW = {');
        if (at < 0) throw new Error('объявление MONEY_GW не найдено');
        const block = src.slice(at, src.indexOf('\n};', at));
        const out = [];
        const re = /^\s*(\w+):\s*\{(.+)$/gm;
        let m;
        while ((m = re.exec(block))) {
            const body = m[2];
            const tag = /tag:\s*'([^']+)'/.exec(body);
            const label = /label:\s*'([^']+)'/.exec(body);
            const host = /host:\s*'([^']+)'/.exec(body);
            if (!tag || !host) continue;
            out.push({ key: m[1], bk: tag[1], label: label ? label[1] : tag[1], host: host[1] });
        }
        if (out.length !== MONEY_GW_FALLBACK.length) {
            warnings.push(`MONEY_GW: в transparent-proxy.js разобрано ${out.length} шлюзов, `
                + `в зашитой копии ${MONEY_GW_FALLBACK.length} — реестр изменился, обнови копию в health-catalog.js`);
        }
        const byKey = new Map(MONEY_GW_FALLBACK.map(g => [g.key, g]));
        for (const g of out) {
            const f = byKey.get(g.key);
            if (f && (f.host !== g.host || f.bk !== g.bk)) {
                warnings.push(`MONEY_GW.${g.key}: файл говорит ${g.bk}/${g.host}, `
                    + `зашитая копия ${f.bk}/${f.host} — источник истины файл, копию поправь`);
            }
        }
        return out.length ? out : MONEY_GW_FALLBACK;
    } catch (e) {
        warnings.push(`MONEY_GW не разобран из transparent-proxy.js (${e.message}) — взята зашитая копия`);
        return MONEY_GW_FALLBACK;
    }
}

// ── Тариф: плоско за запрос или по токенам ───────────────────────────────────────
// Источник — `keepalive-proxy.js:479`, восемь хостов:
//   const FLAT_RATE_HOSTS = new Set(['tabitoken.com', 'gorouter.app', 'xpeach.codes',
//     'api.justwoker.icu', 'seekai.cc', 'true-sota.com', 'kktoken.cc', 'emtf.aipm9527.online']);
// 🪤 Список НЕ равен «тариф плоский»: два хоста внесены по другой причине — см. NOTES.
const FLAT_RATE_FALLBACK = ['tabitoken.com', 'gorouter.app', 'xpeach.codes',
    'api.justwoker.icu', 'seekai.cc', 'true-sota.com', 'kktoken.cc', 'emtf.aipm9527.online'];

function parseFlatRateHosts(warnings) {
    try {
        const src = rd('keepalive-proxy.js');
        const m = /const FLAT_RATE_HOSTS = new Set\(\[([^\]]*)\]\)/.exec(src);
        if (!m) throw new Error('объявление FLAT_RATE_HOSTS не найдено');
        const hosts = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
        if (!hosts.length) throw new Error('пустой набор');
        const a = [...hosts].sort().join(',');
        const b = [...FLAT_RATE_FALLBACK].sort().join(',');
        if (a !== b) {
            warnings.push(`FLAT_RATE_HOSTS в keepalive-proxy.js изменился: [${hosts.join(', ')}] `
                + `против зашитой копии [${FLAT_RATE_FALLBACK.join(', ')}] — источник истины файл`);
        }
        return new Set(hosts);
    } catch (e) {
        warnings.push(`FLAT_RATE_HOSTS не разобран из keepalive-proxy.js (${e.message}) — взята зашитая копия`);
        return new Set(FLAT_RATE_FALLBACK);
    }
}

// ── Заметки по шлюзам: короткая плашка + полный разбор ───────────────────────────
// Два поля на одну и ту же мысль, и это не дублирование:
//   `note`    — то, что влезает НА КАРТОЧКУ шлюза. Жёсткий предел 120 символов
//               (NOTE_LIMIT ниже, проверяется в самом модуле). Длинная строка карточку
//               разрывает, а карточек десять — вкладка перестаёт читаться.
//   `details` — тот же факт с цитатой и адресом строки. Идёт в вики и в тултип.
// Только то, что реально написано в файлах репозитория. Пересказ «по памяти» здесь
// запрещён: этими заметками потом объясняют счёт за месяц.
const NOTE_LIMIT = 120;

const GW_NOTES = {
    kktoken: [{
        note: 'Считает по токенам, но игнорирует max_tokens — брошенный запрос платим целиком',
        details: 'Тариф НЕ плоский (считает по токенам), но в FLAT_RATE_HOSTS внесён намеренно — '
            + 'keepalive-proxy.js:474-477: «шлюз ИГНОРИРУЕТ `max_tokens`, поэтому брошенный на 20-й '
            + 'секунде дубль апстрим досчитывает до конца и выставляет нам полный счёт за ответ, '
            + 'который никто не увидел. То есть цена дубля та же, что у плоского тарифа, — хедж '
            + 'запрещаем (maxHedges: 0)».',
    }],
    truesota: [{
        note: 'Подписка: квота плана. К каждому запросу клеит свой префикс 4.1–6.9к токенов',
        details: 'keepalive-proxy.js:470-473: «true-sota.com (sub2api) добавлен 2026-08-25 … тариф там '
            + 'ПОДПИСОЧНЫЙ (квота плана, а не токены), плюс шлюз приклеивает к каждому запросу свой '
            + 'префикс 4.1–6.9к токенов — дубль съедает окно плана целиком, а ускорения не даёт».',
    }, {
        note: 'Рабочих моделей 2 из 18: opus-5 и opus-5-thinking, остальные реселл Kiro',
        details: 'РАБОЧИХ МОДЕЛЕЙ ДВЕ из 18. transparent-proxy.js:16512-16516: «РАБОЧИХ МОДЕЛЕЙ ДВЕ: '
            + '`claude-opus-5` и `claude-opus-5-thinking`. Остальные 16 из каталога — реселл Kiro: '
            + 'шлюз подставляет СВОЙ системный промпт (префикс 4.1–6.9к токенов) и наш `system` не '
            + 'исполняет. Замер: `system: "тебя зовут NAIL-7"` → «My name is Kiro»…». Машинно-читаемый '
            + 'вид того же факта — `TS_SYSTEM_HONORED` (transparent-proxy.js:17145).',
    }, {
        note: 'Легаси с 05.09, но не из-за банов: шлюз живой, просто узкий — и в опросе вотчдога',
        details: 'ЛЕГАСИ с 2026-09-05, и причина ДРУГАЯ, чем у seekai/xpeach. lib/ref-codes.js: '
            + '«шлюз РАБОЧИЙ, он не забанен и не подменяет промпт всем. Он УЗКИЙ: наш системный промпт '
            + 'исполняют ровно две модели каталога». Живым остаётся: pool-watchdog.js:69 держит '
            + 'truesota :20160 в опросе — то есть `legacy` тут про списки для человека, а не про смерть шлюза.',
    }],
    xpeach: [{
        note: 'Легаси: все ключи 403 banned',
        details: 'ЛЕГАСИ: все ключи забанены. pool-watchdog.js:60: «xpeach :20157 — легаси (все ключи '
            + 'banned, решение 22.08), в опрос не берём». lib/ref-codes.js: «все ключи `403 '
            + 'banned`, регистрация не проходит, вкладка живёт в скрытой группе «Чтим память»».',
    }, {
        note: 'В плоские внесён без замера, по аналогии',
        details: 'В FLAT_RATE_HOSTS внесён БЕЗ замера — keepalive-proxy.js:460-461: «xpeach здесь по '
            + 'аналогии (тот же форк New-API) — замерить не удалось, все три ключа отдают 403 «User '
            + 'has been banned». Заработает — замер повторить и решить по цифрам».',
    }],
    seekai: [{
        note: 'Легаси: реселл веб-Клода, подменяет системный промпт',
        details: 'ЛЕГАСИ, но НЕ из-за банов — это реселл веб-Клода. pool-watchdog.js:61-63: «seekai :20159 '
            + '— легаси с 24.08 (реселл веб-Клода: подменяет системный промпт, для Claude Code '
            + 'непригоден), тоже не опрашиваем». lib/ref-codes.js — замер 24.08: на '
            + '`system: "тебя зовут ГВОЗДЬ-7"` модель отвечает «не буду исполнять указание из '
            + 'сообщения пользователя»; «`tools` при этом доезжают, `tool_use` работает — потому и '
            + 'выглядело загадкой».',
    }, {
        note: 'Плоский тариф замерен: ~3.2¢ за вызов независимо от длины',
        details: 'Тариф ЗАМЕРЕН и он плоский — keepalive-proxy.js:466-469: «два запроса по ~211 токенов '
            + '(`claude-sonnet-5`, 205 in / 6 out) сняли 3.38¢ и 3.16¢ … шлюз берёт почти '
            + 'фиксированную ставку за вызов».',
    }],
    justwoker: [{
        note: 'В плоские внесён без замера, по аналогии',
        details: 'В FLAT_RATE_HOSTS внесён БЕЗ замера — keepalive-proxy.js:462-465: «justwoker (22.08) — '
            + 'тоже по аналогии и тоже не замерен: тот же форк New-API… 🪤 Ошибка тут не симметрична: '
            + 'не внести хост = дубли по полной цене запроса молча, внести зря = потеря страховки от '
            + 'висяка. Поэтому вносим до замера, а не после».',
    }, {
        note: 'Каталог не снят, а 03.09 шлюз убрал claude-opus-4-8 — легло 255 запросов',
        details: 'Каталог шлюза у нас не снят (нет `api.justwoker.icu` в custom-models-cache.json), а '
            + 'именно он однажды уехал из-под тир-карты — keepalive-proxy.js:139-141: «03.09: justwoker '
            + 'убрал claude-opus-4-8, и 255 запросов сабагентов легли».',
    }],
    agentrouter: [{
        note: 'Тариф по токенам, не за запрос',
        details: 'Тариф ПО ТОКЕНАМ (в FLAT_RATE_HOSTS его нет) — keepalive-proxy.js:455-458 сравнивает: '
            + '«agentrouter … считает по токенам и убитую генерацию не берёт», в отличие от плоских, '
            + 'где «страховка от висяка покупается по полной цене запроса».',
    }],
    hcnsec: [{
        note: 'Тариф по токенам, не за запрос',
        details: 'Тариф ПО ТОКЕНАМ — это закреплено регрессом keepalive-proxy.js:2440: '
            + '`assert.ok(!FLAT_RATE_HOSTS.has(\'api.hcnsec.cn\'), \'hcnsec тарифицируется по токенам, '
            + 'не за запрос — в плоских его быть не должно\')`.',
    }, {
        note: 'Единственная не-claude тир-карта: kimi-k3 / step-3.7-flash / step-explore',
        details: 'Единственный шлюз с не-claude тир-картой: `{"opus":"kimi-k3","sonnet":"step-3.7-flash",'
            + '"haiku":"step-explore"}` — клиентские claude-имена уезжают на китайские модели.',
    }],
    aipm: [{
        note: 'Порог баланса 0.10 — единственный в реестре',
        details: 'Единственный шлюз с порогом баланса в реестре: `minBal: 0.10` (transparent-proxy.js, '
            + 'запись `ap` в MONEY_GW).',
    }, {
        note: 'Каталог снят с домена .xyz, а host шлюза .online — к шлюзу он не отнесён',
        details: 'В custom-models-cache.json есть `https://emtf.aipm9527.xyz/v1` (8 моделей), а host в '
            + 'MONEY_GW — `emtf.aipm9527.online`. Домены РАЗНЫЕ, склеивать их молча нельзя: каталог '
            + 'отнесён только к bk=custom. Если это один сервис — поправь реестр или пересними каталог.',
    }],
    gorouter: [{
        note: 'Плоский тариф замерен 21.08: 20¢ за запрос любой длины',
        details: 'keepalive-proxy.js:452-458: «Замер 21.08: tabitoken списывает 50¢, gorouter 20¢ — '
            + 'одинаково за полный ответ на 2000 токенов, за крошечный на 16 токенов И за дубль, '
            + 'который мы порвали на 20-й секунде».',
    }],
    tabi: [{
        note: 'Плоский тариф замерен 21.08: 50¢ за запрос любой длины',
        details: 'keepalive-proxy.js:452-458: «Замер 21.08: tabitoken списывает 50¢, gorouter 20¢ — '
            + 'одинаково за полный ответ на 2000 токенов, за крошечный на 16 токенов И за дубль, '
            + 'который мы порвали на 20-й секунде».',
    }],
};

// Подписочный тариф — ровно один шлюз, и это НЕ то же самое, что «плоский за запрос»:
// плоский платится деньгами за вызов, подписочный выедает квоту плана.
// Источник — keepalive-proxy.js:470-473 (см. details у truesota).
const SUBSCRIPTION_BK = new Set(['truesota']);

// ── legacy: берём из машинно-читаемого места, а не из головы ─────────────────────
// `lib/ref-codes.js` → `SHAPES[*].legacy` — единственный флаг легаси в коде, и именно
// он убирает шлюз из списков для человека. Там их ТРИ: seekai, truesota, xpeach.
// 🪤 Причины разные, и путать их нельзя: у seekai/xpeach шлюз негоден (баны / подмена
// промпта), у truesota он рабочий и в опросе вотчдога — просто узкий. Отсюда note.
const LEGACY_FALLBACK = ['seekai', 'truesota', 'xpeach'];

function parseLegacyBk(warnings) {
    try {
        const src = fs.readFileSync(path.join(DIR, 'lib', 'ref-codes.js'), 'utf8');
        const out = new Set();
        for (const m of src.matchAll(/^\s*(\w+):\s*\{[^}]*\blegacy:\s*true/gm)) out.add(m[1]);
        if (!out.size) throw new Error('ни одного legacy: true не найдено');
        const a = [...out].sort().join(',');
        const b = [...LEGACY_FALLBACK].sort().join(',');
        if (a !== b) {
            warnings.push(`legacy в lib/ref-codes.js изменился: [${[...out].join(', ')}] против `
                + `зашитой копии [${LEGACY_FALLBACK.join(', ')}] — источник истины файл`);
        }
        return out;
    } catch (e) {
        warnings.push(`legacy не разобран из lib/ref-codes.js (${e.message}) — взята зашитая копия`);
        return new Set(LEGACY_FALLBACK);
    }
}

// ── Каталоги кастом-провайдеров ──────────────────────────────────────────────────
function hostOf(u) {
    try { return new URL(u).hostname; } catch { return ''; }
}

function catalog() {
    const warnings = [];

    // Заголовок выдачи: главный вывод этого модуля. Потребитель, который не прочитал
    // шапку файла, обязан споткнуться об это в данных.
    warnings.push('ДЖОЙН С ЖУРНАЛОМ: в `token-usage.jsonl` поле `m` — имя, которое просил '
        + 'КЛИЕНТ, а не то, что ушло апстриму. Подмена по тир-карте живёт в keepalive-прокси, '
        + 'а ответ он переписывает обратно на `clientModel` (MODEL_ECHO, keepalive-proxy.js:'
        + '180-184), и счётчик front-door (usage-tap.js:363, врезка frontdoor-proxy.js:483) '
        + 'читает уже возвращённое имя. Матчить: exact `${bk}|${m}`, иначе по `aliases` со '
        + 'снятым суффиксом `[1m]`; попадание в `aliases` = «выполнено другой моделью». '
        + '🪤 Снимай ещё и ВЕДУЩИЙ `/`: в журнале есть `custom|/claude-opus-4-6-thinking` '
        + '(7 записей) — это `claude-opus-4-6-thinking` с недоеденным префиксом провайдера '
        + '(frontdoor-proxy.js:290 `j.model.slice(0, slash)`), в каталогах имён с `/` в начале нет.');

    const gwList = parseMoneyGw(warnings);
    const flatHosts = parseFlatRateHosts(warnings);

    // ── тир-карты ────────────────────────────────────────────────────────────────
    const tierMaps = {};                       // bk → {opus, sonnet, haiku}
    for (const [bk, file] of Object.entries(TIER_MAP_FILES)) {
        try {
            const doc = rdJson(file);
            const mm = {};
            for (const t of TIERS) mm[t] = norm(doc[t]);
            tierMaps[bk] = mm;
            if (TIERS.every(t => !mm[t])) {
                warnings.push(`${bk}: тир-карта ${file} пустая во всех трёх тирах — `
                    + `claude-имена уедут на шлюз как есть (frontdoor-proxy.js:459 логирует это как будущий 404)`);
            }
        } catch (e) {
            tierMaps[bk] = { opus: '', sonnet: '', haiku: '' };
            warnings.push(`${bk}: тир-карта ${file} не прочитана (${e.message})`);
        }
    }

    // ── каталоги ─────────────────────────────────────────────────────────────────
    let cache = {};
    try { cache = rdJson('custom-models-cache.json'); }
    catch (e) { warnings.push(`custom-models-cache.json не прочитан (${e.message}) — каталогов нет, останутся только тир-карты`); }

    let providers = [];
    try {
        const doc = rdJson('custom-providers.json');
        providers = Array.isArray(doc) ? doc : (doc.providers || []);
    } catch (e) { warnings.push(`custom-providers.json не прочитан (${e.message})`); }

    const providerByBase = new Map();
    for (const p of providers) if (p && p.baseUrl) providerByBase.set(String(p.baseUrl), p);

    // host → bk денежного шлюза. Каталог, снятый с хоста шлюза, принадлежит шлюзу.
    const bkByHost = new Map(gwList.map(g => [g.host, g.bk]));

    // 🪤 Хост AIPM в реестре — `emtf.aipm9527.online`, а каталог снят с
    // `emtf.aipm9527.xyz`. Разные домены; молча склеивать их нельзя (это было бы
    // выдумкой), но и промолчать о таком совпадении нельзя.
    const gwHosts = new Set(bkByHost.keys());
    for (const base of providerByBase.keys()) {
        const h = hostOf(base);
        if (gwHosts.has(h)) continue;
        for (const gh of gwHosts) {
            const a = h.split('.'), b = gh.split('.');
            if (a.length > 1 && b.length > 1 && a.slice(0, -1).join('.') === b.slice(0, -1).join('.')) {
                warnings.push(`каталог снят с ${h}, а в MONEY_GW у шлюза host = ${gh} — домены разные, `
                    + `к шлюзу этот каталог НЕ отнесён (только к bk=custom). Если это один сервис — поправь реестр или пересними каталог`);
            }
        }
    }

    const catalogTsByBk = new Map();           // bk → мс
    // bk → Map(model → {owned_by, ts})
    const catModels = new Map();
    const addCat = (bk, id, ownedBy, ts) => {
        if (!catModels.has(bk)) catModels.set(bk, new Map());
        const m = catModels.get(bk);
        const k = norm(id);
        if (!k) return;
        const prev = m.get(k);
        if (!prev || (ts || 0) > (prev.ts || 0)) m.set(k, { owned_by: ownedBy ? norm(ownedBy) : null, ts: ts || null });
        const cur = catalogTsByBk.get(bk);
        if (ts && (!cur || ts > cur)) catalogTsByBk.set(bk, ts);
    };

    let baseUrls = 0, catalogModels = 0, emptyCatalogs = 0;
    // Отдельный счёт по bk=custom: он единственный, у кого каталог собран из МНОГИХ
    // baseUrl, и поэтому «сколько моделей» у него имеет два разных ответа — см. ниже,
    // где строится одиннадцатая карточка.
    let customBaseUrls = 0, customRawModels = 0, customTsMin = null, customTsMax = null;
    for (const [base, val] of Object.entries(cache)) {
        if (!val || typeof val !== 'object') continue;
        baseUrls++;
        const data = Array.isArray(val.data) ? val.data : [];
        const ts = typeof val.ts === 'number' ? val.ts : null;
        if (!data.length) {
            emptyCatalogs++;
            warnings.push(`каталог ${base} пустой (0 моделей, снят ${ts ? new Date(ts).toISOString() : '?'}) `
                + `— шлюз либо не отдаёт /v1/models, либо ключ мёртв`);
        }
        const gwBk = bkByHost.get(hostOf(base));
        const isProvider = providerByBase.has(base);
        const toCustom = isProvider || !gwBk;
        if (toCustom) {
            customBaseUrls++;
            customRawModels += data.length;
            if (ts) {
                if (customTsMin == null || ts < customTsMin) customTsMin = ts;
                if (customTsMax == null || ts > customTsMax) customTsMax = ts;
            }
        }
        for (const row of data) {
            const id = row && (row.id || row.model);
            if (!id) continue;
            catalogModels++;
            if (gwBk) addCat(gwBk, id, row.owned_by, ts);
            // Кастом-провайдеры в журнале лежат под ОДНИМ bk = `custom`
            // (`~/.claude/backends.json` → provider `custom`), поэтому их модели
            // сводим туда же — иначе строки `custom|…` не сматчатся ни с чем.
            if (toCustom) addCat('custom', id, row.owned_by, ts);
        }
    }

    // modelMap кастом-провайдеров — тоже тир-карты, но все они сходятся в bk `custom`.
    const customTier = { opus: '', sonnet: '', haiku: '' };
    const customTierAll = { opus: new Set(), sonnet: new Set(), haiku: new Set() };
    for (const p of providers) {
        const mmp = (p && p.modelMap) || {};
        for (const t of TIERS) {
            const v = norm(mmp[t]);
            if (!v) continue;
            customTierAll[t].add(v);
            if (!customTier[t]) customTier[t] = v;
        }
    }
    for (const t of TIERS) {
        if (customTierAll[t].size > 1) {
            warnings.push(`bk=custom, тир ${t}: у 18 кастом-провайдеров ${customTierAll[t].size} разных целей `
                + `(${[...customTierAll[t]].join(', ')}), а в журнале все они под одним bk=custom — `
                + `поле tier у таких записей условно, восстановить провайдера по строке журнала нельзя`);
        }
    }
    tierMaps.custom = customTier;

    // ── сборка записей ───────────────────────────────────────────────────────────
    const entries = new Map();                 // key → entry
    const get = (bk, m) => {
        const key = `${norm(bk)}|${norm(m)}`;
        if (!entries.has(key)) {
            entries.set(key, {
                key, bk: norm(bk), m: norm(m),
                source: null, tier: null, owned_by: null,
                aliases: [], catalog_ts: null, catalog_stale_days: null,
                _aliases: new Set(),
            });
        }
        return entries.get(key);
    };

    const now = Date.now();
    const staleDays = ts => (ts ? Math.floor((now - ts) / 864e5) : null);

    // каталоги → записи
    for (const [bk, models] of catModels) {
        for (const [m, info] of models) {
            const e = get(bk, m);
            e.source = e.source === 'tier' ? 'both' : 'catalog';
            e.owned_by = info.owned_by;
            e.catalog_ts = info.ts ? new Date(info.ts).toISOString() : null;
            e.catalog_stale_days = staleDays(info.ts);
        }
    }

    // тир-карты → записи
    const tierMisses = [];
    for (const [bk, mm] of Object.entries(tierMaps)) {
        for (const t of TIERS) {
            const target = mm[t];
            if (!target) continue;
            const e = get(bk, target);
            e.source = e.source === 'catalog' || e.source === 'both' ? 'both' : 'tier';
            if (!e.tier) e.tier = t;            // порядок opus > sonnet > haiku, как в TIER_RE
            const known = catModels.get(bk);
            if (known && known.size && !known.has(target)) {
                // Ровно тот случай, ради которого в keepalive есть availableTarget.
                tierMisses.push(`${bk}: цель тира ${t} = \`${target}\` в снятом каталоге шлюза `
                    + `ОТСУТСТВУЕТ (каталог от ${new Date(catalogTsByBk.get(bk)).toISOString().slice(0, 10)}, `
                    + `${known.size} моделей) — либо каталог протух, либо шлюз убрал модель `
                    + `(keepalive-proxy.js:891 availableTarget подставит живую замену)`);
            }
            // Каталог у bk есть, а модель тир-только → всё равно проставим ts шлюза:
            // потребителю важно знать, насколько свежо наше знание об этом шлюзе.
            if (!e.catalog_ts && catalogTsByBk.has(bk)) {
                const ts = catalogTsByBk.get(bk);
                e.catalog_ts = new Date(ts).toISOString();
                e.catalog_stale_days = staleDays(ts);
            }
        }
    }
    warnings.push(...tierMisses);

    // ── aliases: под какими именами клиент может попросить эту модель ────────────
    // Пул известных клиентских имён на шлюз = его каталог + цели его тир-карты +
    // канон. Плюс `[1m]`-варианты: суффикс — клиентская метка, ремап её срезает
    // (frontdoor-proxy.js:250-252), а в журнал он попадает как есть.
    for (const [bk, mm] of Object.entries(tierMaps)) {
        const pool = new Set(CANONICAL_CLIENT_MODELS.map(norm));
        for (const t of TIERS) if (mm[t]) pool.add(mm[t]);
        const known = catModels.get(bk);
        if (known) for (const m of known.keys()) pool.add(m);
        const withSuffix = [];
        for (const p of pool) withSuffix.push(p + '[1m]');
        for (const p of withSuffix) pool.add(p);

        for (const { tier, re } of TIER_RE) {
            const target = mm[tier];
            if (!target) continue;
            const e = get(bk, target);
            for (const name of pool) {
                if (!re.test(name)) continue;
                if (norm(strip1m(name)) === norm(target)) continue;   // сама себя не алиас
                e._aliases.add(name);
            }
        }
    }

    const out = [...entries.values()].map(e => {
        e.aliases = [...e._aliases].sort();
        delete e._aliases;
        if (!e.source) e.source = 'tier';
        return e;
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

    // ── шлюзы ────────────────────────────────────────────────────────────────────
    // Сводки здесь предпосчитаны НАМЕРЕННО. Каталогов на диске 620 уникальных имён, и
    // если фронт будет считать их сам по `entries`, вкладку зальёт списком. Карточка
    // рисуется одной свёрнутой строкой вида «GoRouter · ещё 2 модели в каталоге ▸», и
    // числа для неё берутся отсюда: `models_in_catalog` − `models_in_tier`.
    const legacyBk = parseLegacyBk(warnings);
    const noCatalogBk = [];
    const gateways = gwList.map(g => {
        const models = catModels.get(g.bk);
        const ts = catalogTsByBk.get(g.bk) || null;
        const rows = (GW_NOTES[g.bk] || []).map(r => ({ note: r.note, details: r.details }));

        // Сколько РАЗНЫХ моделей стоит в тир-карте шлюза. Не число тиров: у ar все три
        // тира смотрят в `claude-opus-5`, и это ОДНА модель, а не три.
        const mm = tierMaps[g.bk] || {};
        const tierTargets = new Set(TIERS.map(t => mm[t]).filter(Boolean));

        if (!models || !models.size) {
            noCatalogBk.push(g.bk);
            rows.push({
                note: 'Каталог с диска не снят — есть только пожелание тир-карты',
                details: `Каталог шлюза НЕ снят: в custom-models-cache.json нет записи по ${g.host}. `
                    + `Всё, что мы про него «знаем», — это пожелание тир-карты, а не факт наличия моделей. `
                    + `На вопрос «какие модели у шлюза есть» ответа с диска нет.`,
            });
        }
        const sd = staleDays(ts);
        if (sd != null && sd >= 7) {
            rows.push({
                note: `Каталог протух: ${sd} дн. (снят ${new Date(ts).toISOString().slice(0, 10)})`,
                details: `Каталог снят ${new Date(ts).toISOString()}, ${sd} суток назад. Сверять с ним `
                    + `«что есть у шлюза» уже нельзя: модели пропадают молча — 03.09 justwoker убрал `
                    + `claude-opus-4-8, и 255 запросов сабагентов легли (keepalive-proxy.js:139-141).`,
            });
        }

        for (const r of rows) {
            if (r.note.length > NOTE_LIMIT) {
                warnings.push(`${g.bk}: заметка длиннее ${NOTE_LIMIT} символов (${r.note.length}) — `
                    + `она идёт плашкой на карточку и разорвёт её: «${r.note.slice(0, 60)}…». `
                    + `Длинный текст место имеет только в details`);
            }
        }

        return {
            bk: g.bk, label: g.label, host: g.host,
            flat_rate: flatHosts.has(g.host),
            subscription: SUBSCRIPTION_BK.has(g.bk),
            models_in_catalog: models ? models.size : 0,
            models_in_tier: tierTargets.size,
            catalog_ts: ts ? new Date(ts).toISOString() : null,
            catalog_stale_days: sd,
            legacy: legacyBk.has(g.bk),
            notes: rows.map(r => r.note),
            details: rows.map(r => r.details),
        };
    });

    // 🔴 Шесть шлюзов из десяти без каталога — это не сбой чтения, а свойство источника.
    // `custom-models-cache.json` наполняет сканер КАСТОМ-ПРОВАЙДЕРОВ (вкладка «Кастом»),
    // и в него попадает только тот baseUrl, который завели там руками. Четыре шлюза
    // (gorouter, tabi, hcnsec, xpeach) в кеше есть ровно потому, что их однажды завели
    // ещё и как кастом-провайдера. Отдельного «снять /v1/models со всех шлюзов» у нас нет.
    if (noCatalogBk.length) {
        warnings.push(`КАТАЛОГОВ НА ДИСКЕ НЕТ у ${noCatalogBk.length} шлюзов из ${gwList.length}: `
            + `${noCatalogBk.join(', ')}. Причина не в чтении: custom-models-cache.json наполняет `
            + `сканер кастом-провайдеров и держит только те baseUrl, что завели во вкладке «Кастом» `
            + `(остальные четыре попали туда потому, что их завели ещё и как кастом-провайдера). `
            + `Для этих шлюзов ответа «какие модели существуют» с диска НЕТ — есть только пожелание `
            + `тир-карты (source: 'tier'). Факт добудет проба, не этот модуль.`);
    }

    // ── одиннадцатая карточка: bk = custom ───────────────────────────────────────
    // 🔴 В MONEY_GW её нет и быть не может — это не денежный шлюз, а вкладка «Кастом».
    // Но в `entries` под `custom` лежит БОЛЬШИНСТВО инвентаря, и без строки-родителя
    // фронту нечем свернуть самую большую группу: она высыпется списком, а условие
    // владельца — «чтобы оно визуально не захламляло». Поэтому строка есть, и она
    // намеренно НЕ похожа на шлюз: `host: null`, `flat_rate: null`.
    //
    // 🪤 `models_in_catalog` здесь — число УНИКАЛЬНЫХ имён, а не сумма по каталогам.
    // Так же, как у остальных десяти (там `catModels.get(bk).size`), и так же, как
    // длина раскрытого списка. Сырая сумма по baseUrl больше: одну и ту же модель
    // отдают несколько провайдеров. Если положить сюда сумму, свёрнутая строка обещала
    // бы больше, чем покажет раскрытие, — ровно та рассинхронизация, из-за которой
    // потом не верят числам. Сырая сумма сохранена в notes/details.
    {
        const models = catModels.get('custom');
        const size = models ? models.size : 0;
        const tierTargets = new Set([...TIERS.flatMap(t => [...customTierAll[t]])].filter(Boolean));
        const ts = customTsMax;
        const sd = staleDays(ts);
        const day = v => new Date(v).toISOString().slice(0, 10);
        const spread = (customTsMin != null && customTsMax != null)
            ? Math.floor((customTsMax - customTsMin) / 864e5) : null;

        const rows = [{
            note: `Провайдеров ${providers.length}, все бесплатные`,
            details: `Это не шлюз, а вкладка «Кастом»: ${providers.length} провайдеров из `
                + `custom-providers.json, каталоги — ${customBaseUrls} baseUrl из custom-models-cache.json. `
                + `flat_rate = null означает free: это бесплатные эндпоинты, платного тарифа у них нет по `
                + `определению — иначе их бы в хабе не было (решение владельца 10.09). `
                + `В журнале все они лежат под одним bk=custom `
                + `(~/.claude/backends.json → provider custom, upstream localhost:20156), поэтому `
                + `восстановить провайдера по строке журнала нельзя.`,
        }, {
            // 🪤 Числа СТОЯТ ПОСЛЕ существительных намеренно: заметка видна человеку, а
            // «931 моделей» / «21 суток» — брак согласования, который на живых данных
            // всплывает то тут, то там. Порядок «слово, число» его снимает целиком.
            note: `Каталогов ${customBaseUrls}, моделей ${customRawModels}, уникальных имён ${size}`,
            details: `Сырая сумма по каталогам — ${customRawModels}, уникальных имён — ${size}: одну и ту же `
                + `модель отдают несколько провайдеров. В models_in_catalog стоит ${size} (уникальные), `
                + `чтобы свёрнутая строка обещала ровно столько, сколько покажет раскрытие.`,
        }];
        if (spread != null && spread >= 7) {
            rows.push({
                note: `Каталоги снимались вразнобой: разброс дат ${spread} дн.`,
                details: `Самый старый каталог снят ${day(customTsMin)}, самый свежий ${day(customTsMax)} — `
                    + `разброс ${spread} суток. catalog_ts/catalog_stale_days на этой карточке — по САМОМУ `
                    + `СВЕЖЕМУ, то есть это оптимистичная оценка: у отдельных провайдеров знание старше. `
                    + `Точный возраст каждой модели — в её записи entries.catalog_ts.`,
            });
        }
        if (tierTargets.size > TIERS.length) {
            rows.push({
                note: `Цели тир-карт разъезжаются: ${tierTargets.size} разных на три тира`,
                details: `У ${providers.length} провайдеров ${tierTargets.size} разных целей modelMap на три `
                    + `тира — карта у каждого своя. Поле tier у записей bk=custom поэтому условно: в entries `
                    + `тир проставлен по первой непустой цели, а фактическую выбирает тот провайдер, `
                    + `на который ушёл запрос.`,
            });
        }
        for (const r of rows) {
            if (r.note.length > NOTE_LIMIT) {
                warnings.push(`custom: заметка длиннее ${NOTE_LIMIT} символов (${r.note.length}) — `
                    + `она идёт плашкой на карточку и разорвёт её: «${r.note.slice(0, 60)}…»`);
            }
        }

        gateways.push({
            bk: 'custom', label: 'Кастом-провайдеры', host: null,
            // null, НЕ false: тарифы 18 провайдеров разные и ни один не замерен.
            flat_rate: null,
            subscription: false,
            models_in_catalog: size,
            models_in_tier: tierTargets.size,
            catalog_ts: ts ? new Date(ts).toISOString() : null,
            catalog_stale_days: sd,
            legacy: false,
            notes: rows.map(r => r.note),
            details: rows.map(r => r.details),
        });
    }

    warnings.push(`источники: ${Object.keys(TIER_MAP_FILES).length} тир-карт, `
        + `${baseUrls} baseUrl в custom-models-cache.json (${catalogModels} моделей, `
        + `${emptyCatalogs} пустых каталогов), ${providers.length} кастом-провайдеров, `
        + `${gwList.length} шлюзов в MONEY_GW`);

    // ── totals ───────────────────────────────────────────────────────────────────
    // `tier_only` / `catalog_only` — это не статистика для красоты, а два ПРОТИВОПОЛОЖНЫХ
    // риска, и путать их нельзя:
    //   tier_only    — мы просим модель, которой в снятом каталоге нет. Ровно этот случай
    //                  ронял 255 запросов 03.09 (keepalive-proxy.js:139-141).
    //   catalog_only — модель у шлюза есть, а мы её никогда не просим. Это и есть тот
    //                  «хвост», который нельзя разворачивать на вкладке по умолчанию.
    const totals = {
        entries: out.length,
        // 🪤 11, а не 10: десять денежных шлюзов из MONEY_GW плюс карточка bk=custom.
        // Кому нужны именно денежные — `money_gateways`.
        gateways: gateways.length,
        money_gateways: gwList.length,
        tier_only: out.filter(e => e.source === 'tier').length,
        catalog_only: out.filter(e => e.source === 'catalog').length,
        both: out.filter(e => e.source === 'both').length,
    };

    return { entries: out, gateways, totals, warnings };
}

module.exports = { catalog };
