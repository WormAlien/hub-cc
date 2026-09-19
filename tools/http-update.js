#!/usr/bin/env node
/*
 * http-update.js — обновление кода БЕЗ git.
 *
 * Зачем: у друга не установлен git (а значит и git-bash — он приезжает вместе с
 * Git for Windows). Обычный путь обновления (`tools/git-pull-safe.js` → `git pull`,
 * потом `install.sh` через git-bash) на такой машине мёртв целиком. Здесь второй,
 * самодостаточный путь: скачать снимок master с GitHub архивом и наложить поверх.
 *
 * Репозиторий `WormAlien/hub-cc` ПУБЛИЧНЫЙ — codeload отдаёт tar.gz без токена,
 * поэтому авторизации не нужно (проверено 19.09).
 *
 * Что переживает обновление: файлы состояния (тир-карты, front-door и пр.) — их
 * список и предикат общий с git-путём (`isStateFile` из git-pull-safe.js), чтобы
 * никогда не разъехаться. Лишние локальные файлы НЕ удаляем: архив их не содержит,
 * а значит upstream-удаления при git-free пути не распространяются — это осознанная
 * плата за отсутствие git, а не дефект.
 *
 * Версию помним сами в `.hub-version.json` (git HEAD'а нет): sha последнего
 * наложенного коммита. По ней «было/стало» и короткое замыкание «уже актуально».
 *
 * Использование:
 *   node tools/http-update.js            # CLI, скачать и наложить
 *   require('../tools/http-update')      # хаб (doHttpUpdate)
 *
 * Коды выхода CLI: 0 — обновлено или уже актуально, 1 — ошибка (нет сети и т.п.).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const fetch = require('node-fetch');
const tar = require('tar-fs');

const { isStateFile } = require('./git-pull-safe');

const REPO = path.resolve(__dirname, '..');
const OWNER = 'WormAlien';
const NAME = 'hub-cc';
const BRANCH = 'master';
const VERSION_FILE = path.join(REPO, '.hub-version.json');

const CODELOAD = `https://codeload.github.com/${OWNER}/${NAME}/tar.gz/refs/heads/${BRANCH}`;
const COMMITS_API = `https://api.github.com/repos/${OWNER}/${NAME}/commits/${BRANCH}`;

// sha последнего коммита на GitHub. Нужен для «уже актуально» и «было→стало».
// Не смогли узнать (нет сети / rate-limit) → null, тогда просто не коротим и
// пишем в версию '(unknown)'. GitHub API без User-Agent отвечает 403.
async function remoteSha() {
    try {
        const res = await fetch(COMMITS_API, {
            headers: {
                'User-Agent': `${NAME}-http-updater`,
                'Accept': 'application/vnd.github+json',
            },
            timeout: 20000,
        });
        if (!res.ok) return null;
        const json = await res.json();
        return (json && json.sha) ? String(json.sha) : null;
    } catch {
        return null;
    }
}

// Наша запись о версии. Формат: { sha, branch, method, fetchedAt }.
function localVersion() {
    try {
        return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function writeVersion(sha) {
    const rec = {
        sha: sha || '(unknown)',
        branch: BRANCH,
        method: 'http',
        fetchedAt: new Date().toISOString(),
    };
    fs.writeFileSync(VERSION_FILE, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    return rec;
}

// Скачать tar.gz во временный файл.
async function download(dest) {
    const res = await fetch(CODELOAD, {
        headers: { 'User-Agent': `${NAME}-http-updater` },
        timeout: 60000,
    });
    if (!res.ok) throw new Error(`GitHub вернул ${res.status} на скачивании архива`);
    await pipeline(res.body, fs.createWriteStream(dest));
}

// Распаковать: gunzip → tar-fs. У архива GitHub верхняя папка `hub-cc-<sha>/`,
// снимаем её `strip: 1`, чтобы `hub.js` лёг в корень outDir, а не на уровень глубже.
async function extract(tarPath, outDir) {
    await pipeline(
        fs.createReadStream(tarPath),
        zlib.createGunzip(),
        tar.extract(outDir, { strip: 1 }),
    );
}

// Наложить распакованное дерево поверх REPO. State-файлы, которые уже есть на
// диске, НЕ трогаем — их единственный писатель дашборд. cpSync с фильтром: false
// = пропустить (файл/папку не копировать), force:true = перезаписать код.
function apply(srcRoot, target = REPO) {
    let copied = 0, preserved = 0;
    fs.cpSync(srcRoot, target, {
        recursive: true,
        force: true,
        filter: (src) => {
            const rel = path.relative(srcRoot, src).split(path.sep).join('/');
            if (!rel) return true;                      // корень
            const dest = path.join(target, rel);
            if (isStateFile(rel) && fs.existsSync(dest)) { preserved++; return false; }
            try { if (fs.statSync(src).isFile()) copied++; } catch {}
            return true;
        },
    });
    return { copied, preserved };
}

// Возвращает { ok, already, from, to, copied, preserved, error }.
async function applyUpdate() {
    const from = (localVersion() || {}).sha || null;
    const to = await remoteSha();

    if (to && from && from === to) {
        return { ok: true, already: true, from, to };
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-http-update-'));
    const tarPath = path.join(tmp, 'src.tar.gz');
    const outDir = path.join(tmp, 'src');
    try {
        await download(tarPath);
        fs.mkdirSync(outDir, { recursive: true });
        await extract(tarPath, outDir);
        const { copied, preserved } = apply(outDir);
        const rec = writeVersion(to);
        return { ok: true, already: false, from, to: rec.sha, copied, preserved };
    } catch (e) {
        return { ok: false, from, to, error: (e && e.message) || String(e) };
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
}

module.exports = { REPO, BRANCH, VERSION_FILE, remoteSha, localVersion, writeVersion, download, extract, apply, applyUpdate };

if (require.main === module) {
    applyUpdate().then(r => {
        if (r.ok && r.already) {
            console.log(`уже актуально (${(r.to || '').slice(0, 7)})`);
            process.exit(0);
        }
        if (r.ok) {
            console.log(`обновлено: ${(r.from || '?').slice(0, 7)} → ${(r.to || '?').slice(0, 7)}`);
            console.log(`  файлов наложено: ${r.copied}, настроек сохранено: ${r.preserved}`);
            console.log('  зависимости: npm install  (потом перезапусти хаб)');
            process.exit(0);
        }
        console.error(`не удалось: ${r.error || '?'}`);
        console.error('  нужен интернет и доступ к github.com/codeload.github.com');
        process.exit(1);
    }).catch(e => {
        console.error('не удалось:', e && e.stack ? e.stack : e);
        process.exit(1);
    });
}
