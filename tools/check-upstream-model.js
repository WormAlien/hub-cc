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

if (failures.length) {
  console.error(failures.map((x) => `[FAIL] ${x}`).join('\n'));
  process.exit(1);
}

console.log(`[OK] upstream model suffix boundary: ${cases.length} кейсов`);
