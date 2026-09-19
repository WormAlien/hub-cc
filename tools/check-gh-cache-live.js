#!/usr/bin/env node
/**
 * check-gh-cache-live.js — регресс на «годность снимка решает срок его куки, а не возраст файла».
 *
 * Инвариант одной строкой: снимок GitHub-сессии отбрасывается, только если его `user_session`
 * истекла (или её вовсе нет) — а не потому, что файлу больше CACHE_TTL_MS (7 суток).
 *
 * Почему файл существует: 19.09 владелец нажал «🐙 из менеджера» под justwoker и получил 409
 * «нет живой user_session». В кэше лежал снимок с кукой до 22.09 (полностью рабочий, 11 суток
 * от роду), но гейт мерил ВОЗРАСТ ФАЙЛА: TTL 7 суток против реальных 14 суток жизни куки
 * GitHub. Снимок выбрасывался, заселение уходило харвестить профили, где та же кука истекла
 * 05-16.09 (Chromium просроченную не отдаёт) → код 3 → отказ. По банку снимков тогда же:
 * 22 живых отброшены TTL против 4 свежих. Разбор — wiki/log.md [2026-09-19 19:44].
 *
 * Запуск:  node tools/check-gh-cache-live.js     (exit 1 = инвариант порван)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROXY = path.join(ROOT, 'routing', 'transparent-proxy.js');
const LIB = path.join(ROOT, 'routing', 'lib', 'github-session.js');

const fails = [];
const ok = [];

function read(p) {
    try { return fs.readFileSync(p, 'utf8'); }
    catch (e) { fails.push(`не читается ${p}: ${e.message}`); return ''; }
}
const proxy = read(PROXY);
const lib = read(LIB);

// ---- 1. Оба пути заселения решают по сроку куки -----------------------------
// Гейт по TTL выглядел так: `if (snap && gsl.cacheStale(snap)) snap = null;` — именно он
// выбрасывал живой снимок. Обе точки (⭐ и 🐙 из менеджера) обязаны мерить срок куки.
hasNot(proxy, 'gsl.cacheStale(snap)) snap = null',
    'путь заселения рубит снимок по возрасту файла (cacheStale) вместо срока куки',
    'путь заселения больше не рубит снимок по возрасту файла');
hasNot(proxy, 'gsl.cacheStale(snap)) { snap = null',
    'путь 🐙 из менеджера рубит снимок по возрасту файла (cacheStale)',
    'путь 🐙 из менеджера больше не рубит снимок по возрасту файла');

{
    const gates = (proxy.match(/gsl\.cacheLive\(snap\)/g) || []).length;
    if (gates >= 2) ok.push(`оба пути заселения спрашивают cacheLive (${gates} места)`);
    else fails.push(`cacheLive в путях заселения только в ${gates} мест(ах) — ожидалось минимум 2 (⭐ и 🐙 из менеджера)`);
}

// ---- 2. Логика годности: срок куки, а не mtime ------------------------------
has(lib, 'function cacheLive(', 'в lib/github-session.js нет cacheLive — годность снимка нечем спросить', 'в lib/github-session.js есть cacheLive');
has(lib, 'function userSessionCookie(', 'в lib/github-session.js нет userSessionCookie — нечем найти куку входа', 'в lib/github-session.js есть userSessionCookie');
has(lib, 'cacheLive, userSessionCookie', 'cacheLive/userSessionCookie не экспортированы — потребители их не увидят', 'cacheLive/userSessionCookie экспортированы');
has(lib, 'CACHE_EXPIRY_MARGIN_MS', 'нет запаса на дорогу у истекающей куки', 'у истекающей куки есть запас на дорогу');

// ---- 3. Живое поведение на синтетических снимках ----------------------------
function check(cond, msg) { cond ? ok.push(msg) : fails.push(msg); }

function has(src, needle, msg, okMsg) {
    if (src.includes(needle)) ok.push(okMsg || `есть ${needle}`);
    else fails.push(`${msg} (не нашёл: ${needle})`);
}
function hasNot(src, needle, msg, okMsg) {
    if (!src.includes(needle)) ok.push(okMsg || `нет лишнего: ${needle}`);
    else fails.push(`${msg} (нашёл лишнее: ${needle})`);
}

let gsl = null;
try { gsl = require(LIB); }
catch (e) { fails.push(`lib/github-session.js не поднимается: ${e.message}`); }

if (gsl) {
    const day = 24 * 3600 * 1000;
    const at = d => Math.floor((Date.now() + d) / 1000);
    const snap = (cookies) => ({ seed: 'github', harvestedAt: new Date().toISOString(), cookies });

    const cases = [
        ['живая кука +3 суток, файлу 11 суток', snap([
            { domain: '.github.com', name: 'user_session', value: 'x', expires: at(3 * day) },
        ]), true],
        ['живая host-only кука github.com', snap([
            { domain: 'github.com', name: 'user_session', value: 'x', expires: at(2 * day) },
        ]), true],
        ['истёкшая сутки назад', snap([
            { domain: '.github.com', name: 'user_session', value: 'x', expires: at(-day) },
        ]), false],
        ['истекает через 10 минут - меньше запаса', snap([
            { domain: '.github.com', name: 'user_session', value: 'x', expires: at(10 * 60 * 1000) },
        ]), false],
        ['сессионная кука без срока', snap([
            { domain: 'github.com', name: 'user_session', value: 'x', expires: -1 },
        ]), true],
        ['куки user_session нет вовсе', snap([
            { domain: '.github.com', name: 'dotcom_user', value: 'nick', expires: at(day) },
        ]), false],
        ['пустой снимок', snap([]), false],
        ['снимка нет', null, false],
    ];
    for (const [name, s, want] of cases) {
        const got = gsl.cacheLive(s);
        check(got === want, `cacheLive: ${name} → ${got}${got === want ? '' : ` (ждали ${want})`}`);
    }

    // Замер по живому банку снимков: сколько из них пойдёт в дело. Не приговор — файлы
    // меняются (gh-live-capture переписывает снимок при каждом входе), поэтому только число.
    try {
        const dir = path.join(ROOT, 'github', 'sessions');
        let live = 0, dead = 0;
        for (const f of fs.readdirSync(dir)) {
            if (!/^gh_.*\.json$/.test(f)) continue;
            let s = null;
            try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')); } catch { continue; }
            gsl.cacheLive(s) ? live++ : dead++;
        }
        ok.push(`банк снимков сейчас: годных ${live}, негодных ${dead}`);
    } catch { /* банка может не быть — это не порча инварианта */ }
}

for (const s of ok) console.log(`  ok   ${s}`);
for (const s of fails) console.log(`  FAIL ${s}`);
if (fails.length) {
    console.log(`\n[X] инвариант «снимок решает срок куки, а не возраст файла» порван: ${fails.length} проблем(ы).`);
    process.exit(1);
}
console.log(`\n[OK] ${ok.length}/${ok.length} — живой снимок больше не выбрасывается по возрасту.`);
