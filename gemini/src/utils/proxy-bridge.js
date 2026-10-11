/**
 * Proxy Bridge
 *
 * Зачем. Нам нужен ОДИН выходной IP на аккаунт — и для запросов к Cloud Code, и
 * для окна входа в Google. Сам node (undici 7.20, на котором стоит глобальный
 * fetch) socks НЕ умеет вовсе: `new ProxyAgent('socks5://…')` падает с
 * «Invalid URL protocol» — проверено на живом пакете, не по докам. Chrome socks5
 * умеет, но не умеет логин/пароль, а формат мостов у двух потребителей тогда
 * разъехался бы.
 *
 * Поэтому каждый прокси поднимается локальным CONNECT-мостом на 127.0.0.1, а оба
 * потребителя получают один и тот же адрес `http://127.0.0.1:<порт>`:
 *   • запросы — undici ProxyAgent (только http-прокси, гарантированно поддержан);
 *   • браузер  — Chrome `--proxy-server=http://127.0.0.1:<порт>`.
 * Схема апстрима (http/https/socks4/socks5, с логином или без) разбирается здесь
 * и наружу не протекает.
 *
 * Только stdlib: новых зависимостей нет намеренно.
 *
 * ponytail: апстрим-соединение на каждый CONNECT, без keep-alive к прокси. Апстрим
 * получает по одному сокету на запрос; поднять пул — если профиль покажет, что
 * рукопожатие с прокси стало заметной долей задержки.
 */

import net from 'net';
import http from 'http';
import tls from 'tls';
import { logger } from './logger.js';

const DIAL_TIMEOUT_MS = 20000;
const BRIDGES = new Map();   // нормализованный адрес прокси → promise моста

/**
 * Разобрать прокси из того, что человек вставил руками.
 * Принимает: `1.2.3.4:1080`, `socks5://1.2.3.4:1080`, `http://user:pass@1.2.3.4:8080`,
 * `socks4://…`. Схема без указания — http.
 *
 * @param {string} raw
 * @returns {{raw: string, scheme: string, host: string, port: number, user: string, pass: string}}
 * @throws {Error} если строку не разобрать — молча пропустить прокси хуже, чем упасть
 */
