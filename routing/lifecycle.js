'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  lifecycle.js — единственная реализация «поднять / погасить / посмотреть».
//
//  Зачем этот файл вообще появился (2026-08-24). Список портов жил в ПЯТИ копиях
//  и разъехался: restart-dashboard.bat знал 8 портов, restart-dashboard.sh и
//  stop-dashboard.sh — 10, START.bat — 2, fix.sh — 2. Каждую копию правили
//  отдельно, поэтому «перезапустил, а не помогло» означало разное в зависимости
//  от того, чем именно перезапускал. Здесь таблица одна, и её читают все.
//
//  Зовут отсюда: hub.js (TUI и CLI), тонкие форвардеры .bat/.command/.sh и
//  кнопка перезапуска в UI дашборда.
//
//  Платформы: win32 (netstat + taskkill) и darwin/linux (lsof + kill). Развилка
//  ровно в двух функциях — listeners() и killPid(); всё остальное общее.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const bifrostSidecar = require('./lib/bifrost-sidecar');
const {
    buildCustomProcessDescriptors,
    cleanupCustomProcess,
} = require('./lib/custom-process-ownership');

const ROUTING = __dirname;
const ROOT = path.join(__dirname, '..');
const IS_WIN = process.platform === 'win32';
// Сколько ждать, пока прокси сами закроют слушателя и выйдут (0 = не просить вовсе).
// 🎯 Решение владельца, 05.09: «если я захотел перезагрузить, пусть он перезагружается
// без ожидания». Поэтому НЕ ждём, пока дожмутся запросы в полёте — секунды хватает
// ровно на то, чтобы простаивающий процесс успел закрыться сам.
// Смысл этой секунды не в дожимании, а в ФОРМЕ закрытия соединений. Жёсткое убийство
// рвёт keep-alive сокеты через RST: у Claude Code они остаются в пуле как живые, и
// первый запрос после паузы уходит в мёртвый сокет — `ECONNRESET`, которого в наших
// логах нет вовсе, потому что до нового процесса он не доехал (наблюдалось 05.09 через
// 22 минуты после рестарта). Процесс, вышедший сам, закрывает их честным FIN, и клиент
// выбрасывает их из пула.
// Простаивающий прокси укладывается в ~300мс, так что на пустом стеке ожидания нет.
// Кому нужно именно дожимание — DRAIN_WAIT_MS в окружении, потолок в прокси 120с.
const DRAIN_WAIT_MS = Number(process.env.DRAIN_WAIT_MS || 1000);

// ── Логи: по файлу на сервис ─────────────────────────────────────────────────
// Раньше все писали в один routing/dashboard.out.log, и это выяснилось как
// неработающее ровно в момент проверки: cmd-редирект `>>` НЕ МОЖЕТ открыть файл,
// который уже держат пять живых процессов стека, — cmd молча выходит, node не
// стартует, порт не занимается. Замерено 24.08: тот же код с тем же кавычками на
// свежий файл поднимается, на dashboard.out.log — нет.
//
// По файлу на сервис снимает конкуренцию и заодно отвечает на «кто именно упал»:
// хвост показывается из лога того сервиса, который не поднялся, а не из общей мешанины.
const LOG_DIR = path.join(ROOT, 'logs', 'hub');
const LOG_MAX = 5 * 1024 * 1024;          // больше — крутим в .1, иначе файл растёт вечно

function serviceLog(svc) {
    const source = svc.logName || svc.script || svc.executable || 'service';
    return path.join(LOG_DIR, path.basename(String(source), path.extname(String(source))) + '.log');
}

// ── Порт front-door ──────────────────────────────────────────────────────────
// Он НЕ константа: настраивается в routing/frontdoor.json, и дашборд читает
// оттуда же (transparent-proxy.js § frontdoorConfig). Хардкод 20100 здесь дал бы
// самый неприятный класс ошибки — «остановил, а порт всё ещё слушает», потому что
// гасили не тот номер. Значение по умолчанию совпадает с дашбордом намеренно.
const FD_DEFAULT_PORT = 20100;

