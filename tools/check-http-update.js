'use strict';

// Регресс на git-free обновление (tools/http-update.js): путь для машин без git
// (у друга не установлен). Две вещи, которые молча испортили бы рабочую копию:
//   1) распаковка снимает верхнюю папку архива GitHub (`hub-cc-<sha>/`) — иначе
//      весь код лёг бы на уровень глубже и хаб бы не нашёл себя;
//   2) наложение НЕ перезаписывает файлы состояния (тир-карты, front-door), если
//      они уже есть на диске — их писатель дашборд, upstream их трогать не должен;
//      при этом код перезаписывается, а новые файлы приезжают.
//
// Тест поведенческий и оффлайновый: сеть не трогаем, собираем фикстур-архив сами
// и накладываем во временную папку-цель (apply принимает target).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const tar = require('tar-fs');

const HU = require('./http-update');
const { isStateFile } = require('./git-pull-safe');

let checks = 0, failures = 0;
function check(cond, msg) {
    checks += 1;
    if (cond) console.log(`ok ${checks} - ${msg}`);
    else { failures += 1; console.error(`not ok ${checks} - ${msg}`); }
}

function tmp(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), pfx)); }

async function main() {
    // ── 1. Экспорт контракта ──
    for (const fn of ['remoteSha', 'localVersion', 'writeVersion', 'download', 'extract', 'apply', 'applyUpdate']) {
        check(typeof HU[fn] === 'function', `http-update экспортирует ${fn}`);
    }
    // Якорь: state-файл узнаётся тем же предикатом, что и в git-пути.
    check(isStateFile('routing/ar-modelmap.json'), 'ar-modelmap.json — файл состояния');
    check(isStateFile('routing/newprovider-modelmap.json'), 'любой *-modelmap.json — файл состояния (паттерн)');
    check(!isStateFile('hub.js'), 'hub.js — не файл состояния (перезапишется)');

    // ── 2. extract снимает верхнюю папку архива (strip:1) ──
    const packRoot = tmp('hu-pack-');
    const topDir = path.join(packRoot, 'hub-cc-deadbeef');
    fs.mkdirSync(path.join(topDir, 'routing'), { recursive: true });
    fs.writeFileSync(path.join(topDir, 'hub.js'), 'console.log("v2")\n');
    fs.writeFileSync(path.join(topDir, 'routing', 'ar-modelmap.json'), '{"from":"archive"}\n');
    // Архив пишем ВНЕ packRoot: положив его внутрь, tar.pack начнёт паковать
    // растущий на ходу tarball и повиснет (сам себя читает).
    const tarPath = path.join(tmp('hu-tar-'), 'src.tar.gz');
    await pipeline(tar.pack(packRoot), zlib.createGzip(), fs.createWriteStream(tarPath));

    const outDir = tmp('hu-out-');
    await HU.extract(tarPath, outDir);
    check(fs.existsSync(path.join(outDir, 'hub.js')), 'после extract hub.js лежит в корне (папка hub-cc-<sha> снята)');
    check(!fs.existsSync(path.join(outDir, 'hub-cc-deadbeef')), 'верхняя папка архива не осталась');
    check(fs.existsSync(path.join(outDir, 'routing', 'ar-modelmap.json')), 'вложенные пути распакованы');

    // ── 3. apply: код поверх, state-файл цел, новый файл приезжает ──
    const target = tmp('hu-target-');
    fs.mkdirSync(path.join(target, 'routing'), { recursive: true });
    fs.writeFileSync(path.join(target, 'hub.js'), 'console.log("v1")\n');           // старый код
    fs.writeFileSync(path.join(target, 'routing', 'ar-modelmap.json'), '{"user":"tiers"}\n'); // настройки пользователя

    const res = HU.apply(outDir, target);
    check(fs.readFileSync(path.join(target, 'hub.js'), 'utf8').includes('v2'), 'код перезаписан свежим из архива');
    check(fs.readFileSync(path.join(target, 'routing', 'ar-modelmap.json'), 'utf8').includes('user'),
        'существующий файл состояния НЕ перезаписан (настройки пользователя целы)');
    check(res.preserved >= 1, `сохранённых настроек посчитано (${res.preserved})`);
    check(res.copied >= 1, `наложенных файлов посчитано (${res.copied})`);

    // ── 4. apply: state-файл, которого на диске НЕТ, всё-таки приезжает ──
    const target2 = tmp('hu-target2-');
    const res2 = HU.apply(outDir, target2);
    check(fs.existsSync(path.join(target2, 'routing', 'ar-modelmap.json')),
        'отсутствующий у пользователя файл состояния приезжает из архива');

    // уборка временных папок (свои, этой сессии — можно rm)
    for (const d of [packRoot, outDir, target, target2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

    console.log(`\n1..${checks}`);
    if (failures) { console.error(`${failures} проверок упало`); process.exit(1); }
    console.log('все проверки прошли');
}

main().catch(e => { console.error('гард упал:', e && e.stack ? e.stack : e); process.exit(1); });
