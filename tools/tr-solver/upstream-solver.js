'use strict';

/**
 * src/solver.js — ThreeRouter's captcha engine and the `--auto` entry, plus the
 * exit transport it shares with the CLI (every panel request goes through one
 * pinned exit when a proxy list is given).
 *
 * Registration is gated by the panel's own "human verification" (a jigsaw slider
 * or an image-click puzzle). Both modes are solved without a browser and without
 * a third-party service:
 *
 *   slider      the notch in the background is the piece content times a
 *               constant, so the offset is plain template correlation
 *               (measured Pearson r = 0.9997, ratio CV 0.004);
 *   image_click shapes are painted translucent over a photo, so the fill is not
 *               the palette RGB — it is flat *within* a shape but shifts per
 *               challenge, so detection keys on the image's own dominant
 *               saturated fills, colour comes from the fill's hue, and the
 *               shape from IoU against rotated ideal templates.
 *
 * Solving order for a challenge:
 *   1. `externalCmd` (`--captcha-cmd`) when the caller supplied one;
 *   2. the bundled `captcha-solve.py` when python + opencv are present — it is
 *      the solver this line was proven with (slider 6/6 and image_click 8/8 live
 *      verifies), so it is preferred whenever it can run;
 *   3. the built-in JS solver: the slider path matches the python numbers, the
 *      image_click path is best effort (measured weaker live), so the caller
 *      keeps the retries (a new challenge every try).
 *
 * Locked one-command entry:
 *   const { solveCaptcha } = require('./solver.js');
 *   const { token, ms } = await solveCaptcha({ type, sitekey, url, proxy });
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

/** The captcha helper lives next to the repo root (src/ is the published layout). */
const ROOT = path.basename(__dirname) === 'src' ? path.resolve(__dirname, '..') : __dirname;

const BASE = 'https://threerouter.com';
const API = `${BASE}/api/v1`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** The per-request budget the CLI's `--timeout` lands on. */
let DEFAULT_TIMEOUT_MS = 60000;
const setDefaultTimeout = (ms) => {
  const v = Number(ms);
  DEFAULT_TIMEOUT_MS = Number.isFinite(v) && v > 0 ? Math.max(5000, v) : 60000;
};

// ------------------------------------------------------------------- proxy
function parseProxy(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  let m = s.match(/^(https?|socks5h?|socks4):\/\/(?:([^:@/]+):([^@/]+)@)?([^:/]+):(\d+)/i);
  if (!m) m = s.match(/^(?:([^:@/]+):([^@/]+)@)?([^:/]+):(\d+)$/);
  if (!m) return null;
  if (m.length === 6) {
    const raw = m[1].toLowerCase();
    if (raw === 'socks4') return null;
    return {
      protocol: raw.startsWith('socks') ? 'socks5' : 'http',
      host: m[4],
      port: Number(m[5]),
      auth: m[2] ? `${m[2]}:${m[3]}` : null,
      line: s,
    };
  }
  return { protocol: 'http', host: m[3], port: Number(m[4]), auth: m[1] ? `${m[1]}:${m[2]}` : null, line: s };
}

