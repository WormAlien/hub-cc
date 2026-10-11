/**
 * Самопроверка пула прокси и моста (src/utils/proxy-bridge.js, src/utils/account-proxy.js).
 *
 * Запуск: node tests/test-proxy-pool.mjs        (или npm run test:proxy)
 * Запущенный сервер и настоящий прокси НЕ нужны: socks5-прокси поднимается здесь же
 * поддельным, который умеет приветствие, вариант с логином/паролем и CONNECT.
 *
 * Что НЕ проверяется тут: приём наших байт живым чужим socks5-сервером и связка
 * «undici ProxyAgent + глобальный fetch» — она проверена на живом Google Cloud Code
 * (мост отдал 404 на GET /, то есть запрос доехал). Если прокси-провайдер сменит
 * реализацию, это всплывёт на первом же реальном запросе, а не тут.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProxy, bridgeFor, dial } from '../src/utils/proxy-bridge.js';

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tmp');
const POOL_FILE = path.join(TMP, 'test-proxies.json');

// ── 1. разбор строки прокси ─────────────────────────────────────────────────

const p1 = parseProxy('1.2.3.4:1080');
assert.equal(p1.scheme, 'http', 'схема по умолчанию — http');
assert.equal(p1.host, '1.2.3.4');
assert.equal(p1.port, 1080);

const p2 = parseProxy('socks5://user:pa%40ss@1.2.3.4:1080');
assert.equal(p2.scheme, 'socks5');
assert.equal(p2.user, 'user');
assert.equal(p2.pass, 'pa@ss', 'логин/пароль декодируются из percent-encoding');

assert.throws(() => parseProxy('abc'), /нет хоста или порта/, 'без порта — отказ, а не молчаливый проход');
assert.throws(() => parseProxy(''), /пустая строка/);
assert.throws(() => parseProxy('ftp://1.2.3.4:21'), /не поддерживается/);
console.log('ok  разбор строк');

// ── 2. поддельный socks5-прокси ─────────────────────────────────────────────

/**
 * @param {{user?: string, pass?: string}} [auth] - требовать логин/пароль
 * @returns {Promise<{port: number, close: Function}>}
 */
function fakeSocks5(auth = null) {
    const state = { lastHost: null };
    const server = net.createServer((sock) => {
        let stage = 'greeting';
        let buf = Buffer.alloc(0);
        let up = null;
        const pending = [];   // байты, пришедшие до установки трубы

        sock.on('data', (chunk) => {
            if (stage === 'piped') {
                // Труба ещё не поднята — придерживаем, иначе первые байты
                // (например запрос клиента) молча пропадут и тест повиснет.
                up ? up.write(chunk) : pending.push(chunk);
                return;
            }
            buf = Buffer.concat([buf, chunk]);
            if (stage === 'greeting') {
                const nmethods = buf[1];
                if (buf.length < 2 + nmethods) return;
                const methods = [...buf.subarray(2, 2 + nmethods)];
                const want = auth ? 0x02 : 0x00;
                if (!methods.includes(want)) { sock.destroy(); return; }
                sock.write(Buffer.from([0x05, want]));
                buf = Buffer.alloc(0);
                stage = auth ? 'auth' : 'request';
            } else if (stage === 'auth') {
                const ulen = buf[1];
                if (buf.length < 2 + ulen) return;
                const plen = buf[2 + ulen];
                if (buf.length < 3 + ulen + plen) return;
                sock.write(Buffer.from([0x01, 0x00]));
                buf = Buffer.alloc(0);
                stage = 'request';
            } else if (stage === 'request') {
                const atyp = buf[3];
                // 4 (ver/cmd/rsv/atyp) + 1 (длина имени) + имя + 2 (порт)
                const wantLen = atyp === 0x03 ? 7 + buf[4] : 4 + 4 + 2;
                if (buf.length < wantLen) return;
                const host = atyp === 0x03
                    ? buf.subarray(5, 5 + buf[4]).toString()
                    : '127.0.0.1';
                const port = atyp === 0x03
                    ? buf.readUInt16BE(5 + buf[4])
                    : buf.readUInt16BE(8);
                // Успех + адрес-заглушка, дальше просто труба в пункт назначения.
                sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                state.lastHost = host;
                // family: 4 — иначе 'localhost' уедет в IPv6, где эхо-сервера нет;
                // разрешать имя должен прокси, а не мы, поэтому адрес берём с него.
                up = net.connect({ port, host, family: 4 }, () => {
                    for (const p of pending) up.write(p);
                    pending.length = 0;
                    up.pipe(sock);
                });
                up.on('error', () => sock.destroy());
                stage = 'piped';
            }
        });
        sock.on('error', () => {});
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ port: server.address().port, state, close: () => server.close() });
        });
    });
}

/** Пункт назначения: отдаёт то, что в него написали. */
function echoServer() {
    const server = net.createServer((sock) => sock.on('data', (d) => sock.write(d)));
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ port: server.address().port, close: () => server.close() });
        });
    });
}

