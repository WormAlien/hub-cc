#!/usr/bin/env node
/**
 * check-statusline.js — сторож сегментов статус-бара Claude Code.
 *
 * Почему файл существует. Ночь 31.08 добавила в бар три вещи — уровень
 * `/effort`, имя git-воркtree и цветовые пороги на контекст — и все три пропали
 * из рабочего дерева: правки не были закоммичены, а `git reset --hard` 04.09 их
 * стёр. Восстановлено из транскриптов; чтобы пропажа второй раз не прошла молча,
 * здесь живой прогон бара, а не grep по исходнику.
 *
 * Проверяем не «строка есть в файле», а что скрипт ЧИТАЕТ поле payload и ВЫВОДИТ
 * сегмент: подкладываем настоящий payload Claude Code в stdin и смотрим на
 * собранную строку вместе с escape-последовательностями. Цвета в ожиданиях
 * прописаны цифрами намеренно — они сняты из бандла CC, чтобы бар и слайдер
 * `/effort` говорили одно и то же, и «поправил оттенок на глаз» обязан краснеть.
 *
 * Изоляция: HOME подменяется на пустой профиль с `{}` в settings.json —
 * провайдер тогда `unknown`, шкала баланса не строится, сети и кешей нет.
 * Деньги, 🎁 и 💸 сюда не входят намеренно: они зависят от живого пула, а этот
 * сторож должен быть зелёным на любой машине. Из тех же соображений сравниваются
 * подстроки и разница двух прогонов, а не строка целиком.
 *
 * 🪤 STATUSLINE_PAYLOAD в env обнуляем: он старше stdin по приоритету, и в
 * сессии, запущенной обёрткой из settings.json, тест мерил бы чужой payload.
 *
 * Запуск: node tools/check-statusline.js   (exit 1 = сегмент потерян)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'routing', 'statusline-autoreger.sh').replace(/\\/g, '/');

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const SEP = `${ESC}[38;5;240m`;
const DIM = `${ESC}[2m`;
// уровень → цвет темы CC: warning / success / permission / autoAccept
const LEVEL = {
    low: `${ESC}[38;2;255;193;7m`,
    medium: `${ESC}[38;2;78;186;101m`,
    high: `${ESC}[38;2;177;185;249m`,
    xhigh: `${ESC}[1;38;2;175;135;255m`,
};
const TEAL = `${ESC}[38;2;72;150;140m`;      // planMode: воркtree
const CTX_WARN = `${ESC}[38;2;255;193;7m`;   // ≥70%
const CTX_ERR = `${ESC}[1;38;2;255;107;128m`; // ≥85%, жирный

let failed = 0;
function ok(cond, msg) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
    if (!cond) failed++;
}
const show = (s) => JSON.stringify(s).replace(/\\u001b/g, 'ESC');

// ---- изолированный профиль: провайдер unknown, денег нет, сети нет ----------
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-check-'));
fs.mkdirSync(path.join(FAKE, '.claude'));
fs.writeFileSync(path.join(FAKE, '.claude', 'settings.json'), '{}\n');

// Payload ровно той формы, в какой его присылает Claude Code 2.1.220: effort и
// git_worktree — необязательные поля, и вся суть сегментов в том, что их может
// не быть. tokens: null = payload без total_input_tokens (старый CC/шлюз).
function payload({ effort, worktree, tokens = 110000, pct = 11, max = 1000000 } = {}) {
    const cw = { context_window_size: max, used_percentage: pct };
    if (tokens !== null) cw.total_input_tokens = tokens;
    const ws = { current_dir: 'D:\\repo', project_dir: 'D:\\repo', added_dirs: [] };
    if (worktree) ws.git_worktree = worktree;
    const p = {
        model: { id: 'claude-opus-5[1m]', display_name: 'Opus 5 (1M context)' },
        workspace: ws,
        context_window: cw,
        version: '2.1.220',
    };
    if (effort) p.effort = { level: effort };
    return JSON.stringify(p) + '\n';
}

function bar(opts) {
    return execFileSync('bash', [SCRIPT], {
        input: payload(opts),
        env: { ...process.env, HOME: FAKE, STATUSLINE_PAYLOAD: '' },
        encoding: 'utf8',
        timeout: 20000,
    });
}

function barAt(script, opts, home = FAKE) {
    return execFileSync('bash', [script], {
        input: payload(opts),
        env: { ...process.env, HOME: home, STATUSLINE_PAYLOAD: '' },
        encoding: 'utf8',
        timeout: 20000,
    });
}

// ---- стенд для имени шлюза в модели (`/model agentrouter`) -------------------
// Бар выводит ROOT из `BASH_SOURCE`, поэтому карты он ищет в `<repo>/routing/`. Чтобы
// проверки не зависели от боевых карт (и не ломались от их правки на вкладке), копируем
// скрипт в temp-репо и кладём карты туда. Побочная польза: файлов пула там нет, значит
// баланс и 🎁 в этих проверках не участвуют — а именно они делают сравнение двух
// прогонов байт в байт нестабильным (дашборд подменяет активный ключ между запусками).
//
// 🪤 Путь карты в реестре — относительный, как в бою. Резолвится он от `routing/`, ровно
// как `path.join(__dirname, file)` в readModelMap (frontdoor-proxy.js:265); абсолютный
// путь бар тоже принимает, но проверять надо ту форму, которая лежит в живом реестре.
const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-stage-'));
fs.mkdirSync(path.join(STAGE, 'routing'));
const STAGE_SCRIPT = path.join(STAGE, 'routing', 'statusline-autoreger.sh').replace(/\\/g, '/');
fs.copyFileSync(SCRIPT, STAGE_SCRIPT);
const GW_MAP = path.join(STAGE, 'routing', 'ar-modelmap.json');
const RT_MAP = path.join(STAGE, 'routing', 'ar-routes-modelmap.json');

const MODEL_COL = `${ESC}[38;5;180m`;
const MAP_ARROW = `${ESC}[38;5;243m`;
const MAP_VAL = `${ESC}[38;5;114m`;
const CTX_ERR_COL = CTX_ERR;      // отказ рисуется тем же красным, что перегретый контекст

// Реестр в изолированном профиле. `modelmap` = ровно то поле, из которого front-door
// выводит имя routes-карты (`routesMapFor`, frontdoor-proxy.js:376): при `null` он
// отвечает 400, и бар обязан показать отказ, а не выдуманную развёртку.
function registry(home, modelmap) {
    fs.writeFileSync(path.join(home, '.claude', 'backends.json'), JSON.stringify({
        version: 1,
        providers: { agentrouter: { upstream: 'http://localhost:20133', keyFile: null, modelmap, label: 'agentrouter' } },
        aliases: { ar: 'agentrouter' },
    }, null, 2) + '\n');
}
function barModel(id, { home = FAKE } = {}) {
    const p = JSON.parse(payload());
    p.model.id = id;
    return execFileSync('bash', [STAGE_SCRIPT], {
        input: JSON.stringify(p) + '\n',
        env: { ...process.env, HOME: home, STATUSLINE_PAYLOAD: '' },
        encoding: 'utf8',
        timeout: 20000,
    });
}
const head = (s) => s.split(' ')[0];

try {
    // ---- 0. скрипт вообще исполняется ---------------------------------------
    ok(fs.existsSync(SCRIPT), `бар на месте: ${SCRIPT}`);
    execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    ok(true, 'bash -n чистый');

    const plain = bar();
    ok(plain.includes(`${DIM}⧉ 110k/1M${RESET}`), `контекст точными токенами: ${show(plain.slice(-40))}`);

    // ---- 1. /effort: поле читается, цвет тот же, что у слайдера CC ----------
    for (const [level, col] of Object.entries(LEVEL)) {
        const seg = ` ${SEP}·${RESET} ${col}${level}${RESET}`;
        const out = bar({ effort: level });
        ok(out.includes(seg), `effort=${level} рисуется своим цветом CC (${col.replace(/\u001b/, 'ESC')})`);
        // 🪤 Инвариант из лога 31.08: без поля effort строка обязана совпадать с
        // прежней БАЙТ В БАЙТ. Проверяем вычитанием сегмента, а не глазами.
        ok(out.replace(seg, '') === plain, `без effort строка та же байт в байт (${level})`);
    }
    // max — радуга по буквам: шаг 2 по кольцу из 7 цветов, поэтому три буквы
    // обязаны получить три РАЗНЫХ оттенка (соседние дали бы «оранжевый»).
    const mx = bar({ effort: 'max' });
    const rb = [...mx.matchAll(/\[1;38;2;(\d+;\d+;\d+)m(.)/g)].filter((m) => 'max'.includes(m[2]));
    ok(rb.map((m) => m[2]).join('') === 'max', `effort=max печатается побуквенно: ${rb.map((m) => m[2]).join('')}`);
    ok(new Set(rb.map((m) => m[1])).size === 3, `три буквы — три разных оттенка (${rb.map((m) => m[1]).join(' ')})`);

    // Незнакомый уровень (CC добавит шестой) не теряется, а печатается тускло.
    ok(bar({ effort: 'turbo' }).includes(` ${SEP}·${RESET} ${DIM}turbo${RESET}`),
        'незнакомый уровень не проглатывается, а показывается тускло');

    // ---- 2. ⑂ воркtree: workspace.git_worktree, а не верхний `worktree` -----
    const wt = bar({ worktree: 'hatchetfish' });
    ok(wt.includes(`${TEAL}⑂hatchetfish${RESET}`), 'имя воркtree читается из workspace.git_worktree');
    ok(!plain.includes('⑂'), 'в основном дереве поля нет — лишнего символа в баре не появляется');
    ok(wt.replace(` ${TEAL}⑂hatchetfish${RESET}`, '') === plain, 'без воркtree строка та же байт в байт');

    // ---- 3. цветовые пороги на контекст (70 / 85) ---------------------------
    // Их не было вовсе: до 31.08 стоял безусловный $DIM, и бар одинаково тускл
    // и на 17%, и за минуту до автокомпакта. Пороги отмерены от места, где CC
    // режет историю (~90%), поэтому проверяем и границы, и «на 1% ниже».
    const ctx = (tokens, pct) => bar({ tokens, pct });
    ok(ctx(110000, 11).includes(`${DIM}⧉ 110k/1M`), '11% — тускло, как было');
    ok(ctx(690000, 69).includes(`${DIM}⧉ 690k/1M`), '69% — ещё тускло, порог не съезжает вниз');
    ok(ctx(700000, 70).includes(`${CTX_WARN}⧉ 700k/1M`), '70% — жёлтый: автокомпакт близко');
    ok(ctx(840000, 84).includes(`${CTX_WARN}⧉ 840k/1M`), '84% — всё ещё жёлтый');
    ok(ctx(850000, 85).includes(`${CTX_ERR}⧉ 850k/1M`), '85% — жирный красный, пора /compact');
    // Ветка без total_input_tokens (старый payload): цвет обязан работать и там,
    // иначе порог живёт только на новых версиях CC.
    ok(bar({ tokens: null, pct: 88 }).includes(`${CTX_ERR}⧉ 88%`), 'процентная ветка красится тем же порогом');
    ok(bar({ tokens: null, pct: 12 }).includes(`${DIM}⧉ 12%`), 'процентная ветка на 12% — тускло');

    // ---- 4. бар всегда успешен ----------------------------------------------
    // Последняя условная команда при пустом значении даёт exit 1, а Claude Code
    // считает ненулевой код сбоем и гасит бар целиком.
    const code = execFileSync('bash', ['-c', `printf '%s' '${payload({ effort: 'high' }).trim()}' | bash "${SCRIPT}" >/dev/null; echo $?`],
        { env: { ...process.env, HOME: FAKE, STATUSLINE_PAYLOAD: '' }, encoding: 'utf8' }).trim();
    ok(code === '0', `exit code бара = ${code}`);

    // ---- 5. AIKeysAPI: провайдер определяется по helper и показывает баланс ----
    const AK_STAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-ak-stage-'));
    try {
        fs.mkdirSync(path.join(AK_STAGE, 'routing'));
        fs.mkdirSync(path.join(AK_STAGE, '.claude'));
        fs.copyFileSync(SCRIPT, path.join(AK_STAGE, 'routing', 'statusline-autoreger.sh'));
        fs.writeFileSync(path.join(AK_STAGE, '.claude', 'settings.json'), JSON.stringify({
            apiKeyHelper: 'cat ~/.claude/aikeysapi-active-key.txt',
        }) + '\n');
        fs.writeFileSync(path.join(AK_STAGE, '.claude', 'aikeysapi-active-key.txt'), 'ak-test-key\n');
        fs.writeFileSync(path.join(AK_STAGE, 'routing', 'aikeysapi-sessions.json'), JSON.stringify([
            { api_key: 'ak-test-key', name: 'echoapex2935ed', email: 'private@example.test', id: 'ak_1', balance: 0.676818, granted: 5, balanceCheckedAt: new Date().toISOString() },
            { api_key: 'ak-second-key', balance: 94.900000, granted: 5, balanceCheckedAt: new Date().toISOString() },
            { api_key: 'ak-unknown-key', balance: null, granted: 5 },
        ]) + '\n');
        const ak = execFileSync('bash', [path.join(AK_STAGE, 'routing', 'statusline-autoreger.sh').replace(/\\/g, '/')], { input: payload(), env: { ...process.env, HOME: AK_STAGE, STATUSLINE_PAYLOAD: '' }, encoding: 'utf8' });
        ok(ak.includes(`${MODEL_COL}aikeysapi/claude-opus-5[1m]${RESET}`),
            `AIKeysAPI определяется по active-key helper (${show(head(ak))})`);
        ok(ak.includes('$0.68/$95'), `AIKeysAPI показывает активный баланс и целую сумму пула (${show(ak)})`);
        ok(!ak.includes('echoapex2935ed'), `AIKeysAPI не выводит имя активного аккаунта (${show(ak)})`);
        ok(!ak.includes('private@example.test'), `AIKeysAPI не выводит email (${show(ak)})`);
    } finally {
        try { fs.rmSync(AK_STAGE, { recursive: true, force: true }); } catch { /* temp */ }
    }

    // ---- 6. имя шлюза в модели: две формы, и ни одна не печатается дважды -----
    // Жалоба владельца 13.09: `/model agentrouter` давал `Custom🧪/agentrouter[1m]` (шлюз
    // от АКТИВНОГО бэкенда, а имя шлюза уехало во вторую половину строки) и второй раз
    // `agentrouter/agentrouter[1m]`. Причина — `case "$model_id" in */*)`: ветка
    // распознавания требовала слэш, а `/model agentrouter` его не содержит.
    //
    // Проверяем ПАРУ из жалобы целиком: имя ровно один раз, развёртка из ROUTES-карты
    // (не из карты активного шлюза — на это отдельный ассерт), и разграничение форм.
    fs.writeFileSync(GW_MAP, JSON.stringify({ opus: 'gw-opus', sonnet: 'gw-sonnet', haiku: '', gpt: '' }) + '\n');
    fs.writeFileSync(RT_MAP, JSON.stringify({
        default: 'claude-opus-5', opus: 'claude-opus-5', sonnet: 'rt-sonnet', haiku: 'claude-opus-4-8', gpt: 'rt-gpt',
    }) + '\n');
    registry(FAKE, 'ar-modelmap.json');

    const bare = barModel('agentrouter[1m]');
    ok(bare.includes(`${MODEL_COL}agentrouter${MAP_ARROW}${RESET}→${MAP_VAL}opus-5[1m]${RESET}`),
        `голое имя: шлюз→развёртка, а не шлюз/шлюз (${show(head(bare))})`);
    // 🪤 Главный ассерт всей правки: имя шлюза обязано встретиться РОВНО один раз.
    // Без него `agentrouter→agentrouter` прошло бы как «стрелка есть, всё хорошо».
    ok((bare.match(/agentrouter/g) || []).length === 1,
        `имя шлюза напечатано один раз, а не дважды (${(bare.match(/agentrouter/g) || []).length})`);
    ok(!bare.includes('agentrouter/'), 'у голого имени нет слэша: модель не названа, печатать нечего');
    // Развёртка обязана прийти из ROUTES-карты. Карта активного шлюза даёт `gw-opus` —
    // если он всплыл, бар читает не тот файл, и владелец увидит модель, которой в
    // запросе нет (инвариант «карт две», вика «Маршруты — своя тир-карта…»).
    ok(!bare.includes('gw-opus'), 'карта АКТИВНОГО шлюза для голого имени не использована');

    const alias = barModel('ar[1m]');
    ok(alias.includes(`${MODEL_COL}agentrouter${MAP_ARROW}${RESET}→${MAP_VAL}opus-5[1m]${RESET}`),
        `алиас резолвится в полное имя и ведёт себя как голое (${show(head(alias))})`);
    ok(!alias.includes('/ar'), 'алиас не печатается вторым словом');

    // Голое имя без суффикса окна: `[1m]` брать неоткуда, дописывать нельзя.
    const bareNo1m = barModel('agentrouter');
    ok(bareNo1m.includes(`→${MAP_VAL}opus-5${RESET}`),
        `без [1m] у источника суффикс на цель не дописывается (${show(head(bareNo1m))})`);

    // Слэш-форма: тир по имени модели, карта та же routes.
    const slashed = barModel('agentrouter/claude-sonnet-5');
    ok(slashed.includes(`${MODEL_COL}agentrouter/claude-sonnet-5${MAP_ARROW}${RESET}→${MAP_VAL}rt-sonnet${RESET}`),
        `слэш-форма: тир по имени модели из routes-карты (${show(head(slashed))})`);
    ok(!slashed.includes('gw-sonnet'), 'слэш-форма тоже читает routes-карту, а не карту активного шлюза');
    // Имя, которого нет ни в одном тире (`glm-5.3` из заявки): уходит как названо.
    const glm = barModel('agentrouter/glm-5.3');
    ok(glm.includes(`${MODEL_COL}agentrouter/glm-5.3${RESET}`) && !glm.includes('→'),
        `имя вне тиров стрелки не получает (${show(head(glm))})`);

    // Обычное имя модели проходит ту же ветку и обязано остаться нетронутым: реестр
    // ищется по КАЖДОМУ имени без слэша, и промах — штатное поведение (как в front-door).
    const plainName = barModel('claude-opus-5[1m]');
    ok(plainName.includes('unknown/claude-opus-5[1m]'),
        `обычное имя модели не считается шлюзом (${show(head(plainName))})`);
    // 🪤 Ловушка, поймавшая меня 13.09: признаком попадания в реестр нельзя брать
    // «`raw_target` не пуст» — блок front-door выше уже заполнил его активным бэкендом,
    // и тогда ЛЮБОЕ имя объявляется шлюзом. Симптом был именно такой: `claude-opus-5[1m]`
    // печатался как `agentrouter→?`. Проверяем на именах, которых в реестре нет заведомо.
    for (const id of ['deepseek-v4-flash[1m]', 'unknown', 'glm-5.3']) {
        const o = barModel(id);
        ok(o.includes(`unknown/${id}`) && !o.includes('→'),
            `«${id}» не выдаётся за шлюз (${show(head(o))})`);
    }

    // Регистр имени шлюза не важен — front-door ищет `reg.get(bare.toLowerCase())`
    // (frontdoor-proxy.js:401), и регресс `check-routes-default` это уже требует от него
    // («регистр имени не важен»). Бар обязан совпадать, иначе `/model AIPM/…` уедет на
    // aipm, а бар покажет активный шлюз — то есть соврёт про маршрут.
    // Подпись при этом обязана быть КАНОНИЧНОЙ из файла, а не как набрал человек:
    // `case "$raw_target"` ниже сравнивает точные строки.
    const upper = barModel('AGENTROUTER[1m]');
    ok(upper.includes(`${MODEL_COL}agentrouter${MAP_ARROW}`),
        `верхний регистр резолвится и печатается каноничным именем (${show(head(upper))})`);
    ok(!upper.includes('AGENTROUTER'), 'в баре не набранное имя, а каноничное из реестра');
    const mixed = barModel('AgentRouter/claude-sonnet-5');
    ok(mixed.includes(`${MODEL_COL}agentrouter/claude-sonnet-5${MAP_ARROW}${RESET}→${MAP_VAL}rt-sonnet${RESET}`),
        `смешанный регистр в слэш-форме тоже резолвится (${show(head(mixed))})`);

    // Пустой `default` → front-door отдаёт 400. Бар обязан показать отказ, а не
    // нормально выглядящую строку: запрос наверх не уйдёт вообще.
    // Ожидание собрано в том же порядке, в каком его печатает рендер: цвет стрелки
    // ставится ПЕРЕД сбросом, иначе `→` унаследовал бы цвет имени шлюза.
    const REFUSE = `${MODEL_COL}agentrouter${MAP_ARROW}→${RESET}${CTX_ERR_COL}?${RESET}`;
    fs.writeFileSync(RT_MAP, JSON.stringify({ default: '', opus: 'claude-opus-5' }) + '\n');
    const noDef = barModel('agentrouter[1m]');
    ok(noDef.includes(REFUSE), `пустой default показан отказом (${show(head(noDef))})`);
    ok(!noDef.includes('opus-5'), 'при пустом default чужой тир (opus) не подставляется');

    // `modelmap: null` в реестре — то же самое: front-door не найдёт routes-карту и
    // ответит 400 (замер живого стенда 13.09, ровно это состояние там и было).
    registry(FAKE, null);
    const noMap = barModel('agentrouter[1m]');
    ok(noMap.includes(REFUSE), `modelmap: null показан отказом (${show(head(noMap))})`);
    // Реестра нет вовсе (дашборд ещё не писал) — голое имя не распознаётся, и бар
    // обязан остаться прежним, а не показывать отказ на обычном имени модели.
    fs.rmSync(path.join(FAKE, '.claude', 'backends.json'));
    ok(barModel('agentrouter[1m]').includes('unknown/agentrouter[1m]'),
        'без реестра имя шлюза не распознаётся и ведёт себя как обычная модель');
} finally {
    try { fs.rmSync(FAKE, { recursive: true, force: true }); } catch { /* temp */ }
    try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch { /* temp */ }
}

if (failed) {
    console.log(`\n[X] сегментов потеряно: ${failed}. Разбор — docs/STATUSLINE.md, восстановление правок — из транскриптов CC`);
    process.exit(1);
}
console.log('\n[OK] бар собирается целиком: effort, воркtree, точные токены, пороги контекста');


