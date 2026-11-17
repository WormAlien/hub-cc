// frontdoor-proxy.js — фиксированный вход Claude Code (:20100).
//
// Зачем: `env` из ~/.claude/settings.json Claude Code читает ОДИН раз, при старте
// процесса. Пока переключение провайдера меняло ANTHROPIC_BASE_URL, каждый свич
// требовал новой сессии CC — а с Orca, где одновременно живёт несколько pty с
// `claude`, это означало перезапуск всех терминалов.
//
// Поэтому base URL больше не меняется (навсегда http://127.0.0.1:20100), а выбор
// бэкенда переехал в файл состояния ~/.claude/active-backend.json, который этот
// прокси перечитывает по mtime на каждый запрос.
//
// Контракт (docs/frontdoor-concept.md):
//   • ЛОКАЛЬНЫЙ апстрим (keepalive :2013x/:2015x, конвертеры :2013x) — чистый релей:
//     заголовки клиента без изменений, ключ не трогаем, тело не трогаем. Ключ там
//     инжектит keepalive (keepalive-proxy.js:771), маппинг тиров тоже его.
//   • УДАЛЁННЫЙ апстрим (бывшие apiKeyHelper-режимы) — читаем ключ из
//     ~/.claude/<keyFile> на каждый запрос (смена ключа на лету, авто-ротация
//     FreeModel), ставим authorization+x-api-key, срезаем суффикс окна [1m] и
//     применяем <p>-modelmap.json по mtime.
//   • НЕ ретраим и не хеджируем (это делает keepalive; дубль сожжёт платный запрос),
//     НЕ конвертим Anthropic→OpenAI (это :20130/:20131/:20132), НЕ отвечаем сами на
//     count_tokens (локальную оценку даёт keepalive), НЕ логируем ключи.
//   • Нет/битый state → 503 с внятным телом, а не молчаливый уход на дефолт.
//
// Слушаем ТОЛЬКО 127.0.0.1: прокси инжектит реальные ключи, на 0.0.0.0 это открытый релей.
//
//   PORT=20100 node frontdoor-proxy.js
//   node frontdoor-proxy.js selftest     # самопроверка, порт не занимает
'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform, pipeline } = require('node:stream');

const PORT = Number(process.env.PORT || 20100);
const LOG_FILE = process.env.LOG_FILE || '';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000);
const STATE_FILE = process.env.ACTIVE_BACKEND_FILE
    || path.join(os.homedir(), '.claude', 'active-backend.json');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const { createLogger } = require('./proxy-logger.js');
const { logLine } = createLogger('frontdoor');
const { createTap } = require('./usage-tap.js');
const {
    ApiGatewayError,
    readPublishedManifest,
    readManifest,
    toOpenAiModels,
    recognizeCallableModel,
    restoreDelegatedOpenAiObject,
    makeRedactedOpenAiError,
    A6API_PUBLIC_ERROR_MAX_BYTES,
    readA6apiPublicErrorCode,
    makeA6apiPublicError,
} = require('./lib/api-gateway.js');
const { createRequestCancellationRegistry } = require('./lib/request-cancellation.js');
const { createLocalHopAuth } = require('./lib/local-hop-auth.js');
const LOCAL_HOP_SELFTEST_FILE = process.argv[2] === 'selftest'
    ? path.join(os.tmpdir(), `abuse-hub-local-hop-frontdoor-selftest-${process.pid}.key`)
    : '';
if (LOCAL_HOP_SELFTEST_FILE) process.env.ABUSE_HUB_LOCAL_HOP_KEY_FILE = LOCAL_HOP_SELFTEST_FILE;
const localHopAuth = createLocalHopAuth();
let frontdoorRouteAuth = '';
function trustedFrontdoorRouteAuth() {
    if (!frontdoorRouteAuth) frontdoorRouteAuth = localHopAuth.token('frontdoor-to-keepalive');
    return frontdoorRouteAuth;
}
const API_GATEWAY_DEFAULT_FILE = process.env.API_GATEWAY_DEFAULT_FILE
    || path.join(__dirname, 'api-gateway.default.json');
const API_GATEWAY_FILE = process.env.API_GATEWAY_FILE
    || path.join(__dirname, 'api-gateway.json');
const CLAUDE_SETTINGS_FILE = process.env.CLAUDE_SETTINGS_FILE
    || path.join(CLAUDE_DIR, 'settings.json');
const BIFROST_URL = new URL(process.env.BIFROST_URL || 'http://127.0.0.1:20135');
if (BIFROST_URL.protocol !== 'http:' || BIFROST_URL.hostname !== '127.0.0.1'
    || !BIFROST_URL.port || BIFROST_URL.username || BIFROST_URL.password
    || BIFROST_URL.search || BIFROST_URL.hash) {
    throw new Error('BIFROST_URL must be an HTTP IPv4 loopback origin');
}
const BIFROST_INTERNAL_MARKER = process.env.BIFROST_INTERNAL_MARKER || 'abuse-hub-bifrost-v1';
const BIFROST_REQUEST_TOKEN_CARRIER = 'x-bf-eh-x-abuse-hub-request-token';
const INTERNAL_REQUEST_TOKEN_HEADER = 'x-abuse-hub-request-token';
const BIFROST_PROVIDER = 'abuse-hub';
const OPENAI_BODY_MAX_BYTES = 16 * 1024 * 1024;
const OPENAI_SSE_LINE_MAX_BYTES = 1 * 1024 * 1024;
const requestCancellationRegistry = createRequestCancellationRegistry({
    hardTtlMs: UPSTREAM_TIMEOUT_MS + 60000,
});
const claimedCallbackWork = new Set();
// Weak request identity, not a client-controlled header or global last error.
// Values are allowlisted codes only; raw callback data is never retained here.
const callbackPublicErrorCodes = new WeakMap();
const startedAt = Date.now();

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stderr.write(line);
    if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ } }
    logLine(msg);
}

// ── Состояние: единственный источник правды об активном бэкенде ───────────────
// Апстрим уже разрешён дашбордом (transparent-proxy.js → writeSettings), поэтому
// здесь НЕТ таблицы провайдеров и знания о портах: прокси только форвардит.
const stateCache = { mtime: 0, state: null, error: 'state ещё не читался' };

function parseState(raw) {
    return parseStateDoc(JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw));
}

// Разбор одной записи бэкенда. Вынесен из parseState, чтобы ТЕМ ЖЕ кодом читались
// записи реестра backends.json: у них та же форма, и расхождение разборов означало бы
// «через префикс работает, а через активный нет» — самый неотлаживаемый класс багов.
function parseStateDoc(doc) {
    const upstream = String(doc.upstream || '').trim();
    if (!upstream) throw new Error('в записи бэкенда нет upstream');
    const u = new URL(upstream);        // бросит на мусоре — поймает вызывающий
    if (!/^https?:$/.test(u.protocol)) throw new Error(`upstream не http(s): ${upstream}`);
    return {
        backend: String(doc.backend || '').trim() || 'unknown',
        upstream,
        url: u,
        local: isLocalHost(u.hostname),
        keyFile: doc.keyFile ? String(doc.keyFile) : null,
        modelmap: doc.modelmap ? String(doc.modelmap) : null,
        updatedAt: Number(doc.updatedAt) || 0,
    };
}

function isLocalHost(h) {
    return /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?|0\.0\.0\.0)$/i.test(String(h || ''));
}

// Локальный апстрим бьём строго в IPv4. `localhost` на Windows разрешается в ::1
// ПЕРВЫМ, а connect в IPv6-loopback, где никто не слушает, отдаёт EACCES вместо
// ECONNREFUSED (замерено 2026-08-20: net.connect('::1',20156) → EACCES,
// ('127.0.0.1',20156) → ECONNREFUSED). Пока прокси жив, happy-eyeballs это прячет —
// ::1 отваливается, IPv4 отвечает; но стоит прокси умереть, и упавший бэкенд
// выглядит как загадочный «502 front-door → gorouter: EACCES» вместо «не слушает».
// Все наши прокси слушают 127.0.0.1, так что терять нечего — заодно уходит
// лишний ::1-заход на каждом соединении.
function connectHost(hostname, local) {
    return local && /^(localhost|0\.0\.0\.0)$/i.test(String(hostname)) ? '127.0.0.1' : hostname;
}

// Локальный апстрим не отвечает на connect = процесса нет. Код при этом зависит от
// стека (ECONNREFUSED на IPv4, EACCES на ::1, ETIMEDOUT если порт съел файрвол) —
// подсказка одна на все, иначе юзер читает код ошибки и идёт искать причину в CC.
const UPSTREAM_DOWN = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL',
]);

// ── Подъём keepalive по требованию (только для префиксного роутинга) ──────────
//
// Префиксный роутинг ввёл второй путь к шлюзу: раньше к провайдеру попадали ТОЛЬКО через
// активацию в дашборде, и она же поднимала его keepalive. Запрос вида `aipm/claude-opus-5`
// активацию обходит — и уезжает на порт, который никто не поднимал. Замер 11.09: из 15
// портов реестра жив был один, то есть префиксом работал только agentrouter.
//
// Спавнить сами не можем и не должны: env каждого инстанса (UPSTREAM, KEY_FILE,
// MODELMAP_FILE) знает дашборд, а он же умеет отличать зомби от живого по /status.
// Поэтому просим его, а не дублируем таблицу портов третьей копией.
const SWITCH_PORT = Number(process.env.SWITCH_PORT || 8200);
const ENSURE_TIMEOUT_MS = Number(process.env.ENSURE_TIMEOUT_MS || 15000);

// Дедуп: пачка запросов на один мёртвый порт обязана разделить ОДИН подъём. Дашборд
// сериализует и у себя, но без этого мы бы всё равно слали пачку HTTP-запросов и
// зависели от его дедупа — а держать одно обещание тут дешевле и честнее.
const ensureInflight = new Map();
// Отбойник: мёртвый наглухо шлюз (нет ключа, порт съеден файрволом) не должен получать
// подъём на КАЖДЫЙ запрос — иначе на каждый 502 сверху ложится 8 секунд ожидания.
const ensureFailedAt = new Map();
const ENSURE_COOLDOWN_MS = Number(process.env.ENSURE_COOLDOWN_MS || 30000);

function upstreamPortOf(state) {
    const p = Number(state && state.url && state.url.port);
    return Number.isInteger(p) && p > 0 ? p : 0;
}

function ensureKeepalive(port) {
    const running = ensureInflight.get(port);
    if (running) return running;
    const failed = ensureFailedAt.get(port) || 0;
    if (Date.now() - failed < ENSURE_COOLDOWN_MS) {
        return Promise.resolve({ ok: false, error: 'подъём уже не удался, отбойник', cooldown: true });
    }
    const p = new Promise((resolve) => {
        const payload = JSON.stringify({ port });
        const rq = http.request({
            host: '127.0.0.1', port: SWITCH_PORT, method: 'POST',
            path: '/__switch/api/keepalive/ensure',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
            timeout: ENSURE_TIMEOUT_MS,
        }, (r) => {
            const buf = [];
            r.on('data', c => buf.push(c));
            r.on('end', () => {
                let j = {};
                try { j = JSON.parse(Buffer.concat(buf).toString('utf8') || '{}'); } catch { /* ignore */ }
                resolve(r.statusCode === 200 && j.ok !== false ? { ok: true, ...j } : { ok: false, error: j.error || `дашборд ответил ${r.statusCode}` });
            });
        });
        rq.on('timeout', () => { rq.destroy(new Error(`дашборд :${SWITCH_PORT} не ответил за ${ENSURE_TIMEOUT_MS}мс`)); });
        rq.on('error', e => resolve({ ok: false, error: e.code || e.message }));
        rq.end(payload);
    }).then((r) => {
        if (r.ok) ensureFailedAt.delete(port);
        else ensureFailedAt.set(port, Date.now());
        ensureInflight.delete(port);
        return r;
    });
    ensureInflight.set(port, p);
    return p;
}

function readRemoteCredentials(state) {
    if (!state || state.local || !state.keyFile) return null;
    const keyPath = path.isAbsolute(state.keyFile) ? state.keyFile : path.join(CLAUDE_DIR, state.keyFile);
    let key = '';
    try { key = fs.readFileSync(keyPath, 'utf8').trim(); } catch { key = ''; }
    return key ? { authorization: `Bearer ${key}`, 'x-api-key': key } : null;
}

function exactBackendHeaders(state, contentLength, identity = {}) {
    const headers = {
        'content-type': 'application/json',
        'content-length': String(contentLength),
    };
    if (state.local) {
        headers['x-route-final'] = '1';
        headers['x-route-exact'] = '1';
        headers[localHopAuth.headerName] = trustedFrontdoorRouteAuth();
    } else {
        const credentials = readRemoteCredentials(state);
        if (!credentials) return null;
        Object.assign(headers, credentials);
    }
    for (const name of ['user-agent', 'x-request-id', 'x-session-id']) {
        if (typeof identity[name] === 'string') headers[name] = identity[name];
    }
    return headers;
}

function directExactRemoteHeaders(state, inbound, contentLength) {
    const headers = {
        'content-type': 'application/json',
        'content-length': String(contentLength),
        'accept-encoding': 'identity',
    };
    for (const name of [
        'accept', 'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access',
        'user-agent', 'x-app',
        'x-request-id', 'x-session-id',
    ]) {
        if (typeof inbound[name] === 'string') headers[name] = inbound[name];
    }
    const credentials = readRemoteCredentials(state);
    if (credentials) Object.assign(headers, credentials);
    return headers;
}

