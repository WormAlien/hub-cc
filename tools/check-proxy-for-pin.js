#!/usr/bin/env node
// Regression: закреплённый адрес (`--pin`) берёт креды ИЗ ПУЛА, а не теряет их по дороге.
//
// Зачем это вообще. Замер 22.09: прогон автореги Odyssey умер на всех трёх кандидатах
// строкой `Page.goto: NS_ERROR_PROXY_CONNECTION_REFUSED`, а `curl` по тем же адресам
// показал TCP открыт и `407 Proxy Authentication Required` на CONNECT - до площадки не
// дошло ни одного пакета. Причина: `label` прокси НЕ содержит логина и пароля (так задумано
// в `parseProxy`: label уходит в UI и логи), проба кладёт в `candidates.json` только label,
// и браузер собирался из одной этой строки. Сама проба те же адреса проходила - она ходит
// через ОБЪЕКТ пула, где креды есть. Классика этого репозитория: проверка мерила не тем
// путём, которым идёт бой.
//
// Инварианты, каждый из которых ломается молча:
//   1. пин отдаёт браузеру server ВМЕСТЕ с username и password;
//   2. креды НЕ протекают в `label` - он уходит в логи и в UI;
//   3. пин работает на ярусе `scraper` - это боевая комбинация, и изоляция ярусов не смеет
//      прятать от пина адрес, лежащий в own-proxies.txt;
//   4. неизвестный адрес - ОТКАЗ, а не молчаливый анонимный заход;
//   5. адрес, у которого кредов нет и в пуле, идёт анонимно - и это видно, а не додумано;
//   6. пин привязок НЕ трогает: он адрес не выбирает, а получает готовый.
//
// Запуск: node tools/check-proxy-for-pin.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'routing', 'lib', 'proxy-for.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-for-pin-'));
const OWN = path.join(TMP, 'own-proxies.txt');
const ASSIGN = path.join(TMP, 'proxy-assign.json');

// Пароль с `@` - не экзотика, а форма, которой отдаёт инбаунд XGATE: в URL он обязан быть
// закодирован как `%40`. Пулер обязан вернуть его РАСКОДИРОВАННЫМ: браузеру нужен пароль,
// а не его URL-форма, и склеенная из `%40` авторизация молча не проходит.
const PINNED = 'http://10.0.0.1:10808';
const ANON = 'http://10.0.0.2:10808';
const UNKNOWN = 'http://10.0.0.9:10808';

fs.writeFileSync(OWN, [
    '# комментарий: пул такие строки пропускает',
    'http://pool:Zp9q%40x@10.0.0.1:10808',
    'http://10.0.0.2:10808',
    '',
].join('\n'), 'utf8');
fs.rmSync(ASSIGN, { force: true });

let fail = 0;
function check(ok, what) {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
}

// Мост зовём ОТДЕЛЬНЫМ процессом: ровно так его зовёт драйвер (`od_common._bridge_json`),
// и именно поэтому ярусы и env читаются так же, как в бою.
function pin(label, extra = []) {
    const env = { ...process.env, PROXY_POOL_OWN_FILE: OWN, PROXY_POOL_ASSIGN: ASSIGN };
    // Родительский `PROXY_POOL_OWN` перебил бы файл и подсунул чужой ярус.
    delete env.PROXY_POOL_OWN;
    delete env.PROXY_POOL_LIST;
    delete env.PROXY_POOL_ENABLED;
    delete env.PROXY_POOL_SOURCE;
    const r = spawnSync(process.execPath, [BRIDGE, '--pin', label, ...extra],
        { encoding: 'utf8', env });
    const line = String(r.stdout || '').split('\n').filter(l => l.trim().startsWith('{')).pop();
    if (!line) throw new Error(`мост не ответил JSON: ${r.stdout || r.stderr || r.status}`);
    return JSON.parse(line);
}

console.log('мост --pin: адрес задан, пул только отдаёт креды');

{
    const a = pin(PINNED);
    check(a.ok === true && a.pinned === true, 'свой адрес найден в пуле и помечен как закреплённый');
    check(a.browser && a.browser.server === PINNED, `браузеру отдан тот же адрес (${PINNED})`);
    check(a.browser && a.browser.username === 'pool', 'логин доехал до браузера');
    check(a.browser && a.browser.password === 'Zp9q@x',
        'пароль доехал РАСКОДИРОВАННЫМ (`%40` → `@`) - иначе авторизация не пройдёт');
    check(!String(a.label || '').includes('@'),
        'в label кредов нет: он уходит в логи дашборда и в UI');
}

{
    // 🔴 Боевая комбинация из прогона 22.09: драйвер просит ярус `scraper`, а адрес лежит
    // в own-proxies.txt. Изоляция `PROXY_POOL_OWN=''` стоит НИЖЕ режима пина - если однажды
    // её поднимут выше, свой адрес перестанет находиться и авторега встанет намертво.
    const a = pin(PINNED, ['--tier', 'scraper']);
    check(a.ok === true && a.browser && a.browser.username === 'pool',
        'на ярусе scraper свой адрес всё равно найден и получает креды');
}

{
    const a = pin(ANON);
    check(a.ok === true && a.browser && a.browser.server === ANON, 'адрес без кредов выдан');
    check(a.browser && !a.browser.username && !a.browser.password,
        'пароля не выдумано: кредов у пула нет - идём анонимно');
}

{
    const a = pin(UNKNOWN);
    check(a.ok === false && a.notFound === true,
        'неизвестный адрес - отказ, а не тихий анонимный заход');
    check(/не найден/.test(String(a.error || '')), `отказ объяснён словами: ${a.error}`);
}

check(!fs.existsSync(ASSIGN), 'привязок не завели: пин адрес не выбирает, а принимает готовый');

console.log(fail ? `\nПРОВАЛОВ: ${fail}` : '\nвсе проверки прошли');
process.exit(fail ? 1 : 0);
