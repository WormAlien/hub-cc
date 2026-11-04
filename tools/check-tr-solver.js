'use strict';
/**
 * check-tr-solver.js - офлайн-регресс симбиоза threerouter-bulk-apikey.
 *
 * Без сети и без живой капчи: контракты CLI, парсер прокси, сборка строки
 * из Camoufox-cfg, PNG-движок на синтетике, режим verify на пустом/полном пуле.
 * Запуск: node tools/check-tr-solver.js
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'tools', 'tr-solver', 'tr-solver.js');
const upstream = require(path.join(ROOT, 'tools', 'tr-solver', 'upstream-solver.js'));

let pass = 0;
let fail = 0;
function ok(cond, name) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}`); }
}
function run(args, env = {}) {
    return spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', timeout: 60000, windowsHide: true,
        env: { ...process.env, ...env },
    });
}
function lastJson(out) {
    const lines = String(out || '').trim().split(/\r?\n/).filter((l) => l.startsWith('{'));
    return JSON.parse(lines[lines.length - 1] || '{}');
}

console.log('1) CLI-контракт');
{
    const r = run([]);
    const j = lastJson(r.stdout);
    ok(j.ok === false && /no --exit/.test(j.error), 'без --exit -> отказ с подсказкой');
    ok(r.status === 0, 'exit code 0 (отказ решателя - штатный ответ, не краш)');
}
{
    const r = run(['--exit', 'socks5://127.0.0.1:1'], { TR_CAPTCHA_TRIES: '1' });
    const j = lastJson(r.stdout);
    ok(j.ok === false && /ECONNREFUSED|connect/.test(j.error), 'мёртвый exit -> честная транспортная ошибка');
    ok(r.status === 1, 'exit code 1 при отказе решателя');
}

console.log('2) upstream: парсер прокси');
{
    ok(!upstream.parseProxy('socks4://1.2.3.4:1080'), 'socks4 не поддерживается солвером (наш helper тоже отказывает)');
    const p = upstream.parseProxy('http://u:p@1.2.3.4:8080');
    ok(p && p.protocol === 'http' && p.auth === 'u:p', 'http с кредами разбирается');
}

console.log('3) Camoufox-cfg -> строка --exit (логика auto-add.py)');
{
    const src = fs.readFileSync(path.join(ROOT, 'smailpro', 'auto-add.py'), 'utf8');
    // та же регэксп-логика, что в _exit_line_for_solver, в JS для проверки
    const m = (line) => {
        const mm = String(line || '').match(/^(\w+):\/\/(?:([^:@/]+):([^@/]*)@)?([^:/]+):(\d+)\/?$/);
        if (!mm || mm[1].toLowerCase() === 'socks4') return null;
        const auth = mm[2] ? `${mm[2]}:${mm[3]}@` : '';
        return `${mm[1]}://${auth}${mm[4]}:${mm[5]}`;
    };
    ok(m('socks5://u:p@1.2.3.4:1080') === 'socks5://u:p@1.2.3.4:1080', 'socks5 с кредами сохраняется');
    ok(m('http://5.6.7.8:8080') === 'http://5.6.7.8:8080', 'http без кредов');
    ok(m('socks4://9.9.9.9:1080') === null, 'socks4 -> None (в auto не годится)');
}

console.log('4) solveSlider: синтетический PNG-челлендж');
{
    // собираем bg и piece: фон - шум с «выемкой» = piece content * k (как обещает
    // комментарий солвера), piece - та же полоса. Корреляция обязана найти offset.
    const W = 320, H = 120, PW = 60, PH = 40, PY = 30, OFF = 170;
    const mkPng = (w, h, rgba) => {
        const zlib = require('zlib');
        const raw = Buffer.alloc(h * (w * 4 + 1));
        for (let y = 0; y < h; y++) {
            raw[y * (w * 4 + 1)] = 0;
            rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
        }
        const chunk = (type, data) => {
            const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
            const t = Buffer.from(type, 'ascii');
            const crcBuf = Buffer.concat([t, data]);
            const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf) >>> 0);
            return Buffer.concat([len, t, data, crc]);
        };
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
        ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
        ]);
    };
    const crcTable = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c;
        }
        return t;
    })();
    const crc32 = (buf) => {
        let c = -1;
        for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
        return c ^ -1;
    };
    const bg = Buffer.alloc(W * H * 4);
    const piece = Buffer.alloc(PW * PH * 4);
    // шум-фон
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < W * H * 4; i += 4) {
        bg[i] = bg[i + 1] = bg[i + 2] = Math.floor(rnd() * 255);
        bg[i + 3] = 255;
    }
    // piece: случайный паттерн, alpha=255 в маске
    for (let i = 0; i < PW * PH * 4; i += 4) {
        piece[i] = piece[i + 1] = piece[i + 2] = Math.floor(rnd() * 255);
        piece[i + 3] = 255;
    }
    // выемка: bg[y..y+ph, off..off+pw] = piece * 0.6 + небольшой шум
    for (let y = 0; y < PH; y++) {
        for (let x = 0; x < PW; x++) {
            const o = ((PY + y) * W + (OFF + x)) * 4;
            const p = (y * PW + x) * 4;
            bg[o] = Math.max(0, piece[p] * 0.6 - 8 + Math.floor(rnd() * 4));
            bg[o + 1] = Math.max(0, piece[p + 1] * 0.6 - 8);
            bg[o + 2] = Math.max(0, piece[p + 2] * 0.6 - 8);
        }
    }
    const ans = upstream.solveSlider({
        bg_image: mkPng(W, H, bg).toString('base64'),
        piece_image: mkPng(PW, PH, piece).toString('base64'),
        piece_y: PY,
    });
    ok(ans && Math.abs(ans.drop_x - OFF) <= 2, `solveSlider нашёл offset ${ans && ans.drop_x} (ожидался ${OFF})`);
    ok(ans && Array.isArray(ans.trajectory) && ans.trajectory.length > 10 && ans.trajectory[ans.trajectory.length - 1].x === ans.drop_x,
        'humanTrack: траектория кончается в drop_x');
}

console.log('5) verify: пустой/весь-dead пул - честный ответ');
{
    const tmp = path.join(os.tmpdir(), `tr-solver-empty-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify([{ api_key: 'sk-a', status: 'dead' }]));
    const r = run(['--verify', tmp]);
    const j = lastJson(r.stdout);
    ok(j.ok === true && j.total === 0, 'весь-dead пул -> ok:true, total:0');
    fs.unlinkSync(tmp);
}

console.log('6) авто-дисциплина auto-add.py: solver вызывается только с exit');
{
    const src = fs.readFileSync(path.join(ROOT, 'smailpro', 'auto-add.py'), 'utf8');
    ok(/CAPTCHA_MODE = os\.environ\.get\("TR_CAPTCHA_MODE", "auto"\)/.test(src), 'env TR_CAPTCHA_MODE, дефолт auto');
    ok(/tr_proxy_label\s*=\s*tr_proxy_full/.test(src), 'строка exit берётся из tr_browser_ctx');
    ok(/captcha_meta\s*=\s*\{"mode": "auto"/.test(src), 'метка auto пишется в пул');
    ok(/"captcha": captcha_meta/.test(src), 'pool_append получает captcha:{...}');
    ok(/captcha-manual/.test(src) && /фолбэк: ручной режим/.test(src), 'manual остаётся фолбэком');
}

console.log(`\nитого: ${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
