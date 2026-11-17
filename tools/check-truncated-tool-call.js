#!/usr/bin/env node
'use strict';
// Обрыв посреди вызова инструмента обязан быть ВИДЕН, а не выглядеть тишиной.
//
// Живой случай 17.11.2026 23:25 (agentrouter, exact route):
//   keepalive: ping #6 · открыт блок tool_use
//            → шлюз закрыл поток без message_stop, рву без досинтеза
//            отдано 15997Б
//   Hermes:    Partial stream dropped tool call(s) ['delegate_task'] after 498 chars
//              Partial stream delivered; returning length-truncated stub
// Модель отдала вызов инструмента, поток оборвался, клиент выбросил вызов и
// продолжил ход — работа потерялась, и по логу нельзя было понять, что именно.
//
// Что здесь можно и нельзя:
//   нельзя  — синтезировать `event: error`/`message_stop`: exact-режим обязан
//             не подделывать терминальные события, иначе клиент примет
//             обрезанный tool_use за целый (это ловит check-keepalive-exact-routing);
//   можно   — назвать причину в логе и пометить событие отдельным ярлыком.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'routing/keepalive-proxy.js'), 'utf8');

function noteTruncatedBody() {
    const start = src.indexOf('const noteTruncated = () => {');
    assert.ok(start > 0, 'не найден noteTruncated');
    let depth = 0;
    let i = src.indexOf('{', start);
    const from = i;
    for (; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) break;
        }
    }
    return src.slice(from, i + 1);
}

const BODY = noteTruncatedBody();

test('a truncation inside tool_use is named in the log', () => {
    assert.match(BODY, /openBlock === 'tool_use'/,
        'обрыв внутри вызова инструмента никак не отличается от обычного');
    assert.match(BODY, /вызов инструмента потерян/,
        'в логе не сказано, что действие потеряно');
    assert.match(BODY, /truncated_tool_use/,
        'событие не помечено — по статистике потерю не увидеть');
});

test('a truncation inside tool_use never fabricates a terminal event', () => {
    // Главное ограничение: exact-режим не подделывает завершение. Иначе клиент
    // посчитает обрезанный вызов целым и выполнит его частично.
    // Проверяем сам КОД ветки, а не текст лога: слово message_stop в сообщении
    // «шлюз закрыл поток без message_stop» — это описание, а не генерация события.
    const branch = BODY.slice(BODY.indexOf("openBlock === 'tool_use'"));
    const upToDestroy = branch.slice(0, branch.indexOf('exact route truncated stream'));
    const codeOnly = upToDestroy
        .split('\n')
        .filter(line => !/log\(/.test(line))
        .join('\n');
    assert.ok(!/event: error/.test(codeOnly),
        'синтезирован event: error — клиент примет обрезанный вызов за завершённый');
    assert.ok(!/res\.write\(/.test(codeOnly),
        'в tool_use что-то дописывается в поток — обрезанный вызов сойдёт за целый');
    assert.ok(!/content_block_delta/.test(codeOnly),
        'в tool_use пытается дописать синтетическую дельту (ломает JSON аргументов)');
    assert.match(BODY, /res\.destroy\(new Error\('exact route truncated stream'\)\)/,
        'поток больше не рвётся — клиент не узнает об обрыве');
});

test('a plain text truncation keeps its previous wording', () => {
    assert.match(BODY, /шлюз закрыл поток без message_stop, рву без досинтеза/,
        'потерялась прежняя запись для обрыва в text');
});

test('truncation is still counted for statistics', () => {
    assert.match(BODY, /stats\.truncated = \(stats\.truncated \|\| 0\) \+ 1/,
        'обрыв перестал учитываться в статистике');
});
