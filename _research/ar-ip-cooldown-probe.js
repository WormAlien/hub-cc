#!/usr/bin/env node
/**
 * Замер отстоя адреса после WAF-отбоя agentrouter.
 *
 * Вопрос, на который отвечает проба: адрес, отдавший N перелогинов, уходит в отбой -
 * и СКОЛЬКО ОН ОТДЫХАЕТ. От этого числа зависит вся конструкция ротации: если отстой
 * короче круга по пулу (~35-40 мин на 7 адресах), очередь ждать не будет вовсе.
 *
 * Механика: берём живой адрес, льём через него публичный `/api/status` (аккаунт не
 * тратится, сессия не жжётся), ловим первый отбой, затем щупаем адрес, пока он не
 * ответит снова. Кругов несколько - чтобы увидеть, повторяется ли картина.
 *
 * 🪤 Отбой по WAF и смерть самого прокси выглядят одинаково. Поэтому на каждом щупе
 * идёт ВТОРАЯ проба на другой хост: жив ли прокси как транспорт. Без неё «отдыхал
 * 40 минут» могло бы оказаться «прокси сдох навсегда».
 *
 * 🪤 Адреса из файла скрапера расходные, но часть из них прямо сейчас привязана к
 * живым аккаунтам хаба. Такие проба по умолчанию пропускает: жечь занятый адрес -
 * это уронить чужие чеки (fail-closed).
 *
 * Запуск:
 *   node _research/ar-ip-cooldown-probe.js
 *   node _research/ar-ip-cooldown-probe.js --proxy socks5://1.2.3.4:1080 --burn 30 --burn-gap 6000
 *
 * Ключи: --proxy --list --try --burn --burn-gap --poll-gap --cycles --max-hours
 *        --timeout --host --path --out --jsonl
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POOL = require(path.join(ROOT, 'routing', 'lib', 'proxy-pool.js'));

const argv = process.argv.slice(2);
function arg(name, def) {
    const eq = argv.find(a => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return def;
}

const LIST = arg('list', path.join(ROOT, 'tools', 'proxy-validator', 'export', 'live-for-host.txt'));
const ASSIGN = arg('assign', path.join(ROOT, 'routing', 'proxy-assign.json'));
const OUT_TXT = arg('out', path.join(ROOT, '_research', 'ar-ip-cooldown-probe.txt'));
const OUT_JSONL = arg('jsonl', path.join(ROOT, '_research', 'ar-ip-cooldown-probe.jsonl'));
const HOST = arg('host', 'agentrouter.org');
const URL_PATH = arg('path', '/api/status');
const BURN = Number(arg('burn', 60));
const BURN_GAP = Number(arg('burn-gap', 8000));
const POLL_GAP = Number(arg('poll-gap', 120000));
const CYCLES = Number(arg('cycles', 2));
const MAX_HOURS = Number(arg('max-hours', 4));
const TIMEOUT = Number(arg('timeout', 20000));
const TRY_N = Number(arg('try', 15));
const PROXY_ARG = arg('proxy', null);
const DEAD_POLLS = 3;

const T0 = Date.now();
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const elapsed = () => Math.round((Date.now() - T0) / 1000);
const mins = (ms) => `${(ms / 60000).toFixed(1)} мин`;

const txtStream = fs.createWriteStream(OUT_TXT, { flags: 'a' });
const jsonStream = fs.createWriteStream(OUT_JSONL, { flags: 'a' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function say(line) {
    const s = `[+${elapsed()}s ${stamp()}] ${line}`;
    console.log(s);
    txtStream.write(s + '\n');
}
function event(obj) {
    jsonStream.write(JSON.stringify({ t: stamp(), elapsedS: elapsed(), ...obj }) + '\n');
}

// ---------------------------------------------------------------- транспорт

async function arRequest(proxy) {
    const t0 = Date.now();
    try {
        const res = await POOL.fetchVia(proxy, `https://${HOST}${URL_PATH}`, {
            headers: { accept: 'application/json' },
            timeoutMs: TIMEOUT,
        });
        const text = await res.text();
        const v = POOL.preflightVerdict(res.status, text);
        return {
            ok: v.ok, error: v.error || null, status: res.status,
            ms: Date.now() - t0, body: String(text == null ? '' : text).slice(0, 120),
        };
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e), status: 0, ms: Date.now() - t0, body: '' };
    }
}

// Жив ли прокси КАК ТРАНСПОРТ. Нужен, чтобы отличить отбой по WAF от смерти адреса.
async function transportCheck(proxy) {
    try {
        const res = await POOL.fetchVia(proxy, 'https://api.ipify.org/?format=json', { timeoutMs: TIMEOUT });
        const text = await res.text();
        let ip = null;
        try { ip = JSON.parse(text).ip; } catch { /* не JSON - не беда */ }
        return { ok: res.status === 200, status: res.status, ip };
    } catch (e) {
        return { ok: false, status: 0, error: (e && e.message) || String(e) };
    }
}

// ---------------------------------------------------------------- выбор адреса

function busyProxies() {
    const busy = new Set();
    try {
        const j = JSON.parse(fs.readFileSync(ASSIGN, 'utf8'));
        for (const rec of Object.values(j.assign || {})) {
            if (rec && rec.proxy) busy.add(String(rec.proxy).trim());
        }
    } catch { /* нет файла - значит и занятых нет */ }
    return busy;
}