// Читаем по mtime: кеш не длиннее одного запроса по смыслу — иначе теряется
// бесшовность свича, ради которой всё и делается.
function readState() {
    let st;
    try {
        st = fs.statSync(STATE_FILE);
    } catch (e) {
        stateCache.state = null;
        stateCache.mtime = 0;
        stateCache.error = `нет ${STATE_FILE} — дашборд ещё не записал активный бэкенд`;
        return null;
    }
    if (stateCache.state && st.mtimeMs === stateCache.mtime) return stateCache.state;
    try {
        const parsed = parseState(fs.readFileSync(STATE_FILE, 'utf8'));
        stateCache.state = parsed;
        stateCache.mtime = st.mtimeMs;
        stateCache.error = null;
        log(`backend: ${parsed.backend} → ${parsed.upstream}${parsed.local ? ' (локальный, ключ не трогаем)' : ' (удалённый, ключ из ' + parsed.keyFile + ')'}`);
        return parsed;
    } catch (e) {
        stateCache.state = null;
        stateCache.mtime = st.mtimeMs;
        stateCache.error = `active-backend.json битый: ${e.message}`;
        return null;
    }
}

// ── Реестр провайдеров: роутинг по префиксу модели ───────────────────────────
// Зачем. Активный бэкенд один на всю машину, поэтому два окна Claude Code не могли
// сидеть на разных шлюзах, а свич провайдера ронял живую сессию, поднятую на модели,
// которой у нового шлюза нет (замер 04.09: kktoken отдал 403 на glm-5.3, удержание
// приняло это за «путь лежит» и держало ~90 с до ECONNRESET).
//
// Решение — как в OmniRoute: `aipm/claude-opus-4-6[1m]` уводит ЭТОТ запрос на aipm,
// независимо от активного. Без префикса поведение прежнее, байт в байт.
//
// 🪤 Таблицы провайдеров и портов здесь по-прежнему НЕТ (это правило из шапки файла):
// имена и апстримы приходят файлом от дашборда, который их и так разрешает. Нет файла
// или он битый → ноль известных префиксов → всё работает как до правки, никогда 5xx.
const REGISTRY_FILE = process.env.BACKENDS_FILE || path.join(CLAUDE_DIR, 'backends.json');
const regCache = { mtime: 0, map: null, error: 'реестр ещё не читался' };

function readRegistry() {
    let st;
    try {
        st = fs.statSync(REGISTRY_FILE);
    } catch {
        regCache.map = null;
        regCache.mtime = 0;
        regCache.error = `нет ${REGISTRY_FILE} — дашборд ещё не писал реестр, префиксы не работают`;
        return null;
    }
    if (regCache.map && st.mtimeMs === regCache.mtime) return regCache.map;
    try {
        const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        const map = new Map();
        for (const [name, e] of Object.entries(doc.providers || {})) {
            // Битая запись роняет ТОЛЬКО себя: остальные провайдеры обязаны работать.
            try { map.set(name.toLowerCase(), parseStateDoc(Object.assign({}, e, { backend: name }))); }
            catch (err) { log(`реестр: запись ${name} пропущена (${err.message})`); }
        }
        for (const [a, target] of Object.entries(doc.aliases || {})) {
            const k = String(a).toLowerCase(), t = String(target).toLowerCase();
            if (!map.has(k) && map.has(t)) map.set(k, map.get(t));   // алиас не смеет заслонять имя
        }
        regCache.map = map;
        regCache.mtime = st.mtimeMs;
        regCache.error = null;
        log(`реестр провайдеров: ${map.size} имён (${[...map.keys()].join(', ')})`);
        return map;
    } catch (e) {
        regCache.map = null;
        regCache.mtime = st.mtimeMs;
        regCache.error = `backends.json битый: ${e.message}`;
        return null;
    }
}

// ── Маппинг тиров для удалённых апстримов ────────────────────────────────────
// Те же правила, что у keepalive-proxy.js (:92) и agentrouter-proxy.js: держим
// формат файла одинаковым, чтобы вкладки дашборда правили его без переучивания.
const TIER_RE = [
    { tier: 'opus', re: /(^|[-_.\/])?opus([-\/]|$)/i },
    { tier: 'sonnet', re: /(^|[-_.\/])?sonnet([-\/]|$)/i },
    { tier: 'haiku', re: /(^|[-_.\/])?haiku([-\/]|$)/i },
];
// 🪤 Кеш на КАЖДЫЙ файл, а не один слот. С префиксным роутингом два окна ходят на
// двух разных remote-провайдеров одновременно, и одиночный слот промахивался бы на
// каждом чередующемся запросе — то есть читал бы карту с диска всегда.
const mapCache = new Map();     // абсолютный путь → { mtime, data }

function readModelMap(file) {
    if (!file) return null;
    const p = path.isAbsolute(file) ? file : path.join(__dirname, file);
    try {
        const st = fs.statSync(p);
        const hit = mapCache.get(p);
        if (hit && hit.mtime === st.mtimeMs) return hit.data;
        const raw = fs.readFileSync(p, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        const data = { opus: '', sonnet: '', haiku: '', ...doc };
        mapCache.set(p, { mtime: st.mtimeMs, data });
        return data;
    } catch { return null; }
}

function tierTargetFor(model, mm) {
    if (!mm) return null;
    for (const { tier, re } of TIER_RE) {
        if (mm[tier] && re.test(String(model || ''))) return { tier, target: mm[tier] };
    }
    return null;
}

// ── Склейка пути: base шлюза + путь клиента ───────────────────────────────────
// У половины шлюзов base URL уже кончается на /v1 (`api.evomap.ai/v1`,
// `api.ourtoken.ai/v1`, `conduit.ozdoev.net/v1`, `localhost:20128/v1` — так они
// лежат в BACKENDS/константах transparent-proxy.js), а Claude Code шлёт
// `/v1/messages`. Наивная склейка даёт `/v1/v1/messages`, и шлюз отвечает 404
// `Invalid URL` — проверено на живых ourtoken/evomap 2026-08-20. Схлопываем дубль:
// одинарный /v1 — единственная форма, на которую эти шлюзы отвечают.
function joinUpstreamPath(basePath, reqPath) {
    const base = String(basePath || '').replace(/\/+$/, '');
    if (base.endsWith('/v1') && /^\/v1(\/|\?|$)/.test(reqPath)) return base.slice(0, -3) + reqPath;
    return base + reqPath;
}

// Что сделать с телом запроса перед удалённым шлюзом.
// Возвращает { body, from, to } либо null (тело не меняем).
// Cun принимает три GPT 5.6 именно с `[1m]`; для остальных удалённых шлюзов суффикс
// остаётся клиентской меткой и срезается. Маппинг тира приоритетнее этого решения.
function remapForRemote(method, reqPath, body, mm, preserveGpt56Suffix) {
    if (method !== 'POST') return null;
    if (reqPath.replace(/\?.*$/, '') !== '/v1/messages') return null;
    let j;
    try { j = JSON.parse(body.toString('utf8') || '{}'); } catch { return null; }
    if (typeof j.model !== 'string' || !j.model) return null;
    const model = j.model;
    const tm = tierTargetFor(model, mm);
    const mapped = tm && tm.target ? tm.target : model;
    const target = preserveGpt56Suffix && /^gpt-5\.6-(sol|luna|terra)\[1m\]$/.test(mapped)
        ? mapped
        : mapped.replace(/\s*\[[^\]]*\]\s*$/, '');
    if (target === model) return null;
    return {
        body: Buffer.from(JSON.stringify(Object.assign({}, j, { model: target })), 'utf8'),
        from: model,
        to: target,
    };
}

// Выбор бэкенда по префиксу модели: `aipm/claude-opus-4-6[1m]` → провайдер aipm,
// наверх уходит `claude-opus-4-6[1m]`. Возвращает { state, prefix, from, to, body }
// либо null (префикса нет / имя чужое / реестра нет — тогда работает активный бэкенд).
//
// 🪤 Незнакомый префикс — это НЕ ошибка и НЕ повод гадать: `anthropic/claude-opus-4-8`
// и `openai/gpt-4o` — легитимные имена моделей, у нас же они есть у кастом-провайдеров.
// Не нашли имя в реестре → тело не трогаем вовсе, запрос едет к активному как раньше.
//
// 🪤 Пути НЕ фильтруем (в отличие от remapForRemote, где гейт на /v1/messages уместен).
// Роутить надо и count_tokens, и /v1/chat/completions от opencode: запрос обязан ехать
// туда, куда его послали, иначе он попадёт на чужой шлюз с неизвестным ему именем.
// Широкий охват безопасен ровно потому, что чужой префикс — no-op.
const MODEL_KEY = Buffer.from('"model"');

// Тир запроса, когда имя модели НЕ названо (`/model agentrouter`).
//
// Клиент в этом случае прислал имя провайдера, а не модели, поэтому «что спросили»
// определяется тем, КТО спросил: главное окно или сабагент. Claude Code зовёт сабагентов
// отдельными именами моделей, и до среза префикса они видны — замер живого трафика
// 12.09 (token-usage.jsonl, 4000 записей): claude-opus-5 1072, claude-sonnet-5 245,
// claude-haiku-4-5 80. Здесь же имени нет вовсе, значит это главное окно → `default`.
//
// 🪤 `default` — ОТДЕЛЬНЫЙ ключ, а не переиспользованный `opus`. «CC попросил opus» и
// «модель не названа» — разные события; их склейка и была причиной разбора 12.09.
const ROUTE_TIER_RE = [
    { tier: 'gpt', re: /gpt|o[0-9]|davinci|chatgpt/i },   // первым, как в keepalive (isGptLike до тиров)
    { tier: 'opus', re: /opus/i },
    { tier: 'sonnet', re: /sonnet/i },
    { tier: 'haiku', re: /haiku/i },
];
function tierOfRequest(model) {
    const s = String(model || '').trim();
    if (!s) return 'default';
    for (const { tier, re } of ROUTE_TIER_RE) if (re.test(s)) return tier;
    return 'default';
}

// Тир-карта ПРЕФИКСНОГО пути. Файл свой (`<prefix>-routes-modelmap.json`), потому что
// вкладка «Маршруты» и вкладка шлюза управляют разными путями: до 12.09 файл был один,
// и правка на одной вкладке меняла поведение другой.
// Читается тем же readModelMap() — кеш по mtime и разбор BOM уже там.
//
// 🪤 `!state.modelmap` и «карта есть, но `default` пуст» — РАЗНЫЕ отказы, и до 13.09
// они давали один и тот же текст 400 «default не задан». Первый означает, что имя файла
// вывести не из чего (реестр отдал `modelmap: null`) — то есть чинить надо реестр, а не
// вкладку. Владелец при этом `default` уже выбрал, шёл по подсказке на вкладку и видел
// там всё на месте. Поэтому различаем причины: `null` = «карта не адресуется»,
// объект = «адресуется, читай значение тира».
//
// Своей таблицы провайдер→префикс здесь НЕТ и быть не должно (правило из шапки файла,
// :56-58 и :207; инвариант вики «таблица остаётся одна — CC_MODEL_PREFIX»). Фолбэк по
// имени бэкенда означал бы КОПИЮ этой таблицы во front-door — второй источник истины,
// который разъедется с первым молча. Имя карты обязан дать реестр.
function routesMapFor(state) {
    if (!state || !state.modelmap) return null;
    return readModelMap(String(state.modelmap).replace(/-modelmap\.json$/, '-routes-modelmap.json'));
}

// ── Виртуальный /model multi: провайдер+модель на КАЖДЫЙ тир ─────────────────
// Дополнение к однашлюзовому режиму (не разворот 12.09): обычный `/model agentrouter`
// по-прежнему = один шлюз на окно. `multi` — отдельный режим, где тир выбирает И
// провайдера, И модель (окно → justwoker/opus, сабагент sonnet → agentrouter/glm).
// Значение тира в карте — ОБЪЕКТ {provider, model}. Разворачиваем в обычный механизм
// префиксов на один хоп раньше: пара из карты → настоящий state провайдера из реестра →
// форвард туда с конечной моделью. Ремап у keepalive гасим заголовком x-route-final
// (иначе routes-карта резолвленного шлюза подменила бы модель повторно).
//
// 🪤 Файл карты — литералом (__dirname), а не через реестр: multi не провайдер, у него
// нет ни апстрима, ни записи в backends.json.
// Путь оверрайдится env — как REGISTRY_FILE: иначе регресс читал бы боевую карту.
const MULTI_MAP_FILE = process.env.MULTI_MAP_FILE || path.join(__dirname, 'multi-routes-modelmap.json');
const MULTI_TIERS = ['default', 'opus', 'sonnet', 'haiku'];

function routeMulti(j, tier, reg, body) {
    if (!MULTI_TIERS.includes(tier)) {
        // gpt через multi не маршрутизируем — как и на обычном префиксном пути
        // (явное gpt-имя пишет человек, сабагент его не назовёт).
        return { multiError: true, code: 400,
            message: `front-door: /model multi — тир «${tier}» не поддерживается (есть ${MULTI_TIERS.join(', ')}). `
                + `Для явной gpt-модели назови шлюз прямо: /model <шлюз>/<модель>.` };
    }
    const mm = readModelMap(MULTI_MAP_FILE);
    if (!mm) {
        return { multiError: true, code: 400,
            message: `front-door: /model multi выбран, но карта ${MULTI_MAP_FILE} не читается. `
                + `Открой дашборд :8200 → «Маршруты» → блок multi и задай провайдер+модель для тира «${tier}».` };
    }
    const pair = mm[tier];
    const prov = pair && typeof pair === 'object' ? String(pair.provider || '').trim() : '';
    const mdl  = pair && typeof pair === 'object' ? String(pair.model || '').trim() : '';
    if (!prov || !mdl) {
        return { multiError: true, code: 400,
            message: `front-door: /model multi — тир «${tier}» не настроен (нет провайдера или модели). `
                + `Открой дашборд :8200 → «Маршруты» → блок multi → строка «${tier}» и выбери провайдера и модель.` };
    }
    const st = reg.get(prov.toLowerCase());
    if (!st) {
        return { multiError: true, code: 400,
            message: `front-door: /model multi — тир «${tier}» указывает на провайдера «${prov}», которого нет в реестре ${REGISTRY_FILE}. `
                + `Переактивируй шлюз в дашборде :8200 после его перезапуска, либо выбери другого провайдера в блоке multi.` };
    }
    return {
        state: st,
        prefix: 'multi',
        from: j.model,
        to: mdl,
        tier: null,          // x-route-tier НЕ ставим: модель уже конечная
        final: true,         // keepalive не ремапит (заголовок x-route-final)
        multiTier: tier,     // для лога
        body: Buffer.from(JSON.stringify(Object.assign({}, j, { model: mdl })), 'utf8'),
    };
}