export function parseProxy(raw) {
    const original = String(raw || '').trim();
    if (!original) throw new Error('пустая строка прокси');

    const withScheme = /^[a-z0-9+.-]+:\/\//i.test(original) ? original : `http://${original}`;
    let u;
    try {
        u = new URL(withScheme);
    } catch {
        throw new Error(`не разобрать прокси «${original}» (ждал ip:port или scheme://[user:pass@]ip:port)`);
    }

    const scheme = u.protocol.replace(':', '').toLowerCase();
    if (!['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(scheme)) {
        throw new Error(`схема «${scheme}» не поддерживается (http, https, socks4, socks5)`);
    }
    const port = Number(u.port);
    if (!u.hostname || !port) throw new Error(`в прокси «${original}» нет хоста или порта`);

    return {
        raw: original,
        scheme,
        host: u.hostname,
        port,
        user: decodeURIComponent(u.username || ''),
        pass: decodeURIComponent(u.password || ''),
    };
}

/** Единый вид адреса — чтобы один и тот же прокси не поднимал два моста. */
function normalize(raw) {
    const p = parseProxy(raw);
    const auth = p.user ? `${p.user}:${p.pass}@` : '';
    return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

// ── читатель ответов прокси ─────────────────────────────────────────────────
//
// Один буфер на сокет, а не по буферу на каждое чтение: ответ socks-прокси
// приходит одним пакетом, и чтение «сначала 4 байта, потом остаток» теряло
// хвост — рукопожатие висло до таймаута. Здесь прочитанное никогда не теряется,
// а неиспользованный остаток возвращается в сокет при stop().

function reader(sock) {
    let buf = Buffer.alloc(0);
    let waiter = null;

    const wake = (err) => {
        if (!waiter) return;
        const w = waiter;
        waiter = null;
        err ? w.reject(err) : w.resolve();
    };
    const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (waiter && buf.length >= waiter.n) wake();
    };
    const onFail = (err) => wake(err instanceof Error ? err : new Error('прокси оборвал соединение'));

    sock.on('data', onData);
    sock.on('error', onFail);
    sock.on('close', () => onFail(new Error('прокси оборвал соединение')));
    sock.on('timeout', () => { sock.destroy(); onFail(new Error('таймаут ответа прокси')); });

    return {
        /** Прочитать ровно n байт. */
        async read(n) {
            if (buf.length < n) {
                await new Promise((resolve, reject) => { waiter = { n, resolve, reject }; });
            }
            const out = buf.subarray(0, n);
            buf = buf.subarray(n);
            return out;
        },
        /** Прочитать до разделителя включительно. @returns {string} прочитанное как latin1 */
        async readUntil(seq) {
            const needle = Buffer.from(seq, 'latin1');
            while (buf.indexOf(needle) === -1) {
                if (buf.length > 65536) throw new Error('слишком длинный ответ прокси');
                await new Promise((resolve, reject) => { waiter = { n: buf.length + 1, resolve, reject }; });
            }
            const end = buf.indexOf(needle) + needle.length;
            const out = buf.subarray(0, end);
            buf = buf.subarray(end);
            return out.toString('latin1');
        },
        /** Отдать неиспользованный остаток обратно в сокет и снять слушателей. */
        stop() {
            sock.removeListener('data', onData);
            sock.removeListener('error', onFail);
            sock.removeAllListeners('timeout');
            if (buf.length) sock.unshift(buf);
            buf = Buffer.alloc(0);
        },
    };
}

// ── апстримы ────────────────────────────────────────────────────────────────

/**
 * TCP-соединение с самим прокси (для https-прокси — сразу TLS).
 * Таймаут ставится на время рукопожатия и снимается в dial() после успеха:
 * оставить его дальше нельзя — SSE-пауза thinking-модели длиннее 20 с, и сокет
 * был бы убит посреди живого ответа.
 */
function connectToProxy(proxy) {
    return new Promise((resolve, reject) => {
        let sock;
        // tls.connect зовёт колбэк по secureConnect, net.connect — по connect;
        // отдельный слушатель 'connect' резолвил бы TLS-прокси по голому TCP.
        const onConnect = () => resolve(sock);
        sock = proxy.scheme === 'https'
            ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host, rejectUnauthorized: true }, onConnect)
            : net.connect({ host: proxy.host, port: proxy.port }, onConnect);
        sock.setTimeout(DIAL_TIMEOUT_MS, () => sock.destroy(new Error('таймаут соединения с прокси')));
        sock.once('error', (e) => reject(new Error(`прокси ${proxy.host}:${proxy.port} недоступен: ${e.message}`)));
    });
}

/** HTTP-прокси: CONNECT host:port + Basic-авторизация, если задана. */
async function dialHttp(proxy, host, port) {
    const sock = await connectToProxy(proxy);
    const r = reader(sock);
    const auth = proxy.user
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64')}\r\n`
        : '';
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    const head = await r.readUntil('\r\n\r\n');
    const status = Number((head.split('\r\n')[0].match(/\s(\d{3})\s?/) || [])[1]);
    if (status !== 200) {
        r.stop();
        sock.destroy();
        throw new Error(`прокси ${proxy.host}:${proxy.port} отказал в CONNECT: HTTP ${status || '???'}`);
    }
    // stop() возвращает в сокет всё, что прокси успел прислать следом за заголовком.
    r.stop();
    return sock;
}

/** SOCKS5: приветствие → (при необходимости) логин/пароль → CONNECT по имени хоста. */
async function dialSocks5(proxy, host, port) {
    const sock = await connectToProxy(proxy);
    const r = reader(sock);
    const wantAuth = Boolean(proxy.user);
    sock.write(Buffer.from([0x05, wantAuth ? 2 : 1, 0x00, ...(wantAuth ? [0x02] : [])]));
    const greeting = await r.read(2);
    if (greeting[1] === 0xff) { r.stop(); sock.destroy(); throw new Error(`SOCKS5 ${proxy.host}:${proxy.port}: не принял ни один способ авторизации`); }

    if (greeting[1] === 0x02) {
        const u = Buffer.from(proxy.user, 'utf8');
        const p = Buffer.from(proxy.pass, 'utf8');
        sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        const auth = await r.read(2);
        if (auth[1] !== 0x00) { r.stop(); sock.destroy(); throw new Error(`SOCKS5 ${proxy.host}:${proxy.port}: логин/пароль не приняты`); }
    }

    // ATYP=0x03 — имя хоста уходит прокси как есть, локального DNS-резолва нет.
    const h = Buffer.from(host, 'utf8');
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));

    const head = await r.read(4);
    if (head[1] !== 0x00) { r.stop(); sock.destroy(); throw new Error(`SOCKS5 ${proxy.host}:${proxy.port}: отказ (код ${head[1]})`); }
    const addrLen = head[3] === 0x01 ? 4 : head[3] === 0x04 ? 16 : (await r.read(1))[0];
    await r.read(addrLen + 2);   // остаток адреса + порт
    r.stop();
    return sock;
}

