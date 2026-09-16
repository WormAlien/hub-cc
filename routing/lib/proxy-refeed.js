// routing/lib/proxy-refeed.js
//
// Долив списка скрапера в файл пула + запуск валидатора `find_for_host` для ЛЮБОГО хоста.
//
// Зачем модуль. Та же логика уже написана ВНУТРИ `transparent-proxy.js` дважды - для
// aikeysapi (`akFindProxyLaunch`, `akMergeProxyLines`) и для rumeng. Третья копия под
// Odyssey гарантированно разъехалась бы с первыми двумя: в этом репозитории такое уже
// было с ожиданием кода почты, где правка в либе не касалась чужого дубля, а снаружи это
// выглядело как «код не пришёл» при письме в ящике. Поэтому общее вынесено сюда; старые
// две копии живые и не тронуты, их миграция - отдельная строка в трекере.
//
// Что важно знать про сам долив (правила не мои, они выведены замерами 12.09):
//
// 🔴 Файл нельзя ЗАМЕНЯТЬ. Привязка «аккаунт → прокси» липкая, и `forAccount()` на
// исчезнувший из списка адрес отвечает `needsReassign`, то есть аккаунт встаёт без чека.
// Перезапись осиротила бы привязки всех уже начатых аккаунтов разом.
//
// 🪤 И просто склеивать нельзя. Публичные прокси живут минуты; за долгий прогон файл
// распух бы до сотен мёртвых строк, `leastLoaded` выбирал бы из них, и новые аккаунты
// садились бы на трупы. Поэтому свежие идут ПЕРВЫМИ, а хвост обрезается по `cap`.
//
// 🪤 Путь проверки задаётся вызывающим и по умолчанию НЕ `/api/status`. Соглашение
// `/api/status` - это New API; на sub2api оно отдавало 404, вердикт «HTTP 404», и ни один
// прокси не проходил при живом прокси и живой панели. У Odyssey (Next.js + Clerk) верный
// зонд - `/api/auth/altcha/challenge`: 200 JSON без авторизации, замер 16.09.
//
// API:
//   const rf = require('./proxy-refeed.js');
//   rf.mergeInto(liveFile, freshLines)                → { written, total }
//   await rf.findForHost({ host, want, path, out })   → { ok, lines, summary }
//   await rf.refeed({ host, want, path, liveFile })   → { ok, added, total, summary }
//
// CLI (им же удобно проверять руками):
//   node routing/lib/proxy-refeed.js --host odysseyapi.tech --want 5 \
//        --path /api/auth/altcha/challenge

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VALIDATOR_DIR = path.join(__dirname, '..', '..', 'tools', 'proxy-validator');
const EXPORT_DIR = path.join(VALIDATOR_DIR, 'export');
const DEFAULT_LIVE_FILE = path.join(EXPORT_DIR, 'live-for-host.txt');
const DEFAULT_CAP = 60;                 // предел файла пула: свежие впереди, хвост отрезается
const DEFAULT_PROBE_PATH = '/api/status';
// Потолок кандидатов на один прогон. 4000 - это минуты, а не десятки минут, и при обычной
// доле живых на публичных списках этого хватает на несколько адресов. Ноль = без потолка.
const DEFAULT_MAX_CANDIDATES = 4000;
// Под регистрацию нужно мало: один-три адреса, дальше прогон останавливается сам.
const DEFAULT_WANT = 3;

function readLines(file) {
    try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch { return []; }
}

// Свежие первыми, дубли по строке снимаются, длина режется по cap.
function mergeLines(fresh, old, cap = DEFAULT_CAP) {
    const seen = new Set();
    const out = [];
    for (const line of [...(fresh || []), ...(old || [])]) {
        const s = String(line).trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= cap) break;
    }
    return out;
}

// Запись атомарная: пул читает файл по mtime и может прочитать его в любой момент,
// поэтому половина файла на диске недопустима даже на миллисекунду.
function mergeInto(liveFile, freshLines, cap = DEFAULT_CAP) {
    const fresh = (freshLines || []).map(String).map(s => s.trim()).filter(Boolean);
    const before = readLines(liveFile);
    const merged = mergeLines(fresh, before, cap);
    fs.mkdirSync(path.dirname(liveFile), { recursive: true });
    const tmp = `${liveFile}.refeed-${process.pid}.tmp`;
    fs.writeFileSync(tmp, merged.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, liveFile);
    const added = merged.filter(l => !before.includes(l)).length;
    return { written: added, total: merged.length };
}

