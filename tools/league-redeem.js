#!/usr/bin/env node
'use strict';
// league-redeem.js — разменять приглашение Лиги НА ЭТОЙ машине и записать свой токен.
//
// Зачем отдельный инструмент. `POST /join` у приёмника публичный: ключа не требует,
// потому что у свежей установки токена ещё нет — она его здесь и получает. Но хаб
// всегда добавляет к запросу СВОЙ `X-League-Key` (см. `leagueProxy`), и приёмник
// опознаёт по нему уже существующего участника: `authOf(req)` находит запись,
// `inviteValidate` уходит в ветку `replay`, новый `token` не выдаётся, и в ответ
// приходит ЧУЖАЯ личность. Проверено живьём 22.11.2026: размен со своего хаба вернул
// мою же запись (WormAlien) вместо новой, а приглашение при этом сожглось.
//
// Отсюда правило: приглашение разменивает ТА машина, которая вступает. Этот скрипт
// говорит с приёмником напрямую и НЕ отправляет никакого ключа, поэтому приёмник
// честно заводит новую личность и отдаёт токен, показанный один раз.
//
// Использование:
//   node tools/league-redeem.js --code=<код или xgl1_…>            # разменять
//   node tools/league-redeem.js --code=<…> --dry-run                # показать, не писать
//   node tools/league-redeem.js --url=https://lg.xgate.online:2083 --code=<…>
//
// Секрет не печатается в лог и не попадает в аргументы командной строки: токен
// приходит в теле ответа и сразу пишется в конфиг с правами 0600.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'routing', 'league-config.json');
const BOOTSTRAP_FILE = path.join(ROOT, 'routing', 'league-bootstrap.json');

const argv = process.argv.slice(2);
const has = n => argv.includes('--' + n);
const opt = (n, d) => {
    const p = '--' + n + '=';
    const hit = argv.find(a => a.startsWith(p));
    return hit === undefined ? d : hit.slice(p.length);
};

const DRY = has('dry-run');
const CODE_RAW = String(opt('code', '')).trim();

function die(msg) { console.error('\n⛔ ' + msg + '\n'); process.exit(1); }

if (!CODE_RAW) die('нужен --code=<код приглашения или строка xgl1_…>\n'
    + '   код выдаёт участник группы: вкладка «Лига» → приглашение');
if (/^xgl1_/.test(CODE_RAW) && CODE_RAW.length < 20) die('строка приглашения обрезана');

// ── Куда стучимся ────────────────────────────────────────────────────────────
// Тот же порядок, что у хаба: живой конфиг, затем bootstrap свежей установки.
function receiverUrl() {
    const explicit = String(opt('url', '')).trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    for (const f of [CONFIG_FILE, BOOTSTRAP_FILE]) {
        try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d && d.url) return String(d.url).replace(/\/+$/, '');
        } catch { /* файла нет или он битый — идём дальше */ }
    }
    return '';
}

const URL_BASE = receiverUrl();
if (!URL_BASE) die('адрес приёмника неизвестен: нет routing/league-config.json и league-bootstrap.json\n'
    + '   дай явно: --url=https://lg.xgate.online:2083');
if (!/^https?:\/\//i.test(URL_BASE)) die('адрес должен начинаться с http(s)://: ' + URL_BASE);

const PIN = String(opt('pin', '')).trim();
const TIMEOUT_MS = Math.max(5, Number(opt('timeout', 25)) || 25) * 1000;

// ── Прочитанное состояние: не затрём живое ───────────────────────────────────
// 🔴 Если на этой машине уже есть РАБОЧИЙ токен, размен приглашения — это вторая
// личность на ту же установку: дубль в рейтинге и путаница в чате. Поэтому по
// умолчанию отказываем, а перезапись — только явным --force.
let existing = null;
try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* свежая установка */ }
if (existing && existing.key && !has('force')) {
    console.log('\n⚠️  на этой машине уже есть routing/league-config.json с ключом.');
    console.log('   Размен приглашения заведёт ВТОРУЮ личность на ту же установку —');
    console.log('   в рейтинге будет два «себя», и старый доступ потеряется.');
    console.log('   Если это осознанно: тем же вызовом с --force\n');
    process.exit(1);
}

console.log('\nЛига: размен приглашения\n');
console.log('  приёмник: ' + URL_BASE);
console.log('  режим:    ' + (DRY ? 'проверить, ничего не писать' : 'разменять и записать токен'));

function body() {
    // Приёмник принимает и голый код, и блоб `xgl1_…` — отдаём как дали.
    return JSON.stringify(/^xgl1_/.test(CODE_RAW) ? { invite: CODE_RAW } : { code: CODE_RAW });
}

