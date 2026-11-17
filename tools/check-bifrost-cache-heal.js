#!/usr/bin/env node
'use strict';
// Повреждённый кэш Bifrost должен ЛЕЧИТЬСЯ САМ, а не требовать ручной команды.
//
// Живой случай 17.11.2026 (Windows у одного, macOS у другого):
//   Bifrost :20135 - OpenAI sidecar недоступен: bifrost_cache_corrupt
// при целом интернете и уже исправленных пинах. Дескриптор сервиса звал
// prepareLaunch({ install: false }), поэтому ensureInstalled не выполнялся, и
// проверка sha256 кидала bifrost_cache_corrupt. Человеку оставалось руками
// запускать `node routing/lib/bifrost-sidecar.js install`.
//
// Проверяем на настоящих файлах репо, но с ИНЪЕКЦИЕЙ загрузки — сеть в тестах
// не нужна и только делает их медленными и нестабильными.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const sidecar = require(path.join(ROOT, 'routing/lib/bifrost-sidecar.js'));
const LOCK_PATH = path.join(ROOT, 'routing/bifrost-lock.json');
const CONFIG_PATH = path.join(ROOT, 'routing/bifrost-config.json');
const fresh = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bifrost-heal-${name}-`));
const hashBytes = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

function fixture({ payload, corrupt = null }) {
    const cacheRoot = fresh('cache');
    const runtimeRoot = fresh('runtime');
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    lock.artifacts[`${PLATFORM}-${ARCH}`].sha256 = hashBytes(payload);
    const lockPath = path.join(cacheRoot, 'lock.json');
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const expected = sidecar.expectedExecutable({ lockPath, cacheRoot, platform: PLATFORM, arch: ARCH });
    if (corrupt !== null) {
        fs.mkdirSync(path.dirname(expected.executable), { recursive: true });
        fs.writeFileSync(expected.executable, corrupt);
    }
    return { cacheRoot, runtimeRoot, lockPath, expected };
}

test('prepareLaunch with install:true re-downloads a corrupted cache', async () => {
    const payload = Buffer.from('healed bifrost fixture');
    const f = fixture({ payload, corrupt: 'CORRUPTED CACHE' });
    // Убеждаемся, что состояние действительно «битый кэш».
    const before = sidecar.verifyFile(f.expected.executable, f.expected.artifact.sha256);
    assert.equal(before.ok, false, 'фикстура не создала битый кэш');

    let downloads = 0;
    const healed = await sidecar.prepareLaunch({
        lockPath: f.lockPath, configTemplatePath: CONFIG_PATH,
        cacheRoot: f.cacheRoot, runtimeRoot: f.runtimeRoot,
        platform: PLATFORM, arch: ARCH, install: true,
        download: async (_url, target) => { downloads += 1; fs.writeFileSync(target, payload); },
    });
    assert.equal(downloads, 1, 'битый кэш не был перекачан');
    assert.equal(healed.verified, true);
    assert.equal(fs.readFileSync(f.expected.executable, 'utf8'), payload.toString());
});

test('prepareLaunch with install:false still fails closed on a corrupted cache', async () => {
    // Это тот самый путь, из-за которого человек видел bifrost_cache_corrupt:
    // проверка обязана отказывать, когда перекачивать запрещено. Лечение — в том,
    // что дескриптор больше НЕ зовёт с install:false.
    const payload = Buffer.from('healed bifrost fixture');
    const f = fixture({ payload, corrupt: 'CORRUPTED CACHE' });
    await assert.rejects(
        sidecar.prepareLaunch({
            lockPath: f.lockPath, configTemplatePath: CONFIG_PATH,
            cacheRoot: f.cacheRoot, runtimeRoot: f.runtimeRoot,
            platform: PLATFORM, arch: ARCH, install: false,
        }),
        (error) => error && error.code === 'bifrost_cache_corrupt',
        'без права скачивать проверка обязана отказать',
    );
});

test('the shipped service descriptor asks for a real install, not a read-only check', () => {
    // Регресс-замок: именно `install: false` в дескрипторе и делал кэш мёртвым.
    // Смотрим ТОЛЬКО на код вызова, без комментариев: в пояснении к правке фраза
    // `install: false` упоминается намеренно, и это не должно валить тест.
    const src = fs.readFileSync(path.join(ROOT, 'routing/lib/bifrost-sidecar.js'), 'utf8');
    const start = src.indexOf('prepare: async descriptor =>');
    assert.ok(start > 0, 'не найден prepare дескриптора');
    const prepareBody = src.slice(start, start + 1200)
        .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    assert.match(prepareBody, /install: true/,
        'дескриптор снова зовёт prepareLaunch без права скачивания');
    assert.ok(!/install: false/.test(prepareBody),
        'дескриптор снова отключил самолечение кэша');
});

test('a substituted artifact never launches, even during self-healing', async () => {
    const payload = Buffer.from('genuine payload');
    const f = fixture({ payload });
    await assert.rejects(
        sidecar.prepareLaunch({
            lockPath: f.lockPath, configTemplatePath: CONFIG_PATH,
            cacheRoot: f.cacheRoot, runtimeRoot: f.runtimeRoot,
            platform: PLATFORM, arch: ARCH, install: true,
            download: async (_url, target) => fs.writeFileSync(target, 'EVIL PAYLOAD'),
        }),
        /checksum|corrupt|identity/i,
        'подменённый артефакт прошёл проверку — защита ослабла',
    );
});

test('an offline download fails fast instead of hanging the start', async () => {
    const payload = Buffer.from('genuine payload');
    const f = fixture({ payload });
    const started = Date.now();
    await assert.rejects(
        sidecar.prepareLaunch({
            lockPath: f.lockPath, configTemplatePath: CONFIG_PATH,
            cacheRoot: f.cacheRoot, runtimeRoot: f.runtimeRoot,
            platform: PLATFORM, arch: ARCH, install: true,
            download: async () => { throw new Error('network down'); },
        }),
        /network down/,
    );
    assert.ok(Date.now() - started < 10000, 'ошибка сети не должна висеть');
});
