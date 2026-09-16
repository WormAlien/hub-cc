// Рестарт AR-конвертера :20132 — повторяет ровно то, что делает boot после обновления
// (routing/transparent-proxy.js § arProxySpawn с opts.force).
//
// Зачем отдельный скрипт: `arProxySpawn` живёт внутри transparent-proxy.js, который
// ничего не экспортирует и не имеет require.main-guard — импортировать его нельзя, а
// запускать копию дашборда ради одного спавна нельзя тем более. Поэтому здесь та же
// последовательность шагов: мягко погасить порт → дождаться, что он реально свободен →
// спавнить detached с stdio:ignore. Ждать нужно именно освобождения порта: он
// отпускается не мгновенно, и без ожидания проверка прочитает его как занятый, спавн
// молча выйдет — и конвертера не будет вообще.
//
// Запуск: node tools/restart-ar-proxy.js
//
// 🪤 НЕ удалять :20132 через taskkill вручную: цель — не «убить», а «поднять заново».

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 20132;
const SCRIPT = path.join(__dirname, '..', 'routing', 'agentrouter-proxy.js');

const nap = ms => new Promise(r => setTimeout(r, ms));

// Порт свободен = никто не слушает. Проба именно на listen, а не на connect:
// connect покажет «занят» и для порта, который уже отпущен, но в TIME_WAIT.
function portIsFree(port) {
    return new Promise(resolve => {
        const sock = net.createServer();
        sock.once('error', () => resolve(false));
        sock.listen(port, '127.0.0.1', () => { sock.close(); resolve(true); });
    });
}

function listeners(port) {
    try {
        const out = require('child_process')
            .execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', windowsHide: true });
        return [...new Set(out.split('\n')
            .filter(l => /LISTENING/.test(l))
            .map(l => l.trim().split(/\s+/).pop())
            .filter(Boolean))];
    } catch { return []; }
}

(async () => {
    const before = listeners(PORT);
    console.log(`:${PORT} — слушают pid: ${before.join(', ') || '(никто)'}`);

    // Мягко: просим завершиться, а не убиваем. `taskkill` без /F = WM_CLOSE; для
    // консольного процесса без окна это не сработает, поэтому следом — принудительно,
    // но только по конкретным pid, снятым с порта (а не по имени процесса).
    for (const pid of before) {
        try { require('child_process').execSync(`taskkill /PID ${pid}`, { stdio: 'ignore', windowsHide: true }); } catch {}
    }
    for (let i = 0; i < 20; i += 1) {
        if (await portIsFree(PORT)) break;
        await nap(100);
    }

    // Кто пережил мягкую попытку — того добиваем по pid.
    if (!(await portIsFree(PORT))) {
        for (const pid of listeners(PORT)) {
            try { require('child_process').execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true }); } catch {}
        }
        for (let i = 0; i < 20; i += 1) {
            if (await portIsFree(PORT)) break;
            await nap(100);
        }
    }

    if (!(await portIsFree(PORT))) {
        console.error(`🔴 :${PORT} не освободился — конвертер НЕ поднят. Разбираться, а не долбить.`);
        process.exit(1);
    }

    const child = spawn(process.execPath, [SCRIPT], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    console.log(`spawn: :${PORT} (pid ${child.pid})`);

    // Ждём именно занятия порта: node мог умереть на первой строке, и «поднял» тогда
    // означало бы неправду (та же логика, что в lifecycle.ensureProviderService).
    for (let i = 0; i < 24; i += 1) {
        await nap(250);
        if (listeners(PORT).length) {
            console.log(`✅ :${PORT} слушает, pid ${listeners(PORT).join(', ')}`);
            process.exit(0);
        }
    }
    console.error(`🔴 :${PORT} не занялся за 6 с — конвертер не поднялся`);
    process.exit(1);
})();