function frontdoorPort() {
    try {
        const raw = fs.readFileSync(path.join(ROUTING, 'frontdoor.json'), 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        return Number(doc.port) || FD_DEFAULT_PORT;
    } catch {
        return FD_DEFAULT_PORT;                       // нет файла — режим выключен
    }
}

// ── Какой бэкенд выбран прямо сейчас ────────────────────────────────────────
// Нужно, чтобы не поднимать конвертеры провайдеров, которыми не пользуются (см. ниже).
// Источник правды тот же, что у дашборда (transparent-proxy.js § activeBackendPort):
// `~/.claude/settings.json` → ANTHROPIC_BASE_URL; если он смотрит в front-door, то
// настоящий адрес лежит в `~/.claude/active-backend.json`, потому что в settings всегда
// один и тот же `:20100`.
// 🪤 Читаем, а не спрашиваем дашборд по HTTP: на старте его ещё нет.
function activeUpstreamPort() {
    const read = (p) => {
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    };
    const home = os.homedir();
    let base = '';
    try { base = String((read(path.join(home, '.claude', 'settings.json')).env || {}).ANTHROPIC_BASE_URL || ''); } catch { return 0; }
    let target = base;
    const fdPort = frontdoorPort();
    if (new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${fdPort}(/|$)`).test(base)) {
        try { target = String(read(path.join(home, '.claude', 'active-backend.json')).upstream || ''); } catch { return 0; }
    }
    const m = target.match(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/);
    return m ? Number(m[1]) : 0;
}

// ── Что хаб поднимает своими руками, в этом порядке ──────────────────────────
// Дашборд идёт последним: он на boot спавнит своих детей (front-door, конвертер
// AR, keepalive активного бэкенда) и снимает лежалых с прошлого запуска, поэтому
// к его старту порты уже должны быть свободны.
//
// 🪤 `provider` — конвертер Anthropic→OpenAI одного конкретного бэкенда. Такие
// поднимаются ТОЛЬКО если этот бэкенд выбран последним (решение владельца 05.09:
// «дашборд, вотчдог, фронтдор, а прокси по последнему выбранному провайдеру»).
// Раньше все три стартовали всегда — три процесса node по ~45 МБ и лишние секунды
// на старте ради панелей, в которые никто не заходит. Девять шлюзовых keepalive
// живут по этому правилу с самого начала (см. children(), respawn: false), а эти
// три его не получили: они старше keepalive-механики и остались в списке с мая.
// В `stop()` и `status()` список по-прежнему ПОЛНЫЙ — иначе «остановил» означало бы
// живой процесс на порту, а «статус» врал бы про него молчанием.
const SERVICES = [
    { port: 20126, name: 'FM-ротатор', script: 'freemodel-rotator.js', provider: 'freemodel_rotator' },
    { port: 20130, name: 'FM-OpenAI', script: 'freemodel-openai-proxy.js', provider: 'fm_openai' },
    { port: 20131, name: 'VyceAI', script: 'vyceai-openai-proxy.js', provider: 'vyce_openai' },
    { port: 8200, name: 'Дашборд', script: 'transparent-proxy.js', ready: '/__switch/api/status' },
    // Вотчдог пулов: следит, не отдаёт ли активный шлюз «all nodes exhausted», и
    // ГРОМКО сообщает (лог + pool-alert.json), сам НЕ переключает. Стоит после
    // дашборда: без активного бэкенда ему нечего мерить. Разбор — pool-watchdog.js.
    { port: 20134, name: 'Вотчдог пулов', script: 'pool-watchdog.js', ready: '/__watchdog/api/status' },
    // Protocol sidecar для OpenAI Chat Completions. Он optional: checksum/install/start
    // error деградирует только /openai/*, а native Claude и dashboard продолжают старт.
    bifrostSidecar.defaultServiceDescriptor(),
];


// ── Дети дашборда: хаб их НЕ поднимает никогда ───────────────────────────────
// Разница между «перезапустить» и «остановить» живёт ровно здесь, и она не
// косметическая (см. transparent-proxy.js § bootSpawnActiveBackend / § bootSweepStaleChildren):
//
//   respawn: true  — дашборд поднимает их обратно сам на boot. Погасить обязаны:
//                    иначе после обновления они доживают на СТАРОМ коде, и снаружи
//                    это выглядит как «перезагрузил, а не перезагрузилось» (21.08).
//   respawn: false — keepalive неактивных провайдеров. На boot дашборд их только
//                    СНИМАЕТ, обратно поднимает активация провайдера. Значит при
//                    рестарте трогать их нельзя (отобрали бы канал у активного
//                    бэкенда до следующей активации), а при остановке — обязаны:
//                    после остановки дашборда снять их не сможет уже никто, и
//                    «остановил» означало бы четыре живых прокси на портах.
function children() {
    return [
        { port: frontdoorPort(), name: 'Front Door', respawn: true },
        { port: 20132, name: 'AR-конвертер', respawn: true },
        { port: 20133, name: 'AgentRouter keepalive', respawn: true },
        // Вкладка Gemini: сервер держит пул Google-аккаунтов, их тир и квоту, и вкладка обязана
        // показывать это, НЕ будучи активным бэкендом. Поэтому `respawn: true` (поднимается на
        // старте хаба, как AgentRouter), а не `false` — иначе цифры во вкладке были бы мёртвыми
        // до первого переключения на Gemini. Порт, попав сюда, сам резервируется от аллокатора
        // Custom-конвертеров (routing/lib/custom-ports.js читает эту же таблицу).
        { port: 20178, name: 'Gemini (Antigravity)', respawn: true },
        // Шлюз вкладки Gemini (keepalive перед её движком): переводит имена моделей Claude Code
        // в модели Antigravity. Поднимается активацией, как у остальных неактивных шлюзов.
        { port: 20179, name: 'Gemini шлюз', respawn: false },
        { port: 20155, name: 'Tabi keepalive', respawn: false },
        { port: 20156, name: 'GoRouter keepalive', respawn: false },
        { port: 20157, name: 'XPeach keepalive', respawn: false },
        { port: 20158, name: 'JustWoker keepalive', respawn: false },
        { port: 20159, name: 'SeekAi keepalive', respawn: false },
        { port: 20160, name: 'TrueSOTA keepalive', respawn: false },
        { port: 20161, name: 'KKtoken keepalive', respawn: false },
        { port: 20190, name: 'APINEX keepalive', respawn: false },
        { port: 20182, name: 'KVOTUM keepalive', respawn: false },
        // Конвертер KVOTUM (Anthropic → OpenAI): площадка НЕ принимает /v1/messages
        // ни для одной модели (осознанный 400, замер 30.10), а CC говорит только
        // Anthropic-формат. Живёт как у Odyssey: поднимает активация, `respawn: false`,
        // порт резервируется этой же строкой через lib/custom-ports.js.
        { port: 20183, name: 'KVOTUM конвертер', respawn: false },
        { port: 20181, name: 'ThreeRouter keepalive', respawn: false },
        { port: 20189, name: 'Premier keepalive', respawn: false },
        { port: 20191, name: 'a6api keepalive', respawn: false },
        { port: 20192, name: 'a6api converter', respawn: false },
        { port: 20180, name: 'Vani keepalive', respawn: false },
        { port: 20177, name: 'dacall.AI keepalive', respawn: false },
        { port: 20164, name: 'Clean APIs keepalive', respawn: false },
        { port: 20176, name: 'Artbloom keepalive', respawn: false },
        { port: 20175, name: 'Fxqidian keepalive', respawn: false },
        { port: 20174, name: 'Lingshu keepalive', respawn: false },
        { port: 20173, name: 'BudsAI keepalive', respawn: false },
        { port: 20172, name: 'Nova keepalive', respawn: false },
        { port: 20170, name: 'Odyssey keepalive', respawn: false },
        // Конвертер Odyssey (Anthropic → OpenAI): им gpt-модели шлюза уводятся на путь,
        // где расход настоящий. Живёт ровно как keepalive - поднимает его активация,
        // поэтому и `respawn: false`. Порт 20171 лежит внутри диапазона кастомов
        // (20150-20250), и одна эта строка держит его отданным: `lib/custom-ports.js`
        // читает список отсюда, а не из второго места, которое надо помнить обновлять.
        { port: 20171, name: 'Odyssey конвертер', respawn: false },
        { port: 20169, name: 'B.AI keepalive', respawn: false },
        { port: 20168, name: 'UniKey keepalive', respawn: false },
        { port: 20162, name: 'HCNsec keepalive', respawn: false },
        { port: 20163, name: 'AIPM keepalive', respawn: false },
        { port: 20164, name: 'WisdomSatan keepalive', respawn: false },
        { port: 20165, name: 'AIKeysAPI keepalive', respawn: false },
        { port: 8300, name: 'Дашборд (легаси)', respawn: false },
    ];
}

// Конвертеры Custom-провайдеров сидят на портах из routing/custom-providers.json
// (диапазон 20150–20250), то есть их номера НЕЛЬЗЯ знать заранее. Старые bat/sh их
// не гасили вовсе: «остановил дашборд» оставляло висеть по прокси на каждого
// добавленного провайдера. Читаем файл, а не сканируем диапазон.
function customPorts() {
    try {
        const raw = fs.readFileSync(path.join(ROUTING, 'custom-providers.json'), 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
        return (doc.providers || [])
            .flatMap(provider => buildCustomProcessDescriptors(provider, { routingDir: ROUTING }))
            .map(descriptor => ({
                port: descriptor.port,
                name: `${descriptor.role === 'keepalive' ? 'keepalive' : 'конвертер'} ${descriptor.providerName || descriptor.providerId || '?'}`,
                respawn: false,
                customProcess: descriptor,
            }))
            .filter(item => item.port > 0);
    } catch {
        return [];
    }
}

// Кого гасить в каждой из двух операций. Порядок: сначала дашборд, потом его дети —
// живой дашборд успел бы заметить пропажу ребёнка и поднять его обратно.
function killPlan(phase, services = SERVICES, childItems = null) {
    const kids = childItems || [...children(), ...customPorts()];
    const list = [...services].reverse().map(s => ({ port: s.port, name: s.name, service: s }));
    for (const k of kids) {
        if (phase === 'stop' || k.respawn) list.push({ ...k, port: k.port, name: k.name, service: null });
    }
    const seen = new Set();
    return list.filter(x => (seen.has(x.port) ? false : seen.add(x.port)));
}

// ── Кто слушает: ОДИН снимок на все порты ────────────────────────────────────
// Раньше на каждый порт звался свой netstat|findstr, и на 12 портах это секунды
// подряд — при этом снимок ещё и разъезжался во времени. Здесь один вызов даёт
// карту порт → PID'ы, из неё же рисуется и статус, и план убийства.
//
// 🪤 Порт берём после ПОСЛЕДНЕГО двоеточия: у IPv6 адрес выглядит как `[::]:8200`,
// и наивный split(':')[1] дал бы пустую строку. И сравнивать надо числами —
// строчный `:8200` совпал бы с `:82000`, ровно поэтому в старых батниках стоял
// findstr с пробелом на конце.
function listeners() {
    const map = new Map();
    const add = (port, pid) => {
        if (!port || !pid) return;
        if (!map.has(port)) map.set(port, new Set());
        map.get(port).add(pid);
    };

    if (IS_WIN) {
        const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
        for (const line of String(r.stdout || '').split(/\r?\n/)) {
            const t = line.trim().split(/\s+/);
            if (t.length < 5 || t[0].toUpperCase() !== 'TCP') continue;
            // 🪤 По слову LISTENING фильтровать нельзя как по единственному признаку:
            // на части локалей Windows netstat переводит и состояния (заголовки
            // таблицы переведены уже на этой машине). Языконезависимая примета слушателя
            // — внешний адрес с портом 0 (`0.0.0.0:0`, `[::]:0`): у ESTABLISHED и
            // TIME_WAIT там настоящий порт собеседника.
            const listening = t[3] === 'LISTENING' || /:0$/.test(t[2]);
            if (!listening) continue;
            add(Number(t[1].slice(t[1].lastIndexOf(':') + 1)), Number(t[4]));
        }
        return map;
    }

    // -F pn — машинный формат: строка `p<pid>`, затем по строке `n<адрес>` на каждый
    // сокет этого процесса. Разбирать колонки обычного вывода нельзя: у COMMAND с
    // пробелом в имени их становится больше, и NAME съезжает.
    const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], { encoding: 'utf8' });
    if (r.status === 0 || r.stdout) {
        let pid = 0;
        for (const line of String(r.stdout || '').split('\n')) {
            if (line[0] === 'p') pid = Number(line.slice(1));
            else if (line[0] === 'n') add(Number(line.slice(line.lastIndexOf(':') + 1)), pid);
        }
        return map;
    }

    // Голый Linux без lsof (на маке он есть всегда). `ss -ltnpH`: адрес в 4-й
    // колонке, pid в хвосте вида `users:(("node",pid=123,fd=20))`.
    const s = spawnSync('ss', ['-ltnpH'], { encoding: 'utf8' });
    for (const line of String(s.stdout || '').split('\n')) {
        const t = line.trim().split(/\s+/);
        if (t.length < 4) continue;
        const port = Number(t[3].slice(t[3].lastIndexOf(':') + 1));
        for (const m of line.matchAll(/pid=(\d+)/g)) add(port, Number(m[1]));
    }
    return map;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Права: считаем один раз ──────────────────────────────────────────────────
// Нужны не для того, чтобы их требовать (хаб намеренно работает без них), а чтобы
// СРАЗУ сказать, в каком режиме он живёт. Элевированный хаб — не благо, а причина
// будущих проблем: его дети тоже становятся элевированными, и следующий обычный
// запуск их уже не убьёт.
//
// `net session` стоит ~130 мс, поэтому результат кешируется на процесс: за время
// одного запуска права не меняются. Проверки без запуска процесса пробовал —
// открытие `\\.\PHYSICALDRIVE0` в node даёт ENOENT и под админом, и без, то есть
// не различает ничего.
let _elevated = null;

function isElevated() {
    if (_elevated !== null) return _elevated;
    if (!IS_WIN) {
        _elevated = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
        return _elevated;
    }
    const r = spawnSync('net', ['session'], { windowsHide: true, encoding: 'utf8' });
    _elevated = r.status === 0;
    return _elevated;
}

// Жив ли процесс. Сигнал 0 ничего не посылает, только проверяет доступ:
//   ESRCH — процесса нет;
//   EPERM — процесс ЕСТЬ, но открыть его нам не дали (то есть жив и чужой).
function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Имя исполняемого файла по PID. Нужно ровно для одного вопроса: занятый порт — это
// НАШ процесс или чужой? Раньше start() в обоих случаях говорил «уже поднят, не
// трогаю», и посторонняя программа на :8200 выглядела как успешно поднятый дашборд.
// Имя образа не переводится ни на одной локали, в отличие от текста вокруг него.
function pidImage(pid) {
    try {
        if (IS_WIN) {
            const r = spawnSync('tasklist', ['/fi', `pid eq ${pid}`, '/fo', 'csv', '/nh'],
                { encoding: 'utf8', windowsHide: true });
            const m = String(r.stdout || '').match(/^"([^"]+)"/);
            return m ? m[1] : '';
        }
        // BSD `ps` (macOS) keeps the executable path in `comm`. Homebrew Node is
        // therefore reported as `/opt/homebrew/Cellar/node/<version>/bin/node`,
        // while Windows reports just `node.exe`. Return one portable image name;
        // otherwise our own detached dashboard/watchdog are called foreign after
        // the first start and an idempotent start refuses the occupied ports.
        const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
        return path.basename(String(r.stdout || '').trim());
    } catch {
        return '';
    }
}

function pidExecutable(pid) {
    try {
        if (IS_WIN) {
            const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').ExecutablePath`;
            const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
                { encoding: 'utf8', windowsHide: true });
            return r.status === 0 ? String(r.stdout || '').trim() : '';
        }
        const r = spawnSync('readlink', [`/proc/${Number(pid)}/exe`], { encoding: 'utf8' });
        if (r.status === 0) return String(r.stdout || '').trim();
        const p = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        const command = String(p.stdout || '').trim();
        return command ? command.split(/\s+/)[0] : '';
    } catch {
        return '';
    }
}

