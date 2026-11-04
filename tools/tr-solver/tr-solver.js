#!/usr/bin/env node
'use strict';

/**
 * tr-solver.js - CLI-адаптер над портированным решателем капчи ThreeRouter.
 *
 * Источник: F0Rextasy/threerouter-bulk-apikey (MIT, 2026), файл src/solver.js
 * сохранён здесь как upstream-solver.js без изменений логики. Этот адаптер
 * - единственное новое: он превращает solveCaptcha в одноразовый CLI,
 * который зовёт Python-авторега (smailpro/auto-add.py).
 *
 * Контракт (одна строка JSON в stdout, всё прочее - stderr):
 *   успех:  {"ok":true,"mode":"slider|image_click","token":"...","ms":1234}
 *   отказ:  {"ok":false,"error":"..."}
 *
 * Режимы:
 *   --exit <line>   прокси-строка (socks5://host:port | http://user:pass@host:port).
 *                   Обязателен: напрямую не ходим - у панели лимит «1 регистрация
 *                   на IP в сутки», и токен капчи привязан к exit, который её решал.
 *   --verify <file> не решать капчу, а перепроверить ключи: файл со строками sk-…
 *                   (или JSON-пулом routing/threerouter-sessions.json - берутся
 *                   живые записи с api_key). Живой ключ = короткий чат 200 с контентом.
 *                   Печатает {"ok":true,"live":N,"dead":M,"results":[...]}.
 *
 * Выход: 0 = ok, 1 = отказ. Ключи никогда не печатаются целиком - только маска.
 */

const fs = require('fs');
const path = require('path');
const upstream = require(path.join(__dirname, 'upstream-solver.js'));

// Скраперные socks5 бывают медленные: дефолт 60 с на запрос не хватает на
// challenge+solve+verify через чужой exit (живой случай 04.11: proxy timeout
// на 25-секундных запросах). Поднимаем потолок; UI-опыта у CLI нет, задержка
// безвредна - авторега всё равно держит окно открытым.
upstream.setDefaultTimeout(Number(process.env.TR_SOLVER_TIMEOUT_MS || 90000));

const CHAT_URL = 'https://api.threerouter.com/v1/chat/completions';
const VERIFY_MODEL = process.env.TR_VERIFY_MODEL || 'minimax-m3';

function arg(name) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function maskKey(k) {
    const s = String(k || '');
    return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '***';
}

function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

async function solve() {
    const exitLine = arg('exit');
    if (!exitLine) {
        return emit({ ok: false, error: 'no --exit: напрямую не ходим (лимит 1 IP/сутки, токен привязан к exit)' });
    }
    const tries = Number(process.env.TR_CAPTCHA_TRIES || 6);
    const res = await upstream.solveCaptcha({
        type: 'auto',
        proxy: exitLine,
        tries,
        log: (m) => process.stderr.write(`[solver] ${m}\n`),
    });
    // solveCaptcha resolves with { token, ms, mode } or throws
    emit({ ok: true, token: res.token, mode: res.mode || '', ms: res.ms || 0 });
}

/** Ключи из JSON-пула (routing/threerouter-sessions.json) или текстового файла. */
function readKeys(file) {
    const raw = fs.readFileSync(path.resolve(file), 'utf8');
    if (raw.trim().startsWith('[')) {
        const rows = JSON.parse(raw);
        return rows
            .filter((r) => r && r.api_key && String(r.api_key).trim() && r.status !== 'dead')
            .map((r) => String(r.api_key).trim());
    }
    return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('sk-'));
}

async function verify() {
    const keysFile = arg('verify');
    const exitLine = arg('exit');
    const keys = readKeys(keysFile);
    // Пул бывает весь dead (как 31.10) - это не ошибка CLI, а честный ответ:
    // {"ok":true,"live":0,"dead":N}. Содержательный смысл отдаёт статус-поле.
    if (!keys.length) {
        emit({ ok: true, live: 0, dead: 0, total: 0, results: [], note: `нет живых ключей в ${keysFile}` });
        return;
    }
    const exit = exitLine ? upstream.parseProxy(exitLine) : null;
    if (exitLine && !exit) return emit({ ok: false, error: `прокси не разобран: ${exitLine.slice(0, 40)}` });
    const results = [];
    for (const k of keys) {
        try {
            const r = await upstream.exitJson(exit, CHAT_URL, {
                method: 'POST',
                headers: { authorization: `Bearer ${k}` },
                body: { model: VERIFY_MODEL, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 32, stream: false },
                timeoutMs: 30000,
            });
            const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
            const content = msg && ((msg.content || '').trim() || (msg.reasoning_content || '').trim());
            results.push({ key_masked: maskKey(k), ok: r.status === 200 && Boolean(content), status: r.status });
        } catch (e) {
            // транспорт - не приговор ключу (прокси мог умереть): помечаем отдельно
            results.push({ key_masked: maskKey(k), ok: false, status: 0, transport: String(e.message).slice(0, 80) });
        }
    }
    const live = results.filter((r) => r.ok).length;
    emit({ ok: true, live, dead: results.length - live, total: results.length, results });
}

(async () => {
    try {
        if (arg('verify')) {
            await verify();
        } else {
            await solve();
        }
        process.exit(0);
    } catch (e) {
        emit({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
        process.exit(1);
    }
})();
