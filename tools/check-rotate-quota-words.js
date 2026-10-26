'use strict';
// Регресс распознавания исчерпанной квоты (keepalive-proxy.js, rotateReason).
// Живой случай 25.10: Premier отвечает 429 «Сообщения на сегодня закончились (50 на тарифе
// Free…) / Daily message limit reached», формулировки не было ни в одной метке, и ротация
// пула не срабатывала при четырёх живых аккаунтах из шести.
// Проверяем обе стороны: новые фразы ловятся, обычный rate-limit - нет.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'routing', 'keepalive-proxy.js');
const code = fs.readFileSync(SRC, 'utf8');
const m = code.match(/const OUT_OF_BALANCE_RE = (\/.+\/i);/);
assert.ok(m, 'OUT_OF_BALANCE_RE не найден');
const RE = new Function('return ' + m[1])();
const dead = new Function('return ' + code.match(/const DEAD_KEY_RE = (\/.+\/i);/)[1])();

const live = '{"type":"error","error":{"type":"rate_limit_error","message":"Сообщения на сегодня закончились (50 на тарифе Free; лимит общий с чатом). Обновится в 00:00 по Москве — через 12 ч 32 мин. Больше сообщений — на https://ide.kgpix.bond/chat. / Daily message limit reached; it resets at 00:00 Moscow time."}}';
assert.ok(RE.test(live), 'живой 429 Premier обязан распознаваться как исчерпанная квота');
assert.ok(!dead.test(live), 'исчерпанная квота не делает аккаунт мёртвым');

// Английская половина той же ошибки по отдельности и русская по отдельности.
assert.ok(RE.test('Daily message limit reached; it resets at 00:00 Moscow time.'), 'английская фраза');
assert.ok(RE.test('Сообщения на сегодня закончились'), 'русская фраза');
assert.ok(RE.test('Сообщения закончились'), 'короткая русская фраза');
assert.ok(RE.test('You have used this week\'s allowance'), 'прежняя метка не сломана');

// Обычный rate-limit аккаунт не меняет: иначе ротация зациклится на живом пуле.
for (const s of ['429 Too Many Requests', 'rate limit exceeded, retry after 30s',
    '{"error":{"message":"Too many requests, please slow down"}}']) {
    assert.ok(!RE.test(s), 'рядовой rate-limit не должен считаться исчерпанной квотой: ' + s);
}

// rotateReason обязан продолжать отбирать по статусу: 200 с эхом этой фразы не ротирует.
const rr = code.match(/function rotateReason\(status, buf\) \{[\s\S]+?\n\}/);
assert.ok(rr, 'rotateReason не найден');
assert.ok(/if \(status !== 401 && status !== 402 && status !== 403 && status !== 429\) return null;/.test(rr[0]),
    'гейт по статусу на месте');

console.log(JSON.stringify({ ok: true, tests: 12 }));
