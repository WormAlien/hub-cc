// Проверка tools/git-pull-safe.js в песочнице: грязный modelmap не должен ломать
// pull, а выбор юзера обязан выжить; грязный код обязан остановить обновление.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pullsafe-'));
const origin = path.join(root, 'origin.git'), seed = path.join(root, 'seed'), work = path.join(root, 'work');
const run = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const ignored = (cwd, file) => {
  try { run(cwd, 'check-ignore', '--quiet', '--no-index', '--', file); return true; }
  catch { return false; }
};
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) process.exitCode = 1; };

function copyPullSafeRuntime(destRoot) {
  fs.mkdirSync(path.join(destRoot, 'routing', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'git-pull-safe.js'), path.join(destRoot, 'tools', 'git-pull-safe.js'));
  fs.copyFileSync(path.resolve(__dirname, '..', 'routing', 'lib', 'durable-write.js'),
    path.join(destRoot, 'routing', 'lib', 'durable-write.js'));
  fs.copyFileSync(path.resolve(__dirname, '..', 'routing', 'lib', 'api-gateway.js'),
    path.join(destRoot, 'routing', 'lib', 'api-gateway.js'));
}

execFileSync('git', ['init', '--bare', '-b', 'master', origin]);
execFileSync('git', ['clone', origin, seed]);
run(seed, 'config', 'user.email', 't@t'); run(seed, 'config', 'user.name', 't');
fs.mkdirSync(path.join(seed, 'routing')); fs.mkdirSync(path.join(seed, 'tools'));
fs.copyFileSync(path.resolve(__dirname, '..', '.gitignore'), path.join(seed, '.gitignore'));
fs.copyFileSync(path.resolve(__dirname, '..', '.gitattributes'), path.join(seed, '.gitattributes'));
for (const name of ['ar', 'gorouter', 'tabi', 'xpeach']) {
  fs.writeFileSync(path.join(seed, `routing/${name}-modelmap.json`), '{"opus":"repo-default"}\n');
}
fs.writeFileSync(path.join(seed, 'routing/api-gateway.default.json'), '{"seed":true}\n');
fs.writeFileSync(path.join(seed, 'code.js'), 'v1\n');
copyPullSafeRuntime(seed);
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'init'); run(seed, 'push', 'origin', 'master');

execFileSync('git', ['clone', origin, work]);
run(work, 'config', 'user.email', 't@t'); run(work, 'config', 'user.name', 't');

// апстрим ушёл вперёд и менял тот же modelmap (худший случай)
fs.writeFileSync(path.join(seed, 'code.js'), 'v2\n');
fs.writeFileSync(path.join(seed, 'routing/ar-modelmap.json'), '{"opus":"repo-new"}\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up'); run(seed, 'push', 'origin', 'master');

// юзер поменял тир в UI
fs.writeFileSync(path.join(work, 'routing/ar-modelmap.json'), '{"opus":"USER-CHOICE"}\n');

