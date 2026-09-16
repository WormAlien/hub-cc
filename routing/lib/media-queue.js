'use strict';
/*
 * media-queue.js — очередь заданий генерации, файлы на диск, история.
 *
 * Зачем очередь на сервере, а не в браузере. Генерация платная и небыстрая: картинка —
 * секунды, видео — минуты. Если работу везёт вкладка, то закрытая вкладка убивает уже
 * оплаченный запрос, а результат теряется молча. Поэтому задание живёт в дашборде, а
 * браузер только спрашивает «что там».
 *
 * 🪤 Ссылки на результат у провайдеров подписанные и протухают. Значит файл надо забирать
 * НА ДИСК сразу, а не хранить URL и надеяться. История без файла — просто запись о том,
 * что деньги потрачены.
 *
 * Запись истории — append-only JSONL и **после каждой** завершённой работы, а не пачкой в
 * конце: падение процесса не должно стоить больше одной работы. Тот же приём, что у
 * проверок здоровья в дашборде.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const catalog = require('./media-catalog');
const dialects = require('./media-dialects');
const mediaKeys = require('./media-keys');

const ROUTING = path.join(__dirname, '..');
// 🪤 Каталоги перекрываются переменными окружения — этим пользуется регресс
// `tools/check-media.js`, который гоняет НАСТОЯЩИЙ код очереди. Без перекрытия его прогон
// оставил бы фантомное задание в живой библиотеке студии и дописал бы его в живую историю.
const OUT_DIR = process.env.MEDIA_OUT_DIR || path.join(ROUTING, 'media-out');
const HISTORY_FILE = process.env.MEDIA_HISTORY_FILE || path.join(ROUTING, 'media-history.jsonl');

const MAX_PARALLEL = 2;              // шлюз общий с рабочими сессиями — не топим его
const REQUEST_TIMEOUT_MS = 180000;   // картинка секунды, видео минуты
const POLL_INTERVAL_MS = 5000;
const POLL_LIMIT = 120;              // 10 минут потолок опроса задания
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

// Задания этого запуска. История переживает рестарт, очередь — нет (см. § restore ниже).
const jobs = new Map();
let running = 0;

// ── Опознание файла по байтам, а не по слову провайдера ──────────────────────
// 🪤 `Content-Type` от чужого сервиса — это его утверждение, а не факт. Раз мы кладём файл
// на диск и потом показываем в браузере, тип определяем по сигнатуре.
const SIGNATURES = [
    { ext: 'png',  mime: 'image/png',  bytes: [0x89, 0x50, 0x4e, 0x47] },
    { ext: 'jpg',  mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
    { ext: 'gif',  mime: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
    { ext: 'webp', mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
    { ext: 'mp4',  mime: 'video/mp4',  at4: [0x66, 0x74, 0x79, 0x70] },
    { ext: 'webm', mime: 'video/webm', bytes: [0x1a, 0x45, 0xdf, 0xa3] },
];
function sniff(buf) {
    for (const s of SIGNATURES) {
        if (s.bytes && !s.bytes.every((b, i) => buf[i] === b)) continue;
        if (s.at4 && !s.at4.every((b, i) => buf[4 + i] === b)) continue;
        if (s.at8 && !s.at8.every((b, i) => buf[8 + i] === b)) continue;
        return { ext: s.ext, mime: s.mime };
    }
    return null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function requestJson(baseUrl, apiKey, spec) {
    return new Promise((resolve, reject) => {
        let target;
        try { target = new URL(String(baseUrl).replace(/\/+$/, '') + spec.path); }
        catch (e) { return reject(new Error(`плохой baseUrl: ${e.message}`)); }

        const payload = spec.body ? Buffer.from(JSON.stringify(spec.body), 'utf8') : null;
        const mod = target.protocol === 'http:' ? http : https;
        const req = mod.request(target, {
            method: spec.method,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            },
            timeout: REQUEST_TIMEOUT_MS,
        }, res => {
            const chunks = [];
            let size = 0;
            res.on('data', c => {
                size += c.length;
                if (size > MAX_ARTIFACT_BYTES) { req.destroy(new Error('ответ больше лимита')); return; }
                chunks.push(c);
            });
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* не JSON — отдадим как есть */ }
                if (res.statusCode >= 400) {
                    const detail = (json && (json.error?.message || json.error || json.message)) || text.slice(0, 300);
                    return reject(new Error(`HTTP ${res.statusCode}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`));
                }
                if (!json) return reject(new Error(`ответ не JSON: ${text.slice(0, 200)}`));
                resolve(json);
            });
        });
        req.on('timeout', () => req.destroy(new Error(`таймаут ${REQUEST_TIMEOUT_MS} мс`)));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function download(url) {
    return new Promise((resolve, reject) => {
        let target;
        try { target = new URL(url); } catch (e) { return reject(new Error(`плохой URL результата: ${e.message}`)); }
        if (!['http:', 'https:'].includes(target.protocol)) return reject(new Error('схема URL не http(s)'));
        const mod = target.protocol === 'http:' ? http : https;
        const req = mod.get(target, { timeout: REQUEST_TIMEOUT_MS }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(download(new URL(res.headers.location, target).toString()));
            }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`скачивание: HTTP ${res.statusCode}`)); }
            const chunks = [];
            let size = 0;
            res.on('data', c => {
                size += c.length;
                if (size > MAX_ARTIFACT_BYTES) { req.destroy(new Error('файл больше лимита')); return; }
                chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('timeout', () => req.destroy(new Error('таймаут скачивания')));
        req.on('error', reject);
    });
}

