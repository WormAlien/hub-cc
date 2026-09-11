'use strict';
// routing/health-probe.js — ручная проверка «модель РЕАЛЬНО отвечает».
//
// ЗАЧЕМ. Все существующие пробы (`arProbe`, `goProbe`, `kkProbe` …) спрашивают
// `GET /v1/models` — то есть «жив ли КЛЮЧ». Владельцу нужно другое: «выдаёт ли
// модель ответ». Ключ бывает валиден, а конкретная модель у шлюза отсутствует,
// подменена или молчит — `/models` этого не видит. Здесь один настоящий запрос
// «привет» на модель и честный вывод по телу ответа.
//
// РОУТЫ ЗДЕСЬ НЕ РЕГИСТРИРУЮТСЯ. Модуль только экспортирует функции; HTTP-обвязку
// вешает дашборд. Ни таймеров, ни автозапуска при `require` — проба стоит денег,
// поэтому запускается ТОЛЬКО явным вызовом.
//
// ── Четыре инварианта, которые нельзя снимать «рефакторингом» ──────────────────
//
// 1) 🔴 ХОДИМ НАПРЯМУЮ НА АПСТРИМ-ХОСТ ШЛЮЗА. Ни через keepalive (:201xx), ни через
//    front-door (:20100). Причина не в скорости: `frontdoor-proxy.js:480` вешает
//    `createTap` на трубу и пишет КАЖДЫЙ прошедший через порт ответ в
//    `routing/token-usage.jsonl`. Пробники попали бы в тот самый журнал, на котором
//    построена вся статистика расхода, и отравили бы её — а поверх ещё и всплеск
//    5xx без 2xx в одном окне поднял бы ложную тревогу «пул исчерпан» в
//    `pool-watchdog.js` (он ловит ровно этот признак по `stats.byStatus` keepalive).
//    Отсюда: base-url в GATEWAYS — публичные https-хосты из MONEY_GW, `localhost`
//    в этом файле не встречается вообще, на это стоит ассерт в selftest.
//
// 2) 🔴 `max_tokens` ≥ 64. Не 1 и не 5. На reasoning-моделях (`kimi-k3` и родня)
//    весь бюджет уходит в `reasoning_content`/`thinking`, текстовых блоков в ответе
//    нет — и проба на 5 токенах вернула бы «модель не отвечает» на полностью живой
//    модели. Существующий `customDetectProtocol` живёт с `max_tokens: 1` законно:
//    он определяет ПРОТОКОЛ по коду ответа, а не читает текст.
//
// 3) 🔴 РЕЗУЛЬТАТЫ ТОЛЬКО В `routing/model-probe.jsonl`. В `token-usage.jsonl` не
//    пишем ни при каких обстоятельствах — см. п.1.
//
// 4) 🔴 СМЕТА ДО ЗАПУСКА. `estimate()` не делает ни одного сетевого вызова и
//    вызывается из `startRun()` раньше первого запроса.
//
// ── Деньги (keepalive-proxy.js:455-480) ───────────────────────────────────────
// Восемь хостов берут ПЛОСКО ЗА ЗАПРОС — «привет» там стоит столько же, сколько
// полный рабочий ход. Поэтому проба по пулу — это не «бесплатно посмотреть».
// 🪤 `kktoken.cc` вдобавок ИГНОРИРУЕТ `max_tokens`: брошенную на таймауте пробу
// апстрим досчитывает до конца и выставляет полный счёт. `abort` там не экономит
// ничего — единственная экономия это не запускать пробу.
// `true-sota.com` приклеивает к каждому запросу свой префикс 4.1–6.9 тыс. токенов
// (тариф подписочный — проба ест квоту плана).
//
// ── Низкий баланс: не пробовать ───────────────────────────────────────────────
// New API преавторизует ~$0.80 под запрос (`transparent-proxy.js:18665`). Проба по
// ключу с низким остатком вернёт отказ преавторизации, а тот способен дёрнуть
// `moneyRotate` — и он перепишет `~/.claude/<gw>-active-key.txt`, который каждый
// живой запрос Claude Code перечитывает. То есть диагностическая проба подменила бы
// ключ под работающим человеком. Поэтому заведомо низкий баланс = `skipped`.

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─────────────────────────── Константы запроса ───────────────────────────

