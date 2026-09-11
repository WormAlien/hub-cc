#!/usr/bin/env node
'use strict';

// Регресс границы Claude Code → keepalive → upstream.
// `[1m]` нужен клиенту для расчёта окна, но большинство шлюзов не принимают
// суффикс как часть GPT model id. JustWoker 11.09.2026: каталог отдаёт только
// gpt-5.6-{sol,luna,terra}; gpt-5.6-sol[1m] отвечает как неизвестная модель.

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'routing', 'keepalive-proxy.js');
const src = fs.readFileSync(file, 'utf8');
const match = src.match(/function upstreamModelFor\(target, sourceModel\) \{[\s\S]*?\n\}/);

if (!match) {
  console.error('[FAIL] keepalive-proxy.js: нет upstreamModelFor() — правило суффикса на проводе не закреплено');
  process.exit(1);
}

let upstreamModelFor;
try {
  upstreamModelFor = new Function('isGptLike', `${match[0]}; return upstreamModelFor;`)(
    (model) => /gpt|o[0-9]|davinci|chatgpt/i.test(String(model || '')),
  );
} catch (error) {
  console.error(`[FAIL] upstreamModelFor() не исполняется: ${error.message}`);
  process.exit(1);
}

const cases = [
  ['gpt-5.6-sol', 'claude-opus-5[1m]', 'gpt-5.6-sol'],
  ['gpt-5.6-sol[1m]', 'claude-opus-5[1m]', 'gpt-5.6-sol'],
  ['gpt-5.6-luna', 'gpt-5.6-sol[1m]', 'gpt-5.6-luna'],
  ['claude-opus-5', 'claude-sonnet-5[1m]', 'claude-opus-5[1m]'],
  ['claude-opus-5[200k]', 'claude-sonnet-5[1m]', 'claude-opus-5[1m]'],
  ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-5'],
  // 11.09, живой бой: glm-цель с [1m] от источника уезжала как glm-5.3[1m], и
  // AgentRouter отвергал её 500 «Upstream rejected the request as invalid».
  ['glm-5.3', 'claude-opus-5[1m]', 'glm-5.3'],
  ['glm-5.3', 'gpt-5.6-sol[1m]', 'glm-5.3'],
];

const failures = [];
for (const [target, source, want] of cases) {
  const got = upstreamModelFor(target, source);
  if (got !== want) failures.push(`${target} + ${source} → ${got}; ожидалось ${want}`);
}

if (!/upstreamModelFor\(target, model\)/.test(src)) {
  failures.push('remapHaiku() не применяет upstreamModelFor(target, model) к реальному телу запроса');
}

// ── stripClaudeOnlyFields: поля Claude API, которые не-claude каналы отвергают ──
// 11.09, живой бой: AgentRouter + glm-5.3 отвечал 400/500 «Upstream rejected the
// request as invalid» на каждый запрос CC v2.1.220 с context_management/output_config.
const stripMatch = src.match(/function stripClaudeOnlyFields\(body\) \{[\s\S]*?\n\}/);
if (!stripMatch) {
  failures.push('keepalive-proxy.js: нет stripClaudeOnlyFields() — новые поля Claude Code валят не-claude каналы');
} else {
  let strip;
  try {
    // Константа живёт рядом с функцией, но в вырезку не попадает — без неё функция
    // молча падает в catch и возвращает null (поймано первым же прогоном этого теста).
    const constMatch = src.match(/const CLAUDE_ONLY_FIELDS = \[[^\]]*\];/);
    if (!constMatch) throw new Error('нет константы CLAUDE_ONLY_FIELDS');
    strip = new Function(`${constMatch[0]}\n${stripMatch[0]}; return stripClaudeOnlyFields;`)();
  } catch (error) {
    failures.push(`stripClaudeOnlyFields() не исполняется: ${error.message}`);
  }
  if (strip) {
    const withFields = Buffer.from(JSON.stringify({
      model: 'glm-5.3', max_tokens: 32000, stream: true,
      thinking: { type: 'adaptive' },
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      output_config: { effort: 'medium' },
    }));
    const stripped = strip(withFields);
    if (!stripped) {
      failures.push('stripClaudeOnlyFields(): тело с обоими полями вернуло null — срезки не было');
    } else {
      const j = JSON.parse(stripped.toString('utf8'));
      if ('context_management' in j) failures.push('stripClaudeOnlyFields(): context_management пережил срезку');
      if ('output_config' in j) failures.push('stripClaudeOnlyFields(): output_config пережил срезку');
      if (j.thinking?.type !== 'adaptive') failures.push('stripClaudeOnlyFields():adaptive thinking пострадал при срезке');
      if (j.model !== 'glm-5.3' || j.max_tokens !== 32000) failures.push('stripClaudeOnlyFields(): пострадали посторонние поля');
    }
    if (strip(Buffer.from(JSON.stringify({ model: 'glm-5.3' }))) !== null) {
      failures.push('stripClaudeOnlyFields(): тело без спец-полей должно давать null (лишняя перезапись тела)');
    }
    if (strip(Buffer.from('not json')) !== null) {
      failures.push('stripClaudeOnlyFields(): не-JSON тело должно давать null');
    }
  }
}
// Проводка: срезка обязана стоять ПОСЛЕ ремапа и применять её решает модель В ТЕЛЕ.
if (!/stripClaudeOnlyFields\(reqBody\)/.test(src)) {
  failures.push('обработчик запроса не зовёт stripClaudeOnlyFields(reqBody) — срезка не подключена');
}

