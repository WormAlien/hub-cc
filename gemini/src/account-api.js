/**
 * account-api.js — HTTP-часть управления аккаунтами для вкладки Gemini в хабе.
 *
 * Заменяет собой `src/webui/**` из апстрима: веб-морду форка удалили (её роль играет
 * вкладка в дашборде хаба), а ручки, которые были нужны, перенесены сюда. Что именно
 * перенесено и что выброшено — в `VENDOR.md` рядом с package.json.
 *
 * 🪤 Чего здесь СОЗНАТЕЛЬНО нет:
 *   • ручек, которые пишут в `~/.claude/settings.json` (claude-config, server-presets) —
 *     этим файлом владеет дашборд хаба, второй хозяин означал бы драку за один файл;
 *   • `refreshToken` наружу не отдаётся ни в одном ответе: это единственный секрет
 *     аккаунта, и он остаётся внутри сервера;
 *   • пароля на ручки нет — сервер слушает только 127.0.0.1, а снаружи к нему не ходят.
 *
 * 🪤 OAuth тут НЕ открывает браузер. В апстриме `GET /api/auth/url` сам поднимал Chrome со
 * своим профилем и своим прокси; в хабе браузер открывает хаб — в профиле ЭТОГО Google-аккаунта
 * (`google/profiles/acct_<id>/`) и с прокси этого аккаунта. Поэтому ручка возвращает только
 * `{url, state}`, а хаб ведёт окно сам и приносит код в `POST /api/auth/complete`.
 */

import { ACCOUNT_CONFIG_PATH, MAX_ACCOUNTS } from './constants.js';
import { loadAccounts, saveAccounts } from './account-manager/storage.js';
import { getAuthorizationUrl, completeOAuthFlow, startCallbackServer, extractCodeFromInput } from './auth/oauth.js';
import { getSubscriptionTier, getModelQuotas } from './cloudcode/index.js';
import { logger } from './utils/logger.js';

// Незавершённые OAuth-потоки: state → { verifier, abortServer, timestamp }.
// Живут в памяти: сервер переживает перезапуск хаба, но не свою собственную смерть, а
// недоделанный вход в этом случае надо начинать заново.
const pendingOAuthFlows = new Map();
const FLOW_TTL_MS = 10 * 60 * 1000;

function dropStaleFlows() {
    const now = Date.now();
    for (const [key, val] of pendingOAuthFlows) {
        if (now - val.timestamp > FLOW_TTL_MS) {
            try { val.abortServer && val.abortServer(); } catch { /* уже закрыт */ }
            pendingOAuthFlows.delete(key);
        }
    }
}

/** Публичная форма записи аккаунта: без refreshToken. */
function accountView(a) {
    const quota = a.quota && a.quota.models ? a.quota.models : {};
    const models = Object.keys(quota);
    // Самый узкий остаток по моделям: одна цифра, по которой видно «пора отдохнуть».
    let minFraction = null;
    for (const id of models) {
        const f = quota[id] && quota[id].remainingFraction;
        if (typeof f === 'number' && (minFraction === null || f < minFraction)) minFraction = f;
    }
    return {
        email: a.email,
        source: a.source || null,
        enabled: a.enabled !== false,
        isInvalid: !!a.isInvalid,
        invalidReason: a.invalidReason || null,
        addedAt: a.addedAt || null,
        lastUsed: a.lastUsed || null,
        tier: (a.subscription && a.subscription.tier) || null,
        projectId: (a.subscription && a.subscription.projectId) || a.projectId || null,
        quota: {
            models,
            // По каждой модели — свой остаток и своё время сброса: у Gemini окна разные
            // (flash, pro, lite сбрасываются врозь), и одной цифры на аккаунт мало.
            perModel: quota,
            minFraction,
            lastChecked: (a.quota && a.quota.lastChecked) || null,
        },
        rateLimited: Object.entries(a.modelRateLimits || {})
            .filter(([, v]) => v && v.isRateLimited)
            .map(([model, v]) => ({ model, resetTime: v.resetTime || null })),
        hasProxy: !!a.proxy,
    };
}

/** Правит запись аккаунта по email. Бросает, если такого нет. */
async function patchAccount(email, fn) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const i = accounts.findIndex(a => a.email === email);
    if (i === -1) throw new Error(`аккаунт ${email} не найден`);
    fn(accounts[i], accounts, i);
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
}

