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
    check(isStateFile('routing/newprovider-modelmap.json'), 'any *-modelmap.json is a state file (pattern)');
    check(isStateFile('routing/api-gateway.json'), 'api-gateway.json is local state');
    check(!isStateFile('routing/api-gateway.default.json'), 'tracked API Gateway seed is not local state');
    check(!isStateFile('hub.js'), 'hub.js is not state (it is overwritten)');

    // ── 2. extract снимает верхнюю папку архива (strip:1) ──
    const packRoot = tmp('hu-pack-');
    const topDir = path.join(packRoot, 'hub-cc-deadbeef');
    fs.mkdirSync(path.join(topDir, 'routing'), { recursive: true });
    fs.writeFileSync(path.join(topDir, 'hub.js'), 'console.log("v2")\n');
    fs.writeFileSync(path.join(topDir, 'routing', 'ar-modelmap.json'), '{"from":"archive"}\n');
    fs.writeFileSync(path.join(topDir, 'routing', 'api-gateway.json'), '{"from":"archive"}\n');
    fs.writeFileSync(path.join(topDir, 'routing', 'api-gateway.default.json'), '{"seed":"archive"}\n');
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
    fs.writeFileSync(path.join(target, 'routing', 'ar-modelmap.json'), '{"user":"tiers"}\n'); // user settings
    const localManifest = Buffer.from('{"owner":"local"}\r\n', 'utf8');
    fs.writeFileSync(path.join(target, 'routing', 'api-gateway.json'), localManifest);
    fs.writeFileSync(path.join(target, 'routing', 'api-gateway.default.json'), '{"seed":"old"}\n');

    const res = HU.apply(outDir, target);
    check(fs.readFileSync(path.join(target, 'hub.js'), 'utf8').includes('v2'), 'код перезаписан свежим из архива');
    check(fs.readFileSync(path.join(target, 'routing', 'ar-modelmap.json'), 'utf8').includes('user'),
        'existing state file is not overwritten');
    check(fs.readFileSync(path.join(target, 'routing', 'api-gateway.json')).equals(localManifest),
        'existing local API Gateway manifest is preserved byte-exact');
    check(fs.readFileSync(path.join(target, 'routing', 'api-gateway.default.json'), 'utf8').includes('archive'),
        'tracked API Gateway default seed is updated from archive');
    check(res.preserved >= 1, `сохранённых настроек посчитано (${res.preserved})`);
    check(res.copied >= 1, `наложенных файлов посчитано (${res.copied})`);

    // ── 4. apply: state-файл, которого на диске НЕТ, всё-таки приезжает ──
    const target2 = tmp('hu-target2-');
    const res2 = HU.apply(outDir, target2);
    check(fs.existsSync(path.join(target2, 'routing', 'ar-modelmap.json')),
        'отсутствующий у пользователя обычный файл состояния приезжает из архива');
    check(!fs.existsSync(path.join(target2, 'routing', 'api-gateway.json')),
        'owner-local API Gateway manifest никогда не импортируется из update archive');
    check(fs.readFileSync(path.join(target2, 'routing', 'api-gateway.default.json'), 'utf8').includes('archive'),
        'tracked default seed приезжает и при отсутствии local manifest');

    // ── 5. apply serializes with the same owner-manifest writer lock ──
    const target3 = tmp('hu-target3-');
    fs.mkdirSync(path.join(target3, 'routing'), { recursive: true });
    fs.writeFileSync(path.join(target3, 'hub.js'), 'console.log("old")\n');
    const liveLock = path.join(target3, 'routing', 'api-gateway.json.lock');
    fs.writeFileSync(liveLock, String(process.pid), 'utf8');
    let busyError = null;
    try { HU.apply(outDir, target3); } catch (error) { busyError = error; }
    check(busyError && busyError.code === 'api_gateway_busy',
        'git-free apply refuses while a live manifest writer holds the shared lock');
    check(fs.readFileSync(path.join(target3, 'hub.js'), 'utf8').includes('old'),
        'blocked git-free update changes no code before lock acquisition');
    fs.unlinkSync(liveLock);
    fs.writeFileSync(path.join(target3, 'routing', 'api-gateway.json.txn'), '{"version":1}\n', 'utf8');
    let pendingError = null;
    try { HU.apply(outDir, target3); } catch (error) { pendingError = error; }
    check(pendingError && pendingError.code === 'api_gateway_busy',
        'git-free apply refuses while a picker recovery journal is pending');
    check(fs.readFileSync(path.join(target3, 'hub.js'), 'utf8').includes('old'),
        'pending recovery journal blocks code replacement before apply');
    fs.unlinkSync(path.join(target3, 'routing', 'api-gateway.json.txn'));
    const afterUnlock = HU.apply(outDir, target3);
    check(afterUnlock.copied >= 1 && fs.readFileSync(path.join(target3, 'hub.js'), 'utf8').includes('v2'),
        'git-free update proceeds after writer releases the lock');

    // уборка временных папок (свои, этой сессии — можно rm)
    for (const d of [packRoot, outDir, target, target2, target3]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

    console.log(`\n1..${checks}`);
    if (failures) { console.error(`${failures} проверок упало`); process.exit(1); }
    console.log('все проверки прошли');
}

main().catch(e => { console.error('гард упал:', e && e.stack ? e.stack : e); process.exit(1); });