// A: CLI обновляется и сохраняет настройки
function cli(cwd, ...extra) {
  try {
    const out = execFileSync(process.execPath, ['tools/git-pull-safe.js', ...extra], { cwd, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
}
const a = cli(work);
ok('A: CLI вышел 0', a.code === 0);
ok('A: код обновился', fs.readFileSync(path.join(work, 'code.js'), 'utf8').trim() === 'v2');
ok('A: выбор юзера сохранён', fs.readFileSync(path.join(work, 'routing/ar-modelmap.json'), 'utf8').includes('USER-CHOICE'));
ok('A: сказал про сохранённые настройки', /ar-modelmap\.json/.test(a.out));

// B: грязный код → код выхода 3, ничего не тронуто
fs.writeFileSync(path.join(seed, 'code.js'), 'v3\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up2'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'code.js'), 'LOCAL HACK\n');
const b = cli(work);
ok('B: код выхода 3', b.code === 3);
ok('B: назвал мешающий файл', /code\.js/.test(b.out));
ok('B: правки юзера целы', fs.readFileSync(path.join(work, 'code.js'), 'utf8').includes('LOCAL HACK'));

// C: модуль возвращает структуру (как зовёт дашборд)
fs.writeFileSync(path.join(work, 'code.js'), 'v2\n');   // убрали помеху
run(work, 'checkout', '--', 'code.js');
const mod = require(path.join(work, 'tools/git-pull-safe.js'));
const r = mod.pullSafe();
ok('C: pullSafe().ok', r.ok === true);
ok('C: preserved — массив', Array.isArray(r.preserved));
ok('C: LOCAL_STATE_FILES экспортирован', mod.LOCAL_STATE_FILES.includes('routing/ar-modelmap.json'));

// D: НИ ОДНА трекаемая тир-карта не осталась без защиты.
// Проверяем против настоящего репо, а не против списка в коде: список и был
// источником бага — `routing/xpeach-modelmap.json` трекался и писался из UI, но в
// перечислении его забыли, и обновление у второго пользователя встало насмерть
// (21.08). Заводя нового провайдера, эту проверку уронит именно забытая карта.
const real = require(path.resolve(__dirname, 'git-pull-safe.js'));
const tracked = run(seed, 'ls-files', 'routing/*-modelmap.json')
    .split('\n').map(s => s.trim()).filter(Boolean);
ok('D: тир-карты в репо нашлись', tracked.length >= 4);
const unprotected = tracked.filter(f => !real.isStateFile(f));
ok(`D: все ${tracked.length} тир-карт защищены${unprotected.length ? ' — ДЫРКА: ' + unprotected.join(', ') : ''}`,
   unprotected.length === 0);
// И обратное: настоящий код файлом состояния не считается, иначе pull молча
// откатывал бы правки в коде вместо того, чтобы о них сказать.
ok('D: code is not state', real.isStateFile('routing/transparent-proxy.js') === false);
ok('D: local API Gateway manifest is state', real.isStateFile('routing/api-gateway.json') === true);
ok('D: tracked API Gateway default seed is not state', real.isStateFile('routing/api-gateway.default.json') === false);
ok('D: local API Gateway manifest is ignored', ignored(seed, 'routing/api-gateway.json'));
ok('D: durable-write temp artifact is ignored', ignored(seed, 'routing/api-gateway.json.tmp-1234'));
ok('D: transaction artifacts are ignored',
   ['routing/api-gateway.json.lock', 'routing/api-gateway.json.journal',
    'routing/api-gateway.json.stage-fixture', 'routing/api-gateway.json.backup-fixture']
       .every(f => ignored(seed, f)));
ok('D: tracked default seed is not ignored', !ignored(seed, 'routing/api-gateway.default.json'));

// E: --stash — правки кода НЕ блокируют обновление, а прячутся и возвращаются.
// Это режим, который жмёт кнопка в дашборде после подтверждения. До 21.08 умный
// путь был только в update.sh, и человек с правками кода застревал на кнопке.
fs.writeFileSync(path.join(seed, 'code.js'), 'v4\n');
fs.writeFileSync(path.join(seed, 'routing/ar-modelmap.json'), '{"opus":"repo-v4"}\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up4'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'code.js'), 'LOCAL HACK 2\n');            // правка кода
fs.writeFileSync(path.join(work, 'routing/ar-modelmap.json'), '{"opus":"USER-2"}\n'); // и настройка

const e = cli(work, '--stash');
ok('E: --stash вышел 0', e.code === 0);
ok('E: код обновился', fs.readFileSync(path.join(work, 'code.js'), 'utf8').trim() === 'v4');
ok('E: выбор юзера сохранён', fs.readFileSync(path.join(work, 'routing/ar-modelmap.json'), 'utf8').includes('USER-2'));
ok('E: сказал про stash', /stash/i.test(e.out) && /code\.js/.test(e.out));
// Правки кода не потеряны — они В СТЭШЕ. Проверяем именно наличие и содержимое, а
// НЕ то, что `git stash pop` применится чисто: если апстрим менял тот же файл, pop
// честно даёт конфликт (проверено здесь живьём — code.js разошёлся v2→v4). Поэтому
// и в UI обещаем «лежит в стэше», а не «вернётся одной командой без вопросов».
const stashList = run(work, 'stash', 'list');
ok('E: запись в stash есть', /git-pull-safe auto-stash/.test(stashList));
ok('E: в стэше именно правка кода', /LOCAL HACK 2/.test(run(work, 'stash', 'show', '-p', 'stash@{0}')));
// Стэш НЕ трогаем: pop мог бы оставить дерево в конфликте и сломать проверку E-контроль.
// И контроль, что тест не зелёный по случайности: БЕЗ --stash тот же расклад обязан
// упереться в код выхода 3, иначе E ничего не проверяет.
fs.writeFileSync(path.join(seed, 'code.js'), 'v5\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up5'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'code.js'), 'LOCAL HACK 3\n');
const noStash = cli(work);
ok('E: без --stash тот же расклад даёт код 3', noStash.code === 3);
ok('E: без --stash правки на месте', fs.readFileSync(path.join(work, 'code.js'), 'utf8').includes('LOCAL HACK 3'));
run(work, 'checkout', '--', 'code.js');   // убрали помеху от E

// F: апстрим завёл ФАЙЛ, которого у нас нет в git, а у человека он уже лежит.
// `git diff --name-only HEAD` неотслеживаемое не видит вообще, поэтому раньше
// dirty был пуст, blocking пуст, и наружу уходило сырое «The following untracked
// working tree files would be overwritten by merge». Два подслучая:
//   F1 — это тир-карта: настройка, её надо сберечь молча (как трекаемую);
//   F2 — это чей-то файл: помеха, называем и прячем в stash по подтверждению.
fs.writeFileSync(path.join(seed, 'routing/newprov-modelmap.json'), '{"opus":"repo-newprov"}\n');
fs.writeFileSync(path.join(seed, 'extra.js'), 'upstream extra\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up6'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'routing/newprov-modelmap.json'), '{"opus":"USER-NEWPROV"}\n'); // F1
fs.writeFileSync(path.join(work, 'extra.js'), 'MY OWN EXTRA\n');                                 // F2

