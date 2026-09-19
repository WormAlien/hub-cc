// check-faildump-keep.js — сколько дампов упавших тел держит keepalive и ЧТО именно удаляет.
//
// Регресс на разбор 19.09. В одной строке чистки было три дефекта сразу: глубина жёстко 4,
// чистка шла ДО записи (поэтому файлов держалось 5), и сортировались ИМЕНА - а имя начинается с
// вида дампа (`fail-perm-` / `fail-budget-`), поэтому пачка одного вида выедала дампы другого
// целиком. Цена: тела отказов 11:56 и 12:02 исчезли раньше, чем понадобились для повторной пробы.
//
// Живой стек НЕ трогает: свой keepalive на подставном порту, вместо шлюза заглушка, отвечающая
// постоянной ошибкой, и дампы пишутся в temp через FAILDUMP_DIR.
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const KP = path.join(__dirname, '..', 'routing', 'keepalive-proxy.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-dump-'));

const spawned = [];
const reap = () => { for (const p of spawned) { try { p.kill(); } catch (e) { /* уже мёртв */ } } };
process.on('exit', reap);
process.on('unhandledRejection', (e) => {
  console.error('НЕОБРАБОТАННОЕ ОТКЛОНЕНИЕ: ' + (e && e.message));
  reap();
  process.exit(1);
});

function waitFor(pred, ms, what) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('не дождались: ' + what));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const listDumps = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('fail-')).sort() : []);

// Каталог дампов, забитый под завязку. Возраст растёт с номером: `dummy:0` самый старый,
// `dummy:n-1` самый свежий. Вид чередуется намеренно - именно по нему ломалась прежняя сортировка.
function mkDumpDir(n) {
  const dir = fs.mkdtempSync(path.join(TMP, 'fd-'));
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const kind = i % 2 ? 'budget' : 'perm';
    const f = path.join(dir, `fail-${kind}-2026-09-19T00-00-00-${String(i).padStart(3, '0')}Z.json`);
    fs.writeFileSync(f, '{"dummy":' + i + '}');
    const t = new Date(now - (n - i) * 60000);
    fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(dir, 'reqhdr-dummy.json'), '{"hdr":1}');  // чужой вид - не трогать
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'temp');                // и не-fail файлы тоже
  return dir;
}

// Заглушка шлюза: на КАЖДЫЙ запрос за генерацией отвечает постоянной ошибкой (`bad request`
// лежит в RETRY_NO). Именно на постоянной ошибке keepalive и пишет дамп тела.
function stubGateway() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/v1/models')) { res.writeHead(404); res.end('{}'); return; }
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad request (стенд)' } }));
      });
      req.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function spawnKeepalive(port, upPort, env) {
  const kp = spawn(process.execPath, [KP], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      UPSTREAM: `http://127.0.0.1:${upPort}`,
      KEEPALIVE_LOG_FILE: path.join(TMP, `kp-${port}.log`),
      CONFIG_FILE: path.join(TMP, `cfg-${port}.json`),
      LATENCY_FILE: path.join(TMP, `lat-${port}.json`),
      EVENTS_FILE: path.join(TMP, `ev-${port}.json`),
      KEY_FILE: path.join(TMP, 'no-such-key.txt'),
      AUTOROTATE: '0', HAIKU_REMAP: '0', HEDGE_MS: '0', PRE_COMMIT_MS: '0', IDLE_MS: '5000',
      MAX_ATTEMPTS: '1', RETRY_BUDGET_MS: '0', HOLD_MS: '0', CATALOG_TTL_MS: '0',
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(kp);
  const box = { proc: kp, log: '' };
  kp.stdout.on('data', (c) => { box.log += c; });
  kp.stderr.on('data', (c) => { box.log += c; });
  return box;
}

// Отказ клиенту здесь ожидаем - важен только дамп, который прокси положит на диск.
function ask(port) {
  const body = JSON.stringify({ model: 'claude-opus-5', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

async function scenario(name, prefill, keep, requests) {
  const dir = mkDumpDir(prefill);
  const gw = await stubGateway();
  const port = await freePort();
  const kp = spawnKeepalive(port, gw.port, { FAILDUMP_DIR: dir, FAILDUMP_KEEP: String(keep) });
  await waitFor(() => /listening on http/.test(kp.log), 10000, 'старт keepalive: ' + name);
  for (let i = 0; i < requests; i++) await ask(port);
  const want = Math.min(keep, prefill + requests);
  await waitFor(() => listDumps(dir).length >= want, 10000, 'дампы: ' + name);
  const left = listDumps(dir);
  kp.proc.kill();
  gw.srv.close();
  return { dir, left, prefill, keep, requests };
}

async function main() {
  let failed = 0;
  const check = (cond, msg) => { if (cond) { console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };

  console.log('Сцена 1: каталог забит (45 дампов), глубина 40, два отказа');
  const s1 = await scenario('полный каталог', 45, 40, 2);
  check(s1.left.length === 40, `после двух отказов ровно 40 дампов (сейчас ${s1.left.length})`);
  check(fs.existsSync(path.join(s1.dir, 'reqhdr-dummy.json')), 'reqhdr-* не тронут');
  check(fs.existsSync(path.join(s1.dir, 'notes.txt')), 'не-fail файл не тронут');
  check(!s1.left.some((f) => f.endsWith('-000Z.json')), 'самый старый дамп (dummy:0) вытеснен');
  check(s1.left.some((f) => f.endsWith('-044Z.json')), 'самый свежий из старых (dummy:44) уцелел');
  // 🎯 Это и есть регресс на сортировку по имени: прежняя версия выедала ОДИН вид целиком.
  check(s1.left.some((f) => f.startsWith('fail-budget-')), 'уцелели дампы вида budget');
  check(s1.left.some((f) => f.startsWith('fail-perm-')), 'уцелели дампы вида perm');
  check(s1.left.length - 39 === 1, 'новый дамп действительно записан (+1)');

  console.log('Сцена 2: глубина управляется ручкой (10 дампов, глубина 3)');
  const s2 = await scenario('малая глубина', 10, 3, 2);
  check(s2.left.length === 3, `после двух отказов ровно 3 дампа (сейчас ${s2.left.length})`);

  console.log('Сцена 3: каталог меньше глубины - не удаляем ничего лишнего');
  const s3 = await scenario('ниже глубины', 3, 40, 2);
  check(s3.left.length === 5, `три старых плюс два новых (сейчас ${s3.left.length})`);

  reap();
  if (failed) { console.log(`ПРОВАЛОВ: ${failed}`); process.exit(1); }
  console.log('check-faildump-keep: все проверки OK');
}

main().catch((e) => { console.error('ПАДЕНИЕ: ' + (e && e.message)); reap(); process.exit(1); });
