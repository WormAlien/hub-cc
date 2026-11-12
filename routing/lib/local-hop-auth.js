'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECRET_BYTES = 32;
const TOKEN_BYTES = 32;
const HEADER_NAME = 'x-abuse-hub-route-auth';
const DEFAULT_SECRET_FILE = path.join(os.homedir(), '.secrets', 'abuse-hub-local-hop.key');
const LABELS = new Set(['frontdoor-to-keepalive', 'keepalive-to-adapter', 'status-inspection']);

function canonicalSecretFile(override) {
    return path.resolve(String(override || process.env.ABUSE_HUB_LOCAL_HOP_KEY_FILE || DEFAULT_SECRET_FILE));
}

function readExact(file) {
    const value = fs.readFileSync(file);
    if (value.length !== SECRET_BYTES) throw new Error('Local-hop secret has invalid length.');
    return value;
}

function fsyncDirectory(directory) {
    let fd;
    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
    } catch { /* Directory fsync is not supported on every Windows filesystem. */ }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

function createSecret(file, randomBytes = crypto.randomBytes) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const value = randomBytes(SECRET_BYTES);
        if (!Buffer.isBuffer(value) || value.length !== SECRET_BYTES) throw new Error('Local-hop random source returned invalid bytes.');
        const temporary = path.join(directory,
            `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
        let fd;
        try {
            fd = fs.openSync(temporary, 'wx', 0o600);
            fs.writeSync(fd, value, 0, value.length, 0);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = null;
            try { fs.chmodSync(temporary, 0o600); } catch { /* Windows ACLs are outside chmod. */ }
            try {
                fs.linkSync(temporary, file);
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                // Another process won the create race.
            }
            fs.unlinkSync(temporary);
            fsyncDirectory(directory);
            return readExact(file);
        } catch (error) {
            if (fd !== undefined && fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
            try { fs.unlinkSync(temporary); } catch { /* absent */ }
            if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
            try { return readExact(file); }
            catch (readError) {
                if (readError.code !== 'ENOENT') throw readError;
            }
        }
    }
    throw new Error('Local-hop secret could not be created.');
}

function loadSecret(file, options = {}) {
    try { return readExact(file); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return createSecret(file, options.randomBytes);
    }
}

function derive(secret, label) {
    if (!LABELS.has(label)) throw new Error('Unknown local-hop role.');
    return crypto.createHmac('sha256', secret).update(`abuse-hub-local-hop-v1\0${label}`, 'utf8').digest();
}

function decodeToken(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    let decoded;
    try { decoded = Buffer.from(value, 'base64url'); } catch { return null; }
    if (decoded.length !== TOKEN_BYTES || decoded.toString('base64url') !== value) return null;
    return decoded;
}

function createLocalHopAuth(options = {}) {
    const secretFile = canonicalSecretFile(options.secretFile);
    let secret = null;
    const getSecret = () => {
        if (!secret) secret = loadSecret(secretFile, options);
        return secret;
    };
    const tokenBytes = label => derive(getSecret(), label);
    if (options.eager) getSecret();
    return {
        headerName: HEADER_NAME,
        secretFile,
        token(label) { return tokenBytes(label).toString('base64url'); },
        verify(value, label) {
            const actual = decodeToken(value);
            if (!actual) return false;
            return crypto.timingSafeEqual(actual, tokenBytes(label));
        },
        consume(headers, label) {
            const value = headers && headers[HEADER_NAME];
            if (headers) delete headers[HEADER_NAME];
            return this.verify(value, label);
        },
        strip(headers) { if (headers) delete headers[HEADER_NAME]; },
    };
}

module.exports = {
    DEFAULT_SECRET_FILE,
    HEADER_NAME,
    SECRET_BYTES,
    createLocalHopAuth,
};