const f1 = cli(work);
ok('F: без --stash код выхода 3', f1.code === 3);
ok('F: назвал неотслеживаемую помеху', /extra\.js/.test(f1.out));
ok('F: пометил, что файл новый', /новый файл/.test(f1.out));
ok('F: не тронул чужой файл', fs.readFileSync(path.join(work, 'extra.js'), 'utf8').includes('MY OWN EXTRA'));
ok('F: тир-карту юзера не выбросил', fs.readFileSync(path.join(work, 'routing/newprov-modelmap.json'), 'utf8').includes('USER-NEWPROV'));

const f2 = cli(work, '--stash');
ok('F: --stash вышел 0', f2.code === 0);
ok('F: untracked тир-карта юзера сохранена',
   fs.readFileSync(path.join(work, 'routing/newprov-modelmap.json'), 'utf8').includes('USER-NEWPROV'));
// `git stash show -p` неотслеживаемое НЕ показывает (оно лежит в третьем родителе
// стэш-коммита) — смотреть надо с --include-untracked, иначе проверка врёт «пусто».
ok('F: untracked чужой файл в стэше',
   /MY OWN EXTRA/.test(run(work, 'stash', 'show', '-p', '--include-untracked', 'stash@{0}')));
ok('F: апстримная версия файла на месте', fs.readFileSync(path.join(work, 'extra.js'), 'utf8').includes('upstream extra'));

// G: свои коммиты, разошедшиеся с master. `--ff-only` даёт «Not possible to
// fast-forward», а regex про «local changes» его не ловил — уходил сырой текст.
// Требуем: понятное объяснение, счёт своих коммитов, команда, и НИ ОДИН свой
// коммит не потерян (auto-reset здесь запрещён).
fs.writeFileSync(path.join(seed, 'code.js'), 'v6\n');
run(seed, 'add', '-A'); run(seed, 'commit', '-m', 'up7'); run(seed, 'push', 'origin', 'master');
fs.writeFileSync(path.join(work, 'mine.js'), 'my own commit\n');
run(work, 'add', '-A'); run(work, 'commit', '-m', 'my local commit');
const head = run(work, 'rev-parse', 'HEAD').trim();

const g = cli(work, '--stash');   // даже в «умном» режиме не имеет права ресетить
// Код 4, а не 1: по нему update.sh/fix.sh обязаны НЕ доезжать до
// `reset --hard origin/master` — он выбросил бы ровно эти коммиты.
ok('G: код выхода 4 (diverged)', g.code === 4);
ok('G: объяснил расхождение', /История разошлась/.test(g.out));
ok('G: посчитал свои коммиты', /у тебя 1 своих коммит/.test(g.out));
ok('G: подсказал команду', /git pull --rebase/.test(g.out));
ok('G: свой коммит на месте', run(work, 'rev-parse', 'HEAD').trim() === head);
ok('G: свой файл цел', fs.existsSync(path.join(work, 'mine.js')));
ok('G: diverged в структуре ответа', require(path.join(work, 'tools/git-pull-safe.js')).pullSafe().diverged === true);

// H: вызывающий не имеет права на грубую починку.
//
// 🪤 Раньше здесь гонялись живьём блоки обновления update.sh и fix.sh: у них было
// последнее средство `git fetch && git reset --hard origin/master`, и на разошедшейся
// истории оно молча уничтожало незапушенные коммиты. Оба скрипта из репозитория убраны
// (обновление целиком переехало в hub.js), и тест падал на их отсутствии - то есть
// блоки I, J и K не выполнялись ВООБЩЕ. Проверяем живого вызывающего: он обязан знать
// оба кода «не трогать» и не ресетить дерево ни по одному из них.
const hubSrc = fs.readFileSync(path.resolve(__dirname, '..', 'hub.js'), 'utf8');
// 🪤 Границы берём вместе со скобкой: `async function doPostUpdate` находит ещё и
// `doPostUpdateNoGit`, которая объявлена РАНЬШЕ, - срез выходил пустым и три проверки
// ниже проходили вхолостую (в пустой строке нет ни `code === 5`, ни `нужен интернет`).
const hFrom = hubSrc.indexOf('async function doUpdate({');
const hTo = hubSrc.indexOf('async function doPostUpdate({');
ok('H: тело doUpdate в hub.js нашлось', hFrom > 0 && hTo > hFrom);
const hubUpdate = hFrom > 0 && hTo > hFrom ? hubSrc.slice(hFrom, hTo) : '';
ok('H: тело doUpdate непустое', hubUpdate.length > 500);
ok('H: хаб знает код 4 (свои коммиты)', /code === 4/.test(hubUpdate));
ok('H: хаб знает код 5 (незавершённая операция)', /code === 5/.test(hubUpdate));
ok('H: хаб не ресетит дерево в обновлении', !/--hard/.test(hubUpdate));
// Причина отказа печатается выше самим git-pull-safe, и она бывает ЛОКАЛЬНОЙ. Обещать
// интернет как единственное объяснение - ровно тот дефект, из-за которого человек две
// недели не мог обновиться (живой экран 30.09.2026).
ok('H: хаб не объявляет интернет единственной причиной',
   !/нужен интернет и доступ к GitHub/.test(hubUpdate));