/** A raw socket straight to host:port — the direct-mode twin of connectThrough. */
function directConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect timeout (${host}:${port})`));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

function connectThrough(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error(`proxy timeout (${proxy.host}:${proxy.port})`));
    }, timeoutMs);
    const done = (err, s) => {
      clearTimeout(t);
      if (err) {
        try {
          sock.destroy();
        } catch (e) {
          /* already gone */
        }
        reject(err);
      } else resolve(s);
    };
    sock.once('error', (e) => done(new Error(`proxy connect failed: ${e.message}`)));
    sock.once('connect', () => {
      if (proxy.protocol === 'socks5') {
        sock.write(proxy.auth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
        let stage = 0;
        let buf = Buffer.alloc(0);
        const sendConnect = () => {
          const hb = Buffer.from(host);
          sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([port >> 8, port & 0xff])]));
        };
        const onData = (d) => {
          try {
            buf = Buffer.concat([buf, d]);
            for (;;) {
              if (stage === 0) {
                if (buf.length < 2) return;
                const v = buf;
                buf = buf.slice(2);
                if (v[0] !== 5) return done(new Error('SOCKS5 bad version'));
                if (v[1] === 2) {
                  if (!proxy.auth) return done(new Error('SOCKS5 auth required'));
                  const [u, p] = proxy.auth.split(':');
                  sock.write(
                    Buffer.concat([Buffer.from([1, u.length]), Buffer.from(u), Buffer.from([p.length]), Buffer.from(p)]),
                  );
                  stage = 1;
                  continue;
                }
                if (v[1] !== 0) return done(new Error('SOCKS5 no acceptable method'));
                stage = 2;
                sendConnect();
                continue;
              }
              if (stage === 1) {
                if (buf.length < 2) return;
                const v = buf;
                buf = buf.slice(2);
                if (v[1] !== 0) return done(new Error('SOCKS5 auth failed'));
                stage = 2;
                sendConnect();
                continue;
              }
              if (stage === 2) {
                if (buf.length < 5) return;
                const atyp = buf[3];
                const need = 4 + (atyp === 1 ? 4 : atyp === 3 ? 1 + buf[4] : 16) + 2;
                if (buf.length < need) return;
                const rep = buf[1];
                buf = buf.slice(need);
                if (rep !== 0) return done(new Error(`SOCKS5 connect failed (code ${rep})`));
                sock.off('data', onData);
                return done(null, sock);
              }
            }
          } catch (e) {
            done(e);
          }
        };
        sock.on('data', onData);
        return;
      }
      const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      let buf = '';
      const onData = (d) => {
        buf += d;
        if (!buf.includes('\r\n\r\n')) return;
        sock.off('data', onData);
        if (!/^HTTP\/\d(\.\d)? 200/.test(buf)) return done(new Error(`proxy CONNECT refused: ${buf.split('\r\n')[0]}`));
        done(null, sock);
      };
      sock.on('data', onData);
    });
  });
}

/** One HTTPS request through one exit (or directly). Returns { status, headers, body }. */
async function exitFetch(proxy, url, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const u = new URL(url);
  const raw = proxy
    ? await connectThrough(proxy, u.hostname, u.port || 443, timeoutMs)
    : await directConnect(u.hostname, u.port || 443, timeoutMs);
  const sock = tls.connect({ socket: raw, servername: u.hostname });
  await new Promise((res, rej) => {
    sock.once('secureConnect', res);
    sock.once('error', rej);
  });
  const chunks = [];
  let resolve;
  let reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const req = http.request({
    method,
    path: u.pathname + u.search,
    createConnection: () => sock,
    headers: { host: u.host, 'user-agent': UA, accept: '*/*', ...headers },
  });
  const t = setTimeout(() => {
    try {
      req.destroy();
    } catch (e) {
      /* gone */
    }
    reject(new Error('request timeout'));
  }, timeoutMs);
  req.on('response', (res) => {
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      clearTimeout(t);
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
    });
  });
  req.on('error', (e) => {
    clearTimeout(t);
    reject(e);
  });
  if (body != null) {
    req.write(Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
  }
  req.end();
  return p;
}

async function exitJson(proxy, url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body != null && !Buffer.isBuffer(opts.body)) headers['content-type'] = 'application/json';
  const r = await exitFetch(proxy, url, { ...opts, headers });
  let json = null;
  try {
    json = JSON.parse(r.body);
  } catch (e) {
    /* not json */
  }
  return { status: r.status, json, text: r.body };
}

// ================================================================== captcha
// Everything below is pure JS: PNG decode (zlib + defilter), a correlation
// solver for the slider and a template-IoU classifier for the image puzzle.

const PALETTE = {
  red: [0xef, 0x44, 0x44],
  blue: [0x3b, 0x82, 0xf6],
  green: [0x22, 0xc5, 0x5e],
  yellow: [0xea, 0xb3, 0x08],
  purple: [0xa8, 0x55, 0xf7],
};
const SHAPES = ['circle', 'square', 'hexagon', 'triangle', 'star'];
const NORM = 64;
const FILL_TOL = 14;
const SAT_MIN = 90;
const MIN_PEAK = 250;
const MIN_AREA = 350;
// The photo behind the shapes has large flat regions of its own that pass the
// dominant-fill test; a painted shape is at most ~60x60 px. Without the ceiling
// a 24 000 px background blob wins the "largest blob of this colour" tie-break
// and the click lands on nothing (measured against the python solver).
const MAX_AREA = 4000;

/** PNG (8-bit, non-interlaced, colour types 0/2/4/6) → { width, height, rgba }. */
function decodePng(buf) {
  if (!buf || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let hdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      hdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!hdr) throw new Error('PNG without IHDR');
  if (hdr.depth !== 8) throw new Error(`PNG bit depth ${hdr.depth} unsupported`);
  if (hdr.interlace) throw new Error('interlaced PNG unsupported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[hdr.colorType];
  if (!channels) throw new Error(`PNG colour type ${hdr.colorType} unsupported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = hdr.width * channels;
  const out = Buffer.alloc(stride * hdr.height);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < hdr.height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.slice(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pred) & 0xff;
      }
      line[i] = v;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  const rgba = new Uint8Array(hdr.width * hdr.height * 4);
  for (let i = 0, n = hdr.width * hdr.height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1 || channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = channels === 2 ? out[s + 1] : 255;
    } else {
      rgba[d] = out[s];
      rgba[d + 1] = out[s + 1];
      rgba[d + 2] = out[s + 2];
      rgba[d + 3] = channels === 4 ? out[s + 3] : 255;
    }
  }
  return { width: hdr.width, height: hdr.height, rgba };
}

