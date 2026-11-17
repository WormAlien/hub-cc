#!/usr/bin/env node
'use strict';
// macOS-установщик обязан проверять РАБОТОСПОСОБНОСТЬ claude, а не наличие шима в PATH.
//
// Живой случай 17.11.2026: на маке `claude '--dangerously-skip-permissions'` падал с
//   Error: claude native binary not installed.
// потому что postinstall (@anthropic-ai/claude-code/install.cjs) не отработал. Шим в
// PATH при этом был, `command -v claude` успешно возвращал путь, установщик рапортовал
// «claude уже стоит» — и человек оставался с нерабочей командой. Лечилось вручную:
//   node "$(npm root -g)/@anthropic-ai/claude-code/install.cjs"
//
// Проверяем контракт по исходнику и по поведению вырезанного блока в песочнице.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'install-mac.sh');
const SRC = fs.readFileSync(INSTALLER, 'utf8');

// Блок «6. Claude Code» — от step до следующего step.
function claudeBlock() {
    const start = SRC.indexOf('step "Claude Code"');
    assert.ok(start > 0, 'не найден блок Claude Code в install-mac.sh');
    const end = SRC.indexOf('step "', start + 10);
    return SRC.slice(start, end > 0 ? end : SRC.length);
}

test('installer does not treat a shim in PATH as a working claude', () => {
    const block = claudeBlock();
    // Голый `have claude` как РЕШЕНИЕ — это ровно тот баг. Разрешено только как
    // условие «шим есть, но не отвечает → ремонтировать».
    assert.ok(!/^if have claude; then\s*\n\s*ok /m.test(block),
        'блок всё ещё считает наличие команды доказательством работоспособности');
    // Решение принимается по ответу `claude --version`.
    assert.match(block, /claude_ver\(\)/, 'нет проверки ответа claude');
    assert.match(block, /CCVER="\$\(claude_ver\)"/, 'версия не читается в переменную');
});

test('installer repairs a broken install by running the real postinstall', () => {
    const block = claudeBlock();
    assert.match(block, /install\.cjs/, 'postinstall не запускается');
    assert.match(block, /npm root -g/, 'путь к пакету не вычисляется через npm root -g');
    // Ремонт должен идти ДО переустановки: она дороже и требует сети.
    const repair = block.indexOf('install.cjs');
    const reinstall = block.indexOf('npm install -g @anthropic-ai/claude-code');
    assert.ok(repair > 0 && reinstall > repair, 'postinstall должен пробоваться раньше переустановки');
});

test('installer runs postinstall after a fresh global install', () => {
    const block = claudeBlock();
    const after = block.slice(block.indexOf('npm install -g @anthropic-ai/claude-code'));
    assert.match(after, /install\.cjs/,
        'после установки postinstall не дожимается — npm с allow-scripts его пропускает');
});

test('installer stays quiet about success until claude actually answers', () => {
    const block = claudeBlock();
    // Ни одна ветка не должна объявлять успех по факту установки.
    assert.ok(!/npm install -g [^\n]*&& ok "Claude Code установлен"/.test(block),
        'успех объявляется по коду возврата npm, а не по ответу claude');
    assert.match(block, /if \[ -n "\$CCVER" \]; then ok "Claude Code установлен: \$CCVER"/,
        'нет финальной проверки по версии');
});

test('installer hands over the exact repair command when it cannot fix it itself', () => {
    const block = claudeBlock();
    assert.match(block, /npm root -g\)\/@anthropic-ai\/claude-code\/install\.cjs/,
        'человеку не дают готовую команду ремонта');
    assert.match(block, /npm cache clean --force/, 'нет команды переустановки с чистым кэшем');
});

test('extracted block repairs a shim-only install without touching a working one', () => {
    // Поведенческая проверка: подставляем фейковые claude/npm/node и смотрим, что
    // установщик делает в двух состояниях.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const rootG = path.join(dir, 'npm-root');
    const pkg = path.join(rootG, '@anthropic-ai/claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    // Реальный postinstall, который «починит» бинарь: создаёт маркер.
    fs.writeFileSync(path.join(pkg, 'install.cjs'), 'require("fs").writeFileSync('
        + JSON.stringify(path.join(dir, 'repaired')) + ', "1");\n');
    // npm: печатает свой root и не падает.
    fs.writeFileSync(path.join(bin, 'npm'),
        `#!/bin/bash\ncase "$1 $2" in\n  "root -g") echo "${rootG}" ;;\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 });
    // node: запускает переданный файл настоящим node (путь берём ДО подмены PATH).
    const realNode = process.execPath;
    fs.writeFileSync(path.join(bin, 'node'),
        `#!/bin/bash\nexec "${realNode}" "$@"\n`, { mode: 0o755 });

    // Состояние «шим есть, бинаря нет»: claude --version падает с той самой ошибкой.
    const broken = path.join(dir, 'broken');
    fs.writeFileSync(broken,
        '#!/bin/bash\necho "Error: claude native binary not installed." >&2\nexit 1\n', { mode: 0o755 });
    // После ремонта тот же шим начинает отвечать.
    const repaired = path.join(dir, 'repaired-shim');
    fs.writeFileSync(repaired,
        `#!/bin/bash\nif [ -e "${path.join(dir, 'repaired')}" ]; then echo 2.5.0; exit 0; fi\n`
        + 'echo "Error: claude native binary not installed." >&2\nexit 1\n', { mode: 0o755 });
    fs.copyFileSync(broken, path.join(bin, 'claude'));

    const script = path.join(dir, 'run.sh');
    // have()/ok()/warn()/step() — минимальные заглушки того же контракта.
    fs.writeFileSync(script, [
        '#!/bin/bash',
        'ok(){ echo "OK: $*"; }',
        'warn(){ echo "WARN: $*"; }',
        'step(){ echo "STEP: $*"; }',
        'have(){ command -v "$1" >/dev/null 2>&1; }',
        claudeBlock(),
    ].join('\n'), { mode: 0o755 });

    // Первый прогон: битый шим. Ждём запуск install.cjs и признание, что починили.
    const out1 = execFileSync('bash', [script], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir },
    });
    assert.ok(fs.existsSync(path.join(dir, 'repaired')),
        'postinstall не был запущен для битого claude\n' + out1);
    assert.match(out1, /postinstall|не отвечает/i, 'установщик не заметил битый claude\n' + out1);

    // Второй прогон: рабочий claude не трогаем — postinstall не должен вызываться.
    fs.rmSync(path.join(dir, 'repaired'));
    fs.copyFileSync(path.join(dir, 'repaired-shim'), path.join(bin, 'claude'));
    fs.writeFileSync(path.join(dir, 'repaired'), '1');   // уже «починен»
    const out2 = execFileSync('bash', [script], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir },
    });
    assert.match(out2, /уже стоит|2\.5\.0/, 'рабочий claude не распознан\n' + out2);
    assert.ok(!/WARN/.test(out2), 'рабочий claude вызвал предупреждения\n' + out2);

    fs.rmSync(dir, { recursive: true, force: true });
});
