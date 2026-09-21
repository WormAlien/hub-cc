#!/usr/bin/env node
// Проба класса `400 Invalid signature in thinking block` на минимальном теле.
//
// Замер 21.09: в упавших телах ВСЕ подписи thinking-блоков - обычные UUID
// (`8445635e-7434-4ebe-ba00-6f2113768f60`, 36 символов), а настоящая подпись
// Anthropic - длинный base64. Их синтезирует шлюз. Ломается не «сессия побывала
// на дипсике», а «запрос попал на канал, который подпись реально проверяет».
//
// Проба отвечает на три вопроса тремя запросами по ~200 токенов вместо правки
// вслепую по боевому телу в 250 КБ:
//   as-is    - воспроизводится ли отказ на поддельной подписи;
//   strip-old- хватит ли чистки ИСТОРИИ (последний ход не трогаем) - это ярус 2;
//   strip-all- законна ли чистка и в ПОСЛЕДНЕМ ассистентском ходе с tool_use,
//              где документация Anthropic прямо запрещает «filtered out» - это ярус 3.
//
// Запуск: node tools/check-thinking-signature.js [порт]   (по умолчанию 20133)

const http = require('http');

const PORT = Number(process.argv[2] || 20133);
const MODEL = process.env.PROBE_MODEL || 'claude-opus-5';
const fakeSig = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

const TOOLS = [{
  name: 'get_weather',
  description: 'Get the current weather for a location.',
  input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
}];

// История ровно той формы, что падает в бою: старый ход с thinking+text, свежий
// ход с thinking+tool_use, и ответ инструмента следом.
function baseMessages() {
  return [
    { role: 'user', content: 'Привет, посчитай два плюс два.' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Два плюс два - четыре.', signature: fakeSig() },
      { type: 'text', text: 'Четыре.' },
    ] },
    { role: 'user', content: 'А теперь погоду в Париже.' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Нужен инструмент погоды.', signature: fakeSig() },
      { type: 'tool_use', id: 'toolu_01probe0000000000000001', name: 'get_weather', input: { location: 'Paris' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_01probe0000000000000001', content: 'Current temperature: 20C' },
    ] },
  ];
}

// Чистка: mode 'old' - во всех ассистентских сообщениях, КРОМЕ последнего;
//         mode 'all' - везде. Остальные блоки (text, tool_use) не трогаем.
function stripThinking(messages, mode) {
  let lastAssistant = -1;
  messages.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });
  return messages.map((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m;
    if (mode === 'old' && i === lastAssistant) return m;
    const content = m.content.filter((b) => !b || b.type !== 'thinking');
    return Object.assign({}, m, { content });
  });
}

function post(messages) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    tools: TOOLS,
    messages,
  });
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    // Прокси держит ответ пробелами и повторяет до пяти раз: один случай съедал
    // 152с на шторме Bedrock. Пробе столько не нужно - рвём и повторяем случай.
    req.setTimeout(45000, () => { req.destroy(new Error('таймаут пробы 45с')); });
    req.on('error', (e) => resolve({ status: 0, text: String(e.message) }));
    req.end(body);
  });
}

const SIG_RE = /Invalid `?signature`? in `?thinking`? block/i;
// Шум шлюза, на котором вердикт делать нельзя: это не про подпись, а про канал.
const NOISE_RE = /Bedrock|InvokeModel|upstream error|overloaded|таймаут пробы|out-of-balance/i;

(async () => {
  const cases = [
    ['as-is    (поддельные подписи везде)', () => baseMessages()],
    ['strip-old(чистка истории, последний ход цел)', () => stripThinking(baseMessages(), 'old')],
    ['strip-all(чистка везде, включая последний ход)', () => stripThinking(baseMessages(), 'all')],
  ];
  for (const [label, build] of cases) {
    let r = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      r = await post(build());
      // Пустое тело на 200 - это удержание пробелами, вердикта в нём нет.
      const noisy = NOISE_RE.test(r.text) || (r.status === 200 && !/"content"|"type"/.test(r.text));
      if (!noisy) break;
      console.log(`      (попытка ${attempt} шумная: ${r.text.replace(/\s+/g, ' ').slice(0, 80)} - повторяю)`);
    }
    const sig = SIG_RE.test(r.text) ? ' ← ОТКАЗ ПО ПОДПИСИ' : '';
    const snippet = r.text.replace(/\s+/g, ' ').slice(0, 180);
    console.log(`${String(r.status).padEnd(4)} ${label}${sig}`);
    console.log(`      ${snippet}`);
  }
})();