function routeByModel(method, body, reg) {
    if (method !== 'POST' || !reg || !reg.size) return null;
    // Быстрый отсев без JSON.parse: нет байтов `"model"` — нет и поля model.
    // indexOf по Buffer — нативный memmem, ложных отрицаний не даёт.
    if (body.indexOf(MODEL_KEY) < 0) return null;
    let j;
    try { j = JSON.parse(body.toString('utf8') || '{}'); } catch { return null; }
    if (typeof j.model !== 'string') return null;
    const slash = j.model.indexOf('/');

    // ── Префиксное окно помнит свой шлюз для субагентов этой же сессии ──────────
    // Claude Code запускает Agent/Workflow с `claude-opus-5`, `claude-sonnet-5` и т.п.
    // без имени родительского провайдера. Пока родитель говорил `a6api/gpt-6-sol`, явный
    // префикс выбирал a6api, но следующий запрос агента был без префикса и шёл на active
    // backend (Premier/DeepSeek). session_id из metadata.user_id связывает эти запросы
    // ТОЛЬКО внутри окна; переменной уровня процесса и глобального SUBAGENT_MODEL нет.
    if (slash < 0) {
        const bareAgent = j.model.trim().replace(/\s*\[[^\]]*\]\s*$/, '');
        const tier = tierOfRequest(bareAgent);
        const sessionState = sessionRouteFor(j);
        if (sessionState && /^(claude[-_](?:opus|sonnet|haiku))\b/i.test(bareAgent)) {
            const mm = routesMapFor(sessionState);
            const target = mm && String(mm[tier] || '').trim();
            if (!target) return { state: sessionState, prefix: 'session', from: bareAgent, to: null, tier, body,
                noTarget: true, noMap: !mm, sessionRoute: true };
            return { state: sessionState, prefix: 'session', from: bareAgent, to: target, tier, sessionRoute: true,
                body: Buffer.from(JSON.stringify(Object.assign({}, j, { model: target })), 'utf8') };
        }
    }

    // ── Имя БЕЗ слэша: назван только шлюз, модель выбирает routes-карта ──────────
    // `/model agentrouter` (заявка владельца 12.09). Раньше этот случай уходил в
    // `return null`, то есть запрос молча ехал на АКТИВНЫЙ шлюз — тихий уход на чужой
    // баланс. Теперь имя провайдера распознаётся, а модель берётся из карты.
    if (slash < 0) {
        // 🪤 Суффикс окна снимаем ПЕРЕД поиском в реестре. `agentrouter[1m]` возникает
        // сам собой — normalizeCcModel вешает `[1m]` на всё, что похоже на 1M-модель, а
        // человек может написать его руками. Без среза `reg.get()` промахнётся, и запрос
        // молча уедет на активный шлюз: ровно тот тихий отказ, ради которого вся правка.
        const bare = j.model.trim().replace(/\s*\[[^\]]*\]\s*$/, '');
        // Голое `multi` — главное окно: тир default, провайдер+модель из multi-карты.
        if (bare.toLowerCase() === 'multi') return routeMulti(j, 'default', reg, body);
        const st = reg.get(bare.toLowerCase());
        if (!st) return null;                          // обычное имя модели — не наше дело
        const tier = 'default';                        // имени модели нет → главное окно
        const mm = routesMapFor(st);
        const target = mm && String(mm[tier] || '').trim();
        // 🪤 Пустой `default` — честная ошибка, а не угадывание. Взять activeModel
        // значило бы вернуться к угадыванию, от которого ушли в пользу явного префикса,
        // а пропустить запрос дальше — отправить его на чужой шлюз молча.
        //
        // 🎯 Причину отказа возвращаем РАЗДЕЛЬНО (13.09). `mm === null` = реестр не дал
        // имени файла карты (`modelmap: null`), то есть карта не адресуется вовсе;
        // `mm` есть, а тир пуст = карта прочитана, значение не выбрано. Раньше оба случая
        // давали текст «выбери default на вкладке Маршруты» — и на первом это была ложь:
        // `default` там уже выбран, а сломан реестр. Владелец по этой подсказке чинил
        // исправное («я уже выбрал, а она непонятно куда пошла»).
        if (!target) {
            return {
                state: st, prefix: j.model, from: j.model, to: null, tier, body,
                noTarget: true,
                noMap: !mm,
            };
        }
        return {
            state: st,
            prefix: j.model,
            from: j.model,
            to: target,
            tier,
            body: Buffer.from(JSON.stringify(Object.assign({}, j, { model: target })), 'utf8'),
        };
    }

    if (slash === 0) return null;                      // ведущий слэш
    // `multi/claude-sonnet-5` — сабагент в окне multi: тир определяем по имени, которым
    // назвался сабагент, а провайдера+модель берёт multi-карта по этому тиру.
    if (j.model.slice(0, slash).toLowerCase() === 'multi') {
        const sub = j.model.slice(slash + 1);
        if (!sub) return null;
        return routeMulti(j, tierOfRequest(sub), reg, body);
    }
    const state = reg.get(j.model.slice(0, slash).toLowerCase());
    if (!state) return null;                           // чужое имя — не наше дело
    // Явный `/provider/model` - это выбор окна, запоминаем его для будущих агентов.
    // Это не меняет active-backend и не смешивает соседние окна: ключом служит session_id.
    rememberSessionRoute(j, state);
    const model = j.model.slice(slash + 1).trim();
    if (!model) return null;                           // `aipm/` без модели
    return {
        state,
        prefix: j.model.slice(0, slash),
        from: j.model,
        to: model,
        // 🎯 Тиры `opus/sonnet/haiku` считаем и здесь: сабагент называет себя именем
        // `claude-haiku-4-5-…`, и по нему видно, КТО спросил — это и есть вариант A
        // владельца (haiku остаётся дешёвым). А вот `gpt` — не метка спрашивающего, а
        // физическое имя модели, которое сабагент не назовёт никогда: его пишет человек
        // руками. Поэтому gpt-тир на явном имени НЕ применяем — `/model
        // agentrouter/gpt-6-astra` обязан дать ровно `gpt-6-astra` (заявка владельца 12.09,
        // поймано на живом запросе: имя подменялось на значение ключа `gpt`).
        tier: tierOfRequest(model) === 'gpt' ? null : tierOfRequest(model),
        body: Buffer.from(JSON.stringify(Object.assign({}, j, { model })), 'utf8'),
    };
}

// Ошибка в форме Anthropic: Claude Code печатает message как есть, иначе юзер
// видит только «unknown error» и лезет искать причину в CC, а не у нас.
// 🪤 Если заголовки уже ушли, `res.end()` ОТМЫВАЕТ обрыв в чистое завершение: клиент
// получает корректно закрытый ответ с недописанным телом и падает на разборе, а не
// повторяет запрос. Особенно больно с удержанием keepalive, где тело до отказа состоит
// из одних пробелов (`jsonHoldMs`) или из одних пингов: `JSON.parse` даёт SyntaxError
// вместо повторяемой сетевой ошибки. Поэтому здесь именно `destroy()` — обрыв должен
// доехать до клиента обрывом. Найдено чтением кода 2026-09-04.
function apiError(res, code, message) {
    const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message } });
    if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function internalMarkerError(res) {
    const body = JSON.stringify({
        type: 'error',
        error: { type: 'permission_error', message: 'Internal request is not permitted.' },
    });
    res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function openAiError(res, status, code, message, publicModel) {
    const projected = publicModel
        ? makeRedactedOpenAiError(status, code, publicModel)
        : { error: { message, type: 'api_error', code } };
    const body = JSON.stringify(projected);
    if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function openAiModels(res) {
    try {
        const manifest = readPublishedManifest({
            defaultManifestPath: API_GATEWAY_DEFAULT_FILE,
            manifestPath: API_GATEWAY_FILE,
            backendsPath: REGISTRY_FILE,
            settingsPath: CLAUDE_SETTINGS_FILE,
        });
        const body = JSON.stringify({ object: 'list', data: toOpenAiModels(manifest) });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
    } catch (error) {
        if (error instanceof ApiGatewayError && error.code === 'api_gateway_disabled') {
            return openAiError(res, 503, error.code, error.message);
        }
        return openAiError(res, 503, 'api_gateway_unavailable', 'API Gateway state is unavailable.');
    }
}

const FORBIDDEN_BIFROST_OVERRIDES = new Set([
    'fallbacks', 'provider', 'key_id', 'routing', 'route', 'access_profile',
]);
const INTERNAL_CARRIER_ALIASES = new Set([
    'x-abuse-hub-correlation',
    'x-abuse-hub-request-id',
    'x-bf-eh-x-abuse-hub-correlation',
    'x-bf-eh-x-abuse-hub-request-id',
]);

function publicControlHeader(req) {
    for (const name of Object.keys(req.headers)) {
        const lower = name.toLowerCase();
        if (lower.startsWith('x-abuse-hub-') || lower.startsWith('x-route-') || lower.startsWith('x-bf-')) {
            return lower;
        }
    }
    return '';
}

function callbackCandidate(req) {
    if (Object.hasOwn(req.headers, 'x-abuse-hub-internal')
        || Object.hasOwn(req.headers, INTERNAL_REQUEST_TOKEN_HEADER)) return true;
    return Object.keys(req.headers).some(name => INTERNAL_CARRIER_ALIASES.has(name.toLowerCase()));
}

function safeIdentity(req) {
    const limits = { 'user-agent': 512, 'x-request-id': 255, 'x-session-id': 255 };
    const result = {};
    for (const [name, limit] of Object.entries(limits)) {
        const value = req.headers[name];
        if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value)) continue;
        if (Buffer.byteLength(value, 'utf8') > limit) continue;
        result[name] = value;
    }
    return result;
}

function readBoundedBody(req, { maxBytes = OPENAI_BODY_MAX_BYTES } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const fail = error => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        req.on('data', chunk => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > maxBytes) {
                fail(Object.assign(new Error('Request body is too large.'), { status: 400, code: 'invalid_request' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks));
        });
        req.on('error', fail);
        req.on('aborted', () => fail(Object.assign(new Error('Request was aborted.'), { code: 'request_aborted' })));
    });
}

// OpenAI Chat Completions делает `max_tokens` необязательным, и клиенты этим пользуются: Hermes не
// присылает его вовсе. Bifrost же при включённом reasoning отвергает запрос без потолка
// («max_tokens must be greater than 1024 for reasoning»), и весь turn падает 400 ещё до модели.
// Подставляем лимит опубликованной модели из манифеста - шлюз его знает, клиенту угадывать не надо.
// Явно присланное значение не трогаем.
const OPENAI_DEFAULT_OUTPUT_TOKENS = 32000;

function withOutputCeiling(body, manifest) {
    if (Object.hasOwn(body, 'max_tokens') || Object.hasOwn(body, 'max_completion_tokens')) return body;
    const published = manifest && manifest.models && manifest.models[body.model];
    const declared = published && Number(published.outputTokens);
    const ceiling = Number.isSafeInteger(declared) && declared > 0 ? declared : OPENAI_DEFAULT_OUTPUT_TOKENS;
    return { ...body, max_tokens: ceiling };
}

function validateOpenAiIngressBody(raw, manifest) {
    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON request body.'), { status: 400, code: 'invalid_request' }); }
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.getPrototypeOf(body) !== Object.prototype) {
        throw Object.assign(new Error('Invalid JSON request body.'), { status: 400, code: 'invalid_request' });
    }
    for (const key of FORBIDDEN_BIFROST_OVERRIDES) {
        if (Object.hasOwn(body, key)) {
            throw Object.assign(new Error('Caller routing overrides are not supported.'), {
                status: 400,
                code: 'invalid_request',
            });
        }
    }
    // Любой отказ здесь обязан назвать поле. Раньше все они отдавали голое «Invalid request.»,
    // и 12.11 пришлось полдня искать, ПОЧЕМУ Hermes с инструментами получал 400: причина
    // (схема инструмента не пережила конвертацию) была не видна ни в логе, ни в ответе.
    if (Object.hasOwn(body, 'tools') && body.tools !== undefined) {
        if (!Array.isArray(body.tools) || body.tools.some(tool => !tool || typeof tool !== 'object'
            || Array.isArray(tool) || typeof tool.function !== 'object' || tool.function === null
            || typeof tool.function.name !== 'string' || !tool.function.name.trim())) {
            throw Object.assign(new Error('tools must be an array of {type:"function", function:{name, parameters}}.'), {
                status: 400,
                code: 'invalid_request',
            });
        }
    }
    if (Object.hasOwn(body, 'stream') && typeof body.stream !== 'boolean') {
        throw Object.assign(new Error('stream must be a boolean.'), { status: 400, code: 'invalid_request' });
    }
    for (const name of ['n', 'best_of']) {
        if (Object.hasOwn(body, name) && (typeof body[name] !== 'number' || body[name] !== 1)) {
            throw Object.assign(new Error(`${name} must be numeric 1.`), { status: 400, code: 'invalid_request' });
        }
    }
    const recognized = recognizeCallableModel(body.model, { backendsPath: REGISTRY_FILE });
    body = withOutputCeiling(body, manifest);
    return {
        publicModel: recognized.id,
        provider: recognized.provider,
        bareModel: recognized.model,
        streamMode: body.stream === true,
        sidecarBody: { ...body, model: `${BIFROST_PROVIDER}/${recognized.id}` },
    };
}

function statusForSidecar(status) {
    if (status === 400) return { status: 400, code: 'invalid_request' };
    if (status === 404) return { status: 404, code: 'model_not_found' };
    return { status: 503, code: 'upstream_unavailable' };
}

