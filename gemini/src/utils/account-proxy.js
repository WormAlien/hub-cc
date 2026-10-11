/**
 * Account Proxy Pool
 *
 * Пул прокси и привязка «аккаунт → прокси». Смысл привязки — один выходной IP на
 * один Google-аккаунт, и при входе, и при работе: разные IP у входа и у запросов
 * выглядят как угон сессии, а один IP на несколько аккаунтов связывает их между
 * собой. Поэтому привязка липкая: назначается при добавлении аккаунта и больше
 * сама не меняется (сменить — только вручную, командой `acc proxy assign`).
 *
 * Файл пула (рядом с accounts.json, тот же каталог):
 *   { "enabled": true, "list": ["socks5://1.2.3.4:1080", "http://user:pass@5.6.7.8:8080"] }
 *
 * Два потребителя получают ОДИН И ТОТ ЖЕ адрес моста (см. proxy-bridge.js):
 * запросы — через undici-dispatcher, браузер — через `--proxy-server`.
 */

import fs from 'fs';
import path from 'path';
import { ProxyAgent } from 'undici';
import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { bridgeFor, parseProxy } from './proxy-bridge.js';
import { logger } from './logger.js';

// Путь к файлу пула: рядом с accounts.json. Переменная окружения нужна
// самопроверке (tests/test-proxy-pool.mjs), чтобы не трогать боевой файл.
export const PROXY_POOL_PATH = process.env.ANTIGRAVITY_PROXY_POOL
    || path.join(path.dirname(ACCOUNT_CONFIG_PATH), 'proxies.json');

const DISPATCHERS = new Map();   // адрес моста → Promise<ProxyAgent>
const TOKEN_PROXY = new Map();   // access-token → прокси аккаунта

// ── пул ─────────────────────────────────────────────────────────────────────

function readPool() {
    try {
        const pool = JSON.parse(fs.readFileSync(PROXY_POOL_PATH, 'utf8'));
        // Пул по умолчанию ВКЛЮЧЁН: если файла нет или в нём нет флага, добавленные
        // прокси должны работать. Выключение — только явным "enabled": false.
        return { enabled: pool.enabled !== false, list: Array.isArray(pool.list) ? pool.list : [] };
    } catch {
        return { enabled: true, list: [] };
    }
}

function writePool(pool) {
    fs.mkdirSync(path.dirname(PROXY_POOL_PATH), { recursive: true });
    fs.writeFileSync(PROXY_POOL_PATH, JSON.stringify(pool, null, 2), 'utf8');
}

/**
 * Ключ «куда ходим» — хост и порт, без схемы. Один и тот же адрес с разной схемой
 * формально разные прокси, но на практике это всегда описка во вводе, а в пуле
 * оказался бы адрес, который заведомо не заработает: ловим его явно.
 */
function endpointKey(raw) {
    const p = parseProxy(raw);
    return `${p.host.toLowerCase()}:${p.port}`;
}

/** @returns {{enabled: boolean, list: string[]}} */
export function loadProxyPool() {
    return readPool();
}

/** @returns {{enabled: boolean, list: string[]}} */
export function setProxyPoolEnabled(enabled) {
    const pool = readPool();
    pool.enabled = Boolean(enabled);
    writePool(pool);
    return pool;
}

/**
 * Добавить прокси в пул. Строка проверяется разбором — мёртвый прокси в пуле хуже,
 * чем отсутствие прокси: он молча уведёт аккаунт в отказ.
 *
 * @param {string} raw
 * @returns {{added: boolean, error?: string, normalized?: string}}
 */
export function addProxy(raw) {
    let normalized;
    let key;
    try {
        const p = parseProxy(raw);
        normalized = p.raw;
        key = endpointKey(raw);
    } catch (e) {
        return { added: false, error: e.message };
    }
    const pool = readPool();
    const clash = pool.list.find(x => { try { return endpointKey(x) === key; } catch { return false; } });
    if (clash) {
        return {
            added: false,
            normalized,
            error: clash === normalized ? 'такой прокси уже в пуле' : `адрес ${key} уже в пуле как «${clash}»`,
        };
    }
    pool.list.push(normalized);
    writePool(pool);
    return { added: true, normalized };
}

/** @returns {{removed: boolean, list: string[]}} */
export function removeProxy(raw) {
    const pool = readPool();
    let key = null;
    try { key = endpointKey(raw); } catch { /* ниже сравним как есть */ }
    const idx = pool.list.findIndex(x => {
        if (x === raw) return true;
        if (!key) return false;
        try { return endpointKey(x) === key; } catch { return false; }
    });
    if (idx === -1) return { removed: false, list: pool.list };
    pool.list.splice(idx, 1);
    writePool(pool);
    return { removed: true, list: pool.list };
}

