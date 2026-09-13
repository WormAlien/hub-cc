#!/usr/bin/env node
'use strict';
/**
 * Живая проба «первое открытие Лиги»: что видно в первые 0,5 / 1 / 2 с.
 *
 * Живой :8200 НЕ перезапускается — HTML читается с диска на каждый запрос, поэтому
 * правки видны по F5. Срез (/__switch/api/league) уже прогрет в памяти хаба и отвечает
 * за 13 мс, а жалоба владельца про холодный случай (~630 мс ожидания). Поэтому задержку
 * подставляем САМИ через page.route — замер становится воспроизводимым и не зависит от
 * того, прогрет ли журнал.
 *
 * Firefox, а не chromium: chromium headless на этой машине падает на графике лиги.
 * Вьюпорт 1920×1080 — как у владельца.
 *
 * Запуск: node .tmp-split/probe-league-first-open.js [задержка_мс]
 */
const { firefox } = require('playwright');

const DELAY = Number(process.argv[2] || 1500);
// 🪤 Не `URL`: имя затенило бы глобальный конструктор, а он нужен в матчере маршрута.
const DASH = 'http://localhost:8200/__switch';
// Точки замера. 0 — сразу после domcontentloaded, дальше как в брифе владельца.
const MARKS = [0, 250, 500, 1000, 2000, 3000, 4500, 6000, 9000];

// Кэш ленты в том же виде, в каком его пишет lgCacheSave: gid — 32 hex (LGC_GID_RE),
// seq > 0 (иначе lgCacheRestore отфильтрует), recvAt — ISO.
// 🪤 gid должен быть НАСТОЯЩИЙ (взят из GET /__switch/api/league/me): буфер лежит на
// группу, активной становится та, что приедет из /me, — и кэш под выдуманным ключом
// восстановится, но останется невидимым, потому что смотрим мы в другую группу.
const GID = '954ff83ca13ecca8668aa1dbe8ce53cb';
const now = Date.now();
const feedCache = {
  at: now,
  gid: GID,
  nick: 'WormAlien',
  groups: {
    [GID]: {
      seq: 42, gseq: 7, firstSeq: 1, title: 'Общий', gone: false,
      msgs: [1, 2, 3, 4, 5].map(i => ({
        seq: 37 + i, installId: 'probe-peer', nick: 'сосед',
        recvAt: new Date(now - (6 - i) * 60000).toISOString(),
        text: 'сообщение из кэша ' + i,
      })),
    },
  },
};