async function pickProxy() {
    if (PROXY_ARG) {
        const p = POOL.parseProxy(PROXY_ARG, 'http');
        if (!p) { say(`--proxy не разобран: ${PROXY_ARG}`); return null; }
        say(`взят заданный прокси: ${PROXY_ARG}`);
        return { line: PROXY_ARG, proxy: p };
    }
    const raw = fs.readFileSync(LIST, 'utf8').split(/\r?\n/).map(s => s.trim())
        .filter(s => s && !s.startsWith('#'));
    const busy = busyProxies();
    const free = raw.filter(line => !busy.has(line));
    say(`в списке ${raw.length}, из них занято живыми аккаунтами ${raw.length - free.length} - их не жжём`);
    say(`щупаю до ${TRY_N} свободных, ищу живой на ${HOST}${URL_PATH}`);
    let tried = 0;
    for (const line of free) {
        if (tried >= TRY_N) break;
        tried++;
        const p = POOL.parseProxy(line, 'http');
        if (!p) continue;
        const r = await arRequest(p);
        if (r.ok) {
            say(`выбран ${line} (${r.status}, ${r.ms} мс) - он и будет сожжён`);
            return { line, proxy: p };
        }
        say(`  мимо ${line}: ${r.error}`);
    }
    return null;
}

// ---------------------------------------------------------------- фазы

async function burnPhase(proxy, cycle) {
    say(`--- круг ${cycle}: жгу, до ${BURN} запросов с паузой ${BURN_GAP} мс ---`);
    let sent = 0, okCount = 0, last = null;
    for (let i = 1; i <= BURN; i++) {
        const r = await arRequest(proxy);
        sent++;
        if (r.ok) okCount++; else last = r;
        const show = !r.ok || i <= 5 || i % 5 === 0;
        if (show) {
            say(`  запрос ${i}: ${r.ok ? 'ok' : 'ОТБОЙ: ' + r.error} (${r.status}, ${r.ms} мс)`
                + (r.body ? ` | ${r.body.slice(0, 60)}` : ''));
        }
        event({ kind: 'burn', cycle, n: i, ...r });
        if (!r.ok) break;
        if (i < BURN) await sleep(BURN_GAP);
    }
    if (okCount === BURN) {
        say(`круг ${cycle}: ${BURN} запросов подряд прошли, отбоя НЕ БЫЛО`);
        event({ kind: 'burn-end', cycle, sent, okCount, verdict: 'no-block' });
        return { blocked: false };
    }
    say(`круг ${cycle}: отбой на запросе ${sent} (успешных до него ${okCount})`
        + (last ? `: ${last.error}` : ''));
    event({ kind: 'burn-end', cycle, sent, okCount, error: last && last.error, body: last && last.body });
    return { blocked: true };
}

async function healPhase(proxy, cycle) {
    const blockStart = Date.now();
    let poll = 0, deadStreak = 0;
    while (true) {
        await sleep(POLL_GAP);
        poll++;
        const r = await arRequest(proxy);
        const healMs = Date.now() - blockStart;
        let transport = null;
        if (!r.ok) {
            transport = await transportCheck(proxy);
            deadStreak = transport.ok ? 0 : deadStreak + 1;
        }
        const tail = transport
            ? (transport.ok ? `; транспорт жив, выход ${transport.ip || '?'}` : `; транспорт МЁРТВ (${transport.error || transport.status})`)
            : '';
        say(`  щуп ${poll} (${mins(healMs)}): ${r.ok ? 'ЖИВОЙ' : 'ещё отбой: ' + r.error}${tail}`);
        event({ kind: 'poll', cycle, poll, healMs, ...r, transport });
        if (r.ok) {
            say(`*** АДРЕС ВЕРНУЛСЯ через ${Math.round(healMs / 1000)} с (${mins(healMs)}) после отбоя ***`);
            event({ kind: 'healed', cycle, healMs });
            return { healed: true, healMs };
        }
        if (deadStreak >= DEAD_POLLS) {
            say(`*** прокси не отвечает ${DEAD_POLLS} щупа подряд - сам адрес мёртв, отстой НЕ измерен ***`);
            event({ kind: 'proxy-dead', cycle, poll });
            return { healed: false, dead: true };
        }
        if (Date.now() - T0 > MAX_HOURS * 3600e3) {
            say('лимит времени вышел - останавливаюсь, отстой НЕ измерен');
            event({ kind: 'timeout', cycle });
            return { healed: false, timeout: true };
        }
    }
}

async function main() {
    say(`=== замер отстоя | ${HOST}${URL_PATH} | burn=${BURN} burn-gap=${BURN_GAP}ms `
        + `poll-gap=${POLL_GAP}ms cycles=${CYCLES} ===`);
    const picked = await pickProxy();
    if (!picked) { say('живого свободного адреса не нашлось - стоп'); return; }
    const transport = await transportCheck(picked.proxy);
    say(`выходной адрес пробы: ${transport.ip || '?'} (ipify ${transport.status})`);
    event({ kind: 'start', proxy: picked.line, exitIp: transport.ip, burn: BURN, burnGap: BURN_GAP, pollGap: POLL_GAP });

    for (let cycle = 1; cycle <= CYCLES; cycle++) {
        const burn = await burnPhase(picked.proxy, cycle);
        if (!burn.blocked) {
            say(`итог: за ${BURN} запросов на этом темпе адрес не сжёгся - лимит выше, `
                + `поднять --burn или ускорить --burn-gap`);
            return;
        }
        const heal = await healPhase(picked.proxy, cycle);
        if (heal.dead || heal.timeout) return;
        if (cycle < CYCLES) await sleep(5000);
    }
    say('=== замер закончен ===');
}

main().catch(e => { say('ПАДЕНИЕ: ' + ((e && e.stack) || e)); process.exit(1); });
