#!/usr/bin/env node
// Очередь чек-инов переживает рестарт дашборда.
//
// Владелец 21.09: «нажимал забрать все забрались не все». Живой замер: 21:48 МСК кнопка
// поставила 6 из 48 готовых с добором до конца, к 21:55 отработали 10, в 21:55:51 `:8200`
// поднялся заново - очередь жила в памяти и исчезла МОЛЧА, вместе с 2 заданиями и ~38
// готовыми аккаунтами. Ни строки в логе, ни плашки: карточка просто перестала обновляться.
//
// Решение владельца 21.09: очередь пишется на диск и поднимается обратно, но сама НЕ
// стартует - на вкладке плашка «пачка прервана перезапуском: N ждут» и кнопка «Продолжить».
// Молча возобновлять чужую волю нельзя: рестарт бывает и намеренным.
//
// Запуск: node tools/check-checkin-durable.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const lf = (s) => s.replace(/\r\n/g, '\n');
const PROXY = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8'));
const HTML = lf(fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8'));
const OLD = process.env.CHECK_OLD_SRC
    ? lf(fs.readFileSync(process.env.CHECK_OLD_SRC, 'utf8')) : null;
const OLD_HTML = process.env.CHECK_OLD_HTML
    ? lf(fs.readFileSync(process.env.CHECK_OLD_HTML, 'utf8')) : null;

let fail = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? '·' : '×'} ${what}`);
    if (!ok) fail++;
};

// ── 1. снимок пишется ──
console.log('\n1. очередь уезжает на диск');
check(/const AR_QUEUE_FILE = path\.join\(__dirname, 'runtime', 'ar-checkin-queue\.json'\)/.test(PROXY),
    'снимок лежит в routing/runtime - рядом с прочим рантаймом, не в корне репо');
check(/function arQueueSave\(\)/.test(PROXY) && /durableWriteJson\(AR_QUEUE_FILE/.test(PROXY),
    'пишется durable-записью (tmp + fsync + rename), а не writeFileSync');
{
    check(/arQueueSave\(\);/.test(PROXY.slice(PROXY.indexOf('function arEnqueueBatch('), PROXY.indexOf('async function handleArCheckinAll('))),
        'постановка пачки в очередь сохраняет снимок');
    check(/arQueueSave\(\)/.test(PROXY.slice(PROXY.indexOf("const at = AR_CHECKIN_QUEUE.findIndex"), PROXY.indexOf('async function handleArCheckinCancel'))),
        'взятие задания из очереди (сразу после сплайса) сохраняет снимок');
    check(/arQueueSave\(\)/.test(PROXY.slice(PROXY.indexOf('function arCheckinCancel('), PROXY.indexOf('function arBatchSnapshot('))),
        'стоп-кран сохраняет снимок');
    check(/arQueueSave\(\);/.test(PROXY.slice(PROXY.indexOf("proc.on('exit'"), PROXY.indexOf('async function handleArCheckinCancel'))),
        'закрытие окна прогона сохраняет снимок');
}

// ── 2. подъём на старте и ожидание кнопки ──
console.log('\n2. подъём после рестарта');
check(/arQueueRestore\(\)/.test(PROXY.slice(PROXY.indexOf('server.listen(LISTEN_PORT'), PROXY.indexOf('server.listen(LISTEN_PORT') + 900)),
    'очередь поднимается на старте дашборда');
check(!/arCheckinPump\(\)/.test(PROXY.slice(PROXY.indexOf('try { arQueueRestore(); }'), PROXY.indexOf("console.log(`  edits"))),
    'насос из подъёма НЕ зовётся: восстановленная пачка ждёт кнопки');
check(/AR_QUEUE_RESTORED/.test(PROXY) && /restored: AR_QUEUE_RESTORED/.test(PROXY),
    'состояние «пачка ждёт» уезжает на фронт вместе с прогрессом');
check(/AR_QUEUE_MAX_AGE_MS/.test(PROXY) && /снимок очереди от/.test(PROXY),
    'старый снимок (протухшее суточное окно) не восстанавливается, а честно называется в логе');

