// check-pool-fallback.js — автофолбэк при `402 Budget pool quota has been exhausted`.
//
// Регресс на отказ 15.09 04:52 МСК: шлюз agentrouter отдаёт Claude/GPT-модели только пока
// налит пул наливки, и когда он кончается, КАЖДЫЙ запрос сессии получает
// `API Error: 402 Budget pool quota has been exhausted…` — сессия владельца встала на этом
// живьём. Лечение: keepalive метит модель мёртвой, переключает тир на фолбэк
// (`deepseek-v4-flash`) и ПОВТОРЯЕТ запрос так, чтобы клиент увидел только успех; карту на
// диске правит дашборд (`POST /__switch/api/routes/pool-drop`), а память процесса — страховка
// на случай лежащего дашборда.
//
// Живой стек НЕ трогает: поднимает свои keepalive на подставных портах (28341+), вместо шлюза
// и дашборда — заглушки, тир-карту берёт из temp через MODELMAP_FILE (боевой
// `routing/ar-modelmap.json` не читается и не пишется). Ни одного платного запроса.
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const KP = path.join(__dirname, '..', 'routing', 'keepalive-proxy.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-pooldrop-'));

const DEAD = 'claude-opus-5';
const FALLBACK = 'deepseek-v4-flash';

const SSE_BODY = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5"}}\n\n'
  + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ПУЛ-ОК"}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

// Канонический текст пустого пула (тот самый, что убил сессию 15.09).
const POOL_402 = JSON.stringify({
  error: { message: 'Budget pool quota has been exhausted. Please ask an administrator to increase the limit or select another budget pool.' },
});
// Чужой 402: кончились деньги аккаунта, а не пул. Пуловым фолбэком считаться не должен —
// иначе фолбэк подменял бы модель там, где это не лечит.
const BALANCE_402 = JSON.stringify({ error: { message: 'Insufficient account balance' } });

// 🪤 Убирать детей ТОЛЬКО в finally недостаточно: необработанное отклонение промиса убивает
// процесс мгновенно, finally не выполняется, и подставные keepalive остаются слушать порты
// (поймано на себе в check-hold-window: «провал» регресса оказался залётным процессом).
const spawned = [];
const boxes = [];                        // лог каждого подставного keepalive — для разбора провала
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Заглушка шлюза. mode:
//   'pool-then-ok'  — первый запрос за генерацией отдаёт канонический 402, дальше нормальный SSE;
//   'pool-always'   — 402 канонический всегда (сцена «фолбэк сам получил 402»);
//   'balance'       — 402 с чужим телом (кончились деньги аккаунта);
//   'see-through'   — 200 SSE всегда: нужен, чтобы проверить, какой моделью спросили.
// quiet — сколько молчать перед ответом (сцена «402 приходит после пре-коммита»).
// GET /v1/models в счётчик hits НЕ идёт: это служебный запрос прокси, а сцены считают
// именно обращения за генерацией. Каталог намеренно содержит и мёртвую модель, и фолбэк —
// каталог шлюза врёт про пул (15.09: все 6 моделей в списке, а claude-opus-5 отвечает 402),
// поэтому решение о фолбэке на него вешаться не должно.
function stubGateway(port, mode, quiet) {
  const state = { hits: 0, models: 0, seen: [] };
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      state.models += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: DEAD }, { id: FALLBACK }, { id: 'claude-opus-5-thinking' }] }));
    }
    state.hits += 1;
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      let asked = '';
      try { asked = JSON.parse(Buffer.concat(body).toString('utf8') || '{}').model || ''; } catch { /* не json */ }
      state.seen.push(asked);
      const send = (status, text) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      };
      const answer = () => {
        if (mode === 'pool-then-ok' && state.hits === 1) return send(402, POOL_402);
        if (mode === 'pool-always') return send(402, POOL_402);
        if (mode === 'balance') return send(402, BALANCE_402);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        res.end(SSE_BODY);
      };
      if (quiet) setTimeout(answer, quiet); else answer();
    });
  });
  return { srv, state, listen: () => new Promise((r) => srv.listen(port, '127.0.0.1', r)) };
}

// Заглушка дашборда: единственное, что нам от неё нужно, — увидеть ровно один
// `POST /__switch/api/routes/pool-drop` с телом `{provider, model, fallback}`.
function stubDashboard(port) {
  const state = { drops: [], paths: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const p = req.url.split('?')[0];
      state.paths.push(`${req.method} ${p}`);
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* не json */ }
      if (req.method === 'POST' && p === '/__switch/api/routes/pool-drop') state.drops.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    req.on('error', () => {});
  });
  return { srv, state, listen: () => new Promise((r) => srv.listen(port, '127.0.0.1', r)) };
}