function pidArguments(pid) {
    try {
        if (IS_WIN) {
            const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`;
            const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
                { encoding: 'utf8', windowsHide: true });
            return r.status === 0 ? String(r.stdout || '').trim() : '';
        }
        const proc = `/proc/${Number(pid)}/cmdline`;
        try {
            return fs.readFileSync(proc).toString('utf8').split('\0').filter(Boolean);
        } catch {
            const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
            return String(r.stdout || '').trim();
        }
    } catch {
        return '';
    }
}

function normalizedPath(value) {
    const full = path.resolve(String(value || ''));
    return IS_WIN ? full.toLowerCase() : full;
}

function hashFile(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (;;) {
            const count = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!count) break;
            hash.update(buffer.subarray(0, count));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function isOursForService(svc, image, executablePath = '') {
    const actual = path.basename(String(image || '')).toLowerCase();
    if (!svc.executable) return /^node(\.exe)?$/i.test(actual);
    const expected = path.basename(String(svc.imageName || svc.executable)).toLowerCase();
    if (actual !== expected) return false;
    if (!executablePath) return false;
    return normalizedPath(executablePath) === normalizedPath((svc.identity && svc.identity.path) || svc.executable);
}

async function healthIdentity(svc, timeoutMs = 1500) {
    const healthPath = (svc.identity && svc.identity.healthPath) || svc.ready || '/health';
    const versionPath = (svc.identity && svc.identity.version) ? '/api/version' : null;
    const get = pathname => new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port: svc.port, path: pathname, timeout: timeoutMs }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* fail closed below */ }
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, json });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, json: null }); });
        req.on('error', () => resolve({ ok: false, json: null }));
    });
    const health = await get(healthPath);
    if (!health.ok || !health.json || health.json.status !== 'ok') return { ok: false, marker: null, version: null };
    let version = null;
    if (versionPath) {
        const response = await get(versionPath);
        if (!response.ok) return { ok: false, marker: null, version: null };
        version = typeof response.json === 'string' ? response.json : response.json && response.json.version;
        if (String(version || '').replace(/^v/, '') !== String(svc.identity.version).replace(/^v/, '')) {
            return { ok: false, marker: null, version };
        }
    }
    // The marker is descriptor-owned and paired with exact path/hash/version checks.
    return { ok: true, marker: svc.identity && svc.identity.marker, version };
}

async function verifyProcessOwnership(svc, pid, {
    pidImage: imageOf = pidImage,
    pidExecutable: executableOf = pidExecutable,
} = {}) {
    if (!svc || !svc.executable) return isOursForService(svc || {}, imageOf(pid), executableOf(pid));
    const runningPath = executableOf(pid);
    if (!isOursForService(svc, imageOf(pid), runningPath)) return false;
    if (svc.identity && svc.identity.sha256) {
        try {
            if (hashFile(runningPath) !== String(svc.identity.sha256).toLowerCase()) return false;
        } catch { return false; }
    }
    return true;
}

function commandTokens(value) {
    if (Array.isArray(value)) return value.map(String);
    const text = String(value || '');
    const tokens = [];
    const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
    let match;
    while ((match = pattern.exec(text))) tokens.push(match[1] ?? match[2] ?? match[3]);
    return tokens;
}

function commandOption(tokens, name) {
    const index = tokens.findIndex(token => token === name);
    return index >= 0 && index + 1 < tokens.length ? tokens[index + 1] : '';
}

function markerFromConfig(file, provider = 'abuse-hub') {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const config = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return config && config.providers && config.providers[provider]
            && config.providers[provider].network_config
            && config.providers[provider].network_config.extra_headers
            && config.providers[provider].network_config.extra_headers['x-abuse-hub-internal'];
    } catch {
        return null;
    }
}

async function verifyServiceIdentity(svc, pid, adapters = {}) {
    if (!await verifyProcessOwnership(svc, pid, adapters)) return false;
    if (!svc.identity) return true;
    if (svc.identity.appDir) {
        const args = commandTokens((adapters.pidArguments || pidArguments)(pid));
        const appDir = commandOption(args, '-app-dir');
        const host = commandOption(args, '-host');
        const port = Number(commandOption(args, '-port'));
        if (!appDir || normalizedPath(appDir) !== normalizedPath(svc.identity.appDir)
            || host !== '127.0.0.1' || port !== Number(svc.port)) return false;
    }
    if (svc.identity.configPath) {
        try {
            if (svc.identity.configSha256
                && hashFile(svc.identity.configPath) !== String(svc.identity.configSha256).toLowerCase()) return false;
            if (markerFromConfig(svc.identity.configPath) !== svc.identity.marker) return false;
        } catch { return false; }
    }
    const probe = await (adapters.healthIdentity || healthIdentity)(svc);
    return !!(probe && probe.ok && probe.marker === svc.identity.marker);
}

const isOurs = pid => /^node(\.exe)?$/i.test(pidImage(pid));

// Убить один PID. Возвращает 'ok' | 'denied' | 'gone'.
//
// 🪤 Текст taskkill'а разбирать НЕЛЬЗЯ, и на этом мы уже стояли: он печатает в
// OEM-кодировке (cp866 на русской Windows), а node декодирует как utf8 — «Отказано
// в доступе» превращается в мусор, регулярка не совпадает, и отказ проходил как
// «процесс уже умер». Дальше killPort честно ждал 8 секунд таймаута на каждый порт;
// на плане из 14 портов это две минуты тишины вместо мгновенного ответа.
// Код возврата тоже не годится: у taskkill и «нет такого процесса», и «нет прав» —
// это 1. Поэтому спрашиваем результат у системы: процесс ещё жив?
async function killPid(pid, hard) {
    if (!pidAlive(pid)) return 'gone';

    if (IS_WIN) {
        spawnSync('taskkill', hard ? ['/F', '/T', '/PID', String(pid)] : ['/PID', String(pid)],
            { windowsHide: true });
    } else {
        try {
            process.kill(pid, hard ? 'SIGKILL' : 'SIGTERM');
        } catch (e) {
            if (e.code === 'EPERM') return 'denied';
            return 'gone';
        }
    }

    // Умирают не мгновенно: даём 300 мс на исчезновение, прежде чем звать это отказом.
    // Вежливому сигналу на POSIX этого мало намеренно — там ждёт сам killPort.
    for (let i = 0; i < 6; i++) {
        if (!pidAlive(pid)) return 'ok';
        await sleep(50);
    }
    return IS_WIN || hard ? 'denied' : 'ok';
}

// Освободить порт и ДОЖДАТЬСЯ, пока ОС его реально отпустит.
//
// 🪤 Проверка после kill обязательна и является источником правды. Убитый процесс
// умирает не мгновенно, а сокет отпускается ещё позже; без ожидания следующий старт
// падал с EADDRINUSE, и человек видел «порт занят» сразу после «порт освобождён».
// Ровно поэтому в старом бате был цикл :KP_WAITFREE — он здесь сохранён, вместе с
// его же ограничением в ~8 секунд.
// Мягкая остановка порта: попросить процесс дожать начатое и выйти сам.
// Зачем это здесь, а не в убийстве: на Windows мягко погасить чужой процесс НЕЛЬЗЯ —
// SIGTERM не доставляется, `taskkill` без `/F` для node бесполезен (ровно об это
// спотыкается round(IS_WIN) ниже). Поэтому просим по HTTP: `POST /__drain`. Прокси
// закрывает слушателя, дожимает запросы в полёте и выходит сам — и живые сессии
// Claude Code не получают `Connection closed mid-response` на каждом рестарте хаба.
// Кто про `/__drain` не знает — ответит 404 или ничем, и мы просто гасим как раньше.
function askDrainOnce(port) {
    return new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/__drain', timeout: 2000 }, r => {
            let body = '';
            r.on('data', c => { body += c; });
            r.on('end', () => {
                if (r.statusCode !== 200) return resolve(null);
                let inflight = 0;
                try { inflight = Number(JSON.parse(body).inflight) || 0; } catch (e) { /* и так сойдёт */ }
                resolve({ inflight });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function stopLaunched(launch, {
    killPid: stopPid = killPid,
    pidAlive: isAlive = pidAlive,
    sleep: pause = sleep,
    timeoutMs = 8000,
} = {}) {
    const pid = Number(launch && typeof launch === 'object' ? launch.pid : launch);
    if (!Number.isInteger(pid) || pid <= 0) {
        return { pid: 0, freed: true, denied: false };
    }
    let outcome = await stopPid(pid, IS_WIN);
    if (outcome === 'denied') return { pid, freed: false, denied: true };
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid) && Date.now() < deadline) await pause(50);
    if (isAlive(pid)) {
        outcome = await stopPid(pid, true);
        if (outcome === 'denied') return { pid, freed: false, denied: true };
        for (let i = 0; i < 20 && isAlive(pid); i++) await pause(50);
    }
    return { pid, freed: !isAlive(pid), denied: false };
}

// ── Front-door: не гасить, если его код не менялся (2026-09-06) ───────────────
// Единственная причина перезапускать front-door — новый код. Всё остальное он
// подхватывает живьём: активный бэкенд читается из active-backend.json, и смена
// провайдера 05.09 в 19:44 прошла без его рестарта вообще.
// А цену каждого убийства платит человек: front-door — единственный вход Claude Code,
// и любой запрос в полёте превращается в `Connection closed mid-response`. Этот класс
// клиент НЕ повторяет и таймера попыток не показывает: часть ответа уже отрисована,
// переигрывать нечего. То есть один рестарт хаба = по одному оборванному ответу у
// каждого, кто в этот момент чего-то ждёт.
// Поэтому решает ОТПЕЧАТОК КОДА, а не привычка: процесс старше файла — гасим, как
// раньше, и гарантия 21.08 («рестарт обязан означать свежий код у всех детей») цела;
// процесс новее файла — оставляем жить.
// 🪤 Возраст берём у самого процесса (`uptime_ms` из его статуса): PID времени старта
// не даёт, а PowerShell ради одной цифры — секунда на пустом месте.
// 🪤 Любая неясность трактуется в пользу убийства: не ответил, нет `uptime_ms`, нет
// файла — гасим. Иначе первая же осечка проверки оставила бы старый код жить молча,
// а это ровно та беда, от которой `respawn: true` и появился.
function getStatusJson(port, urlPath, timeoutMs) {
    return new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, timeout: timeoutMs }, r => {
            let body = '';
            r.on('data', c => { body += c; });
            r.on('end', () => {
                if (r.statusCode !== 200) return resolve(null);
                try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function frontdoorCodeIsCurrent() {
    const st = await getStatusJson(frontdoorPort(), '/__frontdoor/api/status', 1500);
    const up = Number(st && st.uptime_ms);
    if (!Number.isFinite(up) || up <= 0) return false;
    let mtimeMs;
    try { mtimeMs = fs.statSync(path.join(ROUTING, 'frontdoor-proxy.js')).mtimeMs; } catch (e) { return false; }
    return (Date.now() - up) > mtimeMs;
}

// Оставлено для вызовов, которым нужен дренаж ОДНОГО порта с ожиданием.
async function askDrain(port, waitMs) {
    if (!await askDrainOnce(port)) return false;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        await sleep(150);
        if (![...(listeners().get(port) || [])].length) return true;
    }
    return false;
}

async function killPort(port, { timeoutMs = 8000, drainMs = 0 } = {}) {
    let pids = [...(listeners().get(port) || [])];
    if (!pids.length) return { port, was: [], freed: true, denied: false };

    // Сначала по-хорошему. Потолок ожидания небольшой намеренно: рестарт не должен
    // висеть минутами из-за одного долгого ответа, а совсем долгие запросы всё равно
    // придётся оборвать — но их единицы, а коротких в полёте десятки.
    if (drainMs > 0 && await askDrain(port, drainMs)) {
        return { port, was: pids.slice(), freed: true, denied: false, drained: true };
    }

    const was = pids.slice();
    let denied = false;

    // 🪤 Ждать после отказа в правах — чистая потеря времени, и на 12 портах это
    // складывалось в полторы минуты «он что-то долго думает» вместо мгновенного
    // ответа (владелец, 25.08). Отказ не рассосётся сам: процесс элевированный, а мы
    // нет. Поэтому решение принимается по РЕЗУЛЬТАТУ убийства, а не по таймауту:
    // не смогли ни одного — выходим сразу.
    const round = async hard => {
        let killed = 0;
        for (const pid of pids) {
            const r = await killPid(pid, hard);
            if (r === 'denied') denied = true; else killed++;
        }
        return killed;
    };

    // На Windows taskkill без /F для node бесполезен, так что сразу /F; на POSIX
    // сначала SIGTERM — дашборд успевает закрыть сокеты и снять своих детей.
    if (await round(IS_WIN) === 0) return { port, was, freed: false, denied, holding: pids, fast: true };

    const deadline = Date.now() + timeoutMs;
    let hardened = IS_WIN;
    while (Date.now() < deadline) {
        await sleep(250);
        pids = [...(listeners().get(port) || [])];
        if (!pids.length) return { port, was, freed: true, denied };
        if (!hardened && Date.now() > deadline - timeoutMs + 1000) {
            hardened = true;
            if (await round(true) === 0) return { port, was, freed: false, denied, holding: pids, fast: true };
        }
    }
    return { port, was, freed: false, denied, holding: pids };
}

// ── Окружение для детей ──────────────────────────────────────────────────────
// На маке дашборд и его дети зовут внутри себя netstat/taskkill/python — виндовые
// имена, которых там нет. Подмена сделана шимами в mac-support/shims, и они должны
// стоять в PATH РЕБЁНКА. Своему процессу мы PATH не портим намеренно: lifecycle
// ищет реальный lsof, а шим `netstat` из этой же папки его бы подменил.
function childEnv() {
    const env = { ...process.env };
    if (!env.ABUSE_HUB_LOCAL_HOP_KEY_FILE) {
        env.ABUSE_HUB_LOCAL_HOP_KEY_FILE = path.join(os.homedir(), '.secrets', 'abuse-hub-local-hop.key');
    }
    if (!IS_WIN) {
        const shims = path.join(ROOT, 'mac-support', 'shims');
        if (fs.existsSync(shims)) env.PATH = shims + path.delimiter + (env.PATH || '');
        if (fs.existsSync('/usr/bin/sqlite3')) env.SQLITE3 = '/usr/bin/sqlite3';
    }
    return env;
}

function serviceEnv(svc, parentEnv = process.env) {
    if (!svc || svc.envPolicy !== 'allowlist') {
        return { ...childEnv(), ...((svc && svc.env) || {}) };
    }
    const keep = new Set([
        'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
        'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
        'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
    ]);
    const env = {};
    for (const [key, value] of Object.entries(parentEnv || {})) {
        if (keep.has(key.toUpperCase()) && value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(svc.env || {})) {
        if (value !== undefined) env[key] = String(value);
    }
    return env;
}

// ── Подготовка платформы перед стартом ───────────────────────────────────────
// Указатель на корень репо для шима статус-лайна: settings.json показывает на
// ~/.claude/autoreger-statusline.sh, а тот читает путь отсюда. Благодаря этому
// перенос или переименование папки проекта не ломает статус-бар — достаточно
// запустить дашборд из нового места.
//
// 🪤 Слэши прямые даже на Windows: шим — bash-скрипт, и путь с обратными слэшами
// он бы съел как escape-последовательности. Старый bat делал то же самое через
// `%REPO_ROOT:\=/%`, формат файла обязан совпадать.
function preparePlatform() {
    const notes = [];
    try {
        const dir = path.join(os.homedir(), '.claude');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'autoreger-root.txt'), ROOT.replace(/\\/g, '/') + '\n', 'utf8');
        const shim = path.join(ROUTING, 'statusline-shim.sh');
        if (fs.existsSync(shim)) {
            const dst = path.join(dir, 'autoreger-statusline.sh');
            fs.copyFileSync(shim, dst);
            if (!IS_WIN) fs.chmodSync(dst, 0o755);
        }
    } catch (e) {
        notes.push(`указатель статус-лайна не обновлён: ${e.message}`);
    }

    // Exec-бит: в индексе git он есть (100755), но старые копии репо приехали как
    // 100644, а `core.fileMode false` (без него chmod ломает git pull) заставляет git
    // об этой разнице молчать. Восстанавливаем сами — иначе двойной клик по
    // .command падает с «нет прав доступа», а node не может позвать шимы.
    if (!IS_WIN) {
        const pats = [path.join(ROOT, 'mac-support', 'shims'), ROUTING, ROOT];
        for (const dir of pats) {
            let names = [];
            try { names = fs.readdirSync(dir); } catch { continue; }
            for (const n of names) {
                if (dir === ROUTING && !n.endsWith('.sh')) continue;
                if (dir === ROOT && !/\.(sh|command)$/.test(n)) continue;
                try { fs.chmodSync(path.join(dir, n), 0o755); } catch { /* не наш файл */ }
            }
        }
    }
    return notes;
}

// ── Лог ──────────────────────────────────────────────────────────────────────
// Своё окно у процессов больше не появляется (решение владельца 24.08), поэтому
// файл — единственное место, где видно причину падения: хаб показывает его хвост,
// если старт не удался.
function rotateLog(svc) {
    const f = serviceLog(svc);
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        if (fs.statSync(f).size > LOG_MAX) fs.renameSync(f, f + '.1');
    } catch { /* нет файла — первый запуск */ }
    return f;
}

function logTail(svc, lines = 25) {
    try {
        return fs.readFileSync(serviceLog(svc), 'utf8').split(/\r?\n/).slice(-lines).join('\n');
    } catch {
        return '(лог пуст — процесс не дожил до первой строки)';
    }
}

// ── Старт одного сервиса ─────────────────────────────────────────────────────
// Нужны ОДНОВРЕМЕННО три свойства, и на Windows их не даёт ни один флаг `spawn`:
//   1. окна нет;
//   2. процесс переживает выход хаба;
//   3. у процесса ЕСТЬ консоль — чтобы его собственные вызовы консольных программ
//      её наследовали, а не заводили себе новую (с окном).
//
// 🪤 Третье требование пропущено 24.08, и это вышло наружу мгновенно: хаб поднимал
// сервисы с `detached: true`, а на Windows это DETACHED_PROCESS — консоли нет ВООБЩЕ.
// Дашборд внутри себя зовёт `netstat`, `taskkill`, `git`, `sqlite3` и `powershell`
// синхронно и без `windowsHide` (47 мест, часть в циклах по портам). Пока он жил в
// видимом окне от `start /MIN`, они молча наследовали его консоль. Без консоли
// Windows обязана выдать каждому такому вызову НОВУЮ — с окном. Снаружи это
// «нажимаю рестарт, и начинается лютый спам окон» (владелец, 24.08).
//
// Замерено на подставных портах, все три свойства сразу:
//   detached: true                  — окон нет, переживает; консоли НЕТ  → внуки мигают
//   windowsHide: true без detached  — окно нет, консоль ЕСТЬ; УМИРАЕТ вместе с родителем
//   Start-Process -WindowStyle Hidden — всё три. Им же поднимал прокси старый bat.
// Комбинировать флаги нельзя: MSDN запрещает DETACHED_PROCESS вместе с
// CREATE_NO_WINDOW, а node передаёт оба — и выигрывает detached.
//
// cmd-обёртка нужна ради ОДНОГО лога: у `Start-Process` есть -RedirectStandardOutput,
// но два сервиса не могут писать в один файл (sharing violation), а `>>` из cmd
// дописывают конкурентно нормально. Кавычки проверены на путях с пробелами —
// сам node лежит в `C:\Program Files\nodejs`.
function windowsCmdQuote(value) {
    const raw = String(value);
    if (!/[\s"&|<>^()%!]/.test(raw)) return raw;
    return `"${raw.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function startService(svc, {
    platform = process.platform,
    spawn: spawnProcess = spawn,
    spawnSync: spawnProcessSync = spawnSync,
    rotateLog: prepareLog = rotateLog,
} = {}) {
    const executable = svc.executable ? path.resolve(svc.executable) : process.execPath;
    const args = svc.executable
        ? (Array.isArray(svc.args) ? svc.args.map(String) : [])
        : [path.resolve(ROUTING, svc.script), ...(Array.isArray(svc.args) ? svc.args.map(String) : [])];
    const cwd = svc.cwd ? path.resolve(svc.cwd) : ROUTING;
    const log = prepareLog(svc);
    const env = serviceEnv(svc);
    if (platform === 'win32') {
        const q = s => `'${String(s).replace(/'/g, "''")}'`;
        const command = [executable, ...args].map(windowsCmdQuote).join(' ');
        const inner = `"${command} >> ${windowsCmdQuote(log)} 2>&1"`;
        const envSet = Object.entries(svc.env || {})
            .map(([key, value]) => `$env:${key.replace(/[^A-Za-z0-9_]/g, '')} = ${q(value)}; `)
            .join('');
        const ps = `${envSet}$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',${q(inner)} `
            + `-WorkingDirectory ${q(cwd)} -WindowStyle Hidden -PassThru; $p.Id`;
        const r = spawnProcessSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
            { encoding: 'utf8', windowsHide: true, env });
        const label = svc.script || path.basename(executable);
        if (r.status !== 0) throw new Error(`Start-Process не смог поднять ${label}: ${String(r.stderr || '').trim().slice(0, 200)}`);
        return Number(String(r.stdout).trim()) || 0;   // pid обёртки; настоящий узнаём по порту
    }

    // POSIX: detached (setsid) — своя группа процессов, закрытие терминала не
    // рассылает ей SIGHUP. Консоль в этом смысле проблемой не является.
    const out = fs.openSync(log, 'a');
    let child;
    try {
        child = spawnProcess(executable, args, {
            cwd,
            detached: true,
            stdio: ['ignore', out, out],
            env,
        });
    } finally {
        fs.closeSync(out);            // handle уже унаследован ребёнком, свой закрываем
    }
    return new Promise((resolve, reject) => {
        const failed = error => {
            child.removeListener('spawn', launched);
            reject(error);
        };
        const launched = () => {
            child.removeListener('error', failed);
            child.unref();
            resolve(child.pid);
        };
        child.once('error', failed);
        child.once('spawn', launched);
    });
}