/** Добавляет или обновляет аккаунт после OAuth. */
async function addAccount(accountData) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const at = accounts.findIndex(a => a.email === accountData.email);
    if (at !== -1) {
        accounts[at] = {
            ...accounts[at],
            ...accountData,
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            addedAt: accounts[at].addedAt || new Date().toISOString(),
        };
        logger.info(`[accounts] аккаунт обновлён: ${accountData.email}`);
    } else {
        if (accounts.length >= MAX_ACCOUNTS) {
            throw new Error(`достигнут предел ${MAX_ACCOUNTS} аккаунтов (maxAccounts в config.json)`);
        }
        accounts.push({
            ...accountData,
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            modelRateLimits: {},
            lastUsed: null,
            addedAt: new Date().toISOString(),
        });
        logger.info(`[accounts] аккаунт добавлен: ${accountData.email}`);
    }
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
}

function json(res, code, body) {
    res.status(code).json(body);
}

/**
 * Ставит ручки аккаунтов и статуса на переданный express-апп.
 * @param {import('express').Express} app
 * @param {object} accountManager — из server.js
 */
export function mountAccountApi(app, accountManager) {
    // ── статус для жизненного цикла хаба ─────────────────────────────────────
    // Хаб спрашивает этот путь, чтобы понять «жив ли сервер» (probeStatus в
    // transparent-proxy.js), и это единственный признак — по нему же работает кнопка
    // «перезапустить» в Health. Отвечаем быстро и без похода в Google.
    const statusHandler = (req, res) => {
        let st = null;
        try { st = accountManager.getStatus(); } catch { /* ещё не поднялся */ }
        const list = (st && Array.isArray(st.accounts)) ? st.accounts : [];
        res.json({
            ok: true,
            name: 'gemini',
            up: true,
            accounts: st ? st.total : null,
            enabled: list.filter(a => a.enabled !== false).length || null,
            available: st && st.available != null ? st.available : null,
            summary: st ? st.summary : null,
        });
    };
    app.get('/status', statusHandler);
    app.get('/__keepalive/api/status', statusHandler);

    // ── аккаунты ─────────────────────────────────────────────────────────────

    app.get('/api/accounts', async (req, res) => {
        try {
            const { accounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            let summary = null;
            try { summary = accountManager.getStatus(); } catch { /* не критично */ }
            json(res, 200, { status: 'ok', accounts: accounts.map(accountView), summary });
        } catch (e) {
            json(res, 500, { status: 'error', error: e.message });
        }
    });

    app.post('/api/accounts/:email/toggle', async (req, res) => {
        try {
            const email = decodeURIComponent(req.params.email);
            const enabled = req.body && req.body.enabled !== undefined ? !!req.body.enabled : undefined;
            if (enabled === undefined) return json(res, 400, { status: 'error', error: 'нужен enabled (true/false)' });
            await patchAccount(email, a => { a.enabled = enabled; });
            await accountManager.reload();
            json(res, 200, { status: 'ok', email, enabled });
        } catch (e) {
            json(res, e.message.includes('не найден') ? 404 : 500, { status: 'error', error: e.message });
        }
    });

    // Снос записи. 🪤 Кэш квоты и подписки уходит вместе с ней: оставленный кэш
    // показал бы в дашборде квоту аккаунта, которого уже нет.
    app.delete('/api/accounts/:email', async (req, res) => {
        try {
            const email = decodeURIComponent(req.params.email);
            const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const i = accounts.findIndex(a => a.email === email);
            if (i === -1) return json(res, 404, { status: 'error', error: `аккаунт ${email} не найден` });
            accounts.splice(i, 1);
            const nextActive = activeIndex >= accounts.length ? Math.max(0, accounts.length - 1) : activeIndex;
            await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, nextActive);
            await accountManager.reload();
            logger.info(`[accounts] аккаунт снят: ${email}`);
            json(res, 200, { status: 'ok', email });
        } catch (e) {
            json(res, 500, { status: 'error', error: e.message });
        }
    });

    /**
     * Перезапрос квоты и тира ПО ОДНОМУ аккаунту.
     *
     * 🪤 Зачем своя ручка, а не готовый `/account-limits?force=true`: тот обновляет ВСЕ
     * аккаунты сразу и параллельно, то есть одна кнопка в дашборде давала бы залп запросов в
     * Google по всему пулу. Здесь обновляется ровно тот аккаунт, на котором человек нажал.
     * Кэш квоты при этом не сбрасывается: без кэша каждое открытие вкладки ходило бы в Google.
     */
    app.post('/api/accounts/:email/refresh', async (req, res) => {
        const email = decodeURIComponent(req.params.email);
        try {
            const account = accountManager.getAllAccounts().find(a => a.email === email);
            if (!account) return json(res, 404, { status: 'error', error: `аккаунт ${email} не найден` });
            accountManager.clearTokenCache(email);
            accountManager.clearProjectCache(email);
            const token = await accountManager.getTokenForAccount(account);
            const sub = await getSubscriptionTier(token);
            const quotas = await getModelQuotas(token, sub.projectId);
            account.subscription = { tier: sub.tier, projectId: sub.projectId, detectedAt: Date.now() };
            account.quota = { models: quotas, lastChecked: Date.now() };
            accountManager.saveToDisk().catch(e => logger.error(`[accounts] квота не сохранилась: ${e.message}`));
            json(res, 200, {
                status: 'ok',
                email,
                tier: account.subscription.tier,
                models: Object.keys(quotas),
                quota: quotas,
            });
        } catch (e) {
            // 403 с «violation of terms of service» — это бан аккаунта, а не сбой запроса.
            if (String(e.message || '').startsWith('ACCOUNT_BANNED:')) {
                try { accountManager.markInvalid(email, 'аккаунт забанен — Gemini отключён за нарушение условий'); } catch { /* не критично */ }
                return json(res, 200, { status: 'banned', email, error: 'аккаунт забанен за нарушение условий Google' });
            }
            json(res, 500, { status: 'error', error: e.message });
        }
    });

    app.post('/api/accounts/reload', async (req, res) => {        try {
            await accountManager.reload();
            json(res, 200, { status: 'ok' });
        } catch (e) {
            json(res, 500, { status: 'error', error: e.message });
        }
    });

    // ── OAuth ────────────────────────────────────────────────────────────────

    /**
     * Начать вход. Возвращает `{url, state}` и поднимает локальный колбэк на 51121 —
     * его адрес прописан в OAuth-клиенте Antigravity, другим он быть не может.
     * Если колбэк не доедет (окно закрыли, порт занят), хаб донесёт код руками в
     * `POST /api/auth/complete` — оба пути ведут к одному и тому же `completeOAuthFlow`.
     */
    app.get('/api/auth/url', async (req, res) => {
        try {
            dropStaleFlows();
            const { url, verifier, state } = getAuthorizationUrl();
            const { promise: serverPromise, abort: abortServer } = startCallbackServer(state, 120000);
            pendingOAuthFlows.set(state, { verifier, abortServer, timestamp: Date.now() });

            serverPromise
                .then(async (code) => {
                    try {
                        const accountData = await completeOAuthFlow(code, verifier, null);
                        await addAccount({ email: accountData.email, refreshToken: accountData.refreshToken, source: 'oauth' });
                        await accountManager.reload();
                        logger.success(`[oauth] аккаунт добавлен по колбэку: ${accountData.email}`);
                    } catch (e) {
                        logger.error(`[oauth] колбэк не доехал до аккаунта: ${e.message}`);
                    } finally {
                        pendingOAuthFlows.delete(state);
                    }
                })
                .catch(e => {
                    if (!String(e.message || '').includes('aborted')) logger.error(`[oauth] колбэк-сервер: ${e.message}`);
                    pendingOAuthFlows.delete(state);
                });

            json(res, 200, { status: 'ok', url, state });
        } catch (e) {
            logger.error(`[oauth] не собрал ссылку входа: ${e.message}`);
            json(res, 500, { status: 'error', error: e.message });
        }
    });

    /** Донести код (или полную ссылку) руками — когда колбэк не сработал. */
    app.post('/api/auth/complete', async (req, res) => {
        try {
            const { callbackInput, state } = req.body || {};
            if (!callbackInput || !state) return json(res, 400, { status: 'error', error: 'нужны callbackInput и state' });
            const flow = pendingOAuthFlows.get(state);
            if (!flow) return json(res, 400, { status: 'error', error: 'поток входа не найден (истёк или уже завершён) — начни заново' });

            const { code } = extractCodeFromInput(callbackInput);
            const accountData = await completeOAuthFlow(code, flow.verifier, null);
            await addAccount({ email: accountData.email, refreshToken: accountData.refreshToken, projectId: accountData.projectId, source: 'oauth' });
            await accountManager.reload();
            try { flow.abortServer && flow.abortServer(); } catch { /* уже закрыт */ }
            pendingOAuthFlows.delete(state);
            logger.success(`[oauth] аккаунт добавлен вручную: ${accountData.email}`);
            json(res, 200, { status: 'ok', email: accountData.email });
        } catch (e) {
            logger.error(`[oauth] ручное завершение: ${e.message}`);
            json(res, 500, { status: 'error', error: e.message });
        }
    });
}

export { accountView, addAccount };
