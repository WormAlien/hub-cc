'use strict';

// routing/lib/google-agy.js
//
// Antigravity CLI (`agy`) на пул аккаунтов: слепок входа на аккаунт, каталог профиля на
// аккаунт и переключение между ними.
//
// 🔴 Зачем это вообще нужно. `agy` держит вход в хранилище учётных данных Windows ОДНОЙ
// записью с фиксированным именем (`gemini:antigravity`), на пользователя системы. Ни
// `--profile`, ни `--auth-store`, ни `--data-dir`, ни переменной окружения для переноса у
// него нет - апстрим-issues #155 и #381 открыты. То есть «каталог на аккаунт» сам по себе
// не даёт второго аккаунта: `USERPROFILE` изолирует настройки, историю и разговоры (это
// проверено живьём 27.09), а вход остаётся общим. Поэтому запись сохраняется к себе и
// подкладывается обратно перед запуском нужного аккаунта.
//
// 🪤 Отсюда и главное ограничение модели: переключение МАШИННОЕ. Два `agy` на двух аккаунтах
// одновременно не поднять - кто записал последним, у того и сессия. Пул здесь последовательный.
//
// 🪤 Запись - это ЖИВОЙ OAuth-токен (JSON с `refresh_token` и `id_token`). Хранится в
// `google/agy/acct_<id>.cred` в base64, каталог закрыт `.gitignore`, наружу (в список
// вкладки, в лог, в ответ ручки) значение не отдаётся никогда - только почта из `id_token`.
//
// Чтение и запись самой записи идёт через `tools/agy-cred.ps1` (PowerShell + advapi32).
// Для регресса доступ подменяется: `setVault({ read, write })`.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const durable = require('./durable-write');
const pool = require('./google-pool');

const DIR = path.join(pool.DIR, 'agy');
const PS1 = path.join(__dirname, '..', '..', 'tools', 'agy-cred.ps1');
const TARGET = 'gemini:antigravity';
// Путь к бинарю: у установщика он в LOCALAPPDATA\agy\bin, переменная нужна стенду и регрессу.
const EXE = process.env.AGY_EXE || path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');

const credFile = id => path.join(DIR, `acct_${id}.cred`);
const homeDir = id => path.join(DIR, `acct_${id}`, 'home');
const launcherFile = id => path.join(DIR, `acct_${id}`, 'agy.cmd');

// ── Доступ к хранилищу ───────────────────────────────────────────────────────
// По умолчанию - PowerShell-помощник. Регресс подменяет на память: настоящая запись
// принадлежит системе, и трогать её пробой нельзя.

function psRun(args) {
    return new Promise((resolve, reject) => {
        const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
            { windowsHide: true });
        let out = '', err = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { err += d; });
        p.on('error', reject);
        p.on('exit', code => code === 0 ? resolve(out) : reject(new Error(err.trim() || `agy-cred.ps1 вышел с кодом ${code}`)));
    });
}

const fsVault = {
    /** Прочитать запись. Возвращает Buffer или null, если записи нет. */
    async read() {
        const tmp = path.join(DIR, `_read-${process.pid}.bin`);
        fs.mkdirSync(DIR, { recursive: true });
        try {
            await psRun(['-Action', 'save', '-Target', TARGET, '-Path', tmp]);
            return fs.readFileSync(tmp);
        } catch (e) {
            if (/win32 1168/.test(e.message)) return null;   // 1168 = ERROR_NOT_FOUND
            throw e;
        } finally {
            try { fs.unlinkSync(tmp); } catch { /* уже нет */ }
        }
    },
    /** Записать запись целиком (байты). */
    async write(buf) {
        const tmp = path.join(DIR, `_write-${process.pid}.bin`);
        fs.mkdirSync(DIR, { recursive: true });
        try {
            fs.writeFileSync(tmp, buf);
            await psRun(['-Action', 'load', '-Target', TARGET, '-Path', tmp]);
        } finally {
            try { fs.unlinkSync(tmp); } catch { /* уже нет */ }
        }
    },
};

let vault = fsVault;
function setVault(v) { vault = { read: v.read, write: v.write }; }

// ── Разбор записи ────────────────────────────────────────────────────────────
// Наружу из записи выходит ТОЛЬКО почта (из `id_token`) и признак, что она вообще разобралась:
// сам токен не отдаётся ни в ответ ручки, ни в лог.

function blobEmail(buf) {
    try {
        const doc = JSON.parse(buf.toString('utf8'));
        const payload = String(doc.id_token || '').split('.')[1];
        if (!payload) return null;
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return claims.email || null;
    } catch { return null; }
}

const sameBlob = (a, b) => !!a && !!b && a.length === b.length && a.equals(b);

// ── Состояние ────────────────────────────────────────────────────────────────

