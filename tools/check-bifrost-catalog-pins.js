// Пины каталогов Bifrost должны совпадать с файлами В ЛЮБОЙ рабочей копии.
//
// Живой случай 16.11.2026: sidecar не стартовал ни у кого, кроме владельца, с
// безликим «OpenAI sidecar недоступен». Причина в переводе строк: пины в
// bifrost-lock.json посчитаны по CRLF-копии (Windows, core.autocrlf=true), а в git
// лежат LF-блобы. На Windows sha256 совпадал, на macOS — нет, и copyPinnedCatalog
// кидал bifrost_catalog_invalid.
//
// Корень — .gitattributes: `*.json text` + core.autocrlf=true даёт CRLF в рабочей
// копии, а каталожные файлы Bifrost не были помечены `eol=lf`, в отличие от
// bifrost-lock.json и bifrost-config.json. Поэтому проверяем два инварианта:
//   1) каталожные файлы закреплены на LF;
//   2) пин в lock равен sha256 файла, КАК ЕГО ВИДИТ GIT (LF), а не рабочей копии.
'use strict';
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs'), path = require('path');

const REPO = path.resolve(__dirname, '..');
const ok = (n, c, extra) => {
    console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${extra && !c ? '  -> ' + extra : ''}`);
    if (!c) process.exitCode = 1;
};
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'routing/bifrost-lock.json'), 'utf8'));
const catalogs = [
    ['pricing', 'routing/bifrost-pricing.json'],
    ['modelParameters', 'routing/bifrost-model-parameters.json'],
];

// ── 1. Каталожные файлы закреплены на LF ──────────────────────────────────────
const attrs = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
for (const [, file] of catalogs) {
    const line = attrs.split(/\r?\n/).find(l => l.trim().startsWith(file));
    ok(`${file}: закреплён eol=lf`, Boolean(line) && /eol=lf/.test(line),
        line ? line.trim() : 'правила нет — значит действует `*.json text` (CRLF на Windows)');
}

// ── 2. Пин == sha256 блоба в git ──────────────────────────────────────────────
// Именно этот байт-в-байт файл приезжает на macOS, где core.autocrlf выключен.
for (const [key, file] of catalogs) {
    const pin = lock.catalogs[key].sha256;
    const blob = git('show', `HEAD:${file}`);
    // git show декодирует в utf8; для побайтового сравнения берём сырой blob.
    const raw = execFileSync('git', ['cat-file', 'blob', `HEAD:${file}`], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 });
    ok(`${file}: пин совпадает с git-блобом`, sha256(raw) === pin,
        `pin=${pin.slice(0, 16)}… blob=${sha256(raw).slice(0, 16)}…`);
    ok(`${file}: блоб без CRLF`, !raw.includes(0x0d),
        'в git попал CRLF — пины разъедутся снова');
    void blob;
}

// ── 3. Рабочая копия тоже должна совпадать (после eol=lf она не переводится) ──
for (const [key, file] of catalogs) {
    const pin = lock.catalogs[key].sha256;
    const disk = fs.readFileSync(path.join(REPO, file));
    ok(`${file}: файл на диске совпадает с пином`, sha256(disk) === pin,
        `disk=${sha256(disk).slice(0, 16)}… (CRLF в рабочей копии?)`);
}

// ── 4. Причина не должна глотаться: ошибка обязана называть код ───────────────
const sidecar = fs.readFileSync(path.join(REPO, 'routing/lib/bifrost-sidecar.js'), 'utf8');
ok('bifrost_catalog_invalid назван в ошибке', /bifrost_catalog_invalid/.test(sidecar));
// optionalFailure живёт в lifecycle.js и обязан передать code в событие, а reporter
// в hub.js — напечатать его. Иначе снаружи остаётся безликое «sidecar недоступен»,
// ровно то, с чем пришёл пользователь.
const lifecycle = fs.readFileSync(path.join(REPO, 'routing/lifecycle.js'), 'utf8');
const optionalFn = lifecycle.slice(lifecycle.indexOf('const optionalFailure ='), lifecycle.indexOf('const optionalFailure =') + 500);
ok('optionalFailure передаёт code в событие', /code,/.test(optionalFn) || /code:/.test(optionalFn),
    optionalFn.split('\n').slice(0, 12).join(' | '));
const hub = fs.readFileSync(path.join(REPO, 'hub.js'), 'utf8');
const reporterCase = hub.slice(hub.indexOf("case 'start-optional-failed'"), hub.indexOf("case 'start-optional-failed'") + 900);
ok('reporter печатает code', /ev\.code/.test(reporterCase), reporterCase.split('\n').slice(0, 8).join(' | '));
ok('reporter печатает text', /ev\.text/.test(reporterCase));
