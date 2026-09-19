#!/usr/bin/env bash
# Autoreger statusline: provider/model │ $217.33~ │ ⧉ 139k/1M
set -u

# ---- stdin from Claude Code: model info -----------------------------------
# Первично берём payload из env STATUSLINE_PAYLOAD (кладёт его wrapper-команда
# из settings.json ДО запуска скрипта — надёжнее, чем гонять пайп через
# wslpath/cygpath, которые могут украсть stdin). Если env нет — читаем stdin,
# но ПЕРВЫМ делом, до любых subprocess-ов: WSL-интероп cmd.exe жрёт stdin-пайп,
# и потом cat не получает ничего → model_id "unknown" и мерцающий статус.
# timeout на cat: без payload в env и с открытым-но-пустым stdin cat блокируется
# НАВСЕГДА → CC убивает statusline по своему таймауту → бар пропадает целиком
# (и контекст, и баланс). 2с — потолок, обычно env есть и cat не вызывается.
#
# ВАЖНО: `timeout` — из GNU coreutils, на macOS его НЕТ. Раньше здесь стоял
# `timeout 2 cat`, и на маке подстановка молча давала пустую строку: model_id
# становился «unknown», а контекстное окно не показывалось вообще (поймано на
# живом маке 2026-08-20). Поэтому читаем bash-native `read -t` — без внешних
# утилит и без форка, работает и в git-bash, и в bash 3.2 из macOS.
payload="${STATUSLINE_PAYLOAD:-}"
if [ -z "$payload" ]; then
    IFS= read -r -d '' -t 2 payload 2>/dev/null || true
    payload="${payload:-}"
fi

# ---- дата: GNU и BSD расходятся, а на маке date только BSD ------------------
# `date -d <ISO>` — GNU-синтаксис; у BSD -d это флаг летнего времени, и разбор
# ISO падает. `date +%s%3N` (миллисекунды) BSD тоже не умеет — оставляет «%3N»
# в строке, из-за чего арифметика возраста кеша ломалась молча.
_iso_epoch() {   # ISO8601 → epoch, 0 если не разобрали
    local iso="$1" s
    s="$(date -d "$iso" +%s 2>/dev/null)" && [ -n "$s" ] && { printf '%s' "$s"; return 0; }
    iso="${iso%%.*}"; iso="${iso%Z}"; iso="${iso%%+*}"
    date -j -u -f '%Y-%m-%dT%H:%M:%S' "$iso" +%s 2>/dev/null || echo 0
}
_now_ms() {      # epoch в миллисекундах; на BSD добиваем нулями до секунды
    local s
    s="$(date +%s%3N 2>/dev/null)"
    case "$s" in
        ''|*[!0-9]*) printf '%s000' "$(date +%s)" ;;
        *)           printf '%s' "$s" ;;
    esac
}

# ROOT = корень репо (скрипт лежит в <repo>/routing/). ${BASH_SOURCE%/*} вместо
# $(dirname) — без форка.
_self="${BASH_SOURCE[0]}"
_dir="${_self%/*}"
ROOT="$(cd "$_dir/.." && pwd)"
ROUTING="$ROOT/routing"
LOGS="$ROOT/logs"

# отладка: `touch logs/.statusline-debug` → сырой payload от CC копится в .jsonl
[ -f "$LOGS/.statusline-debug" ] && printf '%s\n' "$payload" >> "$LOGS/.statusline-debug.jsonl"

# ---- home пользователя (WSL/MSYS-совместимо) ------------------------------
# `bash` в PATH у нас WSL-шный: $HOME=/home/wormalien, а .claude лежит в
# C:\Users\WormAlien. Если настроек по $HOME нет — берём Windows-профиль
# через cmd.exe %USERPROFILE% и конвертируем wslpath/cygpath.
if [ -f "$HOME/.claude/settings.json" ]; then
    PROF="$HOME"
else
    up="$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')"
    if [ -n "$up" ]; then
        if command -v wslpath >/dev/null 2>&1; then PROF="$(wslpath -u "$up")"
        elif command -v cygpath >/dev/null 2>&1; then PROF="$(cygpath -u "$up")"
        else PROF="$HOME"
        fi
    else
        PROF="$HOME"
    fi
fi
SETTINGS="$PROF/.claude/settings.json"

# curl, который достаёт localhost Windows-хоста и из WSL, и из git-bash:
# curl.exe (Windows-native) работает в обоих, plain curl в WSL2 туда не ходит.
if command -v curl.exe >/dev/null 2>&1; then CURL_BIN="curl.exe"; else CURL_BIN="curl"; fi