// Готовность дашборда — по его же ручке статуса, а не по факту «порт слушает»:
// порт открывается раньше, чем сервер готов отвечать.
async function waitReady(port, urlPath, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise(resolve => {
            const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 1500 },
                res => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
        if (ok) return true;
        await sleep(400);
    }
    return false;
}

// ── Статус ───────────────────────────────────────────────────────────────────
// Один снимок netstat/lsof на весь список. role различает, кто чей: 'service' мы
// поднимаем сами, 'child' поднимает дашборд, и лежащий child далеко не всегда
// поломка (keepalive неактивного провайдера лежит штатно).
function statusRows(items, map = listeners(), activePort = activeUpstreamPort(), role = 'service') {
    return items.map(x => {
        const pids = [...(map.get(x.port) || [])];
        const up = pids.length > 0;
        return {
            port: x.port,
            name: x.name,
            role,
            up,
            pids,
            respawn: !!x.respawn,
            // provider services are expected only when selected. Optional services never
            // count as required native-stack health; their own degraded flag remains visible.
            provider: x.provider || undefined,
            optional: !!x.optional,
            expected: x.optional ? false : (x.provider ? x.port === activePort : true),
            degraded: !!x.optional && !up,
        };
    });
}

async function statusRowsVerified(items, map = listeners(), activePort = activeUpstreamPort(), role = 'service', {
    verifyServiceIdentity: verifyIdentity = verifyServiceIdentity,
} = {}) {
    const rows = statusRows(items, map, activePort, role);
    await Promise.all(rows.map(async (row, index) => {
        const svc = items[index];
        if (!svc || !svc.executable || !row.pids.length) return;
        const checks = await Promise.all(row.pids.map(pid => verifyIdentity(svc, pid)));
        const verified = checks.length === 1 && checks[0] === true;
        row.up = verified;
        row.foreign = !verified;
        row.degraded = !!svc.optional && !verified;
    }));
    return rows;
}

