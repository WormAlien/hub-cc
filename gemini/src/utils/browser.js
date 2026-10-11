/**
 * Chrome Launcher
 *
 * Окно входа в Google открывается НЕ системным браузером, а Chrome с двумя
 * параметрами: `--proxy-server` (чтобы вход вышел тем же IP, что и запросы
 * аккаунта — смена IP между входом и работой выглядит как угон сессии) и
 * `--user-data-dir` (свой профиль на аккаунт: своя история, куки и «железо» с
 * точки зрения Google).
 *
 * Профиль выводится из адреса прокси и номера аккаунта на нём — не хранится
 * отдельным полем: одно и то же правило даёт один и тот же каталог при повторном
 * входе (кнопка «починить») и разные каталоги для разных аккаунтов.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { logger } from './logger.js';

const PROFILE_ROOT = path.join(os.homedir(), '.config', 'antigravity-proxy', 'browser-profiles');

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
].filter(Boolean);

let chromePath;

/** Путь к Chrome или null, если его на машине нет. */
export function findChrome() {
    if (chromePath !== undefined) return chromePath;
    chromePath = CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
    if (!chromePath) logger.warn('[Browser] Chrome не найден — окно входа откроется браузером по умолчанию, без прокси');
    return chromePath;
}

/**
 * Каталог профиля для аккаунта: адрес прокси + его номер среди аккаунтов с тем же
 * прокси. При 1:1 пуле (штатный случай) номер всегда 0.
 *
 * @param {string|null} proxyRaw
 * @param {Array<{email?: string, proxy?: string}>} accounts
 * @param {string|null} email - известен при повторном входе (кнопка «починить»)
 * @returns {string|null}
 */
export function profileDirFor(proxyRaw, accounts = [], email = null) {
    if (!proxyRaw) return null;
    const sameProxy = accounts.filter(a => a?.proxy === proxyRaw);
    const index = email ? Math.max(0, sameProxy.findIndex(a => a.email === email)) : sameProxy.length;
    const slug = proxyRaw.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/[^a-zA-Z0-9.-]+/g, '_');
    return path.join(PROFILE_ROOT, index === 0 ? slug : `${slug}-${index + 1}`);
}

/**
 * Открыть URL в Chrome. Возвращает false, если Chrome не найден — вызывающий код
 * тогда откатывается на браузер по умолчанию.
 *
 * @param {string} url
 * @param {{proxyUrl?: string|null, userDataDir?: string|null}} [opts]
 * @returns {boolean}
 */
export function openInChrome(url, { proxyUrl = null, userDataDir = null } = {}) {
    const chrome = findChrome();
    if (!chrome) return false;

    const args = ['--no-first-run', '--no-default-browser-check'];
    if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);
    if (userDataDir) {
        fs.mkdirSync(userDataDir, { recursive: true });
        args.push(`--user-data-dir=${userDataDir}`);
    }
    args.push('--new-window', url);

    try {
        const child = spawn(chrome, args, { stdio: 'ignore', detached: true });
        child.unref();
        logger.info(`[Browser] Chrome: вход через ${proxyUrl || 'прямое соединение'}${userDataDir ? `, профиль ${path.basename(userDataDir)}` : ''}`);
        return true;
    } catch (e) {
        logger.warn(`[Browser] Chrome не запустился: ${e.message}`);
        return false;
    }
}
