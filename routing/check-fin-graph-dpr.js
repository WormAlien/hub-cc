#!/usr/bin/env node
// check-fin-graph-dpr.js — геометрия графа вкладки «Финансы» на разных масштабах.
//
// Граф рисуется на canvas во весь экран: атрибуты `width/height` ставятся в
// `innerWidth × DPR`, а рисование идёт через `ctx.setTransform(DPR, …)`. Значит
// элемент обязан занимать на экране ровно `innerWidth × innerHeight` CSS-пикселей.
// Canvas — replaced-элемент: без явного CSS-размера он разворачивается до
// интринсик-размера, то есть до `innerWidth × DPR`, и всё нарисованное встаёт
// в `DPR` раз дальше от левого верхнего угла. При DPR = 1 это незаметно, при
// 125/150 % облако уезжает от своей фигуры.
//
//   node routing/check-fin-graph-dpr.js
//
// Нужен живой дашборд на :8200 и Chromium из кеша puppeteer (путь — CHROME_PATH).
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DASH = process.env.DASH_URL || 'http://localhost:8200/';
const CHROME = process.env.CHROME_PATH
  || 'C:\\Users\\WormAlien\\.cache\\puppeteer\\chrome\\win64-148.0.7778.97\\chrome-win64\\chrome.exe';
const PORT = +(process.env.CDP_PORT || 9341);

// Ширины, на которых живёт владелец, и масштабы: 100 % — «эталон», 125/150 % —
// виндовое масштабирование и зум браузера.
const SIZES = [
  { w: 2560, h: 1440, dpr: 1 },
  { w: 1920, h: 1080, dpr: 1 },
  { w: 1920, h: 1080, dpr: 1.25 },
  { w: 1536, h: 864, dpr: 1.25 },
  { w: 1536, h: 864, dpr: 1.5 },
  { w: 1366, h: 768, dpr: 1 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find(t => t.type === 'page');
      if (p) return p;
    } catch {}
    await sleep(150);
  }
  throw new Error('CDP не поднялся на порту ' + PORT);
}

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pend = new Map(); }
  ready() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('не открылся WebSocket CDP'));
      this.ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pend.has(m.id)) {
          const p = this.pend.get(m.id); this.pend.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pend.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

// Замер: место фигуры на экране, «намеренные» координаты облака из graph.points()
// и то, где облако окажется на самом деле. Отображение canvas масштабирует
// координаты в `clientWidth / layer.w` раз — именно там и живёт дефект.
const GEOM = `(() => {
  const q = s => document.querySelector(s);
  const rect = el => { const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, w: b.width, h: b.height }; };
  const cv = q('#cGraph'), anchor = q('#wFire'), scene = q('.scene');
  const g = window.__fig && window.__fig.graph;
  if (!cv || !anchor || !g) return { err: 'нет #cGraph/#wFire/__fig.graph' };
  const st = g.state(), pts = g.points();
  const xs = pts.map(p => p.sx), ys = pts.map(p => p.sy);
  const a = rect(anchor), c = rect(cv), s = rect(scene);
  return {
    dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight,
    canvas: { cssW: c.w, cssH: c.h, scaleX: c.w / st.layer.w, scaleY: c.h / st.layer.h },
    anchor: { cx: a.l + a.w / 2, cy: a.t + a.h / 2, w: a.w },
    scene: { l: s.l, w: s.w },
    cloud: { n: st.n, cx: (Math.min(...xs) + Math.max(...xs)) / 2,
             cy: (Math.min(...ys) + Math.max(...ys)) / 2 },
  }; })()`;

(async () => {
  if (typeof WebSocket === 'undefined') {
    console.error('✗ нужен Node с глобальным WebSocket (Node 22+)');
    process.exit(1);
  }
  if (!fs.existsSync(CHROME)) {
    console.error('✗ не найден Chromium: ' + CHROME + ' (задай CHROME_PATH)');
    process.exit(1);
  }
  try {
    // HEAD :8200 не отвечает (404), поэтому проверяем обычным GET.
    const r = await fetch(DASH);
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.error('✗ дашборд недоступен на ' + DASH + ' — ' + e.message);
    process.exit(1);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-dpr-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--window-size=1920,1080', 'about:blank'],
    { stdio: 'ignore' });

  let pass = 0, fail = 0;
  const check = (name, fn) => {
    try { fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
  };

  try {
    const t = await pageTarget();
    const cdp = new CDP(t.webSocketDebuggerUrl);
    await cdp.ready();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: DASH });
    await sleep(1200);
    await cdp.eval(`localStorage.setItem('opencode_active_tab','fin')`);
    await cdp.send('Page.navigate', { url: DASH });
    await sleep(4000);
    await cdp.eval(`document.querySelector('[data-tab="fin"]')?.click()`);
    await sleep(1500);

    for (const s of SIZES) {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: s.w, height: s.h, deviceScaleFactor: s.dpr, mobile: false });
      await sleep(900);
      // Сцена лежит ниже первого экрана — прокручиваем, иначе граф не рисуется.
      await cdp.eval(`(() => { const el = document.querySelector('.scene');
        if (el) scrollTo(0, el.getBoundingClientRect().top + scrollY - 90); })()`);
      await sleep(1200);
      const g = await cdp.eval(GEOM);
      const tag = `${s.w}×${s.h} @ ${s.dpr === 1 ? '100' : s.dpr * 100} %`;

      if (g.err) { fail++; console.log(`  ✗ ${tag} — ${g.err}`); continue; }

      check(`${tag}: canvas занимает окно, а не окно × DPR`, () => {
        assert.ok(Math.abs(g.canvas.cssW - g.innerW) <= 1,
          `CSS-ширина canvas ${Math.round(g.canvas.cssW)} при окне ${g.innerW}`);
        assert.ok(Math.abs(g.canvas.cssH - g.innerH) <= 1,
          `CSS-высота canvas ${Math.round(g.canvas.cssH)} при окне ${g.innerH}`);
      });
      check(`${tag}: облако стоит в своей фигуре`, () => {
        const rx = g.cloud.cx * g.canvas.scaleX, ry = g.cloud.cy * g.canvas.scaleY;
        const dx = rx - g.anchor.cx, dy = ry - g.anchor.cy;
        assert.ok(Math.abs(dx) <= 8 && Math.abs(dy) <= 8,
          `облако ${Math.round(rx)}/${Math.round(ry)}, фигура ${Math.round(g.anchor.cx)}/${Math.round(g.anchor.cy)}`
          + ` (сдвиг ${Math.round(dx)}/${Math.round(dy)} px, масштаб canvas ${g.canvas.scaleX.toFixed(2)}×)`);
      });
    }
  } finally {
    chrome.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} прошло, ${fail} упало`);
  process.exitCode = fail ? 1 : 0;
})();