// ── L / M: репозиторий посреди незавершённой операции ───────────────────────
//
// 🔴 Замер на живом git 30.09.2026: одна и та же причина приезжает наружу РАЗНЫМИ
// словами, смотря по тому, разошлась ли история. При конфликте от `git stash pop` и при
// брошенном `git rebase -i` это «Pulling is not possible because you have unmerged
// files», а при слиянии с конфликтом на разошедшихся ветках - «fatal: Not possible to
// fast-forward». Первые две фразы не подходили ни под один регекс модуля и уходили
// человеку сырым текстом git'а, третью ловил isDiverged и объяснял расхождением истории.
// А хаб на любую из них печатал «нужен интернет и доступ к GitHub».
//
// Поэтому проверяем ОБА вида состояния: с маркером операции в .git (rebase) и без него
// (конфликт от stash pop - операции нет, а индекс разъехался).
function pullFails(cwd) {
  // Контроль: состояние обязано быть ровно тем, на котором спотыкался человек.
  try { run(cwd, 'pull', '--ff-only'); return false; } catch { return true; }
}

console.log('\nL. брошенный rebase: назван, объяснён, ничего не тронуто');
const l = sandbox('unfinished-rebase', '*.json text\n');
fs.writeFileSync(l.map, '{\n  "opus": "MINE"\n}\n');
run(l.work, 'add', '-A'); run(l.work, 'commit', '-m', 'свой коммит');
// 🪤 fetch обязателен: work клонирован ДО апстримного коммита, и его origin/master ещё
// смотрит на init. Без fetch rebase пошёл бы на тот же коммит, конфликта не было бы, и
// блок L «проходил» бы, ничего не проверяя.
run(l.work, 'fetch', 'origin');
let rebaseOn = false;
try { run(l.work, 'rebase', 'origin/master'); } catch { rebaseOn = true; }
const lHead = run(l.work, 'rev-parse', 'HEAD').trim();
ok('L: rebase встал на конфликте', rebaseOn && fs.existsSync(path.join(l.work, '.git/rebase-merge')));
ok('L: обычный git pull здесь отказывает (контроль)', pullFails(l.work));
const lRes = cli(l.work);
ok('L: код выхода 5 (незавершённая операция)', lRes.code === 5);
ok('L: названа операция', /незавершённый rebase/.test(lRes.out));
ok('L: назван файл в конфликте', /ar-modelmap\.json/.test(lRes.out));
ok('L: сказано, что это не сеть', /не сеть и не права/.test(lRes.out));
ok('L: дан выход через ветку-якорь', /git branch backup\/update-/.test(lRes.out));
ok('L: подсказана отмена именно rebase', /git rebase --abort/.test(lRes.out));
ok('L: не сырой текст git', !/Pulling is not possible/.test(lRes.out));
// Главное: мы ничего не тронули. `reset --hard` здесь выбросил бы работу в rebase.
ok('L: rebase не отменён за спиной', fs.existsSync(path.join(l.work, '.git/rebase-merge')));
ok('L: HEAD не сдвинут', run(l.work, 'rev-parse', 'HEAD').trim() === lHead);
const lmod = require(path.join(l.work, 'tools/git-pull-safe.js'));
ok('L: в структуре ответа unfinished', lmod.pullSafe().unfinished === true);
ok('L: pendingOperation увидел маркер', lmod.pendingOperation().marks.some(m => m.name === 'rebase-merge'));

console.log('\nM. конфликт от stash pop: маркеров в .git нет, а pull всё равно отказывает');
const m = sandbox('unfinished-stash', '*.json text\n');
fs.writeFileSync(m.map, '{\n  "opus": "USER-STASH"\n}\n');
run(m.work, 'stash', 'push', '-m', 'работа юзера');
run(m.work, 'fetch', 'origin');
run(m.work, 'reset', '--hard', 'origin/master');
let popConflict = false;
try { run(m.work, 'stash', 'pop'); } catch { popConflict = true; }
const mmod = require(path.join(m.work, 'tools/git-pull-safe.js'));
ok('M: stash pop дал конфликт', popConflict);
ok('M: маркеров операции в .git НЕТ', mmod.pendingOperation().marks.length === 0);
ok('M: конфликтный путь виден', mmod.pendingOperation().unmerged.includes('routing/ar-modelmap.json'));
ok('M: обычный git pull здесь отказывает (контроль)', pullFails(m.work));
const mRes = cli(m.work);
ok('M: код выхода 5', mRes.code === 5);
ok('M: назван конфликт в рабочем дереве', /конфликт в рабочем дереве/.test(mRes.out));
ok('M: назван файл', /ar-modelmap\.json/.test(mRes.out));
ok('M: не сырой текст git', !/Pulling is not possible/.test(mRes.out));
// Запись в стэше при конфликте не сбрасывается - правки юзера целы, и мы об этом молчим
// зря не пугаем: код 5 про них ничего не утверждает.
ok('M: правки юзера в стэше целы', /работа юзера/.test(run(m.work, 'stash', 'list')));