function hueOf([r, g, b]) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h / 2; // OpenCV scale 0..180
}
const satOf = ([r, g, b]) => {
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : ((max - Math.min(r, g, b)) / max) * 255;
};
const hueDist = (a, b) => {
  const d = Math.abs(a - b);
  return Math.min(d, 180 - d);
};
const HUE = Object.fromEntries(Object.entries(PALETTE).map(([n, c]) => [n, hueOf(c)]));

function colorOfRgb(rgb) {
  const h = hueOf(rgb);
  let best = '?';
  let score = 1e9;
  for (const [name, hh] of Object.entries(HUE)) {
    const d = hueDist(h, hh);
    if (d < score) {
      score = d;
      best = name;
    }
  }
  return { color: best, dist: score };
}

function solveSlider(data) {
  const bg = decodePng(Buffer.from(data.bg_image, 'base64'));
  const piece = decodePng(Buffer.from(data.piece_image, 'base64'));
  const y = Number(data.piece_y);
  const pw = piece.width;
  const ph = piece.height;
  let mask = [];
  for (let i = 0; i < pw * ph; i++) if (piece.rgba[i * 4 + 3] === 255) mask.push(i);
  if (!mask.length) for (let i = 0; i < pw * ph; i++) if (piece.rgba[i * 4 + 3] > 0) mask.push(i);
  if (!mask.length) return null;
  // Pearson correlation of the piece content against the strip at piece_y. Both
  // the reference and the candidate are pooled over the three channels, so the
  // reference variance must be pooled the same way: subtracting per-channel
  // means instead drops the between-channel spread and inflates r (measured
  // 2.27 against a true 0.9992 on a live challenge).
  const N = mask.length * 3;
  let refSum = 0;
  let refSum2 = 0;
  for (let k = 0; k < mask.length; k++) {
    const i = mask[k];
    for (let ch = 0; ch < 3; ch++) {
      const a = piece.rgba[i * 4 + ch];
      refSum += a;
      refSum2 += a * a;
    }
  }
  const refVar = refSum2 / N - (refSum / N) ** 2;
  if (refVar <= 0) return null;
  let best = { r: -2, x: 0 };
  for (let x = 0; x + pw <= bg.width; x++) {
    if (y + ph > bg.height) break;
    let sRC = 0;
    let sC = 0;
    let sC2 = 0;
    for (let k = 0; k < mask.length; k++) {
      const i = mask[k];
      const px = x + (i % pw);
      const py = y + Math.floor(i / pw);
      const o = (py * bg.width + px) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = piece.rgba[i * 4 + ch];
        const b = bg.rgba[o + ch];
        sRC += a * b;
        sC += b;
        sC2 += b * b;
      }
    }
    const varC = sC2 / N - (sC / N) ** 2;
    if (varC <= 0) continue;
    const cov = sRC / N - (refSum / N) * (sC / N);
    const r = cov / Math.sqrt(refVar * varC);
    if (r > best.r) best = { r, x };
  }
  if (best.r < 0.9) return null;
  return { drop_x: best.x, trajectory: humanTrack(best.x, y), _r: Number(best.r.toFixed(5)) };
}

