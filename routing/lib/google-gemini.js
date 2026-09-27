'use strict';

// routing/lib/google-gemini.js
//
// Gemini CLI (`gemini`) на пул аккаунтов: каталог профиля на аккаунт, лончер, прогон промпта.
//
// 🟢 Здесь всё проще, чем у `agy`, и это главное отличие. У Gemini CLI вход ФАЙЛОВЫЙ: настройки,
// `oauth_creds.json` и `google_accounts.json` лежат в `<дом>/.gemini/`. Значит достаточно
// подменить дом (`USERPROFILE` и `HOME`) - и каждый аккаунт получает свой каталог, свой вход и
// свою историю. Никакого общего хранилища, никакой подмены записи, и главное - **панели можно
// запускать параллельно**: у каждого процесса свой вход. У `agy` так не выйдет (см. google-agy.js).
//
// 🪤 `GEMINI_DIR` - это НЕ переменная окружения, а имя папки (`.gemini`) внутри кода CLI. Я
// сначала принял её за рычаг по числу вхождений в бандле (117) - и ошибся; проверка показала,
// что настраивается не она, а дом. Урок общий: счётчик вхождений строки не доказывает, что это
// переменная окружения.
//
// 🪤 `GEMINI_FORCE_FILE_STORAGE=true` ставим всегда. По умолчанию CLI пробует системную ключницу
// (`@github/keytar`), и если она однажды появится в зависимостях, вход уедет в хранилище Windows -
// то есть обратно в общее на пользователя место. С флагом он этого не делает никогда.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const pool = require('./google-pool');

const DIR = path.join(pool.DIR, 'gemini');
// npm ставит лончеры в %APPDATA%\npm. Переменная нужна стенду и регрессу.
const EXE = process.env.GEMINI_EXE
    || path.join(process.env.APPDATA || '', 'npm', 'gemini.cmd');
// 🪤 Запускаем НЕ через лончер. `gemini` - это .cmd, а на Windows .cmd идёт через `shell: true`,
// где аргументы склеиваются в одну строку: промпт с кавычками или `&&` поехал бы как команда.
// Поэтому берём JS-вход пакета и зовём его node'ом: argv остаётся argv.
const PKG_ENTRY = process.env.GEMINI_ENTRY
    || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');

const homeDir = id => path.join(DIR, `acct_${id}`, 'home');
const launcherFile = id => path.join(DIR, `acct_${id}`, 'gemini.cmd');
const BIN_DIR = path.join(pool.DIR, 'bin');
// Короткая обёртка для панели Orca: `orca account` знает только Claude и Codex, поэтому
// аккаунт для панели подставляется командой. Имя короткое, чтобы его печатать руками.
const wrapperFile = (rec) => path.join(BIN_DIR, `gemini-${pool.slug(rec)}.cmd`);
const wrapperCommand = (rec) => wrapperFile(rec);
const credsFile = id => path.join(homeDir(id), '.gemini', 'oauth_creds.json');
const accountsFile = id => path.join(homeDir(id), '.gemini', 'google_accounts.json');

const installed = () => fs.existsSync(EXE);