function createDelegatedOpenAiSseRestorer({ publicModel, maxLineBytes = OPENAI_SSE_LINE_MAX_BYTES }) {
    let pending = Buffer.alloc(0);
    let sawJsonObject = false;
    let sawErrorObject = false;
    let sawDone = false;
    let failed = false;

    function fail(message) {
        failed = true;
        throw new Error(message);
    }

    function restoreLine(line, ending) {
        const content = line.length && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
        if (!content.subarray(0, 5).equals(Buffer.from('data:'))) return Buffer.concat([line, ending]);
        const payload = content.subarray(5).toString('utf8').trim();
        if (!payload) return Buffer.concat([line, ending]);
        if (payload === '[DONE]') {
            if (sawDone || sawErrorObject) fail('Invalid delegated SSE terminal marker.');
            sawDone = true;
            return Buffer.concat([line, ending]);
        }
        if (sawDone) fail('Delegated SSE data followed [DONE].');
        let value;
        try { value = JSON.parse(payload); } catch { fail('Invalid delegated SSE JSON.'); }
        if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
            fail('Delegated SSE data must be an object.');
        }
        const restored = restoreDelegatedOpenAiObject(value, publicModel);
        sawJsonObject = true;
        if (value.error !== null && value.error !== undefined) sawErrorObject = true;
        return Buffer.from(`data: ${JSON.stringify(restored)}${ending.toString('binary')}`, 'utf8');
    }

    const transformer = new Transform({
        transform(chunk, _encoding, callback) {
            try {
                pending = Buffer.concat([pending, Buffer.from(chunk)]);
                let newline;
                while ((newline = pending.indexOf(0x0a)) >= 0) {
                    if (newline > maxLineBytes) fail('Delegated SSE line is too large.');
                    const line = pending.subarray(0, newline);
                    pending = pending.subarray(newline + 1);
                    this.push(restoreLine(line, Buffer.from('\n')));
                }
                if (pending.length > maxLineBytes) fail('Delegated SSE line is too large.');
                callback();
            } catch (error) { callback(error); }
        },
        flush(callback) {
            try {
                if (pending.length) {
                    if (pending.length > maxLineBytes) fail('Delegated SSE line is too large.');
                    this.push(restoreLine(pending, Buffer.alloc(0)));
                    pending = Buffer.alloc(0);
                }
                if (!failed && !((sawDone && !sawErrorObject) || (sawErrorObject && !sawDone))) {
                    fail('Delegated SSE stream was truncated.');
                }
                callback();
            } catch (error) { callback(error); }
        },
    });
    transformer.state = () => ({ pending: pending.length, sawJsonObject, sawErrorObject, sawDone, failed });
    return transformer;
}

// Тело отказа sidecar для лога: причина 400 иначе не сохраняется нигде.
// Лимит жёсткий (отказ короткий), секреты маскируются — в лог не должны попасть
// ни ключи, ни адреса апстрима.
const SIDECAR_REJECTION_MAX_BYTES = 4096;
// Маскируем и поля с явным именем, и голые ключи известных форматов: тело отказа
// пишет апстрим, и он не обязан называть поле «api_key».
const SIDECAR_SECRET_PATTERN = /(bearer\s+|api[_-]?key["']?\s*[:=]\s*["']?|token["']?\s*[:=]\s*["']?|authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',}]{4,}/gi;
const SIDECAR_BARE_KEY_PATTERN = /\b(?:sk-[A-Za-z0-9_\-]{8,}|ya29\.[A-Za-z0-9_\-]{8,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})/g;

function scrubSidecarRejection(text) {
    return String(text)
        .replace(SIDECAR_SECRET_PATTERN, (_m, prefix) => `${prefix}[REDACTED]`)
        .replace(SIDECAR_BARE_KEY_PATTERN, '[REDACTED]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
}

function readSidecarRejection(upstreamResponse, done) {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(chunks);
        chunks.length = 0;
        done(scrubSidecarRejection(raw.toString('utf8')));
        raw.fill(0);
    };
    upstreamResponse.on('data', chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > SIDECAR_REJECTION_MAX_BYTES) chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (bytes - SIDECAR_REJECTION_MAX_BYTES))));
        else chunks.push(chunk);
        finish();
        if (!upstreamResponse.destroyed) upstreamResponse.destroy();
    });
    upstreamResponse.on('end', finish);
    upstreamResponse.on('error', finish);
    upstreamResponse.on('aborted', finish);
    // Отказ может прийти без тела вовсе — не ждём вечно.
    setTimeout(finish, 1000).unref?.();
}

function writePublicDiagnosis(res, diagnosis) {
    const body = Buffer.from(JSON.stringify(diagnosis.body), 'utf8');
    res.writeHead(diagnosis.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
    });
    res.end(body);
}

// Inspect only complete, bounded local-converter JSON before committing headers.
// Truncated/malformed/oversized bodies produce no diagnosis; nothing from the
// provider body or response headers is copied to either protocol boundary.
function forwardA6apiErrorResponse(upRes, res, publicModel, { trustedLocal = false, onCode = () => {}, onFinish = () => {} } = {}) {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const clear = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const finish = code => {
        if (settled) return;
        settled = true;
        clear();
        if (!upRes.destroyed && !upRes.complete) upRes.destroy();
        if (!res.destroyed) {
            const diagnosis = makeA6apiPublicError(code, publicModel, { native: true });
            if (diagnosis) {
                onCode(code);
                writePublicDiagnosis(res, diagnosis);
            } else {
                writePublicDiagnosis(res, {
                    status: [400, 401, 403, 404, 429].includes(upRes.statusCode) ? upRes.statusCode : 503,
                    body: { type: 'error', error: { type: 'api_error', code: 'upstream_unavailable', message: 'Upstream request failed.' }, model: publicModel },
                });
            }
        }
        onFinish();
    };
    upRes.on('error', () => finish(null));
    upRes.on('aborted', () => finish(null));
    upRes.on('close', () => { if (!upRes.complete) finish(null); });
    res.on('close', () => {
        if (!res.writableFinished && !settled) {
            settled = true;
            clear();
            if (!upRes.destroyed) upRes.destroy();
            onFinish();
        }
    });
    if (!trustedLocal) {
        finish(null);
        return;
    }
    upRes.on('data', chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > A6API_PUBLIC_ERROR_MAX_BYTES) return finish(null);
        chunks.push(Buffer.from(chunk));
    });
    upRes.on('end', () => {
        if (settled) return;
        const raw = Buffer.concat(chunks);
        const code = readA6apiPublicErrorCode(raw, upRes.statusCode, upRes.headers);
        raw.fill(0);
        finish(code);
    });
}

function forwardDelegatedJson(upstreamResponse, req, res, handle, publicModel, { rejectSuccessfulBody = false } = {}) {
    const chunks = [];
    let bytes = 0;
    let ended = false;
    let settled = false;
    const finishOuter = () => requestCancellationRegistry.finishOuter(handle);
    const fail = (status = 503, code = 'upstream_unavailable') => {
        if (settled) return;
        settled = true;
        const diagnosis = handle.provider === 'a6api'
            ? makeA6apiPublicError(callbackPublicErrorCodes.get(handle), publicModel)
            : null;
        callbackPublicErrorCodes.delete(handle);
        requestCancellationRegistry.cancel(handle, 'sidecar_response_failure');
        finishOuter();
        if (!upstreamResponse.destroyed) upstreamResponse.destroy();
        if (!res.headersSent && !res.destroyed && diagnosis) writePublicDiagnosis(res, diagnosis);
        else if (!res.headersSent && !res.destroyed) openAiError(res, status, code, '', publicModel);
        else if (!res.destroyed) res.destroy();
    };
    upstreamResponse.on('error', () => fail());
    upstreamResponse.on('aborted', () => fail());
    upstreamResponse.on('close', () => { if (!ended) fail(); });

    if (handle.provider === 'a6api' && callbackPublicErrorCodes.has(handle)) {
        fail();
        return;
    }

    const encoding = String(upstreamResponse.headers['content-encoding'] || '').toLowerCase();
    if (encoding && encoding !== 'identity') {
        fail();
        return;
    }
    const status = upstreamResponse.statusCode || 503;
    if (status < 200 || status >= 300) {
        const mapped = statusForSidecar(status);
        // Причина отказа Bifrost в лог: клиент видит обезличенное «Invalid request.», а без
        // этой строки 12.11 невозможно было отличить провал конвертации инструментов от
        // кривого тела запроса — полдня ушло на бисект повторами.
        //
        // 🪤 Раньше здесь печатался только content-type, и тело отказа терялось: 17.11
        // в 01:18 пришёл 400, а в bifrost.log за этот момент не было НИ ОДНОЙ строки —
        // отказ произошёл до его хендлера, и настоящая причина не сохранилась нигде.
        // Читаем ограниченный хвост тела, чтобы дефект больше не был невидимым.
        if (status === 400 || status === 422) {
            readSidecarRejection(upstreamResponse, text => {
                log(`sidecar ${status} ${req.method} ${req.url}: ${text || '(пустое тело)'}`);
                fail(mapped.status, mapped.code);
            });
            return;
        }
        log(`sidecar ${status} ${req.method} ${req.url}: ${upstreamResponse.headers['content-type'] || '-'}`);
        fail(mapped.status, mapped.code);
        return;
    }
    upstreamResponse.on('data', chunk => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > OPENAI_BODY_MAX_BYTES) {
            fail();
            return;
        }
        chunks.push(chunk);
    });
    upstreamResponse.on('end', () => {
        ended = true;
        if (settled || res.destroyed) return;
        try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const hasError = value && !Array.isArray(value) && typeof value === 'object'
                && value.error !== null && value.error !== undefined;
            if (hasError || rejectSuccessfulBody) {
                fail();
                return;
            }
            const projected = restoreDelegatedOpenAiObject(value, publicModel);
            const responseBody = Buffer.from(JSON.stringify(projected), 'utf8');
            settled = true;
            callbackPublicErrorCodes.delete(handle);
            finishOuter();
            res.writeHead(status, {
                'content-type': 'application/json',
                'content-length': String(responseBody.length),
            });
            res.end(responseBody);
        } catch {
            fail();
        }
    });
}

