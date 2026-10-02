// dacall/live-record.js
//
// РУЧНАЯ запись: открывается ВИДИМОЕ окно браузера, владелец кликает сам (регистрация,
// создание ключа), а скрипт пишет всё, что при этом летит по сети — из этого снимается
// контракт для автореги. Ничего не нажимает за человека.
//
// Запуск:  node dacall/live-record.js
// Выход:   dacall/artifacts/manual-<штамп>/
//            net.jsonl    — каждый запрос к панели (метод, URL, тело, статус, ответ)
//            trace.har    — полный HAR (пишется при закрытии окна)
//            video/       — видео обеих вкладок
//            mailbox.txt  — почта, которую скрипт завёл заранее
//
// Окно живёт, пока владелец его не закроет. Закрыл — скрипт дописывает HAR и печатает
// сводку: какие ручки панели были задеты и в каком порядке.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const emailnator = require('../freemodel/lib/emailnator');

const stamp = new Date().toLocaleString('sv').slice(0, 19).replace(/[: ]/g, '-');
const OUT = path.join(__dirname, 'artifacts', 'manual-' + stamp);
const PROFILE = path.join(__dirname, 'profiles', 'manual');
const VIDEO_DIR = path.join(OUT, 'video');
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const NET = fs.createWriteStream(path.join(OUT, 'net.jsonl'), { flags: 'a' });
const seen = [];

function log(...a) {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  fs.appendFileSync(path.join(OUT, 'run.log'), line + '\n', 'utf-8');
}

// Что считаем «ручкой панели»: всё, что уходит на её API и на /v1 (инференс ключа).
const isApi = (u) => /\/api\/v1\/|dacall\.ai\/v1\//.test(u);

async function main() {
  log('=== ручная запись dacall.AI ===', stamp);
  log('артефакты:', OUT);

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: null,                                   // окно тянется, не заперто в 1280x800
    args: ['--window-size=1200,950', '--start-maximized'],
    locale: 'ru-RU',
    recordVideo: { dir: VIDEO_DIR, size: { width: 1200, height: 900 } },
    recordHar: { path: path.join(OUT, 'trace.har'), content: 'embed' },
  });
  context.setDefaultTimeout(30000);

  // Сеть: пишем запрос и ответ на каждую ручку панели.
  context.on('request', req => {
    if (!isApi(req.url())) return;
    const rec = {
      t: new Date().toISOString().slice(11, 19),
      phase: 'req',
      method: req.method(),
      url: req.url(),
      body: (() => { try { return req.postData() || null; } catch { return null; } })(),
    };
    seen.push(req.method() + ' ' + req.url().replace(/^https?:\/\/[^/]+/, ''));
    NET.write(JSON.stringify(rec) + '\n');
    log('  →', rec.method, rec.url.replace(/^https?:\/\/[^/]+/, ''));
    if (rec.body) log('      body:', rec.body.slice(0, 400));
  });
  context.on('response', async res => {
    if (!isApi(res.url())) return;
    let body = null;
    try { body = (await res.text()).slice(0, 2000); } catch { /* тело могло не прийти */ }
    NET.write(JSON.stringify({
      t: new Date().toISOString().slice(11, 19),
      phase: 'res', status: res.status(), url: res.url(), body,
    }) + '\n');
    log('  ←', res.status(), res.url().replace(/^https?:\/\/[^/]+/, ''), body ? '| ' + body.replace(/\s+/g, ' ').slice(0, 220) : '');
  });

  // Вкладка 1: ящик. Заводим заранее, чтобы владельцу осталось только вставить адрес.
  const mail = await context.newPage();
  let email = null;
  try {
    email = await emailnator.createEmail(mail);
    log('=== ПОЧТА:', email);
    log('    (ящик открыт в первой вкладке, код придёт туда)');
    fs.writeFileSync(path.join(OUT, 'mailbox.txt'), email + '\n', 'utf-8');
    fs.writeFileSync(path.join(__dirname, 'last-mailbox.txt'), email + '\n', 'utf-8');
  } catch (e) {
    log('⚠️ ящик не завёлся:', e.message);
  }

  // Вкладка 2: страница регистрации dacall.
  const site = await context.newPage();
  await site.goto('https://ru.dacall.ai/register', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await site.bringToFront();

  log('');
  log('>>> ОКНО ОТКРЫТО. Кликай руками: регистрация → создание ключа.');
  log('>>> Почта для регистрации:', email || '(смотри первую вкладку)');
  log('>>> Когда закончишь — просто закрой окно браузера.');

  await new Promise(resolve => context.on('close', resolve));
  NET.end();
  await new Promise(r => setTimeout(r, 1500));

  log('');
  log('=== ИТОГ: ручки панели, которых касались ===');
  const uniq = [...new Set(seen)];
  uniq.forEach(u => log('   ' + u));
  log('записано запросов:', seen.length, '· файл:', path.join(OUT, 'net.jsonl'));
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