// ── I / J: файл, грязный ТОЛЬКО переводами строк ─────────────────────────────
// Расклад с живого репо (Windows, core.autocrlf=true, `*.json text`): дашборд
// перезаписывает тир-карту из Node — `JSON.stringify + '\n'`, то есть LF, — а git
// ждёт в рабочей копии CRLF. Содержимое при этом совпадает с HEAD байт в байт после
// нормализации, поэтому `git diff --name-only HEAD` ПУСТ, а `git pull` встаёт на
// «local changes would be overwritten». Тупик: откатывать нечего, обновиться нельзя,
// а починка доезжает только тем самым обновлением.
// I — старый мир (`*.json text`): pullSafe обязан вывезти.
// J — с `eol=lf` на файлы состояния грязь не возникает вообще.
function sandbox(name, attributes) {
  const o = path.join(root, `${name}.git`), s = path.join(root, `${name}-seed`), w = path.join(root, `${name}-work`);
  execFileSync('git', ['init', '--bare', '-b', 'master', o]);
  execFileSync('git', ['clone', o, s]);
  run(s, 'config', 'user.email', 't@t'); run(s, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(s, 'routing')); fs.mkdirSync(path.join(s, 'tools'));
  fs.writeFileSync(path.join(s, '.gitattributes'), attributes);
  fs.writeFileSync(path.join(s, 'routing/ar-modelmap.json'), '{\n  "opus": "repo-default"\n}\n');
  fs.writeFileSync(path.join(s, 'code.js'), 'v1\n');
  copyPullSafeRuntime(s);
  run(s, 'add', '-A'); run(s, 'commit', '-m', 'init'); run(s, 'push', 'origin', 'master');
  // Клонируем ИМЕННО с autocrlf=true — это и есть настройка живого репо на Windows,
  // без неё расхождение не возникает и тест ничего не проверяет.
  execFileSync('git', ['clone', '-c', 'core.autocrlf=true', o, w]);
  run(w, 'config', 'user.email', 't@t'); run(w, 'config', 'user.name', 't');
  // Апстрим ушёл вперёд и тронул ТОТ ЖЕ json: без этого git на грязный по eol файл
  // не жалуется вовсе (проверено) — pull проходит и случай не воспроизводится.
  fs.writeFileSync(path.join(s, 'code.js'), 'v2\n');
  fs.writeFileSync(path.join(s, 'routing/ar-modelmap.json'), '{\n  "opus": "repo-new"\n}\n');
  run(s, 'add', '-A'); run(s, 'commit', '-m', 'up'); run(s, 'push', 'origin', 'master');
  return { seed: s, work: w, map: path.join(w, 'routing/ar-modelmap.json') };
}

const i = sandbox('eol', '*.json text\n');
ok('I: git отдал рабочую копию с CRLF', fs.readFileSync(i.map, 'utf8').includes('\r\n'));
// «Дашборд» переписал файл: значение то же, переводы строк — LF.
fs.writeFileSync(i.map, '{\n  "opus": "repo-default"\n}\n');
// Контроль, что тест воспроизводит именно слепое пятно, а не обычную грязь: старый
// детект файл НЕ видит, новый — видит. Уберут union из dirtyFiles() — упадёт I ниже.
ok('I: старый детект (diff HEAD) файл НЕ видит', run(i.work, 'diff', '--name-only', 'HEAD').trim() === '');
ok('I: diff-files его видит', /ar-modelmap\.json/.test(run(i.work, 'diff-files', '--name-only')));
let plainPull = 0;
try { run(i.work, 'pull', '--ff-only'); } catch (e) { plainPull = e.status; }
ok('I: обычный git pull встаёт насмерть', plainPull !== 0);
const iRes = cli(i.work);
ok('I: pullSafe вывез (код 0)', iRes.code === 0);
ok('I: код обновился', fs.readFileSync(path.join(i.work, 'code.js'), 'utf8').trim() === 'v2');
ok('I: значение юзера сохранено', /repo-default/.test(fs.readFileSync(i.map, 'utf8')));
ok('I: сказал про сохранённые настройки', /ar-modelmap\.json/.test(iRes.out));

