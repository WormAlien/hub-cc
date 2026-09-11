'use strict';
// Разовая миграция: девять ручек `<p>/modelmap` с полной перезаписи на слияние.
// Запускается один раз, проверяет КАЖДУЮ замену на единственность и падает, если
// шаблон не найден или найден дважды — молча ничего не меняет.
const fs = require('fs');
const F = 'routing/transparent-proxy.js';
let src = fs.readFileSync(F, 'utf8');
const before = src;

// [константа файла, подпись в логе, пустое значение]
const THREE = [
    ['GO_MODELMAP_FILE', 'gorouter', 'null'],
    ['KK_MODELMAP_FILE', 'kktoken', 'null'],
    ['AP_MODELMAP_FILE', 'kktoken', 'null'],   // 🪤 подпись врёт: файл AIPM, лог «kktoken» — чиним заодно
    ['HN_MODELMAP_FILE', 'hcnsec', 'null'],
    ['JW_MODELMAP_FILE', 'justwoker', 'null'],
    ['SK_MODELMAP_FILE', 'seekai', 'null'],
    ['TB_MODELMAP_FILE', 'tabi', "''"],
    ['XP_MODELMAP_FILE', 'xpeach', "''"],
];
const LOG_LABEL = { AP_MODELMAP_FILE: 'aipm' };          // исправленные подписи

const report = [];
for (const [konst, label, empty] of THREE) {
    const e = empty === 'null' ? 'null' : "''";
    const old = `const mm = {
            opus: String(body.opus || '').trim() || ${e},
            sonnet: String(body.sonnet || '').trim() || ${e},
            haiku: String(body.haiku || '').trim() || ${e},
        };
        fs.writeFileSync(${konst}, JSON.stringify(mm, null, 2) + '\\n', 'utf8');
        logLine(\`${label} modelmap: opus→\${mm.opus || '-'} sonnet→\${mm.sonnet || '-'} haiku→\${mm.haiku || '-'}\`);`;
    // Вариант с лишним отступом (Tb/Xp держат тело под `if (req.method === 'POST')`).
    const oldIndented = old.split('\n').map((l, i) => (i === 0 ? l : '    ' + l)).join('\n');
    const hit = src.split(old).length - 1;
    const hitIndented = src.split(oldIndented).length - 1;
    const useIndented = hitIndented > 0 && hit === 0;
    const pattern = useIndented ? oldIndented : old;
    const count = useIndented ? hitIndented : hit;
    if (count !== 1) { report.push(`SKIP ${konst}: совпадений ${count} (ожидалась 1)`); continue; }

    const lbl = LOG_LABEL[konst] || label;
    const pad = useIndented ? '    ' : '';
    const neu = `// 🪤 Слияние, а не перезапись: ручка управляет тремя тирами, а в файле
${pad}        // может лежать \`gpt\` из вкладки «Маршруты» — полная перезапись стирала его молча.
${pad}        const mm = writeTierMap(${konst}, {
${pad}            opus: body.opus, sonnet: body.sonnet, haiku: body.haiku,
${pad}        }, ${e});
${pad}        logLine(\`${lbl} modelmap: opus→\${mm.opus || '-'} sonnet→\${mm.sonnet || '-'} haiku→\${mm.haiku || '-'}\${mm.gpt ? \` gpt→\${mm.gpt} (сохранён)\` : ''}\`);`;
    src = src.replace(pattern, neu);
    report.push(`ok   ${konst}${LOG_LABEL[konst] ? ' (+ подпись лога исправлена)' : ''}${useIndented ? ' [вложенный отступ]' : ''}`);
}

if (src === before) { console.log(report.join('\n')); console.log('\nничего не изменено'); process.exit(1); }
fs.writeFileSync(F, src, 'utf8');
console.log(report.join('\n'));
