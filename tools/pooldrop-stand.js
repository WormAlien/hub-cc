#!/usr/bin/env node
'use strict';
/**
 * pooldrop-stand.js — СКВОЗНОЙ стенд пул-фолбэка: «402 пул пуст» → уход на беспуловую модель
 * → переключение тир-карты на диске → возврат карты, когда пул налили.
 *
 * Зачем отдельно от `check-pool-fallback.js` и `check-pooldrop.js`. Те гоняют куски по
 * отдельности: первый — боевой keepalive с ФАЛЬШИВЫМ дашбордом, второй — функции дашборда
 * в песочнице. Стык между ними не проверял никто, и именно там нашлась дыра: keepalive шлёт
 * ПРЕФИКС провайдера ('ar'), а таблица путей дашборда ключуется ИМЕНЕМ ('agentrouter') —
 * `poolDropTiers('ar')` отказывал, и карта на диск не писалась никогда.
 *
 * Что здесь НАСТОЯЩЕЕ:
 *   • keepalive  — `routing/keepalive-proxy.js`, живой процесс на своём порту;
 *   • дашборд    — роут-блоки `POST /__switch/api/routes/pool-*`, ВЫРЕЗАННЫЕ ИЗ МОНОЛИТА,
 *                  поверх настоящего HTTP, плюс настоящие `poolDropTiers`/`poolRestoreTiers`
 *                  и настоящий `routing/lib/pooldrop.js`;
 *   • шлюз       — заглушка, но с КАНОНИЧЕСКИМ телом 402 и с каталогом, который, как и
 *                  настоящий agentrouter, ВРЁТ: перечисляет `claude-opus-5`, отвечая на него 402.
 *
 * Чего здесь нет: настоящего `transparent-proxy.js` (это монолит на 25k строк, он поднимает
 * весь хаб). Не покрыты ровно те 6 строк, что диспатчат URL в этот роут; их наличие
 * проверяется статикой ниже.
 *
 * Живого стека не касается: свои порты, свой temp-каталог, никаких платных запросов.
 *
 * Запуск: node tools/pooldrop-stand.js       (exit 1 = стенд не прошёл)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const KP_FILE = path.join(REPO, 'routing', 'keepalive-proxy.js');
const TP_FILE = path.join(REPO, 'routing', 'transparent-proxy.js');
const poolDropLib = require(path.join(REPO, 'routing', 'lib', 'pooldrop.js'));

const POOL_RE = /^(claude|gpt)[-_]/i;
const DEAD = 'claude-opus-5';
const FB = 'deepseek-v4-flash';
const CATALOG = ['claude-opus-4-8', 'claude-opus-5', 'deepseek-v4-flash', 'glm-5.3', 'gpt-5.6-sol', 'gpt-6-astra'];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pooldrop-stand-'));
const MAP = path.join(TMP, 'ar-modelmap.json');
const ROUTES_MAP = path.join(TMP, 'ar-routes-modelmap.json');
const MAP_ORIG = { opus: DEAD, sonnet: DEAD, haiku: 'glm-5.3', gpt: 'gpt-5.6-sol' };
const ROUTES_ORIG = { default: DEAD, opus: DEAD, haiku: 'glm-5.3' };
const writeMap = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
const readMap = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let passed = 0;
const fails = [];
function chk(name, cond, extra) {
    if (cond) { passed += 1; console.log(`  \x1b[32mok\x1b[0m   ${name}`); }
    else { fails.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '  ← ' + extra : ''}`); }
}

// ── вырезание кода из монолита ───────────────────────────────────────────────
// Приём тот же, что в check-pooldrop: берём ТЕКСТ функции, а не её копию в тесте.
function cutFn(text, head) {
    const s = text.indexOf(head);
    if (s < 0) throw new Error(`не нашёл в transparent-proxy.js: ${head}`);
    let i = s, paren = 0, sawParen = false;
    for (; i < text.length; i += 1) {
        const c = text[i];
        if (c === '(') { paren += 1; sawParen = true; }
        else if (c === ')') { paren -= 1; if (sawParen && paren === 0) { i += 1; break; } }
    }
    return text.slice(s, braceEnd(text, i, head));
}
// Для `if (...) { ... }` и `const X = { ... }`: считаем фигурные от первой открывающей.
function cutBraced(text, marker) {
    const s = text.indexOf(marker);
    if (s < 0) throw new Error(`не нашёл в transparent-proxy.js: ${marker}`);
    return text.slice(s, braceEnd(text, text.indexOf('{', s), marker));
}
function braceEnd(text, from, what) {
    let depth = 0, seen = false;
    for (let i = from; i < text.length; i += 1) {
        if (text[i] === '{') { depth += 1; seen = true; }
        else if (text[i] === '}') { depth -= 1; if (seen && depth === 0) return i + 1; }
    }
    throw new Error(`не закрыл тело: ${what}`);
}

const tp = fs.readFileSync(TP_FILE, 'utf8');
const dashSrc = [
    cutBraced(tp, 'const CC_MODEL_PREFIX = {'),      // таблица ИМЁН провайдеров, не префиксов
    cutFn(tp, 'function tierMapFile('),
    cutFn(tp, 'function writeTierMap('),
    cutFn(tp, 'function resolveProviderKey('),
    cutFn(tp, 'function poolDropTiers('),
    cutFn(tp, 'function poolRestoreTiers('),
    cutFn(tp, 'function jsonRes('),
].join('\n');
const dash = new Function('fs', 'path', 'poolDropLib', 'logLine', '__dirname',
    `${dashSrc}\nreturn { poolDropTiers, poolRestoreTiers, jsonRes, resolveProviderKey, CC_MODEL_PREFIX };`
)(fs, path, poolDropLib, (m) => console.log(`  \x1b[35m[дашборд]\x1b[0m ${m}`), TMP);

// Роут-блоки — тот самый код, который в бою диспатчит URL. Их и исполняем.
const routeSrc = [
    cutBraced(tp, "if (req.method === 'POST' && req.url === '/__switch/api/routes/pool-drop')"),
    cutBraced(tp, "if (req.method === 'POST' && req.url === '/__switch/api/routes/pool-restore')"),
].join('\n');
const runRoutes = new Function('poolDropTiers', 'poolRestoreTiers', 'jsonRes', 'req', 'res', routeSrc);

// ── заглушка шлюза ───────────────────────────────────────────────────────────
const gw = { seen: [], delayMs: 0, requests: 0 };
function gatewayServer() {
    return http.createServer((req, res) => {
        if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            // 🪤 Каталог намеренно «врёт» ровно как у agentrouter: перечисляет пуловые модели,
            // которые в тот же момент отвечают 402. Именно на этом сломался бы «умный маппинг».
            return res.end(JSON.stringify({ data: CATALOG.map((id) => ({ id })) }));
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let model = '';
            try { model = String(JSON.parse(body || '{}').model || ''); } catch { /* не-JSON */ }
            gw.seen.push(model);
            gw.requests += 1;
            console.log(`  \x1b[36m[шлюз]\x1b[0m    ← запрос #${gw.requests}: model=${model}`);
            const answer = () => {
                if (POOL_RE.test(model)) {
                    // Канонический текст владельца, слово в слово.
                    const msg = 'Budget pool quota has been exhausted. Please ask an administrator '
                        + 'to increase the limit or select another budget pool.';
                    console.log('  \x1b[36m[шлюз]\x1b[0m    → 402 Budget pool quota has been exhausted');
                    res.writeHead(402, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ error: { type: 'pool_quota', message: msg } }));
                }
                console.log('  \x1b[36m[шлюз]\x1b[0m    → 200 (SSE)');
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model } })}\n\n`);
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}\n\n`);
                res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
                res.end();
            };
            if (gw.delayMs) setTimeout(answer, gw.delayMs); else answer();
        });
    });
}

