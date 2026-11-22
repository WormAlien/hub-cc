#!/usr/bin/env node
'use strict';
// check-league-check-only.js — регресс на `tools/league-join.js --check-only`.
//
// Зачем. Живой случай 22.11.2026: `--check-only` на рабочей установке умирал с
// «для https нужен --pin», не сделав ни одного сетевого запроса, хотя приёмник
// живёт за Cloudflare с валидной цепочкой (routing/league-config.json:
// url=https://lg.xgate.online:2083, pin отсутствует). Плюс проверка доверяла
// `/peers` — а эта ручка ПУБЛИЧНАЯ и 200 на ней ничего не говорит о том, принят
// ли секрет (routing/league-receiver.js: handlePeers зовётся с identity=true).
//
// Что проверяем на локальном mock-приёмнике (без сети, без секретов):
//   1. https по ДОМЕННОМУ имени с валидной цепочкой — pin НЕ требуется;
//   2. соединение по IP (самоподписанный) — pin требуется;
//   3. /me 401 «такой личности нет» → «неизвестная личность», не «отзыв»;
//   4. /me 401 «отозвана» → «отозвана», авто-джойн запрещён;
//   5. /me 403 pending → «не одобрена»;
//   6. /me 200 active → успех;
//   7. --check-only не пишет файлов и не создаёт личность.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const JOIN = path.join(ROOT, 'tools', 'league-join.js');
const KEY = 'k'.repeat(32);   // фиктивный секрет: 32 символа, ни одного настоящего байта
// ПРОБЕЛ ЗАКРЫТ: прогресс-бар и `con` могут уводить вывод не в stdout; глушим их.
const NO_COLOR_ENV = { NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', TERM: 'dumb' };

// ── mock-приёмник: /health, /me (с настраиваемым ответом), /peers ─────────────
function startReceiver() {
    const state = {
        me: { status: 401, body: { error: 'токен не принят: такой личности у приёмника нет' } },
        hits: [],
    };
    const handler = (req, res) => {
        const u = (req.url || '').split('?')[0];
        state.hits.push(u);
        if (u === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, installs: 33, last: new Date().toISOString(), instance: 'mock' }));
        }
        if (u === '/me') {
            res.writeHead(state.me.status, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(state.me.body));
        }
        if (u === '/peers') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ peers: [] }));
        }
        res.writeHead(404); res.end('no');
    };
    const server = http.createServer(handler);
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}

// Изолированный конфиг. ВАЖНО: league-join.js считает пути от __dirname (то есть от
// самого репозитория), а НЕ от cwd — поэтому cwd тут ничего не изолирует, и первый
// прогон тестов читал боевой routing/league-config.json. Изоляция только через --out.
function makeSandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'league-sbx-'));
    return { dir, cfg: path.join(dir, 'league-config.json'), keyFile: path.join(dir, 'key.txt') };
}

function sealKey(sbx) {
    fs.writeFileSync(sbx.keyFile, KEY, 'utf8');
    return sbx.keyFile;
}

function writeCfg(sbx, doc) {
    fs.writeFileSync(sbx.cfg, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2), 'utf8');
}

// ВАЖНО: async spawn, а не spawnSync. Мок-приёмник живёт В ЭТОМ ЖЕ процессе, и
// spawnSync блокирует event loop — сервер не может ответить, запрос висит до
// таймаута, а тест «доказывает» недоступность несуществующим таймаутом.
function runJoin(sbx, args) {
    return new Promise(resolve => {
        const c = spawn(process.execPath, [JOIN, '--out=' + sbx.cfg, ...args], {
            cwd: sbx.dir,
            env: { ...process.env, ...NO_COLOR_ENV, LEAGUE_KEY: KEY },
        });
        let out = '';
        c.stdout.on('data', d => out += d);
        c.stderr.on('data', d => out += d);
        c.on('close', code => resolve({ code, out }));
    });
}

function snapshot(dir) {
    const acc = [];
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else acc.push(path.relative(dir, p) + ':' + fs.statSync(p).size);
        }
    };
    walk(dir);
    return acc.sort().join('\n');
}

// ── 1. https по доменному имени: pin не нужен ────────────────────────────────
// Здесь нельзя проверить «валидную цепочку» на localhost, поэтому проверяем
// главное: требование пина больше не зависит от одного факта «это https».
test('https по доменному имени не требует pin', async () => {
    const sbx = makeSandbox();
    // url с доменным именем, без --ip → NEED_PIN=false. Сеть не нужна: важно,
    // что скрипт ДОШЁЛ до сети, а не упал на требовании пина.
    const r = await runJoin(sbx, ['--url=https://example.invalid:2083', '--key-file=' + sealKey(sbx), '--check-only', '--timeout=2']);
    assert.doesNotMatch(r.out, /требует --pin/,
        'по доменному имени пин не должен требоваться');
    assert.match(r.out, /приёмник:|health|контроль/i,
        'скрипт обязан дойти до сетевой части, а не умереть на валидации');
});

test('соединение по IP требует pin', async () => {
    const sbx = makeSandbox();
    const r = await runJoin(sbx, ['--url=https://example.invalid:2083', '--ip=127.0.0.1',
        '--key-file=' + sealKey(sbx), '--check-only', '--timeout=2']);
    assert.match(r.out, /требует --pin/,
        'по IP без SNI секрет нельзя отправлять без пина');
    assert.equal(r.code, 1);
});


