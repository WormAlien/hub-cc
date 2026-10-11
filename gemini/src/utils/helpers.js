import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from '../config.js';
import { proxyForToken, dispatcherFor } from './account-proxy.js';

/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Get the package version from package.json
 * @param {string} [defaultVersion='1.0.0'] - Default version if package.json cannot be read
 * @returns {string} The package version
 */
export function getPackageVersion(defaultVersion = '1.0.0') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const packageJsonPath = path.join(__dirname, '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || defaultVersion;
    } catch {
        return defaultVersion;
    }
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}


/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is a network error (transient)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a network error
 */
export function isNetworkError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes('fetch failed') ||
        msg.includes('network error') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('socket hang up') ||
        msg.includes('timeout')
    );
}

/**
 * Токен из заголовков запроса (Authorization: Bearer … или x-api-key).
 *
 * @param {Object|undefined} headers
 * @returns {string|null}
 */
function bearerToken(headers) {
    if (!headers) return null;
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== 'authorization') continue;
        const v = String(value || '').trim();
        return v.toLowerCase().startsWith('bearer ') ? v.slice(7).trim() : v || null;
    }
    return null;
}

/**
 * Подставить прокси аккаунта в запрос. Прокси ищется по access-token: токен
 * уникален на аккаунт и уже есть в каждом запросе к Google, поэтому привязка
 * «аккаунт → прокси» работает во всех местах вызова без правок в каждом из них.
 *
 * @param {RequestInit|undefined} options
 * @returns {Promise<RequestInit|undefined>} options с dispatcher, если у аккаунта есть прокси
 */
async function withAccountProxy(options) {
    if (!options || options.dispatcher) return options;
    const proxy = proxyForToken(bearerToken(options.headers));
    if (!proxy) return options;
    return { ...options, dispatcher: await dispatcherFor(proxy) };
}

/**
 * Throttled fetch that applies a configurable delay before each request
 * Only applies delay when requestThrottlingEnabled is true
 * @param {string|URL} url - The URL to fetch
 * @param {RequestInit} [options] - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
export async function throttledFetch(url, options) {
    if (config.requestThrottlingEnabled) {
        const delayMs = config.requestDelayMs || 200;
        if (delayMs > 0) {
            await sleep(delayMs);
        }
    }
    return fetch(url, await withAccountProxy(options));
}

/**
 * Generate random jitter for backoff timing (Thundering Herd Prevention)
 * Prevents all clients from retrying at the exact same moment after errors.
 * @param {number} maxJitterMs - Maximum jitter range (result will be ±maxJitterMs/2)
 * @returns {number} Random jitter value between -maxJitterMs/2 and +maxJitterMs/2
 */
export function generateJitter(maxJitterMs) {
    return Math.random() * maxJitterMs - (maxJitterMs / 2);
}