/** SOCKS4a: имя хоста передаётся в конце, локального DNS-резолва тоже нет. */
async function dialSocks4(proxy, host, port) {
    const sock = await connectToProxy(proxy);
    const r = reader(sock);
    const user = Buffer.from(proxy.user || '', 'utf8');
    sock.write(Buffer.concat([
        Buffer.from([0x04, 0x01, port >> 8, port & 0xff, 0, 0, 0, 1]),
        user, Buffer.from([0x00]),
        Buffer.from(host, 'utf8'), Buffer.from([0x00]),
    ]));
    const rep = await r.read(8);
    if (rep[1] !== 0x5a) { r.stop(); sock.destroy(); throw new Error(`SOCKS4 ${proxy.host}:${proxy.port}: отказ (код ${rep[1]})`); }
    r.stop();
    return sock;
}

/**
 * Открыть туннель до host:port через прокси. Схему выбирает сам.
 *
 * @param {ReturnType<typeof parseProxy>} proxy
 * @param {string} host
 * @param {number} port
 * @returns {Promise<net.Socket>}
 */
export async function dial(proxy, host, port) {
    let sock;
    switch (proxy.scheme) {
        case 'socks5':
        case 'socks5h':
        case 'socks': sock = await dialSocks5(proxy, host, port); break;
        case 'socks4':
        case 'socks4a': sock = await dialSocks4(proxy, host, port); break;
        default: sock = await dialHttp(proxy, host, port);
    }
    // Рукопожатие кончилось — снимаем таймаут, дальше туннель живёт сам.
    sock.setTimeout(0);
    return sock;
}

// ── локальный мост ──────────────────────────────────────────────────────────

/**
 * Поднять (или взять уже поднятый) локальный CONNECT-мост до прокси.
 *
 * @param {string} raw - прокси в любом поддерживаемом виде
 * @returns {Promise<{port: number, url: string, close: Function}>}
 */
export function bridgeFor(raw) {
    const key = normalize(raw);
    let entry = BRIDGES.get(key);
    if (entry) return entry;

    entry = (async () => {
        const proxy = parseProxy(key);
        const server = http.createServer((req, res) => {
            // undici и Chrome ходят на https через CONNECT; обычные http-запросы сюда
            // не приходят и обрабатывать их незачем.
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('only CONNECT');
        });

        server.on('connect', async (req, clientSocket, head) => {
            const idx = req.url.lastIndexOf(':');
            const host = req.url.slice(0, idx);
            const port = Number(req.url.slice(idx + 1));
            try {
                const upstream = await dial(proxy, host, port);
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head?.length) upstream.write(head);
                upstream.on('error', () => clientSocket.destroy());
                clientSocket.on('error', () => upstream.destroy());
                upstream.pipe(clientSocket);
                clientSocket.pipe(upstream);
            } catch (err) {
                logger.warn(`[Bridge] ${key} → ${req.url}: ${err.message}`);
                clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            }
        });

        // Слушаем только localhost: наружу этот порт торчать не должен ни при каких условиях.
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        const port = server.address().port;
        logger.info(`[Bridge] ${key} → http://127.0.0.1:${port}`);
        return { port, url: `http://127.0.0.1:${port}` };
    })();

    // Неудачу не кэшируем: следующий запрос имеет право попробовать снова.
    entry.catch(() => BRIDGES.delete(key));
    BRIDGES.set(key, entry);
    return entry;
}

// Мосты живут до конца процесса и не закрываются: проверено, что server.close()
// при живых сокетах с последующим process.exit() роняет процесс ассерцией libuv
// «!(handle->flags & UV_HANDLE_CLOSING)» на Windows. Смерть процесса закрывает их
// сама; смена прокси у аккаунта оставит старый мост висеть на localhost — это один
// лишний локальный порт, наружу он не торчит (listen только на 127.0.0.1).
