#!/usr/bin/env node
'use strict';
// Проверка ПЕРЕД пушем: в публичный репо не уезжают секреты и мусор.
//
// Зачем (14.09.2026): в public-репо `hub-cc` уехали `routing/rumeng-sessions.json` с
// email, паролями, `api_key` и токенами десяти аккаунтов и `rumeng/sessions/acct_rm_*.json`
// с живыми куками. Ни то, ни другое не выглядело ошибкой: файлы рабочие, репо локально
// приватный по ощущению. GitHub индексирует мгновенно — удаление постфактум не помогает.
//
// Зовётся из ДВУХ крючков (устройство и включение — в шапке `.githooks/pre-commit`):
//   `.githooks/pre-commit` → `--staged` — что вот-вот станет коммитом (индекс);
//   `.githooks/pre-push`               — что уезжает этим пушем (диапазон base..head).
// Второй нужен отдельно: коммит с секретом остаётся в локальной истории навсегда, но
// уехать наружу он может и позже, другим пушем — например, после снятия секрета из файла.
// Обойти на один раз: `git commit --no-verify` или `git push --no-verify`.
// Проверить вручную: `node tools/check-no-secrets.js --staged`
//                     `node tools/check-no-secrets.js --range=<base>..<head>`
//
// Проверяется ровно то, что добавляется этим коммитом (пушем), а не вся история: иначе
// страж блокировал бы всё вечно из-за того, что уже лежит в прошлом.
//
//   1. ПУТИ — личные данные и мусор. Блокируем по имени независимо от содержимого:
//      профили браузеров, пулы сессий, ключи, `.tmp-*`, бэкапы движка.
//   2. СОДЕРЖИМОЕ добавленных строк — ключи, токены, приватные ключи, пароли в пулах.
//
// Отпечаток находки печатается усечённым: полный секрет в логе — вторая утечка.

const { execFileSync } = require('child_process');

// Пустой tree — база сравнения для новой ветки (её локальная сторона уезжает целиком).
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(args, input) {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
        input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
}
function gitSafe(args, input) {
    try { return git(args, input); } catch (e) { return null; }
}

