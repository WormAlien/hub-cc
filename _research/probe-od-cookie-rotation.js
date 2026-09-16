// _research/probe-od-cookie-rotation.js
//
// Проверка: проворачивается ли сессия Clerk при обращении к кабинету.
//
// Гипотеза, которую проверяем: снимок сессии одноразовый. Clerk меняет refresh-куку при
// каждом использовании, поэтому сохранённый файл после первого удачного запроса становится
// просроченным - и следующий чек получает 307 (владелец: «оно не даёт баланс, вообще 0»).
//
// Смотрим на `set-cookie` в ответе: если он приносит новые `__session`/`__refresh`, значит
// снимок НАДО обновлять после каждого обращения, а не только при регистрации.
//
// Запуск: node _research/probe-od-cookie-rotation.js [id]

const fs = require('fs');
const path = require('path');

const id = process.argv[2] || 'od_1789545916807_2';
const file = path.join(__dirname, '..', 'odyssey', 'sessions', `acct_${id}.json`);
const URL = 'https://odysseyapi.tech/billing';

(async () => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cookies = doc.cookies || [];
    const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const before = Object.fromEntries(cookies.map(c => [c.name, (c.value || '').slice(0, 12)]));
    console.log(`кук в снимке: ${cookies.length}`);

    const res = await fetch(URL, { headers: { Cookie: header }, redirect: 'manual' });
    console.log(`HTTP ${res.status}`);
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    console.log(`set-cookie в ответе: ${set.length}`);
    for (const s of set) {
        const name = s.split('=')[0];
        const val = s.split('=')[1] || '';
        const changed = before[name] && before[name] !== val.slice(0, 12);
        console.log(`  ${name}${changed ? '  ← ИЗМЕНИЛАСЬ (снимок устарел)' : ''}`);
    }
    const text = await res.text();
    const m = /Credit balance[\s\S]{0,400}?\$([0-9]+\.[0-9]{2})/.exec(text);
    console.log(`баланс: ${m ? '$' + m[1] : 'не прочитан'}`);
    if (res.status !== 200 && set.length) {
        console.log('вывод: даже отказ приносит новые куки - снимок надо переписывать после каждого хода');
    } else if (set.length) {
        console.log('вывод: сессия проворачивается - снимок надо обновлять после каждого обращения');
    } else {
        console.log('вывод: куки не меняются - одноразовость не подтверждается');
    }
})();