// ── 3..6. Различение ответов /me ─────────────────────────────────────────────
// Проверяем через прямой mock: важна не сеть, а то, что скрипт называет
// состояние своим именем. Гоняем по http (пин тут ни при чём).
test('/me 401 «такой личности нет» → неизвестная личность', async () => {
    const rx = await startReceiver();
    const sbx = makeSandbox();
    rx.state.me = { status: 401, body: { error: 'токен не принят: такой личности у приёмника нет' } };
    try {
        // --check-only проверяет УЖЕ ЛЕЖАЩИЙ конфиг (как на живой установке).
        writeCfg(sbx, { enabled: true, url: `http://127.0.0.1:${rx.port}`, everyMin: 10, key: KEY });
        sealKey(sbx);
        const r = await runJoin(sbx, ['--check-only', '--timeout=5']);
        assert.match(r.out, /не знает эту личность|неизвестная личность/i);
        assert.doesNotMatch(r.out, /ОТОЗВАНА/, 'неизвестная личность — это не отзыв');
        assert.ok(rx.state.hits.includes('/me'), 'проверка обязана идти в /me, а не только в /peers');
    } finally { rx.server.close(); }
});

test('/me 401 «отозвана» → отзыв, авто-джойн запрещён', async () => {
    const rx = await startReceiver();
    const sbx = makeSandbox();
    rx.state.me = { status: 401, body: { error: 'эта личность отозвана' } };
    try {
        // --check-only проверяет УЖЕ ЛЕЖАЩИЙ конфиг (как на живой установке).
        writeCfg(sbx, { enabled: true, url: `http://127.0.0.1:${rx.port}`, everyMin: 10, key: KEY });
        sealKey(sbx);
        const r = await runJoin(sbx, ['--check-only', '--timeout=5']);
        assert.match(r.out, /ОТОЗВАНА|отозван/i);
        assert.match(r.out, /авто-джойн запрещён/i);
    } finally { rx.server.close(); }
});

test('/me 403 → заявка не одобрена', async () => {
    const rx = await startReceiver();
    const sbx = makeSandbox();
    rx.state.me = { status: 403, body: { error: 'заявка ещё не одобрена' } };
    try {
        // --check-only проверяет УЖЕ ЛЕЖАЩИЙ конфиг (как на живой установке).
        writeCfg(sbx, { enabled: true, url: `http://127.0.0.1:${rx.port}`, everyMin: 10, key: KEY });
        sealKey(sbx);
        const r = await runJoin(sbx, ['--check-only', '--timeout=5']);
        assert.match(r.out, /не одобрена/i);
    } finally { rx.server.close(); }
});

test('/me 200 active → успех', async () => {
    const rx = await startReceiver();
    const sbx = makeSandbox();
    rx.state.me = { status: 200, body: { status: 'active', nick: 'me', installId: 'abc' } };
    try {
        // --check-only проверяет УЖЕ ЛЕЖАЩИЙ конфиг (как на живой установке).
        writeCfg(sbx, { enabled: true, url: `http://127.0.0.1:${rx.port}`, everyMin: 10, key: KEY });
        sealKey(sbx);
        const r = await runJoin(sbx, ['--check-only', '--timeout=5']);
        assert.match(r.out, /секрет принят/i);
        assert.equal(r.code, 0, 'успешная проверка обязана вернуть 0');
    } finally { rx.server.close(); }
});

test('/peers-200 при /me-401 не считается успехом', async () => {
    const rx = await startReceiver();
    const sbx = makeSandbox();
    rx.state.me = { status: 401, body: { error: 'токен не принят: такой личности у приёмника нет' } };
    try {
        // --check-only проверяет УЖЕ ЛЕЖАЩИЙ конфиг (как на живой установке).
        writeCfg(sbx, { enabled: true, url: `http://127.0.0.1:${rx.port}`, everyMin: 10, key: KEY });
        sealKey(sbx);
        const r = await runJoin(sbx, ['--check-only', '--timeout=5']);
        assert.equal(r.code, 1, 'публичный /peers не должен давать зелёный результат');
    } finally { rx.server.close(); }
});

// ── 7. --check-only read-only ────────────────────────────────────────────────
test('--check-only не пишет файлов и не создаёт личность', async () => {
    const rx = await startReceiver();
    const sbx = makeSandbox();
    rx.state.me = { status: 200, body: { status: 'active', nick: 'me', installId: 'abc' } };
    try {
        // Кладём уже существующий конфиг, чтобы --check-only было что проверять.
        writeCfg(sbx, { enabled: true, url: `http://127.0.0.1:${rx.port}`, everyMin: 10, key: KEY });
        sealKey(sbx);                 // ключ кладём ДО снимка: иначе тест ловит свой же файл
        const before = snapshot(sbx.dir);
        const r = await runJoin(sbx, ['--check-only', '--timeout=5']);
        const after = snapshot(sbx.dir);
        assert.equal(after, before, '--check-only обязан быть read-only');
        assert.equal(r.code, 0);
        assert.equal(fs.existsSync(path.join(sbx.dir, 'league-data', 'instance-id')), false,
            'личность создаёт хаб, а не проверка');
    } finally { rx.server.close(); }
});

test('повреждённый JSON конфига распознаётся как ошибка конфигурации', async () => {
    const sbx = makeSandbox();
    writeCfg(sbx, '{oops');
    const r = await runJoin(sbx, ['--check-only', '--timeout=2']);
    assert.match(r.out, /не JSON|починить|снести/i);
    assert.equal(r.code, 1);
});