function forwardOpenAi(req, res, validated) {
    let begun;
    try {
        begun = requestCancellationRegistry.begin({
            publicModel: validated.publicModel,
            provider: validated.provider,
            bareModel: validated.bareModel,
            streamMode: validated.streamMode,
            safeIdentity: safeIdentity(req),
        });
    } catch {
        return openAiError(res, 503, 'api_gateway_busy', '', validated.publicModel);
    }
    const { token, handle } = begun;
    const payload = Buffer.from(JSON.stringify(validated.sidecarBody), 'utf8');
    const headers = {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        'accept-encoding': 'identity',
        [BIFROST_REQUEST_TOKEN_CARRIER]: token,
    };
    let sidecarConnected = false;
    let outerTerminal = false;
    const finishOuter = () => {
        if (outerTerminal) return;
        outerTerminal = true;
        requestCancellationRegistry.finishOuter(handle);
    };
    const failSidecar = () => {
        if (!sidecarConnected) {
            requestCancellationRegistry.finishInner(handle);
        } else {
            requestCancellationRegistry.cancel(handle, 'sidecar_failure');
        }
        finishOuter();
        if (!res.headersSent && !res.destroyed) {
            openAiError(res, 503, 'upstream_unavailable', '', validated.publicModel);
        } else if (!res.destroyed) {
            res.destroy();
        }
    };
    const upstream = http.request({
        host: '127.0.0.1',
        port: Number(BIFROST_URL.port),
        method: 'POST',
        path: '/v1/chat/completions',
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
    }, upstreamResponse => {
        sidecarConnected = true;
        upstreamResponse.on('end', finishOuter);
        if (handle.provider === 'a6api' && callbackPublicErrorCodes.has(handle)) {
            return forwardDelegatedJson(upstreamResponse, req, res, handle, validated.publicModel);
        }
        if (validated.streamMode) {
            const status = upstreamResponse.statusCode || 503;
            const contentType = String(upstreamResponse.headers['content-type'] || '').trim().toLowerCase();
            const mediaType = contentType.split(';', 1)[0].trim();
            if (status < 200 || status >= 300 || mediaType !== 'text/event-stream') {
                return forwardDelegatedJson(
                    upstreamResponse,
                    req,
                    res,
                    handle,
                    validated.publicModel,
                    { rejectSuccessfulBody: status >= 200 && status < 300 },
                );
            }
            const encoding = String(upstreamResponse.headers['content-encoding'] || '').toLowerCase();
            if (encoding && encoding !== 'identity') {
                requestCancellationRegistry.cancel(handle, 'protocol_failure');
                finishOuter();
                upstreamResponse.on('error', () => {});
                upstreamResponse.destroy();
                return openAiError(res, 503, 'upstream_unavailable', '', validated.publicModel);
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            const restorer = createDelegatedOpenAiSseRestorer({ publicModel: validated.publicModel });
            pipeline(upstreamResponse, restorer, res, error => {
                if (error) {
                    requestCancellationRegistry.cancel(handle, 'protocol_failure');
                    finishOuter();
                    try { upstream.destroy(); } catch { /* already closed */ }
                    try { upstreamResponse.destroy(); } catch { /* already closed */ }
                    if (!res.destroyed) res.destroy();
                }
            });
        } else {
            forwardDelegatedJson(upstreamResponse, req, res, handle, validated.publicModel);
        }
    });
    upstream.on('socket', socket => {
        if (!socket.connecting) sidecarConnected = true;
        else socket.once('connect', () => { sidecarConnected = true; });
    });
    let gone = false;
    const abort = () => {
        if (gone) return;
        gone = true;
        requestCancellationRegistry.cancel(handle, 'client_disconnect');
        finishOuter();
        try { upstream.destroy(); } catch { /* already closed */ }
    };
    req.on('aborted', abort);
    req.on('close', () => { if (!req.complete) abort(); });
    res.on('close', () => {
        if (!res.writableFinished) abort();
        else finishOuter();
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Bifrost timeout')));
    upstream.on('error', () => {
        if (!gone) failSidecar();
    });
    upstream.end(payload);
}

async function openAiChat(req, res) {
    try {
        const manifest = readManifest({
            manifestPath: API_GATEWAY_FILE,
            backendsPath: REGISTRY_FILE,
        });
        if (manifest.enabled === false) {
            return openAiError(res, 503, 'api_gateway_disabled', 'API Gateway is disabled.');
        }
        const raw = await readBoundedBody(req);
        const validated = validateOpenAiIngressBody(raw, manifest);
        forwardOpenAi(req, res, validated);
    } catch (error) {
        if (res.destroyed || error.code === 'request_aborted') return;
        if (error instanceof ApiGatewayError) {
            return openAiError(res, error.status, error.code, error.message);
        }
        // Клиенту отдаём обезличенный текст, но причину пишем в лог: 12.11 Hermes получал
        // «Invalid request.» и искать было нечего - настоящая ошибка (неизвестная модель,
        // ошибка разбора тела) жила только в стеке процесса.
        log(`openai ingress 400: ${error.code || error.name || 'error'}: ${error.message}`);
        return openAiError(res, error.status || 400, error.code || 'invalid_request', 'Invalid request.');
    }
}

// Счётчики префиксного роутинга и привязка окна к провайдеру.
// Claude Code запускает субагента с моделью `claude-opus-5`, без префикса родительского
// шлюза. Поэтому одного modelmap недостаточно: unprefixed запрос иначе попадает на
// активный backend (или в Premier) и падает до нужной карты. Session id приходит в
// metadata.user_id как JSON-строка. Запоминаем только явный выбор `/model <provider>/<model>`
// и используем его для последующих субагентов этого же окна. Другие окна не смешиваются.
const routedCounts = Object.create(null);
const routedLast = Object.create(null);
const sessionRoutes = new Map();
const SESSION_ROUTE_TTL_MS = Number(process.env.SESSION_ROUTE_TTL_MS || 12 * 60 * 60 * 1000);
const SESSION_ROUTE_MAX = 2048;
function sessionIdOf(body) {
    const metadata = body && body.metadata;
    const raw = metadata && (metadata.session_id || metadata.sessionId || metadata.user_id);
    if (!raw) return '';
    if (typeof raw === 'string') {
        try { const parsed = JSON.parse(raw); return String(parsed.session_id || parsed.sessionId || '').trim(); }
        catch { return ''; }
    }
    return String(raw || '').trim();
}
function rememberSessionRoute(body, state) {
    const id = sessionIdOf(body);
    if (!id || !state) return;
    sessionRoutes.set(id, { state, at: Date.now() });
    while (sessionRoutes.size > SESSION_ROUTE_MAX) sessionRoutes.delete(sessionRoutes.keys().next().value);
}
function sessionRouteFor(body) {
    const id = sessionIdOf(body), hit = id && sessionRoutes.get(id);
    if (!hit) return null;
    if (Date.now() - hit.at > SESSION_ROUTE_TTL_MS) { sessionRoutes.delete(id); return null; }
    return hit.state;
}

function statusPayload({ detailed = false } = {}) {
    const s = readState();
    const reg = readRegistry();
    const base = {
        ok: true,
        port: PORT,
        uptime_ms: Date.now() - startedAt,
        backend: s ? s.backend : null,
        local: s ? s.local : null,
        error: s ? null : 'active_backend_unavailable',
        registry_error: reg ? null : 'registry_unavailable',
        api_gateway_inflight: requestCancellationRegistry.size(),
    };
    if (!detailed) return base;
    // Group by state object: aliases point at the same entry.
    const groups = [];
    if (reg) {
        for (const v of new Set(reg.values())) {
            groups.push({
                backend: v.backend,
                upstream: v.upstream,
                local: v.local,
                injectsKey: !v.local && !!v.keyFile,
                modelmap: v.modelmap,
                names: [...reg.entries()].filter(([, x]) => x === v).map(([k]) => k),
            });
        }
    }
    return {
        ...base,
        upstream: s ? s.upstream : null,
        injectsKey: s ? (!s.local && !!s.keyFile) : null,
        modelmap: s ? s.modelmap : null,
        registry: groups,
        routed: Object.assign({}, routedCounts),
        routed_last: Object.assign({}, routedLast),
    };
}

// ── Мягкая остановка: дожать начатое, а не расстрелять ───────────────────────
// Зачем. Рестарт хаба гасит front-door, и КАЖДЫЙ запрос в полёте превращается для
// Claude Code в `Connection closed mid-response` или `ECONNRESET`. 05.09 это било по
// живым сессиям раз за разом: дашборд поднимался по четыре раза в час, а владелец
// требовал прямо — «прокси не должна рвать соединение».
// 🪤 На Windows мягко погасить чужой процесс нельзя: SIGTERM не доставляется, а
// `taskkill` без `/F` для node бесполезен (об это же спотыкается lifecycle.killPort).
// Поэтому сигнал ВНУТРИПОЛОСНЫЙ: кто гасит — просит `POST /__drain`, и процесс сам
// перестаёт принимать новые соединения, дожимает начатые и выходит.
let draining = false;
let inflight = 0;
const DRAIN_MAX_MS = Number(process.env.DRAIN_MAX_MS || 120000);

function maybeExitAfterDrain() {
    if (!draining || inflight > 0 || claimedCallbackWork.size > 0) return;
    log('дренаж закончен: запросов в полёте нет, выхожу');
    setTimeout(() => process.exit(0), 250)   // запас на дослив последнего ответа в сокет.unref();
}

function startDrain(res) {
    const drainInflight = inflight + claimedCallbackWork.size;
    const body = JSON.stringify({ ok: true, draining: true, inflight: drainInflight });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    if (draining) return;
    draining = true;
    log(`дренаж: закрываю слушателя, в полёте ${drainInflight} запрос(ов), потолок ожидания ${DRAIN_MAX_MS}мс`);
    try { server.close(); } catch (e) { /* уже закрыт */ }
    // Потолок обязателен: один долгий ответ (наблюдались 12-минутные) иначе держал бы
    // рестарт бесконечно, и человек убил бы процесс руками — то есть вернулся к разрыву.
    setTimeout(() => {
        if (!draining) return;
        if (claimedCallbackWork.size > 0) {
            log(`дренаж: потолок ${DRAIN_MAX_MS}мс истёк, оплачиваемых callback ещё ${claimedCallbackWork.size} - продолжаю ждать`);
            return;
        }
        log(`дренаж: потолок ${DRAIN_MAX_MS}мс истёк, в полёте ещё ${inflight} - выхожу`);
        process.exit(0);
    }, DRAIN_MAX_MS).unref();
    maybeExitAfterDrain();
}

function countRawHeader(req, wanted) {
    let count = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (String(req.rawHeaders[index]).toLowerCase() === wanted) count += 1;
    }
    return count;
}

function timingSafeMarker(value) {
    if (typeof value !== 'string') return false;
    const actual = Buffer.from(value, 'utf8');
    const expected = Buffer.from(BIFROST_INTERNAL_MARKER, 'utf8');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function callbackEnvelopeAllowed(req) {
    if (req.method !== 'POST' || req.url !== '/v1/messages') return false;
    if (req.socket.remoteAddress !== '127.0.0.1') return false;
    if (countRawHeader(req, 'x-abuse-hub-internal') !== 1
        || countRawHeader(req, INTERNAL_REQUEST_TOKEN_HEADER) !== 1) return false;
    const marker = req.headers['x-abuse-hub-internal'];
    const token = req.headers[INTERNAL_REQUEST_TOKEN_HEADER];
    if (typeof marker !== 'string' || marker.includes(',') || typeof token !== 'string' || token.includes(',')) return false;
    return timingSafeMarker(marker);
}

function callbackBodyMatches(body, handle) {
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.getPrototypeOf(body) !== Object.prototype) return false;
    if (body.model !== handle.publicModel) return false;
    if (handle.streamMode ? body.stream !== true : (body.stream !== undefined && body.stream !== false)) return false;
    try {
        const recognized = recognizeCallableModel(body.model, { backendsPath: REGISTRY_FILE });
        return recognized.provider === handle.provider && recognized.model === handle.bareModel;
    } catch { return false; }
}

async function internalCallback(req, res) {
    if (!callbackEnvelopeAllowed(req)) return internalMarkerError(res);
    let handle;
    try { handle = requestCancellationRegistry.claim(req.headers[INTERNAL_REQUEST_TOKEN_HEADER]); }
    catch { return internalMarkerError(res); }

    let backendReq = null;
    let terminal = false;
    claimedCallbackWork.add(handle);
    const finishInner = () => {
        if (terminal) return;
        terminal = true;
        requestCancellationRegistry.finishInner(handle);
        claimedCallbackWork.delete(handle);
        maybeExitAfterDrain();
    };
    const cancelError = new Error('Delegated request cancelled.');
    const bound = requestCancellationRegistry.bindInnerAbort(handle, () => {
        try { req.destroy(cancelError); } catch { /* already closed */ }
        if (backendReq) { try { backendReq.destroy(cancelError); } catch { /* already closed */ } }
    });
    if (bound === 'already_cancelled') {
        finishInner();
        return;
    }

    let body;
    try {
        const raw = await readBoundedBody(req);
        body = JSON.parse(raw.toString('utf8'));
    } catch {
        finishInner();
        if (!res.destroyed) internalMarkerError(res);
        return;
    }
    if (!callbackBodyMatches(body, handle)) {
        requestCancellationRegistry.cancel(handle, 'protocol_failure');
        finishInner();
        if (!res.destroyed) internalMarkerError(res);
        return;
    }
    if (requestCancellationRegistry.isCancelled(handle)) {
        finishInner();
        return;
    }

    const registry = readRegistry();
    const state = registry && registry.get(handle.provider.toLowerCase());
    if (!state || state.backend !== handle.provider) {
        finishInner();
        return apiError(res, 503, 'Internal provider is unavailable.');
    }
    const internalBody = Buffer.from(JSON.stringify({ ...body, model: handle.bareModel }), 'utf8');
    const identity = handle.safeIdentity || {};
    const backendIdentity = state.local && state.backend === 'agentrouter'
        ? { ...identity, 'user-agent': undefined }
        : identity;
    const headers = exactBackendHeaders(state, internalBody.length, backendIdentity);
    if (!headers) {
        finishInner();
        return apiError(res, 503, 'Internal provider is unavailable.');
    }
    const u = state.url;
    const requester = u.protocol === 'https:' ? https.request : http.request;
    let retried = false;
    const failInner = () => {
        if (!res.headersSent && !res.destroyed && !requestCancellationRegistry.isCancelled(handle)) {
            apiError(res, 502, 'Internal upstream request failed.');
        } else if (!res.destroyed) res.destroy();
        finishInner();
    };
    res.on('close', () => {
        if (!res.writableFinished) {
            if (backendReq) { try { backendReq.destroy(cancelError); } catch { /* already closed */ } }
            finishInner();
        }
    });
    const send = () => {
        if (terminal || requestCancellationRegistry.isCancelled(handle)) {
            finishInner();
            return;
        }
        const candidate = requester({
            protocol: u.protocol,
            hostname: connectHost(u.hostname, state.local),
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            method: 'POST',
            path: joinUpstreamPath(u.pathname, '/v1/messages'),
            headers: { ...headers, host: u.host },
            timeout: UPSTREAM_TIMEOUT_MS,
        }, upstreamResponse => {
            if (requestCancellationRegistry.isCancelled(handle)) {
                upstreamResponse.destroy(cancelError);
                return;
            }
            if (handle.provider === 'a6api'
                && (upstreamResponse.statusCode || 502) >= 300) {
                return forwardA6apiErrorResponse(upstreamResponse, res, handle.publicModel, {
                    trustedLocal: state.local,
                    onCode: code => {
                        if (!terminal && !requestCancellationRegistry.isCancelled(handle)) {
                            callbackPublicErrorCodes.set(handle, code);
                        }
                    },
                    onFinish: finishInner,
                });
            }
            res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
            const tap = createTap({
                method: 'POST', url: '/v1/messages', backend: state.backend,
                ua: identity['user-agent'], status: upstreamResponse.statusCode, headers: upstreamResponse.headers,
            });
            if (tap) {
                upstreamResponse.on('data', tap.chunk);
                upstreamResponse.on('end', tap.end);
                upstreamResponse.on('aborted', tap.end);
            }
            upstreamResponse.pipe(res);
            upstreamResponse.on('error', () => {
                if (!res.destroyed) res.destroy();
                finishInner();
            });
            upstreamResponse.on('end', finishInner);
            upstreamResponse.on('aborted', finishInner);
        });
        backendReq = candidate;
        let connected = false;
        candidate.on('socket', socket => {
            if (!socket.connecting) connected = true;
            else socket.once('connect', () => { connected = true; });
        });
        candidate.on('timeout', () => candidate.destroy(new Error('upstream timeout')));
        candidate.on('error', error => {
            if (candidate !== backendReq || terminal) return;
            const port = upstreamPortOf(state);
            if (!retried && !connected && state.local && port && UPSTREAM_DOWN.has(error.code)
                && !requestCancellationRegistry.isCancelled(handle)) {
                retried = true;
                ensureKeepalive(port).then(result => {
                    if (terminal || requestCancellationRegistry.isCancelled(handle)) {
                        finishInner();
                        return;
                    }
                    if (result.ok) send();
                    else failInner();
                });
                return;
            }
            failInner();
        });
        if (requestCancellationRegistry.isCancelled(handle)) {
            candidate.destroy(cancelError);
            finishInner();
            return;
        }
        candidate.end(internalBody);
    };
    send();
}

function routeDirectCanonical(method, reqPath, body) {
    const pathname = String(reqPath || '').replace(/\?.*$/, '');
    if (method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) return null;
    let parsed;
    try { parsed = JSON.parse(body.toString('utf8') || '{}'); } catch { return null; }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || typeof parsed.model !== 'string') return null;
    let recognized;
    try { recognized = recognizeCallableModel(parsed.model, { backendsPath: REGISTRY_FILE }); }
    catch { return null; }
    const registry = readRegistry();
    const state = registry && registry.get(recognized.provider.toLowerCase());
    if (!state || state.backend !== recognized.provider) {
        return { exactError: true, provider: recognized.provider };
    }
    const internal = {
        state,
        prefix: recognized.provider,
        from: recognized.id,
        to: recognized.model,
        tier: null,
        final: true,
        exact: true,
        body: Buffer.from(JSON.stringify({ ...parsed, model: recognized.model }), 'utf8'),
    };
    rememberSessionRoute(parsed, state);
    return internal;
}

function stripUntrustedControlHeaders(req) {
    for (const name of Object.keys(req.headers)) {
        const lower = name.toLowerCase();
        if (lower.startsWith('x-bf-') || lower.startsWith('x-abuse-hub-')
            || ['x-route-final', 'x-route-exact', 'x-route-prefixed', 'x-route-tier'].includes(lower)) {
            delete req.headers[name];
        }
    }
}

function handle(req, res) {
    const reqPath = req.url || '/';
    const pathname = reqPath.replace(/\?.*$/, '');
    const presentedStatusAuth = pathname === '/__frontdoor/api/status'
        && countRawHeader(req, localHopAuth.headerName) === 1
        ? req.headers[localHopAuth.headerName]
        : null;
    const openAiPath = pathname === '/openai' || pathname.startsWith('/openai/');
    if (openAiPath && publicControlHeader(req)) {
        return openAiError(res, 400, 'invalid_request', 'Internal routing headers are not accepted.');
    }
    if (callbackCandidate(req)) return internalCallback(req, res);
    stripUntrustedControlHeaders(req);
    if (req.method === 'POST' && pathname === '/__drain') return startDrain(res);
    inflight += 1;
    res.on('close', () => { inflight -= 1; maybeExitAfterDrain(); });
    if (req.method === 'GET' && pathname === '/__frontdoor/api/status') {
        const statusAuth = presentedStatusAuth;
        localHopAuth.strip(req.headers);
        const body = JSON.stringify(statusPayload({
            detailed: req.headers.origin === undefined && localHopAuth.verify(statusAuth, 'status-inspection'),
        }));
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
        return res.end(body);
    }
    if (req.method === 'GET' && pathname === '/openai/v1/models') return openAiModels(res);
    if (req.method === 'POST' && reqPath === '/openai/v1/chat/completions') {
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
            return openAiError(res, 400, 'invalid_request', 'Content-Type must be application/json.');
        }
        return openAiChat(req, res);
    }
    if (pathname === '/openai' || pathname.startsWith('/openai/')) {
        return openAiError(res, 404, 'unsupported_route', 'Unsupported OpenAI route.');
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => { /* клиент отвалился — апстрим не дёргаем */ });
    req.on('end', () => {
        let state = readState();
        let body = Buffer.concat(chunks);
        const routed = routeDirectCanonical(req.method, reqPath, body)
            || routeByModel(req.method, body, readRegistry());
        if (routed) {
            if (routed.exactError) {
                return apiError(res, 503, `front-door: provider ${routed.provider} is unavailable.`);
            }
            // /model multi: тир не настроен / провайдер не в реестре — честная ошибка,
            // называющая блок multi и тир, без ухода на активный шлюз (чужой баланс).
            if (routed.multiError) {
                log(`${req.method} ${reqPath} ▸multi → ${routed.code || 400}: ${routed.message}`);
                return apiError(res, routed.code || 400, routed.message);
            }
            // Шлюз назван, а цели нет: `default` в «Маршрутах» не выбран. Отвечаем
            // честной ошибкой вместо угадывания — подставить activeModel значило бы
            // вернуть угадывание, а пропустить дальше — молча уехать на активный шлюз
            // (и на чужой баланс). Текст называет и шлюз, и что именно чинить.
            if (routed.noTarget) {
                // Две разные поломки — два разных текста. Ошибка обязана называть тот
                // файл, который правда сломан: подсказка «выбери default на вкладке» при
                // испорченном реестре отправляла владельца чинить исправное.
                if (routed.noMap) {
                    log(`${req.method} ${reqPath} ▸${routed.state.backend} (только шлюз): в реестре нет modelmap → 400`);
                    return apiError(res, 400,
                        `front-door: шлюз «${routed.state.backend}» выбран префиксом, но реестр ${REGISTRY_FILE} `
                        + `не указывает его тир-карту (modelmap: null), поэтому файл <префикс>-routes-modelmap.json `
                        + `не адресуется. Вкладка «Маршруты» тут НЕ виновата — значение default она читает напрямую `
                        + `и покажет его на месте. Починит запись переактивация шлюза в дашборде :8200 после `
                        + `перезапуска дашборда. Пока обходной путь — назвать модель явно: `
                        + `/model ${routed.state.backend}/<модель>`);
                }
                log(`${req.method} ${reqPath} ▸${routed.state.backend} (только шлюз): default не задан → 400`);
                return apiError(res, 400,
                    `front-door: шлюз «${routed.state.backend}» выбран префиксом, но модель по умолчанию у него не задана. `
                    + `Открой дашборд :8200 → вкладка «Маршруты» → строка ${routed.state.backend} → селект «default». `
                    + `Либо назови модель явно: /model ${routed.state.backend}/<модель>`);
            }
            state = routed.state;
            body = routed.body;
            routedCounts[state.backend] = (routedCounts[state.backend] || 0) + 1;
            routedLast[state.backend] = new Date().toISOString();
            log(`${req.method} ${reqPath} ▸${state.backend} (префикс модели): ${routed.from} → ${routed.to} → ${state.upstream}`);
        } else if (!state) {
            // Проверка стоит ПОСЛЕ разбора префикса сознательно: запрос, который сам
            // назвал провайдера, не должен падать из-за битого active-backend.json —
            // ему глобальный бэкенд не нужен вовсе.
            log(`${req.method} ${reqPath} → 503: ${stateCache.error}`);
            return apiError(res, 503, `front-door :${PORT}: ${stateCache.error}. Открой дашборд :8200 и выбери провайдера.`);
        }
        forward(req, res, state, body, reqPath, routed);
    });
}

