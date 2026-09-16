'use strict';

// Регресс на вердикт про ЛОГИН у аккаунтов AgentRouter (решение владельца 14.09).
//
// История: после залпа подарков 13.09 владелец сказал «кучу аккаунтов просто разлогинилось,
// а баланс не актуальный — заранее видно, есть логин или нет?». Проверить заранее нечем:
// куки-пруфа `acw_sc__v2` нет ни у одного аккаунта, и любой HTTP-запрос к `/api/user/self`
// отбивается WAF'ом НЕЗАВИСИМО от того, жив логин или нет (живой замер: пауза доросла
// 45с → 555с за семь аккаунтов, прогон остановлен вручную).
//
// Поэтому ответ — не проверка наперёд, а честный вердикт в таблице. Контракт, который
// проверяется здесь:
//   1) отказ `accountSelf` несёт машинное поле `failureKind`, а не только текст;
//   2) `login_dead` (401/403) и `no_proof` (WAF без пруфа) — РАЗНЫЕ виды. Это главное:
//      401 значит «разлогинен», WAF значит «про логин не знаем ничего»;
//   3) набор видов закрытый — новая ветка отказа не должна молча стать `other`;
//   4) вид доживает до записи пула (`selfFailureKind`), иначе вердикт живёт до первого F5;
//   5) успешный чек снимает вид, иначе аккаунт навсегда останется «разлогиненным».
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (condition) console.log(`ok ${checks} - ${message}`);
  else { failures += 1; console.error(`not ok ${checks} - ${message}`); }
}

const lib = require(path.join(ROOT, 'routing/lib/newapi-account.js'));
const proxyText = fs.readFileSync(path.join(ROOT, 'routing/transparent-proxy.js'), 'utf8');
const dashText = fs.readFileSync(path.join(ROOT, 'routing/proxy-dashboard.html'), 'utf8');

// ── 1. Контракт модуля ──
check(typeof lib.classifySelfFailure === 'function', 'lib экспортирует classifySelfFailure');
check(Array.isArray(lib.SELF_FAILURE_KINDS), 'lib экспортирует SELF_FAILURE_KINDS');
check(lib.SELF_FAILURE_KINDS.length >= 8, 'видов отказа не меньше восьми');

// ── 2. Живые тексты отказов → правильный вид ──
// Тексты взяты из кода дословно: тест обязан ломаться, если формулировку поменяют,
// не поправив классификатор.
const CASES = [
  ['сессия профиля недействительна (HTTP 401)', 'login_dead'],
  ['сессия профиля недействительна (HTTP 403)', 'login_dead'],
  ['сессия профиля истекла — открой ЛК аккаунта, чтобы обновить', 'login_expired'],
  ['WAF просит JS-челлендж, а пруфа (acw_sc__v2) у нас нет: открой ЛК кнопкой 🌐 или ⚡ — браузер добудет куку. Пауза 10 мин', 'no_proof'],
  ['WAF отбил запрос даже с пруфом (acw_sc__v2) — пауза 10 мин', 'waf'],
  ['слишком часто (429), пауза 10 мин', 'rate_limited'],
  ['нет профиля с куками', 'no_profile'],
  ['профиль не найден на диске', 'no_profile'],
  ['профиля аккаунта нет — открой ЛК кнопкой 🌐 и войди, тогда баланс станет точным', 'no_profile'],
  ['браузер этого аккаунта ОТКРЫТ — Chromium запер куки, а нашу копию сессии он уже прокрутил. Закрой окно ЛК и повтори чек — цифра станет точной', 'browser_open'],
  ['не удалось определить New-Api-User id', 'no_uid'],
  ['шлюз отбивает по частоте, пауза ещё 555с', 'deferred'],
  ['fetch failed', 'transport'],
  ['self: HTTP 502', 'other'],
];
for (const [text, want] of CASES) {
  const got = lib.classifySelfFailure({ error: text });
  check(got === want, `«${text.slice(0, 46)}…» → ${want} (получено ${got})`);
}

// ── 3. Главное различие: разлогин против неизвестности ──
// Если эти два когда-нибудь схлопнутся, таблица снова начнёт врать в самую дорогую сторону:
// владелец пойдёт жать ⚡ на аккаунт, который на самом деле разлогинен.
const dead = lib.classifySelfFailure({ error: 'сессия профиля недействительна (HTTP 401)' });
const blind = lib.classifySelfFailure({ error: 'WAF просит JS-челлендж, а пруфа (acw_sc__v2) у нас нет: пауза 10 мин' });
check(dead !== blind, '401 и «WAF без пруфа» — разные виды, а не один');
check(dead === 'login_dead' && blind === 'no_proof', 'и это именно login_dead против no_proof');

// ── 4. Каждый объявленный вид достижим и вид не выпадает из набора ──
const reached = new Set(CASES.map(([t]) => lib.classifySelfFailure({ error: t })));
for (const v of reached) {
  check(lib.SELF_FAILURE_KINDS.includes(v), `вид «${v}» объявлен в SELF_FAILURE_KINDS`);
}
check(lib.SELF_FAILURE_KINDS.includes('login_dead'), 'login_dead входит в закрытый набор');