// ── Диск ─────────────────────────────────────────────────────────────────────

function dayDir() {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dir = path.join(OUT_DIR, stamp);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Имя файла собирает сервер. Из браузера имя не принимается никогда. */
function saveArtifact(jobId, index, buf) {
    const kind = sniff(buf);
    if (!kind) throw new Error('не опознан формат файла по сигнатуре');
    const dir = dayDir();
    const file = path.join(dir, `${jobId}-${index}.${kind.ext}`);
    fs.writeFileSync(file, buf);
    return { file, mime: kind.mime, ext: kind.ext, bytes: buf.length };
}

function appendHistory(entry) {
    try { fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8'); }
    catch { /* история не должна ронять работу */ }
}

function readHistory(limit) {
    try {
        const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
        const tail = limit ? lines.slice(-limit) : lines;
        return tail.map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean).reverse();
    } catch { return []; }
}

// ── Задания ──────────────────────────────────────────────────────────────────

const JOB_ID_RE = /^m[0-9a-f]{16}$/;
function newJobId() { return 'm' + crypto.randomBytes(8).toString('hex'); }
function isJobId(v) { return JOB_ID_RE.test(String(v || '')); }

function publicJob(job) {
    return {
        id: job.id, status: job.status, kind: job.kind, model: job.model,
        providerId: job.providerId, providerName: job.providerName,
        prompt: job.prompt, params: job.params,
        createdAt: job.createdAt, finishedAt: job.finishedAt || null,
        ms: job.ms || null, error: job.error || null,
        artifacts: (job.artifacts || []).map((a, i) => ({
            index: i, mime: a.mime, ext: a.ext, bytes: a.bytes,
            url: `/__media/api/file/${job.id}/${i}`,
        })),
        dialectVerified: job.dialectVerified,
    };
}

/**
 * Поставить задание. Возвращает публичный вид сразу, работа идёт в фоне.
 * @param {{provider, model, prompt, params}} spec
 */
function enqueue(spec) {
    const profile = catalog.profileFor(spec.provider.id, spec.model);
    const dialect = dialects.dialectFor(profile);
    if (!dialect) throw new Error(`для модели ${spec.model} нет диалекта (тип: ${profile.kind})`);

    // Какой ключ тратить, решает `media-keys`: выбор в студии → активный → первый.
    // Раньше здесь брался первый активный, и второй аккаунт в карточке не тратился никогда.
    const key = mediaKeys.pick(spec.provider);
    if (!key || !key.apiKey) throw new Error(`у провайдера ${spec.provider.name} нет ключа`);

    const job = {
        id: newJobId(),
        status: 'queued',
        kind: profile.kind,
        model: spec.model,
        providerId: spec.provider.id,
        providerName: spec.provider.name,
        baseUrl: spec.provider.baseUrl,
        apiKey: key.apiKey,                 // только в памяти, наружу не отдаётся
        prompt: spec.prompt,
        params: spec.params || {},
        dialect,
        dialectVerified: dialect.verified,
        artifacts: [],
        createdAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    setImmediate(pump);
    return publicJob(job);
}

async function runJob(job) {
    const started = Date.now();
    job.status = 'running';
    try {
        const built = job.dialect.build({ model: job.model, prompt: job.prompt, ...job.params });
        let res = job.dialect.parse(await requestJson(job.baseUrl, job.apiKey, built));

        // Асинхронное задание — опрашиваем, пока не готово.
        // 🪤 Идентификатор держим здесь, в цикле, а не в ответе опроса: `parsePoll` возвращает
        // только статус и файлы, поэтому `res.jobId` после первого опроса теряется, и второй
        // опрос уезжал на `/videos/null` — задание падало через 5 с, уже ПОСЛЕ списания денег.
        // Провайдер вправе вернуть новый id, поэтому обновляем, а не фиксируем навсегда.
        let upstreamJobId = res.jobId || null;
        let polls = 0;
        while (res.status === 'pending' && job.dialect.poll) {
            if (++polls > POLL_LIMIT) throw new Error(`задание не завершилось за ${POLL_LIMIT * POLL_INTERVAL_MS / 1000} с`);
            // Опрос по пустому id — это ровно тот молчаливый 404, который мы чиним.
            if (!upstreamJobId) throw new Error('провайдер не назвал id задания — опрашивать нечего');
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            const pollJson = await requestJson(job.baseUrl, job.apiKey, job.dialect.poll(upstreamJobId));
            res = job.dialect.parsePoll(pollJson);
            if (res.jobId) upstreamJobId = res.jobId;
        }
        if (res.status !== 'done' || !res.artifacts.length) throw new Error('провайдер не вернул файл');

        job.artifacts = [];
        for (let i = 0; i < res.artifacts.length; i++) {
            const a = res.artifacts[i];
            const buf = a.b64 ? Buffer.from(a.b64, 'base64') : await download(a.url);
            job.artifacts.push(saveArtifact(job.id, i, buf));
        }
        job.status = 'done';
    } catch (e) {
        job.status = 'failed';
        job.error = e.message;
    } finally {
        job.ms = Date.now() - started;
        job.finishedAt = new Date().toISOString();
        delete job.apiKey;                            // ключ в истории не нужен и опасен
        appendHistory({ ...publicJob(job), files: (job.artifacts || []).map(a => a.file) });
        running--;
        setImmediate(pump);
    }
}

function pump() {
    if (running >= MAX_PARALLEL) return;
    for (const job of jobs.values()) {
        if (job.status !== 'queued') continue;
        running++;
        runJob(job);
        if (running >= MAX_PARALLEL) return;
    }
}

function getJob(id) { return jobs.get(id) || null; }
function listJobs() { return [...jobs.values()].map(publicJob).reverse(); }

/** Файл задания по индексу. Путь собран сервером, из запроса берётся только индекс. */
function artifactPath(jobId, index) {
    const job = jobs.get(jobId);
    if (job) {
        const a = job.artifacts[Number(index)];
        return a ? a : null;
    }
    // Не в памяти — ищем в истории (переживает рестарт).
    for (const h of readHistory(2000)) {
        if (h.id !== jobId) continue;
        const file = (h.files || [])[Number(index)];
        const meta = (h.artifacts || [])[Number(index)];
        if (file && fs.existsSync(file)) return { file, mime: (meta && meta.mime) || 'application/octet-stream', bytes: (meta && meta.bytes) || 0 };
    }
    return null;
}

module.exports = {
    OUT_DIR, HISTORY_FILE, MAX_PARALLEL,
    enqueue, getJob, listJobs, publicJob, readHistory, artifactPath,
    isJobId, sniff,
};