function ensureHome(id) {
    const dir = homeDir(id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Вход этого аккаунта: есть ли файл кредов и, если получится, чей он. */
function state(id) {
    const home = homeDir(id);
    const hasCreds = fs.existsSync(credsFile(id));
    let email = null;
    try {
        // `google_accounts.json` держит список входов аккаунта: `{active, old:[...]}`.
        const doc = JSON.parse(fs.readFileSync(accountsFile(id), 'utf8'));
        email = doc && doc.active ? String(doc.active) : null;
    } catch { /* файла нет или он ещё не дописан - это не ошибка */ }
    let at = null;
    try { at = hasCreds ? fs.statSync(credsFile(id)).mtime.toISOString() : null; } catch { /* без даты */ }
    return { id, home, hasCreds, email: email || (hasCreds ? '(почта ещё не читается)' : null), at };
}

/** Состояние всех аккаунтов пула, у которых заведён каталог Gemini CLI. */
function states() {
    const out = [];
    for (const e of pool.load()) {
        if (!fs.existsSync(homeDir(e.id))) continue;
        const s = state(e.id);
        s.accountEmail = e.email;
        // Команда для панели Orca: обёртку пишем сразу, чтобы её можно было вставить, не
        // заходя никуда ещё.
        try { s.orcaCommand = wrapper(e); } catch { s.orcaCommand = null; }
        out.push(s);
    }
    return out;
}

/** Лончер аккаунта: окно с подменённым домом, в нём человек и входит. */
function launcher(id) {
    const file = launcherFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const home = ensureHome(id);
    const lines = [
        '@echo off',
        'REM Gemini CLI under this account\'s home. Written by routing/lib/google-gemini.js.',
        'REM ASCII only: cmd.exe prints cp866, Cyrillic here would come out as garbage.',
        `set "USERPROFILE=${home}"`,
        `set "HOME=${home}"`,
        'REM Keep the login in a file, never in the OS keychain: the keychain is one per user.',
        'set "GEMINI_FORCE_FILE_STORAGE=true"',
        'echo Gemini CLI, account profile. Sign in below.',
        `"${EXE}"`,
        'pause',
    ];
    fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
    return file;
}

/**
 * Обёртка для панели: ставит дом и флаг файлового входа, дальше передаёт аргументы CLI.
 * 🪤 Без `pause` (в отличие от лончера): она запускается из панели, а не двойным щелчком, и
 * ждать нажатия клавиши там некому. Аргументы идут через `%*`, поэтому `--yolo` из панели
 * доезжает до CLI.
 */
function wrapper(rec) {
    ensureHome(rec.id);
    const file = wrapperFile(rec);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const home = homeDir(rec.id);
    const lines = [
        '@echo off',
        `REM Gemini CLI as ${pool.slug(rec)}. Written by routing/lib/google-gemini.js.`,
        `set "USERPROFILE=${home}"`,
        `set "HOME=${home}"`,
        'set "GEMINI_FORCE_FILE_STORAGE=true"',
        `"${process.execPath}" "${PKG_ENTRY}" %*`,
    ];
    fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
    return file;
}

/** Прогон одного промпта без интерактива. */
function run(id, prompt, { model = null, timeoutMs = 180000, extraArgs = [] } = {}) {
    return new Promise((resolve) => {
        if (!installed()) return resolve({ ok: false, error: `нет ${EXE}` });
        if (!fs.existsSync(PKG_ENTRY)) return resolve({ ok: false, error: `нет JS-входа пакета: ${PKG_ENTRY}` });
        const started = Date.now();
        const args = [PKG_ENTRY, '-p', prompt, '--skip-trust', ...extraArgs];
        if (model) args.push('-m', model);
        const proc = spawn(process.execPath, args, {
            windowsHide: true,
            env: {
                ...process.env,
                USERPROFILE: ensureHome(id),
                HOME: ensureHome(id),
                GEMINI_FORCE_FILE_STORAGE: 'true',
            },
        });
        let out = '', err = '';
        const timer = setTimeout(() => { try { proc.kill(); } catch { /* уже мёртв */ } }, timeoutMs);
        proc.stdout.on('data', d => { out += d; });
        proc.stderr.on('data', d => { err += d; });
        proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
        proc.on('exit', code => {
            clearTimeout(timer);
            resolve({ ok: code === 0, code, output: out, error: err.trim(), ms: Date.now() - started });
        });
    });
}

module.exports = {
    DIR, EXE, PKG_ENTRY, BIN_DIR, launcherFile, homeDir, credsFile, accountsFile,
    installed, ensureHome, launcher, wrapper, wrapperFile, wrapperCommand, state, states, run,
};
