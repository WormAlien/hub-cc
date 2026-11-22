#!/usr/bin/env node
'use strict';
// check-league-redeem.js — регресс на tools/league-redeem.js.
//
// Зачем. Живой случай 22.11.2026: размен приглашения через хаб вернул МОЮ ЖЕ
// личность вместо новой, потому что хаб добавляет к `/join` свой `X-League-Key`
// и приёмник опознаёт по нему старого участника (ветка replay). Приглашение при
// этом сжигается. Разменять с чужой машины было нечем: в league-join.js такого
// режима нет.
//
// Что проверяем на локальном mock-приёмнике (без сети, без настоящих секретов):
//   1. ключ НЕ отправляется в заголовках;
//   2. успешный размен пишет конфиг с правами 0600;
//   3. replay не считается успехом;
//   4. 401/403 с «уже использовано» даёт внятный отказ;
//   5. --dry-run ничего не пишет;
//   6. живой ключ не затирается без --force;
//   7. токен не печатается в вывод.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'league-redeem.js');
const TOKEN = 'T'.repeat(32);          // фиктивный токен, ни одного настоящего байта
const CODE = 'testcode_abcdefgh';

// ── mock-приёмник ────────────────────────────────────────────────────────────
function startReceiver() {
    const state = {
        reply: { status: 200, body: { ok: true, memberId: 'abcdef0123456789', groups: ['g1'], token: TOKEN } },
        seenHeaders: null,
        seenBody: null,
    };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
            state.seenHeaders = req.headers;
            state.seenBody = raw;
            res.writeHead(state.reply.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(state.reply.body));
        });
    });
    return new Promise(r => server.listen(0, '127.0.0.1',
        () => r({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

// Изолированный конфиг: --out в скрипте нет, поэтому подменяем каталог целиком
// через копию репозитория-заглушки. Проще и честнее: гоняем скрипт с --force и
// смотрим на РЕАЛЬНЫЙ routing/league-config.json? Нет — это снесло бы живой токен.
// Поэтому у скрипта есть --url, а конфиг он пишет рядом с собой. Чтобы не трогать
// боевой файл, копируем tools/league-redeem.js в песочницу с нужной структурой.
function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-redeem-'));
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'routing'), { recursive: true });
    fs.copyFileSync(TOOL, path.join(dir, 'tools', 'league-redeem.js'));
    return { dir, cfg: path.join(dir, 'routing', 'league-config.json'),
        tool: path.join(dir, 'tools', 'league-redeem.js') };
}

function writeCfg(sb, doc) {
    fs.writeFileSync(sb.cfg, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

function run(sb, args) {
    return new Promise(resolve => {
        const c = spawn(process.execPath, [sb.tool, ...args], {
            cwd: sb.dir, env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
        });
        let out = '';
        c.stdout.on('data', d => out += d);
        c.stderr.on('data', d => out += d);
        c.on('close', code => resolve({ code, out }));
    });
}

function withReceiver(fn) {
    return async () => {
        const rx = await startReceiver();
        try { await fn(rx); } finally { rx.server.close(); }
    };
}

// ── 1. Ключ не отправляется ─────────────────────────────────────────────────
test('размен НЕ отправляет X-League-Key (иначе приёмник вернёт replay)', withReceiver(async rx => {
    const sb = sandbox();
    await run(sb, ['--url=' + rx.url, '--code=' + CODE]);
    assert.equal(rx.state.seenHeaders['x-league-key'], undefined,
        'ключ в заголовке превращает размен в replay чужой личности');
}));

test('код уезжает в теле как code', withReceiver(async rx => {
    const sb = sandbox();
    await run(sb, ['--url=' + rx.url, '--code=' + CODE]);
    const b = JSON.parse(rx.state.seenBody);
    assert.equal(b.code, CODE);
    assert.equal(b.invite, undefined);
}));

test('строка xgl1_… уезжает как invite', withReceiver(async rx => {
    const sb = sandbox();
    await run(sb, ['--url=' + rx.url, '--code=xgl1_abcdefghijklmnop']);
    const b = JSON.parse(rx.state.seenBody);
    assert.equal(b.invite, 'xgl1_abcdefghijklmnop');
    assert.equal(b.code, undefined);
}));

// ── 2. Успешный размен пишет конфиг ─────────────────────────────────────────
test('успех: конфиг записан с правом 0600 и живым токеном', withReceiver(async rx => {
    const sb = sandbox();
    const r = await run(sb, ['--url=' + rx.url, '--code=' + CODE]);
    assert.equal(r.code, 0, r.out);
    const cfg = JSON.parse(fs.readFileSync(sb.cfg, 'utf8'));
    assert.equal(cfg.key, TOKEN, 'токен обязан попасть в конфиг');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.url, rx.url);
    // права: на POSIX 0600. На Windows режим не проверяем — там другая модель.
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(sb.cfg).mode & 0o777, 0o600);
    }
}));

