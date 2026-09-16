'use strict';

// Тело пробы. `max_tokens` НЕ равен 1 намеренно: gpt-6-astra отвергает крошечный потолок
// вывода («Could not finish the message because max_tokens or model output limit was
// reached») и отвечает 400 — а классификатор читает это как `error`, и кнопка «Проверить
// GPT» падала вместо ответа. Ровно та же грабля, что чинилась полом 16 в конвертере
// (`agentrouter-proxy.js`), но здесь пол конвертера не работает: проба идёт СВОИМ
// запросом прямо на agentrouter.org, минуя конвертер.
//
// 16 выбрано не «на глаз»: это минимальное значение, которое Astra принимает (проверено
// пробой 15.09). Потолок на ответ не влияет — пробе важен только код состояния, а не текст.
//
// Для claude-* пол безвреден: там max_tokens=1 работал, но 16 работает так же.
const AR_QUOTA_BODY = Object.freeze({
    model: 'claude-opus-5',
    max_tokens: 16,
    messages: [{ role: 'user', content: '1' }],
});

// ── Полос две, и они РАЗНЫЕ ──────────────────────────────────────────────────
// agentrouter наливает Claude и GPT одновременно (партии одни и те же), но
// кончаются они по отдельности: 15.09 в 04:52 пул Opus был пуст, а GPT ещё
// отдавался. Поэтому состояние ведётся на полосу, а не на аккаунт.
// Имя модели НЕ угадывается: у AgentRouter это ровно то, что перечислено в
// /v1/models; для gpt это `gpt-6-astra`.
const AR_QUOTA_POOLS = Object.freeze({
    opus: 'claude-opus-5',
    gpt: 'gpt-6-astra',
});
const AR_QUOTA_DEFAULT_POOL = 'opus';

// Полоса по имени модели. `null` = модель беспуловая (deepseek-*, glm-*): она
// пулу не подчинена, и записывать ей состояние квоты нечего.
function arQuotaPoolForModel(id) {
    const s = String(id || '');
    if (/^claude[-_]/i.test(s)) return 'opus';
    if (/^gpt[-_]/i.test(s)) return 'gpt';
    return null;
}

// Тело пробы для полосы. Одна и та же проба на обеих полосах проверяла бы Opus
// дважды и врала про GPT — поэтому модель берётся из таблицы, а не из константы.
function arQuotaBodyFor(pool) {
    const model = AR_QUOTA_POOLS[pool];
    return model ? { ...AR_QUOTA_BODY, model } : { ...AR_QUOTA_BODY };
}

// Файл состояния — плоский словарь по полосам: `{"opus":{…},"gpt":{…}}`.
// 🪤 Формат v1 (одна запись без ключей полос) обязан читаться как запись opus:
// он лежит на диске у всех, кто обновляется, и «после апдейта квота пропала»
// выглядело бы поломкой.
function arQuotaReadPools(raw) {
    let doc = null;
    try { doc = JSON.parse(raw); } catch { return {}; }
    if (!doc || typeof doc !== 'object') return {};
    const out = {};
    for (const p of Object.keys(AR_QUOTA_POOLS)) {
        if (doc[p] && typeof doc[p] === 'object') out[p] = doc[p];
    }
    if (!out.opus && doc.state) out.opus = doc;   // v1 = запись opus
    return out;
}

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
    AR_QUOTA_POOLS,
    AR_QUOTA_DEFAULT_POOL,
    arQuotaPoolForModel,
    arQuotaBodyFor,
    arQuotaReadPools,
    AR_QUOTA_CYCLE_MS,
    AR_QUOTA_ANCHOR_MS,
    classifyArQuotaProbe,
    arQuotaDropAt,
    arQuotaKeyTail,
    buildArQuotaCache,
    isArQuotaCacheFresh,
    pickFresherArQuota,
};
