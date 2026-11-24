#!/usr/bin/env node
'use strict';
// Адресный регресс: исполняем именно dictation-menu gate из check-hub.js,
// не запускаем остальные gates, lifecycle или настоящий dictation-fix.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const GATE_NAME = 'пункт меню и вердикт в «Проверке» на месте';
const hubSource = fs.readFileSync(path.join(ROOT, 'hub.js'), 'utf8');
const lfSource = hubSource.replace(/\r\n/g, '\n');
const crlfSource = lfSource.replace(/\n/g, '\r\n');
const checkerSource = fs.readFileSync(path.join(__dirname, 'check-hub.js'), 'utf8').replace(/\r\n/g, '\n');
const gateStart = checkerSource.indexOf(`t('${GATE_NAME}', () => {`);
assert.notEqual(gateStart, -1, 'точный gate не найден');
const gateEnd = checkerSource.indexOf('\n});', gateStart);
assert.notEqual(gateEnd, -1, 'конец точного gate не найден');
const gateCode = checkerSource.slice(gateStart, gateEnd + '\n});'.length);

function gateVerdict(source) {
    let verdict;
    let calls = 0;
    vm.runInNewContext(gateCode, {
        read(file) {
            assert.equal(file, 'hub.js', 'gate должен читать только actual hub.js');
            return source;
        },
        t(name, fn) {
            assert.equal(name, GATE_NAME);
            calls++;
            try {
                const result = fn();
                verdict = result === undefined ? true : result;
            } catch (error) {
                verdict = error.message;
            }
        },
    }, { timeout: 1000, filename: 'tools/check-hub.js:dictation-menu-gate' });
    assert.equal(calls, 1, 'должен исполняться ровно один owned gate');
    return verdict;
}

function actualFunction(source, declaration) {
    // Независимая граница для доказательства: сначала нормализуем только EOL,
    // потом берём top-level функцию, включая её закрывающую скобку.
    const lf = source.replace(/\r\n/g, '\n');
    const start = lf.indexOf(declaration);
    assert.notEqual(start, -1, `${declaration}: нет объявления`);
    const end = lf.indexOf('\n}\n', start);
    assert.notEqual(end, -1, `${declaration}: нет конца функции`);
    return lf.slice(start, end + '\n}'.length);
}

function sourceBlock(source, first, next) {
    const start = source.indexOf(first);
    assert.notEqual(start, -1, `${first}: нет начала блока`);
    const end = source.indexOf(next, start + first.length);
    assert.notEqual(end, -1, `${first}: нет конца блока`);
    return source.slice(start, end);
}

const clearCalls = source => (source.match(/clearScreen\(\)/g) || []).length;

