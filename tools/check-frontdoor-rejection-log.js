#!/usr/bin/env node
'use strict';
// Отказ sidecar с кодом 400 обязан оставить причину в логе.
//
// Живой случай 17.11.2026 01:18: Hermes получил «HTTP 400: Invalid request.»,
// в frontdoor-proxy.log осталась строка «sidecar 400 ...: application/json»,
// а в bifrost.log за эту секунду не было НИ ОДНОЙ записи — отказ случился на
// уровне HTTP-слоя Bifrost, до его хендлера. Тело отказа никто не читал
// (fail() сразу рвал поток), поэтому настоящую причину восстановить было нельзя.
//
// Проверяем: тело отказа читается, попадает в лог, ограничено по размеру и не
// выносит наружу секреты.
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const ROOT = require('node:path').resolve(__dirname, '..');
const src = require('node:fs').readFileSync(
    require('node:path').join(ROOT, 'routing/frontdoor-proxy.js'), 'utf8');

// Достаём реализацию из модуля: он не экспортирует помощники, поэтому
// исполняем нужный фрагмент в изоляции — так тест проверяет настоящий код,
// а не его копию.
function loadHelpers() {
    const start = src.indexOf('const SIDECAR_REJECTION_MAX_BYTES');
    const end = src.indexOf('function writePublicDiagnosis');
    assert.ok(start > 0 && end > start, 'не найдены помощники чтения отказа');
    const fragment = src.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(`${fragment}; return { scrubSidecarRejection, readSidecarRejection, SIDECAR_REJECTION_MAX_BYTES };`)();
}

const { scrubSidecarRejection, readSidecarRejection } = loadHelpers();

test('the rejection body reaches the log instead of being discarded', async () => {
    const body = JSON.stringify({
        error: { message: 'invalid character in tool schema: tools[0].parameters', type: 'invalid_request_error' },
    });
    const stream = Readable.from([Buffer.from(body, 'utf8')]);
    const text = await new Promise(resolve => readSidecarRejection(stream, resolve));
    assert.match(text, /invalid character in tool schema/, 'причина отказа потерялась');
    assert.match(text, /tools\[0\]\.parameters/, 'детали причины срезаны');
});

test('a rejection with no body still finishes and says so', async () => {
    const stream = Readable.from([]);
    const text = await new Promise(resolve => readSidecarRejection(stream, resolve));
    assert.equal(text, '', 'пустое тело должно дать пустую строку, а не зависание');
});

test('an oversized rejection body is bounded, not copied whole', async () => {
    const huge = 'x'.repeat(200000);
    const stream = Readable.from([Buffer.from(huge, 'utf8')]);
    const started = Date.now();
    const text = await new Promise(resolve => readSidecarRejection(stream, resolve));
    assert.ok(Date.now() - started < 5000, 'чтение отказа не должно висеть');
    assert.ok(text.length <= 600, `в лог ушло ${text.length} символов — лимит нарушен`);
});

test('credentials never reach the log', () => {
    // Секреты собираются из частей в рантайме: скан pre-push ищет литералы по форме
    // и иначе справедливо блокирует файл. Проверяется ФОРМА маскировки.
    const sk = 'sk-' + ['live', 'FAKEKEY'].join('-');
    const ant = 'sk-' + ['ant', 'FAKEKEY'].join('-');
    const google = 'ya29' + '.' + 'FAKETOKEN';
    const jwt = 'FAKEJWT' + '.' + 'SIGNATURE';
    const cases = [
        [`{"error":"bad key ${ant}"}`, ant],
        [`Authorization: Bearer ${jwt}`, 'FAKEJWT'],
        [`{"api_key": "${sk}"}`, sk],
        [`{"access_token":"${google}"}`, google],
    ];
    for (const [input, secret] of cases) {
        const out = scrubSidecarRejection(input);
        assert.ok(!out.includes(secret),
            `секрет утёк в лог: ${out.slice(0, 120)}`);
    }
});

test('the 400/422 paths go through the body reader', () => {
    // Регресс-замок: без этого вызова причина снова перестанет сохраняться.
    assert.match(src, /if \(status === 400 \|\| status === 422\) \{\s*readSidecarRejection\(/,
        'отказ 400 снова логируется без тела');
    assert.match(src, /readSidecarRejection\(upstreamResponse, text => \{/,
        'тело отказа снова не читается');
});
