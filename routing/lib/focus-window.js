// routing/lib/focus-window.js
//
// Выносит окно Chromium, поднятое ЭТИМ процессом, поверх остальных окон Windows.
//
// Зачем отдельный модуль, если у Playwright есть page.bringToFront(). Это разные вещи:
// bringToFront — CDP-команда `Page.bringToFront`, она активирует ВКЛАДКУ внутри браузера.
// Окно операционной системы она наверх не выносит: у Chromium нет причин трогать z-order,
// он и так считает, что показал нужную вкладку.
//
// Почему окно не всплывает само. Кнопка «Открыть» на дашборде спавнит `open-session.js`
// как detached-потомок (`spawn(process.execPath, …, { detached: true })`), браузер —
// потомок уже этого node. Windows запрещает процессу, который не владеет передним планом,
// звать SetForegroundWindow: иначе любое фоновое приложение воровало бы фокус. Отказ
// молчаливый — функция возвращает false, окно остаётся мигать в панели задач.
//
// Обход — штатный и старый: AttachThreadInput цепляет наш поток ввода к потоку окна,
// которое сейчас на переднем плане, и на время этой связки система считает нас «тем же
// самым» передним планом, то есть SetForegroundWindow проходит. Связку сразу снимаем.
//
// 🪤 PowerShell зовётся через -EncodedCommand (base64 UTF-16LE), а не -Command: так
// строка не проходит через разбор кавычек cmd.exe и не зависит от кодовой страницы
// консоли. Внутри скрипта только ASCII — по той же причине.
//
// 🪤 spawn БЕЗ detached: true. Замерено 10.09 на трёх вариантах запуска — с `detached`
// PowerShell выходит с кодом 0, не выполнив скрипт (пустой вывод в файл-лог), и подъём
// молча не происходит. Процесс-родитель тут живёт дольше вызова в обоих случаях
// (open-session.js держит окно, дашборд работает всегда), так что detached не нужен.

const { spawn } = require('child_process');

// SW_RESTORE (9), а не SW_SHOW: окно могло быть свёрнуто в панель задач — тогда у него
// нет ни размера, ни позиции, и один SetForegroundWindow оставил бы его свёрнутым.
const PS_SOURCE = `
Add-Type @"
using System;
using System.Threading;
using System.Runtime.InteropServices;
public static class WaFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  const int SW_MINIMIZE = 6;
  const int SW_RESTORE = 9;
  const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_SHOWWINDOW = 0x0040;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

  static void Activate(IntPtr h) {
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(fgThread, myThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SwitchToThisWindow(h, true);
    if (attached) AttachThreadInput(fgThread, myThread, false);
  }

  public static bool Raise(IntPtr h) {
    ShowWindow(h, SW_RESTORE);
    // Гарантия ВИДИМОСТИ, отдельно от гарантии фокуса: топмост поднимает окно в z-order
    // даже когда система откатывает активацию. Снимаем ниже — иначе окно навсегда
    // осталось бы поверх всего, чего никто не просил.
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    Activate(h);
    Thread.Sleep(250);
    if (GetForegroundWindow() != h) {
      // Foreground-lock откатил активацию. Обходим легитимно: активацию при
      // разворачивании окна Windows отдаёт сама, права переднего плана для этого
      // не нужны. Цена — окно на миг сворачивается в панель задач.
      ShowWindow(h, SW_MINIMIZE);
      ShowWindow(h, SW_RESTORE);
      Activate(h);
      Thread.Sleep(250);
    }
    bool ok = GetForegroundWindow() == h;
    SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    return ok;
  }
}
"@
$root = __PID__
Write-Output "root=$root"
$deadline = (Get-Date).AddSeconds(__WAIT__)
while ((Get-Date) -lt $deadline) {
  $ids = New-Object System.Collections.Generic.List[int]
  $ids.Add($root)
  foreach ($kid in (Get-CimInstance Win32_Process -Filter "ParentProcessId=$root")) { $ids.Add([int]$kid.ProcessId) }
  foreach ($id in $ids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
      $ok = [WaFg]::Raise($proc.MainWindowHandle)
      Write-Output ("raise pid=" + $id + " name=" + $proc.ProcessName + " hwnd=" + $proc.MainWindowHandle + " foreground=" + $ok)
      exit 0
    }
  }
  Start-Sleep -Milliseconds 250
}
Write-Output "no window found"
exit 1
`;

/**
 * Поднять окно браузера поверх остальных окон.
 *
 * Окно ищется у самого `pid` и у его прямых потомков — этим один вызов покрывает оба
 * способа запуска: `launchPersistentContext` из open-session.js (браузер — потомок node,
 * передаём process.pid) и `chromium.launch()` из dashboard-api.js (окно у самого
 * браузера, передаём browser.process().pid).
 *
 * Ничего не ждёт и ничего не возвращает: подъём окна — украшение, и падать из-за него
 * открытие аккаунта не должно. Не Windows — тихо выходим.
 *
 * @param {number} pid       корень поиска, по умолчанию текущий процесс
 * @param {number} waitSecs  сколько секунд ждать появления окна
 */
function raiseBrowserWindow(pid = process.pid, waitSecs = 10) {
    if (process.platform !== 'win32') return;
    try {
        const script = PS_SOURCE
            .replace('__PID__', String(Number(pid) || process.pid))
            .replace('__WAIT__', String(Number(waitSecs) || 10));
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        // WA_FOCUS_LOG=<файл> — вывод PowerShell вместо /dev/null. Отладка вслепую тут
        // особенно дорога: при stdio:'ignore' молчат и ошибка Add-Type, и отказ WinAPI.
        const logPath = process.env.WA_FOCUS_LOG;
        let stdio = 'ignore';
        let fd = null;
        if (logPath) {
            try {
                fd = require('fs').openSync(logPath, 'a');
                stdio = ['ignore', fd, fd];
            } catch { /* лог не обязателен */ }
        }
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
            { stdio, windowsHide: true },
        );
        child.on('error', () => {});
        child.unref();
        if (fd !== null) { try { require('fs').closeSync(fd); } catch {} }
    } catch { /* фокус — не повод ронять открытие аккаунта */ }
}

module.exports = { raiseBrowserWindow };