// stdin проходит настоящий readline -> KEYQ -> readKey -> keyName. ANSI-ветка
// TTY и renderer тоже actual; только D.state заменён безопасным снимком.
// ConPTY не нужен: он уже искажал залпы escape-байтов в этом репо.
async function exerciseNavigation(source) {
    const input = new PassThrough();
    input.isTTY = false;
    const frames = [];
    const actions = [];
    let output = '';
    let items = [];
    let stateCalls = 0;
    let fed = false;
    let timer;
    const takeFrame = () => { frames.push({ output, items }); output = ''; items = []; };
    const D = {
        state() {
            stateCalls++;
            return { ahk: 'fixture-only', pid: 2468, installed: true, startup: true, task: true, managed: true };
        },
    };
    for (const action of ['install', 'disable', 'remove', 'confirm', 'pause']) {
        D[action] = () => { actions.push(action); throw new Error(`запрещённое fixture-действие: ${action}`); };
    }
    const context = vm.createContext({
        TTY: true, SAFE: false, W: () => 100, fs, readline, focusHook: null,
        WISPR_ART_FILE: path.join(ROOT, 'internal', 'wispr-art.txt'),
        process: { stdin: input, stdout: { write: text => { output += String(text); return true; } } },
        require(name) { assert.equal(name, './internal/dictation-fix'); return D; },
        confirm: D.confirm, pause: D.pause,
        traceItem: (item, selected) => items.push({ key: item.key, selected }),
        beforeRead() {
            if (frames.length >= 16) throw new Error('подменю превысило 16 чтений клавиш');
            takeFrame();
        },
        feedKeys() {
            if (fed) return;
            fed = true;
            // ↓, ↑, j, k, о(j), л(k), неизвестная z, Й(q).
            input.write('\x1b[B\x1b[AjkолzЙ');
        },
    });
    vm.runInContext([
        sourceBlock(source, 'const e = (code, s) =>', 'const sleep = L.sleep;'),
        sourceBlock(source, 'const G = (rich, safe)', '// ── Табло состояния'),
        actualFunction(source, 'function readArt('),
        sourceBlock(source, 'const KEYQ = [];', '// Русская раскладка.'),
        sourceBlock(source, 'const RU_TO_EN = {', '// Имя нажатой клавиши'),
        actualFunction(source, 'function keyName('),
        actualFunction(source, 'function itemLine('),
        actualFunction(source, 'async function doDictationFix('),
        // Только наблюдение: декодер/очередь/renderer/экран исполняются без замены.
        'const actualReadKey = readKey; readKey = () => { beforeRead(); const pending = actualReadKey(); feedKeys(); return pending; };',
        'const actualItemLine = itemLine; itemLine = (item, selected) => { traceItem(item, selected); return actualItemLine(item, selected); };',
    ].join('\n'), context, { timeout: 1000, filename: 'hub.js:fixture-dictation-navigation' });
    try {
        const result = await Promise.race([
            context.doDictationFix(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('подменю не вернулось за 1000 ms')), 1000); }),
        ]);
        takeFrame();
        const all = frames.map(frame => frame.output).join('');
        return {
            result, frames, stateCalls, actions,
            clears: (all.match(/\x1b\[2J\x1b\[H/g) || []).length,
            erases: (all.match(/\x1b\[2K\r/g) || []).length,
        };
    } finally {
        clearTimeout(timer);
        context.keysRelease();
        input.destroy();
    }
}

function assertNavigation(receipt) {
    assert.equal(receipt.result, true, 'Й/q возвращает управление');
    assert.equal(receipt.clears, 1, 'clearScreen: полный кадр только один раз при входе');
    assert.equal(receipt.stateCalls, 1, 'D.state не вызывается на стрелках');
    assert.equal(receipt.erases, 12, 'шесть переходов стирают ровно по две строки');
    assert.equal(receipt.frames.length, 9, 'восемь клавиш + выход');
    assert.match(receipt.frames[0].output, /Фикс диктовки в терминалах Orca/);
    assert.deepEqual(receipt.frames[0].items, [
        { key: '1', selected: true }, { key: '2', selected: false },
        { key: '3', selected: false }, { key: 'q', selected: false },
    ]);
    for (const [index, frame] of receipt.frames.entries()) {
        if (index === 0) continue;
        assert.ok(!frame.output.includes('\x1b[2J'), `полный clear на шаге ${index}`);
        if (index <= 6) {
            const previous = index % 2 ? '1' : '2';
            const selected = index % 2 ? '2' : '1';
            assert.deepEqual(frame.items, [{ key: previous, selected: false }, { key: selected, selected: true }], `две строки на шаге ${index}`);
            assert.equal((frame.output.match(/\x1b\[2K\r/g) || []).length, 2);
            assert.ok(!frame.output.includes('Фикс диктовки в терминалах Orca'), 'состояние не перепечатывается');
        } else {
            assert.equal(frame.output, '', 'z и Й/q ничего не перерисовывают');
            assert.deepEqual(frame.items, []);
        }
    }
    assert.deepEqual(receipt.actions, [], 'никаких install/disable/remove/confirm/pause');
}

function mutateMenu(before, after) {
    const declaration = 'async function doDictationFix(';
    const body = actualFunction(lfSource, declaration);
    assert.equal(body.split(before).length, 2, 'мутация попадает ровно в одно actual место');
    const start = lfSource.indexOf(declaration);
    return lfSource.slice(0, start) + body.replace(before, after) + lfSource.slice(start + body.length);
}

test('actual doDictationFix: старый LF-only срез на CRLF захватывает чужие clearScreen', t => {
    const tail = crlfSource.slice(crlfSource.indexOf('async function doDictationFix'));
    const legacyEnd = tail.indexOf('\n}\n');
    const legacyBody = tail.slice(0, legacyEnd);
    const actualBody = actualFunction(crlfSource, 'async function doDictationFix');
    assert.equal(legacyEnd, -1, 'CRLF не содержит LF-only границу');
    assert.equal(clearCalls(actualBody), 1, 'в реальном подменю ровно один clearScreen');
    assert.ok(clearCalls(legacyBody) > 1, 'ложный срез должен считать чужие вызовы');
    assert.ok(legacyBody.includes('async function doVersions'), 'старый срез включает соседний экран');
    assert.ok(!actualBody.includes('async function doVersions'), 'правильный срез исключает соседний экран');
    t.diagnostic(`CRLF: legacyEnd=${legacyEnd}, legacy clearScreen=${clearCalls(legacyBody)}, actual clearScreen=${clearCalls(actualBody)}`);
});

for (const [eol, source] of [['LF', lfSource], ['CRLF', crlfSource]]) {
    test(`точный actual-source dictation-menu gate принимает ${eol}`, () => {
        assert.equal(gateVerdict(source), true, `${eol}: ложный отказ на правильном hub.js`);
    });
    test(`actual меню ${eol}: стрелки/русские клавиши, один clear, две строки, q без паузы`, { timeout: 3000 }, async t => {
        const receipt = await exerciseNavigation(source);
        assertNavigation(receipt);
        t.diagnostic(`${eol}: clear=${receipt.clears}, state=${receipt.stateCalls}, eraseLine=${receipt.erases}, actions/pause=${receipt.actions.length}`);
    });
}

test('второй clearScreen в move отвергается actual gate на LF/CRLF и behavioral assertion', { timeout: 3000 }, async t => {
    const mutant = mutateMenu('const move = dir => {\n', 'const move = dir => {\n            clearScreen();\n');
    assert.equal(clearCalls(actualFunction(mutant, 'async function doDictationFix')), 2, 'реальный второй call-site');
    for (const [eol, source] of [['LF', mutant], ['CRLF', mutant.replace(/\n/g, '\r\n')]]) {
        const verdict = gateVerdict(source);
        assert.equal(verdict, 'clearScreen в подменю зовётся не только из draw()');
        t.diagnostic(`${eol}: второй clearScreen -> gate FAIL: ${verdict}`);
    }
    const receipt = await exerciseNavigation(mutant);
    assert.ok(receipt.clears > 1, 'второй call-site реально выполняется');
    assert.deepEqual(receipt.actions, []);
    assert.throws(() => assertNavigation(receipt), /clearScreen: полный кадр только один раз при входе/);
    t.diagnostic(`второй clear: behavioral FAIL, clear=${receipt.clears}, state=${receipt.stateCalls}`);
});

test('удаление needFull guard отвергается actual gate на LF/CRLF и behavioral assertion', { timeout: 3000 }, async t => {
    const mutant = mutateMenu('if (needFull) { draw(); needFull = false; }', 'draw(); needFull = false;');
    assert.equal(clearCalls(actualFunction(mutant, 'async function doDictationFix')), 1, 'guard-mutant не добавляет call-site');
    for (const [eol, source] of [['LF', mutant], ['CRLF', mutant.replace(/\n/g, '\r\n')]]) {
        const verdict = gateVerdict(source);
        assert.equal(verdict, 'кадр подменю рисуется без флага needFull — будет мигать');
        t.diagnostic(`${eol}: удалён needFull guard -> gate FAIL: ${verdict}`);
    }
    const receipt = await exerciseNavigation(mutant);
    assert.ok(receipt.clears > 1, 'без guard кадр реально очищается на стрелках');
    assert.ok(receipt.stateCalls > 1, 'без guard состояние реально читается заново');
    assert.deepEqual(receipt.actions, []);
    assert.throws(() => assertNavigation(receipt), /clearScreen: полный кадр только один раз при входе/);
    t.diagnostic(`needFull guard удалён: behavioral FAIL, clear=${receipt.clears}, state=${receipt.stateCalls}`);
});
