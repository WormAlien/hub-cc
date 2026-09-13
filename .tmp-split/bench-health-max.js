// Честный замер: блокировка ПЕРИОДИЧЕСКАЯ, поэтому одиночная параллельная проба может
// попасть в окно между блокировками и показать копейки (так и вышло у первого замера на
// живом :8200 — 140 мс при блокировках в сотни мс). Здесь во время health молотим HTML
// каждые 20 мс и берём ХУДШИЙ TTFB — то, что человек видит как «дашборд замер».
const http = require('http');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const execFileAsync = require('util').promisify(execFile);
const REPO = process.cwd();

const scanSync = () => {
    const l = new Map();
    try { const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
        for (const ln of out.split(/\r?\n/)) { const m = ln.match(/:(\d{4,5})\s+\S+\s+LISTENING\s+(\d+)/); if (m) { const p = +m[1]; l.set(p, (l.get(p) || []).concat(m[2])); } } } catch {}
    try { const g = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
        const b = g('rev-parse', '--abbrev-ref', 'HEAD'); g('fetch', '--quiet', 'origin', b); g('rev-parse', '--short', 'HEAD'); } catch {}
    return l.size;
};
const scanAsync = async () => {
    const l = new Map();
    try { const { stdout: out } = await execFileAsync('netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        for (const ln of out.split(/\r?\n/)) { const m = ln.match(/:(\d{4,5})\s+\S+\s+LISTENING\s+(\d+)/); if (m) { const p = +m[1]; l.set(p, (l.get(p) || []).concat(m[2])); } } } catch {}
    try { const g = async (...a) => (await execFileAsync('git', a, { cwd: REPO, encoding: 'utf8', timeout: 8000 })).stdout.trim();
        const b = await g('rev-parse', '--abbrev-ref', 'HEAD'); await g('fetch', '--quiet', 'origin', b); await g('rev-parse', '--short', 'HEAD'); } catch {}
    return l.size;
};

// ── клиент: отдельным процессом, непрерывной стрельбой ──────────────────────
// 🪤 Ждать каждую пробу нельзя: пока сервер заблокирован, проба сама висит на всю
// блокировку, и цикл «выстрелил — дождался — выстрелил» делает 3 пробы вместо сотни.
// Поэтому запросы уходят по таймеру и НЕ ждутся; ждём только health и считаем, сколько
// народу попало в окно.
function client(port) {
    const get = (p) => new Promise(r => {
        const t = Date.now();
        const q = http.get({ host: '127.0.0.1', port, path: p }, s => { s.resume(); s.on('end', () => r(Date.now() - t)); });
        q.on('error', () => r(null));
    });
    const samples = [];
    const timer = setInterval(() => { get('/').then(v => { if (v !== null) samples.push(v); }); }, 20);
    const t0 = Date.now();
    get('/health').then(() => {
        clearInterval(timer);
        // даём догореть пробам, уже висящим в сокете
        setTimeout(() => {
            console.log(JSON.stringify({
                max: samples.length ? Math.max(...samples) : 0,
                n: samples.length,
                health: Date.now() - t0,
            }));
        }, 250);
    });
}

(async () => {
    if (process.argv[2] === '--client') { client(Number(process.argv[3])); return; }
    for (const [label, scan, port] of [['ДО (sync)', scanSync, 45881], ['ПОСЛЕ (async)', scanAsync, 45882]]) {
        const srv = http.createServer(async (req, res) => {
            if (req.url === '/health') { const n = await scan(); res.end(JSON.stringify({ ports: n })); return; }
            res.end('<html>дашборд</html>');
        });
        await new Promise(r => srv.listen(port, '127.0.0.1', r));
        const out = await new Promise(r => execFile(process.execPath, [__filename, '--client', String(port)], (e, o) => r(JSON.parse(o.trim()))));
        srv.close();
        console.log(`${label.padEnd(14)} худший TTFB HTML во время health: ${String(out.max).padStart(5)} мс · проб ${out.n} · сама health ${out.health} мс`);
    }
})();
