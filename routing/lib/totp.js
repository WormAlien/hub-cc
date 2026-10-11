'use strict';
/*
 * totp.js — код двухфакторной авторизации (RFC 6238, шаг 30 с, SHA-1).
 *
 * Зачем отдельным модулем. Тот же код уже лежит внутри `google/open-session.js`, и второе
 * окно (Gemini) его бы скопировало третьим экземпляром: три реализации одной формулы
 * расходятся молча — расхождение видно только тем, что код «не подходит» на одном окне и
 * подходит на другом. Работающий скрипт вкладки Google ради этого не трогаем; когда
 * решим — он переедет на этот модуль.
 *
 * Своя реализация, а не пакет: пятнадцать строк не стоят зависимости в этом репозитории.
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32 → байты. Всё, что не входит в алфавит, выбрасывается: секреты продавцы пишут группами. */
function base32Decode(s) {
    const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0;
    const out = [];
    for (const ch of clean) {
        value = (value << 5) | ALPHABET.indexOf(ch);
        bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Buffer.from(out);
}

/** Код на момент `at`. `null` — если секрета нет или он не разбирается. */
function totpCode(secret, at = Date.now()) {
    const key = base32Decode(secret);
    if (!key.length) return null;
    const counter = Math.floor(at / 1000 / 30);
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const hash = crypto.createHmac('sha1', key).update(msg).digest();
    const off = hash[hash.length - 1] & 0x0f;
    const num = ((hash[off] & 0x7f) << 24) | (hash[off + 1] << 16) | (hash[off + 2] << 8) | hash[off + 3];
    return String(num % 1000000).padStart(6, '0');
}

/** Сколько секунд осталось текущему коду — чтобы человек не ввёл протухший. */
const secondsLeft = (at = Date.now()) => 30 - (Math.floor(at / 1000) % 30);

module.exports = { base32Decode, totpCode, secondsLeft };
