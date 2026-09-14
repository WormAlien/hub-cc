/**
 * Проверка трансформации «код эталона → код цели» на РЕАЛЬНЫХ строках kktoken.
 *
 * Зачем отдельным файлом: ошибка трансформации молчаливая — код соберётся,
 * `node --check` пройдёт, вкладка появится, а внутри останется чужое имя
 * (`kkLoad` вместо `fnLoad`) или, что хуже, чужой `kk` в provider-теге.
 * Поэтому сверяем не «похоже», а точным равенством на выписках из живого файла.
 *
 * Запуск: node tools/check-gateway-transform.js
 */
'use strict';

const path = require('path');
const { tokenPairs, toTarget } = require('./add-gateway.js');

const CONFIG = require(path.join(__dirname, 'gateways.config.json'));
const src = CONFIG.kktoken;
const dst = CONFIG.fluxnat;
const pairs = tokenPairs(src, dst);

// Выписки из routing/transparent-proxy.js и routing/proxy-dashboard.html — дословно.
const CASES = [
    ['реестр CC_MODEL_PREFIX',
        `    kktoken: 'kktoken',`,
        `    fluxnat: 'fluxnat',`],

    ['реестр BACKENDS (запись)',
        `    kktoken: {`,
        `    fluxnat: {`],

    ['вторая строка записи BACKENDS',
        `        label: 'KKtoken',`,
        `        label: 'FluxRouter',`],

    ['реестр GH_POOL_LOADERS (фрагмент)',
        `kk: () => kkLoad()`,
        `fn: () => fnLoad()`],

    ['реестр GH_POOL_LABELS (фрагмент)',
        `kk: 'KKtoken'`,
        `fn: 'FluxRouter'`],

    ['реестр NEWAPI_PROFILE_DIRS',
        `    'kktoken.cc': path.join(__dirname, '..', 'kktoken', 'profiles'),`,
        `    'llm.fluxnat.dev': path.join(__dirname, '..', 'fluxnat', 'profiles'),`],

    ['реестр MONEY_GW',
        `    kk: { tag: 'kktoken',     label: 'KKtoken',     host: 'kktoken.cc',     keyFile: KK_ACTIVE_KEY_FILE, load: kkLoad, save: kkSave, balanceFn: kkBalance, applyFn: kkApplyBalance },`,
        `    fn: { tag: 'fluxnat',     label: 'FluxRouter',     host: 'llm.fluxnat.dev',     keyFile: FN_ACTIVE_KEY_FILE, load: fnLoad, save: fnSave, balanceFn: fnBalance, applyFn: fnApplyBalance },`],

    ['реестр keepaliveInstances',
        `        [KK_KEEPALIVE_PORT]: { name: 'KKtoken', spawn: kkKeepaliveSpawn },`,
        `        [FN_KEEPALIVE_PORT]: { name: 'FluxRouter', spawn: fnKeepaliveSpawn },`],

    ['keepalive handler',
        `const keepaliveKk = makeKeepaliveHandlers(Number(process.env.KK_KEEPALIVE_PORT || 20161));`,
        `const keepaliveFn = makeKeepaliveHandlers(Number(process.env.FN_KEEPALIVE_PORT || 20167));`],

    ['роут balance',
        `    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/kk/balance'))  return handleKkBalance(req, res);`,
        `    if (req.method === 'GET'  && req.url.startsWith('/__switch/api/fn/balance'))  return handleFnBalance(req, res);`],

    ['функция pidAlive',
        `function kkPidAlive(pid) {`,
        `function fnPidAlive(pid) {`],

    ['тег дедупа баланса (грабля #23)',
        `            const queued = nudgeBalanceOnce('kk:' + api_key, recalc);`,
        `            const queued = nudgeBalanceOnce('fn:' + api_key, recalc);`],

    ['тег бэкапа настроек (грабля #25)',
        `            makeSettingsBackup('settings-kk');`,
        `            makeSettingsBackup('settings-fn');`],

    ['фронт: LABELS',
        `  kktoken: 'KKtoken',`,
        `  fluxnat: 'FluxRouter',`],

    ['фронт: KEEPALIVE_API',
        `  kk: '/__switch/api/kk/keepalive',`,
        `  fn: '/__switch/api/fn/keepalive',`],

    ['фронт: showTab',
        `  if (name === 'kktoken') { if (!state.loaded.kktoken) { state.loaded.kktoken = true; loadKkSessions(false); } kkLoadKeepalive(); }`,
        `  if (name === 'fluxnat') { if (!state.loaded.fluxnat) { state.loaded.fluxnat = true; loadFnSessions(false); } fnLoadKeepalive(); }`],

    ['фронт: обёртка keepalive',
        `const kkLoadKeepalive   = () => loadKeepaliveCard('kk', KEEPALIVE_API.kk);`,
        `const fnLoadKeepalive   = () => loadKeepaliveCard('fn', KEEPALIVE_API.fn);`],

    ['общий файл: GW_BY_HOST',
        `  'kktoken.cc': 'kk',`,
        `  'llm.fluxnat.dev': 'fn',`],

    ['lifecycle: keepalive',
        `        { port: 20161, name: 'KKtoken keepalive', respawn: false },`,
        `        { port: 20167, name: 'FluxRouter keepalive', respawn: false },`],

    ['hub-balance: POOLS',
        `    { id: 'kk', file: 'kktoken-sessions.json', name: 'KKtoken' },`,
        `    { id: 'fn', file: 'fluxnat-sessions.json', name: 'FluxRouter' },`],

    ['.gitignore: сессии',
        `routing/kktoken-sessions.json`,
        `routing/fluxnat-sessions.json`],

    ['байтовый тест: provider-тег строкой (грабля #8)',
        `newapiRows(state.kk, 'kk')`,
        `newapiRows(state.fn, 'fn')`],

    ['байтовый тест: префикс аккаунта (грабля #18)',
        `prefix: 'kk_'`,
        `prefix: 'fn_'`],

    // 🪤 Модель в строке НЕ должна меняться: трансформа знает только имена шлюза.
    ['контроль: имя модели неприкосновенно',
        `    model: 'claude-opus-5',   // kk-шлюз отдаёт opus`,
        `    model: 'claude-opus-5',   // fn-шлюз отдаёт opus`],

    // 🪤 Другой шлюз в той же строке не должен пострадать.
    ['контроль: соседний шлюз не тронут',
        `    aipm: 'aipm', hn: 'hcnsec', kk: 'kktoken',`,
        `    aipm: 'aipm', hn: 'hcnsec', fn: 'fluxnat',`],
];

let bad = 0;
console.log(`Трансформация: ${src.NAME} (${src.p}/${src.P}/${src.full}) → ${dst.NAME} (${dst.p}/${dst.P}/${dst.full})`);
console.log(`Пар замен: ${pairs.length}\n`);

for (const [title, input, want] of CASES) {
    const got = toTarget(input, pairs);
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`${ok ? '✓' : '✗'} ${title}`);
    if (!ok) {
        console.log(`    вход : ${JSON.stringify(input)}`);
        console.log(`    ждали: ${JSON.stringify(want)}`);
        console.log(`    вышло: ${JSON.stringify(got)}`);
    }
}

console.log(`\n${CASES.length - bad}/${CASES.length} прошло`);
if (bad) console.log('ТРАНСФОРМАЦИЯ ВРЁТ — apply запускать нельзя');
process.exit(bad ? 1 : 0);