// ── 1. Пути: личные данные и мусор ───────────────────────────────────────────
// Правило простое: если файл по имени похож на приватные данные или отходы — он не
// должен быть в индексе вовсе. Содержимое тут не смотрим: у профилей и сессий его
// ещё и не прочитать как текст.
const JUNK_PATH = [
    [/(^|\/)\.tmp[-._]/, 'временный файл сессии (.tmp-*)'],
    [/(^|\/)\.tmp\//, 'временный каталог (.tmp/)'],
    [/(^|\/)\.tmp-stand\//, 'стенд замеров (.tmp-stand/)'],
    [/\.orig$/, 'след слияния (.orig)'],
    [/\.rej$/, 'след слияния (.rej)'],
    [/\.bak-/, 'бэкап перед правкой (.bak-*)'],
    [/\.bak$/, 'бэкап (.bak)'],
    [/(^|\/)node_modules\//, 'зависимости (node_modules)'],
    [/(^|\/)__pycache__\//, 'кэш Python'],
    [/(^|\/)\.DS_Store$/, 'мусор macOS'],
    [/Thumbs\.db$/, 'мусор Windows'],
    [/(^|\/)sessions\//, 'живые сессии (куки, токены)'],
    [/(^|\/)gh-sessions\//, 'снимки GitHub-сессий'],
    [/(^|\/)profiles\//, 'профили браузера'],
    [/(^|\/)recordings\//, 'записи'],
    [/-sessions\.json$/, 'пул сессий/аккаунтов'],
    [/(^|\/)accounts\.txt$/, 'список аккаунтов'],
    [/(^|\/)keys\.(txt|json)$/, 'файл с ключами'],
    [/\.env$/, 'файл окружения с секретами'],
    [/\.(pem|key|pfx|p12)$/, 'ключ или сертификат'],
    // 🔴 Пул адресов пробы (23.09.2026). Путь добавлен отдельным правилом, потому что
    // содержимое тут секретом НЕ выглядит и обычные правила его не ловят: в файле
    // `{"label":"http://185.114.117.145:10808"}` - голый адрес без логина и пароля.
    // При этом `tier: own` означает СОБСТВЕННУЮ ноду владельца, а коммит `63fbc90` убирал
    // ровно этот класс из публичного репо: «опубликована цель для сканирования и брутфорса,
    // а на ноде fail2ban». Проба `_research/probe-odyssey-candidates.js:229,232` пишет в оба
    // файла свой пул, поэтому одного `.gitignore` мало: файлы снимаются с отслеживания, а
    // это правило ловит и осознанный `git add -f`, и будущую правку `.gitignore`.
    [/(^|\/)(odyssey|_research)\/[^/]*candidates\.json$/, 'пул адресов пробы (в нём адреса своих нод)'],
];

// Исключения: это не секреты и не мусор — образцы конфигов и сторонние библиотеки.
const PATH_OK = [
    /\.example\.(json|js|sh|env|txt)$/i,
    /\.env\.example$/i,
    /(^|\/)routing\/vendor\//,
    /(^|\/)docs\//,
    /package-lock\.json$/,
];

// ── 2. Содержимое добавленных строк ─────────────────────────────────────────
// Только шаблоны с высокой уверенностью. Всё, что похоже на «может быть ключом»,
// здесь намеренно отсутствует: страж, который срабатывает на безобидном, отключают
// в первый же вечер, и он перестаёт защищать вообще.
const SECRETS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'приватный ключ'],
    [/\bghp_[A-Za-z0-9]{36}\b/, 'токен GitHub (ghp_)'],
    [/\bgho_[A-Za-z0-9]{36}\b/, 'токен GitHub OAuth (gho_)'],
    [/\bghu_[A-Za-z0-9]{36}\b/, 'токен GitHub (ghu_)'],
    [/\bghs_[A-Za-z0-9]{36}\b/, 'токен GitHub App (ghs_)'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'токен GitHub (fine-grained)'],
    [/\bsk-[A-Za-z0-9_-]{32,}/, 'API-ключ (sk-)'],
    [/\bsk_live_[A-Za-z0-9]{16,}/, 'ключ Stripe (live)'],
    [/\brk_live_[A-Za-z0-9]{16,}/, 'ключ Stripe (restricted live)'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'ключ AWS (access key id)'],
    [/\bASIA[0-9A-Z]{16}\b/, 'ключ AWS (временный)'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'токен Slack'],
    [/\b\d{8,10}:[A-Za-z0-9_-]{33,}\b/, 'токен Telegram-бота'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, 'ключ Google API'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'JWT'],
];
// Поля-пароли в JSON-пулах: имя поля + значение. Значение смотрим отдельно —
// иначе `"password": "CHANGE_ME"` из образца конфига считался бы утечкой.
const SECRET_FIELD = /"(password|passwd|api_key|apikey|access_?token|refresh_?token|client_secret|secret_key)"\s*:\s*"([^"]{8,})"/gi;
const PLACEHOLDER = /^(x+|\*+|\.+|example|placeholder|change[-_ ]?me|your[-_ ]|replace|insert|todo|none|null|test|probe|demo|sample|dummy|abc+|1234|password|пароль|qwerty)/i;

const redact = s => s.slice(0, 6) + '…(' + s.length + ' симв)';

function scanContent(path, line) {
    const out = [];
    for (const [re, what] of SECRETS) {
        const m = re.exec(line);
        if (m) out.push(what + ' ' + redact(m[0]));
    }
    SECRET_FIELD.lastIndex = 0;
    let f;
    while ((f = SECRET_FIELD.exec(line)) !== null) {
        const value = f[2];
        if (PLACEHOLDER.test(value)) continue;
        if (/[<>{}$]/.test(value)) continue;          // шаблон вида ${TOKEN}
        out.push('пароль/ключ в поле ' + f[1] + ' ' + redact(value));
    }
    return out;
}

// ── Что уезжает этим пушем ──────────────────────────────────────────────────
function refsFromStdin() {
    let raw = '';
    try { raw = require('fs').readFileSync(0, 'utf8'); } catch (e) { raw = ''; }
    const refs = [];
    for (const line of raw.split('\n')) {
        const p = line.trim().split(/\s+/);
        if (p.length === 4) refs.push({ localRef: p[0], localSha: p[1], remoteRef: p[2], remoteSha: p[3] });
    }
    return refs;
}
const ZERO = /^0+$/;

function scanDiffText(diff) {
    const paths = [], findings = [];
    let cur = '';
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) { cur = line.slice(4).trim(); if (cur !== '/dev/null') paths.push(cur); continue; }
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        const body = line.slice(1);
        if (!cur) continue;
        if (PATH_OK.some(re => re.test(cur))) continue;
        for (const hit of scanContent(cur, body)) findings.push({ path: cur, what: hit });
    }
    return { paths, findings };
}

function scanRange(base, head) {
    const diff = gitSafe(['diff', '-U0', '--no-color', '--no-prefix', '--diff-filter=ACMR', base, head]);
    if (diff === null) return { paths: [], findings: [], err: 'не удалось прочитать диапазон ' + base + '..' + head };
    return Object.assign(scanDiffText(diff), { err: null });
}

// То же самое, но про ИНДЕКС: то, что вот-вот станет коммитом. Зовётся из pre-commit,
// чтобы секрет не попадал даже в локальную историю — на пуше ловить уже поздно,
// коммит с секретом останется в репозитории навсегда.
function scanStaged() {
    const diff = gitSafe(['diff', '--cached', '-U0', '--no-color', '--no-prefix', '--diff-filter=ACMR']);
    if (diff === null) return { paths: [], findings: [], err: 'не удалось прочитать индекс' };
    return Object.assign(scanDiffText(diff), { err: null });
}

function main() {
    const argv = process.argv.slice(2);
    const rangeArg = argv.find(a => a.startsWith('--range='));
    let ranges = [];
    if (argv.includes('--staged')) {
        // Режим pre-commit: смотрим индекс, а не историю — что вот-вот станет коммитом.
        ranges.push({ staged: true, label: 'индекс (что уходит в коммит)' });
    } else if (rangeArg) {
        const [b, h] = rangeArg.slice('--range='.length).split('..');
        ranges.push({ base: b, head: h, label: b + '..' + h });
    } else {
        const refs = refsFromStdin();
        if (!refs.length) {
            console.log('check-no-secrets: refs не переданы (запуск руками?) — беру HEAD против HEAD~1');
            ranges.push({ base: 'HEAD~1', head: 'HEAD', label: 'HEAD~1..HEAD' });
        }
        for (const r of refs) {
            if (ZERO.test(r.localSha)) continue;                  // удаление ветки — везти нечего
            const base = ZERO.test(r.remoteSha) ? EMPTY_TREE : r.remoteSha;
            ranges.push({ base, head: r.localSha, label: r.remoteRef || r.localRef });
        }
    }

    const problems = [];
    const seen = new Set();
    for (const r of ranges) {
        const { paths, findings, err } = r.staged ? scanStaged() : scanRange(r.base, r.head);
        if (err) { console.log('check-no-secrets: ' + err + ' — пропускаю'); continue; }
        for (const p of paths) {
            if (PATH_OK.some(re => re.test(p))) continue;
            for (const [re, what] of JUNK_PATH) {
                if (re.test(p)) { problems.push({ kind: 'путь', path: p, what, range: r.label }); break; }
            }
        }
        for (const f of findings) {
            const key = f.path + '|' + f.what;
            if (seen.has(key)) continue;
            seen.add(key);
            problems.push({ kind: 'содержимое', path: f.path, what: f.what, range: r.label });
        }
    }

    if (!problems.length) {
        console.log('check-no-secrets: чисто — ' + ranges.length + ' диапазон(ов), секретов и мусора нет');
        return 0;
    }
    console.error('');
    console.error('check-no-secrets: СТОП. В этот коммит (пуш) попадёт то, чего в репозитории быть не должно:');
    for (const p of problems) {
        console.error('  [' + (p.kind === 'путь' ? 'мусор/личные данные' : 'СЕКРЕТ') + '] ' + p.path
            + ' — ' + p.what + '  (' + p.range + ')');
    }
    console.error('');
    console.error('  Что делать: убрать файл из индекса, оставив на диске —');
    console.error('      git restore --staged <файл>   (файл ещё не в истории)');
    console.error('      git rm --cached <файл>        (файл уже отслеживается)');
    console.error('    и дописать правило в .gitignore, чтобы не вернулся.');
    console.error('  Если это ложное срабатывание — обойти на один раз: --no-verify');
    console.error('');
    return 1;
}

process.exit(main());