function humanTrack(dropX, pieceY, steps = 26, duration = 900) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    let x = dropX * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, f * 0.94)));
    if (f > 0.88 && f < 0.965) x = dropX * (1 + 0.012 * Math.sin(((f - 0.88) / 0.085) * Math.PI));
    x += Math.sin(i * 1.7) * 0.6;
    pts.push({
      x: Number(Math.max(0, Math.min(x, dropX + 3)).toFixed(2)),
      y: Number((pieceY + Math.sin(i * 0.9) * 0.5).toFixed(2)),
      t: Math.round(f * duration),
    });
  }
  pts[pts.length - 1] = { x: dropX, y: pieceY, t: duration };
  return pts;
}

/**
 * Ideal silhouettes, pre-rendered per rotation.
 *
 * The mask is resampled exactly ONCE (crop to its bounding box → 64x64); every
 * candidate orientation comes from rotating the *template's* polygon before
 * rasterising, then normalising the template the same way. Rotating the mask
 * instead cost a second resample on shapes that are only 30-50 px wide, and the
 * star/hexagon calls drifted away from the python solver's (measured live).
 */
function renderShape(name) {
  const t = new Uint8Array(NORM * NORM);
  const R = NORM / 2;
  const fill = (pts) => {
    for (let y = 0; y < NORM; y++) {
      for (let x = 0; x < NORM; x++) {
        let inPoly = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inPoly = !inPoly;
        }
        if (inPoly) t[y * NORM + x] = 1;
      }
    }
  };
  if (name === 'square') t.fill(1);
  else if (name === 'circle') {
    for (let y = 0; y < NORM; y++)
      for (let x = 0; x < NORM; x++) if (((x - R) / R) ** 2 + ((y - R) / R) ** 2 <= 1) t[y * NORM + x] = 1;
  } else if (name === 'hexagon')
    fill(Array.from({ length: 6 }, (_, i) => [R + R * Math.cos((Math.PI / 3) * i), R + R * Math.sin((Math.PI / 3) * i)]));
  else if (name === 'triangle') fill([[NORM / 2, 0], [0, NORM - 1], [NORM - 1, NORM - 1]]);
  else
    fill(
      Array.from({ length: 10 }, (_, i) => {
        const r = i % 2 === 0 ? R : R * 0.42;
        const a = -Math.PI / 2 + (Math.PI / 5) * i;
        return [R + r * Math.cos(a), R + r * Math.sin(a)];
      }),
    );
  return t;
}

