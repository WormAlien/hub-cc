'use strict';
/*
 * media-dialects.js — как попросить у провайдера картинку или видео и как разобрать ответ.
 *
 * Зачем файл существует. У картинок форма запроса предсказуемая: `POST /images/generations`,
 * ответ — `data[]` с `b64_json` или `url`. У видео единой формы нет вообще: кто-то отдаёт
 * готовый файл синхронно, кто-то — job с опросом статуса, и поля у всех разные. Держать это
 * в общем коде студии значит переписывать студию под каждого нового провайдера.
 *
 * Поэтому диалект — отдельная маленькая единица: собрать тело запроса, разобрать ответ,
 * сказать «готово» или «жди». Новый провайдер = новый диалект здесь, а не правка вкладки.
 *
 * ⚠️ ЧЕСТНО ПРО ПРОВЕРЕННОСТЬ. `images-openai` проверен живьём на
 * `newapi.makelove.cloud` 2026-09-10 (`gpt-image-2.5-sunburst`, 1536×1024, файл получен).
 * `video-openai` НЕ проверен ни разу — форма собрана по документации и общей практике.
 * Отсюда правило ниже: неизвестный ответ обязан падать громко, с сохранением сырого тела,
 * а не молча возвращать пустоту. Пустой результат при списанных деньгах — худший исход.
 */

const catalog = require('./media-catalog');

// ── Разбор артефактов ────────────────────────────────────────────────────────

/** Достать картинки/видео из ответа формы OpenAI: `data[]` с `b64_json` либо `url`. */
function extractOpenAiData(json) {
    const items = Array.isArray(json && json.data) ? json.data : [];
    const artifacts = [];
    for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        if (it.b64_json) artifacts.push({ b64: it.b64_json, mime: null });
        else if (it.url) artifacts.push({ url: it.url, mime: null });
        else if (it.video_url) artifacts.push({ url: it.video_url, mime: null });
    }
    return artifacts;
}

/** Поискать id задания в ответе — у видео его называют по-разному. */
function extractJobId(json) {
    if (!json || typeof json !== 'object') return null;
    for (const k of ['id', 'job_id', 'jobId', 'task_id', 'taskId', 'request_id']) {
        if (json[k] && typeof json[k] !== 'object') return String(json[k]);
    }
    return null;
}

/** Статус асинхронного задания, приведённый к трём значениям. */
function normalizeStatus(json) {
    const raw = String((json && (json.status || json.state)) || '').toLowerCase();
    if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].includes(raw)) return 'done';
    if (['failed', 'error', 'cancelled', 'canceled'].includes(raw)) return 'failed';
    if (raw) return 'pending';
    return null;
}

// ── Диалекты ─────────────────────────────────────────────────────────────────

const DIALECTS = {
    /**
     * Картинки, форма OpenAI. ✅ Проверен живьём 2026-09-10.
     */
    'images-openai': {
        kind: catalog.KIND.IMAGE,
        verified: true,
        build(params) {
            const body = {
                model: params.model,
                prompt: params.prompt,
                n: Math.max(1, Math.min(Number(params.count) || 1, 10)),
                response_format: 'b64_json',
            };
            if (params.size) body.size = params.size;
            if (params.quality) body.quality = params.quality;
            // Поля ниже поддерживают не все — шлём, только если человек их реально задал.
            if (params.seed !== undefined && params.seed !== null && params.seed !== '') {
                body.seed = Number(params.seed);
            }
            if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
            if (params.background) body.background = params.background;
            // Сырой оверрайд — последним, он должен побеждать всё остальное: это аварийный
            // рычаг на случай поля, которого мы в UI ещё не описали.
            return { method: 'POST', path: '/images/generations', body: { ...body, ...(params.raw || {}) } };
        },
        parse(json) {
            const artifacts = extractOpenAiData(json);
            if (artifacts.length) return { status: 'done', artifacts };
            throw new Error('ответ без data[].b64_json и без data[].url');
        },
    },

    /**
     * Видео, форма OpenAI-подобная. ⚠️ НЕ ПРОВЕРЕН на живом шлюзе.
     * Умеет оба исхода: файл сразу и задание с опросом.
     */
    'video-openai': {
        kind: catalog.KIND.VIDEO,
        verified: false,
        build(params) {
            const body = { model: params.model, prompt: params.prompt };
            if (params.size) body.size = params.size;
            if (params.durationSec) body.seconds = Number(params.durationSec);
            if (params.startFrameUrl) body.image = params.startFrameUrl;
            if (params.audio !== undefined) body.audio = Boolean(params.audio);
            return { method: 'POST', path: '/videos', body: { ...body, ...(params.raw || {}) } };
        },
        parse(json) {
            const artifacts = extractOpenAiData(json);
            if (artifacts.length) return { status: 'done', artifacts };

            const jobId = extractJobId(json);
            const status = normalizeStatus(json);
            if (jobId && status !== 'failed') return { status: 'pending', jobId, artifacts: [] };
            if (status === 'failed') {
                throw new Error(`провайдер вернул отказ: ${(json && (json.error || json.message)) || 'без текста'}`);
            }
            // 🪤 Молча вернуть «готово, ноль файлов» нельзя: деньги уже списаны, а человек
            // увидит пустой экран и решит, что сломалась вкладка. Падаем с сырым телом.
            throw new Error('ответ не опознан: ни файла, ни id задания, ни статуса');
        },
        /** Опрос задания. Путь и поля — тоже предположение, см. предупреждение вверху файла. */
        poll(jobId) {
            return { method: 'GET', path: `/videos/${encodeURIComponent(jobId)}` };
        },
        parsePoll(json) {
            const artifacts = extractOpenAiData(json);
            const status = normalizeStatus(json);
            if (artifacts.length) return { status: 'done', artifacts };
            if (status === 'failed') {
                throw new Error(`задание провалено: ${(json && (json.error || json.message)) || 'без текста'}`);
            }
            return { status: 'pending', artifacts: [] };
        },
    },
};

/** Какой диалект применить к модели. Пока выбирает тип модели, дальше — поле у провайдера. */
function dialectFor(profile) {
    if (!profile) return null;
    if (profile.kind === catalog.KIND.IMAGE) return { name: 'images-openai', ...DIALECTS['images-openai'] };
    if (profile.kind === catalog.KIND.VIDEO) return { name: 'video-openai', ...DIALECTS['video-openai'] };
    return null;
}

module.exports = { DIALECTS, dialectFor, extractOpenAiData, extractJobId, normalizeStatus };