/** Написать в туннель, прочитать ответ, закрыть. */
function roundTrip(sock) {
    return new Promise((resolve, reject) => {
        sock.once('data', (d) => { sock.destroy(); resolve(d.toString()); });
        sock.once('error', reject);
        // Без этого оборванный туннель выглядит как вечное ожидание: тест висит
        // вместо того, чтобы сказать, что соединение умерло.
        sock.once('close', () => reject(new Error('туннель закрылся, не ответив')));
        sock.write('ping');
    });
}

const echo = await echoServer();

// без авторизации
const anon = await fakeSocks5();
const viaAnon = await dial(parseProxy(`socks5://127.0.0.1:${anon.port}`), '127.0.0.1', echo.port);
assert.equal(await roundTrip(viaAnon), 'ping', 'socks5 без авторизации');
console.log('ok  socks5 без авторизации');

// с логином/паролем
const withAuth = await fakeSocks5({ user: 'u', pass: 'p' });
const viaAuth = await dial(parseProxy(`socks5://u:p@127.0.0.1:${withAuth.port}`), '127.0.0.1', echo.port);
assert.equal(await roundTrip(viaAuth), 'ping', 'socks5 с логином/паролем');
console.log('ok  socks5 с логином/паролем');

// имена хостов уезжают прокси как есть (ATYP=3), локального DNS нет
const viaHost = await dial(parseProxy(`socks5://127.0.0.1:${anon.port}`), 'localhost', echo.port);
assert.equal(await roundTrip(viaHost), 'ping', 'соединение по имени хоста');
assert.equal(anon.state.lastHost, 'localhost', 'прокси должен получить ИМЯ хоста, а не готовый IP');
console.log('ok  socks5 по имени хоста (DNS на стороне прокси)');

// ── 3. локальный мост: тот же путь, что у Chrome и у undici ─────────────────

const bridge = await bridgeFor(`socks5://127.0.0.1:${anon.port}`);
assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'мост слушает только localhost');
const viaBridge = await new Promise((resolve, reject) => {
    const sock = net.connect(bridge.port, '127.0.0.1', () => {
        sock.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
    });
    let head = '';
    const onData = (d) => {
        head += d.toString('latin1');
        if (!head.includes('\r\n\r\n')) return;
        sock.removeListener('data', onData);
        assert.match(head, /^HTTP\/1\.1 200/, 'мост должен ответить 200 на CONNECT');
        resolve(sock);
    };
    sock.on('data', onData);
    sock.on('error', reject);
});
assert.equal(await roundTrip(viaBridge), 'ping', 'через мост');
console.log('ok  мост CONNECT → socks5');

// мост на тот же прокси переиспользуется, а не поднимается второй
assert.equal((await bridgeFor(`socks5://127.0.0.1:${anon.port}`)).port, bridge.port, 'мост кэшируется');
console.log('ok  мост кэшируется по адресу прокси');

// ── 4. растекание аккаунтов по пулу ─────────────────────────────────────────

fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(POOL_FILE, JSON.stringify({
    enabled: true,
    list: ['socks5://10.0.0.1:1080', 'socks5://10.0.0.2:1080'],
}), 'utf8');
process.env.ANTIGRAVITY_PROXY_POOL = POOL_FILE;
// Импорт после подмены пути: путь к файлу пула читается на импорте.
const { pickProxyFor, addProxy, removeProxy, assignmentReport } = await import('../src/utils/account-proxy.js');

assert.equal(pickProxyFor([]), 'socks5://10.0.0.1:1080', 'первый аккаунт — первый прокси');
assert.equal(
    pickProxyFor([{ email: 'a', proxy: 'socks5://10.0.0.1:1080' }]),
    'socks5://10.0.0.2:1080',
    'второй аккаунт уходит на свободный прокси, а не садится на занятый'
);
assert.equal(
    pickProxyFor([
        { email: 'a', proxy: 'socks5://10.0.0.1:1080' },
        { email: 'b', proxy: 'socks5://10.0.0.2:1080' },
    ]),
    'socks5://10.0.0.1:1080',
    'когда прокси кончились — на тот, где меньше аккаунтов'
);
const report = assignmentReport([
    { email: 'a', proxy: 'socks5://10.0.0.1:1080' },
    { email: 'b' },
]);
assert.deepEqual(report.withoutProxy, ['b'], 'аккаунт без прокси виден в отчёте');
assert.deepEqual(report.unused, ['socks5://10.0.0.2:1080']);
assert.equal(addProxy('мусор').added, false, 'битую строку в пул не пускаем');
assert.equal(addProxy('socks5://10.0.0.1:1080').added, false, 'дубликат не добавляется');
assert.match(
    addProxy('10.0.0.1:1080').error,
    /уже в пуле как/,
    'тот же адрес с другой схемой — это описка, а не второй прокси'
);
assert.equal(removeProxy('10.0.0.2:1080').removed, true, 'удаление находит прокси и без схемы');
console.log('ok  растекание и отчёт');

fs.rmSync(TMP, { recursive: true, force: true });
echo.close(); anon.close(); withAuth.close();
console.log('\nвсе проверки прошли');
process.exit(0);