// ── 5. Поведение без сети: ветку отказа видно на реальном вызове ──
(async () => {
  const noDir = path.join(os.tmpdir(), 'ar-login-verdict-definitely-missing');
  const res = await lib.accountSelf({ host: 'agentrouter.org', profileDir: noDir });
  check(res && res.ok === false, 'accountSelf без профиля отвечает отказом');
  check(res && res.failureKind === 'no_profile', `и помечает его no_profile (получено ${res && res.failureKind})`);
  check(res && typeof res.error === 'string' && res.error.length > 0, 'текстовую причину тоже отдаёт');

  // ── 6. Персистентность и снятие в дашборде ──
  check(/target\.selfFailureKind = bal\.selfFailureKind/.test(proxyText), 'дашборд пишет вид отказа в запись пула');
  // 🪤 Здесь стояла буквальная редакция `seen && !bal.selfCached) delete target.selfFailureKind`
  // — ровно тот же класс, что уже ловили в этом файле (пин на текст благословляет баг).
  // Смысл утверждения: удачный чек снимает вид отказа, а снятие различает два рода вердиктов —
  // «ответа не было» (`no_proof`, `deferred`, WAF) и утверждение о самом входе (`login_dead`).
  // Второй род стирать по молчанию нельзя: аккаунт с доказанным 401 обязан остаться помеченным.
  check(/delete target\.selfFailureKind/.test(proxyText), 'успешный чек снимает вид отказа');
  check(/AR_LOGIN_KINDS/.test(proxyText) && /selfStale/.test(proxyText),
      'снятие различает «ответа не было» и утверждение о входе');
  check(/noteSelfFailure/.test(proxyText), 'ветки без модуля размечают вид через noteSelfFailure');

  // ── 7. Фронт: значок и счётчик ──
  check(/function loginVerdictMark\(s\)/.test(dashText), 'панель имеет loginVerdictMark');
  check(/\$\{loginVerdictMark\(s\)\}/.test(dashText), 'значок подключён к строке аккаунта');
  check(/s\.selfFailureKind === 'login_dead'/.test(dashText), 'подвал считает разлогиненных по login_dead');
  check(/logoutKeys/.test(dashText), 'счётчик разлогиненных выведен в подвал');

  // ── 8. Цвет значков существует в теме, иначе метка отрисуется невидимой ──
  // 🪤 Живая находка 14.09: `sky` в теме нет (есть `azure`), а `text-sky` в файле встречается.
  // Проверяем ровно те цвета, что стоят в карте вердикта.
  const verdictMap = dashText.match(/function loginVerdictMark\(s\) \{[\s\S]*?\n\}/);
  const colors = [...new Set([...String(verdictMap).matchAll(/'(crimson|amber|azure|emerald|faint|rose|teal|violet|cyan|dim)'/g)].map(m => m[1]))];
  check(colors.length > 0, 'в карте вердикта вообще есть цвета');
  for (const c of colors) {
    check(dashText.includes(`--color-${c}:`), `цвет «${c}» объявлен в теме панели`);
  }

  // ── 9. Свежий вход перебивает вердикт чека (заявка 15.09) ──
  // «Пишет, что акк разлогинен, хотя по факту вход выполнен, статус не меняется». Плашка
  // гасла только успешным чеком, а его не было ни у одного аккаунта пула. Теперь вход в ЛК
  // ПОСЛЕ показанной цифры смягчает вердикт до «не переспрошен» — не объявляет вход живым,
  // но и не объявляет мёртвым.
  check(/relogin_unverified/.test(proxyText), 'дашборд умеет смягчать вердикт после входа');
  // 🪤 Здесь стояло `prof.label || target.profile` — буква в букву то, что в бою роняло
  // запись баланса (`ReferenceError: prof is not defined`: переменная из newapiBalance,
  // в newapiApplyBalance её нет). Утверждение пинило текст, а не смысл, и потому зелёным
  // пропускало падение. Смысл — «отметка визита в ЛК, а не память процесса»; проверяем его.
  check(/newapiLkOpenedAt\(target\.profile\)/.test(proxyText),
    'смягчение опирается на отметку визита в ЛК, а не на память процесса');
  check(/lkAt > figureMs/.test(proxyText), 'условие именно «вход БЫЛ ПОСЛЕ цифры»');
  check(/relogin_unverified/.test(dashText), 'панель знает вид relogin_unverified');
  const reloginMap = /relogin_unverified:\s*\['([^']+)',\s*'([^']+)',\s*'([^']+)'/.exec(dashText);
  check(!!reloginMap, 'вид relogin_unverified отрисован в карте вердикта');
  if (reloginMap) {
    check(reloginMap[3] !== 'crimson', 'и он НЕ красный — это «не подтверждено», а не «разлогинен»');
    check(!/разлогинен/.test(reloginMap[2]), `подпись не пугает разлогином (сейчас «${reloginMap[2]}»)`);
  }
  // Счётчик разлогиненных обязан считать только доказанные 401, иначе смягчённые записи
  // вернутся в пугающее число.
  const logoutLine = /if \(s\.selfFailureKind === '([^']+)' \|\| s\.selfFailureKind === '([^']+)'\) logoutKeys\+\+;/.exec(dashText);
  check(!!logoutLine, 'счётчик разлогиненных считает по видам');
  if (logoutLine) {
    check(logoutLine[1] === 'login_dead' && logoutLine[2] === 'login_expired',
      'в счётчик разлогиненных входят только login_dead и login_expired');
    check(!/relogin_unverified/.test(logoutLine[0]), 'смягчённый вид в него НЕ входит');
  }
  check(lib.SELF_FAILURE_KINDS.includes('relogin_unverified'), 'relogin_unverified в закрытом наборе видов');
  check(lib.classifySelfFailure({ error: 'вход выполнялся после этой цифры (браузер), а переспросить шлюз не удалось' })
    === 'relogin_unverified', 'текст смягчённого вердикта опознаётся классификатором');

  // ── 10. Маркер свежести читает возраст ЦИФРЫ, а не момент чека ──
  // Замер 15.09 после ребута: 22 записи из 33 имели `balanceCheckedAt` СТАРШЕ `selfCheckedAt`,
  // и разрыв рос там, где цифра старее (`exhaustedar`: проверка 4.7 ч, цифра 73.8 ч; обратных
  // случаев ноль). То есть `balanceCheckedAt` честно значит «когда мы ходили проверять», и
  // врал не он, а метка, читавшая не то поле. `exhaustedar` показывался как «обновлено 12с назад».
  check(/const ts = s && \(s\.selfCheckedAt \|\| s\.balanceCheckedAt\)/.test(dashText),
    'маркер свежести берёт дату ЦИФРЫ (selfCheckedAt), а не момент чека');
  // 🪤 Обратная правка уже была ошибкой: она переписала бы `balanceCheckedAt` датой цифры,
  // и тогда ветвь `reused` (цифра подтверждена замером расхода, но selfCheckedAt прежний)
  // выглядела бы непроверенной. Проверяем, что этого соблазна в коде нет.
  check(!/target\.balanceCheckedAt = figureAt/.test(proxyText),
    'balanceCheckedAt НЕ переписан датой цифры (это ломало бы ветвь reused)');  check(/target\.balanceCheckedAt = new Date\(\)\.toISOString\(\);/.test(proxyText),
    'balanceCheckedAt остался отметкой «когда ходили проверять»');
  // Подпись метки не должна обещать обновление, которого не будет. Ищем фразу именно в
  // `title=`, а не в комментариях: комментарий, объясняющий старую ошибку, — это не ошибка.
  check(!/title="[^"]*статус-бар обновит/.test(dashText),
    'подпись маркера не обещает обновление статус-баром');

  // ── 11. Признак входа должен быть прочным и сравниваться с датой цифры ──
  // Две редакции правки подряд срабатывали на 2 и 3 записях из 27, и обе — из-за признака,
  // а не из-за логики. Проверяем то, что их починило.
  //
  // (а) Признаков входа ДВА: отметка визита в ЛК зовётся ручными путями (🌐, клик по цифре),
  //     а залп чек-инов входит в тот же аккаунт мимо неё — и по отметке такие входы не видны.
  check(/target\.checkinAt \? Date\.parse\(target\.checkinAt\) : 0/.test(proxyText),
    'вход опознаётся и по чек-ину, а не только по отметке визита в ЛК');
  check(/const lkAt = Math\.max\(/.test(proxyText), 'источники входа объединяются через max');
  // (б) Сравнение обязано идти с датой ЦИФРЫ: `balanceCheckedAt` обновляется на каждом
  //     прогоне, а прогоны идут постоянно — вход почти всегда «старше последнего прогона»,
  //     и условие молча не срабатывало (замер: 3 записи вместо 24).
  check(/const figureMs = target\.selfCheckedAt \? Date\.parse\(target\.selfCheckedAt\) : 0;/.test(proxyText),
    'сравнение идёт с датой цифры (selfCheckedAt), а не с моментом прогона');
  check(!/const figureMs = target\.balanceCheckedAt/.test(proxyText),
    'и не с balanceCheckedAt — иначе смягчение не срабатывает');
  // (в) Успешный чек-ин обязан сохранить отметку входа на диск: файловый признак переживает
  //     рестарт, а карта в памяти — нет (это и был зазор: окно закрылось, чек упал через 6 с).
  check(/newapiLkVisited\(label\);\n        \}/.test(proxyText) || /newapiLkVisited\(label\);/.test(proxyText),
    'успешный чек-ин сохраняет отметку входа');
  check(/checkedIn === true/.test(proxyText), 'и делает это именно по факту состоявшегося входа');

  console.log(`\n${checks} проверок, ${failures} провалов`);
  process.exit(failures ? 1 : 0);
})();