test('токен НЕ печатается в вывод', withReceiver(async rx => {
    const sb = sandbox();
    const r = await run(sb, ['--url=' + rx.url, '--code=' + CODE]);
    assert.ok(!r.out.includes(TOKEN), 'токен не должен попадать в лог');
    assert.match(r.out, /токен: получен/);
}));

// ── 3. replay не считается успехом ──────────────────────────────────────────
test('replay → отказ, конфиг не перезаписан', withReceiver(async rx => {
    const sb = sandbox();
    rx.state.reply = { status: 200, body: { ok: true, replay: true, memberId: 'old', groups: ['g1'] } };
    const r = await run(sb, ['--url=' + rx.url, '--code=' + CODE]);
    assert.equal(r.code, 1, 'replay не должен давать код 0');
    assert.match(r.out, /replay/i);
    assert.equal(fs.existsSync(sb.cfg), false, 'при replay конфиг писать нечем — токена нет');
}));

// ── 4. Отказы приёмника ─────────────────────────────────────────────────────
test('409 «уже использовано» → внятный отказ, не успех', withReceiver(async rx => {
    const sb = sandbox();
    rx.state.reply = { status: 409, body: {
        error: 'приглашение уже использовано',
        hint: 'если ты его не разменивал — код взял кто-то другой, скажи пригласившему' } };
    const r = await run(sb, ['--url=' + rx.url, '--code=' + CODE]);
    assert.equal(r.code, 1);
    assert.match(r.out, /уже использовано/);
    assert.match(r.out, /скажи пригласившему/);
}));

test('200 без токена → отказ (размен не состоялся)', withReceiver(async rx => {
    const sb = sandbox();
    rx.state.reply = { status: 200, body: { ok: true, memberId: 'abc', groups: [] } };
    const r = await run(sb, ['--url=' + rx.url, '--code=' + CODE]);
    assert.equal(r.code, 1);
    assert.match(r.out, /без токена/i);
}));

// ── 5. --dry-run ────────────────────────────────────────────────────────────
test('--dry-run показывает успех, но ничего не пишет', withReceiver(async rx => {
    const sb = sandbox();
    const r = await run(sb, ['--url=' + rx.url, '--code=' + CODE, '--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /dry-run/i);
    assert.equal(fs.existsSync(sb.cfg), false, 'dry-run не должен писать конфиг');
}));

// ── 6. Живой ключ не затирается без --force ─────────────────────────────────
test('живой ключ на машине → отказ без --force', withReceiver(async rx => {
    const sb = sandbox();
    writeCfg(sb, { enabled: true, url: 'https://old', key: 'OLD_KEY_VALUE', everyMin: 10 });
    const before = fs.readFileSync(sb.cfg, 'utf8');
    const r = await run(sb, ['--url=' + rx.url, '--code=' + CODE]);
    assert.equal(r.code, 1, 'без --force второй личности быть не должно');
    assert.match(r.out, /--force/);
    assert.equal(fs.readFileSync(sb.cfg, 'utf8'), before, 'конфиг не тронут');
}));

test('с --force перезапись разрешена', withReceiver(async rx => {
    const sb = sandbox();
    writeCfg(sb, { enabled: true, url: 'https://old', key: 'OLD_KEY_VALUE', everyMin: 7 });
    const r = await run(sb, ['--url=' + rx.url, '--code=' + CODE, '--force']);
    assert.equal(r.code, 0, r.out);
    const cfg = JSON.parse(fs.readFileSync(sb.cfg, 'utf8'));
    assert.equal(cfg.key, TOKEN);
    assert.equal(cfg.everyMin, 7, 'прежний период обмена должен сохраниться');
}));

// ── 7. Адрес ────────────────────────────────────────────────────────────────
test('без адреса и без конфигов → понятный отказ', async () => {
    const sb = sandbox();
    const r = await run(sb, ['--code=' + CODE]);
    assert.equal(r.code, 1);
    assert.match(r.out, /адрес приёмника неизвестен/i);
});

test('без --code → понятный отказ', async () => {
    const sb = sandbox();
    const r = await run(sb, ['--url=http://127.0.0.1:1']);
    assert.equal(r.code, 1);
    assert.match(r.out, /нужен --code/i);
});