const j = sandbox('eollf', '*.json text\nrouting/*-modelmap.json text eol=lf\n');
ok('J: с eol=lf рабочая копия сразу LF', !fs.readFileSync(j.map, 'utf8').includes('\r\n'));
fs.writeFileSync(j.map, '{\n  "opus": "repo-default"\n}\n');   // тот же Node-writer
ok('J: файл не стал грязным', run(j.work, 'status', '--porcelain').trim() === '');
let plainPullJ = 0;
try { run(j.work, 'pull', '--ff-only'); } catch (e) { plainPullJ = e.status; }
ok('J: обычный git pull из консоли проходит', plainPullJ === 0);

// K: правило eol=lf стоит на КАЖДОМ файле состояния настоящего репо. Проверяем
// против самого git'а (`check-attr`), а не против текста .gitattributes: строчку
// там забыть так же легко, как забыли `xpeach-modelmap.json` в перечислении.
const localManifest = 'routing/api-gateway.json';
const stateFiles = run(seed, 'ls-files', 'routing/*.json')
    .split('\n').map(s => s.trim()).filter(f => f && real.isStateFile(f));
if (real.isStateFile(localManifest)) stateFiles.push(localManifest);
ok('K: state files exist in the fixture repository', stateFiles.length >= 5);
const noLf = stateFiles.filter(f => !/eol: lf/.test(run(seed, 'check-attr', 'eol', '--', f)));
ok(`K: all ${stateFiles.length} state files use eol=lf${noLf.length ? ' - MISSING: ' + noLf.join(', ') : ''}`,
   noLf.length === 0);
ok('K: local API Gateway manifest uses eol=lf',
   /eol: lf/.test(run(seed, 'check-attr', 'eol', '--', 'routing/api-gateway.json')));

ok('K: tracked API Gateway default seed uses eol=lf',
   /eol: lf/.test(run(seed, 'check-attr', 'eol', '--', 'routing/api-gateway.default.json')));

function ignoredManifestSandbox(name) {
  const o = path.join(root, `${name}.git`);
  const s = path.join(root, `${name}-seed`);
  const w = path.join(root, `${name}-work`);
  execFileSync('git', ['init', '--bare', '-b', 'master', o]);
  execFileSync('git', ['clone', o, s]);
  run(s, 'config', 'user.email', 't@t'); run(s, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(s, 'routing')); fs.mkdirSync(path.join(s, 'tools'));
  fs.writeFileSync(path.join(s, '.gitignore'), 'routing/api-gateway.json\nrouting/api-gateway.json.*\n');
  fs.writeFileSync(path.join(s, 'routing/api-gateway.default.json'), '{"seed":true}\n');
  fs.writeFileSync(path.join(s, 'code.js'), 'v1\n');
  copyPullSafeRuntime(s);
  run(s, 'add', '-A'); run(s, 'commit', '-m', 'init'); run(s, 'push', 'origin', 'master');
  execFileSync('git', ['clone', o, w]);
  run(w, 'config', 'user.email', 't@t'); run(w, 'config', 'user.name', 't');
  return { origin: o, seed: s, work: w, manifest: path.join(w, 'routing/api-gateway.json') };
}

function loadWithInjectedGitFailure(file, subcommand) {
  const childProcess = require('child_process');
  const original = childProcess.execFileSync;
  childProcess.execFileSync = function injected(command, args, options) {
    const output = original.call(this, command, args, options);
    if (command === 'git' && Array.isArray(args) && args[0] === subcommand) {
      const error = new Error(`injected failure after git ${subcommand}`);
      error.status = 17;
      error.stderr = `injected failure after git ${subcommand}`;
      throw error;
    }
    return output;
  };
  delete require.cache[require.resolve(file)];
  try { return require(file); }
  finally { childProcess.execFileSync = original; }
}

function requireFresh(file) {
  delete require.cache[require.resolve(file)];
  return require(file);
}

console.log('\nN. ignored manifest collision during pull');
const n = ignoredManifestSandbox('ignored-pull');
const nBytes = Buffer.from([0x7b, 0x22, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x22, 0x3a, 0x31, 0x7d, 0x0d, 0x0a]);
fs.writeFileSync(n.manifest, nBytes);
fs.writeFileSync(path.join(n.seed, 'code.js'), 'v2\n');
fs.writeFileSync(path.join(n.seed, 'routing/api-gateway.json'), '{"upstream":true}\n');
run(n.seed, 'add', '-f', 'routing/api-gateway.json'); run(n.seed, 'add', 'code.js');
run(n.seed, 'commit', '-m', 'upstream tracks manifest'); run(n.seed, 'push', 'origin', 'master');
const nRes = cli(n.work);
ok('N: pull succeeds when upstream starts tracking ignored manifest', nRes.code === 0);
ok('N: pull updates unrelated code', fs.readFileSync(path.join(n.work, 'code.js'), 'utf8').trim() === 'v2');
ok('N: ignored local manifest is restored byte-exact', fs.readFileSync(n.manifest).equals(nBytes));
ok('N: manifest is reported as preserved', /api-gateway\.json/.test(nRes.out));
ok('N: restored owner manifest is marked skip-worktree while upstream tracks the path',
   /^S\s/.test(run(n.work, 'ls-files', '-v', 'routing/api-gateway.json')));
