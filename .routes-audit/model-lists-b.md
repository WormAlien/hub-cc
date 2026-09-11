# Model lists — group B (tb / xp / jw / sk / ts)

Source: `routing/proxy-dashboard.html` (read-only audit, no files modified).
Question: where does the tier-mapping UI on each provider tab get its selectable models?

## Shared mechanism (applies to all five)

All five tabs use the **same generated-`<select>` pattern**, not datalist, not free text.
The `<div id="<p>-modelmap-sel">` placeholder in the HTML is empty markup; the three
`<select>` elements are injected by `render<P>ModelMap()` via `innerHTML`.

**Lazy tab loading — `showTab(name)`, lines 8607-8616:**

```
if (name === 'tabi')  { if (!state.loaded.tabi)  { state.loaded.tabi  = true; loadTbSessions(false); } tbLoadKeepalive(); }
if (name === 'xpeach'){ if (!state.loaded.xpeach){ state.loaded.xpeach= true; loadXpSessions(false); } xpLoadKeepalive(); }
if (name === 'justwoker') { ... loadJwSessions(false); ... }
if (name === 'seekai')    { ... loadSkSessions(false); ... }
if (name === 'truesota')  { ... loadTsSessions(false); ... }
```

So for every provider in this group: **nothing is fetched at page load.** The catalog is
fetched exactly once, on the **first** open of that provider's tab (the `state.loaded.<p>`
flag makes later opens a no-op). On F5 the restored tab is the exception — that one tab
loads because `showTab` is called during restore.

**Two-phase render (the important subtlety).** `load<P>Sessions()` fires *both*
`load<P>Models()` and `load<P>ModelMap()` without awaiting either. They race:

- `load<P>ModelMap()` → `render<P>ModelMap()` with `state.<p>Models` still empty →
  the selects contain only `''` + the three previously-saved values.
- `load<P>Models()` → `render<P>Models()` → calls `render<P>ModelMap()` **again** at the
  end, this time with the full catalog.

The comment at line 18602 is explicit about why phase 2 matters:
`// как в renderArModels/renderGoModels: без этого селекты маппинга остаются пустыми.`

Consequence: **if the models fetch fails or there are no keys, `render<P>Models()` never
runs and the selects stay at "saved values only".** `load<P>Models()` returns early on
`if (!keys.length)`.

**Option construction** is identical in all five (tb shown, line 18982):

```js
const models = (state.tbModels || []).map(m => m.id);
const opts = [...new Set(['', ...models, mm.opus, mm.sonnet, mm.haiku].filter(v => typeof v === 'string'))];
```

Empty string renders as `— как есть —` (passthrough). Saved targets are always injected
into the option list even if absent from the catalog, so a saved value never silently
disappears.

---

## tabi (tb)

| | |
|---|---|
| Control | three generated `<select>` |
| Element ids | `tb-mm-opus`, `tb-mm-sonnet`, `tb-mm-haiku` |
| Container | `<div id="tb-modelmap-sel">` (line 7321), card `#tb-modelmap` (line 7316) |
| Filler fn | `renderTbModelMap()` — line 18978 |
| Catalog source | `state.tbModels`, filled by `loadTbModels(force)` — line 18562 |
| Endpoint (catalog) | `GET /__switch/api/tb/models?api_key=<key>[&force=1]` — line 18573 |
| Endpoint (saved map) | `GET /__switch/api/tb/modelmap` — line 18970 (`loadTbModelMap`, line 18968) |
| Save | `tbSaveModelMap()` line 18995 → `POST /__switch/api/tb/modelmap` |
| When filled | first open of the **tabi** tab → `loadTbSessions(false)` (line 18529) → `loadTbModels()` + `loadTbModelMap()` (lines 18541-18542). Also on `↻ Обновить` / `📡 Пинг статусов` (lines 7375-7376) and the `↻` model-refresh buttons `loadTbModels(true)` (lines 7308, 7319). |
| Entry shape | **object with `id`** — `models.map(m => m.id)` (18980); `renderTbModels` also reads `m.id` (18592) |

Notable: `loadTbModels` walks **every** key (active first) and stops at the first key that
returns a non-empty `models` array; if all fail it writes `lastNote` into `#tb-models-list`
and `renderTbModels` is never called, leaving the selects catalog-less.

---

## xpeach (xp)

The tab is **not broken and not missing** — it is a complete clone of the tabi
implementation, with one extra feature (dead-model annotation). Two things are true and
should not be confused with each other:

1. `routing/xpeach-modelmap.json` **exists** (48 bytes, valid JSON) but every tier is an
   empty string: `{"opus":"","sonnet":"","haiku":""}`. Empty = passthrough
   (`— как есть — (дефолт)`), which is a *configured* state, not a corrupt one.
2. The nav button lives in a collapsed group `data-extra-nav="memory"` titled
   **«Чтим память»** (line 729-739) — a graveyard group, `class="hidden"` by default,
   expanded only by clicking the ▶ chevron. Tooltip on the button:
   `все ключи 403 banned — регистрация больше не проходит`.