/** Crop to content and resample to NORM x NORM (nearest). */
function normalise(mask, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  const sw = x1 - x0 + 1;
  const sh = y1 - y0 + 1;
  const out = new Uint8Array(NORM * NORM);
  for (let y = 0; y < NORM; y++) {
    const sy = y0 + Math.min(sh - 1, Math.floor((y * sh) / NORM));
    for (let x = 0; x < NORM; x++) {
      const sx = x0 + Math.min(sw - 1, Math.floor((x * sw) / NORM));
      out[y * NORM + x] = mask[sy * w + sx];
    }
  }
  return out;
}
const TEMPLATES = Object.fromEntries(SHAPES.map((n) => [n, renderShape(n)]));

/** Rotate a mask around its centre (nearest sampling) for the angle sweep. */
function rotate(mask, w, h, deg) {
  const out = new Uint8Array(w * h);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = Math.round(cx + dx * cos + dy * sin);
      const sy = Math.round(cy + -dx * sin + dy * cos);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      out[y * w + x] = mask[sy * w + sx];
    }
  }
  return out;
}

function classifyShape(mask, w, h) {
  const scores = {};
  for (let deg = 0; deg < 360; deg += 15) {
    const cand = normalise(deg === 0 ? mask : rotate(mask, w, h, deg), w, h);
    if (!cand) continue;
    for (const name of SHAPES) {
      const tpl = TEMPLATES[name];
      let inter = 0;
      let union = 0;
      for (let i = 0; i < NORM * NORM; i++) {
        const a = cand[i];
        const b = tpl[i];
        if (a && b) inter++;
        if (a || b) union++;
      }
      const iou = union ? inter / union : 0;
      if (!(name in scores) || iou > scores[name]) scores[name] = iou;
    }
  }
  let best = ['?', 0];
  for (const [k, v] of Object.entries(scores)) if (v > best[1]) best = [k, v];
  return best;
}
function dominantFills(img) {
  const { width, height, rgba } = img;
  const counts = new Map();
  for (let i = 0; i < width * height; i++) {
    const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400);
  const out = [];
  for (const [key, count] of top) {
    if (count < MIN_PEAK) break;
    const rgb = [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
    if (satOf(rgb) < SAT_MIN) continue;
    if (out.some((o) => Math.max(...o.rgb.map((v, i) => Math.abs(v - rgb[i]))) <= FILL_TOL)) continue;
    out.push({ rgb, count });
    if (out.length >= 12) break;
  }
  return out;
}

function componentsOf(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pix = [];
    while (stack.length) {
      const p = stack.pop();
      pix.push(p);
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    comps.push(pix);
  }
  return comps;
}

/** Fill interior holes: flood the background from the border, everything not reached is a hole. */
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const p = y * w + x;
      if (!mask[p] && !outside[p]) {
        outside[p] = 1;
        stack.push(p);
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const p = y * w + x;
      if (!mask[p] && !outside[p]) {
        outside[p] = 1;
        stack.push(p);
      }
    }
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!mask[n] && !outside[n]) {
          outside[n] = 1;
          stack.push(n);
        }
      }
    }
  }
  const filled = Uint8Array.from(mask);
  for (let i = 0; i < w * h; i++) if (!mask[i] && !outside[i]) filled[i] = 1;
  return filled;
}

/** Binary 3x3 close (8-connected dilate then erode) — joins anti-aliased edges. */
function close3x3(mask, w, h) {
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          dil[ny * w + nx] = 1;
        }
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        for (let dx = -1; dx <= 1 && all; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (!dil[ny * w + nx]) all = 0;
        }
      }
      out[y * w + x] = all;
    }
  }
  return out;
}