fs.writeFileSync(path.join(n.seed, 'code.js'), 'v3\n');
fs.writeFileSync(path.join(n.seed, 'routing/api-gateway.json'), '{"upstream":2}\n');
run(n.seed, 'add', 'code.js'); run(n.seed, 'add', '-f', 'routing/api-gateway.json');
run(n.seed, 'commit', '-m', 'second upstream update'); run(n.seed, 'push', 'origin', 'master');
const nSecond = cli(n.work);
ok('N: second pull also succeeds after upstream began tracking manifest', nSecond.code === 0);
ok('N: second pull updates code', fs.readFileSync(path.join(n.work, 'code.js'), 'utf8').trim() === 'v3');
ok('N: second pull still preserves ignored local manifest byte-exact', fs.readFileSync(n.manifest).equals(nBytes));

console.log('\nO. ignored manifest is restored after failed pull');
const o = ignoredManifestSandbox('ignored-pull-fail');
const oBytes = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0xff]);
fs.writeFileSync(o.manifest, oBytes);
fs.writeFileSync(path.join(o.seed, 'routing/api-gateway.json'), '{"upstream":true}\n');
run(o.seed, 'add', '-f', 'routing/api-gateway.json');
run(o.seed, 'commit', '-m', 'upstream tracks manifest'); run(o.seed, 'push', 'origin', 'master');
const oMod = loadWithInjectedGitFailure(path.join(o.work, 'tools/git-pull-safe.js'), 'pull');
const oRes = oMod.pullSafe();
ok('O: pull reports the injected post-pull failure', oRes.ok === false && /injected failure/.test(oRes.error || ''));
ok('O: ignored local manifest survives failed pull byte-exact', fs.readFileSync(o.manifest).equals(oBytes));

console.log('\nP. ignored manifest collision during moveTo');
const p = ignoredManifestSandbox('ignored-move');
const pMod = requireFresh(path.join(p.work, 'tools/git-pull-safe.js'));
const oldSha = run(p.work, 'rev-parse', 'HEAD').trim();
fs.writeFileSync(path.join(p.work, 'routing/api-gateway.json'), '{"tracked":"new"}\n');
run(p.work, 'add', '-f', 'routing/api-gateway.json'); run(p.work, 'commit', '-m', 'track manifest locally');
const pNewSha = run(p.work, 'rev-parse', 'HEAD').trim();
const pBytes = Buffer.from([0x00, 0xff, 0x7b, 0x7d, 0x0d, 0x0a]);
fs.writeFileSync(p.manifest, pBytes);
const pBack = pMod.moveTo(oldSha);
ok('P: moveTo revision without tracked manifest succeeds', pBack.ok === true);
ok('P: moveTo restores ignored manifest byte-exact', fs.readFileSync(p.manifest).equals(pBytes));
const pForward = pMod.moveTo(pNewSha);
ok('P: moveTo revision tracking manifest succeeds', pForward.ok === true);
ok('P: moveTo keeps ignored manifest byte-exact', fs.readFileSync(p.manifest).equals(pBytes));

console.log('\nQ. API Gateway writer lock serializes update and manifest saves');
const q = ignoredManifestSandbox('writer-lock');
const qBytes = Buffer.from('{"owner":"before-update"}\r\n', 'utf8');
fs.writeFileSync(q.manifest, qBytes);
fs.writeFileSync(path.join(q.seed, 'code.js'), 'v2\n');
run(q.seed, 'add', 'code.js'); run(q.seed, 'commit', '-m', 'update under lock'); run(q.seed, 'push', 'origin', 'master');
const qLock = `${q.manifest}.lock`;
fs.writeFileSync(qLock, String(process.pid), 'utf8');
const qBlocked = cli(q.work);
ok('Q: live API Gateway writer lock blocks git update', qBlocked.code !== 0 && /busy|lock|занят/i.test(qBlocked.out));
ok('Q: blocked update leaves code unchanged', fs.readFileSync(path.join(q.work, 'code.js'), 'utf8').trim() === 'v1');
ok('Q: blocked update leaves local manifest byte-exact', fs.readFileSync(q.manifest).equals(qBytes));
fs.unlinkSync(qLock);
const qMarker = path.join(q.work, '.git', 'api-gateway-lock-seen');
const qHook = path.join(q.work, '.git', 'hooks', 'post-merge');
fs.writeFileSync(qHook, '#!/bin/sh\nif test -f routing/api-gateway.json.lock; then printf yes > .git/api-gateway-lock-seen; else printf no > .git/api-gateway-lock-seen; fi\n');
fs.chmodSync(qHook, 0o755);
const qUpdated = cli(q.work);
ok('Q: update succeeds after the live writer releases the lock', qUpdated.code === 0);
ok('Q: updater holds the shared API Gateway lock during git pull',
   fs.existsSync(qMarker) && fs.readFileSync(qMarker, 'utf8') === 'yes');