# ---- payload → поля (bash-native regex, БЕЗ форков) ------------------------
# Раньше это были 6 вызовов sed|head. Каждый форк на Windows ~30-60мс, statusline
# зовётся часто и с таймаутом → скрипт должен быть быстрым. =~ читает всё in-proc.
model_id=""
if [[ "$payload" =~ \"model\"[^}]*\"id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    model_id="${BASH_REMATCH[1]}"
elif [[ "$payload" =~ \"display_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    model_id="${BASH_REMATCH[1]}"
fi
[ -z "$model_id" ] && model_id="unknown"

# context window: used_percentage приходит готовым (CC ≥2.1.132)
ctx_pct=""; [[ "$payload" =~ \"used_percentage\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && ctx_pct="${BASH_REMATCH[1]}"
ctx_tok=""; [[ "$payload" =~ \"total_input_tokens\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && ctx_tok="${BASH_REMATCH[1]}"
ctx_max=""; [[ "$payload" =~ \"context_window_size\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && ctx_max="${BASH_REMATCH[1]}"

# /effort: уровень усилий ИМЕННО ЭТОЙ сессии. Источник — payload, а не
# settings.json: `effortLevel` в настройках это лишь дефолт для новых сессий, а
# `/effort` в живой сессии его не переписывает (и `ultracode` не пишет вообще).
# Поэтому по файлу настроек нельзя понять, что выбрано в текущем окне — ради
# этого блок и появился. Поле приходит только у моделей, поддерживающих effort:
# нет поля → ничего не рисуем.
# Значения: low | medium | high | xhigh | max (CC: `CD=["low","medium","high","xhigh","max"]`).
# 🪤 `ultracode` в бар не доедет: CC разворачивает его в `xhigh` до отправки
# payload (`qoe()` → `effortValue = "xhigh"`), отдельного флага в payload нет.
# Поэтому «ultracode» и «xhigh» в баре выглядят одинаково — фиолетовым.
effort=""
[[ "$payload" =~ \"effort\"[^}]*\"level\"[[:space:]]*:[[:space:]]*\"([a-z]+)\" ]] && effort="${BASH_REMATCH[1]}"

# git-воркtree: имя, если сессия открыта не в основном рабочем дереве. Поле
# `workspace.git_worktree`, а НЕ верхнеуровневый объект `worktree` — тот приходит
# только у воркtree, созданных самим CC (`EnterWorktree`), и за месяц отладочного
# лога не пришёл ни разу. А `git_worktree` пришёл 655 раз: так выглядят рабочие
# копии Orca (`orca\workspaces\<репо>\<имя>`). Зачем в баре: при нескольких
# открытых окнах по одному репо перепутать, в каком дереве правишь, — вопрос
# времени, и цена ошибки — правка в чужую ветку.
worktree=""
[[ "$payload" =~ \"git_worktree\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && worktree="${BASH_REMATCH[1]}"

# ---- active provider: из settings.json (bash-native, БЕЗ сети) ------------
# Раньше тут был блокирующий `curl :8200` в КАЖДОМ вызове statusline — сеть в
# горячем пути. Провайдер однозначно определяется по apiKeyHelper/ANTHROPIC_BASE_URL
# в settings.json, читаем файл целиком в память и парсим =~ (0 форков, 0 сети).
raw_target=""
settings_raw=""
[ -f "$SETTINGS" ] && settings_raw="$(<"$SETTINGS")"
helper=""; [[ "$settings_raw" =~ \"apiKeyHelper\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && helper="${BASH_REMATCH[1]}"
# Команда helper'а — это node -e "…" с ЭКРАНИРОВАННЫМИ кавычками внутри JSON, а
# захват выше обрывается на первом `\`. Поэтому если имени key-файла в захвате нет,
# ищем его во всём тексте settings.json: правила ниже всё равно матчат подстрокой.
case "$helper" in
    *-active-key.txt*) ;;
    *) [[ "$settings_raw" == *'"apiKeyHelper"'* ]] && helper="$settings_raw" ;;
esac
base_url=""; [[ "$settings_raw" =~ \"ANTHROPIC_BASE_URL\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && base_url="${BASH_REMATCH[1]}"
# Режим front-door: base URL всегда :20100, поэтому провайдера по нему уже не
# опознать — источник правды переезжает в ~/.claude/active-backend.json (его пишет
# writeSettings() дашборда). Читаем файл целиком в память, как и settings.json:
# 0 форков, 0 сети. Правила ниже остаются фолбэком для прямого режима.
case "$base_url" in
    *:20100|*:20100/*)
        fd_state=""
        [ -f "$PROF/.claude/active-backend.json" ] && fd_state="$(<"$PROF/.claude/active-backend.json")"
        if [[ "$fd_state" =~ \"backend\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
            raw_target="${BASH_REMATCH[1]}"
        else
            raw_target="frontdoor"      # прокси есть, состояния нет — так и скажем
        fi
        ;;
esac
# ---- Шлюз назван в имени модели: `aipm/claude-opus-4-6[1m]` и `agentrouter[1m]` ---
# Такой запрос уехал НЕ к активному бэкенду, а к названному шлюзу (routeByModel в
# frontdoor-proxy.js). Бар обязан показать фактический маршрут — иначе получится
# двойной провайдер `agentrouter/aipm/claude-opus-4-6`, а стрелка маппинга ниже
# возьмёт тир-карту глобального бэкенда для трафика, ушедшего совсем в другое место.
#
# Форм ДВЕ, и различать их обязательно (заявка владельца 12.09):
#   `aipm/claude-opus-4-6[1m]` — шлюз назван И модель названа;
#   `agentrouter[1m]`          — назван ТОЛЬКО шлюз, модель выбирает routes-карта.
# 🪤 Вторая форма до 13.09 здесь не распознавалась (`case */*)` требовал слэш), и бар
# врал сразу трижды: провайдер брался от АКТИВНОГО бэкенда, поэтому имя шлюза уезжало
# во вторую половину строки и печаталось дважды (`agentrouter/agentrouter[1m]`), баланс
# считался для чужого шлюза, а стрелки развёртки не было вовсе.
#
# Реестр читаем целиком в память, как settings.json выше: 0 форков, 0 сети. Блокирующий
# `curl :8200` отсюда убран намеренно (см. коммент на :119) — возвращать его нельзя.
#
# 🪤 Имя обязано быть КЛЮЧОМ (`"aipm":`), а не просто подстрокой: в том же файле лежит
# `"modelmap": "aipm-modelmap.json"`, и поиск по голому `aipm` совпадал бы всегда.
#
# Алиас (`ar`) резолвим в полное имя ЗНАЧЕНИЕМ ключа: у провайдера значение — объект
# (`"aipm": {`), regex на строку не сматчится и останется само имя; у алиаса значение —
# строка (`"ar": "agentrouter"`), и мы берём её. Это важно: подписи и `map_prefix` ниже
# знают только полные имена, короткий `ar` провалился бы в catch-all без тир-карты.
route_prefixed=0   # 1 = шлюз назван в имени модели (любой из двух форм) → routes-карта
route_bare=0       # 1 = модель НЕ названа → тир `default`, печатать второе слово нечем
win_suffix=""      # `[1m]` источника; на цель переносится как в upstreamModelFor()
case "$model_id" in *'[1m]') win_suffix="[1m]" ;; esac
case "$model_id" in
    */*) mp_head="${model_id%%/*}"; mp_bare=0 ;;
    # 🪤 Голое имя: суффикс окна снимаем ПЕРЕД поиском в реестре — ровно как
    # routeByModel (frontdoor-proxy.js:386). `normalizeCcModel` вешает `[1m]` на всё
    # похожее на 1M-модель, поэтому `agentrouter[1m]` возникает сам собой, и без среза
    # имя в реестре не нашлось бы. `%%\[*` вместо regex: bash 3.2 без `${x//}`-магии.
    *)   mp_head="${model_id%%\[*}"; mp_bare=1 ;;
esac
# Обычное имя модели (`claude-opus-5`) сюда тоже заходит и обязано ничего не менять:
# ключа с таким именем в реестре нет, ветка молчит. Так же устроен и front-door — он
# ищет в реестре КАЖДОЕ имя без слэша (`reg.get(bare)`), а промах считает штатным.
#
# 🪤 Регистр имени не важен: front-door кладёт ключи реестра в нижнем регистре и ищет
# `reg.get(bare.toLowerCase())` (frontdoor-proxy.js:230/401/434), поэтому `/model AIPM/…`
# у него уезжает на aipm, а бар без `nocasematch` показывал бы такой запрос как обычную
# модель на активном шлюзе — то есть врал бы про маршрут. `${x,,}` для этого нельзя:
# bash 4+, а скрипт держит 3.2 (macOS). `shopt nocasematch` есть и в 3.2.
# Включаем ТОЛЬКО на этот блок: ниже по файлу есть `case` с регистро-зависимыми
# шаблонами (`Custom*`, `*[Oo]pus*`), и глобальный nocasematch их поведение изменил бы.
shopt -s nocasematch
mp_hit=""      # имя шлюза, найденное в реестре; пусто = имя не наше
if [[ "$mp_head" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    mp_reg=""
    [ -f "$PROF/.claude/backends.json" ] && mp_reg="$(<"$PROF/.claude/backends.json")"
    if [ -n "$mp_reg" ] && [[ "$mp_reg" == *"\"$mp_head\":"* ]]; then
        # Имя берём КАНОНИЧНЫМ написанием ИЗ ФАЙЛА (первая группа), а не как его набрал
        # человек: подписи ниже (`case "$raw_target"`) и `map_prefix` сравнивают точные
        # строки, и `AIPM` провалился бы в catch-all без тир-карты и без баланса.
        if [[ "$mp_reg" =~ \"($mp_head)\"[[:space:]]*:[[:space:]]*\"([A-Za-z0-9_.-]+)\" ]]; then
            mp_hit="${BASH_REMATCH[2]}"         # алиас → полное имя (значение ключа)
        elif [[ "$mp_reg" =~ \"($mp_head)\"[[:space:]]*: ]]; then
            mp_hit="${BASH_REMATCH[1]}"         # сам провайдер
        fi
    fi
    # 🪤 Проверять `[ -n "$raw_target" ]` здесь НЕЛЬЗЯ: блок front-door выше уже заполнил
    # его активным бэкендом из `active-backend.json`, поэтому такое условие было бы верным
    # для ЛЮБОГО имени модели — и обычный `claude-opus-5` объявился бы шлюзом. Признак
    # попадания только один: имя нашлось в реестре (`mp_hit`).
    if [ -n "$mp_hit" ]; then
        raw_target="$mp_hit"
        route_prefixed=1
        if [ "$mp_bare" = "1" ]; then
            route_bare=1
            model_id=""                         # модель не названа — печатать нечего
            # 🪤 Путь routes-карты берём ИЗ ЗАПИСИ РЕЕСТРА, а не из своей таблицы
            # префиксов: front-door выводит его ровно так — `routesMapFor()`
            # (frontdoor-proxy.js:376) делает `state.modelmap.replace(/-modelmap\.json$/,
            # '-routes-modelmap.json')`, а при `modelmap: null` возвращает null и отвечает
            # 400 «default не задан». Замер 13.09: в живом реестре у agentrouter лежит
            # именно `null` (реестр писал старый `transparent-proxy.js`, до рестарта
            # :8200), и по своей таблице бар нарисовал бы развёртку на запросе, который
            # фактически вернёт 400. Пустой `mp_map` ниже = «карты нет» — так и покажем.
            #
            # Ищем поле внутри блока СВОЕГО провайдера: `raw_target` уже полное имя, а
            # значение алиаса — строка, поэтому от хвоста после `"agentrouter":` до первой
            # `}`. Без этого сузить нельзя — `"modelmap"` есть у каждого провайдера.
            mp_map=""
            mp_tail="${mp_reg#*\"$raw_target\":}"
            mp_blk="${mp_tail%%\}*}"
            if [[ "$mp_blk" =~ \"modelmap\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
                mp_map="${BASH_REMATCH[1]}"
            fi
        else
            model_id="${model_id#*/}"
        fi
    fi
fi
# Обратно СРАЗУ: ниже `case "$raw_target"`, `Custom*` и `*[Oo]pus*` — регистро-зависимые,
# и при включённом nocasematch провайдер `custom` совпал бы с шаблоном `Custom*`, получив
# подпись `Custom🧪` вместо своей.
shopt -u nocasematch
if [ -z "$raw_target" ]; then
case "$helper" in
    *fm-active-key.txt*|*freemodel*) raw_target="apihelper" ;;
    *al-active-key.txt*)             raw_target="aerolink" ;;
    *cdt-active-key.txt*)            raw_target="conduit" ;;
    *ev-active-key.txt*)             raw_target="evomap" ;;
    *ot-active-key.txt*)             raw_target="ourtoken" ;;
    *om-active-key.txt*)             raw_target="omniroute" ;;
    *vyceai-active-key.txt*)         raw_target="vyce_openai" ;;
    *ar-active-key.txt*)             raw_target="agentrouter" ;;
    *tabi-active-key.txt*)           raw_target="tabi" ;;
    *gorouter-active-key.txt*)       raw_target="gorouter" ;;
    *xpeach-active-key.txt*)         raw_target="xpeach" ;;
    *justwoker-active-key.txt*)      raw_target="justwoker" ;;
    *seekai-active-key.txt*)         raw_target="seekai" ;;
    *truesota-active-key.txt*)       raw_target="truesota" ;;
    *kktoken-active-key.txt*)        raw_target="kktoken" ;;
    *hcnsec-active-key.txt*)         raw_target="hcnsec" ;;
    *aipm-active-key.txt*)           raw_target="aipm" ;;
    *aikeysapi-active-key.txt*)      raw_target="aikeysapi" ;;
    *rumeng-active-key.txt*)         raw_target="rumeng" ;;
    *wisdomsatan-active-key.txt*)    raw_target="wisdomsatan" ;;
    *custom-active-key.txt*)         raw_target="custom" ;;
esac
if [ -z "$raw_target" ]; then
    case "$base_url" in
        https://api.ourtoken.ai*) raw_target="ourtoken" ;;
        *localhost:20128*)        raw_target="omniroute" ;;
        *localhost:20131*)        raw_target="vyce_openai" ;;
        *localhost:20132*|*localhost:20133*)  raw_target="agentrouter" ;;
        *127.0.0.1:20132*|*127.0.0.1:20133*)  raw_target="agentrouter" ;;
        *localhost:20155*)        raw_target="tabi" ;;
        *localhost:20156*)        raw_target="gorouter" ;;
        *127.0.0.1:20155*)        raw_target="tabi" ;;
        *127.0.0.1:20156*)        raw_target="gorouter" ;;
        # :20157 обязан стоять ДО catch-all Custom-конвертеров ниже (2015[0-9]),
        # иначе xpeach определялся бы как custom. То же и :20158 (justwoker), :20159 (seekai).
        *localhost:20157*)        raw_target="xpeach" ;;
        *127.0.0.1:20157*)        raw_target="xpeach" ;;
        *localhost:20158*)        raw_target="justwoker" ;;
        *127.0.0.1:20158*)        raw_target="justwoker" ;;
        *localhost:20159*)        raw_target="seekai" ;;
        *127.0.0.1:20159*)        raw_target="seekai" ;;
        *localhost:20160*)        raw_target="truesota" ;;
        *127.0.0.1:20160*)        raw_target="truesota" ;;
        *localhost:20161*)        raw_target="kktoken" ;;
        *127.0.0.1:20161*)        raw_target="kktoken" ;;
        # :20162 (hcnsec) — тоже ВЫШЕ catch-all Custom-конвертеров: шаблон
        # `*localhost:201[6-9][0-9]*` съедает весь диапазон 20160–20199, и без явной
        # пары строк шлюз показывался бы как `Custom🧪`.
        *localhost:20162*)        raw_target="hcnsec" ;;
        *127.0.0.1:20162*)        raw_target="hcnsec" ;;
        *localhost:20163*)        raw_target="aipm" ;;
        *127.0.0.1:20163*)        raw_target="aipm" ;;
        # :20164 (wisdomsatan) — та же причина, что у :20162 выше: без явной пары строк
        # порт попадает под catch-all `*localhost:201[6-9][0-9]*` и шлюз показывается
        # как `Custom🧪`.
        *localhost:20164*)        raw_target="wisdomsatan" ;;
        *127.0.0.1:20164*)        raw_target="wisdomsatan" ;;
        *localhost:20165*)        raw_target="aikeysapi" ;;
        *127.0.0.1:20165*)        raw_target="aikeysapi" ;;
        *localhost:20166*)        raw_target="rumeng" ;;
        *127.0.0.1:20166*)        raw_target="rumeng" ;;
        *tabitoken.com*)          raw_target="tabi" ;;
        *gorouter.app*)           raw_target="gorouter" ;;
        *xpeach.codes*)           raw_target="xpeach" ;;
        *justwoker.icu*)          raw_target="justwoker" ;;
        *seekai.cc*)              raw_target="seekai" ;;
        *true-sota.com*)          raw_target="truesota" ;;
        *kktoken.cc*)             raw_target="kktoken" ;;
        *api.hcnsec.cn*)          raw_target="hcnsec" ;;
        *aipm9527.online*)        raw_target="aipm" ;;
        *api.wisdomsatan.club*)   raw_target="wisdomsatan" ;;
        *localhost:8190*)         raw_target="notion" ;;
        *agentrouter.org*)        raw_target="agentrouter" ;;
        *cc.freemodel.dev*)       raw_target="apihelper" ;;
        # Custom OpenAI Proxy (Anthropic→OpenAI конвертер) — порты 20150–20250
        *localhost:2015[0-9]*|*localhost:201[6-9][0-9]*|*localhost:202[0-5][0-9]*)  raw_target="custom" ;;
    esac