(async () => {
  const browser = await firefox.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();

  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  // Сетевые события по срезу: когда ушёл запрос и когда пришёл ответ. Нужно, чтобы
  // отличать «страница не рисует» от «данные ещё не приехали».
  const net = [];
  const isSlice = u => { try { return new URL(u).pathname === '/__switch/api/league'; } catch (e) { return false; } };
  page.on('request', r => { if (isSlice(r.url())) net.push(['→ запрос среза', Date.now()]); });
  page.on('response', r => { if (isSlice(r.url())) net.push([`← ответ среза ${r.status()}`, Date.now()]); });
  page.on('requestfailed', r => { if (isSlice(r.url())) net.push([`× срез упал: ${r.failure()?.errorText}`, Date.now()]); });

  await page.addInitScript(([tab, cache, gid]) => {
    localStorage.setItem('opencode_active_tab', tab);
    localStorage.setItem('abusehub-league-feed', cache);
    localStorage.setItem('abusehub-league-gid', gid);
  }, ['league', JSON.stringify(feedCache), GID]);

  // Тормозим ВСЕ ручки лиги, не только срез. Иначе кэш не отличить от сети: лента может
  // приехать первым же тиком опроса, и «кэш нарисовался раньше» станет недоказуемым.
  // С одинаковой задержкой единственный источник строк в первом кадре — localStorage.
  await page.route(u => { try { return new URL(u).pathname.startsWith('/__switch/api/league'); } catch (e) { return false; } },
    async route => { await new Promise(r => setTimeout(r, DELAY)); await route.continue(); });

  // Точные моменты появления — вот что сравнивается ДО/ПОСЛЕ. Замер по фиксированным
  // точкам шумит: сам срез читает журналы, и его время плавает от прогона к прогону.
  // Здесь же мы ловим САМ ФАКТ и время: появилась оболочка, появилась первая строка
  // ленты и — важно — кэш это или уже сеть.
  await page.addInitScript(() => {
    window.__lgT = { nav: performance.now(), shell: 0, feed: 0, feedSrc: '', firstMsg: '' };
    const watch = () => {
      const T = window.__lgT;
      if (!T.shell && document.getElementById('lg-lede')) T.shell = performance.now();
      const feed = document.getElementById('lg-feed');
      if (feed && !T.feed) {
        const rows = feed.querySelectorAll('.lgmsg');
        if (rows.length) {
          T.feed = performance.now();
          T.hasCache = !!feed.querySelector('.lgmsg') && /сообщение из кэша/.test(feed.textContent || '');
          T.feedSrc = T.hasCache ? 'кэш localStorage' : 'сеть';
          T.firstMsg = (feed.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
        }
      }
      requestAnimationFrame(watch);
    };
    // Начинаем следить сразу: оболочка может появиться до того, как отработает
    // DOMContentLoaded-хендлер, если скрипт вкладки уже разобран.
    watch();
  });

  const t0 = Date.now();
  await page.goto(DASH, { waitUntil: 'domcontentloaded' });

  // Что именно мерим. Не «на глаз», а числами: высота вкладки, сколько в ней узлов,
  // есть ли каркас (оболочка LG_SHELL), есть ли лента чата и сколько в ней строк.
  const sample = () => page.evaluate(() => {
    const h = document.getElementById('leagueTab');
    const feed = document.getElementById('lg-feed');
    const plot = document.getElementById('lg-plot');
    const txt = (h ? h.textContent : '').replace(/\s+/g, ' ').trim();
    return {
      height: h ? h.clientHeight : -1,
      nodes: h ? h.querySelectorAll('*').length : -1,
      shell: !!document.getElementById('lg-lede'),
      head: !!h && /Лига ABUSE HUB/.test(txt),
      plot: !!plot, plotSvg: !!(plot && plot.querySelector('svg')),
      plotH: plot ? plot.clientHeight : -1,
      tiles: document.querySelectorAll('#lg-tiles > *').length,
      rows: document.querySelectorAll('#lg-list > *').length,
      feed: !!feed, msgs: feed ? feed.querySelectorAll('.lgmsg').length : -1,
      feedH: feed ? feed.clientHeight : -1,
      // Первый текст ленты: по нему видно, кэш это («сообщение из кэша 1») или уже сеть.
      first: feed ? (feed.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '',
      skel: document.querySelectorAll('#leagueTab .lgskel').length,
      // Состояние модуля: отличает «данные не приехали» от «приехали, а не нарисовано».
      lg: typeof LG === 'undefined' ? 'нет LG' : {
        data: !!LG.data, loading: !!LG.loading, err: LG.err || null,
        hash: String(LG._lastHash || '').slice(0, 40),
      },
      lgc: typeof LGC === 'undefined' ? 'нет LGC' : { booted: !!LGC.booted, msgs: (LGC.msgs || []).length },
      active: !!document.querySelector('[data-tab-content="league"]')?.classList.contains('active'),
      text: txt.slice(0, 150),
    };
  });

  const out = [];
  for (const ms of MARKS) {
    const wait = t0 + ms - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const s = await sample();
    s.at = Date.now() - t0;
    out.push(s);
    console.log(`\n── ${s.at} мс ─────────────────────────────`);
    console.log(`  высота вкладки : ${s.height} px`);
    console.log(`  узлов в DOM    : ${s.nodes}`);
    console.log(`  оболочка/шапка : ${s.shell ? 'да' : 'НЕТ'} / ${s.head ? 'да' : 'НЕТ'}`);
    console.log(`  график         : ${s.plot ? 'контейнер есть' : 'НЕТ'}, svg ${s.plotSvg ? 'есть' : 'нет'}, h=${s.plotH}`);
    console.log(`  плиток/строк   : ${s.tiles} / ${s.rows}`);
    console.log(`  лента чата     : ${s.feed ? 'есть' : 'НЕТ'}, сообщений ${s.msgs}, h=${s.feedH}`);
    console.log(`  скелет         : ${s.skel} узлов`);
    console.log(`  LG             : ${JSON.stringify(s.lg)}`);
    console.log(`  LGC            : ${JSON.stringify(s.lgc)}, вкладка активна: ${s.active ? 'да' : 'НЕТ'}`);
    console.log(`  текст          : ${JSON.stringify(s.text)}`);
  }

  console.log('\nточные моменты появления (от начала навигации):');
  const T = await page.evaluate(() => {
    const t = window.__lgT || {};
    const nav = t.nav || 0;
    return { shell: t.shell ? Math.round(t.shell - nav) : -1,
      feed: t.feed ? Math.round(t.feed - nav) : -1,
      feedSrc: t.feedSrc || '—', firstMsg: t.firstMsg || '' };
  });
  console.log(`  оболочка вкладки : ${T.shell < 0 ? 'не появилась' : T.shell + ' мс'}`);
  console.log(`  первая строка чата: ${T.feed < 0 ? 'не появилась' : T.feed + ' мс'} (источник: ${T.feedSrc})`);
  if (T.firstMsg) console.log(`  текст первой      : ${JSON.stringify(T.firstMsg)}`);

  console.log('\nсетевые события по срезу:');
  if (!net.length) console.log('  (ни одного запроса к /__switch/api/league)');
  net.forEach(([what, at]) => console.log(`  ${String(at - t0).padStart(5)} мс  ${what}`));

  if (errs.length) { console.log('\nошибки страницы:'); errs.slice(0, 10).forEach(e => console.log('  ' + e)); }
  else console.log('\nошибок страницы нет');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