// 🪤 Клампим снизу, а не просто читаем env: 64 — это инвариант (п.2), а не вкус.
const MAX_TOKENS = Math.max(64, Number(process.env.PROBE_MAX_TOKENS) || 64);
const TIMEOUT_MS = Math.max(1000, Number(process.env.PROBE_TIMEOUT_MS) || 20_000);
// Домашняя идиома конкурентности (`transparent-proxy.js:8470-8474`): порциями по 3
// через `for (i += 3) await Promise.all(slice)`. Три — не «побольше»: на плоском
// тарифе каждая проба это деньги, а на другом конце живой пул.
const CONCURRENCY = 3;
const PROMPT = 'привет';
const RESULTS_FILE = path.join(__dirname, 'model-probe.jsonl');
// Хвост, который читаем из журнала. Файл append-only и растёт; читать целиком ради
// последних результатов незачем.
const TAIL_BYTES = 2 * 1024 * 1024;

// Зеркало `FLAT_RATE_HOSTS` (keepalive-proxy.js:479). Копия, а не require: тянуть
// keepalive-proxy ради одного Set значит выполнить весь его модуль-скоуп (он читает
// env, считает конфиг и логирует) — для сметы это лишние побочные эффекты.
// 🪤 Строки обязаны совпадать байт в байт с оригиналом; на это стоит ассерт.
const FLAT_RATE_HOSTS = new Set([
    'tabitoken.com',
    'gorouter.app',
    'xpeach.codes',
    'api.justwoker.icu',
    'seekai.cc',
    'true-sota.com',
    'kktoken.cc',
    'emtf.aipm9527.online',
]);

// ─────────────────────────── Реестр шлюзов ───────────────────────────
//
// Зеркало `MONEY_GW` (transparent-proxy.js:18802) + базовые URL из тех же
// `<XX>_BASE_URL`. `host` — та же строка, что в MONEY_GW/GW_BY_HOST, по ней
// считается плоский тариф.
//
// 🪤 `base` у `ar`/`tb`/`xp` — БЕЗ `/v1`, у остальных С ним. Это не небрежность, а
// то, как заведено в проде: у части шлюзов `usage` живёт на корне, у части `/v1`
// обязателен. Разнобой снимает `messagesCandidates()`, руками его не «выравнивать».
const GATEWAYS = {
    ar: { tag: 'agentrouter', label: 'AgentRouter', host: 'agentrouter.org',        base: 'https://agentrouter.org',           keyName: 'ar',        waf: true },
    go: { tag: 'gorouter',    label: 'GoRouter',    host: 'gorouter.app',           base: 'https://gorouter.app/v1',           keyName: 'gorouter' },
    tb: { tag: 'tabi',        label: 'Tabi Token',  host: 'tabitoken.com',          base: 'https://tabitoken.com',             keyName: 'tabi' },
    xp: { tag: 'xpeach',      label: 'XPeach',      host: 'xpeach.codes',           base: 'https://xpeach.codes',              keyName: 'xpeach' },
    jw: { tag: 'justwoker',   label: 'JustWoker',   host: 'api.justwoker.icu',      base: 'https://api.justwoker.icu/v1',      keyName: 'justwoker' },
    sk: { tag: 'seekai',      label: 'SeekAi',      host: 'seekai.cc',              base: 'https://seekai.cc/v1',              keyName: 'seekai' },
    // 🪤 TrueSOTA — единственный не New-API (sub2api): тариф подписочный, «баланс» в
    // сессиях там не деньги. Поэтому порог низкого остатка к нему не применяем.
    ts: { tag: 'truesota',    label: 'TrueSOTA',    host: 'true-sota.com',          base: 'https://true-sota.com/v1',          keyName: 'truesota', subscription: true },
    kk: { tag: 'kktoken',     label: 'KKtoken',     host: 'kktoken.cc',             base: 'https://kktoken.cc/v1',             keyName: 'kktoken',  ignoresMaxTokens: true },
    // minBal 0.10 — как в MONEY_GW (у AIPM свой порог, аккаунты там центовые).
    ap: { tag: 'aipm',        label: 'AIPM',        host: 'emtf.aipm9527.online',   base: 'https://emtf.aipm9527.online/v1',   keyName: 'aipm',     minBal: 0.10 },
    hn: { tag: 'hcnsec',      label: 'HCNsec',      host: 'api.hcnsec.cn',          base: 'https://api.hcnsec.cn/v1',          keyName: 'hcnsec' },
};

// Порог «ниже этого пробовать нельзя» — `MONEY_MIN_BAL` (transparent-proxy.js:18665
// и рядом). $2 при преавторизации $0.80 = запас на два-три запроса.
const MIN_BAL = 2.0;
function minBal(gw) { return typeof gw.minBal === 'number' ? gw.minBal : MIN_BAL; }

