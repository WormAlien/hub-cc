#!/usr/bin/env node
/**
 * Замер: забирает ли окно браузера фокус у владельца.
 *
 * Повод прямой - владелец 19.09: «сделать чтобы браузеры в фоне открывались а то заебало
 * они забирают фокус». Механизм в коде был двойной: `page.bringToFront()` плюс WinAPI
 * `raiseBrowserWindow()` из `routing/lib/focus-window.js`, и вызывались они ВСЕГДА.
 *
 * Меряем не «на глаз», а активным окном Windows: снимаем заголовок окна в фокусе ДО старта
 * Chromium и после, и сравниваем. Если после старта в фокусе оказалось окно браузера -
 * тихий режим не работает, что бы там ни было написано в аргументах.
 *
 * Запуск: node _research/check-window-silent.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PS1 = path.join(__dirname, 'fg-window.ps1');

function foreground() {
    try {
        return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1],
            { encoding: 'utf8', timeout: 20000 }).trim();
    } catch (e) {
        return `<не снять: ${e.message}>`;
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function measure(label, args, { minimizeViaCdp = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-window-'));
    const before = foreground();
    const ctx = await chromium.launchPersistentContext(dir, {
        headless: false,
        viewport: null,
        channel: 'chrome',
        ignoreDefaultArgs: ['--disable-extensions'],
        args,
    });
    let win = null;
    let cdp = null;
    if (minimizeViaCdp) {
        // Свернуть сразу после старта: окно успевает активироваться, но не остаётся поверх.
        cdp = await ctx.newCDPSession(ctx.pages()[0]);
        win = await cdp.send('Browser.getWindowForTarget').catch(() => null);
        if (win) {
            await cdp.send('Browser.setWindowBounds', {
                windowId: win.windowId, bounds: { windowState: 'minimized' },
            }).catch(() => {});
        }
    }
    await sleep(6000);                     // окно успевает подняться и, если оно наглое, всплыть
    const after = foreground();
    if (!cdp) {
        cdp = await ctx.newCDPSession(ctx.pages()[0]);
        win = await cdp.send('Browser.getWindowForTarget').catch(() => null);
    }
    const bounds = win ? await cdp.send('Browser.getWindowBounds', { windowId: win.windowId }).catch(() => null) : null;
    await ctx.close().catch(() => {});
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временный профиль */ }

    const stole = after !== before && /chrom|профиль|about:blank|data:/i.test(after);
    console.log(`\n${label}`);
    console.log(`  до старта в фокусе : ${before}`);
    console.log(`  после старта       : ${after}`);
    console.log(`  состояние окна     : ${bounds && bounds.bounds ? bounds.bounds.windowState : '?'}`);
    console.log(`  ${stole ? 'ФОКУС УКРАДЕН' : 'фокус не тронут'}`);
    return { before, after, stole, state: bounds && bounds.bounds ? bounds.bounds.windowState : null };
}

(async () => {
    const normal = await measure('1. как было: обычное окно', ['--window-size=600,1000']);
    const flag = await measure('2. флаг --start-minimized', ['--window-size=600,1000', '--start-minimized']);
    const cdpMin = await measure('3. свернуть через CDP сразу после старта',
        ['--window-size=600,1000'], { minimizeViaCdp: true });
    console.log('\nитог:');
    console.log(`  обычное окно        - ${normal.stole ? 'забирает фокус' : 'фокус не тронут'} (окно ${normal.state})`);
    console.log(`  флаг minimized      - ${flag.stole ? 'забирает фокус' : 'фокус не тронут'} (окно ${flag.state})`);
    console.log(`  CDP-сворачивание    - ${cdpMin.stole ? 'забирает фокус' : 'фокус не тронут'} (окно ${cdpMin.state})`);
})();