ok('Q: successful update still preserves local manifest byte-exact', fs.readFileSync(q.manifest).equals(qBytes));

console.log('\nR. absent local manifest is never imported from upstream');
const rCase = ignoredManifestSandbox('absent-manifest');
fs.writeFileSync(path.join(rCase.seed, 'code.js'), 'v2\n');
fs.writeFileSync(path.join(rCase.seed, 'routing/api-gateway.json'), '{"upstream":"must-not-become-owner-state"}\n');
run(rCase.seed, 'add', 'code.js'); run(rCase.seed, 'add', '-f', 'routing/api-gateway.json');
run(rCase.seed, 'commit', '-m', 'upstream mistakenly tracks local state'); run(rCase.seed, 'push', 'origin', 'master');
const rRes = cli(rCase.work);
ok('R: update with newly tracked local manifest path succeeds', rRes.code === 0);
ok('R: unrelated code still updates', fs.readFileSync(path.join(rCase.work, 'code.js'), 'utf8').trim() === 'v2');
ok('R: upstream local manifest is removed so first run seeds from default', !fs.existsSync(rCase.manifest));

console.log('\nS. update never restores an old snapshot over an unexpected concurrent edit');
const sOwner = Buffer.from('{"owner":"seeded-after-update"}\r\n', 'utf8');
const sExternal = '{"external":"newer-writer-wins"}\n';
fs.writeFileSync(rCase.manifest, sOwner);
fs.writeFileSync(path.join(rCase.seed, 'code.js'), 'v3\n');
run(rCase.seed, 'add', 'code.js'); run(rCase.seed, 'commit', '-m', 'second update'); run(rCase.seed, 'push', 'origin', 'master');
const sHook = path.join(rCase.work, '.git', 'hooks', 'post-merge');
fs.writeFileSync(sHook, '#!/bin/sh\nprintf \'%s\\n\' \'{"external":"newer-writer-wins"}\' > routing/api-gateway.json\n');
fs.chmodSync(sHook, 0o755);
const sRes = cli(rCase.work);
ok('S: ambiguous concurrent manifest edit makes update report failure', sRes.code !== 0 && /параллельно|восстанов/i.test(sRes.out));
ok('S: updater never overwrites the unexpected newer bytes with its old snapshot',
   fs.readFileSync(rCase.manifest, 'utf8') === sExternal);

console.log('\nU. next update recovers a crash after git pull but before owner-state restore');
const u = ignoredManifestSandbox('crash-after-pull');
const uOwner = Buffer.from('{"owner":"survives-process-crash"}\r\n', 'utf8');
fs.writeFileSync(u.manifest, uOwner);
fs.writeFileSync(path.join(u.seed, 'code.js'), 'v2\n');
fs.writeFileSync(path.join(u.seed, 'routing/api-gateway.json'), '{"upstream":"temporary"}\n');
run(u.seed, 'add', 'code.js'); run(u.seed, 'add', '-f', 'routing/api-gateway.json');
run(u.seed, 'commit', '-m', 'update before injected crash'); run(u.seed, 'push', 'origin', 'master');
const uScript = `
  const fs = require('node:fs');
  const cp = require('node:child_process');
  const path = require('node:path');
  const work = ${JSON.stringify(u.work)};
  const manifest = path.join(work, 'routing/api-gateway.json');
  const lib = require(path.join(work, 'routing/lib/api-gateway.js'));
  lib.acquireManifestLock(manifest + '.lock');
  lib.beginManifestUpdateOverlayLocked({ manifestPath: manifest });
  fs.unlinkSync(manifest);
  cp.execFileSync('git', ['pull', '--ff-only', '--no-edit'], { cwd: work, stdio: 'ignore' });
  process.exit(57);
`;
const uCrash = require('child_process').spawnSync(process.execPath, ['-e', uScript], { encoding: 'utf8' });
ok('U: fixture crashed after pull at the intended boundary', uCrash.status === 57);
ok('U: crash left upstream manifest plus durable overlay journal',
   /temporary/.test(fs.readFileSync(u.manifest, 'utf8')) && fs.existsSync(`${u.manifest}.update-txn`));
const uRecovered = cli(u.work);
ok('U: next updater run recovers and succeeds', uRecovered.code === 0);
ok('U: owner manifest is restored byte-exact after process crash', fs.readFileSync(u.manifest).equals(uOwner));
ok('U: durable update journal and stale lock are cleared',
   !fs.existsSync(`${u.manifest}.update-txn`) && !fs.existsSync(`${u.manifest}.lock`));

fs.rmSync(root, { recursive: true, force: true });