// ── 3. поведение: снимок → подъём ──
// Статика выше ловит форму. Здесь исполняем настоящие arQueueSave/arQueueRestore на
// временном каталоге: проверяем, что подъём отсеивает забранное, признаёт прогон,
// догнавший без нас, и заполняет очередь ожидания.
console.log('\n3. поведение: что поднимается обратно, а что нет');
{
    const from = PROXY.indexOf('const AR_CHECKIN_BATCH_MAX = 6;');
    const to = PROXY.indexOf('function arBatchSnapshot(');
    const block = PROXY.slice(from, to);
    const CHECKIN_LOG_RE = new Function(`return ${(PROXY.match(/const CHECKIN_LOG_RE = (\/.*\/);/) || [])[1]};`)();

    function sandbox({ sessions = [], logs = {}, logAgeMs = 30_000, nowMs = Date.now(), cfg = { resetHhmmMsk: '19:30', bonusUsd: 25 } } = {}) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-queue-'));
        fs.mkdirSync(path.join(tmp, 'runtime'), { recursive: true });
        fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
        for (const [name, body] of Object.entries(logs)) {
            const p = path.join(tmp, 'logs', name);
            fs.writeFileSync(p, body);
            fs.utimesSync(p, new Date(nowMs - logAgeMs), new Date(nowMs - logAgeMs));   // возраст прогона
        }
        const saved = [];
        const merged = [];
        const notes = [];
        const deps = {
            durableWriteJson: (file, value) => { saved.push({ file, value }); fs.writeFileSync(file, JSON.stringify(value)); },
            logLine: () => {},
            arPidAlive: () => false,
            arLkPids: new Map(),
            arRunKind: new Map(),
            AR_AUTO_CHECKIN: new Map(),
            AR_CHECKIN_QUEUE: [],
            // Окно суток началось час назад: всё, что отмечено раньше, - с прошлого окна.
            arCheckinWindowStartMs: () => nowMs - 3600_000,
            arReadCheckinCfg: () => cfg,
            arLoad: () => sessions,
            arSaveMerge: (s) => { merged.push({ ...s }); },
            CHECKIN_LOG_RE,
            // Заглушка журнала: события собираем строкой, чтобы проверить их текст.
            arNote: (kind, text) => { notes.push({ kind, text }); },
        };
        const pathStub = {
            join: (...parts) => (parts[0] === tmp
                ? [tmp, ...parts.slice(1).filter(p => p !== '..')].join(path.sep)
                : path.join(...parts)),
            basename: (p) => path.basename(p),
        };
        const fn = new Function('deps', 'fs', 'path', '__dirname', `
            const { durableWriteJson, logLine, arPidAlive, arLkPids, arRunKind, AR_AUTO_CHECKIN,
                    AR_CHECKIN_QUEUE, arCheckinWindowStartMs, arReadCheckinCfg, arLoad, arSaveMerge,
                    CHECKIN_LOG_RE, arNote } = deps;
            ${block}
            return { arQueueSave, arQueueRestore, arRunLogVerdict, AR_CHECKIN_BATCH, AR_COLLECT_SEEN,
                     AR_CHECKIN_QUEUE, AR_AUTO_CHECKIN,
                     restored: () => AR_QUEUE_RESTORED, queueFile: () => AR_QUEUE_FILE };
        `);
        const api = fn(deps, fs, pathStub, tmp);
        return { api, tmp, saved, merged, notes, deps };
    }

    const job = (id, name, extra = {}) => ({ id, label: 'acct_' + id, dispName: name, mode: 'autocheckin', wantCheckin: true, wantAuto: true, batch: true, ...extra });
    const acc = (id, name, checkinAt = null) => ({ id, name, api_key: 'sk-x', status: 'live', checkinAt });

    // (а) снимок пишется и читается как есть
    {
        const s = sandbox({ sessions: [acc('1', 'faithfulpho'), acc('2', 'sandylashes')] });
        s.api.AR_CHECKIN_QUEUE.push(job('1', 'faithfulpho'), job('2', 'sandylashes'));
        s.depts = s.deps;
        s.api.arQueueSave();
        check(s.saved.length === 1 && /ar-checkin-queue\.json$/.test(s.saved[0].file),
            'снимок ушёл в файл очереди');
        check((s.saved[0].value.queue || []).length === 2, 'в снимке обе ждущие метки');
    }

    // (б) подъём: забранное, пока нас не было, в очередь НЕ возвращается
    {
        const s = sandbox({ sessions: [acc('1', 'faithfulpho', new Date(Date.now() - 600_000).toISOString()), acc('2', 'sandylashes')] });
        s.api.AR_CHECKIN_QUEUE.push(job('1', 'faithfulpho'), job('2', 'sandylashes'));
        s.api.arQueueSave();
        s.api.AR_CHECKIN_QUEUE.length = 0;                       // «рестарт»: память пуста
        const r = s.api.arQueueRestore();
        check(s.api.AR_CHECKIN_QUEUE.length === 1 && s.api.AR_CHECKIN_QUEUE[0].dispName === 'sandylashes',
            'поднялось только то, что ещё не забрано');
        check(r && r.jobs === 1 && r.taken === 1, 'в состоянии для карточки видно: 1 ждёт, 1 забран');
        check(s.api.AR_AUTO_CHECKIN.get('acct_2').state === 'queued',
            'поднятое задание получает карточку статуса «в очереди», а не висит без неё');
    }

    // (в) прогон, который в момент падения был в полёте, мог догнать сам
    {
        const runLog = 'ar-checkin-acct_3-2026-09-21T21-50-00.log';
        const s = sandbox({
            sessions: [acc('3', 'optimalmoon')],
            logs: { [runLog]: '🔑 шлюз принял GitHub-вход\nAUTOCHECKIN_RESULT {"checkedIn":true,"message":""}\n' },
        });
        s.api.AR_CHECKIN_QUEUE.push(job('3', 'optimalmoon', { interrupted: true }));
        s.api.arQueueSave();
        const doc = JSON.parse(fs.readFileSync(s.api.queueFile(), 'utf8'));
        doc.running = doc.queue; doc.queue = [];                 // так выглядел снимок в момент падения
        fs.writeFileSync(s.api.queueFile(), JSON.stringify(doc));
        s.api.AR_CHECKIN_QUEUE.length = 0;                       // «рестарт»: память пуста
        const r = s.api.arQueueRestore();
        check(s.api.AR_CHECKIN_QUEUE.length === 0, 'догнавший сам в очередь не возвращается');
        check(r && r.settled === 1, 'он назван отдельным счётом «догнали сами»');
        check(s.merged.length === 1 && s.merged[0].checkinAt,
            'отметка «подарок забран» восстановлена по логу прогона — иначе аккаунт поехал бы второй раз');
        check(s.notes.some(n => /без нас/.test(n.text)), 'и в журнал вкладки это попало строкой');
    }

    // (г) прогон из полёта, который НЕ догнал, возвращается в очередь и помечен
    {
        const runLog = 'ar-checkin-acct_4-2026-09-21T21-50-00.log';
        const s = sandbox({ sessions: [acc('4', 'presentkid')], logs: { [runLog]: '🚪 вышел через меню профиля\n' } });
        s.api.AR_CHECKIN_QUEUE.push(job('4', 'presentkid', { interrupted: true }));
        s.api.arQueueSave();
        const doc = JSON.parse(fs.readFileSync(s.api.queueFile(), 'utf8'));
        doc.running = doc.queue; doc.queue = [];
        fs.writeFileSync(s.api.queueFile(), JSON.stringify(doc));
        s.api.AR_CHECKIN_QUEUE.length = 0;                       // «рестарт»: память пуста
        const r = s.api.arQueueRestore();
        check(s.api.AR_CHECKIN_QUEUE.length === 1 && s.api.AR_CHECKIN_QUEUE[0].interrupted === true,
            'недоехавший прогон возвращается в очередь с пометкой «стоял на середине»');
        check(r && r.interrupted === 1 && !s.merged.length,
            'и это видно в плашке: логин мог остаться погашенным, повтор войдёт заново');
    }

    // (д) старый снимок не поднимаем
    {
        const s = sandbox({ sessions: [acc('5', 'lovingfairy')] });
        s.api.AR_CHECKIN_QUEUE.push(job('5', 'lovingfairy'));
        s.api.arQueueSave();
        const old = JSON.parse(fs.readFileSync(s.api.queueFile(), 'utf8'));
        old.at = new Date(Date.now() - 7 * 3600_000).toISOString();   // 7 часов: окно сменилось
        fs.writeFileSync(s.api.queueFile(), JSON.stringify(old));
        s.api.AR_CHECKIN_QUEUE.length = 0;                       // «рестарт»: память пуста
        const r = s.api.arQueueRestore();
        check(r === null && s.api.AR_CHECKIN_QUEUE.length === 0, 'снимок старше 6 ч не поднимается');
        check(s.notes.some(n => /старше/.test(n.text)), 'и об этом сказано в журнале, а не молча');
    }

    // (е) удачный прогон НЕДЕЛЬНОЙ давности не считается «догнал сам».
    // 🪤 Такую ловушку чуть не принесла первая редакция: снимок за сегодня, а файл прогона
    // искался «по метке, без границы по времени» - удачный старый лог закрывал бы задание,
    // и подарок в этот день остался бы не забран.
    {
        const runLog = 'ar-checkin-acct_6-2026-09-14T10-00-00.log';
        const s = sandbox({
            sessions: [acc('6', 'grouchyvanit')],
            logs: { [runLog]: 'AUTOCHECKIN_RESULT {"checkedIn":true,"message":""}\n' },
            nowMs: Date.now() - 7 * 24 * 3600_000,               // прогон был неделю назад
        });
        s.api.AR_CHECKIN_QUEUE.push(job('6', 'grouchyvanit', { interrupted: true }));
        s.api.arQueueSave();
        const doc = JSON.parse(fs.readFileSync(s.api.queueFile(), 'utf8'));
        doc.at = new Date().toISOString();                       // снимок свежий: рестарт только что
        doc.running = doc.queue; doc.queue = [];
        fs.writeFileSync(s.api.queueFile(), JSON.stringify(doc));
        s.api.AR_CHECKIN_QUEUE.length = 0;
        const r = s.api.arQueueRestore();
        check(s.api.AR_CHECKIN_QUEUE.length === 1 && r && r.jobs === 1,
            'давний удачный прогон не закрывает задание — оно остаётся в очереди');
        check(!s.merged.length, 'и отметка по чужому логу не ставится');
    }
}