fi
fi   # закрывает ветку «front-door не сработал»

# LABELS mirror proxy-dashboard.html:1261 (lowercased for /model format)
case "$raw_target" in
    apihelper|freemodel_rotator) provider="freemodel" ;;
    omniroute)                   provider="omniroute" ;;
    agentrouter)                 provider="agentrouter" ;;
    notion)                      provider="notion" ;;
    aerolink)                    provider="aerolink" ;;
    evomap)                      provider="evomap" ;;
    ourtoken)                    provider="ourtoken" ;;
    conduit)                     provider="conduit" ;;
    vyce_openai)                 provider="vyceai" ;;
    tabi)                        provider="tabi" ;;
    gorouter)                    provider="gorouter" ;;
    xpeach)                      provider="xpeach" ;;
    justwoker)                   provider="justwoker" ;;
    seekai)                      provider="seekai" ;;
    truesota)                    provider="truesota" ;;
    aikeysapi)                  provider="aikeysapi" ;;
    rumeng)                      provider="rumeng" ;;
    kktoken)                     provider="kktoken" ;;
    hcnsec)                      provider="hcnsec" ;;
    aipm)                        provider="aipm" ;;
    wisdomsatan)                 provider="wisdomsatan" ;;
    custom)                      provider="Custom🧪" ;;
    "")                          provider="unknown" ;;
    *)                           provider="$raw_target" ;;
esac