// Экземпляр keepalive на подставном порту. Все файлы — в temp: рабочие
// keepalive-<порт>.log / -config / -latency не трогаем.
// 🪤 MODELMAP_FILE обязателен: без него экземпляр прочитал бы боевой `ar-modelmap.json`
// владельца, а тест не имеет права ни читать, ни тем более писать боевое состояние.
function spawnKeepalive(port, upPort, dashPort, env) {
  const map = path.join(TMP, `pd-modelmap-${port}.json`);
  fs.writeFileSync(map, JSON.stringify({ opus: DEAD, sonnet: DEAD, haiku: DEAD, gpt: FALLBACK, default: '' }), 'utf8');
  const logFile = path.join(TMP, `kp-${port}.log`);
  const kp = spawn(process.execPath, [KP], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      UPSTREAM: `http://127.0.0.1:${upPort}`,
      DASHBOARD_URL: `http://127.0.0.1:${dashPort}`,
      KEEPALIVE_LOG_FILE: logFile,
      CONFIG_FILE: path.join(TMP, `cfg-${port}.json`),
      LATENCY_FILE: path.join(TMP, `lat-${port}.json`),
      EVENTS_FILE: path.join(TMP, `ev-${port}.json`),
      KEY_FILE: path.join(TMP, 'no-such-key.txt'),
      MODELMAP_FILE: map,
      AUTOROTATE: '0',
      // 🪤 Без явного провайдера askPoolDrop не позвонит в дашборд вовсе: он опознаёт
      // провайдера по ХОСТУ апстрима, а у подставной заглушки хост 127.0.0.1 — не в
      // таблице. Тогда сцена 2 увидела бы ноль pool-drop не из-за фичи, а из-за теста.
      ROTATE_PROVIDER: 'ar',
      HAIKU_REMAP: '1',
      HEDGE_MS: '0',
      PRE_COMMIT_MS: '0',
      IDLE_MS: '300',
      MAX_ATTEMPTS: '3',
      HOLD_MS: '30000',
    }, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(kp);
  const box = { proc: kp, log: '' };
  kp.stdout.on('data', (c) => { box.log += c; });
  kp.stderr.on('data', (c) => { box.log += c; });
  boxes.push(box);
  return box;
}