/** Кто сейчас в хранилище. `{ email, id }`, где id - запись пула, если она сошлась по почте. */
async function current() {
    let buf = null;
    try { buf = await vault.read(); }
    catch (e) { return { error: e.message }; }
    if (!buf) return { email: null, id: null };
    const email = blobEmail(buf);
    const rec = email ? pool.load().find(a => String(a.email || '').toLowerCase() === email.toLowerCase()) : null;
    return { email, id: rec ? rec.id : null };
}

/** Аккаунты пула, у которых сохранён вход. */
function saved() {
    const out = [];
    for (const e of pool.load()) {
        const f = credFile(e.id);
        if (!fs.existsSync(f)) continue;
        let at = null;
        try { at = fs.statSync(f).mtime.toISOString(); } catch { /* без даты */ }
        out.push({ id: e.id, email: e.email, savedAt: at });
    }
    return out;
}

/** Сохранить текущий вход как вход этого аккаунта. */
async function capture(id) {
    const rec = pool.load().find(a => String(a.id) === String(id));
    if (!rec) return { ok: false, error: 'аккаунт не найден в пуле' };
    let buf = null;
    try { buf = await vault.read(); }
    catch (e) { return { ok: false, error: `хранилище не читается: ${e.message}` }; }
    if (!buf) return { ok: false, error: `в хранилище нет записи ${TARGET}: сначала войди в agy` };
    const email = blobEmail(buf);
    if (!email) return { ok: false, error: 'запись не разобралась как вход agy (нет id_token)' };
    if (email.toLowerCase() !== String(rec.email || '').toLowerCase()) {
        // 🪤 Разные адреса - это НЕ повод молча записать: сохранённый вход достался бы не
        // той карточке, и «переключиться» на аккаунт оказалось бы невозможно.
        return { ok: false, error: `в agy сейчас ${email}, а у карточки ${rec.email}: войди в agy этим аккаунтом` };
    }
    fs.mkdirSync(DIR, { recursive: true });
    durable.writeTextSync(credFile(id), buf.toString('base64') + '\n');
    return { ok: true, email, bytes: buf.length };
}

/** Убрать сохранённый вход аккаунта (сам вход в хранилище не трогаем). */
function forget(id) {
    try { fs.rmSync(credFile(id), { force: true }); } catch { /* уже нет */ }
    return { ok: true };
}

/** Переключить `agy` на этот аккаунт. */
async function switchTo(id) {
    const f = credFile(id);
    if (!fs.existsSync(f)) return { ok: false, error: 'у аккаунта нет сохранённого входа' };
    const buf = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
    if (!buf.length) return { ok: false, error: 'сохранённый вход пуст' };
    const email = blobEmail(buf);
    try { await vault.write(buf); }
    catch (e) { return { ok: false, error: `хранилище не записалось: ${e.message}` }; }
    return { ok: true, email };
}

// ── Запуск ───────────────────────────────────────────────────────────────────

const installed = () => fs.existsSync(EXE);

/** Каталог профиля аккаунта: сюда `agy` положит настройки, историю и разговоры. */
function ensureHome(id) {
    const dir = homeDir(id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Лончер: консольное окно с подменённым профилем - им вход и делается. */
function launcher(id) {
    const file = launcherFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const home = ensureHome(id);
    const lines = [
        '@echo off',
        'REM agy under this account\'s profile. Written by routing/lib/google-agy.js.',
        'REM ASCII only: cmd.exe prints cp866, so Cyrillic here would come out as garbage.',
        `set "USERPROFILE=${home}"`,
        `set "HOME=${home}"`,
        'echo Antigravity CLI, account profile. Sign in below.',
        `"${EXE}"`,
        'pause',
    ];
    fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
    return file;
}

/**
 * Прогон промпта без интерактива - то же, что делает человек руками.
 * Возвращает `{ ok, output, code, ms, switched }`.
 */
function run(id, args = [], { timeoutMs = 180000, env = {} } = {}) {
    return new Promise(async (resolve) => {
        if (!installed()) return resolve({ ok: false, error: `нет ${EXE}` });
        const started = Date.now();
        const proc = spawn(EXE, args, {
            windowsHide: true,
            env: {
                ...process.env,
                // 🪤 Профиль подменяем ДО запуска: иначе настройки, история и разговоры
                // уедут в общий `~/.gemini/antigravity-cli` и смешаются между аккаунтами.
                USERPROFILE: ensureHome(id),
                HOME: ensureHome(id),
                ...env,
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
    DIR, EXE, TARGET, PS1,
    credFile, homeDir, launcherFile,
    installed, ensureHome, launcher,
    current, saved, capture, forget, switchTo, run,
    blobEmail, setVault,
};
