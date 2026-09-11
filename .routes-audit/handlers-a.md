# Audit A — POST modelmap handlers in `routing/transparent-proxy.js`

Read-only audit. File: `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\transparent-proxy.js` (22152 lines).
Scope: `handleGoModelMap`, `handleKkModelMap`, `handleApModelMap`, `handleHnModelMap`, `handleTbModelMap`.
Reference (not in scope, used as the 4-tier / `''` baseline): `handleArModelMap` @ 12629.

## Summary table

| Handler | Line | Tiers written | Write mode | Empty conv. | File constant | Resolved filename |
|---|---|---|---|---|---|---|
| `handleGoModelMap` | 13369 | opus, sonnet, haiku | FULL OVERWRITE | `null` | `GO_MODELMAP_FILE` @ 12772 | `routing/gorouter-modelmap.json` |
| `handleKkModelMap` | 14214 | opus, sonnet, haiku | FULL OVERWRITE | `null` | `KK_MODELMAP_FILE` @ 13423 | `routing/kktoken-modelmap.json` |
| `handleApModelMap` | 14734 | opus, sonnet, haiku | FULL OVERWRITE | `null` | `AP_MODELMAP_FILE` @ 13458 | `routing/aipm-modelmap.json` |
| `handleHnModelMap` | 15439 | opus, sonnet, haiku | FULL OVERWRITE | `null` | `HN_MODELMAP_FILE` @ 14799 | `routing/hcnsec-modelmap.json` |
| `handleTbModelMap` | 18521 | opus, sonnet, haiku | FULL OVERWRITE | `''` | `TB_MODELMAP_FILE` @ 17761 | `routing/tabi-modelmap.json` |
| _(ref)_ `handleArModelMap` | 12629 | opus, sonnet, haiku, **gpt** | FULL OVERWRITE | `''` | `AR_MODELMAP_FILE` @ 7628 | `routing/ar-modelmap.json` |

**Verdict: all five drop `gpt`, and all five are full overwrites with no read-modify-write merge.** Any `gpt` value in those five files is erased on the next successful POST.

## On-disk state at audit time (2026-09-11)

```
ar-modelmap.json       {"opus","sonnet","haiku","gpt"}   <- ONLY file with a gpt key
gorouter-modelmap.json {"opus","sonnet","haiku"}
kktoken-modelmap.json  {"opus","sonnet","haiku"}
aipm-modelmap.json     {"opus","sonnet","haiku"}
hcnsec-modelmap.json   {"opus","sonnet","haiku"}
tabi-modelmap.json     {"opus","sonnet","haiku"}
```

Note: `HN_MODELMAP_FILE` resolves to `hcnsec-modelmap.json`, **not** `haineng-modelmap.json` — the `hn` prefix does not match the filename stem.

---

## 1. `handleGoModelMap` — line 13369

**Tiers written (verbatim object literal, lines 13372-13376):**

```js
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
```

- **Tier keys:** `opus`, `sonnet`, `haiku`. **No `gpt`.**
- **Write mode: FULL OVERWRITE.** Line 13377 is a bare `fs.writeFileSync(GO_MODELMAP_FILE, JSON.stringify(mm, null, 2) + '\n', 'utf8')`. There is no read of the existing file anywhere in the handler — no `goReadModelMap()` call, no spread of prior state. Any key present in `gorouter-modelmap.json` but absent from `mm` (i.e. `gpt`) is destroyed on every POST.
- **Empty-value convention: `null`** (`|| null`). Differs from `handleArModelMap`, which uses `|| ''`.
- **File constant:** `GO_MODELMAP_FILE`, defined line 12772 as `path.join(__dirname, 'gorouter-modelmap.json')` → `routing/gorouter-modelmap.json`.
- **Side effects beyond the write:**
  - `logLine(...)` @ 13378 — `gorouter modelmap: opus→… sonnet→… haiku→…` (3 tiers logged, no gpt).
  - `jsonRes(res, 200, { ok: true, modelMap: mm })` @ 13379 — echoes the new map back.
  - No keepalive restart, no settings rewrite, no other file touched.
- **Method handling:** POST-only body path; the handler does **not** branch on `req.method`. GET for this route is served inline at the router (line 20953) via `goReadModelMap()`, not by this function. Contrast with `handleArModelMap`, which handles both methods internally.
- **Error path:** `catch (e) { jsonRes(res, 500, { error: e.message }); }`.

---

## 2. `handleKkModelMap` — line 14214

**Tiers written (verbatim object literal, lines 14217-14221):**

```js
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
```