/**
 * Выбрать прокси для нового аккаунта: тот, на котором меньше всего аккаунтов.
 * Так при 1:1 пуле каждый аккаунт получает свой адрес, а при нехватке прокси
 * нагрузка растекается ровно, без «все на первом».
 *
 * @param {Array<{proxy?: string}>} accounts - уже существующие аккаунты
 * @returns {string|null}
 */
export function pickProxyFor(accounts = []) {
    const pool = readPool();
    if (!pool.enabled || pool.list.length === 0) return null;

    const used = new Map(pool.list.map(p => [p, 0]));
    for (const acc of accounts) {
        if (acc?.proxy && used.has(acc.proxy)) used.set(acc.proxy, used.get(acc.proxy) + 1);
    }
    return [...used.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

/**
 * Сколько аккаунтов сидит на каждом прокси — для отчёта и для колонки в UI.
 *
 * @param {Array<{email?: string, proxy?: string}>} accounts
 * @returns {{onProxy: Array, withoutProxy: string[], unused: string[]}}
 */
export function assignmentReport(accounts = []) {
    const pool = readPool();
    const byProxy = new Map(pool.list.map(p => [p, []]));
    const withoutProxy = [];
    for (const acc of accounts) {
        const list = byProxy.get(acc?.proxy);
        if (list) list.push(acc.email || '(без email)');
        else withoutProxy.push(acc?.email || '(без email)');
    }
    return {
        onProxy: [...byProxy].map(([proxy, emails]) => ({ proxy, emails })),
        withoutProxy,
        unused: [...byProxy].filter(([, emails]) => emails.length === 0).map(([proxy]) => proxy),
    };
}

// ── реестр «токен → прокси» ─────────────────────────────────────────────────
//
// Ключ — access-token: он уникален на аккаунт и уже приезжает в каждом запросе к
// Google (Authorization: Bearer). Так прокси применяется ко ВСЕМ запросам
// аккаунта — и к стриму, и к квоте, и к онбордингу, — без правок в каждом месте
// вызова. Регистрируется там же, где токен выдаётся (account-manager/credentials.js).

/** @param {string} token @param {string|null|undefined} proxy */
export function registerTokenProxy(token, proxy) {
    if (!token) return;
    if (proxy) TOKEN_PROXY.set(token, proxy);
    else TOKEN_PROXY.delete(token);
}

/** @param {string} token @returns {string|null} */
export function proxyForToken(token) {
    return (token && TOKEN_PROXY.get(token)) || null;
}

// ── мост и dispatcher ───────────────────────────────────────────────────────

/**
 * Dispatcher для запросов через прокси (null — идти напрямую, прокси не назначен).
 *
 * Если прокси назначен, но мост не поднялся — исключение, а не тихий обход:
 * запрос с домашнего IP при назначенном прокси и есть та утечка, ради которой
 * пул и заводился. Отказ виден, аккаунт-менеджер попробует другой аккаунт.
 *
 * @param {string|null|undefined} proxyRaw
 * @returns {Promise<import('undici').Dispatcher|null>}
 * @throws {Error} если прокси назначен, но поднять мост не удалось
 */
export async function dispatcherFor(proxyRaw) {
    if (!proxyRaw) return null;
    let entry = DISPATCHERS.get(proxyRaw);
    if (entry) return entry;

    entry = bridgeFor(proxyRaw)
        .then(bridge => new ProxyAgent(bridge.url))
        .catch((e) => {
            DISPATCHERS.delete(proxyRaw);   // неудача не кэшируется — следующий запрос попробует снова
            throw new Error(`прокси ${proxyRaw} недоступен: ${e.message}`);
        });
    DISPATCHERS.set(proxyRaw, entry);
    return entry;
}

/**
 * Положить dispatcher в опции fetch.
 *
 * 🪤 Ключ появляется ТОЛЬКО когда прокси есть: undici падает ассерцией
 * `assert(dispatcher)`, если ключ присутствует, а значение null. Именно так
 * ломались аккаунты без прокси — им передавался `dispatcher: null`.
 *
 * @param {RequestInit} options
 * @param {import('undici').Dispatcher|null|undefined} dispatcher
 * @returns {RequestInit}
 */
export function withDispatcher(options, dispatcher) {
    return dispatcher ? { ...options, dispatcher } : options;
}

/**
 * Адрес для браузера: Chrome получит `--proxy-server=<этот url>` и выйдет тем же
 * IP, что и запросы аккаунта.
 *
 * @param {string|null|undefined} proxyRaw
 * @returns {Promise<string|null>}
 */
export async function browserProxyFor(proxyRaw) {
    if (!proxyRaw) return null;
    try {
        return (await bridgeFor(proxyRaw)).url;
    } catch (e) {
        logger.warn(`[Proxy] ${proxyRaw}: ${e.message} — окно входа откроется напрямую`);
        return null;
    }
}
