#!/usr/bin/env node
'use strict';
// Synthetic profiles only: never reads the user's cookies or Keychain.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { createRequire } = require('module');
const file = path.join(__dirname, '..', 'routing', 'lib', 'newapi-account.js');
const localRequire = createRequire(file);
const source = fs.readFileSync(file, 'utf8');
const sandbox = {
    require: id => id === 'os' ? { ...os, homedir: () => home }
        : id === 'child_process' ? { execFileSync: () => { throw Error('Keychain must not be accessed'); } }
        : localRequire(id),
    module: { exports: {} }, exports: {}, __dirname: path.dirname(file),
    Buffer, console, process: { ...process, platform: 'darwin' }, setTimeout, clearTimeout,
};
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cookie-v11-test-'));
const DB = localRequire('better-sqlite3');
function encrypt(value, host, tag) {
    const key = crypto.pbkdf2Sync('mock_password', tag === 'v11' ? 'pepper' : 'saltysalt', 1003, 16, 'sha1');
    const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
    const plain = Buffer.concat([crypto.createHash('sha256').update(host).digest(), Buffer.from(value)]);
    return Buffer.concat([Buffer.from(tag), cipher.update(plain), cipher.final()]);
}
try {
    vm.runInNewContext(source, sandbox, { filename: file });
    const nac = sandbox.module.exports;
    for (const tags of [['v10'], ['v11'], ['v10', 'v11']]) {
        const profile = path.join(home, tags.join('-'));
        fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
        const dbPath = path.join(profile, 'Default', 'Cookies');
        const db = new DB(dbPath);
        db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, last_update_utc INTEGER, last_access_utc INTEGER)');
        for (const tag of tags) db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, 0, 0)').run(
            'agentrouter.org', tag, '', encrypt(`fixture-${tag}`, 'agentrouter.org', tag));
        db.close();
        assert.strictEqual(nac.cookieDbPath(profile), dbPath);
        let cookies = nac.readProfileCookies(profile);
        for (const tag of tags) assert.strictEqual(cookies.find(c => c.name === tag)?.value, `fixture-${tag}`);
        const update = Object.fromEntries(tags.map(tag => [tag, `updated-${tag}`]));
        assert.strictEqual(nac.writeProfileCookies(profile, 'agentrouter.org', update).ok, true);
        cookies = nac.readProfileCookies(profile);
        const check = new DB(dbPath, { readonly: true });
        for (const tag of tags) {
            assert.strictEqual(cookies.find(c => c.name === tag)?.value, `updated-${tag}`);
            const row = check.prepare('SELECT encrypted_value FROM cookies WHERE name = ?').get(tag);
            assert.strictEqual(row.encrypted_value.subarray(0, 3).toString(), tag);
        }
        check.close();
        console.log(`[OK] macOS ${tags.join('+')}: read, write, preserve encryption tag`);
    }
    const ghFile = path.join(__dirname, '..', 'routing', 'lib', 'github-session.js');
    const ghSrc = fs.readFileSync(ghFile, 'utf8');
    const fn = ghSrc.match(/function cookiesMtime\(dir\) \{[\s\S]*?\n\}/)[0];
    const mtime = new Function('fs', 'nac', `${fn};return cookiesMtime;`)(fs, nac);
    assert(mtime(path.join(home, 'v11')) > 0);
    assert.strictEqual(mtime(path.join(home, 'missing')), 0);
    console.log('[OK] GitHub index uses shared cookie DB layout resolver');
} finally {
    fs.rmSync(home, { recursive: true, force: true });
}
