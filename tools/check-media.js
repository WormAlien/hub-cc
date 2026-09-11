#!/usr/bin/env node
/*
 * check-media.js — регресс вкладки MEDIA (генерация картинок и видео).
 *
 * Зачем файл существует. Вкладка ходит к платному шлюзу, поэтому цена молчаливой
 * поломки тут выше обычной: неверно собранный запрос стоит денег, а пустой результат
 * при списанных деньгах выглядит как «сломался интерфейс». Регресс охраняет ровно
 * те места, где такая ошибка была бы тихой.
 *
 * 🪤 Ни одного обращения к живому шлюзу и ни одной генерации: сеть заменена заглушкой,
 * задание гоняется по настоящему коду очереди. Регресс не должен стоить денег.
 *
 * Живой стек НЕ трогает: свой временный каталог, свой порт, живой дашборд не нужен.
 *
 * Запуск: node tools/check-media.js      (exit 1 = вкладка сломана)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROUTING = path.join(__dirname, '..', 'routing');
const catalog = require(path.join(ROUTING, 'lib', 'media-catalog.js'));
const dialects = require(path.join(ROUTING, 'lib', 'media-dialects.js'));
const queue = require(path.join(ROUTING, 'lib', 'media-queue.js'));
const routes = require(path.join(ROUTING, 'lib', 'media-routes.js'));

let passed = 0;
function ok(name, fn) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
async function okAsync(name, fn) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('check-media:');

// ── Каталог: типизация ────────────────────────────────────────────────────────

ok('видео не уезжает в картинки (порядок правил важен)', () => {
    // `grok-imagine-video` содержит и `imagine`, и `video`. Если правило картинок
    // окажется выше, все видеомодели молча станут картинками.
    assert.strictEqual(catalog.guessKind('grok-imagine-video'), catalog.KIND.VIDEO);
    assert.strictEqual(catalog.guessKind('grok-imagine-video-1.5'), catalog.KIND.VIDEO);
    assert.strictEqual(catalog.guessKind('grok-imagine-image'), catalog.KIND.IMAGE);
});

ok('живой каталог шлюза раскладывается 11 картинок / 3 видео', () => {
    const models = ['codex-gpt-image-2', 'gpt-image-2', 'gpt-image-2-4k', 'gpt-image-2-max',
        'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'grok-imagine',
        'grok-imagine-image', 'grok-imagine-image-quality', 'nano-banana-2',
        'grok-imagine-video', 'grok-imagine-video-1.5', 'grok-imagine-video-1.5-preview',
        'claude-opus-5', 'gpt-5.6-luna'];
    const c = catalog.classify('test', models);
    assert.strictEqual(c.image.length, 11, `картинок ${c.image.length}`);
    assert.strictEqual(c.video.length, 3, `видео ${c.video.length}`);
});

ok('неизвестная модель просит подтверждения, описанная — нет', () => {
    // Логика намеренно «подтверждено только перечисленное»: список подозрительных
    // суффиксов всегда неполон, и новая модель проезжала бы с чужими дефолтами.
    assert.strictEqual(catalog.profileFor('t', 'gpt-image-2.5-sunburst').undocumented, false);
    assert.strictEqual(catalog.profileFor('t', 'gpt-image-2-max').undocumented, true);
    assert.strictEqual(catalog.profileFor('t', 'какая-то-новая-модель-image').undocumented, true);
});

// ── Диалекты ─────────────────────────────────────────────────────────────────

ok('запрос картинки собирается в проверенную форму', () => {
    const d = dialects.dialectFor(catalog.profileFor('t', 'gpt-image-2.5-sunburst'));
    const r = d.build({ model: 'gpt-image-2.5-sunburst', prompt: 'кот', size: '1024x1024', count: 2 });
    assert.strictEqual(r.method, 'POST');
    assert.strictEqual(r.path, '/images/generations');
    assert.strictEqual(r.body.response_format, 'b64_json');
    assert.strictEqual(r.body.n, 2);
    assert.strictEqual(r.body.size, '1024x1024');
});

ok('сырой JSON перекрывает поля формы', () => {
    const d = dialects.dialectFor(catalog.profileFor('t', 'gpt-image-2'));
    const r = d.build({ model: 'gpt-image-2', prompt: 'x', size: '1024x1024', raw: { size: '512x512', extra: 1 } });
    assert.strictEqual(r.body.size, '512x512', 'оверрайд обязан побеждать — это аварийный рычаг');
    assert.strictEqual(r.body.extra, 1);
});

ok('поля, которые человек не задал, в запрос не попадают', () => {
    // Лишнее поле у части шлюзов = 400 на весь запрос.
    const d = dialects.dialectFor(catalog.profileFor('t', 'gpt-image-2'));
    const r = d.build({ model: 'gpt-image-2', prompt: 'x' });
    for (const k of ['seed', 'negative_prompt', 'background', 'quality']) {
        assert.ok(!(k in r.body), `поле ${k} уехало пустым`);
    }
});

ok('пустой ответ падает громко, а не отдаёт ноль файлов', () => {
    const d = dialects.dialectFor(catalog.profileFor('t', 'gpt-image-2'));
    assert.throws(() => d.parse({ data: [] }), /без data/);
    assert.throws(() => d.parse({}), /без data/);
});

ok('видео понимает и готовый файл, и задание с опросом', () => {
    const d = dialects.dialectFor(catalog.profileFor('t', 'grok-imagine-video'));
    assert.strictEqual(d.parse({ data: [{ url: 'https://x/y.mp4' }] }).status, 'done');
    const pend = d.parse({ id: 'job1', status: 'queued' });
    assert.strictEqual(pend.status, 'pending');
    assert.strictEqual(pend.jobId, 'job1');
    assert.throws(() => d.parse({ nonsense: true }), /не опознан/);
});

ok('диалект видео честно помечен непроверенным', () => {
    // Если его когда-нибудь проверят живьём — флаг снимут осознанно, а не забудут.
    assert.strictEqual(dialects.dialectFor(catalog.profileFor('t', 'grok-imagine-video')).verified, false);
    assert.strictEqual(dialects.dialectFor(catalog.profileFor('t', 'gpt-image-2')).verified, true);
});

// ── Файлы ────────────────────────────────────────────────────────────────────

ok('тип файла берётся из байтов, а не из слова провайдера', () => {
    assert.deepStrictEqual(queue.sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0])),
        { ext: 'png', mime: 'image/png' });
    assert.deepStrictEqual(queue.sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8)])),
        { ext: 'mp4', mime: 'video/mp4' });
    // HTML под видом картинки — самый вероятный мусор от шлюза (страница ошибки).
    assert.strictEqual(queue.sniff(Buffer.from('<html>ошибка</html>')), null);
});

ok('id задания не пускает обход пути', () => {
    assert.ok(queue.isJobId('m0123456789abcdef'));
    for (const bad of ['../etc/passwd', 'm123', '', 'M0123456789ABCDEF', 'm0123456789abcdef/../x']) {
        assert.ok(!queue.isJobId(bad), `пропущен плохой id: ${bad}`);
    }
});

// ── Ручки ────────────────────────────────────────────────────────────────────

function serve() {
    const srv = http.createServer((req, res) => {
        if (routes.handle(req, res)) return;
        res.writeHead(404); res.end();
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}
function req(port, pathname, opts = {}) {
    return new Promise(resolve => {
        const q = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers: opts.headers || {} }, res => {
            const c = []; res.on('data', x => c.push(x));
            res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
        });
        if (opts.body) q.write(opts.body);
        q.end();
    });
}

(async () => {
    const srv = await serve();
    const port = srv.address().port;

    await okAsync('query-строка не ломает маршрут', async () => {
        // 🪤 В дашборде ~355 предикатов сверяют req.url целиком, и `?param` мимо них
        // пролетает. Здесь сравнение идёт по pathname — проверяем, что так и осталось.
        const r = await req(port, '/__media/api/jobs?x=1&y=2');
        assert.strictEqual(r.code, 200);
    });

    await okAsync('генерация без промпта отвергается до похода к шлюзу', async () => {
        const r = await req(port, '/__media/api/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'нет-такого', model: 'x', prompt: '' }),
        });
        assert.strictEqual(r.code, 404);
    });

    await okAsync('обход пути в имени файла отбивается', async () => {
        const r = await req(port, '/__media/api/file/..%2F..%2Fetc%2Fpasswd/0');
        assert.strictEqual(r.code, 400);
    });

    await okAsync('неизвестный маршрут отвечает 404, а не падает', async () => {
        const r = await req(port, '/__media/api/no-such-route');
        assert.strictEqual(r.code, 404);
    });

    await okAsync('чужой префикс модуль не перехватывает', async () => {
        // Иначе одна строка делегирования в дашборде съела бы соседние вкладки.
        const r = await req(port, '/__switch/api/status');
        assert.strictEqual(r.code, 404, 'модуль ответил на чужой путь');
    });

    srv.close();

    // ── Фронт: контракт с большим файлом ──────────────────────────────────────
    ok('вкладка отдаёт наружу только точки входа', () => {
        const js = fs.readFileSync(path.join(ROUTING, 'vendor', 'media-tab.js'), 'utf8');
        assert.ok(/window\.MEDIA\s*=/.test(js), 'нет window.MEDIA');
        assert.ok(/\bload\b/.test(js) && /\brefresh\b/.test(js), 'нет load/refresh');
    });

    ok('в CSS вкладки нет своих hex и нет коротких имён токенов', () => {
        const css = fs.readFileSync(path.join(ROUTING, 'vendor', 'media-tab.css'), 'utf8');
        const body = css.replace(/\/\*[\s\S]*?\*\//g, '');   // комментарии не считаем
        assert.deepStrictEqual(body.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [],
            'захардкоженный цвет станет тёмным островом на светлых темах');
        const shortVars = (body.match(/var\(--(?!color-)[a-z-]+\)/g) || []);
        assert.deepStrictEqual(shortVars, [],
            `коротких токенов в глобальной области нет, значение будет пустым: ${shortVars.join(', ')}`);
    });

    ok('вкладка не красит запрещёнными в темах цветами', () => {
        const js = fs.readFileSync(path.join(ROUTING, 'vendor', 'media-tab.js'), 'utf8');
        const body = js.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const bad of ['text-rose', 'bg-white/', 'text-sky', 'text-teal', 'text-cyan']) {
            assert.ok(!body.includes(bad), `${bad} — в темах дашборда не работает`);
        }
    });

    console.log(process.exitCode ? '\nСЛОМАНО' : `\nвсё зелено (${passed})`);
})();