function shapeBlobs(img) {
  const { width: w, height: h, rgba } = img;
  const out = [];
  for (const peak of dominantFills(img)) {
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const dr = Math.abs(rgba[i * 4] - peak.rgb[0]);
      const dg = Math.abs(rgba[i * 4 + 1] - peak.rgb[1]);
      const db = Math.abs(rgba[i * 4 + 2] - peak.rgb[2]);
      if (Math.max(dr, dg, db) <= FILL_TOL) mask[i] = 1;
    }
    // The fills sit on a photo, so edge pixels blend and the raw mask can break
    // into slivers; a 3x3 close is what the python solver does too, and keeping
    // the two on the same masks is what makes their answers agree.
    mask = close3x3(mask, w, h);
    for (const pix of componentsOf(mask, w, h)) {
      if (pix.length < MIN_AREA || pix.length > MAX_AREA) continue;
      const comp = new Uint8Array(w * h);
      let sx = 0;
      let sy = 0;
      for (const p of pix) {
        comp[p] = 1;
        sx += p % w;
        sy += Math.floor(p / w);
      }
      const filled = fillHoles(comp, w, h);
      const [shape, iou] = classifyShape(filled, w, h);
      const { color, dist } = colorOfRgb(peak.rgb);
      out.push({
        color,
        hue_dist: dist,
        shape,
        iou: Number(iou.toFixed(4)),
        area: pix.length,
        x: sx / pix.length,
        y: sy / pix.length,
      });
    }
  }
  return out;
}

function solveImageClick(data) {
  const img = decodePng(Buffer.from(data.image, 'base64'));
  const prompt = data.prompt || [];
  const blobs = shapeBlobs(img);
  const clicks = [];
  const used = new Set();
  for (const want of prompt) {
    const color = String(want.color || '').toLowerCase();
    const shape = String(want.shape || '').toLowerCase();
    const same = blobs.filter((b) => b.color === color && !used.has(`${Math.round(b.x)},${Math.round(b.y)}`));
    if (!same.length) return null;
    let picked = same.filter((b) => b.shape === shape);
    if (!picked.length) picked = same; // misclassification: take the colour's main blob
    picked.sort((a, b) => b.area - a.area);
    const pick = picked[0];
    used.add(`${Math.round(pick.x)},${Math.round(pick.y)}`);
    clicks.push({ x: Number(pick.x.toFixed(2)), y: Number(pick.y.toFixed(2)) });
  }
  if (clicks.length !== Number(data.click_count || prompt.length)) return null;
  return { clicks, _blobs: blobs.map((b) => [b.color, b.shape, b.iou, b.area]) };
}