// ── заглушка дашборда: настоящий роут, настоящие функции, настоящий lib ───────
const dashStat = { poolDrop: 0, restore: 0 };
function dashboardServer() {
    return http.createServer((req, res) => {
        const isDrop = req.url === '/__switch/api/routes/pool-drop';
        const isRestore = req.url === '/__switch/api/routes/pool-restore';
        if (req.method !== 'POST' || (!isDrop && !isRestore)) {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end('{"ok":false,"error":"нет такой ручки"}');
        }
        if (isDrop) dashStat.poolDrop += 1; else dashStat.restore += 1;
        console.log(`  \x1b[35m[дашборд]\x1b[0m ← POST ${req.url}`);
        // 🪤 Тело читает САМ роут (`req.on('data')`), поэтому свой слушатель сюда вешать
        // нельзя: поток уже окончится к моменту вызова, и настоящий `req.on('end')` не
        // сработает никогда. Ответ роута и есть то, что мы хотим видеть — логируем его.
        const origEnd = res.end.bind(res);
        res.end = (chunk, ...rest) => {
            if (chunk) console.log(`  \x1b[35m[дашборд]\x1b[0m → ${String(chunk).slice(0, 220)}`);
            return origEnd(chunk, ...rest);
        };
        return runRoutes(dash.poolDropTiers, dash.poolRestoreTiers, dash.jsonRes, req, res);
    });
}