// Принимаем и префикс (`go`), и тег (`gorouter`), и `label` в любом регистре: в UI и
// в вызовах ходят все три написания, а падать на регистре — глупая причина потерять
// прогон. Ключ результата всегда нормализуем к тегу.
const ALIASES = (() => {
    const m = new Map();
    for (const [pfx, gw] of Object.entries(GATEWAYS)) {
        m.set(pfx, pfx);
        m.set(gw.tag.toLowerCase(), pfx);
        m.set(gw.label.toLowerCase(), pfx);
        m.set(gw.host.toLowerCase(), pfx);
    }
    return m;
})();

function resolveGw(bk) {
    const k = String(bk || '').trim().toLowerCase();
    const pfx = ALIASES.get(k);
    return pfx ? { pfx, ...GATEWAYS[pfx] } : null;
}

function isFlatRate(gw) { return FLAT_RATE_HOSTS.has(gw.host); }

// ─────────────────────────── Ключ и остаток ───────────────────────────

// Тот же предикат, что `isRealKey` (transparent-proxy.js:7499): заглушки в пулах
// имеют вид `no-key-<rnd>`, живые ключи все `sk-…` (проверено по десяти пулам).
function isRealKey(k) { return /^sk-/.test(String(k || '').trim()); }

function keyFilePath(gw) {
    return path.join(os.homedir(), '.claude', gw.keyName + '-active-key.txt');
}
function sessionsFilePath(gw) {
    return path.join(__dirname, gw.tag + '-sessions.json');
}

function loadSessions(gw) {
    try {
        const raw = fs.readFileSync(sessionsFilePath(gw), 'utf8');
        // BOM режем как в `arLoad`: файлы правились разными редакторами.
        const j = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        if (Array.isArray(j)) return j;
        return Array.isArray(j && j.sessions) ? j.sessions : [];
    } catch { return []; }
}

// Ключ: сначала файл активного ключа (его же читает каждый живой запрос Claude
// Code — значит именно он «текущий»), потом активная запись пула. Порядок важен:
// пул может содержать активным другой аккаунт, а работаем мы тем, что в файле.
function activeKey(gw) {
    try {
        const k = fs.readFileSync(keyFilePath(gw), 'utf8').trim();
        if (isRealKey(k)) return { key: k, from: 'key-file' };
    } catch { /* файла может не быть — у ts его нет вовсе */ }
    const sessions = loadSessions(gw);
    const s = sessions.find(x => x && x.active && isRealKey(x.api_key))
        || sessions.find(x => x && isRealKey(x.api_key));
    return s ? { key: String(s.api_key).trim(), from: 'sessions' } : { key: null, from: null };
}

// Остаток по ключу. `null` = НЕИЗВЕСТНО, и это не то же самое, что ноль: у hcnsec
// баланс в сессиях `null`, у truesota его нет вовсе. Неизвестный остаток пробу не
// блокирует — иначе мы молча выключили бы половину реестра.
function keyBalance(gw, key) {
    if (gw.subscription) return null;
    const s = loadSessions(gw).find(x => x && String(x.api_key || '').trim() === key);
    const b = s ? s.balance : null;
    return typeof b === 'number' && Number.isFinite(b) ? b : null;
}

// Единственное место, где решается «пробовать или пропустить». Возвращает причину
// пропуска либо null.
function skipReason(gw, key, balance) {
    if (!isRealKey(key)) return 'no-key';
    if (balance !== null && balance < minBal(gw)) return 'low-balance';
    return null;
}

// ─────────────────────────── URL запроса ───────────────────────────

// Обобщение `customDetectProtocol()` (transparent-proxy.js:3956-3971): там уже решён
// разнобой `/v1` — у части шлюзов он в базовом URL есть, у части нет.
//
// 🪤 ПОРЯДОК КАНДИДАТОВ ОБРАТНЫЙ оригиналу, и это осознанно. В `customDetectProtocol`
// протокол неизвестен и первым идёт `base + '/messages'`. Здесь хосты известны, все
// говорят Anthropic, и канонический путь у всех `<корень>/v1/messages` — ставим его
// первым. Иначе для `ar`/`tb`/`xp` (база без `/v1`) первым улетал бы `/messages`, а
// он у части шлюзов отдаёт 200 С HTML — «потеря даст мусор, не ошибку»
// (transparent-proxy.js:207-209). Второй кандидат остаётся страховкой на случай
// шлюза, у которого messages лежит на корне.
function messagesCandidates(base) {
    const b = String(base || '').replace(/\/+$/, '');
    const clean = b.replace(/\/v1$/, '');
    const out = [];
    const push = u => { if (u && !out.includes(u)) out.push(u); };
    push(clean + '/v1/messages');
    push(b + '/messages');
    return out;
}