# ---- modelmap: показать фактическую модель, если тир-карта переписывает ----
# Читаем тир-карту (тот же файл, что keepalive-proxy), матчим тир модели из payload,
# и если карта подменяет имя — дописываем →target в рендер.
# БЕЗ форков: jq/python не зовём, разбираем JSON двумя regex.
#
# 🪤 Карт ДВЕ, и путь определяет, какую брать (инвариант 12.09, вика «Маршруты — своя
# тир-карта и имя без модели»): `<prefix>-modelmap.json` обслуживает запрос БЕЗ имени
# шлюза (окно сидит на активном бэкенде), `<prefix>-routes-modelmap.json` — запрос, где
# шлюз назван. Это ровно `readModelMap(routes)` из keepalive-proxy.js:127, куда флаг
# приезжает заголовком `x-route-prefixed` от front-door. Прочитать не ту карту — значит
# показать модель, которой в этом запросе нет.
map_target=""
if [ -n "$provider" ] && [ "$model_id" != "unknown" ] \
   && { [ -n "$model_id" ] || [ "$route_bare" = "1" ]; }; then
    # CC_MODEL_PREFIX из transparent-proxy.js (урезанная копия — только провайдеры
    # с keepalive, у которых маппинг работает).
    map_prefix=""
    case "$provider" in
        agentrouter) map_prefix="ar" ;;
        gorouter)    map_prefix="gorouter" ;;
        tabi)        map_prefix="tabi" ;;
        xpeach)      map_prefix="xpeach" ;;
        justwoker)   map_prefix="justwoker" ;;
        seekai)      map_prefix="seekai" ;;
        truesota)    map_prefix="truesota" ;;
        aikeysapi)  map_prefix="aikeysapi" ;;
        rumeng)      map_prefix="rumeng" ;;
        kktoken)     map_prefix="kktoken" ;;
        hcnsec)      map_prefix="hcnsec" ;;
        aipm)        map_prefix="aipm" ;;
        wisdomsatan) map_prefix="wisdomsatan" ;;
        Custom*)     map_prefix="custom" ;;
    esac
    if [ -n "$map_prefix" ] || [ "$route_bare" = "1" ]; then
        if [ "$route_bare" = "1" ]; then
            # Голое имя обслуживает front-door, и карту он берёт из поля реестра (см.
            # 🪤 выше). Относительный путь резолвится от `routing/` — как `path.join(
            # __dirname, file)` в readModelMap (frontdoor-proxy.js:265).
            mmf=""
            case "$mp_map" in
                "")            mmf="" ;;                       # modelmap: null → 400
                /*|[A-Za-z]:*) mmf="${mp_map%-modelmap.json}-routes-modelmap.json" ;;
                *)             mmf="$ROUTING/${mp_map%-modelmap.json}-routes-modelmap.json" ;;
            esac
        elif [ "$route_prefixed" = "1" ]; then
            mmf="$ROUTING/${map_prefix}-routes-modelmap.json"
        else
            mmf="$ROUTING/${map_prefix}-modelmap.json"
        fi
        if [ -n "$mmf" ] && [ -f "$mmf" ]; then
            mm_raw="$(<"$mmf")"
            # определяем тир модели (зеркало TIER_RE + isGptLike из keepalive-proxy.js)
            #
            # 🪤 gpt проверяется ПЕРВЫМ и отдельно от тиров — ровно так же, как в прокси:
            # ветка isGptLike() там стоит ДО маппинга тиров (keepalive-proxy.js:1192,
            # «gpt-модели уходят на конвертер всегда — до и независимо от маппинга»),
            # и `mm.gpt` перебивает всё остальное. Без этой ветки бар печатал
            # `agentrouter/gpt-5.6-sol[1m]` на запросе, который прокси уже переписал в
            # `claude-opus-5[1m]` — то есть врал про фактическую модель ровно в том
            # случае, ради которого стрелка и заведена (поймано владельцем 2026-09-11).
            #
            # Классы посимвольно, а не `${model_id,,}`: нижний регистр через `,,` — это
            # bash 4+, а на macOS bash 3.2, и весь скрипт намеренно держится 3.2 (см.
            # комментарии про BSD выше). `chatgpt` отдельной альтернативы не требует —
            # он содержит `gpt` и покрыт первым классом.
            #
            # 🪤 Голое имя шлюза (`/model agentrouter`) — тир `default`, а НЕ тир по
            # имени: имени модели в запросе нет вовсе. Без этой ветки `mm_tier` оставался
            # пустым и стрелка не рисовалась совсем (баг до 13.09). `default` — отдельный
            # ключ карты, а не переиспользованный `opus`: «CC попросил opus» и «модель не
            # названа» — разные события, их склейка и была причиной разбора 12.09.
            mm_tier=""
            if [ "$route_bare" = "1" ]; then
                mm_tier="default"
            elif [[ "$model_id" =~ [Gg][Pp][Tt]|[Oo][0-9]|[Dd][Aa][Vv][Ii][Nn][Cc][Ii] ]]; then
                mm_tier="gpt"
            else
                case "$model_id" in
                    *[Oo]pus*)   mm_tier="opus" ;;
                    *[Ss]onnet*) mm_tier="sonnet" ;;
                    *[Hh]aiku*)  mm_tier="haiku" ;;
                esac
            fi
            if [ -n "$mm_tier" ]; then
                # извлекаем значение тира из JSON ("opus": "claude-opus-5")
                mm_val=""
                if [[ "$mm_raw" =~ \"$mm_tier\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
                    mm_val="${BASH_REMATCH[1]}"
                fi
                # показываем стрелку только если карта подменяет модель (без учёта [1m]).
                # У голого имени сравнивать не с чем — модель не названа, поэтому цель
                # карты и есть вся информация о том, что уедет наверх.
                mm_bare="${model_id%\[1m\]}"
                if [ -n "$mm_val" ] && { [ "$route_bare" = "1" ] || [ "$mm_val" != "$mm_bare" ]; }; then
                    # сокращаем: claude-opus-5 → opus-5, gpt-5.6-sol → gpt-5.6-sol
                    mm_short="$mm_val"
                    mm_short="${mm_short#claude-}"
                    # дописываем [1m] если исходная модель пришла с ним И цель — claude
                    # (зеркало upstreamModelFor + echoModelFor: клиенту окно возвращают,
                    # шлюзу суффикс не показывают). `win_suffix` снят с ИСХОДНОГО имени
                    # до среза префикса — у голого `agentrouter[1m]` другого источника нет.
                    if [ -n "$win_suffix" ]; then
                        case "$mm_val" in
                            claude-*|*opus*|*sonnet*|*haiku*|*fable*) mm_short="${mm_short}${win_suffix}" ;;
                        esac
                    fi
                    map_target="$mm_short"
                fi
            fi
        fi
    fi
fi
# 🪤 Голое имя без цели в карте — это не «нечего показать», а гарантированный отказ:
# front-door отдаёт 400 «`default` в Маршрутах не задан» (frontdoor-proxy.js:397,
# noTarget). Молча напечатать одно имя шлюза значило бы показать нормально выглядящий
# бар на запросе, который наверх не уйдёт вообще.
route_nomap=0
[ "$route_bare" = "1" ] && [ -z "$map_target" ] && route_nomap=1

# ---- balance/quota gauge (mirrors dashboard) -------------------------------
pct=0
avail_sum=0
pool_balance_total=""
active_account_label=""
have_gauge=0
cool_str=""     # непустая = аккаунт на перезарядке, тут остаток времени

parse_dollars_sum() {  # print sum of "$X.XX" values in file
    grep -oE '"available"[[:space:]]*:[[:space:]]*"\$[0-9]+\.[0-9]+"' "$1" 2>/dev/null \
        | grep -oE '[0-9]+\.[0-9]+' \
        | awk '{s+=$1} END { printf "%.2f", (s+0) }'
}

stale_age_s=0
stale=0
balance_age_s=-1   # возраст цифры баланса в секундах; -1 = провайдер без кеша баланса
balance_err=""     # непустая = последняя проверка баланса не удалась (таймаут/dead)
active_name=""

# Общий gauge для провайдеров с кешем баланса в <sessions_file> (agentrouter/tabi/gorouter/xpeach/justwoker/seekai/truesota/kktoken/hcnsec):
# дашборд держит там balance/granted/balanceCheckedAt активного ключа. Читаем блок активного
# ключа bash-native (0 форков), avail_sum = balance как есть (дашборд уже посчитал точную
# цифру из /api/user/self либо вывел из вписанного анкера), pct = balance/granted. Ленивый
# рефреш через GET /__switch/api/<endpoint_path>?api_key=… если кеш протух (> <stale_s>).
gauge_from_balance_cache() {
    local sessions_file="$1" active_key_file="$2" endpoint_path="$3" stale_threshold="$4"
    local key raw after before head_obj tail_obj block bal granted anchor grant bonus referral chk bal_i grant_i chk_ts now_s name email id
    have_gauge=0
    pool_balance_total=""
    active_account_label=""

    key=""; read -r key < "$active_key_file" 2>/dev/null || true
    key="${key//[$' \t\r\n']/}"
    [ -n "$key" ] || return 0

    # весь файл в память, вырезаем объект активного ключа между соседними {…}
    raw="$(<"$sessions_file")"
    [[ "$raw" == *"$key"* ]] || return 0
    after="${raw#*"$key"}"        # хвост от ключа
    before="${raw%%"$key"*}"      # голова до ключа
    head_obj="${before##*\{}"     # от последней { перед ключом
    tail_obj="${after%%\}*}"      # до первой } после ключа
    block="{$head_obj$key$tail_obj}"
    [ -n "$block" ] || return 0

    name=""; [[ "$block" =~ \"name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && name="${BASH_REMATCH[1]}"
    email=""; [[ "$block" =~ \"email\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && email="${BASH_REMATCH[1]}"
    id=""; [[ "$block" =~ \"id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && id="${BASH_REMATCH[1]}"
    active_account_label="${name:-${email:-${id}}}"

    have_gauge=1
    bal=0;   [[ "$block" =~ \"balance\"[[:space:]]*:[[:space:]]*(-?[0-9]+(\.[0-9]+)?) ]] && bal="${BASH_REMATCH[1]}"
    chk="";  [[ "$block" =~ \"balanceCheckedAt\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && chk="${BASH_REMATCH[1]}"
    # balanceError пишет сервер, когда billing не ответил — цифра не просто стара, а под вопросом
    balance_err=""; [[ "$block" =~ \"balanceError\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && balance_err="${BASH_REMATCH[1]}"
    # Знаменатель шкалы. Приоритет тот же, что у сервера при расчёте balance:
    #   granted       — точная сумма выданного (остаток+расход) из /api/user/self
    #   balanceAnchor — вписанный руками баланс, если точного нет
    #   grant+bonus+referral — легаси-поля старых записей (до перехода на анкер)
    # Знаменатель обязан быть тем же, из которого посчитан balance, иначе шкала
    # уезжает за 100% и перестаёт двигаться.
    granted=0;  [[ "$block" =~ \"granted\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && granted="${BASH_REMATCH[1]}"
    anchor=0;   [[ "$block" =~ \"balanceAnchor\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && anchor="${BASH_REMATCH[1]}"
    grant=0;    [[ "$block" =~ \"grant\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && grant="${BASH_REMATCH[1]}"
    bonus=0;    [[ "$block" =~ \"bonus\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && bonus="${BASH_REMATCH[1]}"
    referral=0; [[ "$block" =~ \"referral\"[[:space:]]*:[[:space:]]*([0-9]+(\.[0-9]+)?) ]] && referral="${BASH_REMATCH[1]}"
    [[ "$bal" == -* ]] && bal=0
    avail_sum="$bal"
    if [ "$provider" = "aikeysapi" ]; then
        pool_balance_total="$(grep -oE '"balance"[[:space:]]*:[[:space:]]*[0-9]+(\.[0-9]+)?' "$sessions_file" 2>/dev/null \
            | grep -oE '[0-9]+(\.[0-9]+)?' \
            | awk '{ s += $1 } END { if (NR > 0) printf "%d", s }')"
    fi
    bal_i="${bal%.*}"
    if [ "${granted%.*}" -gt 0 ] 2>/dev/null; then
        grant_i="${granted%.*}"
    elif [ "${anchor%.*}" -gt 0 ] 2>/dev/null; then
        grant_i="${anchor%.*}"
    else
        grant_i=$(( ${grant%.*} + ${bonus%.*} + ${referral%.*} ))
    fi
    if [ "${grant_i:-0}" -gt 0 ] 2>/dev/null; then pct=$(( bal_i * 100 / grant_i )); else pct=0; fi

    # свежесть по balanceCheckedAt (ISO). balance_age_s наружу — рендер строки
    # показывает возраст цифры, чтобы было видно, обновляется квота или залипла.
    if [ -n "$chk" ]; then
        chk_ts="$(_iso_epoch "$chk")"
        now_s="$(date +%s)"
        [ "$chk_ts" -gt 0 ] && stale_age_s=$(( now_s - chk_ts ))
        [ "$stale_age_s" -lt 0 ] && stale_age_s=0
    else
        # штампа нет вообще — цифра неизвестного возраста, считаем протухшей
        stale_age_s=$(( stale_threshold + 1 ))
    fi
    balance_age_s="$stale_age_s"
    if [ "$stale_age_s" -gt "$stale_threshold" ]; then
        stale=1
        # Только ПИНАЕМ дашборд: `nudge=1` отвечает мгновенно и считает баланс в
        # своём процессе. Раньше здесь висел `curl -m 0.5 … &`, который должен был
        # дождаться медленного (1-2с) billing-эндпоинта — но statusline завершается
        # через ~50мс, и сиротский фоновый curl на Windows сносило вместе с группой
        # процессов, часто ДО отправки запроса. Итог: balanceCheckedAt не двигался
        # часами, а пинок уходил на каждом промпте. Дедуп и троттлинг — на сервере.
        ("$CURL_BIN" -s -m 1 "http://localhost:8200/__switch/api/$endpoint_path?api_key=$key&nudge=1" >/dev/null 2>&1 &) >/dev/null 2>&1
    fi
}

if [ "$provider" = "freemodel" ] && [ -f "$LOGS/.freemodel_quota_cache.json" ] && [ -f "$LOGS/.freemodel_meta.json" ]; then
    active_key="$(cat "$PROF/.claude/fm-active-key.txt" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$active_key" ]; then
        # найти dir аккаунта в meta по apiKey
        # `[ \t]` вместо `[[:space:]]`: awk на маке — BWK, и POSIX-классы он понял
        # только в сборке 2020 года (Ventura+). На более старых macOS класс
        # трактуется как набор литералов, имя аккаунта не находилось и шкала
        # баланса FreeModel просто не выводилась — без единого сообщения.
        active_name="$(awk -v key="$active_key" '
            BEGIN { RS="}"; name=""; found_ok=""; found_any="" }
            {
                if (match($0, /"[^"]+"[ \t]*:[ \t]*\{/)) {
                    n=substr($0,RSTART,RLENGTH); gsub(/["{: \t]/,"",n); name=n
                }
                if (index($0, key) > 0) {
                    found_any=name
                    if (index(name, "_ok_") > 0) found_ok=name
                }
            }
            END { print (found_ok != "" ? found_ok : found_any) }
        ' "$LOGS/.freemodel_meta.json")"
    fi

    if [ -n "$active_name" ]; then
        # вырезаем блок конкретного аккаунта и парсим h5/h5max/updatedAt
        block="$(awk -v n="$active_name" '
            $0 ~ "\""n"\"[ \t]*:[ \t]*\\{" { flag=1 }
            flag { print }
            flag && /^[ \t]*\}/ { exit }
        ' "$LOGS/.freemodel_quota_cache.json")"
        if [ -n "$block" ]; then
            have_gauge=1
            h5="$(printf '%s' "$block"  | grep -oE '"h5"[^0-9]*\$[0-9]+\.[0-9]+'    | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
            h5m="$(printf '%s' "$block" | grep -oE '"h5max"[^0-9]*\$[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
            upd="$(printf '%s' "$block" | grep -oE '"updatedAt"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -n1)"
            # Баланс ("AVAILABLE NOW") = min(деньги, остаток 5h-окна) — источник
            # правды. Окно без денег непригодно, поэтому остаток режем балансом.
            av="$(printf '%s' "$block"  | grep -oE '"available"[^0-9]*\$[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | head -n1)"
            [ -z "$h5" ]  && h5=0
            [ -z "$h5m" ] && h5m=0
            [ -z "$upd" ] && upd=0
            [ -z "$av" ]  && av=-1     # -1 = баланс не спарсился, идём по окну

            # Перезарядка: $0.00 при живом окне — это не смерть аккаунта, а ожидание
            # налива. Показываем сколько ждать, иначе шкала в нуле выглядит как «всё».
            fm_state="$(printf '%s' "$block" | grep -oE '"state"[[:space:]]*:[[:space:]]*"[a-z]+"' | grep -oE '(ok|cooldown|dead)' | head -n1)"
            cool_until="$(printf '%s' "$block" | grep -oE '"cooldownUntil"[[:space:]]*:[[:space:]]*"[^"]+"' | sed 's/.*"\([^"]*\)"$/\1/' | head -n1)"
            if [ "$fm_state" = "cooldown" ]; then
                cool_str="?"
                if [ -n "$cool_until" ]; then
                    cool_ts="$(_iso_epoch "$cool_until")"
                    now_s="$(date +%s)"
                    if [ "$cool_ts" -gt "$now_s" ]; then
                        cool_left=$(( cool_ts - now_s ))
                        if [ "$cool_left" -lt 3600 ]; then cool_str="$((cool_left/60))м"
                        else cool_str="$((cool_left/3600))ч$(( (cool_left%3600)/60 ))м"
                        fi
                    else
                        cool_str="вот-вот"
                    fi
                fi
            fi

            avail_sum="$(awk -v u="$h5" -v m="$h5m" -v a="$av" 'BEGIN { r=m-u; if (r<0) r=0; if (a>=0 && a<r) r=a; printf "%.2f", r }')"
            pct="$(awk -v u="$h5" -v m="$h5m" -v a="$av" 'BEGIN { r=m-u; if (r<0) r=0; if (a>=0 && a<r) r=a; if (m>0) printf "%d",(r/m)*100; else print (a==0 ? "0" : "100") }')"

            # свежесть по updatedAt (ms)
            now_ms="$(_now_ms)"
            [ "$upd" -gt 0 ] && stale_age_s=$(( (now_ms - upd) / 1000 ))
            [ "$stale_age_s" -lt 0 ] && stale_age_s=0
            balance_age_s="$stale_age_s"   # возраст цифры → в рендер (см. age_mark)

            # lazy refresh: асинхронный дёрг рефреша (пишет в общий кэш).
            # Порог 30с, а не 180: рефреш идёт по JSON-API (~1.5с), браузер не
            # поднимается, поэтому держать три минуты устаревшую цифру незачем.
            if [ "$stale_age_s" -gt 30 ]; then
                stale=1
                ("$CURL_BIN" -s -m 0.5 -X POST -H 'content-type: application/json' \
                    --data "{\"kind\":\"freemodel\",\"name\":\"$active_name\"}" \
                    http://localhost:8200/__switch/api/session/refresh-quota >/dev/null 2>&1 &) >/dev/null 2>&1
            fi
        fi
    fi
elif [ "$provider" = "ourtoken" ] && [ -f "$ROUTING/ourtoken-sessions.json" ]; then
    # ourtoken: $1 за LIVE ключ (правило из дашборда), % = live/total
    have_gauge=1
    total="$(grep -c '"api_key"' "$ROUTING/ourtoken-sessions.json" 2>/dev/null | head -n1 | tr -cd 0-9)"
    live="$(grep -c '"status"[[:space:]]*:[[:space:]]*"live"' "$ROUTING/ourtoken-sessions.json" 2>/dev/null | head -n1 | tr -cd 0-9)"
    [ -z "$total" ] && total=0
    [ -z "$live" ] && live=0
elif [ "$provider" = "rumeng" ] && [ -f "$ROUTING/rumeng-sessions.json" ]; then
    # rumeng/sub2api: balance — wallet field from /auth/me, cached by dashboard.
    # There is no subscription grant; dashboard's balance is the authoritative value.
    gauge_from_balance_cache "$ROUTING/rumeng-sessions.json" "$PROF/.claude/rumeng-active-key.txt" "rm/balance" 90
elif [ "$provider" = "agentrouter" ] && [ -f "$ROUTING/agentrouter-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/agentrouter-sessions.json" "$PROF/.claude/ar-active-key.txt" "ar/balance" 90
elif [ "$provider" = "tabi" ] && [ -f "$ROUTING/tabi-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/tabi-sessions.json" "$PROF/.claude/tabi-active-key.txt" "tb/balance" 90
elif [ "$provider" = "gorouter" ] && [ -f "$ROUTING/gorouter-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/gorouter-sessions.json" "$PROF/.claude/gorouter-active-key.txt" "go/balance" 90
elif [ "$provider" = "xpeach" ] && [ -f "$ROUTING/xpeach-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/xpeach-sessions.json" "$PROF/.claude/xpeach-active-key.txt" "xp/balance" 90
elif [ "$provider" = "justwoker" ] && [ -f "$ROUTING/justwoker-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/justwoker-sessions.json" "$PROF/.claude/justwoker-active-key.txt" "jw/balance" 90
elif [ "$provider" = "seekai" ] && [ -f "$ROUTING/seekai-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/seekai-sessions.json" "$PROF/.claude/seekai-active-key.txt" "sk/balance" 90
# TrueSOTA: тот же кеш, но цифра там — остаток КВОТЫ ПОДПИСКИ (или лимита ключа), а не
# кошелька, и её может не быть вовсе (у аккаунта без лимитов balance = null). Пустой
# balance gauge просто не покажет — это штатно, а не «баланс не прочитался».
elif [ "$provider" = "truesota" ] && [ -f "$ROUTING/truesota-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/truesota-sessions.json" "$PROF/.claude/truesota-active-key.txt" "ts/balance" 90
elif [ "$provider" = "kktoken" ] && [ -f "$ROUTING/kktoken-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/kktoken-sessions.json" "$PROF/.claude/kktoken-active-key.txt" "kk/balance" 90
elif [ "$provider" = "aipm" ] && [ -f "$ROUTING/aipm-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/aipm-sessions.json" "$PROF/.claude/aipm-active-key.txt" "ap/balance" 90
elif [ "$provider" = "aikeysapi" ] && [ -f "$ROUTING/aikeysapi-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/aikeysapi-sessions.json" "$PROF/.claude/aikeysapi-active-key.txt" "ak/balance" 90
elif [ "$provider" = "wisdomsatan" ] && [ -f "$ROUTING/wisdomsatan-sessions.json" ]; then
    gauge_from_balance_cache "$ROUTING/wisdomsatan-sessions.json" "$PROF/.claude/wisdomsatan-active-key.txt" "ws/balance" 90
fi

# ---- пул наливки: молчать про него = врать ---------------------------------
# 🪤 Реактивный фолбэк НЕ виден в тир-карте. Когда пул кончился, карта остаётся на
# `claude-opus-5`, а keepalive на КАЖДЫЙ запрос ловит 402 и повторяет фолбэком.
# Бар, читающий только карту, показывал `agentrouter/claude-opus-5[1m]` — то есть
# нормальную модель, — а ответ приходил с deepseek. Владелец 16.09 проработал так
# полночи, узнав об этом только из логов. Источник правды о пуле — файл состояния
# квоты, тот же, что кормит часы в дашборде (`~/.claude/ar-quota-state.json`).
pool_dry=0
pool_fb=""
if [ "${map_prefix:-}" = "ar" ]; then
    # Полоса — по модели, которую ЗАПРОСИЛИ, а не по той, что уедет: когда карта уже
    # подменяет цель на беспуловую (deepseek/glm), по цели полосу не определить вовсе —
    # а вопрос «пул пуст?» относится ровно к запрошенному тиру. Цель смотрим первой лишь
    # потому, что она и есть фактический адрес, когда она пуловая.
    pool_pfx=""
    case "${mm_val:-${model_id%\[1m\]}}" in
        claude[-_]*) pool_pfx="opus" ;;
        gpt[-_]*)    pool_pfx="gpt" ;;
    esac
    if [ -z "$pool_pfx" ]; then
        case "${mm_tier:-}" in
            opus|sonnet|haiku) pool_pfx="opus" ;;
            gpt)               pool_pfx="gpt" ;;
            *)
                case "${model_id%\[1m\]}" in
                    claude[-_]*) pool_pfx="opus" ;;
                    gpt[-_]*)    pool_pfx="gpt" ;;
                esac ;;
        esac
    fi
    if [ -n "$pool_pfx" ] && [ -r "$HOME/.claude/ar-quota-state.json" ]; then
        q_raw="$(cat "$HOME/.claude/ar-quota-state.json" 2>/dev/null)"
        q_state=""
        # Полосы лежат словарём: {"opus":{"state":…},"gpt":{…}}. Формат v1 (плоская
        # запись без ключей полос) читается как opus — он лежит на диске у всех, кто
        # обновляется, и «после апдейта пул исчез» выглядело бы поломкой часов.
        if [[ "$q_raw" =~ \"$pool_pfx\"[[:space:]]*:[[:space:]]*\{[^}]*\"state\"[[:space:]]*:[[:space:]]*\"([a-z]+)\" ]]; then
            q_state="${BASH_REMATCH[1]}"
        elif [ "$pool_pfx" = "opus" ] && [[ "$q_raw" =~ ^[[:space:]]*\{[^}]*\"state\"[[:space:]]*:[[:space:]]*\"([a-z]+)\" ]]; then
            q_state="${BASH_REMATCH[1]}"
        fi
        # Свежесть — по ПАРТИИ, а не по TTL: запись прошлой партии мертва, и «пул пуст»
        # по ней врал бы ровно наоборот (после налива пул как раз полон). Границу партии
        # берём из того же расписания, что дашборд и проба (`ar-quota-schedule.json`), а НЕ
        # по 8-часовой сетке: с 18.09 расписание файловое (Asia/Shanghai 10:00/19:00 =
        # 02:00/11:00Z, промежутки 9 ч и 15 ч), а `% 28800000` давало 00:00Z — запись об
        # истощении отвергалась как «прошлая партия», и «⛔ пул пуст» молчал на пустом пуле
        # (баг 18.09–19.09). git-bash без tzdata (named-zone TZ игнорит), поэтому смещение
        # зоны берём таблицей, а не `date`; незнакомую зону добираем ручкой расписания.
        if [ "$q_state" = "exhausted" ]; then
            q_drop_ms=0
            if [[ "$q_raw" =~ \"${pool_pfx}\"[^}]*\"dropAt\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
                q_drop_ms=$(( $(date -d "${BASH_REMATCH[1]}" +%s 2>/dev/null || echo 0) * 1000 ))
            fi
            q_now_ms=$(( $(date +%s) * 1000 ))
            q_sched_raw=""
            [ -r "$HOME/.claude/ar-quota-schedule.json" ] && q_sched_raw="$(<"$HOME/.claude/ar-quota-schedule.json")"
            q_tz=""
            [[ "$q_sched_raw" =~ \"tz\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && q_tz="${BASH_REMATCH[1]}"
            case "$q_tz" in
                Asia/Shanghai) q_off=480 ;;
                Europe/Moscow) q_off=180 ;;
                UTC|"")        q_off=0 ;;
                *)             q_off="" ;;   # зоны нет в таблице — добор ручкой ниже
            esac
            q_cur_ms=0
            if [ -n "$q_off" ] && [ -n "$q_sched_raw" ]; then
                # локальное HH:MM → минута дня UTC (может уйти в ±сутки — перебираем -1/0/+1)
                q_day0=$(( q_now_ms / 1000 - (q_now_ms / 1000) % 86400 ))
                while read -r q_t; do
                    [ -n "$q_t" ] || continue
                    q_hh=${q_t%%:*}; q_mm=${q_t#*:}
                    q_um=$(( 10#$q_hh * 60 + 10#$q_mm - q_off ))
                    for q_d in -1 0 1; do
                        q_b=$(( (q_day0 + q_d * 86400 + q_um * 60) * 1000 ))
                        [ "$q_b" -le "$q_now_ms" ] && [ "$q_b" -gt "$q_cur_ms" ] && q_cur_ms=$q_b
                    done
                done <<< "$(printf '%s' "$q_sched_raw" | grep -oE '"[0-9]{2}:[0-9]{2}"' | tr -d '"')"
            else
                # Зоны нет в таблице (или файла нет): спросим сервер. Ветка редкая — пул уже
                # пуст, и один короткий curl тут дешевле, чем молчащая метка.
                q_last="$(curl -s -m 1 "http://localhost:8200/__switch/api/ar/quota-schedule" 2>/dev/null \
                    | grep -oE '"last"[[:space:]]*:[[:space:]]*"[^"]+"' | grep -oE '[0-9T:.Z-]{20,}')"
                [ -n "$q_last" ] && q_cur_ms=$(( $(date -d "$q_last" +%s 2>/dev/null || echo 0) * 1000 ))
            fi
            [ "$q_drop_ms" != "0" ] && [ "$q_drop_ms" = "$q_cur_ms" ] && pool_dry=1
        fi
        # Куда уедет при пустом пуле. «⛔ пул пуст» без адреса бесполезно: владелец
        # 16.09 видел пометку и всё равно не понимал, на чём работает. Берём ту же
        # настройку, что читает keepalive (`poolFallbackModel`), а если конфига нет —
        # цель из маркера пул-дропа.
        if [ "$pool_dry" = "1" ]; then
            for f in "$ROUTING/keepalive-config-20133.json" "$ROUTING/ar-pooldrop.json"; do
                [ -r "$f" ] || continue
                if [[ "$(<"$f")" =~ \"(poolFallbackModel|fallback)\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
                    pool_fb="${BASH_REMATCH[2]}"
                    break
                fi
            done
        fi
    fi
fi

# ---- render ----------------------------------------------------------------
RESET=$'\033[0m'
DIM=$'\033[2m'
MODEL_COL=$'\033[38;5;180m'
SEP=$'\033[38;5;240m'
MONEY=$'\033[38;5;42m'
# Пул пуст — факт про то, ЧТО ОТВЕЧАЕТ, а не про карту тиров. Стоит сразу после модели
# и заметным красным: иначе бар выглядит совершенно нормально ровно в тот момент,
# когда модель подменили под ногами.
POOL_MARK=""
if [ "$pool_dry" = "1" ]; then
    # Адрес пишем только если бар ещё его не показал: когда карта уже подменяет цель,
    # стрелка →фолбэк стоит слева, и второй раз то же слово было бы шумом.
    if [ -n "$pool_fb" ] && [ "$map_target" != "$pool_fb" ]; then
        POOL_MARK=$' \033[1;38;2;255;107;128m⛔ пул пуст → '"$pool_fb"$'\033[0m'
    else
        POOL_MARK=$' \033[1;38;2;255;107;128m⛔ пул пуст\033[0m'
    fi
fi

if [ -n "$map_target" ]; then
    MAP_ARROW=$'\033[38;5;243m'
    MAP_VAL=$'\033[38;5;114m'
    # 🪤 У голого имени шлюза второго слова НЕТ — модель не названа, и печатать вместо
    # неё имя шлюза второй раз (`agentrouter/agentrouter[1m]`) значит показать выбор,
    # которого владелец не делал. Поэтому здесь `agentrouter→opus-5[1m]`: слева шлюз,
    # справа во что развернётся, ровно один раз каждое.
    if [ "$route_bare" = "1" ]; then
        printf '%s%s%s%s→%s%s%s%s' "$MODEL_COL" "$provider" "$MAP_ARROW" "$RESET" "$MAP_VAL" "$map_target" "$RESET" "$POOL_MARK"
    else
        printf '%s%s/%s%s%s→%s%s%s%s' "$MODEL_COL" "$provider" "$model_id" "$MAP_ARROW" "$RESET" "$MAP_VAL" "$map_target" "$RESET" "$POOL_MARK"
    fi
elif [ "$route_nomap" = "1" ]; then
    # Цель не задана → front-door ответит 400, запрос наверх не уйдёт. Красным, а не
    # тускло: это отказ, а не «просто нет стрелки».
    printf '%s%s%s→%s%s?%s%s' "$MODEL_COL" "$provider" $'\033[38;5;243m' "$RESET" $'\033[1;38;2;255;107;128m' "$RESET" "$POOL_MARK"
else
    printf '%s%s/%s%s%s' "$MODEL_COL" "$provider" "$model_id" "$RESET" "$POOL_MARK"
fi

# ---- /effort: тем же цветом, каким уровень подсвечен в самом Claude Code -----
# Цвета не выдуманы, а сняты из бандла CC (2.1.220), чтобы бар и его собственный
# слайдер `/effort` говорили одно и то же. Соответствие уровень → токен темы:
#   low    → warning      rgb(255,193,7)     жёлтый
#   medium → success      rgb(78,186,101)    зелёный
#   high   → permission   rgb(177,185,249)   сине-сиреневый
#   xhigh  → autoAccept   rgb(175,135,255)   фиолетовый (он же ultracode, см. выше)
#   max    → rainbow-animated: радуга rainbow_red…rainbow_violet
# Значения взяты из ТЁМНОЙ палитры (`text:"rgb(255,255,255)"`) — терминал тут
# тёмный, а `theme: auto` в settings.json к statusline отношения не имеет: CC
# цвет бара не навязывает, escape-последовательности пишем мы сами.
# Truecolor (38;2;R;G;B) вместо 38;5;N по всему блоку намеренно: попадание в
# 256-цветную палитру исказило бы именно те оттенки, ради совпадения с которыми
# всё и делается. Warp и Windows Terminal truecolor понимают.
if [ -n "$effort" ]; then
    printf ' %s·%s ' "$SEP" "$RESET"
    case "$effort" in
        low)    printf '%s%s%s' $'\033[38;2;255;193;7m'     "$effort" "$RESET" ;;
        medium) printf '%s%s%s' $'\033[38;2;78;186;101m'    "$effort" "$RESET" ;;
        high)   printf '%s%s%s' $'\033[38;2;177;185;249m'   "$effort" "$RESET" ;;
        xhigh)  printf '%s%s%s' $'\033[1;38;2;175;135;255m' "$effort" "$RESET" ;;
        max)
            # Радуга по буквам. Шаг 2 по кольцу из 7 цветов, а не 1: на трёх
            # символах соседние оттенки дали бы тёплый градиент, который читается
            # не как радуга, а как «оранжевый». Шаг 2 = красный/жёлтый/синий.
            # Фаза вращается по секундам — статуслайн перерисовывается на каждом
            # событии, и `max` за счёт этого переливается, как «rainbow-animated»
            # в самом CC. Форк `date` здесь единственный и только на уровне max.
            rb=( '235;95;87' '245;139;87' '250;195;95' '145;200;130' '130;170;220' '155;130;200' '200;130;180' )
            ph=$(( $(date +%s) % 7 ))
            i=0
            while [ "$i" -lt "${#effort}" ]; do
                printf '\033[1;38;2;%sm%s' "${rb[$(( (ph + i * 2) % 7 ))]}" "${effort:$i:1}"
                i=$(( i + 1 ))
            done
            printf '%s' "$RESET"
            ;;
        *)      printf '%s%s%s' "$DIM" "$effort" "$RESET" ;;
    esac
fi

# ---- ⑂ воркtree: в каком рабочем дереве эта сессия ---------------------------
# Показываем ТОЛЬКО когда дерево не основное: в обычном репо поля нет, и лишнего
# символа в баре не появляется. Цвет `planMode` rgb(72,150,140) выбран потому, что
# бирюзовый в этом баре больше нигде не занят — уровень effort, деньги, контекст и
# 💸 его не используют, так что пятно читается как отдельная сущность, а не как
# продолжение модели.
[ -n "$worktree" ] && printf ' %s⑂%s%s' $'\033[38;2;72;150;140m' "$worktree" "$RESET"

if [ "$have_gauge" = "1" ]; then
    # Возраст цифры показываем текстом: раньше был только тусклый `~`, по которому
    # нельзя было понять «обновляется, просто чуть отстало» или «залипло часы назад».
    # Свежее порога — цвет денег без пометки; протухло — тускло + возраст (2м/3ч/5д).
    age_mark=""
    if [ "$stale" = "1" ]; then
        money_col="$DIM"
        if [ "${balance_age_s:--1}" -ge 0 ] 2>/dev/null; then
            if   [ "$balance_age_s" -lt 3600 ];  then age_mark="~$(( balance_age_s / 60 ))м"
            elif [ "$balance_age_s" -lt 86400 ]; then age_mark="~$(( balance_age_s / 3600 ))ч"
            else                                      age_mark="~$(( balance_age_s / 86400 ))д"
            fi
        else
            age_mark="~"
        fi
        # ошибка последней проверки (таймаут billing / dead-ключ) — цифра не просто стара
        [ -n "$balance_err" ] && age_mark="$age_mark⚠"
    else
        money_col="$MONEY"
    fi

    if [ "$provider" = "aikeysapi" ] && [ -n "$pool_balance_total" ]; then
        avail_display="$(awk -v v="$avail_sum" 'BEGIN { printf "%.2f", v }')/\$$pool_balance_total"
    else
        avail_display="$avail_sum"
    fi
    printf ' %s│%s %s$%s%s%s' \
        "$SEP" "$RESET" \
        "$money_col" "$avail_display" "$age_mark" "$RESET"

    # ⏳ перезарядка: окно выжрано, аккаунт живой и ждёт налива
    if [ -n "$cool_str" ]; then
        printf ' %s⏳%s%s' $'\033[38;5;220m' "$cool_str" "$RESET"
    fi
fi

# ---- context window: ⧉ 139k/1M --------------------------------------------
# Точные токены показываем вмеcто округлённого used_percentage.
ctx_warn=""
if [ -n "$ctx_max" ] && [ "$provider" = "freemodel" ] && [ "$ctx_max" -lt 1000000 ]; then
    case "$model_id" in
        *"[1m]"*) ;;
        *) ctx_warn="⚠" ;;
    esac
fi

# Цвет по заполненности. До 2026-08-31 здесь стоял безусловный $DIM — то есть
# предупреждения о близком автокомпакте в баре не было вообще, ни на 80%, ни на
# 95%: цифра одинаково тускла и на 17%, и за минуту до того, как CC срежет
# контекст. (Вика утверждала, что «цветовые пороги cохранены» — это было неправдой
# с самого перехода на компактный формат.) Пороги 70/85 выбраны от места
# срабатывания автокомпакта: он бьёт в районе 90%+, значит жёлтый должен успеть
# предупредить, а красный — застать ещё с запасом на `/compact` руками.
ctx_col="$DIM"
ctx_pct_calc=""
if [ -n "$ctx_tok" ] && [ -n "$ctx_max" ] && [ "$ctx_max" -gt 0 ] 2>/dev/null; then
    ctx_pct_calc=$(( ctx_tok * 100 / ctx_max ))
elif [ -n "$ctx_pct" ]; then
    ctx_pct_calc="$ctx_pct"
fi
if [ -n "$ctx_pct_calc" ]; then
    if   [ "$ctx_pct_calc" -ge 85 ]; then ctx_col=$'\033[1;38;2;255;107;128m'   # error, жирный
    elif [ "$ctx_pct_calc" -ge 70 ]; then ctx_col=$'\033[38;2;255;193;7m'       # warning
    fi
fi

if [ -n "$ctx_tok" ] && [ "$ctx_tok" -gt 0 ] && [ -n "$ctx_max" ] && [ "$ctx_max" -gt 0 ]; then
    format_tokens() {
        local tokens="$1" out_var="$2" formatted
        if [ "$tokens" -ge 1000000 ]; then formatted="$((tokens / 1000000))M"
        elif [ "$tokens" -ge 1000 ]; then formatted="$((tokens / 1000))k"
        else formatted="$tokens"
        fi
        printf -v "$out_var" '%s' "$formatted"
    }

    format_tokens "$ctx_tok" ctx_tok_h
    format_tokens "$ctx_max" ctx_max_h
    printf ' %s│%s %s⧉ %s/%s%s' \
        "$SEP" "$RESET" \
        "$ctx_col" "$ctx_tok_h" "$ctx_max_h" "$RESET"
else
    # Старые/неполные payload: процент пригоден только еcли Claude Code его поcчитал.
    if [ -n "$ctx_pct" ] && [ "$ctx_pct" -gt 0 ]; then
        [ "$ctx_pct" -gt 100 ] && ctx_pct=100
        printf ' %s│%s %s⧉ %d%%%s' \
            "$SEP" "$RESET" \
            "$ctx_col" "$ctx_pct" "$RESET"
    elif [ -n "$ctx_max" ] && [ "$ctx_max" -gt 0 ]; then
        # Нулевой usage от gateway не означает пуcтую живую cеccию.
        printf ' %s│%s %s⧉ ?%s' "$SEP" "$RESET" "$DIM" "$RESET"
    fi
fi
[ -n "$ctx_warn" ] && printf '%s%s%s' $'\033[38;5;220m' "$ctx_warn" "$RESET"

# ---- AgentRouter: сколько аккаунтов готовы забрать +$25 --------------------
# Считаем ВСЕГДА, а не только когда активен agentrouter: бонус лежит на всём пуле, и
# знать про него надо, даже сидя на FreeModel. Сброс — суточная граница (по умолчанию
# 20:30 МСК = 17:30 UTC, МСК это UTC+3 без переходов на летнее время).
# Оценка приблизительная: аккаунт, который забрал и потом умер, занижает счёт на 1.
# Точную цифру считает дашборд — здесь важна не арифметика, а «пора идти».
ar_ready=0
if [ -f "$ROUTING/agentrouter-sessions.json" ]; then
    ar_hh=20; ar_mm=30
    if [ -f "$ROUTING/ar-checkin.json" ]; then
        ar_hhmm="$(grep -oE '"resetHhmmMsk"[[:space:]]*:[[:space:]]*"[0-9]{1,2}:[0-9]{2}"' "$ROUTING/ar-checkin.json" 2>/dev/null | grep -oE '[0-9]{1,2}:[0-9]{2}' | head -n1)"
        if [ -n "$ar_hhmm" ]; then
            ar_hh="${ar_hhmm%%:*}"; ar_mm="${ar_hhmm##*:}"
            ar_hh=$((10#$ar_hh)); ar_mm=$((10#$ar_mm))
        fi
    fi
    # Границу считаем секундами от начала UTC-суток: `date -d "…-1:30"` ломается,
    # когда граница раньше 03:00 и час уходит в минус.
    # Начало UTC-суток берём АРИФМЕТИКОЙ, а не `date -d`: GNU-синтаксиса на маке
    # нет, подстановка молча давала 0 и весь блок 🎁 пропускался (поймано в
    # аудите 2026-08-20 — на маке напоминание про +$25 не появлялось никогда).
    ar_now="$(date -u +%s)"
    ar_day=$(( ar_now - ar_now % 86400 ))
    ar_b=$(( ar_day + (ar_hh - 3) * 3600 + ar_mm * 60 ))
    [ "$ar_b" -gt "$ar_now" ] && ar_b=$(( ar_b - 86400 ))
    # BSD: `-r <epoch>`, GNU: `-d @<epoch>` — порядок именно такой, на маке
    # первый же вариант срабатывает и второй не зовётся.
    ar_biso="$(date -u -r "$ar_b" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d "@$ar_b" +%Y-%m-%dT%H:%M:%S 2>/dev/null)"
    # Пустая граница сравнивалась бы с любой датой как «уже забрал» и гасила 🎁.
    if [ -n "$ar_biso" ]; then
        # checkinAt пишется toISOString() → UTC фиксированной ширины, поэтому
        # лексикографическое сравнение строк здесь и есть хронологическое.
        ar_got="$(grep -oE '"checkinAt"[[:space:]]*:[[:space:]]*"[0-9]{4}-[0-9]{2}-[0-9]{2}T[^"]+"' "$ROUTING/agentrouter-sessions.json" 2>/dev/null \
            | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[^"]+' \
            | awk -v b="$ar_biso" '$1 >= b { n++ } END { print n+0 }')"
        ar_live="$(grep -c '"status"[[:space:]]*:[[:space:]]*"live"' "$ROUTING/agentrouter-sessions.json" 2>/dev/null | tr -cd 0-9)"
        [ -z "$ar_live" ] && ar_live=0
        [ -z "$ar_got" ] && ar_got=0
        ar_ready=$(( ar_live - ar_got ))
        [ "$ar_ready" -lt 0 ] && ar_ready=0
    fi
fi
[ "$ar_ready" -gt 0 ] && printf ' %s🎁%d%s' $'\033[38;5;214m' "$ar_ready" "$RESET"

# ---- 💸 авторотация: выключенный тумблер обязан быть виден ------------------
# Зачем в баре. Общий тумблер авторотации стоял `false` неизвестно сколько (замер
# 22.08), и со стороны Claude Code это выглядит как «денег нет вообще»: отказ шлюза
# по балансу (`403 预扣费额度失败`) доезжает до агента вместо подмены ключа, хотя в
# пуле лежат тысячи долларов. Полчаса разбора ушло на то, что видно одним символом.
#
# Источник правды — `logs/.money_autorotate.json`, тот же файл, что читает дашборд
# (`transparent-proxy.js` → moneyLoadPersist). Тумблер ОДИН на все пять шлюзов,
# полей на провайдера в нём нет. Читаем файл целиком в память и матчим bash-native:
# 0 форков, 0 сети — правило горячего пути.
#
# 🪤 Отсутствие файла = ВЫКЛЮЧЕНО, а не «включено по умолчанию»: дашборд при
# `!existsSync` оставляет дефолт `{enabled:false}`. Показывать в этом случае «on»
# значило бы врать ровно в том сценарии, из-за которого блок и появился.
#
# Регулярка заодно покрывает легаси-формат `{"ar":{"enabled":true},…}`: у дашборда
# он читается как «включён хоть у одного = включён», и совпадение по любому
# `"enabled": true` даёт тот же ответ.
#
# Показываем только на денежных шлюзах: ротация подменяет активный ключ текущего
# шлюза, и на FreeModel/Ourtoken её состояние не значит ничего — «off» там был бы
# ложной тревогой. Это отличает блок от 🎁, который считается всегда намеренно
# (бонус лежит на пуле и важен, даже когда сидишь на другом провайдере).
case "$provider" in
    agentrouter|tabi|gorouter|xpeach|justwoker|seekai|truesota|rumeng|kktoken|hcnsec|aipm)
        rot_raw=""
        [ -f "$LOGS/.money_autorotate.json" ] && rot_raw="$(<"$LOGS/.money_autorotate.json")"
        if [[ "$rot_raw" =~ \"enabled\"[[:space:]]*:[[:space:]]*true ]]; then
            # Норма: тускло и одним символом, чтобы бар не пестрил. Строка ниже —
            # то, что выпиливается первой, если 💸 в норме окажется лишним шумом.
            printf ' %s💸%s' "$DIM" "$RESET"
        else
            # Не `⚠`: он в этом баре уже занят двумя разными смыслами (протухший
            # баланс тускло и урезанное окно FreeModel жёлтым).
            printf ' %s💸off%s' $'\033[38;5;203m' "$RESET"
        fi
        ;;
esac

# statusline вcегда уcпешен: поcледняя уcловная команда при пуcтом значении
# может дать exit 1, а Claude Code может cчеcть ненулевой код cбоем.
exit 0
