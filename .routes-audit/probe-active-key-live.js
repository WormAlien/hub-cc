'use strict';
// Приёмка резолвера ключа БЕЗ похода в боевой шлюз: поднимаем настоящий keepalive на
// запасном порту, а вместо шлюза - эхо-сервер, который возвращает то, что получил.
// Так видно, какой ключ прокси реально подставил в запрос.
//
// Два прогона, и различаться они обязаны:
//   1. файла активации нет, пул есть  → уходит ключ из пула;
//   2. ни файла, ни пула              → ключ не подставляется вовсе (прежнее поведение).
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ECHO_PORT = 20998;
const KP_PORT = 20999;
const POOL = path.join(ROOT, 'routing', 'odyssey-sessions.json');

let lastSeen = null;
const echo = http.createServer((req, res) => {
    lastSeen = { auth: req.headers.authorization || '', apiKey: req.headers['x-api-key'] || '', url: req.url };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function run(label, env) {
    lastSeen = null;
    const child = spawn(process.execPath, [path.join(ROOT, 'routing', 'keepalive-proxy.js')], {
        env: { ...process.env, PORT: String(KP_PORT), UPSTREAM: `http://127.0.0.1:${ECHO_PORT}`, ...env },
        stdio: 'ignore', detached: false,
    });
    // Прокси поднимается не мгновенно: ждём порт.
    let up = false;
    for (let i = 0; i < 30 && !up; i++) {
        await wait(200);
        up = await new Promise(r => {
            const s = http.request({ host: '127.0.0.1', port: KP_PORT, path: '/', method: 'GET' }, () => r(true));
            s.on('error', () => r(false));
            s.end();
        });
    }
    await wait(300);
    await new Promise(r => {
        const body = JSON.stringify({ model: 'openai/gpt-5.6-terra', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
        const req = http.request({ host: '127.0.0.1', port: KP_PORT, path: '/v1/messages', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'anthropic-version': '2023-06-01',
                       authorization: 'Bearer CLIENT-DUMMY-TOKEN', 'x-api-key': 'CLIENT-DUMMY-TOKEN' } }, () => r());
        req.on('error', () => r());
        req.end(body);
    });
    await wait(500);
    try { child.kill(); } catch { }
    const seen = lastSeen || { auth: '(запрос до шлюза не дошёл)' };
    // 🪤 Печатать ключ ЦЕЛИКОМ нельзя: лог пробы - вторая утечка (правило стража
    // `check-no-secrets`: отпечаток находки усекается). Показываем только хвост.
    const mask = (v) => String(v || '').replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+([A-Za-z0-9_-]{4})/, '$1…$2');
    const injected = /^Bearer sk-/.test(seen.auth || '') || /^sk-/.test(seen.apiKey || '');
    console.log(`${label}`);
    console.log(`   ушло наверх: ${mask(seen.auth) || '(пусто)'}`);
    console.log(`   ключ подставлен: ${injected ? 'ДА' : 'НЕТ'}`);
    return { injected, seen };
}

(async () => {
    await new Promise(r => echo.listen(ECHO_PORT, '127.0.0.1', r));
    const none = path.join(os.tmpdir(), 'нет-активации-odyssey.txt');

    const a = await run('1) файла активации нет, пул есть', { KEY_FILE: none, SESSIONS_FILE: POOL });
    const b = await run('2) ни файла, ни пула', { KEY_FILE: none, SESSIONS_FILE: '' });

    echo.close();
    // Заглушка клиента обязана исчезнуть в первом прогоне (её перекрыл ключ из пула)
    // и остаться во втором - иначе «подставил» и «не подставил» неразличимы.
    const ok = a.injected && !/CLIENT-DUMMY/.test(a.seen.auth) && !b.injected;
    console.log(ok
        ? '\n[OK] без активации ключ берётся из пула; без пула - не подставляется (как было)'
        : '\n[FAIL] поведение не то, что заявлено');
    process.exit(ok ? 0 : 1);
})();