function restoreCanonicalNativeObject(value, publicModel) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error('Canonical native response must be an object.');
    }
    const restored = { ...value };
    if (Object.hasOwn(restored, 'model')) restored.model = publicModel;
    return restored;
}

function createCanonicalNativeSseRestorer(publicModel) {
    let pending = Buffer.alloc(0);
    let eventType = '';
    let dataLines = [];
    let sawMessageStop = false;
    let sawDataObject = false;

    function resetEvent() {
        eventType = '';
        dataLines = [];
    }

    function restoreObject(value) {
        if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
            throw new Error('Canonical native SSE data must be an object.');
        }
        const restored = { ...value };
        if (Object.hasOwn(restored, 'model')) restored.model = publicModel;
        if (restored.message && !Array.isArray(restored.message) && typeof restored.message === 'object') {
            restored.message = { ...restored.message, model: publicModel };
        }
        return restored;
    }

    function dispatch() {
        if (!eventType && dataLines.length === 0) return Buffer.alloc(0);
        const payload = dataLines.join('\n');
        if (!payload) {
            const raw = eventType ? `event: ${eventType}\n\n` : '\n';
            resetEvent();
            return Buffer.from(raw, 'utf8');
        }
        if (payload === '[DONE]') throw new Error('Anthropic canonical SSE must not use [DONE].');
        const value = JSON.parse(payload);
        const restored = restoreObject(value);
        sawDataObject = true;
        const objectType = typeof value.type === 'string' ? value.type : '';
        if (eventType === 'message_stop' || objectType === 'message_stop') {
            if (sawMessageStop || (eventType && eventType !== 'message_stop') || objectType !== 'message_stop') {
                throw new Error('Invalid canonical native message_stop event.');
            }
            sawMessageStop = true;
        } else if (sawMessageStop) {
            throw new Error('Canonical native SSE data followed message_stop.');
        }
        const eventLine = eventType ? `event: ${eventType}\n` : '';
        const result = Buffer.from(`${eventLine}data: ${JSON.stringify(restored)}\n\n`, 'utf8');
        resetEvent();
        return result;
    }

    function consumeLine(rawLine) {
        let line = rawLine;
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
        if (line.length === 0) return dispatch();
        if (line[0] === 0x3a) return Buffer.concat([line, Buffer.from('\n')]);
        const colon = line.indexOf(0x3a);
        const field = (colon < 0 ? line : line.subarray(0, colon)).toString('utf8');
        let value = colon < 0 ? Buffer.alloc(0) : line.subarray(colon + 1);
        if (value.length && value[0] === 0x20) value = value.subarray(1);
        if (field === 'event') eventType = value.toString('utf8');
        else if (field === 'data') dataLines.push(value.toString('utf8'));
        else return Buffer.concat([line, Buffer.from('\n')]);
        return Buffer.alloc(0);
    }

    return new Transform({
        transform(chunk, _encoding, callback) {
            try {
                pending = Buffer.concat([pending, Buffer.from(chunk)]);
                let newline;
                while ((newline = pending.indexOf(0x0a)) >= 0) {
                    if (newline > OPENAI_SSE_LINE_MAX_BYTES) throw new Error('Canonical native SSE line is too large.');
                    const line = pending.subarray(0, newline);
                    pending = pending.subarray(newline + 1);
                    const output = consumeLine(line);
                    if (output.length) this.push(output);
                }
                if (pending.length > OPENAI_SSE_LINE_MAX_BYTES) throw new Error('Canonical native SSE line is too large.');
                callback();
            } catch (error) { callback(error); }
        },
        flush(callback) {
            try {
                if (pending.length) {
                    const output = consumeLine(pending);
                    if (output.length) this.push(output);
                }
                pending = Buffer.alloc(0);
                const final = dispatch();
                if (final.length) this.push(final);
                if (!sawMessageStop) {
                    throw new Error(sawDataObject
                        ? 'Canonical native SSE stream ended without message_stop.'
                        : 'Canonical native SSE stream ended without data or message_stop.');
                }
                callback();
            } catch (error) { callback(error); }
        },
    });
}

function canonicalNativeDecoder(encoding) {
    if (!encoding || encoding === 'identity') return null;
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip();
    if (encoding === 'deflate') return zlib.createInflate();
    if (encoding === 'br' && typeof zlib.createBrotliDecompress === 'function') return zlib.createBrotliDecompress();
    if (encoding === 'zstd' && typeof zlib.createZstdDecompress === 'function') return zlib.createZstdDecompress();
    return false;
}

function forwardCanonicalNativeResponse(upRes, res, publicModel) {
    const encoding = String(upRes.headers['content-encoding'] || '').trim().toLowerCase();
    const decoder = canonicalNativeDecoder(encoding);
    if (decoder === false) {
        upRes.on('error', () => {});
        upRes.destroy();
        apiError(res, 502, 'front-door: canonical native upstream returned an unsupported encoded response.');
        return;
    }
    const contentType = String(upRes.headers['content-type'] || '').toLowerCase();
    if (/text\/event-stream/.test(contentType)) {
        const headers = { ...upRes.headers };
        delete headers['content-length'];
        delete headers['content-encoding'];
        res.writeHead(upRes.statusCode || 502, headers);
        const restorer = createCanonicalNativeSseRestorer(publicModel);
        const streams = decoder ? [upRes, decoder, restorer, res] : [upRes, restorer, res];
        pipeline(...streams, error => {
            if (error && !res.destroyed) res.destroy();
        });
        return;
    }
    const source = decoder || upRes;
    const chunks = [];
    let bytes = 0;
    let failed = false;
    const fail = () => {
        if (failed) return;
        failed = true;
        if (!upRes.destroyed) upRes.destroy();
        if (decoder && !decoder.destroyed) decoder.destroy();
        if (!res.headersSent && !res.destroyed) apiError(res, 502, 'front-door: invalid canonical native response.');
        else if (!res.destroyed) res.destroy();
    };
    upRes.on('error', fail);
    upRes.on('aborted', fail);
    if (decoder) {
        decoder.on('error', fail);
        upRes.pipe(decoder);
    }
    source.on('data', chunk => {
        if (failed) return;
        bytes += chunk.length;
        if (bytes > OPENAI_BODY_MAX_BYTES) return fail();
        chunks.push(chunk);
    });
    source.on('end', () => {
        if (failed || res.destroyed) return;
        try {
            const restored = restoreCanonicalNativeObject(
                JSON.parse(Buffer.concat(chunks).toString('utf8')),
                publicModel,
            );
            const body = Buffer.from(JSON.stringify(restored), 'utf8');
            const headers = { ...upRes.headers, 'content-length': String(body.length) };
            delete headers['transfer-encoding'];
            delete headers['content-encoding'];
            res.writeHead(upRes.statusCode || 502, headers);
            res.end(body);
        } catch { fail(); }
    });
}

