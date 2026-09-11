# Modelmap POST handlers audit — transparent-proxy.js

File: `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\transparent-proxy.js`
Scope: `handleXpModelMap`, `handleJwModelMap`, `handleSkModelMap`, `handleTsModelMap`, `handleArModelMap`
Concern: a FULL OVERWRITE with only 3 tiers (opus/sonnet/haiku) silently erases any existing `gpt` value on every save.

---

## handleArModelMap — TEMPLATE (already writes gpt)

1. **Definition line:** 12629 (`async function handleArModelMap(req, res)`)
2. **Tier keys written** (verbatim, lines 12633–12638) — writes ALL FOUR incl. `gpt`:
```js
const mm = {
    opus: String(body.opus || '').trim() || '',
    sonnet: String(body.sonnet || '').trim() || '',
    haiku: String(body.haiku || '').trim() || '',
    gpt: String(body.gpt || '').trim() || '',
};
```
3. **Overwrite vs merge:** FULL OVERWRITE — `mm` is built purely from POST `body`, no read of existing file. Write at line 12639: `fs.writeFileSync(AR_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');`. Safe only because it includes `gpt`.
4. **Empty-value convention:** `''` (empty string) — `... .trim() || ''` on every tier.
5. **Target file constant:** `AR_MODELMAP_FILE` (defined line 7628) = `path.join(__dirname, 'ar-modelmap.json')` → `routing/ar-modelmap.json`.
6. **Side effects beyond write:**
   - `logLine(...)` at 12640: `agentrouter modelmap: opus→… sonnet→… haiku→… gpt→…`.
   - Handles both GET and POST: `if (req.method === 'POST')` branch writes; the GET fall-through returns `arReadModelMap()`. (Router wires both GET and POST at lines 20841–20842.)
   - Returns `jsonRes(res, 200, { ok: true, modelMap: mm })`. No keepalive restart, no settings rewrite — per comment (12617–12618) proxy :20132 and keepalive :20133 re-read the file by mtime each request, so no restart needed.

**Confirmed:** `handleArModelMap` is the only handler that persists `gpt`. It reads `body.gpt`, trims it, defaults to `''`, and includes the `gpt` key in the object it serializes. This is the shape the other four should follow.

---

## handleJwModelMap

1. **Definition line:** 16338 (`async function handleJwModelMap(req, res)`)
2. **Tier keys written** (verbatim, lines 16341–16345) — only THREE, NO `gpt`:
```js
const mm = {
    opus: String(body.opus || '').trim() || null,
    sonnet: String(body.sonnet || '').trim() || null,
    haiku: String(body.haiku || '').trim() || null,
};
```
3. **Overwrite vs merge:** FULL OVERWRITE — `mm` built purely from `body`, no read of existing file. Write at line 16346: `fs.writeFileSync(JW_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');`. **BUG:** with only 3 tiers, any pre-existing `gpt` value in the file is erased on every save.
4. **Empty-value convention:** `null` — `... .trim() || null`.
5. **Target file constant:** `JW_MODELMAP_FILE` (defined line 15489) = `path.join(__dirname, 'justwoker-modelmap.json')` → `routing/justwoker-modelmap.json`.
6. **Side effects beyond write:**
   - `logLine(...)` at 16347: `justwoker modelmap: opus→… sonnet→… haiku→…` (no gpt in log).
   - POST-only: no `req.method` guard; reads `body` directly. Router wires only POST at line 21087 (no GET route for jw modelmap).
   - Returns `jsonRes(res, 200, { ok: true, modelMap: mm })`. No keepalive restart / settings rewrite.

---

## handleSkModelMap

1. **Definition line:** 16994 (`async function handleSkModelMap(req, res)`)
2. **Tier keys written** (verbatim, lines 16997–17001) — only THREE, NO `gpt`:
```js
const mm = {
    opus: String(body.opus || '').trim() || null,
    sonnet: String(body.sonnet || '').trim() || null,
    haiku: String(body.haiku || '').trim() || null,
};
```
3. **Overwrite vs merge:** FULL OVERWRITE — `mm` built purely from `body`, no read of existing file. Write at line 17002: `fs.writeFileSync(SK_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');`. **BUG:** erases any pre-existing `gpt` on every save.
4. **Empty-value convention:** `null` — `... .trim() || null`.
5. **Target file constant:** `SK_MODELMAP_FILE` (defined line 16392) = `path.join(__dirname, 'seekai-modelmap.json')` → `routing/seekai-modelmap.json`.
6. **Side effects beyond write:**
   - `logLine(...)` at 17003: `seekai modelmap: opus→… sonnet→… haiku→…` (no gpt in log).
   - POST-only: no `req.method` guard; reads `body` directly. Router wires only POST at line 21107.
   - Returns `jsonRes(res, 200, { ok: true, modelMap: mm })`. No keepalive restart / settings rewrite.
   - Byte-identical in structure to `handleJwModelMap` (same 3 tiers, same `null`, same log shape) — only the constant, log prefix and file differ.

---

## handleTsModelMap