// ── Запрос БЕЗ ключа ─────────────────────────────────────────────────────────
// Это и есть суть: ни `X-League-Key`, ни каких-либо других заголовков личности.
// Пин (если задан) проверяется до отправки тела — на случай соединения по IP.
function redeem() {
    const b = body();
    return new Promise((resolve, reject) => {
        const u = new URL(URL_BASE + '/join');
        const tls = u.protocol === 'https:';
        const lib = tls ? https : http;
        const opts = {
            host: u.hostname, port: u.port || (tls ? 443 : 80),
            path: u.pathname, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) },
            timeout: TIMEOUT_MS,
        };
        if (tls) {
            opts.agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
            // Пин нужен только там, где нечем проверить цепочку (соединение по IP).
            if (PIN) { opts.rejectUnauthorized = false; opts.servername = undefined; }
        }
        const r = lib.request(opts, res => {
            const parts = [];
            res.on('data', c => parts.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }));
        });
        if (tls && PIN) {
            r.on('socket', s => s.on('secureConnect', () => {
                let got = '';
                try { got = s.getPeerCertificate().fingerprint256 || ''; } catch { /* нет сертификата */ }
                const norm = x => String(x || '').replace(/:/g, '').toLowerCase();
                if (norm(got) !== norm(PIN)) r.destroy(new Error('отпечаток не совпал — секрет не отправлен'));
            }));
        }
        r.on('timeout', () => r.destroy(new Error(`таймаут ${Math.round(TIMEOUT_MS / 1000)} с`)));
        r.on('error', reject);
        r.write(b);
        r.end();
    });
}

function saveConfig(token, doc) {
    const out = { enabled: true, url: URL_BASE };
    if (PIN) out.pin = PIN;
    out.key = token;
    if (existing && existing.everyMin) out.everyMin = existing.everyMin;
    else if (doc && doc.everyMin) out.everyMin = doc.everyMin;
    else out.everyMin = 10;
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_FILE);
}

(async () => {
    let r;
    try { r = await redeem(); }
    catch (e) { die(`приёмник не ответил: ${e.message}\n   это сетевая ошибка, а не отказ в приглашении`); }

    let d = null;
    try { d = JSON.parse(r.body); } catch { /* ответ не JSON */ }

    if (r.status === 401 || r.status === 403 || r.status === 409 || r.status === 429) {
        // Приёмник ответил про личность или приглашение. Частный и самый частый
        // случай — приглашение уже разменял кто-то другой (409): код одноразовый.
        die('приёмник отказал: ' + String((d && d.error) || r.body.slice(0, 160))
            + (d && d.hint ? '\n   ' + d.hint : ''));
    }
    if (r.status !== 200 || !d || d.ok !== true) {
        die(`приёмник ответил ${r.status}: ${String((d && d.error) || r.body.slice(0, 200))}`);
    }

    if (d.replay) {
        // Приёмник опознал по токену, а мы его не отправляли — значит ключ всё же уехал
        // (старая сборка хаба?). Это не успех: новая личность не заведена.
        die('приёмник вернул replay вместо новой личности — токен этой установки ему уже известен.\n'
            + '   Размен должен идти с машины, которая вступает, и без ключа в заголовках.');
    }

    const token = String(d.token || '');
    if (!token) die('приёмник ответил ok, но без токена — размен не состоялся');

    console.log('\n  ✅ личность заведена');
    console.log('  memberId: ' + String(d.memberId || '—').slice(0, 16));
    console.log('  групп: ' + (Array.isArray(d.groups) ? d.groups.length : 0));
    // Ник — не секрет, но и он не нужен: печатаем только факт, что он придёт срезом.
    console.log('  токен: получен (' + token.length + ' симв.), в лог не печатается');

    if (DRY) {
        console.log('\n--dry-run: конфиг НЕ записан, токен не сохранён.\n');
        process.exit(0);
    }
    try {
        saveConfig(token, d);
        console.log('\n  записано: ' + CONFIG_FILE);
        console.log('  права 0600: читать может только владелец\n');
        console.log('дальше: обмен начнётся сам в течение ' + (existing && existing.everyMin || 10) + ' мин.');
        console.log('  не ждать: curl -X POST http://127.0.0.1:8200/__switch/api/league/sync');
        console.log('  видно тут: http://127.0.0.1:8200/__switch/api/league\n');
        process.exit(0);
    } catch (e) {
        die(`токен получен, но конфиг не записался: ${e.message}\n`
            + '   ТОКЕН НЕ ПОКАЗАН и уже не будет показан — попроси новое приглашение');
    }
})();