async function statusVerified({
    services = SERVICES,
    childItems = children(),
    customItems = customPorts(),
    listeners: getListeners = listeners,
    activeUpstreamPort: getActivePort = activeUpstreamPort,
    verifyServiceIdentity: verifyIdentity = verifyServiceIdentity,
} = {}) {
    const map = getListeners();
    const activePort = getActivePort();
    return [
        ...await statusRowsVerified(services, map, activePort, 'service', {
            verifyServiceIdentity: verifyIdentity,
        }),
        ...statusRows(childItems, map, activePort, 'child'),
        ...statusRows(customItems, map, activePort, 'child'),
    ];
}

function status() {
    const map = listeners();
    const activePort = activeUpstreamPort();
    return [
        ...statusRows(SERVICES, map, activePort, 'service'),
        ...statusRows(children(), map, activePort, 'child'),
        ...statusRows(customPorts(), map, activePort, 'child'),
    ];
}

// ── Остановить ───────────────────────────────────────────────────────────────
// phase: 'stop' — всё, включая keepalive неактивных провайдеров и конвертеры
// Custom (их не снимет уже никто). 'restart' — только то, что дашборд поднимет
// обратно сам; см. комментарий у children().
// Попросить ВСЕ порты плана дожать начатое — параллельно, одним общим окном.
// Возвращает { asked, inflight, freed }: сколько процессов поняли просьбу, сколько
// запросов они дожимали и сколько портов освободилось само.
async function drainAll(ports, waitMs, on = () => {}) {
    if (!(waitMs > 0) || !ports.length) return { asked: 0, inflight: 0, freed: 0 };
    const answers = await Promise.all(ports.map(async port => {
        if (![...(listeners().get(port) || [])].length) return null;
        const r = await askDrainOnce(port);
        return r ? { port, inflight: r.inflight } : null;
    }));
    const asked = answers.filter(Boolean);
    if (!asked.length) return { asked: 0, inflight: 0, freed: 0 };
    const inflight = asked.reduce((n, a) => n + (Number(a.inflight) || 0), 0);
    on({ type: 'drain-begin', ports: asked.map(a => a.port), inflight });
    const deadline = Date.now() + waitMs;
    let left = asked.map(a => a.port);
    while (left.length && Date.now() < deadline) {
        await sleep(150);
        left = left.filter(port => [...(listeners().get(port) || [])].length);
    }
    const freed = asked.length - left.length;
    on({ type: 'drain-done', freed, stuck: left, waited_ms: waitMs - Math.max(0, deadline - Date.now()) });
    return { asked: asked.length, inflight, freed };
}