function ask(port, model) {
  const body = JSON.stringify({ model: model || DEAD, stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out, ms: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Ручка фолбэка: пустая строка выключает фичу целиком.
function patchConfig(port, patch) {
  const body = JSON.stringify(patch);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/__config',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* не json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const POOLDROPPED = /пул[^\n]*deepseek-v4-flash|deepseek-v4-flash[^\n]*пул/i;

(async () => {
  const open = [];
  let checks = 0;
  try {
    // ── Сцены 1-3: главная, дашборд и память процесса — один экземпляр ───────────
    // Один экземпляр намеренно: сцена 3 проверяет именно ПАМЯТЬ того же процесса, а не
    // повторную реакцию на 402 (после первого запроса мёртвая модель не должна быть
    // спрошена вообще, то есть второго 402 не будет вовсе).
    {
      const [P, U, D] = [28342, 28341, 28343];
      const gw = stubGateway(U, 'pool-then-ok');
      const dash = stubDashboard(D);
      await gw.listen();
      await dash.listen();
      const kp = spawnKeepalive(P, U, D, {});
      open.push(gw.srv, dash.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 10000, 'старт keepalive (сцена 1)');

      // ── Сцена 1: 402 на первый запрос → клиент видит ОДИН чистый ответ ─────────
      const r = await ask(P);
      assert.strictEqual(r.status, 200, `клиент получил успех, а не 402 (было ${r.status}: ${r.body.slice(0, 120)})`);
      assert.ok(r.body.includes('ПУЛ-ОК'), 'настоящий ответ шлюза доехал до клиента целиком');
      assert.ok(!/event: error/.test(r.body), 'в потоке нет in-band ошибки — сессия бы выжила');
      assert.ok(!/quota has been exhausted/.test(r.body), 'текст 402 клиенту не просочился');
      assert.strictEqual(gw.state.hits, 2, `шлюз спрошен ровно дважды: 402 + повтор (было ${gw.state.hits})`);
      assert.deepStrictEqual(gw.state.seen, [DEAD, FALLBACK],
        `во втором запросе модель фолбэка (видел ${JSON.stringify(gw.state.seen)})`);
      assert.ok(POOLDROPPED.test(kp.log), 'переключение на фолбэк записано в лог с обеими моделями');
      checks += 7;

      // ── Сцена 2: дашборд получил ровно один pool-drop с контрактным телом ──────
      // 🪤 askPoolDrop — best-effort и не блокирует повтор, поэтому POST может быть ещё
      // в полёте, когда клиент уже получил ответ: сначала ждём его прихода, и только
      // потом проверяем, что он РОВНО один (даём лишние 400мс на «второй не придёт»).
      await waitFor(() => dash.state.drops.length >= 1, 5000, 'дашборд получил pool-drop (сцена 2)');
      await sleep(400);
      assert.strictEqual(dash.state.drops.length, 1,
        `ровно один POST pool-drop (было ${dash.state.drops.length}, пути: ${JSON.stringify(dash.state.paths)})`);
      const d = dash.state.drops[0] || {};
      assert.ok(d.provider, 'в теле pool-drop есть provider');
      assert.strictEqual(d.model, DEAD, `в теле pool-drop мёртвая модель (было ${d.model})`);
      assert.strictEqual(d.fallback, FALLBACK, `в теле pool-drop фолбэк (было ${d.fallback})`);
      checks += 4;

      // ── Сцена 3: память процесса — мёртвую модель больше не спрашиваем ─────────
      const r2 = await ask(P);
      assert.strictEqual(r2.status, 200, `второй запрос тоже успешен (было ${r2.status})`);
      assert.ok(r2.body.includes('ПУЛ-ОК'), 'второй запрос дошёл содержимым');
      assert.strictEqual(gw.state.hits, 3, `третий заход в шлюз — сразу фолбэком (было ${gw.state.hits})`);
      assert.strictEqual(gw.state.seen.filter((m) => m === DEAD).length, 1,
        `мёртвую модель спросили РОВНО раз за всё время (видел ${JSON.stringify(gw.state.seen)})`);
      assert.strictEqual(gw.state.seen[2], FALLBACK, `второй запрос ушёл фолбэком, минуя мёртвую модель (${gw.state.seen[2]})`);
      await sleep(400);
      assert.strictEqual(dash.state.drops.length, 1, 'повторного pool-drop нет — дашборд не дёргают зря');
      checks += 6;
    }

    // ── Сцена 4: `poolFallbackModel: ''` — фича выключена, отказ честный ─────────
    {
      const [P, U, D] = [28345, 28344, 28346];
      const gw = stubGateway(U, 'pool-then-ok');
      const dash = stubDashboard(D);
      await gw.listen();
      await dash.listen();
      const kp = spawnKeepalive(P, U, D, {});
      open.push(gw.srv, dash.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 10000, 'старт keepalive (сцена 4)');

      const off = await patchConfig(P, { poolFallbackModel: '' });
      assert.strictEqual(off.status, 200, `POST /__config принят (было ${off.status})`);
      assert.ok(off.json && off.json.cfg && off.json.cfg.poolFallbackModel === '',
        `ручка фолбэка пишется пустой строкой (cfg.poolFallbackModel=${off.json && off.json.cfg && JSON.stringify(off.json.cfg.poolFallbackModel)})`);

      const r = await ask(P);
      assert.strictEqual(r.status, 402, `клиент получает честный 402, а не подмену (было ${r.status})`);
      assert.ok(/quota has been exhausted/i.test(r.body), 'тело отказа — настоящее, от шлюза');
      assert.strictEqual(gw.state.hits, 1, `шлюз спрошен один раз, повтора нет (было ${gw.state.hits})`);
      assert.strictEqual(dash.state.drops.length, 0, 'дашборд не дёргали — фича выключена целиком');
      checks += 6;
    }

    // ── Сцена 5: чужой 402 («нет баланса») пуловым фолбэком НЕ считается ────────
    // Фолбэк лечит пустой ПУЛ, а не пустой аккаунт: подменять модель там бессмысленно,
    // деньги кончились у аккаунта, и клиент должен увидеть настоящую причину.
    {
      const [P, U, D] = [28348, 28347, 28349];
      const gw = stubGateway(U, 'balance');
      const dash = stubDashboard(D);
      await gw.listen();
      await dash.listen();
      const kp = spawnKeepalive(P, U, D, {});
      open.push(gw.srv, dash.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 10000, 'старт keepalive (сцена 5)');

      const r = await ask(P);
      assert.strictEqual(r.status, 402, `чужой 402 отдан клиенту как есть (было ${r.status})`);
      assert.ok(/Insufficient account balance/.test(r.body), 'клиент видит настоящую причину шлюза');
      assert.strictEqual(gw.state.hits, 1, `повтора нет (было ${gw.state.hits})`);
      assert.strictEqual(dash.state.drops.length, 0, 'карта не тронута — это не пул');
      checks += 4;
    }

    // ── Сцена 6: 402 приходит ПОСЛЕ пре-коммита — клиент всё равно видит успех ───
    // Поток клиенту уже открыт и кормится пингами. Переиграть можно, потому что 402 это
    // тело ошибки, а не дельты содержимого: настоящий ответ дописывается в тот же поток.
    {
      const [P, U, D] = [28351, 28350, 28352];
      const gw = stubGateway(U, 'pool-then-ok', 3000);
      const dash = stubDashboard(D);
      await gw.listen();
      await dash.listen();
      const kp = spawnKeepalive(P, U, D, { PRE_COMMIT_MS: '1500', IDLE_MS: '500' });
      open.push(gw.srv, dash.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 10000, 'старт keepalive (сцена 6)');

      const r = await ask(P);
      assert.ok(/пре-коммит SSE/.test(kp.log), 'пре-коммит успел открыть поток — сцена воспроизведена');
      assert.strictEqual(r.status, 200, `клиент получил 200 (было ${r.status})`);
      assert.ok(!/event: error/.test(r.body), 'in-band ошибки нет — подагент бы выжил');
      assert.ok(r.body.includes('ПУЛ-ОК'), 'ответ фолбэка доехал в тот же открытый поток');
      assert.ok(/event: ping/.test(r.body), 'пока разбирались с 402, клиента держали пингами');
      assert.strictEqual(gw.state.hits, 2, `шлюз спрошен дважды (было ${gw.state.hits})`);
      checks += 6;
    }

    // ── Сцена 7: фолбэк сам получил 402 — цикла нет, клиенту уходит ошибка ───────
    // Ровно один повтор на запрос: иначе фолбэк, который тоже в пуле, крутил бы запросы
    // до бесконечности, а клиент так и не узнал бы, что происходит.
    {
      const [P, U, D] = [28354, 28353, 28355];
      const gw = stubGateway(U, 'pool-always');
      const dash = stubDashboard(D);
      await gw.listen();
      await dash.listen();
      const kp = spawnKeepalive(P, U, D, {});
      open.push(gw.srv, dash.srv, kp.proc);
      await waitFor(() => /listening on http/.test(kp.log), 10000, 'старт keepalive (сцена 7)');

      const r = await ask(P);
      assert.strictEqual(gw.state.hits, 2, `ровно два обращения: 402 + один повтор (было ${gw.state.hits})`);
      assert.strictEqual(gw.state.seen[1], FALLBACK, `повтор ушёл фолбэком (${gw.state.seen[1]})`);
      assert.strictEqual(r.status, 402, `клиенту уходит ошибка, а не тишина (было ${r.status})`);
      assert.ok(r.ms < 20000, `и без выкручивания бюджета попыток (${r.ms}мс)`);
      checks += 4;
    }

    console.log(`check-pool-fallback OK (${checks} проверок): 402 пула переигран фолбэком незаметно для клиента, `
      + 'дашборд получил ровно один pool-drop, память процесса не пускает запрос в мёртвую модель, '
      + 'выключенный фолбэк отдаёт честный 402, чужой 402 пуловым не считается, '
      + 'после пре-коммита клиент всё равно видит успех, фолбэк-402 не зацикливается');
    process.exitCode = 0;
  } catch (e) {
    console.error('ПРОВАЛ: ' + e.message);
    // Лог подставных keepalive — наверх: живут они в отдельных процессах, и без их
    // вывода причина провала («ветка не сработала» / «процесс упал») не видна вовсе.
    for (const b of boxes) {
      const tail = b.log.split('\n').filter(Boolean).slice(-25).join('\n');
      if (tail) console.error(`--- keepalive (pid ${b.proc.pid}) ---\n${tail}`);
    }
    process.exitCode = 1;
  } finally {
    for (const x of open) {
      try { x.kill ? x.kill() : x.close(); } catch { /* уже мёртв */ }
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* не критично */ }
  }
})();