function probeHeaders(gw, key) {
    const h = {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-cli/2.1.158 (external, sdk-cli)',
    };
    // 🪤 У agentrouter WAF отбивает всё, что не похоже на Claude Code (см. коммент к
    // AR_SESSIONS_FILE). Без этих заголовков проба вернула бы 403 — и была бы прочитана
    // как «модель не отвечает», хотя модель ни при чём. Набор — копия `AR_CC_HEADERS`.
    if (gw.waf) {
        h['anthropic-beta'] = 'claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12';
        h['anthropic-dangerous-direct-browser-access'] = 'true';
        h['x-app'] = 'cli';
    }
    return h;
}

// ─────────────────────────── Разбор ответа ───────────────────────────

// Текст ответа. Основной формат — Anthropic (`content[]` с блоками `text`), но
// у части шлюзов-конвертеров проскакивает OpenAI-форма; вторая ветка это страховка,
// а не поддержка второго протокола.
function extractText(j) {
    if (!j || typeof j !== 'object') return '';
    if (Array.isArray(j.content)) {
        return j.content
            .filter(b => b && b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text)
            .join('')
            .trim();
    }
    const ch = Array.isArray(j.choices) ? j.choices[0] : null;
    const c = ch && ch.message ? ch.message.content : null;
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) return c.map(x => (x && typeof x.text === 'string' ? x.text : '')).join('').trim();
    return '';
}

// Сколько токенов шлюз списал на выход. Нужно ровно для одного вывода: текст пуст,
// но выход не нулевой → бюджет съел reasoning, модель РАБОТАЕТ (инвариант п.2).
function outputTokens(j) {
    const u = (j && j.usage) || {};
    for (const k of ['output_tokens', 'completion_tokens', 'total_output_tokens']) {
        if (typeof u[k] === 'number' && Number.isFinite(u[k])) return u[k];
    }
    return 0;
}