async function stopServices(services, {
    phase = 'stop',
    on = () => {},
    children: childItems = null,
    listeners: getListeners = listeners,
    pidImage: imageOf = pidImage,
    pidExecutable: executableOf = pidExecutable,
    verifyProcessOwnership: verifyOwnership = verifyProcessOwnership,
    killPort: stopPort = killPort,
    stopLaunched: stopExact = stopLaunched,
    drainAll: drainPorts = drainAll,
} = {}) {
    const plan = killPlan(phase, services, childItems);
    const runnable = [];
    const ownedExternal = new Map();
    const refused = [];

    for (const item of plan) {
        const holders = [...(getListeners().get(item.port) || [])];
        if (item.customProcess) {
            runnable.push(item);
            continue;
        }
        if (item.service && holders.length) {
            const owned = await Promise.all(holders.map(pid => verifyOwnership(item.service, pid, {
                pidImage: imageOf,
                pidExecutable: executableOf,
            })));
            if (owned.some(value => !value)) {
                refused.push({
                    ...item,
                    was: holders,
                    freed: false,
                    denied: false,
                    holding: holders,
                    foreign: true,
                });
                continue;
            }
            if (item.service.executable) ownedExternal.set(item, holders);
        }
        runnable.push(item);
    }

    await drainPorts(runnable.filter(item => !item.customProcess).map(item => item.port), DRAIN_WAIT_MS, on);
    const results = refused.slice();
    for (const item of runnable) {
        on({ type: 'kill-begin', ...item });
        let result;
        if (item.customProcess) {
            result = await cleanupCustomProcess(item.customProcess);
        } else {
            const exactPids = ownedExternal.get(item);
            if (exactPids) {
                const current = [...(getListeners().get(item.port) || [])];
                const unchanged = current.length === exactPids.length
                    && current.every(pid => exactPids.includes(pid));
                const stillOwned = unchanged && (await Promise.all(current.map(pid => verifyOwnership(item.service, pid, {
                    pidImage: imageOf,
                    pidExecutable: executableOf,
                })))).every(Boolean);
                if (!stillOwned) {
                    result = {
                        port: item.port,
                        was: current,
                        freed: current.length === 0,
                        denied: false,
                        holding: current,
                        foreign: current.length > 0,
                    };
                } else {
                    const stopped = await Promise.all(exactPids.map(pid => stopExact(pid)));
                    result = {
                        port: item.port,
                        was: exactPids,
                        freed: stopped.every(row => row && row.freed !== false),
                        denied: stopped.some(row => row && row.denied),
                        holding: stopped.filter(row => !row || row.freed === false).map((_row, index) => exactPids[index]),
                    };
                }
            } else {
                result = await stopPort(item.port);
            }
        }
        results.push({ ...item, ...result });
        on({ type: 'kill-done', ...item, ...result });
        if (result.denied && phase === 'restart') {
            on({ type: 'abort', ...item, ...result });
            break;
        }
    }
    const stuck = results.filter(result => !result.freed);
    return { results, stuck, denied: results.some(result => result.denied), elevated: isElevated() };
}