// ── stripImageBlocks: картинки в истории валят не-claude каналы целиком ──
// 11.09 (вечер), живой бой: один pasted-скрин в истории — и каждый запрос сессии
// умирает «Upstream rejected» (канал glm не принимает image-блоки). Бисект по
// реальному телу: без image — 200 за 12с, с ним — 500 на каждом повторе.
const imgMatch = src.match(/const IMAGE_PLACEHOLDER = \{[^}]*\};\nfunction stripImageBlocks\(body\) \{[\s\S]*?\n\}/);
if (!imgMatch) {
  failures.push('keepalive-proxy.js: нет stripImageBlocks() — image-блок в истории убивает сессию на glm-канале');
} else {
  let stripImg;
  try {
    stripImg = new Function(`${imgMatch[0]}; return stripImageBlocks;`)();
  } catch (error) {
    failures.push(`stripImageBlocks() не исполняется: ${error.message}`);
  }
  if (stripImg) {
    const withImg = Buffer.from(JSON.stringify({
      model: 'glm-5.3',
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'смотри скрин' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
        ] }] },
      ],
    }));
    const cleaned = stripImg(withImg);
    if (!cleaned) {
      failures.push('stripImageBlocks(): тело с картинками вернуло null — срезки не было');
    } else {
      const j2 = JSON.parse(cleaned.toString('utf8'));
      const flat = JSON.stringify(j2);
      if (/"type":"image"/.test(flat)) failures.push('stripImageBlocks(): image-блок пережил срезку');
      if (!flat.includes('[image removed')) failures.push('stripImageBlocks(): вместо картинки нет текстовой метки');
      if (!flat.includes('смотри скрин')) failures.push('stripImageBlocks(): посторонний текст пострадал');
      if (j2.messages[1].content[0].type !== 'tool_use') failures.push('stripImageBlocks(): tool_use пострадал');
    }
    if (stripImg(Buffer.from(JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'текст' }] }))) !== null) {
      failures.push('stripImageBlocks(): тело без картинок должно давать null (лишняя перезапись)');
    }
    if (stripImg(Buffer.from('not json')) !== null) {
      failures.push('stripImageBlocks(): не-JSON тело должно давать null');
    }
  }
}
if (!/stripImageBlocks\(reqBody\)/.test(src)) {
  failures.push('обработчик запроса не зовёт stripImageBlocks(reqBody) — срезка картинок не подключена');
}
// Гейт срезки — явный список моделей-отвергателей (12.09, слова владельца:
// картинки не принимают только glm-5.3 и deepseek-v4-flash, остальные — все —
// принимают). Никаких масок: /^glm-\d/ ловила и vision-варианты — поймано тестом.
if (!/IMG_REJECTING_MODELS\.has\(outModel\)/.test(src)) {
  failures.push('срезка картинок не заперта на явный список IMG_REJECTING_MODELS');
}
if (!/new Set\(\['glm-5\.3', 'deepseek-v4-flash'\]\)/.test(src)) {
  failures.push('в IMG_REJECTING_MODELS должны быть glm-5.3 и deepseek-v4-flash (точные id из каталога)');
}

// ── content-length пересчитывается ВСЕГДА, не только при ремапе ──
// 11.09, живой бой: срезка context_management/output_config укорачивала passthrough-
// тело (голая glm-5.3 от CC — ремапа нет, tgt=null), а пересчёт длины стоял под
// if (tgt) — наверх уезжал завышенный content-length, шлюз ждал недостающие байты
// 60с и отвечал 502. Так лежали все новые окна с прямым glm-5.3[1m]. Воспроизведено
// replay.js с CL_DELTA: 62с → 502 nginx, один-в-один симптом падения.
if (!/headers\['content-length'\] = Buffer\.byteLength\(body\);/.test(src)) {
  failures.push('makeUpstream(): нет пересчёта content-length по фактическому телу');
}
if (/if \(tgt\) \{\s*headers\['content-length'\]/.test(src)) {
  failures.push('makeUpstream(): пересчёт content-length заперт под if (tgt) — passthrough со срезкой полей уезжает с завышенной длиной (502 за 60с)');
}
if (!/delete headers\['transfer-encoding'\];/.test(src)) {
  failures.push('makeUpstream(): с клиента не снимается transfer-encoding при явном content-length');
}

if (failures.length) {
  console.error(failures.map((x) => `[FAIL] ${x}`).join('\n'));
  process.exit(1);
}

console.log(`[OK] upstream model suffix boundary: ${cases.length} кейсов`);