// Есть ли в ответе reasoning/thinking — второй признак того же (некоторые шлюзы
// usage не отдают вовсе).
function hasReasoning(j) {
    if (!j || typeof j !== 'object') return false;
    if (Array.isArray(j.content) && j.content.some(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking' || typeof b.reasoning_content === 'string'))) return true;
    const ch = Array.isArray(j.choices) ? j.choices[0] : null;
    const m = ch && ch.message;
    return !!(m && (m.reasoning_content || m.reasoning));
}

function clip(s, n = 200) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
}

// ─────────────────────────── Журнал ───────────────────────────

// Строка на пробу, append. 🔴 Только этот файл — `token-usage.jsonl` не наш (п.3).
function appendResult(rec) {
    try {
        fs.appendFileSync(RESULTS_FILE, JSON.stringify(rec) + '\n', 'utf8');
    } catch (e) {
        // Молча терять результат нельзя, но и валить прогон из-за журнала — тоже:
        // проба уже оплачена, ответ важнее записи.
        try { process.stderr.write(`[health-probe] журнал недоступен: ${e.message}\n`); } catch {}
    }
}

// Хвост файла. Читаем не целиком: журнал append-only и со временем распухнет, а нужны
// последние записи. Первую (возможно обрезанную) строку отбрасываем при offset > 0.
function readTailLines(file, maxBytes) {
    let fd = null;
    try {
        const st = fs.statSync(file);
        if (!st.size) return [];
        const start = Math.max(0, st.size - maxBytes);
        const len = st.size - start;
        const buf = Buffer.alloc(len);
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, len, start);
        const lines = buf.toString('utf8').split('\n');
        if (start > 0) lines.shift();
        return lines.filter(Boolean);
    } catch { return []; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

// ─────────────────────────── Смета (БЕЗ СЕТИ) ───────────────────────────

// Нормализация входа. Принимаем `[{bk, m}]`, `[{bk, model}]`, `[[bk, m]]`,
// `['gorouter|claude-opus-5']` — вызовов будет несколько (UI, консоль, роут другого
// агента), и разбирать формат в каждом из них хуже, чем один раз здесь.
function normalizePairs(pairs) {
    const out = [];
    for (const raw of Array.isArray(pairs) ? pairs : []) {
        let bk, m;
        if (Array.isArray(raw)) { [bk, m] = raw; }
        else if (raw && typeof raw === 'object') { bk = raw.bk ?? raw.gw ?? raw.backend; m = raw.m ?? raw.model; }
        else if (typeof raw === 'string' && raw.includes('|')) { [bk, m] = raw.split('|'); }
        else continue;
        bk = String(bk || '').trim();
        m = String(m || '').trim();
        if (!bk || !m) continue;
        const gw = resolveGw(bk);
        // Ключ результата — по ТЕГУ, а не по тому, как пару написал вызывающий:
        // иначе `go` и `gorouter` разъедутся в две записи об одном и том же.
        const key = (gw ? gw.tag : bk.toLowerCase()) + '|' + m;
        if (out.some(p => p.key === key)) continue;   // дедуп: платить дважды за одно незачем
        out.push({ bk: gw ? gw.tag : bk, m, key, gw });
    }
    return out;
}

// 🔴 estimate — БЕЗ ЕДИНОГО СЕТЕВОГО ЗАПРОСА (инвариант п.4). Читает только диск:
// реестр, файл активного ключа, `<tag>-sessions.json`.
function estimate(pairs) {
    const list = normalizePairs(pairs);
    const per_gateway = {};
    const warnings = [];
    let flat_rate = 0, free = 0, skipped = 0, unknown = 0;

    for (const p of list) {
        if (!p.gw) {
            unknown++;
            if (!warnings.includes(`неизвестный шлюз: ${p.bk}`)) warnings.push(`неизвестный шлюз: ${p.bk}`);
            continue;
        }
        const gw = p.gw;
        let g = per_gateway[gw.tag];
        if (!g) {
            const { key, from } = activeKey(gw);
            const balance = key ? keyBalance(gw, key) : null;
            g = per_gateway[gw.tag] = {
                label: gw.label,
                host: gw.host,
                flat_rate: isFlatRate(gw),
                subscription: !!gw.subscription,
                has_key: isRealKey(key),
                key_from: from,
                balance,
                min_balance: minBal(gw),
                skip: skipReason(gw, key, balance),
                count: 0,
                models: [],
            };
        }
        g.count++;
        g.models.push(p.m);
        if (g.skip) { skipped++; continue; }
        if (g.flat_rate) flat_rate++; else free++;
    }

    // Предупреждения — по фактическому составу прогона, а не «на все случаи».
    for (const [tag, g] of Object.entries(per_gateway)) {
        if (g.skip === 'no-key') warnings.push(`${tag}: нет живого ключа — ${g.count} проб(ы) будут пропущены`);
        if (g.skip === 'low-balance') warnings.push(`${tag}: баланс $${g.balance} < $${g.min_balance} — пропускаем, иначе отказ преавторизации может дёрнуть moneyRotate и подменить активный ключ`);
        if (g.skip) continue;
        if (tag === 'kktoken') warnings.push('kktoken: игнорирует max_tokens, брошенная проба оплачивается целиком');
        if (tag === 'truesota') warnings.push('truesota: приклеивает префикс 4.1–6.9к токенов к каждому запросу, тариф подписочный — проба ест квоту плана');
        else if (g.flat_rate && tag !== 'kktoken') warnings.push(`${tag}: плоский тариф — «привет» стоит столько же, сколько полный ход`);
    }
    if (flat_rate > 0) {
        warnings.unshift(`${flat_rate} из ${list.length} проб(ы) идут на хосты с плоским тарифом — это реальные деньги, а не «посмотреть»`);
    }

    return {
        total: list.length,
        flat_rate,
        free,
        skipped,
        unknown,
        max_tokens: MAX_TOKENS,
        timeout_ms: TIMEOUT_MS,
        concurrency: CONCURRENCY,
        warnings,
        per_gateway,
    };
}

// ─────────────────────────── Одна проба ───────────────────────────

function nowIso() { return new Date().toISOString(); }

// probeOne никогда не бросает: прогон из трёх параллельных проб не должен умирать
// целиком из-за одной сетевой ошибки.
async function probeOne(bk, model) {
    const m = String(model || '').trim();
    const gw = resolveGw(bk);
    const base = {
        t: nowIso(),
        bk: gw ? gw.tag : String(bk || '').trim(),
        m,
        ok: false,
        reason: null,
        ttfb_ms: null,
        total_ms: null,
        swapped_to: null,
    };

    if (!gw) { const r = { ...base, reason: 'unknown-gateway' }; appendResult(r); return r; }
    if (!m) { const r = { ...base, reason: 'no-model' }; appendResult(r); return r; }

    const { key } = activeKey(gw);
    const balance = key ? keyBalance(gw, key) : null;
    const skip = skipReason(gw, key, balance);
    if (skip) {
        // 🔴 Ни одного сетевого вызова: смысл пропуска ровно в этом.
        const r = { ...base, skipped: skip, reason: skip, balance };
        appendResult(r);
        return r;
    }

    const urls = messagesCandidates(gw.base);
    const headers = probeHeaders(gw, key);
    const body = JSON.stringify({
        model: m,
        max_tokens: MAX_TOKENS,          // 🔴 ≥ 64, инвариант п.2
        messages: [{ role: 'user', content: PROMPT }],
        // stream не ставим вовсе — не-стрим это дефолт, а лишнее поле некоторые
        // конвертеры принимают хуже, чем его отсутствие.
    });

    let last = null;
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const hasNext = i < urls.length - 1;
        const t0 = Date.now();
        let ttfb = null;
        try {
            const r = await fetch(url, {
                method: 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            ttfb = Date.now() - t0;
            const raw = await r.text().catch(() => '');
            const total = Date.now() - t0;

            // Роута нет → пробуем следующего кандидата (та же логика, что в
            // customDetectProtocol). Ничего не стоит: генерации не было.
            if ((r.status === 404 || r.status === 405) && hasNext) { last = { status: r.status, raw, ttfb, total, url }; continue; }

            if (!r.ok) {
                const res = { ...base, url, ttfb_ms: ttfb, total_ms: total, reason: `${r.status} ${clip(raw)}` };
                appendResult(res);
                return res;
            }

            let j = null;
            try { j = JSON.parse(raw); } catch { j = null; }
            // 🪤 200 с HTML — реальный сценарий на неверном пути (см. коммент к
            // messagesCandidates). Молча принять его = записать мусор как успех.
            if (!j || typeof j !== 'object') {
                if (hasNext) { last = { status: r.status, raw, ttfb, total, url }; continue; }
                const res = { ...base, url, ttfb_ms: ttfb, total_ms: total, reason: `non-json ${clip(raw)}` };
                appendResult(res);
                return res;
            }

            // Имя модели В ОТВЕТЕ. Мы идём напрямую, без keepalive, значит MODEL_ECHO
            // тут не работает и видно настоящее внутреннее имя шлюза — ровно то, что
            // нужно, чтобы поймать подмену модели.
            const got = typeof j.model === 'string' ? j.model : null;
            const swapped_to = got && got !== m ? got : null;

            const text = extractText(j);
            const out = outputTokens(j);
            const res = { ...base, url, ttfb_ms: ttfb, total_ms: total, swapped_to, out_tokens: out };

            if (text) { res.ok = true; res.reason = null; res.text = clip(text, 120); }
            else if (out > 0 || hasReasoning(j)) {
                // Инвариант п.2 в действии: текста нет, но выход не нулевой — бюджет
                // съел reasoning. Модель РАБОТАЕТ, это не отказ.
                res.ok = true; res.note = 'reasoning'; res.reason = null;
            } else if (j.error) { res.ok = false; res.reason = `error ${clip(j.error.message || JSON.stringify(j.error))}`; }
            else { res.ok = false; res.reason = 'empty-body'; }

            appendResult(res);
            return res;
        } catch (e) {
            const total = Date.now() - t0;
            const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError' || /timeout|aborted/i.test(String(e.message || '')));
            last = { err: e, ttfb, total, url, timeout };
            if (hasNext) continue;
            const res = {
                ...base, url,
                ttfb_ms: ttfb,
                total_ms: total,
                reason: timeout ? 'timeout' : 'network',
                // 🪤 На kktoken таймаут денег НЕ экономит: шлюз игнорирует max_tokens
                // и досчитывает брошенный ответ до конца, счёт приходит полный.
                note: timeout && gw.ignoresMaxTokens ? 'timeout-paid-in-full' : undefined,
            };
            if (res.note === undefined) delete res.note;
            appendResult(res);
            return res;
        }
    }

    // Кандидаты кончились, ни один не дал вердикта (все 404/405 или все упали).
    const res = {
        ...base,
        url: last && last.url,
        ttfb_ms: last ? last.ttfb : null,
        total_ms: last ? last.total : null,
        reason: last && last.status ? `${last.status} ${clip(last.raw)}` : (last && last.timeout ? 'timeout' : 'network'),
    };
    appendResult(res);
    return res;
}

// ─────────────────────────── Прогон ───────────────────────────

// Один прогон на процесс. Второй параллельный не нужен и вреден: пробы стоят денег,
// а два прогона по одному пулу это двойной счёт за один и тот же ответ.
const run = {
    running: false,
    runId: null,
    done: 0,
    total: 0,
    current: null,
    started_at: null,
    finished_at: null,
    estimate: null,
    results: [],
};

function startRun(pairs) {
    if (run.running) {
        // Возвращаем ТЕКУЩИЙ, второй не запускаем.
        return { runId: run.runId, total: run.total, already_running: true };
    }
    const list = normalizePairs(pairs);

    // 🔴 Инвариант п.4: смета считается ДО первого сетевого запроса.
    const est = estimate(list);

    run.running = true;
    run.runId = 'probe-' + Date.now().toString(36);
    run.done = 0;
    run.total = list.length;
    run.current = null;
    run.started_at = nowIso();
    run.finished_at = null;
    run.estimate = est;
    run.results = [];

    (async () => {
        // Домашняя идиома: порциями по CONCURRENCY (transparent-proxy.js:8470-8474).
        for (let i = 0; i < list.length; i += CONCURRENCY) {
            const slice = list.slice(i, i + CONCURRENCY);
            run.current = slice.map(p => p.key).join(', ');
            await Promise.all(slice.map(async p => {
                const r = await probeOne(p.bk, p.m);
                run.results.push(r);
                run.done++;
            }));
        }
    })().catch(e => {
        run.error = String((e && e.message) || e);
    }).finally(() => {
        run.running = false;
        run.current = null;
        run.finished_at = nowIso();
    });

    return { runId: run.runId, total: list.length };
}

function runStatus() {
    return {
        running: run.running,
        runId: run.runId,
        done: run.done,
        total: run.total,
        current: run.current,
        started_at: run.started_at,
        finished_at: run.finished_at,
        error: run.error || null,
        estimate: run.estimate,
        results: run.results.slice(),
    };
}

// Последние результаты по ключу `${bk}|${m}`. `maxAgeSec` — отсечка по свежести:
// результат недельной давности как «текущее состояние» врёт.
function readResults(opts) {
    const maxAgeSec = Number((opts || {}).maxAgeSec);
    const cutoff = Number.isFinite(maxAgeSec) && maxAgeSec > 0 ? Date.now() - maxAgeSec * 1000 : null;
    const out = {};
    for (const line of readTailLines(RESULTS_FILE, TAIL_BYTES)) {
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!r || !r.bk || !r.m) continue;
        const at = Date.parse(r.t || '');
        if (!Number.isFinite(at)) continue;
        if (cutoff !== null && at < cutoff) continue;
        const key = `${r.bk}|${r.m}`;
        // Журнал append-only и в хронологическом порядке → последняя строка побеждает.
        const prev = out[key];
        if (prev && Date.parse(prev.at) > at) continue;
        out[key] = {
            ok: !!r.ok,
            reason: r.reason ?? null,
            ttfb_ms: r.ttfb_ms ?? null,
            total_ms: r.total_ms ?? null,
            swapped_to: r.swapped_to ?? null,
            at: r.t,
            note: r.note ?? null,
            skipped: r.skipped ?? null,
        };
    }
    return out;
}

module.exports = { estimate, startRun, runStatus, readResults, probeOne };

// ─────────────────────────── Самопроверка (сеть не нужна) ───────────────────────────
// `node routing/health-probe.js selftest`. Стоит на страже четырёх инвариантов —
// чтобы «полезное улучшение» не сняло их молча. Роутов не поднимает, проб не делает.
if (require.main === module && process.argv[2] === 'selftest') {
    const assert = require('assert');
    const src = fs.readFileSync(__filename, 'utf8');

    // Инвариант 1: напрямую на апстрим. Ни localhost, ни портов 201xx в коде URL.
    for (const gw of Object.values(GATEWAYS)) {
        assert.ok(/^https:\/\//.test(gw.base), `${gw.tag}: base обязан быть https — ${gw.base}`);
        assert.ok(!/localhost|127\.0\.0\.1|:201\d\d/.test(gw.base), `${gw.tag}: base смотрит в локальный прокси — ${gw.base}`);
        for (const u of messagesCandidates(gw.base)) {
            assert.ok(!/localhost|127\.0\.0\.1|:201\d\d/.test(u), `${gw.tag}: кандидат идёт через локальный порт — ${u}`);
            assert.ok(new URL(u).hostname === gw.host, `${gw.tag}: хост кандидата ${new URL(u).hostname} ≠ ${gw.host}`);
        }
    }
    // Инвариант 3: пишем только в свой журнал. Проверяем КОД, а не текст — в
    // комментариях выше `token-usage.jsonl` упомянут законно (объясняет, почему туда
    // нельзя). Поэтому сначала срезаем комментарии, потом смотрим цели записи.
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // 🪤 Иглу собираем из кусков: иначе строка-сообщение этого же ассерта попадёт в
    // `code` и он сработает сам на себе (наступали, 2 попытки).
    const forbiddenLog = 'token' + '-' + 'usage';
    assert.ok(!code.includes(forbiddenLog), `инвариант 3: код не должен писать в чужой журнал расхода (${forbiddenLog})`);
    const writes = [...code.matchAll(/fs\.(appendFile|writeFile|createWriteStream)\w*\(\s*([A-Za-z_$][\w$]*)/g)];
    assert.ok(writes.length > 0, 'запись в журнал пропала — readResults читать будет нечего');
    for (const w of writes) {
        assert.strictEqual(w[2], 'RESULTS_FILE', `запись идёт не в RESULTS_FILE, а в ${w[2]}`);
    }
    assert.ok(/model-probe\.jsonl/.test(code), 'журнал обязан быть routing/model-probe.jsonl');

    // Инвариант 2: max_tokens ≥ 64 даже если env просит меньше.
    assert.ok(MAX_TOKENS >= 64, `max_tokens ${MAX_TOKENS} < 64`);

    // Разнобой /v1 снят: у всех шлюзов канонический путь — <хост>/v1/messages.
    for (const gw of Object.values(GATEWAYS)) {
        assert.strictEqual(messagesCandidates(gw.base)[0], `https://${gw.host}/v1/messages`, `${gw.tag}: первый кандидат не канонический`);
    }
    // 🪤 Порядок именно такой, чтобы не улететь в `/messages` (200 с HTML).
    assert.strictEqual(messagesCandidates('https://agentrouter.org')[1], 'https://agentrouter.org/messages');
    assert.strictEqual(messagesCandidates('https://gorouter.app/v1').length, 1, 'база с /v1 даёт ровно один кандидат');

    // Зеркало FLAT_RATE_HOSTS не разъехалось с keepalive-proxy.js:479.
    const ka = fs.readFileSync(path.join(__dirname, 'keepalive-proxy.js'), 'utf8');
    const mm = ka.match(/const FLAT_RATE_HOSTS = new Set\(\[([^\]]*)\]\)/);
    assert.ok(mm, 'FLAT_RATE_HOSTS в keepalive-proxy.js не найден — зеркало проверить нечем');
    const upstream = new Set([...mm[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
    assert.deepStrictEqual([...FLAT_RATE_HOSTS].sort(), [...upstream].sort(), 'зеркало FLAT_RATE_HOSTS разъехалось с keepalive-proxy.js');
    assert.strictEqual(FLAT_RATE_HOSTS.size, 8, 'плоских хостов должно быть восемь');

    // Реестр совпадает с MONEY_GW (transparent-proxy.js) по префиксам и хостам.
    const tp = fs.readFileSync(path.join(__dirname, 'transparent-proxy.js'), 'utf8');
    for (const [pfx, gw] of Object.entries(GATEWAYS)) {
        const re = new RegExp(`\\n\\s*${pfx}:\\s*\\{[^\\n]*host:\\s*'([^']+)'`);
        const m2 = tp.match(re);
        assert.ok(m2, `MONEY_GW.${pfx} не найден в transparent-proxy.js`);
        assert.strictEqual(m2[1], gw.host, `MONEY_GW.${pfx}.host = ${m2[1]}, у нас ${gw.host}`);
    }

    // Смета: без сети, дедуп, алиасы префикс/тег сходятся в один ключ.
    const e = estimate([{ bk: 'go', m: 'x' }, { bk: 'gorouter', m: 'x' }, { bk: 'kktoken', m: 'x' }]);
    assert.strictEqual(e.total, 2, 'дедуп по тегу не сработал: go и gorouter это один шлюз');
    assert.ok(e.warnings.some(w => /kktoken.*max_tokens/.test(w)), 'нет предупреждения про kktoken');
    assert.strictEqual(estimate([{ bk: 'нетакого', m: 'x' }]).unknown, 1);

    // Разбор ответа: reasoning не читается как отказ.
    assert.strictEqual(extractText({ content: [{ type: 'text', text: ' да ' }] }), 'да');
    assert.strictEqual(extractText({ content: [{ type: 'thinking', thinking: 'hmm' }] }), '');
    assert.strictEqual(outputTokens({ usage: { output_tokens: 41 } }), 41);
    assert.ok(hasReasoning({ content: [{ type: 'thinking' }] }));

    console.log('health-probe selftest: OK (сеть не использовалась, проб не сделано)');
}