async function stop({ phase = 'stop', on = () => {} } = {}) {
    let childItems = [...children(), ...customPorts()];
    // Restart keeps a current front-door alive. Stop always includes it.
    if (phase === 'restart' && await frontdoorCodeIsCurrent()) {
        const fd = frontdoorPort();
        childItems = childItems.filter(item => item.port !== fd);
        on({ type: 'note', text: `front-door :${fd} оставлен жить — код в процессе свежий, рвать живые сессии незачем` });
    }
    return stopServices(SERVICES, { phase, on, children: childItems });
}

// ── Запустить ────────────────────────────────────────────────────────────────
// The injectable core is used by isolated dynamic-port tests. Production start()
// supplies the real service table and process adapters.
function publicService(svc, extra = {}) {
    return {
        name: svc.name,
        port: svc.port,
        optional: !!svc.optional,
        ...extra,
    };
}

async function startServices(services, {
    on = () => {},
    listeners: getListeners = listeners,
    activeUpstreamPort: getActivePort = activeUpstreamPort,
    startService: launchService = startService,
    sleep: pause = sleep,
    waitReady: awaitReady = waitReady,
    pidImage: imageOf = pidImage,
    pidExecutable: executableOf = pidExecutable,
    verifyProcessOwnership: verifyOwnership = verifyProcessOwnership,
    verifyServiceIdentity: verifyIdentity = verifyServiceIdentity,
    logTail: tailOf = logTail,
    serviceLog: logOf = serviceLog,
    stopService = killPort,
    stopLaunched: stopLaunch = stopLaunched,
    maxPortPolls = 24,
} = {}) {
    const map = getListeners();
    const started = [];
    const foreign = [];
    const optionalFailures = [];
    const activePort = getActivePort();

    const optionalFailure = (svc, code, text) => {
        const failure = {
            name: svc.name,
            port: svc.port,
            optional: true,
            code,
            text,
        };
        optionalFailures.push(failure);
        on({ type: 'start-optional-failed', ...failure });
    };

    for (const original of services) {
        let svc = original;
        if (svc.provider && svc.port !== activePort) {
            on({ type: 'start-lazy', ...publicService(svc) });
            continue;
        }
        const holders = [...(getListeners().get(svc.port) || [])];
        if (holders.length) {
            if (svc.executable) {
                const owned = await Promise.all(holders.map(pid => verifyOwnership(svc, pid, {
                    pidImage: imageOf,
                    pidExecutable: executableOf,
                })));
                if (owned.some(value => !value)) {
                    const who = holders.filter((_pid, index) => !owned[index])
                        .map(pid => `${imageOf(pid) || '?'} (pid ${pid})`).join(', ');
                    if (svc.optional) optionalFailure(svc, 'port_foreign', `порт :${svc.port} занят чужим процессом: ${who}`);
                    else {
                        foreign.push(publicService(svc, { who }));
                        on({ type: 'start-foreign', ...publicService(svc, { who }) });
                    }
                } else if (holders.length !== 1 || !await verifyIdentity(svc, holders[0], {
                    pidImage: imageOf,
                    pidExecutable: executableOf,
                })) {
                    const stopped = await Promise.all(holders.map(pid => stopLaunch(pid)));
                    const clean = stopped.every(result => result && result.freed !== false);
                    const text = clean
                        ? 'процесс sidecar не прошёл проверку identity и остановлен'
                        : 'процесс sidecar не прошёл проверку identity и не остановлен';
                    if (svc.optional) optionalFailure(svc, 'identity_failed', text);
                    else {
                        on({ type: 'error', ...publicService(svc), text });
                        return { ok: false, started, foreign, optionalFailures, failed: publicService(svc) };
                    }
                } else {
                    on({ type: 'start-skip', ...publicService(svc) });
                }
                continue;
            }
            const alien = holders.filter(pid => !isOursForService(svc, imageOf(pid), executableOf(pid)));
            if (alien.length) {
                const who = alien.map(pid => `${imageOf(pid) || '?'} (pid ${pid})`).join(', ');
                if (svc.optional) optionalFailure(svc, 'port_foreign', `порт :${svc.port} занят чужим процессом: ${who}`);
                else {
                    foreign.push(publicService(svc, { who }));
                    on({ type: 'start-foreign', ...publicService(svc, { who }) });
                }
            } else if (svc.optional && svc.ready && !(await awaitReady(svc.port, svc.ready))) {
                const text = 'порт занят нашим процессом, но статус не отвечает';
                const cleanup = await stopService(svc.port);
                optionalFailure(svc, 'readiness_failed', cleanup && cleanup.freed === false ? `${text}; процесс не остановлен` : text);
            } else {
                on({ type: 'start-skip', ...publicService(svc) });
            }
            continue;
        }
        on({ type: 'start-begin', ...publicService(svc) });
        let launch = 0;
        try {
            if (typeof svc.prepare === 'function') {
                const prepared = await svc.prepare(svc);
                if (prepared && typeof prepared === 'object') svc = { ...svc, ...prepared };
            }
            launch = await launchService(svc);
        } catch (error) {
            if (svc.optional) {
                optionalFailure(svc, 'launch_failed', 'запуск sidecar не удался');
                continue;
            }
            on({ type: 'error', ...svc, text: error.message });
            return { ok: false, started, foreign, optionalFailures, failed: svc, tail: tailOf(svc), log: logOf(svc) };
        }

        let realPid = 0;
        for (let i = 0; i < maxPortPolls && !realPid; i++) {
            await pause(250);
            realPid = [...(getListeners().get(svc.port) || [])][0] || 0;
        }
        if (!realPid) {
            const text = `порт :${svc.port} не занялся`;
            const cleanup = await stopLaunch(launch);
            if (svc.optional) {
                optionalFailure(svc, 'port_not_bound', cleanup && cleanup.freed === false ? `${text}; процесс не остановлен` : text);
                continue;
            }
            on({ type: 'error', ...svc, text });
            return { ok: false, started, foreign, optionalFailures, failed: svc, tail: tailOf(svc), log: logOf(svc) };
        }
        started.push(publicService(svc, { pid: realPid }));

        if (svc.ready && !(await awaitReady(svc.port, svc.ready))) {
            const text = 'порт занят, но статус не отвечает';
            const cleanup = svc.executable ? await stopLaunch(launch) : await stopService(svc.port);
            const startedIndex = started.findIndex(row => row.port === svc.port);
            if (startedIndex >= 0) started.splice(startedIndex, 1);
            if (svc.optional) {
                optionalFailure(svc, 'readiness_failed', cleanup && cleanup.freed === false ? `${text}; процесс не остановлен` : text);
                continue;
            }
            on({ type: 'error', ...svc, text });
            return { ok: false, started, foreign, optionalFailures, failed: svc, tail: tailOf(svc), log: logOf(svc) };
        }
        if (svc.executable && !await verifyIdentity(svc, realPid, {
            pidImage: imageOf,
            pidExecutable: executableOf,
        })) {
            const cleanup = await stopLaunch(launch);
            const startedIndex = started.findIndex(row => row.port === svc.port);
            if (startedIndex >= 0) started.splice(startedIndex, 1);
            const text = cleanup && cleanup.freed === false
                ? 'запущенный sidecar не прошёл проверку identity и не остановлен'
                : 'запущенный sidecar не прошёл проверку identity и остановлен';
            if (svc.optional) {
                optionalFailure(svc, 'identity_failed', text);
                continue;
            }
            on({ type: 'error', ...publicService(svc), text });
            return { ok: false, started, foreign, optionalFailures, failed: publicService(svc) };
        }
        on({ type: 'start-done', ...publicService(svc, { pid: realPid }) });
    }
    return {
        ok: foreign.length === 0,
        started,
        foreign,
        optionalFailures,
        url: 'http://localhost:8200/__switch',
    };
}

