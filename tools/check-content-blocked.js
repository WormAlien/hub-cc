#!/usr/bin/env node
'use strict';
// Блокировка содержимого провайдером обязана доходить до клиента отдельным кодом.
//
// Живой случай 17.11.2026 23:30: AgentRouter ответил 400 с текстом
//   "This content was flagged for possible cybersecurity risk..."
// Наша цепочка превращала это в голое «Invalid request.», и Hermes советовал
// пользователю начать новую сессию и сменить модель. Совет не мог помочь: тело
// запроса корректное, отказ идёт по политике вендора, новый чат ничего не меняет.
//
// Здесь проверяем три вещи:
//   1) блокировка опознаётся по тексту вендора, а не по коду;
//   2) клиент получает отдельный код content_filtered и объяснение;
//   3) обычный кривой запрос по-прежнему остаётся invalid_request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'routing/frontdoor-proxy.js'), 'utf8');

function loadHelpers() {
    const start = src.indexOf('const CONTENT_BLOCKED_RE');
    const end = src.indexOf('function createDelegatedOpenAiSseRestorer');
    assert.ok(start > 0 && end > start, 'не найдены помощники распознавания блокировки');
    const fragment = src.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(`function statusForSidecar(s){if(s===400)return{status:400,code:'invalid_request'};if(s===404)return{status:404,code:'model_not_found'};return{status:503,code:'upstream_unavailable'};}${fragment}; return { contentBlockedReason, statusForSidecarStatus };`)();
}

const { contentBlockedReason, statusForSidecarStatus } = loadHelpers();

// Настоящий текст вендора из лога (ссылки и id заменены на заглушки).
const CYBER = 'This content was flagged for possible cybersecurity risk. If this '
    + 'seems wrong, try rephrasing your request. If you are doing authorized security '
    + 'work that requires more cyber permissive safeguards, apply for Daybreak access.';

test('the vendor content block is recognised by its wording', () => {
    assert.ok(contentBlockedReason(CYBER), 'блокировка по кибербезопасности не опознана');
    assert.ok(contentBlockedReason('content-blocked (request id: 1234)'), 'content-blocked не опознан');
    assert.ok(contentBlockedReason('Your input violates our content policy'),
        'content policy не опознана');
});

test('an ordinary malformed request is not mistaken for a content block', () => {
    const ordinary = 'Invalid request body: messages must be an array';
    assert.equal(contentBlockedReason(ordinary), null,
        'обычная ошибка формата принята за блокировку — клиент получит ложный совет');
});

test('a content block reaches the caller as content_filtered, not invalid_request', () => {
    const mapped = statusForSidecarStatus(400, CYBER);
    assert.equal(mapped.code, 'content_filtered', 'код остался безликим');
    assert.equal(mapped.status, 403, 'статус должен отличать политику от формата');
});

test('a plain 400 keeps its own meaning', () => {
    const mapped = statusForSidecarStatus(400, 'messages must be an array');
    assert.equal(mapped.code, 'invalid_request');
    assert.equal(mapped.status, 400);
});

test('the vendor details do not leak to the client', () => {
    const reason = contentBlockedReason(CYBER);
    assert.ok(!/Daybreak|apply for|http/i.test(reason),
        'в ответ клиенту попали детали и ссылки вендора');
    assert.match(reason, /content policy/i, 'клиенту не сказано, что дело в содержимом');
    assert.match(reason, /will not help/i,
        'клиент не предупреждён, что повтор и новый чат не помогут');
});

test('the rejection path actually calls the content check', () => {
    // Регресс-замок: без этого вызова блокировка снова станет «Invalid request.».
    assert.match(src, /const reason = contentBlockedReason\(text\);/,
        'ветка отказа не проверяет блокировку содержимого');
    assert.match(src, /fail\(403, 'content_filtered', reason\)/,
        'блокировка не передаётся клиенту отдельным кодом');
});

test('the redacted error keeps the explanation instead of replacing it', () => {
    // makeRedactedOpenAiError раньше схлопывал всё, кроме 400/404, в 503 с общим
    // текстом — объяснение терялось по дороге к клиенту.
    const gw = fs.readFileSync(path.join(ROOT, 'routing/lib/api-gateway.js'), 'utf8');
    assert.match(gw, /function makeRedactedOpenAiError\(status, code, publicModel, messageOverride\)/,
        'редактор ошибки снова не принимает текст');
    assert.match(gw, /messageOverride\.trim\(\)/,
        'объяснение снова отбрасывается');
    assert.match(gw, /status === 403 && code === 'content_filtered' \? 403/,
        '403 снова схлопывается в 503');
});
