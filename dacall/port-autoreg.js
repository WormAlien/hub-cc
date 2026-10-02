// dacall/port-autoreg.js — одноразовый перенос авторег-поверхности lsapi → dacall.
//
// Зачем: вкладка dacall заведена клоном KKtoken (`spec._source = kktoken`), а у KKtoken
// флаг autoreg выключен — поэтому в спеке add-gateway НЕТ ни одной autoreg-точки, и
// кнопки «🤖 Авторег / 🔎 Найти прокси» на вкладку не попали. Эталон автореги — lsapi.
// Этот скрипт извлекает ls-autoreg регион бэкенда и маршруты, переименовывает ls→dc и
// вставляет рядом. Фронт переносится отдельным скриптом.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
let src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

// ── 1. Границы бэкенд-региона: от `const lsAutoreg = {` до строки перед handleAkPing ──
const startIdx = lines.findIndex(l => l.startsWith('const lsAutoreg = {'));
const akPingIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith('async function handleAkPing'));
if (startIdx < 0 || akPingIdx < 0) { console.error('не нашёл границы бэкенд-региона', startIdx, akPingIdx); process.exit(1); }
// Последняя строка региона — пустая перед handleAkPing. Заберём до неё включительно.
let endIdx = akPingIdx - 1;
const backendBlock = lines.slice(startIdx, endIdx + 1).join('\n');

// ── переименование ls → dc ──
function rename(text) {
    return text
        // строки-литералы (до общего lsapi)
        .replace(/'lsapi\.cloud'/g, "'api-ru.dacall.ai'")
        .replace(/lsapi\/auto-add\.js/g, 'dacall/auto-add.js')
        .replace(/\blsapi\b/g, 'dacall')
        .replace(/Lingshu/g, 'dacall.AI')
        // идентификаторы: lsXxx (camel) и handleLsXxx и LS_
        .replace(/\bls(?=[A-Z])/g, 'dc')
        .replace(/Ls(?=[A-Z])/g, 'Dc')
        .replace(/\bLS_/g, 'DC_')
        // пути маршрутов /api/ls/ → /api/dc/
        .replace(/\/__switch\/api\/ls\//g, '/__switch/api/dc/');
}

const portedBackend = rename(backendBlock);

// Защита: клон не должен содержать ls-autoreg имён
const leftover = portedBackend.match(/\bls[A-Z][A-Za-z]*|handleLs|LS_[A-Z]|'lsapi'|lsapi\.cloud/g);
if (leftover) { console.error('остались ls-имена в клоне:', [...new Set(leftover)].slice(0, 20)); process.exit(1); }

// ── вставка бэкенда: после региона ls (перед handleAkPing), с разделителем ──
const header = '\n// ═══════════ dacall.AI: авторег (клон lsapi, порт 01.10) ═══════════\n';
lines.splice(endIdx + 1, 0, header + portedBackend);
src = lines.join('\n');

// ── 2. Маршруты ──
const routeAnchor = "    if (req.method === 'GET'  && req.url === '/__switch/api/ls/proxy-pool') return handleLsProxyPool(req, res);";
const routeBlockLs = [
  "    if (req.method === 'GET'  && req.url === '/__switch/api/ls/autoreg/status') return handleLsAutoregStatus(req, res);",
  "    if (req.method === 'POST' && req.url === '/__switch/api/ls/autoreg/start') return handleLsAutoregStart(req, res);",
  "    if (req.method === 'POST' && req.url === '/__switch/api/ls/autoreg/stop') return handleLsAutoregStop(req, res);",
  "    if (req.method === 'POST' && req.url === '/__switch/api/ls/autoreg/find-proxy') return handleLsFindProxyStart(req, res);",
  "    if (req.method === 'GET'  && req.url === '/__switch/api/ls/autoreg/find-proxy') return handleLsFindProxyStatus(req, res);",
  "    if (req.method === 'POST' && req.url === '/__switch/api/ls/autoreg/find-proxy/stop') return handleLsFindProxyStop(req, res);",
  "    if (req.method === 'GET'  && req.url === '/__switch/api/ls/refill') return handleLsRefillState(req, res);",
  "    if (req.method === 'GET'  && req.url === '/__switch/api/ls/proxy-lines') return handleLsProxyPoolLines(req, res);",
  "    if (req.method === 'GET'  && req.url === '/__switch/api/ls/proxy-pool') return handleLsProxyPool(req, res);",
].join('\n');
if (!src.includes(routeAnchor)) { console.error('не нашёл якорь маршрутов ls'); process.exit(1); }
const portedRoutes = rename(routeBlockLs);
src = src.replace(routeAnchor, routeAnchor + '\n' + portedRoutes);

fs.writeFileSync(FILE, src, 'utf8');
console.log('бэкенд dacall-автореги вставлен; маршруты добавлены. Проверь node -c.');