function forward(req, res, state, reqBody, reqPath, routed, retried) {
    const u = state.url;
    const requester = u.protocol === 'https:' ? https.request : http.request;
    let headers = routed && routed.exact && !state.local
        ? directExactRemoteHeaders(state, req.headers, reqBody.length)
        : Object.assign({}, req.headers);
    headers.host = u.host;
    let body = reqBody;

    // Тело уже переписано разбором префикса — длина обязана совпасть. Раньше эта строка
    // была только в ветке !state.local: у локальных апстримов тело не трогали вовсе.
    // 🪤 При transfer-encoding content-length ставить нельзя (RFC 9112 §6.2).
    if (routed && !headers['transfer-encoding']) headers['content-length'] = String(Buffer.byteLength(body));

    // Разницу «пришло через префикс или нет» видит ТОЛЬКО front-door: к моменту
    // keepalive префикс уже срезан, и отличить `/model agentrouter` от обычного запроса
    // по телу невозможно. Поэтому говорим заголовком — по нему keepalive возьмёт
    // routes-карту вместо карты активного шлюза.
    // 🪤 Маппить здесь самим нельзя: keepalive применит свою карту ещё раз поверх нашей,
    // и получится двойная подмена (модель → цель → цель цели).
    if (routed) {
        if (!routed.exact) {
            headers['x-route-prefixed'] = '1';
            if (routed.tier) headers['x-route-tier'] = routed.tier;
        }
        // /model multi: модель уже конечная — keepalive НЕ должен ремапить её по тир-карте
        // резолвленного шлюза (иначе кросс-шлюзовой выбор владельца потеряется).
        if (routed.final) headers['x-route-final'] = '1';
        if (routed.exact) headers['x-route-exact'] = '1';
        if (routed.exact && state.local) {
            headers[localHopAuth.headerName] = trustedFrontdoorRouteAuth();
        }
    } else {
        // Клиент мог прислать заголовок сам — снимаем оба, иначе чужой запрос притворится
        // финальным/префиксным и уведёт keepalive не туда.
        delete headers['x-route-final'];
        delete headers['x-route-exact'];
        localHopAuth.strip(headers);
        // Клиент мог прислать заголовок сам — снимаем, иначе чужой запрос притворится
        // префиксным и уведёт keepalive на не ту карту.
        delete headers['x-route-prefixed'];
        delete headers['x-route-tier'];
    }

    if (state.local) {
        headers[localHopAuth.headerName] = trustedFrontdoorRouteAuth();
    } else {
        // Ключ читаем на КАЖДЫЙ запрос: на этом стоит смена аккаунта без рестарта CC
        // и авто-ротация FreeModel. Мирроринг keepalive-proxy.js:771-774.
        const credentials = readRemoteCredentials(state);
        if (state.keyFile && !credentials) {
            log(`${req.method} ${reqPath} → 503: пустой ${state.keyFile} (${state.backend})`);
            return apiError(res, 503, `front-door: у ${state.backend} нет активного ключа (${state.keyFile}). Активируй аккаунт в дашборде.`);
        }
        if (credentials) Object.assign(headers, credentials);
        if (!routed || !routed.exact) {
            const mm = readModelMap(state.modelmap);
            const remap = remapForRemote(req.method, reqPath, body, mm, state.backend === 'cun');
            if (remap) {
                body = remap.body;
                headers['content-length'] = String(Buffer.byteLength(body));
                log(`${req.method} ${reqPath} ${state.backend}: ${remap.from} → ${remap.to}`);
            } else if (!mm && req.method === 'POST' && /claude-/i.test(modelOf(body))) {
                // Шлюз без карты тиров: claude-модель уедет как есть. Первый признак
                // будущего 404 «no such model» — пусть это будет видно в логе, а не в догадках.
                log(`${req.method} ${reqPath} ${state.backend}: claude-* уходит на шлюз без ${state.modelmap || 'карты моделей'}`);
            }
        }
        if (routed && routed.exact) {
            delete headers['x-route-final'];
            delete headers['x-route-exact'];
            delete headers['x-route-prefixed'];
            delete headers['x-route-tier'];
            localHopAuth.strip(headers);
            for (const name of Object.keys(headers)) {
                const lower = name.toLowerCase();
                if (lower.startsWith('x-abuse-hub-') || lower.startsWith('x-bf-')) delete headers[name];
            }
        }
    }

    const upReq = requester({
        protocol: u.protocol,
        hostname: connectHost(u.hostname, state.local),
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: joinUpstreamPath(u.pathname, reqPath),
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
    }, (upRes) => {
        if (state.backend === 'a6api' && (upRes.statusCode || 502) >= 300) {
            const publicModel = routed && routed.exact ? routed.from : `a6api/${modelOf(body)}`;
            return forwardA6apiErrorResponse(upRes, res, publicModel, { trustedLocal: state.local });
        }
        // Счётчик токенов висит РЯДОМ с трубой: слушатель `data` получает те же
        // чанки, что и `pipe`, ответ клиенту от этого не задерживается и не меняется.
        // Через front-door идут все харнессы, поэтому это единственное место, где
        // видно весь расход разом (см. usage-tap.js).
        const tap = createTap({
            method: req.method, url: reqPath, backend: state.backend,
            ua: req.headers['user-agent'], status: upRes.statusCode, headers: upRes.headers,
        });
        if (tap) {
            upRes.on('data', tap.chunk);
            upRes.on('end', tap.end);
            upRes.on('aborted', tap.end);       // клиент ушёл — считаем то, что успело прийти
        }
        if (routed && routed.exact) {
            return forwardCanonicalNativeResponse(upRes, res, routed.from);
        }
        // Тело не трогаем вообще: SSE, gzip/zstd, MODEL_ECHO — не наша забота,
        // ретраев нет, значит и буферизовать нечего. Просто труба.
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
        // Тот же принцип, что в apiError: недописанный ответ обязан выглядеть
        // недописанным. `res.end()` здесь закрывал бы поток штатно, и клиент считал бы
        // обрезанный ответ полным — вместо повторяемой транспортной ошибки.
        upRes.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    });

    let upstreamConnected = false;
    upReq.on('socket', socket => {
        if (!socket.connecting) upstreamConnected = true;
        else socket.once('connect', () => { upstreamConnected = true; });
    });
    upReq.on('timeout', () => {
        log(`${req.method} ${reqPath} ${state.backend}: таймаут ${UPSTREAM_TIMEOUT_MS}мс`);
        upReq.destroy(new Error('upstream timeout'));
    });
    upReq.on('error', (e) => {
        // Ретраев тут нет сознательно: они живут в keepalive, дубль = второй платный запрос.
        //
        // Единственное исключение — префиксный запрос, чей ЛОКАЛЬНЫЙ keepalive не поднят.
        // Оно безопасно ровно потому, что платного запроса не было: UPSTREAM_DOWN значит,
        // что соединение не установилось и до шлюза не доехало ничего. Тело уже забуферено
        // (`upReq.end(body)`), значит второй forward не требует перечитывания req.
        // Для глобального бэкенда так НЕ делаем: там порт мог погасить владелец руками, а
        // за подъём отвечает bootSpawnActiveBackend() — авто-подъём был бы дракой с ним.
        const port = upstreamPortOf(state);
        if (routed && state.local && !retried && !upstreamConnected && e.code !== 'ECONNRESET' && port
            && UPSTREAM_DOWN.has(e.code) && !res.headersSent) {
            log(`${req.method} ${reqPath} ${state.backend}: ${e.code} — поднимаю keepalive :${port} по требованию`);
            ensureKeepalive(port).then((r) => {
                if (res.destroyed || res.writableEnded) return;      // клиент уже ушёл
                if (r.ok) {
                    log(`${req.method} ${reqPath} ${state.backend}: keepalive :${port} ${r.already ? 'уже жив' : 'поднят'} — повторяю запрос`);
                    return forward(req, res, state, reqBody, reqPath, routed, true);
                }
                log(`${req.method} ${reqPath} ${state.backend}: подъём :${port} не удался — ${r.error || '?'}`);
                apiError(res, 502, `front-door → ${state.backend}: ${e.code || e.message}. Прокси ${state.upstream} не слушает, автоподъём не удался: ${r.error || '?'} (шлюз выбран префиксом модели \`${routed.prefix}/\`, активный бэкенд ни при чём).`);
            });
            return;
        }
        const hint = state.local && UPSTREAM_DOWN.has(e.code)
            ? ` Прокси ${state.upstream} не слушает — подними его кнопкой в Health или переактивируй провайдера.`
            : '';
        // Без этой приписки владелец идёт чинить активный бэкенд, хотя запрос уехал
        // совсем не туда — его увёл префикс модели.
        const via = routed ? ` (шлюз выбран префиксом модели \`${routed.prefix}/\`, активный бэкенд ни при чём)` : '';
        log(`${req.method} ${reqPath} ${state.backend}: ${e.code || e.message}${retried ? ' (уже после автоподъёма)' : ''}`);
        apiError(res, 502, `front-door → ${state.backend}: ${e.code || e.message}.${hint}${via}`);
    });
    // ── Клиент ушёл (Ctrl-C, ESC в CC, свой таймаут стрима) ───────────────────
    // 🪤 `req.on('aborted')` СЛОМАН на Node 17+ (deprecated с 16-й) — в обычном пути
    // обрыва он не приходит, и до 25.08 здесь стоял только он. Цена: front-door не
    // узнавал об уходе клиента и держал запрос к keepalive до своего таймаута 600с.
    // По логам за один день **349 таких висяков** против 3 у keepalive, который тот же
    // случай ловит правильно (`req.on('close')` + `res.on('close')`).
    // Хуже, чем просто занятый сокет: пока мы держим запрос, шлюз ПРОДОЛЖАЕТ
    // генерировать и берёт за это деньги — на плоском тарифе полную цену запроса за
    // ответ, которого никто не прочитает.
    // Поэтому слушаем `close` — но с ПРАВИЛЬНЫМИ сторожами, зеркаля keepalive-proxy.js
    // (§ конец handle): у `res` признак ухода — `!res.writableEnded`, у `req` — строго
    // `!req.complete`.
    // 🪤 Сторож у `req` обязателен и обязан быть именно таким: `close` на серверном
    // запросе приходит, когда ДОЧИТАНО ТЕЛО, а не когда ушёл клиент. Первая версия
    // этой правки проверяла у `req` тот же `res.writableEnded` — и рвала апстрим на
    // каждом запросе через 50 мс после старта. Поймано регрессом
    // `tools/check-frontdoor-abort.js` на подставном порту, до живого стека не дошло.
    let clientGone = false;
    const dropUpstream = (why) => {
        if (clientGone) return;
        clientGone = true;
        log(`${req.method} ${reqPath} ${state.backend}: клиент ушёл (${why}) — рву апстрим`);
        try { upReq.destroy(); } catch { /* уже мёртв */ }
    };
    req.on('aborted', () => dropUpstream('aborted'));
    req.on('close', () => { if (!req.complete) dropUpstream('тело запроса не дочитано'); });
    res.on('close', () => { if (!res.writableEnded) dropUpstream('ответ не дописан'); });
    upReq.end(body);
}

function modelOf(body) {
    try { return JSON.parse(body.toString('utf8') || '{}').model || ''; } catch { return ''; }
}

