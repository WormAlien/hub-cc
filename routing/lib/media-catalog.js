'use strict';
/*
 * media-catalog.js — какие модели умеют картинки, какие видео, и с какими параметрами.
 *
 * Зачем файл существует. `/v1/models` у OpenAI-совместимого шлюза отдаёт про модель почти
 * ничего: `id`, `owned_by`, `supported_endpoint_types`. Ни типа (картинка/видео/текст), ни
 * размеров, ни списка полей. Значит тип приходится выводить самим — а вывод по имени
 * ошибается ровно там, где имя нестандартное.
 *
 * 🪤 Половина каталога `newapi.makelove.cloud` — алиасы шлюза, которых нет в документации
 * вендора: `gpt-image-2-max`, `gpt-image-2-4k`, `codex-gpt-image-2`, `gpt-image-2.5`.
 * Поэтому автотипизация здесь ОБЯЗАНА уступать ручной правке, а не наоборот: угаданный
 * профиль — это подсказка, сохранённый руками — это факт. Разбор моделей и тир-лист —
 * вика, «Модели генерации изображений — тир-лист 2026-09».
 *
 * Ручные правки лежат отдельно от кеша каталога (`media-profiles.json`), чтобы обновление
 * списка моделей их не затирало: каталог живёт у провайдера и пересобирается сканом, а
 * профиль переживает скан.
 */

const fs = require('fs');
const path = require('path');

const PROFILES_FILE = path.join(__dirname, '..', 'media-profiles.json');

// ── Типы и возможности ───────────────────────────────────────────────────────

const KIND = { IMAGE: 'image', VIDEO: 'video', OTHER: 'other' };

// Правила угадывания. Порядок важен: первое совпадение выигрывает, поэтому видео стоит
// ВЫШЕ картинок — `grok-imagine-video` содержит и `imagine`, и `video`, и без порядка
// уехал бы в картинки.
const GUESS_RULES = [
    { kind: KIND.VIDEO, re: /(^|[-_/])video|video([-_.]|$)|veo|kling|runway|sora/i },
    { kind: KIND.IMAGE, re: /image|imagine|banana|flux|dalle|dall-e|midjourney|ideogram|recraft|imagen|sdxl|stable-?diffusion/i },
];

// Что подставляем в форму, пока человек не уточнил. Значения намеренно консервативные:
// лучше показать меньше полей, чем показать поле, которого шлюз не понимает.
const DEFAULT_CAPS = {
    [KIND.IMAGE]: {
        sizes: ['1024x1024', '1536x1024', '1024x1536'],
        defaultSize: '1024x1024',
        maxCount: 4,
        supportsNegativePrompt: false,
        supportsSeed: false,
        supportsQuality: true,
        supportsReferenceImages: false,
    },
    [KIND.VIDEO]: {
        sizes: ['1280x720', '720x1280'],
        defaultSize: '1280x720',
        maxCount: 1,
        durationsSec: [5, 10],
        defaultDurationSec: 5,
        supportsStartFrame: true,
        supportsExtend: false,
        supportsAudio: false,
    },
    [KIND.OTHER]: {},
};

/** Угадать тип модели по её id. Только подсказка — перекрывается ручным профилем. */
function guessKind(modelId) {
    const id = String(modelId || '');
    for (const rule of GUESS_RULES) if (rule.re.test(id)) return rule.kind;
    return KIND.OTHER;
}

/*
 * 🪤 Флаг «параметры этой модели никто не подтверждал» — по умолчанию ВКЛЮЧЁН.
 *
 * Соблазн был сделать наоборот: список подозрительных суффиксов (`-max`, `-4k`, `codex-`)
 * и флаг только на них. Так нельзя — список подозрительных всегда неполон, и любая новая
 * модель проезжала бы как «проверенная» с чужими дефолтами. Поэтому логика обратная:
 * подтверждено то, что перечислено ниже или что человек сохранил руками, остальное —
 * «уточни параметры». Для новой модели это ровно правильный совет.
 *
 * Список — только те id, у которых поведение описано документацией вендора (проверено
 * 2026-09-10). Он намеренно короткий и не обязан поспевать за каталогом.
 */
const DOCUMENTED = new Set([
    'gpt-image-2',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'grok-imagine-image',
    'grok-imagine-image-quality',
    'grok-imagine-video',
    'grok-imagine-video-1.5',
    'nano-banana-2',
]);
function looksUndocumented(modelId, kind, manual) {
    if (kind === KIND.OTHER) return false;   // текстовые модели эта вкладка не настраивает
    if (manual) return false;                // человек подтвердил — вопрос закрыт
    return !DOCUMENTED.has(String(modelId || ''));
}

// ── Хранилище ручных профилей ────────────────────────────────────────────────

function loadProfiles() {
    try {
        const raw = fs.readFileSync(PROFILES_FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return doc && typeof doc.profiles === 'object' && doc.profiles ? doc : { profiles: {} };
    } catch { return { profiles: {} }; }
}

/** Запись атомарная (temp + rename) — как customSave в дашборде. */
function saveProfiles(doc) {
    const tmp = `${PROFILES_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, PROFILES_FILE);
}

/** Ключ профиля — пара «провайдер + модель»: один id у разных шлюзов может вести себя по-разному. */
function profileKey(providerId, modelId) {
    return `${providerId}::${modelId}`;
}

// ── Сборка профиля ───────────────────────────────────────────────────────────

/**
 * Профиль модели: угаданное, перекрытое ручным.
 * @returns {{id, providerId, kind, guessedKind, caps, undocumented, manual}}
 */
function profileFor(providerId, modelId, profilesDoc) {
    const doc = profilesDoc || loadProfiles();
    const manual = doc.profiles[profileKey(providerId, modelId)] || null;
    const guessedKind = guessKind(modelId);
    const kind = (manual && manual.kind) || guessedKind;
    return {
        id: modelId,
        providerId,
        kind,
        guessedKind,
        caps: { ...(DEFAULT_CAPS[kind] || {}), ...((manual && manual.caps) || {}) },
        undocumented: looksUndocumented(modelId, kind, Boolean(manual)),
        manual: Boolean(manual),
    };
}

/** Разложить каталог провайдера по типам. `models` — массив id или объектов с `id`. */
function classify(providerId, models) {
    const doc = loadProfiles();
    const out = { [KIND.IMAGE]: [], [KIND.VIDEO]: [], [KIND.OTHER]: [] };
    for (const m of models || []) {
        const id = typeof m === 'string' ? m : (m && m.id);
        if (!id) continue;
        const prof = profileFor(providerId, id, doc);
        out[prof.kind].push(prof);
    }
    return out;
}

/** Сохранить ручную правку профиля. `patch` = {kind?, caps?}; kind: null снимает правку. */
function setProfile(providerId, modelId, patch) {
    const doc = loadProfiles();
    const key = profileKey(providerId, modelId);
    if (patch === null) delete doc.profiles[key];
    else {
        const prev = doc.profiles[key] || {};
        doc.profiles[key] = {
            ...prev,
            ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
            ...(patch.caps ? { caps: { ...(prev.caps || {}), ...patch.caps } } : {}),
            updatedAt: new Date().toISOString(),
        };
    }
    saveProfiles(doc);
    return profileFor(providerId, modelId);
}

module.exports = {
    KIND, DEFAULT_CAPS, PROFILES_FILE, DOCUMENTED,
    guessKind, looksUndocumented, profileFor, classify,
    loadProfiles, saveProfiles, setProfile, profileKey,
};