check(/AR_QUEUE_BUSY_HOLD_MS/.test(PROXY) && /прогон пережил перезапуск и ещё идёт/.test(PROXY),
    'прогон, который пережил перезапуск и ещё идёт, ждут, а не поднимают второе окно на тот же профиль');
check(/AR_QUEUE_LOG_SLACK_MS/.test(PROXY) && /restoredSince/.test(PROXY),
    'файлы прогонов ищутся с границей по времени: удачный лог недельной давности задание не закрывает');
check(/arQueueSave\(\);\s*\n\s*return proc;/.test(PROXY),
    'снимок пишется и после старта прогона - иначе рестарт посреди окна потерял бы задание совсем');

// ── 4. вкладка ──
console.log('\n4. что видит владелец на вкладке');
check(/<div id="ar-journal"/.test(HTML), 'на вкладке AgentRouter есть карточка журнала');
check(/Пачка прервана перезапуском дашборда/.test(HTML), 'в ней плашка про прерванную пачку');
check(/arResumeBatch/.test(HTML) && /▶ Продолжить с этого места/.test(HTML),
    'и кнопка «Продолжить», а не надежда на второй заход');
check(/arJournalPoll/.test(HTML) && /checkin-events\?since=/.test(HTML),
    'журнал тянется с номером последнего события, а не перечитывается целиком');