// Idempotent: only down services are started. This matters because Claude Code
// itself uses front-door and a needless restart would cut the current session.
async function start({ on = () => {} } = {}) {
    for (const note of preparePlatform()) on({ type: 'note', text: note });
    return startServices(SERVICES, { on });
}

// Порядок «сначала погасить нужное, потом поднять» держится ЗДЕСЬ, а не в хабе:
// иначе он снова окажется в двух местах — ровно то, из-за чего затевался этот файл.
// Хаб добавляет к результату только текст.
async function restart({ on = () => {} } = {}) {
    const s = await stop({ phase: 'restart', on });
    if (s.stuck.length) return { ok: false, stage: 'stop', ...s };
    return { ...(await start({ on })), stage: 'start' };
}

async function restartService(name, {
    services = SERVICES,
    listeners: getListeners = listeners,
    verifyProcessOwnership: verifyOwnership = verifyProcessOwnership,
    stopLaunched: stopExact = stopLaunched,
    startService: launchService = startService,
    sleep: pause = sleep,
    waitReady: awaitReady = waitReady,
    verifyServiceIdentity: verifyIdentity = verifyServiceIdentity,
    writeLaunchRecord = () => {},
    maxPortPolls = 24,
} = {}) {
    const original = services.find(service => service.name === name);
    if (!original) return { ok: false, code: 'service_not_found', name: String(name || '') };

    const holders = [...(getListeners().get(original.port) || [])];
    for (const pid of holders) {
        if (!await verifyOwnership(original, pid)) {
            return { ok: false, code: 'foreign_holder', ...publicService(original), foreign: true };
        }
    }
    for (const pid of holders) {
        const stopped = await stopExact(pid);
        if (!stopped || stopped.freed === false) {
            return { ok: false, code: 'stop_failed', ...publicService(original) };
        }
    }

    let svc = original;
    let launch = 0;
    try {
        if (typeof svc.prepare === 'function') {
            const prepared = await svc.prepare(svc);
            if (prepared && typeof prepared === 'object') svc = { ...svc, ...prepared };
        }
        launch = await launchService(svc);
    } catch {
        return { ok: false, code: 'launch_failed', ...publicService(svc) };
    }

    let pid = 0;
    for (let i = 0; i < maxPortPolls && !pid; i++) {
        await pause(250);
        pid = [...(getListeners().get(svc.port) || [])][0] || 0;
    }
    if (!pid) {
        await stopExact(launch);
        return { ok: false, code: 'port_not_bound', ...publicService(svc) };
    }
    if ((svc.ready && !await awaitReady(svc.port, svc.ready)) || !await verifyIdentity(svc, pid)) {
        await stopExact(launch);
        return { ok: false, code: 'identity_failed', ...publicService(svc) };
    }
    writeLaunchRecord({ name: svc.name, port: svc.port, pid });
    return { ok: true, ...publicService(svc), pid };
}

// ── Поднять конвертер провайдера по требованию ───────────────────────────────
// Обратная сторона ленивого старта: раз на boot их больше не поднимают, кто-то обязан
// поднять при выборе провайдера. Зовёт дашборд из applyTarget ДО того, как обратится к
// порту (у freemodel_rotator он сразу спрашивает активный ключ у :20126, и на пустом
// порту переключение молча получало бы пустой ключ).
//
// Идемпотентно: порт уже слушает — ничего не делаем. Ждём именно ЗАНЯТИЯ ПОРТА, а не
// факта spawn: node мог умереть на первой строке, и «поднял» тогда означало бы неправду.
// → { ok, port, pid, already?, error? }
async function ensureProviderService(port) {
    const svc = SERVICES.find(s => s.provider && s.port === Number(port));
    if (!svc) return { ok: false, port: Number(port), error: 'это не конвертер провайдера' };
    const live = [...(listeners().get(svc.port) || [])];
    if (live.length) return { ok: true, port: svc.port, pid: live[0], already: true };
    try { startService(svc); } catch (e) { return { ok: false, port: svc.port, error: e.message }; }
    for (let i = 0; i < 24; i++) {
        await sleep(250);
        const pid = [...(listeners().get(svc.port) || [])][0];
        if (pid) return { ok: true, port: svc.port, pid, name: svc.name };
    }
    return { ok: false, port: svc.port, error: `порт :${svc.port} не занялся`, tail: logTail(svc) };
}

module.exports = {
    ROOT, ROUTING, IS_WIN, LOG_DIR, serviceLog, isElevated,
    SERVICES, children, customPorts, killPlan, frontdoorPort,
    listeners, killPort, killPid, stopLaunched, status, statusVerified, statusRows, statusRowsVerified,
    start, startServices, stop, stopServices, restart, restartService,
    preparePlatform, childEnv, serviceEnv, waitReady, logTail, sleep, startService,
    pidAlive, pidImage, pidExecutable, pidArguments, healthIdentity, isOurs, isOursForService,
    verifyProcessOwnership, verifyServiceIdentity,
    activeUpstreamPort, ensureProviderService,
};