- **Tier keys:** `opus`, `sonnet`, `haiku`. **No `gpt`.**
- **Write mode: FULL OVERWRITE.** Line 14222, bare `fs.writeFileSync(KK_MODELMAP_FILE, …)`. No read of prior state, no `kkReadModelMap()` call inside the handler, no merge. Identical shape to Go.
- **Empty-value convention: `null`.**
- **File constant:** `KK_MODELMAP_FILE`, defined line 13423 as `path.join(__dirname, 'kktoken-modelmap.json')` → `routing/kktoken-modelmap.json`.
- **Side effects beyond the write:**
  - `logLine(...)` @ 14223 — `kktoken modelmap: opus→… sonnet→… haiku→…`.
  - `jsonRes(res, 200, { ok: true, modelMap: mm })` @ 14224.
  - Nothing else. No keepalive restart (KK's keepalive is :20161), no settings rewrite.
- **Method handling:** POST-only body path, no `req.method` branch. GET served inline at router line 20980 via `kkReadModelMap()`.
- **Note:** this handler is a line-for-line copy of `handleGoModelMap` with the constant and the log prefix swapped. Consistent with the code comment at 13391 calling KKtoken "структурная копия вкладки GoRouter".

---

## 3. `handleApModelMap` — line 14734

**Tiers written (verbatim object literal, lines 14737-14741):**

```js
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
```

- **Tier keys:** `opus`, `sonnet`, `haiku`. **No `gpt`.**
- **Write mode: FULL OVERWRITE.** Line 14742, bare `fs.writeFileSync(AP_MODELMAP_FILE, …)`. No read, no merge.
- **Empty-value convention: `null`.**
- **File constant:** `AP_MODELMAP_FILE`, defined line 13458 as `path.join(__dirname, 'aipm-modelmap.json')` → `routing/aipm-modelmap.json`.
- **Side effects beyond the write:**
  - `logLine(...)` @ 14743 — **and here is a copy-paste defect.** The literal reads:
    ```js
    logLine(`kktoken modelmap: opus→${mm.opus || '-'} sonnet→${mm.sonnet || '-'} haiku→${mm.haiku || '-'}`);
    ```
    It is tagged **`kktoken`**, not `aipm`. A tier change on the AIPM tab writes `aipm-modelmap.json` but reports itself in the log as a KKtoken change. Log-only (the write target is correct), but it makes the AIPM tab invisible in the log and fakes KK activity. Same copy-paste lineage as the duplicated block comment at 13446 ("SSE keepalive proxy для kktoken" sitting above the AIPM constants).
  - `jsonRes(res, 200, { ok: true, modelMap: mm })` @ 14744.
  - Nothing else — no keepalive restart, no settings rewrite.
- **Method handling:** POST-only body path, no `req.method` branch. GET served inline at router line 20999 via `apReadModelMap()`.

---

## 4. `handleHnModelMap` — line 15439

**Tiers written (verbatim object literal, lines 15442-15446):**

```js
        const mm = {
            opus: String(body.opus || '').trim() || null,
            sonnet: String(body.sonnet || '').trim() || null,
            haiku: String(body.haiku || '').trim() || null,
        };
```

- **Tier keys:** `opus`, `sonnet`, `haiku`. **No `gpt`.**
- **Write mode: FULL OVERWRITE.** Line 15447, bare `fs.writeFileSync(HN_MODELMAP_FILE, …)`. No read, no merge.
- **Empty-value convention: `null`.**
- **File constant:** `HN_MODELMAP_FILE`, defined line 14799 as `path.join(__dirname, 'hcnsec-modelmap.json')` → `routing/hcnsec-modelmap.json`. 🪤 **The `hn` route prefix does not match the filename stem** (`hcnsec`, not `haineng`) — grepping for `haineng-modelmap.json` finds nothing.
- **Side effects beyond the write:**
  - `logLine(...)` @ 15448 — `hcnsec modelmap: …`. Prefix is correct here (unlike AP).
  - `jsonRes(res, 200, { ok: true, modelMap: mm })` @ 15449.
  - Nothing else — no keepalive restart (HN's keepalive is :20162), no settings rewrite.
- **Method handling:** POST-only body path, no `req.method` branch. GET is served inline at the router.
- **Context:** the HCNsec tab is documented at 15455 as having 19 of GoRouter's 22 routes (no GitHub login), but the modelmap handler itself is the unmodified 3-tier clone.

---

## 5. `handleTbModelMap` — line 18521

**Tiers written (verbatim object literal, lines 18525-18529):**

```js
            const mm = {
                opus: String(body.opus || '').trim() || '',
                sonnet: String(body.sonnet || '').trim() || '',
                haiku: String(body.haiku || '').trim() || '',
            };
```

- **Tier keys:** `opus`, `sonnet`, `haiku`. **No `gpt`.**
- **Write mode: FULL OVERWRITE.** Line 18530, bare `fs.writeFileSync(TB_MODELMAP_FILE, …)`. The handler *does* contain a `tbReadModelMap()` call at 18534 — but it is in the **GET** branch, after the POST branch has already returned. It is not a read-modify-write: the read never feeds the write.
- **Empty-value convention: `''`** — **the odd one out among the five.** Go/Kk/Ap/Hn all write `null`; Tb writes `''`, matching the `handleArModelMap` reference.
- **File constant:** `TB_MODELMAP_FILE`, defined line 17761 as `path.join(__dirname, 'tabi-modelmap.json')` → `routing/tabi-modelmap.json`.
- **Side effects beyond the write:**
  - `logLine(...)` @ 18531 — `tabi modelmap: …`. Prefix correct.
  - `jsonRes(res, 200, { ok: true, modelMap: mm })` @ 18532.
  - Nothing else — no keepalive restart (Tb's keepalive is :20155), no settings rewrite.
- **Method handling:** unlike the other four, Tb branches on `req.method` internally and has its own GET fallback at 18534. **That GET branch is dead code:** the router answers `GET /__switch/api/tb/modelmap` inline at line 21051 with `jsonRes(res, 200, { ok: true, modelMap: tbReadModelMap() })` and only routes POST to the handler (line 21060). Behaviour is identical either way, so this is cosmetic dead code, not a bug. Same dead-GET shape as the comment at 18519 which advertises "GET/POST".

---

## Cross-cutting findings

### A. All five are full overwrites, all five omit `gpt`

Every one of the five uses the same shape: build a fresh 3-key literal from the request body, then `fs.writeFileSync` it whole. None reads the existing file before writing. Therefore **a `gpt` value present in any of the five target files is erased on the next POST to that tab's modelmap endpoint**, silently and with a 200 response.

Blast radius today is zero-but-fragile: only `ar-modelmap.json` currently holds a `gpt` key, and that file is owned by `handleArModelMap`, which is the only handler that round-trips all four tiers. The bug is latent — it fires the moment a `gpt` tier is introduced into any of gorouter / kktoken / aipm / hcnsec / tabi, whether by hand, by a migration, or by a future 4-tier UI.

The same "fresh literal + writeFileSync" pattern would also drop any *other* future key (comments, version markers, per-tier metadata), not just `gpt`.

### B. The empty-value convention is split 4-vs-1

| Convention | Handlers |
|---|---|
| `null` | `handleGoModelMap`, `handleKkModelMap`, `handleApModelMap`, `handleHnModelMap` |
| `''` | `handleTbModelMap`, and the reference `handleArModelMap` |

Consumers reading these files must treat both as "unset". `mm.opus \|\| '-'` in the log lines handles both, and `goReadModelMap()`-style readers return `{}` on any parse failure, so nothing currently breaks — but a strict `=== null` or `=== ''` check anywhere downstream would be wrong for half the gateways. JSON-wise the two are not interchangeable: `null` survives as `null`, `''` as an empty string.

### C. `handleApModelMap` logs under the wrong gateway name

Line 14743 logs `kktoken modelmap:` while writing `aipm-modelmap.json`. Copy-paste from the KK handler, same lineage as the stale "SSE keepalive proxy для kktoken" comment sitting above the AIPM constants at 13446. Log-only defect; the write target is correct.

### D. Naming trap: `hn` → `hcnsec-modelmap.json`

`HN_MODELMAP_FILE` (line 14799) resolves to `hcnsec-modelmap.json`. The route prefix (`hn`), the log prefix (`hcnsec`), and the filename stem (`hcnsec`) do not share a token with any "haineng" spelling — searching for `haineng-modelmap.json` returns nothing.

### E. Two router shapes for the same endpoint pair

Go / Kk / Ap / Hn: GET answered inline in the router via `xxReadModelMap()`, POST dispatched to the handler. Ar: both methods dispatched to the handler, which branches internally. Tb: router does the inline-GET shape, but the handler *also* carries an internal GET branch, which is therefore unreachable.

---

## Audit hygiene

- No source file was modified by this audit. Only `.routes-audit/handlers-a.md` was written.
- ⚠️ `routing/transparent-proxy.js` was **modified by another process during the audit**: it grew 22152 → 22165 lines and its mtime moved to 2026-09-11 04:21:57, shifting the router-section line numbers (e.g. the `ar/modelmap` routes moved 20841 → 20854). All six handler definition lines and all ten `*_MODELMAP_FILE` constant lines were re-verified after the change and are **unchanged** — every line number in this report was confirmed against the post-edit file. Line numbers for the router dispatch section are quoted post-edit.
- `git status` reports `routing/transparent-proxy.js` as ` M` (dirty working tree), pre-existing and unrelated to this read-only audit.