check(/case 'agentrouter':\s+loadArSessionsLight\(\); arJournalKick\(\);/.test(HTML),
    'тик вкладки обновляет журнал');
check(/AR_JOURNAL_STYLE/.test(HTML) && /grant:\s*'text-emerald/.test(HTML),
    'победа, отказ и этап различаются цветом');
check(/GET' && req\.url\.startsWith\('\/__switch\/api\/ar\/checkin-events'\)/.test(PROXY),
    'ручка журнала зарегистрирована в роутере');

if (OLD) {
    console.log('\n5. краснота на старом коде');
    check(!/arQueueRestore/.test(OLD), 'до правки подъёма очереди не было вовсе');
    check(!/AR_QUEUE_FILE/.test(OLD), 'и снимка на диск тоже');
    check(!/checkin-events/.test(OLD), 'ручки журнала не было — «чё происходит» спрашивать было негде');
    if (OLD_HTML) {
        check(!/ar-journal/.test(OLD_HTML), 'карточки журнала на вкладке не было');
        check(!/Пачка прервана перезапуском/.test(OLD_HTML), 'и про прерванную пачку вкладка молчала');
    }
}

console.log(fail ? `\n❌ ${fail} провалено` : '\n✅ Очередь чек-инов переживает рестарт, а журнал сбора виден на вкладке.');
process.exit(fail ? 1 : 0);
