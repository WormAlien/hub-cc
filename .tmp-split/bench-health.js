// Замер ДО/ПОСЛЕ в песочнице: два крошечных сервера, в каждом ручка /health повторяет
// ФОРМУ соответствующего кода (старую синхронную и новую асинхронную) на тех же самых
// внешних командах. Живой :8200 для «после» не годится — он крутит старый код, пока
// владелец не перезапустит, а рестарт рвёт его сессии Claude Code.
//
// 🔴 Клиент — ОТДЕЛЬНЫМ ПРОЦЕССОМ (этот же файл с --client). Внутри одного процесса мерить
// нельзя: пока сервер заблокирован, клиент не получает даже событие `connect`, запросы
// уходят в сокет после разблокировки, и sync-версия с 1,4 с блокировки показывает 1 мс.
// Проверено на себе — первый прогон этого файла выдал «1 мс → 2 мс» и был выброшен.
const http = require('http');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const execFileAsync = require('util').promisify(execFile);

const REPO = process.cwd();

function scanSync() {
    const listening = new Map();
    try {
        const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        for (const line of out.split(/\r?\n/)) {
            const m = line.match(/:(\d{4,5})\s+\S+\s+LISTENING\s+(\d+)/);
            if (m) { const p = +m[1]; if (!listening.has(p)) listening.set(p, []); listening.get(p).push(m[2]); }
        }
    } catch {}
    try {
        const g = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
        const branch = g('rev-parse', '--abbrev-ref', 'HEAD');
        g('fetch', '--quiet', 'origin', branch);
        g('rev-parse', '--short', 'HEAD');
    } catch {}
    return listening.size;
}

async function scanAsync() {
    const listening = new Map();
    try {
        const { stdout: out } = await execFileAsync('netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        for (const line of out.split(/\r?\n/)) {
            const m = line.match(/:(\d{4,5})\s+\S+\s+LISTENING\s+(\d+)/);
            if (m) { const p = +m[1]; if (!listening.has(p)) listening.set(p, []); listening.get(p).push(m[2]); }
        }
    } catch {}
    try {
        const g = async (...a) => (await execFileAsync('git', a, { cwd: REPO, encoding: 'utf8', timeout: 8000 })).stdout.trim();
        const branch = await g('rev-parse', '--abbrev-ref', 'HEAD');
        await g('fetch', '--quiet', 'origin', branch);
        await g('rev-parse', '--short', 'HEAD');
    } catch {}
    return listening.size;
}

function serve(scan) {
    return http.createServer(async (req, res) => {
        if (req.url === '/health') { const n = await scan(); res.end(JSON.stringify({ ports: n })); return; }
        res.end('<html>дашборд</html>');     // «HTML» — та самая параллельная проба
    });
}

// ── Клиент: запускается дочерним процессом ──────────────────────────────────
function client(port) {
    const once = (p) => new Promise(r => http.get({ host: '127.0.0.1', port, path: p }, s => { s.resume(); s.on('end', () => r(Date.now())); }));
    (async () => {
        const t0 = Date.now();
        const health = once('/health');                       // стартует первой
        await new Promise(r => setTimeout(r, 10));            // даём ей уйти в сокет
        const html = once('/');                               // и сразу просим HTML
        const [h, g] = await Promise.all([health, html]);
        console.log(JSON.stringify({ health: h - t0, html: g - t0 }));
    })();
}

async function measure(label, scan, port) {
    const srv = serve(scan);
    await new Promise(r => srv.listen(port, '127.0.0.1', r));
    // покой: один HTML без сопутствующей health
    const idle = await new Promise(r => { const t0 = Date.now(); http.get({ host: '127.0.0.1', port, path: '/' }, s => { s.resume(); s.on('end', () => r(Date.now() - t0)); }); });

    const res = await new Promise(r => {
        execFile(process.execPath, [__filename, '--client', String(port)], (e, out) => r(JSON.parse(out.trim())));
    });
    srv.close();
    console.log(`${label.padEnd(15)} HTML в покое ${String(idle).padStart(4)} мс · `
        + `HTML при health ${String(res.html).padStart(5)} мс · health ${String(res.health).padStart(5)} мс`);
    return res;
}

(async () => {
    if (process.argv[2] === '--client') { client(Number(process.argv[3])); return; }
    console.log(`\nрепо: ${REPO}\n(` + 'HTML при health — сколько ждал ОБЫЧНЫЙ запрос страницы, пока шла health)\n');
    const before = await measure('ДО (sync)', scanSync, 45871);
    const after = await measure('ПОСЛЕ (async)', scanAsync, 45872);
    console.log(`\nHTML при health: ${before.html} мс → ${after.html} мс  (в ${(before.html / Math.max(after.html, 1)).toFixed(1)} раза меньше)\n`);
})();
