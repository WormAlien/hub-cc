// _research/probe-od-balance.js
//
// Проверка читателя баланса Odyssey ТЕМ ЖЕ путём, что боевой: берём снимок сессии аккаунта
// (`odyssey/sessions/acct_<id>.json`), идём с его куками на страницу кабинета и вытаскиваем
// «Credit balance». Тот же регексп, что в `odBalanceFromCabinet`.
//
// Зачем отдельно: у площадки нет billing-ручек (404 route_not_found), баланс живёт только
// в вёрстке кабинета. Проверять это надо на живой странице, а не на вере в селектор.
//
// Запуск: node _research/probe-od-balance.js od_1789542441438_0

const fs = require('fs');
const path = require('path');

const id = process.argv[2] || 'od_1789542441438_0';
const file = path.join(__dirname, '..', 'odyssey', 'sessions', `acct_${id}.json`);
const URL = 'https://odysseyapi.tech/dashboard';

(async () => {
    let cookies = [];
    try {
        cookies = JSON.parse(fs.readFileSync(file, 'utf8')).cookies || [];
    } catch (e) {
        console.log(`❌ снимка сессии нет (${file}): ${e.message}`);
        process.exit(1);
    }
    const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`аккаунт ${id}: кук в снимке ${cookies.length}`);

    // Два пути, как в бою: напрямую и через прокси (владелец: «когда IP в одной сети -
    // баланс не даёт»; замер это подтверждает - один и тот же снимок пускают с одного
    // адреса и не пускают с другого).
    const probe = async (label, init) => {
        try {
            const r = await fetch(URL, { headers: { Cookie: header }, redirect: 'manual', ...init });
            console.log(`${label}: HTTP ${r.status}`);
            return { status: r.status, text: r.status === 200 ? await r.text() : '' };
        } catch (e) { console.log(`${label}: ошибка ${e.message}`); return { status: 0, text: '', error: e.message }; }
    };
    let res = await probe('напрямую', {});
    if (res.status !== 200) {
        const lib = require('../routing/lib/newapi-account.js');
        const pool = require('../routing/lib/proxy-pool.js');
        const px = lib.accountProxy ? await lib.accountProxy({ host: 'odysseyapi.tech', accountId: id }) : null;
        if (px && px.ok && px.proxy) {
            const r2 = await pool.fetchVia(px.proxy, URL, { headers: { Cookie: header }, timeoutMs: 20000 });
            const text = await r2.text();
            console.log(`через прокси ${px.proxy.label || ''}: HTTP ${r2.status}`);
            if (r2.status === 200) res = { status: 200, text };
        } else {
            console.log('прокси аккаунта пул не выдал:', px && px.error ? px.error : 'нет привязки');
        }
    }
    if (res.status !== 200) {
        console.log('вердикт: сессия не принята (307 = редирект на вход)');
        process.exit(0);
    }
    // 🪤 `res` тут - уже разобранный объект {status, text}, а не Response: чтение
    // `res.text()` падало. Тело лежит строкой.
    const html = typeof res.text === 'string' ? res.text : await res.text();

    const near = /Credit balance[\s\S]{0,600}?\$([0-9]+(?:\.[0-9]{1,2})?)/.exec(html);
    const any = /\$([0-9]+\.[0-9]{2})/.exec(html);
    const m = near || any;
    console.log(`найдено рядом с подписью: ${near ? near[1] : '—'} · первая сумма на странице: ${any ? any[1] : '—'}`);
    console.log(m ? `✅ баланс прочитан: $${m[1]}` : '❌ цифру не нашёл — селектор надо править');
})();