1. **Definition line:** 17736 (`async function handleTsModelMap(req, res)`)
2. **Tier keys written** (verbatim, lines 17739–17743) — only THREE, NO `gpt`:
```js
const mm = {
    opus: String(body.opus || '').trim() || null,
    sonnet: String(body.sonnet || '').trim() || null,
    haiku: String(body.haiku || '').trim() || null,
};
```
3. **Overwrite vs merge:** FULL OVERWRITE — `mm` built purely from `body`, no read of existing file. Write at line 17744: `fs.writeFileSync(TS_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');`. **BUG:** erases any pre-existing `gpt` on every save.
4. **Empty-value convention:** `null` — `... .trim() || null`.
5. **Target file constant:** `TS_MODELMAP_FILE` (defined line 17049) = `path.join(__dirname, 'truesota-modelmap.json')` → `routing/truesota-modelmap.json`.
6. **Side effects beyond write — the richest of the five:**
   - **Validation warning (17745–17746):** `const bad = ['opus','sonnet','haiku'].filter(t => mm[t] && !TS_SYSTEM_HONORED.has(mm[t]));` → if non-empty, `logLine('truesota modelmap: ⚠️ тиры … смотрят на модель, которая выбрасывает системный промпт')`. `TS_SYSTEM_HONORED` (line 17660) = `new Set(['claude-opus-5', 'claude-opus-5-thinking'])`.
   - **Empty-tier warning (17747):** if any of the three tiers is falsy → `logLine('truesota modelmap: ⚠️ пустой тир — запрос этого тира упадёт без ретрая')`.
   - `logLine(...)` at 17748: `truesota modelmap: opus→… sonnet→… haiku→…` (no gpt in log).
   - Returns `jsonRes(res, 200, { ok: true, modelMap: mm, warnTiers: bad })` — the only handler returning an extra field.
   - 🪤 Note: the hardcoded tier lists at 17745 and 17747 are `['opus','sonnet','haiku']` — adding `gpt` later means updating these two literals too, or the new tier escapes validation.
   - POST-only: no `req.method` guard. Router wires only POST at line 21145. No keepalive restart / settings rewrite.

---

## handleXpModelMap

1. **Definition line:** 19143 (`async function handleXpModelMap(req, res)`)
2. **Tier keys written** (verbatim, lines 19147–19151) — only THREE, NO `gpt`:
```js
const mm = {
    opus: String(body.opus || '').trim() || '',
    sonnet: String(body.sonnet || '').trim() || '',
    haiku: String(body.haiku || '').trim() || '',
};
```
3. **Overwrite vs merge:** FULL OVERWRITE — `mm` built purely from `body`, no read of existing file. Write at line 19152: `fs.writeFileSync(XP_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8');`. **BUG:** erases any pre-existing `gpt` on every save.
4. **Empty-value convention:** `''` (empty string) — `... .trim() || ''`. (Same convention as `handleArModelMap`, but Xp lacks the `gpt` key.)
5. **Target file constant:** `XP_MODELMAP_FILE` (defined line 18728) = `path.join(__dirname, 'xpeach-modelmap.json')` → `routing/xpeach-modelmap.json`.
6. **Side effects beyond write:**
   - `logLine(...)` at 19153: `xpeach modelmap: opus→… sonnet→… haiku→…` (no gpt in log).
   - Has its own `if (req.method === 'POST')` guard (like Ar); GET fall-through at 19156 returns `xpReadModelMap()`. But the router intercepts GET inline at line 21071 (`return jsonRes(..., xpReadModelMap())`) before reaching the handler, so only POST actually enters `handleXpModelMap`. Router POST wire at line 21080.
   - Returns `jsonRes(res, 200, { ok: true, modelMap: mm })`. No keepalive restart / settings rewrite (keepalive :20157 re-reads by mtime per comment 19141–19142).

---

## Summary table

| Handler | Def line | gpt written? | Overwrite? | Empty conv. | File constant → filename |
|---|---|---|---|---|---|
| `handleArModelMap` | 12629 | ✅ YES | full overwrite | `''` | `AR_MODELMAP_FILE` → `ar-modelmap.json` |
| `handleJwModelMap` | 16338 | ❌ no | full overwrite | `null` | `JW_MODELMAP_FILE` → `justwoker-modelmap.json` |
| `handleSkModelMap` | 16994 | ❌ no | full overwrite | `null` | `SK_MODELMAP_FILE` → `seekai-modelmap.json` |
| `handleTsModelMap` | 17736 | ❌ no | full overwrite | `null` | `TS_MODELMAP_FILE` → `truesota-modelmap.json` |
| `handleXpModelMap` | 19143 | ❌ no | full overwrite | `''` | `XP_MODELMAP_FILE` → `xpeach-modelmap.json` |

**All five are full overwrites** (build `mm` from POST body only, never read the existing file). The four without `gpt` (jw, sk, ts, xp) therefore silently erase any existing `gpt` value on every save. `handleArModelMap` is the correct template: add a 4th line `gpt: String(body.gpt || '').trim() || <empty>` to each.

**Empty-convention split to reconcile when adding `gpt`:** Ar + Xp use `''`; Jw + Sk + Ts use `null`. To match the Ar template use `''`. (For reference, `handleGoModelMap` uses `null`.)

**Extra care for Ts:** its validation uses two hardcoded `['opus','sonnet','haiku']` literals (lines 17745, 17747) and returns `warnTiers` — a `gpt` tier must be added there too or it bypasses the warnings.