| | |
|---|---|
| Control | three generated `<select>` |
| Element ids | `xp-mm-opus`, `xp-mm-sonnet`, `xp-mm-haiku` |
| Container | `<div id="xp-modelmap-sel">` (line 7494), card `#xp-modelmap` (line 7475) |
| Filler fn | `renderXpModelMap()` — line 19516 |
| Catalog source | `state.xpModels`, filled by `loadXpModels(force)` — line 19090 |
| Endpoint (catalog) | `GET /__switch/api/xp/models?api_key=<key>[&force=1]` — line 19101 |
| Endpoint (saved map) | `GET /__switch/api/xp/modelmap` — line 19508 (`loadXpModelMap`, line 19506) |
| Save | `xpSaveModelMap()` line 19533 → `POST /__switch/api/xp/modelmap` |
| When filled | first open of the **xpeach** tab → `loadXpSessions(false)` (line 19057) → `loadXpModels()` + `loadXpModelMap()` (lines 19069-19070). Also `↻ Обновить` / `📡 Пинг статусов` (7452-7453) and `loadXpModels(true)` (7467, 7478). Because the tab sits in a collapsed group, reaching it needs **two** clicks: expand «Чтим память», then the tab. |
| Entry shape | **object with `id`** — `models.map(m => m.id)` (19518). Also reads `m.supported_endpoint_types` (19133) to badge OpenAI-only models |

**Practical consequence of the two facts combined:** with all tiers saved as `''`, the
saved-value injection into `opts` contributes nothing, so the option list is exactly
`['', ...catalog]`. If the keys are indeed 403-banned, `loadXpModels` never reaches
`renderXpModels`, `state.xpModels` stays empty, and the three selects render with a
**single** option — `— как есть — (дефолт)`. That looks like a broken UI but is the
correct output of a working code path fed an empty catalog.

Unique to xp: `XP_DEAD_MODELS` (line 19115) hand-maintained blacklist. Dead ids get a
` 💀 нет канала` suffix inside the option label (19523) and `xpSaveModelMap` raises a
`confirm()` before saving one (19540-19542).

---

## justwoker (jw)

Same generated-`<select>` pattern. Its tab is in the **main** nav group (not the graveyard).

| | |
|---|---|
| Control | three generated `<select>` |
| Element ids | `jw-mm-opus`, `jw-mm-sonnet`, `jw-mm-haiku` |
| Container | `<div id="jw-modelmap-sel">` (line 6363), card `#jw-modelmap` (line 6358) |
| Filler fn | `renderJwModelMap()` — line 17289 |
| Catalog source | `state.jwModels`, filled by `loadJwModels(force)` — line 16870 |
| Endpoint (catalog) | `GET /__switch/api/jw/models?api_key=<key>[&force=1]` — line 16881 |
| Endpoint (saved map) | `GET /__switch/api/jw/modelmap` — line 17281 (`loadJwModelMap`, line 17279) |
| Save | `jwSaveModelMap()` line 17309 → `POST /__switch/api/jw/modelmap` |
| When filled | first open of the **justwoker** tab → `loadJwSessions(false)` (line 16838) → `loadJwModels()` + `loadJwModelMap()` (lines 16849-16850). Also `↻ Обновить` / `📡 Пинг статусов` (6429-6430), `loadJwModels(false)` (6361) and `loadJwModels(true)` (6419). Re-fired after most mutations (`jwAutoAddOne` 14319, delete 17043, etc.) |
| Entry shape | **object with `id`** — `models.map(m => m.id)` (17291) |

`routing/justwoker-modelmap.json` on disk is populated and non-Claude:
`{"opus":"gpt-5.6-sol","sonnet":"gpt-5.6-luna","haiku":"gpt-5.6-terra"}` (modified today).

**jw carries the canonical explanation of why saved values are force-injected into
`opts`** (lines 17292-17295) — worth quoting because it documents a real data-loss bug the
pattern fixes:

> Сохранённые цели держим в опциях ВСЕГДА: `/go/models` ходит в апстрим и приезжает
> позже локального modelmap, а select без своей option показывает «— как есть —»,
> т.е. маппинг выглядит выключённым, хотя `justwoker-modelmap.json` на месте (и
> 💾 Сохранить в этот момент затирал его null'ами).

I.e. the race between the two un-awaited fetches used to let a user press 💾 Сохранить
during the window where the catalog had not arrived, and `$('jw-mm-opus').value` would
read the placeholder `''`, wiping a valid saved mapping.

---

## seekai (sk)

Byte-for-byte the same pattern as jw (including the copied `/go/models` comment, which is
stale — sk fetches `/sk/models`, not `/go/models`). Tab lives in the collapsed
**«Чтим память»** group (line 740), tooltip:
`реселл веб-Клода под видом API: свой system-промпт шлюза перебивает наш, для Claude Code непригоден (замер 24.08)`.

| | |
|---|---|
| Control | three generated `<select>` |
| Element ids | `sk-mm-opus`, `sk-mm-sonnet`, `sk-mm-haiku` |
| Container | `<div id="sk-modelmap-sel">` (line 6518), card `#sk-modelmap` (line 6513) |
| Filler fn | `renderSkModelMap()` — line 17830 |
| Catalog source | `state.skModels`, filled by `loadSkModels(force)` — line 17414 |
| Endpoint (catalog) | `GET /__switch/api/sk/models?api_key=<key>[&force=1]` — line 17425 |
| Endpoint (saved map) | `GET /__switch/api/sk/modelmap` — line 17822 (`loadSkModelMap`, line 17820) |
| Save | `skSaveModelMap()` line 17851 → `POST /__switch/api/sk/modelmap` |
| When filled | first open of the **seekai** tab → `loadSkSessions(false)` (line 17382) → `loadSkModels()` + `loadSkModelMap()` (lines 17393-17394). Also `↻ Обновить` / `📡 Пинг статусов` (6583-6584), `loadSkModels(false)` (6516), `loadSkModels(true)` (6574). Two clicks to reach — group is collapsed |
| Entry shape | **object with `id`** — `models.map(m => m.id)` (17832) |

`routing/seekai-modelmap.json`: `{"opus":"claude-opus-5","sonnet":"claude-sonnet-5","haiku":"claude-fable-5"}`, last modified **Aug 24** — stale, matching the "unusable for Claude Code" verdict in the nav tooltip.

---

## truesota (ts)

Same pattern again (same stale `/go/models` comment). Tab in the collapsed
**«Чтим память»** group (line 744), tooltip:
`sub2api: подписочная квота как API. Годятся только claude-opus-5 и claude-opus-5-thinking — остальные модели каталога подменяют системный промпт промптом Kiro`.

| | |
|---|---|
| Control | three generated `<select>` |
| Element ids | `ts-mm-opus`, `ts-mm-sonnet`, `ts-mm-haiku` |
| Container | `<div id="ts-modelmap-sel">` (line 6672), card `#ts-modelmap` (line 6667) |
| Filler fn | `renderTsModelMap()` — line 18449 |
| Catalog source | `state.tsModels`, filled by `loadTsModels(force)` — line 17963 |
| Endpoint (catalog) | `GET /__switch/api/ts/models?api_key=<key>[&force=1]` — line 17974 |
| Endpoint (saved map) | `GET /__switch/api/ts/modelmap` — line 18441 (`loadTsModelMap`, line 18439) |
| Save | `tsSaveModelMap()` line 18470 → `POST /__switch/api/ts/modelmap` |
| When filled | first open of the **truesota** tab → `loadTsSessions(false)` (line 17931) → `loadTsModels()` + `loadTsModelMap()` (lines 17942-17943). Also `↻ Обновить` / `📡 Пинг статусов` (6737-6738), `loadTsModels(false)` (6670), `loadTsModels(true)` (6728). Two clicks to reach — group is collapsed |
| Entry shape | **object with `id`** — `models.map(m => m.id)` (18451) |

**ts is the one asymmetry in the group: it has no `state` initializer slots.** The state
object (lines 8396-8429) declares `arModelMap / goModelMap / jwModelMap / skModelMap /
kkModelMap / hnModelMap / tbModelMap / xpModelMap` and `arModels / goModels / jwModels /
skModels / kkModels / hnModels / tbModels / xpModels`, plus `truesota: []` (line 8409) —
but **no `tsModels`, no `tsActiveModel`, no `tsModelMap`**. Those three properties are
created implicitly on first write (`state.tsModels = models` at 17984,
`state.tsModelMap = data.modelMap || {}` at 18444).

This is currently harmless — every read site is guarded (`state.tsModelMap || {}` at 18450,
`(state.tsModels || [])` at 18451, `state.tsModelMap || {}` at 18026) — but it is a latent
trap for any future code that reads these before the first load, and it breaks the
copy-paste symmetry the other nine providers rely on.

`routing/truesota-modelmap.json`: `{"opus":"claude-opus-5","sonnet":"claude-opus-5","haiku":"claude-opus-5"}`, last modified **Aug 25** — all three tiers pinned to `claude-opus-5`, consistent with the "only opus-5 works" tooltip.

---

## Cross-check: no datalist, no free-text anywhere in this group

- The only `<datalist>` in the entire file is line 11092, and it belongs to the **custom**
  provider UI (`custom-mm-list-<providerId>`), not to any of these five.
- The `<div id="<p>-modelmap-sel">` elements in static HTML are empty containers; grepping
  for `<p>-mm-<tier>` finds hits only inside template literals and inside the
  `$('<p>-mm-<tier>')?.value` read in the save functions. No static `<input>` or `<select>`
  markup exists for any of the five.
- Filenames on disk use the **full provider name**, not the two-letter code:
  `tabi-modelmap.json`, `xpeach-modelmap.json`, `justwoker-modelmap.json`,
  `seekai-modelmap.json`, `truesota-modelmap.json`. (`tb-modelmap.json` etc. do not exist.)