// Запуск валидатора. Итог он печатает последней строкой-JSON (`--json`), её и берём;
// найденные адреса пишет в `--out`, поэтому читаем ОБА источника: строка-итог говорит,
// чем кончилось, файл - что именно найдено.
//
// 🎯 Прогон ОГРАНИЧЕН по кандидатам (решение владельца 16.09: «нужно чтобы отбирал по 10
// штук и тормозил, а то каждый прогон на дохуя кандидатов это не ок»). У валидатора две
// разные ручки, и работают они вместе:
//   • `--want`            - сколько живых достаточно; найдя их, он останавливается сам;
//   • `--max-candidates`  - сколько адресов вообще проверять, даже если живых не набралось.
// Второе и есть потолок времени: без него прогон на пустых списках уходит в 120 тысяч
// проверок (замер 16.09: 6904 проверено, живых 0) и молотит впустую.
function findForHost({ host, want = 3, probePath = DEFAULT_PROBE_PATH, out = null, python = null,
                       maxCandidates = DEFAULT_MAX_CANDIDATES, workers = null, onLine = null } = {}) {
    if (!host) return Promise.resolve({ ok: false, error: 'host обязателен' });
    const outFile = out || path.join(EXPORT_DIR, `live-for-host.new.${process.pid}.txt`);
    const py = python || process.env.PYTHON || 'python';
    const args = [
        '-u',                         // без буферизации: иначе прогресс доедет одним куском в конце
        '-m', 'proxy_scraper.find_for_host',
        '--host', String(host),
        '--want', String(Math.max(1, Math.min(30, parseInt(want, 10) || 3))),
        '--path', String(probePath),
        '--max-candidates', String(Math.max(0, parseInt(maxCandidates, 10) || 0)),
        '--json',
        '--out', outFile,
    ];
    if (workers) args.push('--workers', String(parseInt(workers, 10) || 60));

    return new Promise((resolve) => {
        const proc = spawn(py, args, {
            cwd: VALIDATOR_DIR,
            windowsHide: true,
            // 🪤 Консоль Windows по умолчанию cp1252, и русская строка в логе валидатора
            // роняла прогон UnicodeEncodeError ещё до первой проверки.
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });

        let tail = '';
        let jsonLine = null;
        const feed = (chunk) => {
            tail += String(chunk);
            const parts = tail.split(/\r?\n/);
            tail = parts.pop();
            for (const line of parts) {
                const s = line.trim();
                if (!s) continue;
                if (s.startsWith('{')) jsonLine = s;
                if (onLine) onLine(s);
            }
        };
        proc.stdout.on('data', feed);
        proc.stderr.on('data', feed);
        proc.on('error', e => resolve({ ok: false, error: `валидатор не запустился: ${e.message}` }));
        proc.on('close', (code) => {
            if (tail.trim().startsWith('{')) jsonLine = tail.trim();
            let summary = null;
            if (jsonLine) { try { summary = JSON.parse(jsonLine); } catch { /* не JSON - и ладно */ } }
            const lines = readLines(outFile);
            // Файл валидатора временный - оставлять его в export незачем.
            if (!out) { try { fs.unlinkSync(outFile); } catch { /* мог не появиться */ } }
            resolve({ ok: code === 0 || lines.length > 0, exitCode: code, lines, summary });
        });
    });
}

async function refeed({ host, want = DEFAULT_WANT, probePath = DEFAULT_PROBE_PATH, liveFile = DEFAULT_LIVE_FILE,
                        cap = DEFAULT_CAP, maxCandidates = DEFAULT_MAX_CANDIDATES, workers = null, onLine = null } = {}) {
    const found = await findForHost({ host, want, probePath, maxCandidates, workers, onLine });
    if (!found.ok && !found.lines.length) {
        return { ok: false, error: found.error || `валидатор кончился с кодом ${found.exitCode}`, added: 0, total: readLines(liveFile).length };
    }
    const m = mergeInto(liveFile, found.lines, cap);
    return { ok: true, added: m.written, total: m.total, found: found.lines.length, summary: found.summary };
}

module.exports = {
    readLines, mergeLines, mergeInto, findForHost, refeed,
    DEFAULT_LIVE_FILE, DEFAULT_CAP, DEFAULT_PROBE_PATH, DEFAULT_MAX_CANDIDATES, DEFAULT_WANT,
    VALIDATOR_DIR, EXPORT_DIR,
};

if (require.main === module) {
    const argv = process.argv.slice(2);
    const val = (name, def = null) => {
        const i = argv.indexOf(name);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
    };
    const host = val('--host');
    if (!host) {
        console.log('нужно: node routing/lib/proxy-refeed.js --host <хост> [--want 3] [--max 4000] [--path /api/status]');
        console.log('  --want  сколько живых достаточно (найдя их, прогон останавливается сам)');
        console.log('  --max   потолок проверенных кандидатов, 0 = без потолка');
        process.exit(2);
    }
    const want = val('--want', String(DEFAULT_WANT));
    const maxCandidates = val('--max', String(DEFAULT_MAX_CANDIDATES));
    const probePath = val('--path', DEFAULT_PROBE_PATH);
    // 🔴 Проверка не формальная, она стоит четырёх минут прогона. Git-bash на этой машине
    // подменяет аргумент, начинающийся со слеша, на путь Windows: `--path /api/auth/altcha/
    // challenge` дошёл до валидатора как `C:/Program Files/Git/api/auth/altcha/challenge`,
    // и все проверенные прокси получили 404 - «живых 0» при полностью живом пуле адресов.
    // Лечится `MSYS_NO_PATHCONV=1` перед командой; здесь - громкий отказ вместо тишины.
    if (!probePath.startsWith('/')) {
        console.log(`❌ --path должен начинаться со слеша, а пришло: ${probePath}`);
        console.log('   Похоже на подмену пути git-bash. Запускай так:');
        console.log(`   MSYS_NO_PATHCONV=1 node routing/lib/proxy-refeed.js --host ${host} --want ${want} --path /api/...`);
        process.exit(2);
    }
    console.log(`ищу живые прокси для ${host}: нужно ${want}, потолок кандидатов ${maxCandidates}, зонд ${probePath}`);
    refeed({ host, want, maxCandidates, probePath, onLine: s => console.log(`  ${s.slice(0, 160)}`) })
        .then(r => {
            if (!r.ok) { console.log(`❌ ${r.error}`); process.exit(1); }
            console.log(`✅ найдено ${r.found}, долито в пул ${r.added}, всего в файле ${r.total}`);
        })
        .catch(e => { console.log(`❌ ${e.message}`); process.exit(1); });
}