// ── Самопроверка (до server.listen: порт не занимаем) ─────────────────────────
if (process.argv[2] === 'selftest') {
    const assert = require('assert');

    // 1. Разбор состояния: local/remote, мусор.
    const local = parseState(JSON.stringify({ backend: 'gorouter', upstream: 'http://127.0.0.1:20156' }));
    assert.strictEqual(local.local, true, 'localhost = локальный апстрим');
    assert.strictEqual(local.keyFile, null, 'у локального нет keyFile');
    const remote = parseState(JSON.stringify({
        backend: 'conduit', upstream: 'https://conduit.ozdoev.net/v1',
        keyFile: 'cdt-active-key.txt', modelmap: 'cdt-modelmap.json',
    }));
    assert.strictEqual(remote.local, false, 'внешний хост = удалённый апстрим');
    assert.strictEqual(remote.keyFile, 'cdt-active-key.txt', 'keyFile читается');
    assert.strictEqual(parseState(JSON.stringify({ backend: 'x', upstream: 'http://localhost:20155' })).local, true, 'localhost по имени');
    assert.throws(() => parseState('{"backend":"x"}'), /нет upstream/, 'без upstream — ошибка');
    assert.throws(() => parseState('{"upstream":"ftp://x/"}'), /не http/, 'не-http upstream — ошибка');
    assert.throws(() => parseState('не json'), 'мусор — ошибка');

    // 2. Путь апстрима: base шлюза + путь клиента, с схлопыванием дубля /v1.
    //    Замерено на живых шлюзах 2026-08-20: ourtoken отвечает на /v1/models (403
    //    «banned» — т.е. путь дошёл) и 404 «Invalid URL (/v1/v1/models)» на дубле;
    //    evomap так же. aerolink (base без пути) отдал каталог 200.
    const jp = (up, p) => joinUpstreamPath(new URL(up).pathname, p);
    assert.strictEqual(jp('https://api.evomap.ai/v1', '/v1/messages'), '/v1/messages', 'дубль /v1 схлопнут');
    assert.strictEqual(jp('http://localhost:20128/v1', '/v1/messages'), '/v1/messages', 'omniroute тоже');
    assert.strictEqual(jp('https://api.svrtr.org', '/v1/messages'), '/v1/messages', 'base без пути');
    assert.strictEqual(jp('https://capi.aerolink.lat/', '/v1/models'), '/v1/models', 'хвостовой слэш не мешает');
    assert.strictEqual(jp('http://127.0.0.1:20156', '/v1/messages?beta=true'), '/v1/messages?beta=true', 'query не теряется');
    assert.strictEqual(jp('https://api.evomap.ai/v1', '/health'), '/v1/health', 'не-/v1 путь дописывается к base');
    assert.strictEqual(joinUpstreamPath('/api/v1', '/v1/messages'), '/api/v1/messages', 'схлопывание не съедает префикс');

    // 3. Ремап тела для удалённых: срез суффикса окна и карта тиров.
    const bodyOf = (o) => Buffer.from(JSON.stringify(o), 'utf8');
    const noMap = null;
    const r1 = remapForRemote('POST', '/v1/messages', bodyOf({ model: 'claude-opus-5[1m]', max_tokens: 1 }), noMap);
    assert.strictEqual(r1.to, 'claude-opus-5', 'суффикс [1m] срезан');
    assert.strictEqual(JSON.parse(r1.body).max_tokens, 1, 'остальное тело сохранено');
    assert.strictEqual(remapForRemote('POST', '/v1/messages', bodyOf({ model: 'claude-opus-5' }), noMap), null,
        'без суффикса и без карты тело не трогаем');
    const mm = { opus: 'gpt-5.4', sonnet: '', haiku: '' };
    const r2 = remapForRemote('POST', '/v1/messages', bodyOf({ model: 'claude-opus-5[1m]' }), mm);
    assert.strictEqual(r2.to, 'gpt-5.4', 'карта тиров приоритетнее среза суффикса');
    const r3 = remapForRemote('POST', '/v1/messages', bodyOf({ model: 'claude-sonnet-5[1m]' }), mm);
    assert.strictEqual(r3.to, 'claude-sonnet-5', 'пустой тир в карте = только срез суффикса');
    const cunGpt = bodyOf({ model: 'gpt-5.6-sol[1m]' });
    assert.strictEqual(remapForRemote('POST', '/v1/messages', cunGpt, noMap, true), null,
        'Cun получает GPT 5.6 с [1m] без переписывания тела');
    assert.strictEqual(remapForRemote('POST', '/v1/messages', cunGpt, noMap, false).to, 'gpt-5.6-sol',
        'другие удалённые шлюзы по-прежнему получают GPT без клиентского суффикса');
    assert.strictEqual(remapForRemote('GET', '/v1/models', bodyOf({ model: 'claude-opus-5[1m]' }), mm), null, 'не POST — не трогаем');
    assert.strictEqual(remapForRemote('POST', '/v1/messages/count_tokens', bodyOf({ model: 'claude-opus-5[1m]' }), mm), null,
        'count_tokens форвардим как есть, своей оценки не даём');
    assert.strictEqual(remapForRemote('POST', '/v1/messages', Buffer.from('не json'), mm), null, 'битое тело не ломает прокси');
    // Пробник валидации модели CC (stream=false, 2 сообщения, без tools) — обычный запрос.
    const probe = remapForRemote('POST', '/v1/messages', bodyOf({
        model: 'claude-opus-5[1m]', stream: false, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
    }), noMap);
    assert.strictEqual(probe.to, 'claude-opus-5', 'пробник /model проходит как обычный запрос');

    // 3c. Роутинг по префиксу модели: выбор бэкенда + срез префикса.
    const reg = new Map([
        ['aipm', parseStateDoc({ backend: 'aipm', upstream: 'http://localhost:20163' })],
        ['conduit', parseStateDoc({
            backend: 'conduit', upstream: 'https://conduit.ozdoev.net/v1',
            keyFile: 'cdt-active-key.txt', modelmap: 'cdt-modelmap.json',
        })],
    ]);
    reg.set('ap', reg.get('aipm'));                     // алиас указывает на ТУ ЖЕ запись
    const rb = (m, meth = 'POST') => routeByModel(meth, bodyOf({ model: m, max_tokens: 1 }), reg);
    assert.strictEqual(rb('aipm/claude-opus-4-6[1m]').state.backend, 'aipm', 'префикс выбирает провайдера');
    // Главный инвариант правки: срезается ТОЛЬКО префикс. Суффикс окна остаётся —
    // его снимет remapForRemote/keepalive, как и для беспрефиксных моделей.
    assert.strictEqual(rb('aipm/claude-opus-4-6[1m]').to, 'claude-opus-4-6[1m]', 'срезан только префикс, окно [1m] цело');
    assert.strictEqual(JSON.parse(rb('aipm/claude-opus-4-6').body).max_tokens, 1, 'остальное тело сохранено');
    assert.strictEqual(rb('ap/claude-opus-4-6').state.backend, 'aipm', 'алиас резолвится');
    assert.strictEqual(rb('AIPM/claude-opus-4-6').state.backend, 'aipm', 'регистр имени провайдера не важен');
    assert.strictEqual(rb('aipm/ claude-opus-4-6').to, 'claude-opus-4-6', 'пробел после provider/ не становится частью model id');
    assert.strictEqual(rb('anthropic/claude-opus-4-8'), null, 'чужой префикс не трогаем и не гадаем');
    assert.strictEqual(rb('openai/gpt-4o'), null, 'легитимное имя с / у кастом-провайдера — тоже мимо');
    assert.strictEqual(rb('claude-opus-5[1m]'), null, 'без префикса — глобальный бэкенд');
    assert.strictEqual(rb('/claude-opus-5'), null, 'ведущий слэш — не префикс');
    assert.strictEqual(rb('aipm/'), null, 'префикс без модели');
    assert.strictEqual(rb('aipm/claude-opus-4-6', 'GET'), null, 'не POST — не трогаем');
    assert.strictEqual(routeByModel('POST', Buffer.from('не json'), reg), null, 'битое тело не ломает прокси');
    assert.strictEqual(routeByModel('POST', bodyOf({ max_tokens: 1 }), reg), null, 'нет поля model');
    assert.strictEqual(routeByModel('POST', bodyOf({ model: 'aipm/x' }), new Map()), null, 'пустой реестр = как до правки');
    assert.strictEqual(routeByModel('POST', bodyOf({ model: 'aipm/x' }), null), null, 'нет реестра = как до правки');
    // Путь на роутинг не влияет: count_tokens и /v1/chat/completions от opencode обязаны
    // ехать туда же, куда их послали, иначе попадут на чужой шлюз с неизвестным именем.
    assert.ok(rb('aipm/claude-opus-4-6'), 'путь не фильтруется (count_tokens/chat.completions роутятся)');
    // После среза префикса тир-карта провайдера обязана работать как обычно.
    assert.strictEqual(
        remapForRemote('POST', '/v1/messages', rb('conduit/claude-opus-5[1m]').body, { opus: 'gpt-5.4', sonnet: '', haiku: '' }).to,
        'gpt-5.4', 'после среза префикса карта тиров применяется');


    assert.strictEqual(connectHost('localhost', true), '127.0.0.1', 'локальный localhost уходит в IPv4');
    assert.strictEqual(connectHost('0.0.0.0', true), '127.0.0.1', '0.0.0.0 тоже (connect в него бессмысленен)');
    assert.strictEqual(connectHost('127.0.0.1', true), '127.0.0.1', 'уже IPv4 — без изменений');
    assert.strictEqual(connectHost('::1', true), '::1', 'явный ::1 — воля пользователя, не подменяем');
    assert.strictEqual(connectHost('localhost', false), 'localhost', 'удалённый апстрим не переписываем');
    assert.strictEqual(connectHost('api.evomap.ai', false), 'api.evomap.ai', 'домен шлюза не трогаем');
    // Подсказка «прокси не слушает» должна ловить и EACCES: именно так выглядел
    // мёртвый gorouter :20156 через localhost/::1 (2026-08-20).
    assert.ok(UPSTREAM_DOWN.has('EACCES') && UPSTREAM_DOWN.has('ECONNREFUSED'),
        'оба кода мёртвого локального апстрима дают подсказку');

    // 4. Локальный апстрим: callback helper выдаёт route-control, но не ключ;
    //    удалённый helper выдаёт серверный ключ, но не route-control.
    const localHeaders = exactBackendHeaders(
        parseStateDoc({ backend: 'local', upstream: 'http://127.0.0.1:1' }),
        2,
    );
    assert.strictEqual(localHeaders.authorization, undefined, 'локальный exact helper не инжектит ключ');
    assert.strictEqual(localHeaders['x-route-final'], '1', 'локальный exact helper ставит trusted final');
    assert.strictEqual(localHeaders['x-route-exact'], '1', 'локальный exact helper ставит trusted exact');
    const remoteNoKey = exactBackendHeaders(
        parseStateDoc({ backend: 'remote', upstream: 'https://example.invalid', keyFile: 'missing-selftest-key' }),
        2,
    );
    assert.strictEqual(remoteNoKey, null, 'удалённый exact helper fail-closed без серверного ключа');
    // Ровно один вызов обычного апстрима на запрос: ретраи и хеджи живут в keepalive,
    // дубль отсюда - второй платный запрос к шлюзу.
    const src = fs.readFileSync(__filename, 'utf8');
    assert.strictEqual((src.match(/^\s*const upReq = requester\(\{/gm) || []).length, 1,
        'апстрим дёргается ровно из одного места (нет ретраев/хеджей)');
    assert.ok(/server\.listen\(PORT, '127\.0\.0\.1'/.test(src), 'слушаем только 127.0.0.1 (инжектим ключи)');
    // Правило из шапки файла: провайдеров и портов здесь нет, они приходят файлом от
    // дашборда. Если кто-то «для удобства» впишет порт — тест обязан упасть.
    // 🪤 Смотрим ТОЛЬКО боевую часть файла: в самом selftest порты — это фикстуры
    // (фейковый реестр, адреса шлюзов в проверках склейки пути), и запрещать их там
    // значило бы запретить тестировать.
    const srcProd = src.slice(0, src.indexOf("if (process.argv[2] === 'selftest')"))
        .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    assert.ok(!/2013(?:[0-4]|[6-9])|2015[0-9]|2016[0-9]/.test(srcProd),
        'в коде front-door нет портов провайдеров (20135 - pinned Bifrost sidecar)');
    assert.ok(/BACKENDS_FILE|backends\.json/.test(src), 'реестр провайдеров читается из файла');
    // Длину тела после переписывания префиксом обязаны пересчитать и для ЛОКАЛЬНЫХ
    // апстримов: раньше тело у них не трогалось вовсе, и content-length брался клиентский.
    assert.ok(/if \(routed && !headers\['transfer-encoding'\]\) headers\['content-length'\]/.test(src),
        'после среза префикса content-length пересчитан (включая локальные апстримы)');
    // Уход клиента ловится через `close`, а не только через сломанный на Node 17+
    // `aborted`: без этого front-door держал апстрим до своего таймаута (349 висяков
    // за день 25.08) и платил шлюзу за ответы, которые никто не читает.
    assert.ok(/req\.on\('close'/.test(src) && /res\.on\('close'/.test(src),
        'уход клиента ловится по close (req и res)');
    // Сторожа перепутать нельзя: у req это !req.complete, у res — !res.writableEnded.
    // С неверным сторожем у req прокси рвёт КАЖДЫЙ запрос сразу после чтения тела.
    assert.ok(/req\.on\('close', \(\) => \{ if \(!req\.complete\)/.test(src),
        'у req сторож — !req.complete (close приходит по дочитанному телу)');
    assert.ok(/res\.on\('close', \(\) => \{ if \(!res\.writableEnded\)/.test(src),
        'у res сторож — !res.writableEnded');

    // 5a. Обрыв должен доезжать обрывом: `res.end()` при уже отправленных заголовках
    //     превращает недописанный ответ в «успешный», и клиент падает на разборе тела
    //     вместо повтора. Критично для удержания keepalive, где до отказа наружу ушли
    //     только пробелы или пинги.
    assert.ok(/if \(res\.headersSent\) \{ try \{ res\.destroy\(\); \} catch/.test(src),
        'apiError при отправленных заголовках рвёт соединение, а не закрывает его штатно');
    assert.ok(/upRes\.on\('error', \(\) => \{ try \{ res\.destroy\(\); \} catch/.test(src),
        'ошибка тела апстрима тоже рвёт ответ клиенту');
    assert.strictEqual((src.match(/try \{ res\.end\(\); \} catch/g) || []).length, 0,
        'ни одного пути, где обрыв отмывается в res.end()');

    // 5. Ошибки в форме Anthropic.
    let captured = null;
    apiError({ writeHead() {}, end(b) { captured = b; }, headersSent: false }, 503, 'тест');
    const err = JSON.parse(captured);
    assert.strictEqual(err.type, 'error', 'тело ошибки в форме Anthropic');
    assert.ok(err.error.message.includes('тест'), 'сообщение доезжает до клиента');

    // 3d. Сессия окна -> провайдер: агент без префикса наследует карту именно окна,
    // а не active-backend. Две сессии одновременно не смешиваются.
    const sessionA = JSON.stringify({ model: 'a6api/gpt-6-sol', metadata: { user_id: JSON.stringify({ session_id: 'window-a' }) } });
    const sessionB = JSON.stringify({ model: 'premier/free-deepseek-4.1-flash', metadata: { user_id: JSON.stringify({ session_id: 'window-b' }) } });
    const stateA = parseStateDoc({ backend: 'a6api', upstream: 'http://127.0.0.1:29191', modelmap: 'a6api-modelmap.json' });
    const stateB = parseStateDoc({ backend: 'premier', upstream: 'http://127.0.0.1:29192', modelmap: 'premier-modelmap.json' });
    rememberSessionRoute(JSON.parse(sessionA), stateA); rememberSessionRoute(JSON.parse(sessionB), stateB);
    assert.strictEqual(sessionRouteFor({ metadata: { user_id: JSON.stringify({ session_id: 'window-a' }) } }).backend, 'a6api', 'окно A помнит a6api');
    assert.strictEqual(sessionRouteFor({ metadata: { user_id: JSON.stringify({ session_id: 'window-b' }) } }).backend, 'premier', 'окно B помнит Premier');
    assert.strictEqual(sessionRouteFor({ metadata: { user_id: JSON.stringify({ session_id: 'unknown' }) } }), null, 'чужая сессия не наследует провайдера');
    assert.ok(sessionIdOf({ metadata: { user_id: JSON.stringify({ session_id: 'window-a' }) } }) === 'window-a', 'session_id извлекается из user_id');
    const sessionReg = new Map([['a6api', stateA], ['premier', stateB]]);
    const childA = routeByModel('POST', bodyOf({ model: 'claude-opus-5', metadata: { user_id: JSON.stringify({ session_id: 'window-a' }) } }), sessionReg);
    const childB = routeByModel('POST', bodyOf({ model: 'claude-opus-5', metadata: { user_id: JSON.stringify({ session_id: 'window-b' }) } }), sessionReg);
    assert.strictEqual(childA.state.backend, 'a6api', 'агент окна A идёт в a6api');
    assert.strictEqual(childB.state.backend, 'premier', 'агент окна B идёт в Premier');
    assert.equal(JSON.parse(childA.body).model, readModelMap('a6api-routes-modelmap.json').opus, 'агент A получает тир-карту a6api');
    assert.equal(JSON.parse(childB.body).model, readModelMap('premier-routes-modelmap.json').opus, 'агент B получает тир-карту Premier');

    try { fs.rmSync(LOCAL_HOP_SELFTEST_FILE, { force: true }); } catch { /* absent */ }
    console.log('selftest OK');
    process.exit(0);
}

const server = http.createServer(handle);
server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
server.listen(PORT, '127.0.0.1', () => {
    log(`front-door на http://127.0.0.1:${PORT}, состояние из ${STATE_FILE}`);
    const s = readState();
    if (!s) log(`ВНИМАНИЕ: ${stateCache.error} — запросы будут отвечать 503, пока дашборд не запишет бэкенд`);
});
