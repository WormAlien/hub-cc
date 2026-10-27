'use strict';
// Регресс дописки хвоста для Premier (keepalive-proxy.js, ensureTrailingUserText).
// Замер, на котором правка построена, - tools/probe-premier-reasoning.js: шлюз отвечает
// 400 «requires previous reasoning_content», когда последний ход истории - user с одним
// tool_result или роль system; любой пользовательский текст в хвосте лечит отказ.
// Проверяем само преобразование и оба гейта (хост и рубильник), живых запросов нет.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'routing', 'keepalive-proxy.js');
const code = fs.readFileSync(SRC, 'utf8');
// Функция живёт до блока selftest: берём её исходник и исполняем в песочнице.
const start = code.indexOf('const PREMIER_TAIL_TEXT =');
const end = code.indexOf('// ──', code.indexOf('function ensureTrailingUserText'));
assert.ok(start > 0 && end > start, 'исходник ensureTrailingUserText не найден');
const helpers = code.slice(start, end);
const sandbox = {};
new Function('exports', helpers + '; exports.f = ensureTrailingUserText; exports.hasText = hasTextBlock; exports.TEXT = PREMIER_TAIL_TEXT;')(sandbox);
const { f: ensureTrailingUserText, hasText: hasTextBlock, TEXT } = sandbox;

const buf = obj => Buffer.from(JSON.stringify(obj), 'utf8');
const parse = b => JSON.parse(b.toString('utf8'));

// 1. Агентский ход: user с одним tool_result - главный живой случай.
{
    const body = { model: 'm', messages: [
        { role: 'user', content: 'привет' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ] };
    const out = ensureTrailingUserText(buf(body));
    assert.ok(out, 'хвост из tool_result обязан переписываться');
    const msgs = parse(out.body).messages;
    assert.strictEqual(msgs.length, 3, 'число ходов не меняется - роли остаются чередоваться');
    const blocks = msgs[2].content;
    assert.strictEqual(blocks[0].type, 'tool_result', 'tool_result остаётся на месте и первым');
    assert.deepStrictEqual(blocks[blocks.length - 1], { type: 'text', text: TEXT }, 'текст дописан в тот же ход');
}

// 2. Хвост ролью system - второй живой случай (клиент так шлёт напоминания).
{
    const body = { model: 'm', messages: [
        { role: 'user', content: 'привет' },
        { role: 'assistant', content: [{ type: 'text', text: 'да' }] },
        { role: 'system', content: '<total_tokens>1 left</total_tokens>' },
    ] };
    const msgs = parse(ensureTrailingUserText(buf(body)).body).messages;
    assert.strictEqual(msgs.length, 4, 'после system добавлен отдельный ход пользователя');
    assert.strictEqual(msgs[3].role, 'user');
    assert.deepStrictEqual(msgs[3].content, [{ type: 'text', text: TEXT }]);
    assert.strictEqual(msgs[2].role, 'system', 'сам system-ход не переписан');
}

// 3. Хвост уже правильный - тело не трогаем вовсе.
{
    const body = { model: 'm', messages: [
        { role: 'user', content: 'привет' },
        { role: 'assistant', content: [{ type: 'text', text: 'да' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'продолжай' }] },
    ] };
    assert.strictEqual(ensureTrailingUserText(buf(body)), null, 'текст в хвосте уже есть - преобразование не нужно');
}

// 4. Пустой текст не считается: блок из одних пробелов не лечит отказ.
{
    assert.strictEqual(hasTextBlock([{ type: 'text', text: '   ' }]), false, 'пробелы - не текст');
    assert.strictEqual(hasTextBlock([{ type: 'thinking', thinking: 'x' }]), false, 'thinking - не текст');
    assert.strictEqual(hasTextBlock('  '), false, 'пустая строка - не текст');
    assert.strictEqual(hasTextBlock('ok'), true, 'строка с текстом');
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: '  ' }] }] };
    const out = ensureTrailingUserText(buf(body));
    assert.ok(out, 'ход из одних пробелов переписывается');
    assert.strictEqual(parse(out.body).messages[0].content.filter(b => b.type === 'text' && b.text.trim()).length, 1);
}

// 5. Строковый content у пользователя: текст дописывается, а не затирает строку.
{
    const body = { messages: [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'да' }] };
    const msgs = parse(ensureTrailingUserText(buf(body)).body).messages;
    assert.strictEqual(msgs[2].role, 'user');
    assert.strictEqual(msgs[2].content[0].text, TEXT);
}

// 6. Не-JSON и пустая история - null, а не исключение: путь запроса не должен падать.
{
    assert.strictEqual(ensureTrailingUserText(Buffer.from('не json', 'utf8')), null);
    assert.strictEqual(ensureTrailingUserText(buf({ messages: [] })), null);
    assert.strictEqual(ensureTrailingUserText(buf({})), null);
}

// 7. Тело клиента не портится: остальные поля и ходы остаются байт-в-байт по смыслу.
{
    const body = { model: 'deepseek-v4.1-flash-1017', max_tokens: 32000, stream: true, system: 'rules',
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] }] };
    const out = parse(ensureTrailingUserText(buf(body)).body);
    assert.strictEqual(out.model, body.model);
    assert.strictEqual(out.max_tokens, 32000);
    assert.strictEqual(out.stream, true);
    assert.strictEqual(out.system, 'rules');
}

// 8. Гейты: рубильник и хост считаются один раз при старте, дефолт - включено у Premier.
{
    const gate = code.match(/const PREMIER_TAIL = ([^\n]+);/);
    assert.ok(gate, 'гейт PREMIER_TAIL не найден');
    assert.ok(/PREMIER_TAIL !== '0'/.test(gate[1]), 'рубильник PREMIER_TAIL=0 выключает правку');
    assert.ok(/upstream\.hostname === PREMIER_TAIL_HOST/.test(gate[1]), 'гейт по хосту обязателен');
    assert.ok(/const PREMIER_TAIL_HOST = process\.env\.PREMIER_TAIL_HOST \|\| 'ide\.kgpix\.bond';/.test(code),
        'хост Premier указан явно, с подменой только для тестов');
    const sites = code.split('ensureTrailingUserText(reqBody').length - 1;
    assert.strictEqual(sites, 1, 'преобразование на пути запроса ровно одно');
    assert.ok(/if \(PREMIER_TAIL && req\.method === 'POST' && \/\^\\\/v1\\\/messages/.test(code),
        'правка не трогает count_tokens и прочие ручки');
}

console.log(JSON.stringify({ ok: true, tests: 8 }));