// ── клиент ───────────────────────────────────────────────────────────────────
function ask(port, model) {
    return new Promise((resolve) => {
        const payload = JSON.stringify({ model: `${model}[1m]`, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] });
        const req = http.request({
            hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages?beta=true',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'user-agent': 'claude-cli/2.1.270 (external, sdk-cli)' },
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
            res.on('error', () => resolve({ status: res.statusCode, body, broken: true }));
        });
        req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
        req.end(payload);
    });
}
function post(port, url, obj) {
    return new Promise((resolve) => {
        const data = JSON.stringify(obj);
        const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: url, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
            (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.end(data);
    });
}
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

// ── прогон ───────────────────────────────────────────────────────────────────
(async () => {
    let kp = null, gwSrv = null, dashSrv = null;
    try {
        const gwPort = await freePort(), dashPort = await freePort(), kpPort = await freePort();
        writeMap(MAP, MAP_ORIG);
        writeMap(ROUTES_MAP, ROUTES_ORIG);
        fs.writeFileSync(path.join(TMP, 'ar-active-key.txt'), 'sk-stand-test-key\n', 'utf8');

        gwSrv = gatewayServer().listen(gwPort, '127.0.0.1');
        dashSrv = dashboardServer().listen(dashPort, '127.0.0.1');

        console.log(`стенд: шлюз :${gwPort} · дашборд :${dashPort} · keepalive :${kpPort}`);
        console.log(`каталог шлюза (врёт, как настоящий): ${CATALOG.join(', ')}\n`);
        console.log(`карта ДО:\n  ${JSON.stringify(readMap(MAP))}\n`);

        kp = spawn(process.execPath, [KP_FILE], {
            env: {
                ...process.env,
                PORT: String(kpPort),
                UPSTREAM: `http://127.0.0.1:${gwPort}`,
                DASHBOARD_URL: `http://127.0.0.1:${dashPort}`,
                MODELMAP_FILE: MAP,
                CONFIG_FILE: path.join(TMP, `keepalive-config-${kpPort}.json`),
                EVENTS_FILE: path.join(TMP, `keepalive-events-${kpPort}.json`),
                KEY_FILE: path.join(TMP, 'ar-active-key.txt'),
                ROTATE_PROVIDER: 'ar',      // в бою keepalive выводит этот префикс из имени хоста
                AUTOROTATE: '0',
                MAX_SOCKETS: '8',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const say = (line) => { if (/пул|402|фолбэк|pool|deepseek/i.test(line)) console.log(`  \x1b[33m[keepalive]\x1b[0m ${line.trim()}`); };
        kp.stdout.on('data', (b) => b.toString('utf8').split('\n').forEach(say));
        kp.stderr.on('data', (b) => b.toString('utf8').split('\n').forEach(say));

        // Ждём готовности: /__state отвечает только у поднявшегося процесса.
        let up = false;
        for (let i = 0; i < 60 && !up; i += 1) {
            up = await new Promise((r) => {
                const q = http.get({ hostname: '127.0.0.1', port: kpPort, path: '/__state', timeout: 700 }, (res) => { res.resume(); r(res.statusCode === 200); });
                q.on('error', () => r(false)); q.on('timeout', () => { q.destroy(); r(false); });
            });
            if (!up) await nap(250);
        }
        if (!up) throw new Error('keepalive не поднялся на стенде');
        console.log('');

        // ── Сцена 1: КОНТРОЛЬ. Фолбэк выключен — как было до сегодняшней правки ──
        console.log('\n── Сцена 1: фолбэк выключен (поведение ДО правки) ──');
        await post(kpPort, '/__config', { poolFallbackModel: '' });
        gw.seen.length = 0; gw.requests = 0;
        let r = await ask(kpPort, DEAD);
        chk('без фолбэка клиент получает сырой 402 (сессия встала бы)', r.status === 402, `получено ${r.status}`);
        chk('шлюз спрошен ровно один раз, повтора нет', gw.requests === 1, `запросов ${gw.requests}`);
        chk('карта на диске не тронута: пул пуст, но никто не переключился', readMap(MAP).opus === DEAD);

        // ── Сцена 2: ГЛАВНОЕ. Фолбэк включён ──
        console.log('\n── Сцена 2: фолбэк включён ──');
        await post(kpPort, '/__config', { poolFallbackModel: FB });
        gw.seen.length = 0; gw.requests = 0; dashStat.poolDrop = 0;
        r = await ask(kpPort, DEAD);
        chk('клиент получил УСПЕХ, а не 402 — сессия выжила', r.status === 200 && /message_stop/.test(r.body), `статус ${r.status}`);
        chk('в ответе нет in-band ошибки (её Claude Code не умеет повторять)', !/event: error/.test(r.body));
        chk('шлюз спрошен дважды: первая попытка умерла на 402', gw.requests === 2, `запросов ${gw.requests}`);
        chk(`вторая попытка ушла на ${FB}`, gw.seen[1] === FB, `было ${gw.seen[1]}`);
        chk('дашборд получил ровно один pool-drop (без повторов и циклов)', dashStat.poolDrop === 1, `пришло ${dashStat.poolDrop}`);
        const afterDrop = readMap(MAP);
        chk(`ПЕРСИСТЕНТНОСТЬ: карта на диске переключена на ${FB}`, afterDrop.opus === FB && afterDrop.sonnet === FB, JSON.stringify(afterDrop));
        chk('беспуловый haiku не тронут', afterDrop.haiku === 'glm-5.3', `haiku=${afterDrop.haiku}`);
        chk('пустой default не стал моделью', readMap(ROUTES_MAP).default === FB || readMap(ROUTES_MAP).default === DEAD);
        chk('бэкап исходной карты создан', fs.existsSync(path.join(TMP, 'ar-modelmap.pooldrop.bak.json')));
        chk('маркер пул-дропа записан', fs.existsSync(path.join(TMP, 'ar-pooldrop.json')));

        // ── Сцена 3: следующий запрос идёт мимо мёртвой модели ──
        console.log('\n── Сцена 3: следующий запрос (мёртвую модель не трогаем вовсе) ──');
        gw.seen.length = 0; gw.requests = 0;
        r = await ask(kpPort, DEAD);
        chk('клиент снова получил успех', r.status === 200);
        chk('шлюз спрошен ОДИН раз: 402 больше не тратится', gw.requests === 1, `запросов ${gw.requests}`);
        chk(`запрос сразу на ${FB}`, gw.seen[0] === FB, `было ${gw.seen[0]}`);

        // ── Сцена 4: пул налили — карта возвращается ──
        console.log('\n── Сцена 4: возврат карты (ручка, которую в бою зовёт «Проверить квоту») ──');
        const rr = await post(dashPort, '/__switch/api/routes/pool-restore', { provider: 'ar' });
        let rj = {}; try { rj = JSON.parse(rr.body); } catch { /* не-JSON */ }
        chk('возврат по ПРЕФИКСУ (его шлёт keepalive) прошёл, а не отказ «не редактируется»', rj.ok === true, rr.body.slice(0, 120));
        chk('карта вернулась побайтово', fs.readFileSync(MAP, 'utf8') === JSON.stringify(MAP_ORIG, null, 2) + '\n');
        chk('маркер снят', !fs.existsSync(path.join(TMP, 'ar-pooldrop.json')));
        gw.seen.length = 0; gw.requests = 0;
        r = await ask(kpPort, DEAD);
        chk('после возврата пуловая модель снова спрашивается (возврат настоящий)', gw.seen[0] === DEAD, `было ${gw.seen[0]}`);
        chk('и снова спасается фолбэком', r.status === 200 && gw.seen[1] === FB, `статус ${r.status}, второй запрос ${gw.seen[1]}`);

        // ── Сцена 5: 402 приходит ПОСЛЕ пре-коммита ──
        console.log('\n── Сцена 5: 402 после пре-коммита (клиент уже на пингах) ──');
        // Конец сцены 4 снова уронил карту в фолбэк (тот запрос опять попал в пул), поэтому
        // здесь карту возвращаем заново — иначе сцена проверяла бы не то, что задумано.
        const rr5 = await post(dashPort, '/__switch/api/routes/pool-restore', { provider: 'ar' });
        chk('карта перед сценой 5 вернулась на пуловую модель', readMap(MAP).opus === DEAD, rr5.body.slice(0, 120));
        await post(kpPort, '/__config', { poolFallbackModel: FB, preCommitMs: 300 });
        gw.delayMs = 900;                 // 402 придёт позже пре-коммита — худший случай
        gw.seen.length = 0; gw.requests = 0;
        r = await ask(kpPort, DEAD);
        gw.delayMs = 0;
        chk('клиент всё равно видит один цельный ответ', r.status === 200 && /message_stop/.test(r.body), `статус ${r.status}`);
        chk('в поток НЕ уехал event: error', !/event: error/.test(r.body));
        chk('шлюз спрошен дважды (402, затем фолбэк)', gw.requests === 2, `запросов ${gw.requests}`);
    } catch (e) {
        fails.push(`исключение: ${e.message}`);
        console.log(`\n  \x1b[31mупало\x1b[0m ${e.message}\n${e.stack.split('\n').slice(1, 3).join('\n')}`);
    } finally {
        try { if (kp) kp.kill(); } catch { /* уже мёртв */ }
        try { if (gwSrv) gwSrv.close(); } catch { /* уже */ }
        try { if (dashSrv) dashSrv.close(); } catch { /* уже */ }
        await nap(200);
        // 🪤 Каталог стенда — свой временный: боевые тир-карты не читались и не писались.
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* оставим на разбор */ }
    }
    console.log('');
    if (fails.length) {
        console.log(`\x1b[31m[FAIL] стенд провален: ${fails.length} из ${passed + fails.length}\x1b[0m`);
        fails.forEach((f) => console.log(`  · ${f}`));
        process.exit(1);
    }
    console.log(`\x1b[32m[OK] ${passed} проверок OK: сквозной путь 402 → фолбэк → карта на диске → возврат работает\x1b[0m`);
    process.exit(0);
})();
