#!/usr/bin/env node
'use strict';
// check-league-instance-verdict.js — регресс на различение «переезд ноды / отзыв /
// неизвестно / приёмник недоступен / участие выключено / конфиг повреждён».
//
// Зачем. Живой случай 22.11.2026: у клиента отсутствовал routing/league-data/instance-id,
// и по нему нельзя было отличить переезд приёмника от отзыва личности. Хуже: отсутствие
// файла легко принять за «нода новая» и молча обойти отзыв авто-джойном. Поэтому
// отсутствие — это состояние unknown, а НЕ разрешение.
//
// Проверяем чистую логику вердикта, без сети и без секретов: функции вынесены в
// routing/lib/league-instance.js, их и дергаем.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const LIB = path.join(__dirname, '..', 'routing', 'lib', 'league-instance.js');
const { verdict, remember, known, INSTANCE_RE } = require(LIB);

function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-inst-'));
    return { dir, file: path.join(dir, 'receiver-instance.json') };
}

const A = 'ba8b43dbe9b59a22';
const B = 'ffffffffffffffff';

test('формат instance: 16 hex, и ничего другого', () => {
    assert.ok(INSTANCE_RE.test(A));
    assert.ok(INSTANCE_RE.test(B));
    assert.ok(!INSTANCE_RE.test(''), 'пустая строка не instance');
    assert.ok(!INSTANCE_RE.test('ba8b43dbe9b59a2'), '15 символов не instance');
    assert.ok(!INSTANCE_RE.test('../etc/passwd'), 'мусор не instance');
});

test('файла нет → unknown_prev (НЕ разрешение на авто-джойн)', () => {
    const sb = sandbox();
    const v = verdict({ file: sb.file, remote: A, enabled: true });
    assert.equal(v.state, 'unknown_prev');
    assert.equal(v.instance, A);
    assert.equal(v.autoJoinAllowed, false,
        'отсутствие прежнего instance не даёт права на авто-джойн');
});

test('instance совпал → same (значит отказ про личность, не про ноду)', () => {
    const sb = sandbox();
    remember({ file: sb.file, instance: A });
    const v = verdict({ file: sb.file, remote: A, enabled: true });
    assert.equal(v.state, 'same');
    assert.equal(v.autoJoinAllowed, false, 'тот же instance — переезда нет, авто-джойн запрещён');
});

test('instance сменился → changed (переезд ноды)', () => {
    const sb = sandbox();
    remember({ file: sb.file, instance: A });
    const v = verdict({ file: sb.file, remote: B, enabled: true });
    assert.equal(v.state, 'changed');
    assert.equal(v.previous, A);
    assert.equal(v.instance, B);
});

test('приёмник не ответил → receiver_down (это транспорт, не авторизация)', () => {
    const sb = sandbox();
    remember({ file: sb.file, instance: A });
    const v = verdict({ file: sb.file, remote: null, enabled: true });
    assert.equal(v.state, 'receiver_down');
    assert.equal(v.autoJoinAllowed, false);
});

test('участие выключено → disabled (не включать обратно)', () => {
    const sb = sandbox();
    const v = verdict({ file: sb.file, remote: A, enabled: false });
    assert.equal(v.state, 'disabled');
    assert.equal(v.autoJoinAllowed, false);
});

test('конфиг повреждён → config_broken', () => {
    const sb = sandbox();
    const v = verdict({ file: sb.file, remote: A, enabled: true, broken: true });
    assert.equal(v.state, 'config_broken');
    assert.equal(v.autoJoinAllowed, false);
});

test('remember не затирает совпадающий instance и не мусорит', () => {
    const sb = sandbox();
    assert.equal(remember({ file: sb.file, instance: A }), true);
    const first = JSON.parse(fs.readFileSync(sb.file, 'utf8'));
    assert.equal(first.instance, A);
    // повторная запись того же значения — no-op (файл не переписывается)
    const mtime1 = fs.statSync(sb.file).mtimeMs;
    assert.equal(remember({ file: sb.file, instance: A }), true);
    assert.equal(fs.statSync(sb.file).mtimeMs, mtime1, 'тот же instance не должен переписывать файл');
});

test('remember отвергает мусор и не создаёт файл', () => {
    const sb = sandbox();
    assert.equal(remember({ file: sb.file, instance: 'не-instance' }), false);
    assert.equal(remember({ file: sb.file, instance: '' }), false);
    assert.equal(fs.existsSync(sb.file), false, 'мусор не должен попадать на диск');
});

test('known читает записанное и не падает на мусоре в файле', () => {
    const sb = sandbox();
    assert.equal(known({ file: sb.file }), null, 'нет файла → null');
    remember({ file: sb.file, instance: A });
    assert.equal(known({ file: sb.file }), A);
    fs.writeFileSync(sb.file, '{битый json', 'utf8');
    assert.equal(known({ file: sb.file }), null, 'битый файл → null, без исключения');
    fs.writeFileSync(sb.file, JSON.stringify({ instance: 'коротко' }), 'utf8');
    assert.equal(known({ file: sb.file }), null, 'невалидный instance → null');
});

test('смена instance сама по себе НЕ обходит отзыв', () => {
    // Главное правило: changed даёт право на авто-джойн только если личность активна.
    // Отозванную личность не возвращает никакая смена ноды.
    const sb = sandbox();
    remember({ file: sb.file, instance: A });
    const v = verdict({ file: sb.file, remote: B, enabled: true });
    assert.equal(v.state, 'changed');
    assert.equal(v.revokedMustStayRevoked, true,
        'переезд ноды не должен автоматически возвращать отозванную личность');
});