let PY_SOLVER = null; // { cmd, args } once probed
function pythonSolver() {
  if (PY_SOLVER !== null) return PY_SOLVER;
  // The helper ships next to this file (published: src/captcha-solve.py); a
  // checkout that keeps it at the repo root is still found (measured: the
  // published layout looked only at ROOT and never used the python solver).
  const script = [path.join(__dirname, 'captcha-solve.py'), path.join(ROOT, 'captcha-solve.py')].find((p) => fs.existsSync(p));
  PY_SOLVER = false;
  if (!script) return PY_SOLVER;
  for (const bin of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
    const probe = spawnSync(bin, ['-c', 'import cv2, numpy, PIL'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (!probe.error && probe.status === 0) {
      PY_SOLVER = { cmd: bin, args: [script] };
      break;
    }
  }
  return PY_SOLVER;
}

/**
 * One challenge → one answer. `externalCmd` (`--captcha-cmd`) wins, then the
 * bundled python helper, then the built-in JS solver. Returns
 * `{ ok, mode, solver, drop_x, trajectory }` or `{ ok, mode, clicks }`, or
 * `{ ok: false, error }` — the panel decides whether the answer is accepted.
 */
function solveChallenge(challenge, { externalCmd = '' } = {}) {
  if (externalCmd) {
    const r = spawnSync(externalCmd, {
      shell: true,
      input: JSON.stringify(challenge),
      encoding: 'utf8',
      timeout: 90000,
      windowsHide: true,
    });
    if (r.error) return { ok: false, error: String(r.error.message).slice(0, 120) };
    try {
      return JSON.parse(String(r.stdout || '{}').trim());
    } catch (e) {
      return { ok: false, error: `captcha-cmd output unreadable: ${String(r.stdout || r.stderr).slice(0, 120)}` };
    }
  }
  const py = pythonSolver();
  if (py) {
    const r = spawnSync(py.cmd, py.args, {
      input: JSON.stringify(challenge),
      encoding: 'utf8',
      timeout: 90000,
      windowsHide: true,
    });
    if (!r.error) {
      try {
        const ans = JSON.parse(String(r.stdout || '{}').trim());
        if (ans && ans.ok) return ans;
      } catch (e) {
        /* fall through to the built-in solver */
      }
    }
  }
  const mode = challenge.mode;
  try {
    const answer = mode === 'slider' ? solveSlider(challenge.slider || {}) : solveImageClick(challenge.image_click || {});
    if (!answer) return { ok: false, error: `no answer (${mode})` };
    return { ok: true, mode, solver: 'embedded-js', ...answer };
  } catch (e) {
    return { ok: false, error: `${mode}: ${String(e.message).slice(0, 140)}` };
  }
}

/**
 * One-command entry (`--auto`), following the shared solver contract:
 *
 *   const { token, ms } = await solveCaptcha({ type, sitekey, url, proxy, cdata });
 *
 * The panel's token comes back from its own verify call, so this entry owns the
 * whole round trip: challenge → solve → verify, all on `proxy` (the exit the
 * caller will spend the token on — the panel binds it to the solving exit).
 * `proxy` is the exit LINE ('socks5://host:port' | 'http://user:pass@host:port')
 * or null for DIRECT. `cdata` short-circuits the challenge call when the caller
 * already holds one (`--solve-file`). Resolves with the untrimmed token, or
 * throws — never a silent empty string.
 */
async function solveCaptcha({ type = 'auto', url = `${API}/auth/captcha/challenge`, proxy = null, cdata = null, externalCmd = '', tries = 6, log = () => {} } = {}) {
  const exit = proxy ? parseProxy(proxy) : null;
  if (proxy && !exit) throw new Error(`solveCaptcha: unreadable exit "${String(proxy).slice(0, 60)}"`);
  const t0 = Date.now();
  let last = 'no challenge';
  for (let i = 0; i < tries; i++) {
    let data = cdata;
    if (!data) {
      const ch = await exitJson(exit, url, {
        method: 'POST',
        body: {},
        headers: { origin: BASE, referer: `${BASE}/register` },
        timeoutMs: 25000,
      });
      data = ch.json && ch.json.data;
      if (!data) {
        last = `challenge ${ch.status} ${String(ch.text).slice(0, 90)}`;
        log(`  captcha ${last}`);
        continue;
      }
    }
    const ans = solveChallenge(data, { externalCmd });
    if (!ans.ok) {
      last = `solver (${data.mode}): ${ans.error}`;
      log(`  solver failed (${data.mode}): ${ans.error}`);
      continue;
    }
    const body = { challenge_id: data.challenge_id };
    if (data.mode === 'slider') {
      body.drop_x = ans.drop_x;
      body.trajectory = ans.trajectory;
    } else {
      body.clicks = ans.clicks;
    }
    const vr = await exitJson(exit, url.replace(/challenge$/, 'verify'), {
      method: 'POST',
      body,
      headers: { origin: BASE, referer: `${BASE}/register` },
      timeoutMs: 25000,
    });
    const token = vr.json && vr.json.data && vr.json.data.captcha_token;
    if (token) return { token, ms: Date.now() - t0, mode: data.mode };
    last = `verify ${data.mode} -> ${vr.status} ${String(vr.text).slice(0, 100)}`;
    log(`  captcha ${last}`);
  }
  throw new Error(`solveCaptcha: no captcha token after ${tries} tries (${last})`);
}

module.exports = {
  solveCaptcha,
  solveChallenge,
  solveSlider,
  solveImageClick,
  decodePng,
  parseProxy,
  exitFetch,
  exitJson,
  setDefaultTimeout,
  pythonSolver,
  UA,
  BASE,
  API,
};
