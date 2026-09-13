'use strict';

const AR_QUOTA_BODY = Object.freeze({
    model: 'claude-opus-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: '1' }],
});

// ── Сетка партий: та же, что у циферблата (03/11/19 МСК = 16:00 UTC + 8 ч) ──
// Дублировать её здесь, а не импортировать из HTML, приходится потому, что часы —
// самодостаточный IIFE в разметке. Числа обязаны совпадать: регресс это проверяет.
const AR_QUOTA_CYCLE_MS = 8 * 3600 * 1000;
const AR_QUOTA_ANCHOR_MS = Date.UTC(1970, 0, 1, 16, 0, 0);

// Последняя партия НЕ ПОЗЖЕ ts. Ответ шлюза относится именно к ней: пока не
// случился следующий налив, состояние квоты не могло измениться само.
function arQuotaDropAt(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t)) return null;
    const el = ((t - AR_QUOTA_ANCHOR_MS) % AR_QUOTA_CYCLE_MS + AR_QUOTA_CYCLE_MS) % AR_QUOTA_CYCLE_MS;
    return t - el;
}

// Хвост ключа: заметить смену аккаунта достаточно, а секретом не является.
// Целый sk-… в кеш не попадает НИКОГДА — иначе ключ уехал бы в localStorage,
// чего вся схема quota-check избегает специально (сервер его не отдаёт клиенту).
function arQuotaKeyTail(key) {
    const s = String(key || '');
    return s.length > 4 ? s.slice(-4) : s;
}

// Запись кеша из результата пробы. `error` не кешируется вообще: это факт про
// сеть в тот момент, а не про квоту, и показывать его завтра бессмысленно.
function buildArQuotaCache(result, key, now) {
    const state = result && result.state;
    if (state !== 'available' && state !== 'exhausted') return null;
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return {
        state,
        checkedAt: new Date(ts).toISOString(),
        dropAt: new Date(arQuotaDropAt(ts)).toISOString(),
        keyTail: arQuotaKeyTail(key),
    };
}

// Годна ли запись СЕЙЧАС. Инвалидация по партии, а не по TTL: пока идёт та же
// партия — ответ актуален сколько угодно долго; как только случился налив, запись
// мертва (показывать «квота закончилась» после нового налива хуже, чем молчать).
// Смена активного ключа тоже убивает запись: состояние привязано к аккаунту.
function isArQuotaCacheFresh(entry, now, keyTail) {
    if (!entry || (entry.state !== 'available' && entry.state !== 'exhausted')) return false;
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const checked = Date.parse(entry.checkedAt);
    if (!Number.isFinite(checked) || checked > ts + 60_000) return false;   // запись из будущего — часы уехали
    const drop = Date.parse(entry.dropAt);
    if (!Number.isFinite(drop) || drop !== arQuotaDropAt(ts)) return false;
    if (keyTail && entry.keyTail && entry.keyTail !== keyTail) return false;
    return true;
}

// Кто свежее: сравнение по checkedAt, а НЕ по слою. Иначе браузер с устаревшей
// записью затирал бы свежую серверную — и наоборот сразу после рестарта :8200.
function pickFresherArQuota(a, b) {
    const ta = a && Date.parse(a.checkedAt), tb = b && Date.parse(b.checkedAt);
    if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
    if (!Number.isFinite(tb)) return a;
    return tb > ta ? b : a;
}

function classifyArQuotaProbe(status, rawBody) {
    const code = Number(status) || 0;
    if (code >= 200 && code < 300) return { state: 'available' };
    const text = String(rawBody || '');
    if (code === 402 && /Budget pool quota has been exhausted/i.test(text)) {
        return { state: 'exhausted' };
    }
    let message = text.slice(0, 300) || `HTTP ${code || 0}`;
    try {
        const parsed = JSON.parse(text);
        message = parsed?.error?.message || parsed?.error || parsed?.message || message;
    } catch {}
    return { state: 'error', error: String(message) };
}

module.exports = {
    AR_QUOTA_BODY,
    AR_QUOTA_CYCLE_MS,
    AR_QUOTA_ANCHOR_MS,
    classifyArQuotaProbe,
    arQuotaDropAt,
    arQuotaKeyTail,
    buildArQuotaCache,
    isArQuotaCacheFresh,
    pickFresherArQuota,
};
