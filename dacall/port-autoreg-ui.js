// dacall/port-autoreg-ui.js — перенос фронта авторег-UI lsapi → dacall.
// Три поверхности: лог-панели (find + autoreg), контролы тулбара, JS-функции.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
let lines = fs.readFileSync(FILE, 'utf8').split('\n');

const findLine = (needle, from = 0) => {
    const i = lines.findIndex((l, idx) => idx >= from && l.includes(needle));
    if (i < 0) throw new Error('не нашёл: ' + needle);
    return i;
};

// ── переименование ls→dc (idшники, функции, пути; хост/папка — как в бэкенде) ──
function rename(t) {
    return t
        .replace(/id="ls-/g, 'id="dc-')
        .replace(/'ls-/g, "'dc-")                       // $('ls-...') и getElementById
        .replace(/lsapi\.cloud/g, 'api-ru.dacall.ai')
        .replace(/\blsapi\b/g, 'dacall')
        .replace(/Lingshu/g, 'dacall.AI')
        .replace(/\bls(?=[A-Z])/g, 'dc')                // lsAutoregStart, loadLsSessions→loadDcSessions
        .replace(/Ls(?=[A-Z])/g, 'Dc')                  // loadLsSessions, renderLs
        .replace(/\bLS_/g, 'DC_')                        // LS_FIND_FLOOR, LS_STAGE_LABELS — иначе дубль const
        .replace(/newapiFilterChange\('ls'\)/g, "newapiFilterChange('dc')")
        .replace(/\('ls'\)/g, "('dc')")
        .replace(/\/__switch\/api\/ls\//g, '/__switch/api/dc/');
}

// Защита от наивной замены: в тулбаре/панелях цвет ls был violet/azure — у dacall orange.
// Не трогаем цвета намеренно (визуальная мелочь), но проверяем, что ls-идентификаторы ушли.
function assertClean(t, label) {
    const bad = t.match(/id="ls-|'ls-|lsAutoreg|lsFindProxy|lsProxyPool|loadLsSessions|\/api\/ls\//g);
    if (bad) throw new Error(`${label}: остались ls-имена: ${[...new Set(bad)].slice(0,10)}`);
}

// ── 1. Лог-панели: ls-find-log-wrap … ls-autoreg-log-wrap (единым куском) ──
const logStart = findLine('id="ls-find-log-wrap"');
const logEnd = findLine('id="ls-autoreg-log"', logStart); // <pre id=ls-autoreg-log...>
// панель autoreg закрывается </div> через строку после log-err
const logErr = findLine('id="ls-autoreg-log-err"', logEnd);
const logClose = logErr + 1; // следующая строка — закрывающий </div> панели
const logBlock = lines.slice(logStart, logClose + 1).join('\n');
let portedLog = rename(logBlock);
assertClean(portedLog, 'лог-панели');

// ── 2. Контролы тулбара: ls-autoreg-count … ls-autoreg-status ──
const ctlStart = findLine('id="ls-autoreg-count"');
const ctlEnd = findLine('id="ls-autoreg-status"', ctlStart);
const ctlBlock = lines.slice(ctlStart, ctlEnd + 1).join('\n');
let portedCtl = rename(ctlBlock);
assertClean(portedCtl, 'контролы');

// ── 3. JS-блок: function lsAutoregProxyToggle … конец lsAutoregStop ──
const jsStart = findLine('function lsAutoregProxyToggle()');
const jsOdyssey = findLine('🤖 Авторег Odyssey', jsStart);   // маркер начала след. блока
// отступаем назад к последней непустой строке блока ls
let jsEnd = jsOdyssey - 1;
while (jsEnd > jsStart && lines[jsEnd].trim() === '') jsEnd--;
const jsBlock = lines.slice(jsStart, jsEnd + 1).join('\n');
let portedJs = rename(jsBlock);
assertClean(portedJs, 'JS-блок');

// ── вставки (снизу вверх по номерам строк, чтобы индексы не поехали) ──
// 3. JS — сразу после ls-блока
lines.splice(jsEnd + 1, 0, '\n// ═══════════ dacall.AI: авторег UI (клон lsapi) ═══════════\n' + portedJs);

// 2. контролы — перед <input id="dc-filter"> в тулбаре dacall
const dcFilterIdx = findLine('id="dc-filter"');
lines.splice(dcFilterIdx, 0, portedCtl);

// 1. лог-панели — перед тулбаром dacall (<div class="flex gap-2 items-center flex-wrap"> после loadDcSessions)
const dcToolbarIdx = findLine('<div class="flex gap-2 items-center flex-wrap">', findLine('data-tab-content="dacall"'));
lines.splice(dcToolbarIdx, 0, portedLog);

fs.writeFileSync(FILE, lines.join('\n'), 'utf8');
console.log('фронт dacall-автореги вставлен: лог-панели + контролы + JS');
