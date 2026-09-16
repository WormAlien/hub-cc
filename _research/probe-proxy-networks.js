// _research/probe-proxy-networks.js
//
// Разбор прокси пула ПО СЕТЯМ: какие адреса принадлежат одному провайдеру/диапазону.
//
// 🔴 Зачем. У Odyssey подарочные $5 даются «one account per network» - дословно из кабинета:
// «Another account on the same network has already received it». Значит для подарка нужны
// адреса из РАЗНЫХ сетей, а не просто разные IP: три прокси одного провайдера
// (`154.221.x`, `154.219.x`, `185.104.x`) для площадки сеть ОДНА, и подарок достанется
// только первому аккаунту.
//
// Считаем две вещи: /16 диапазон (дешёвая оценка «сеть ли это») и ASN провайдера
// (ip-api.com, батчами - он даёт и то, и другое).
//
// Запуск: node _research/probe-proxy-networks.js

const pp = require('../routing/lib/proxy-pool.js');

const BATCH = 100;   // предел бесплатного ip-api

(async () => {
    const pool = pp.pool();
    const proxies = pool.proxies;
    console.log(`прокси в пуле: ${proxies.length}`);
    if (!proxies.length) return;

    const byIp = new Map();
    for (const p of proxies) {
        if (!byIp.has(p.hostname)) byIp.set(p.hostname, []);
        byIp.get(p.hostname).push(p);
    }
    const ips = [...byIp.keys()];
    console.log(`уникальных адресов: ${ips.length}`);

    // Бесплатный ip-api батчами по 100, только нужные поля.
    const info = {};
    for (let i = 0; i < ips.length; i += BATCH) {
        const chunk = ips.slice(i, i + BATCH);
        try {
            const r = await fetch('http://ip-api.com/batch?fields=query,as,isp,country,org', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(chunk),
            });
            const arr = await r.json();
            for (const it of arr) info[it.query] = it;
        } catch (e) {
            console.log(`  ⚠️ батч ${i / BATCH + 1} не спросился: ${e.message}`);
        }
    }

    // Группируем по ASN (это и есть «сеть» в смысле антифрода), внутри показываем /16.
    const groups = new Map();
    for (const ip of ips) {
        const it = info[ip] || {};
        const asn = it.as || 'неизвестно';
        if (!groups.has(asn)) groups.set(asn, []);
        groups.get(asn).push(ip);
    }
    console.log(`\nсетей (по ASN): ${groups.size}`);
    for (const [asn, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const net16 = [...new Set(list.map(ip => ip.split('.').slice(0, 2).join('.')))].join(', ');
        const only = info[list[0]] || {};
        console.log(`  ${String(list.length).padStart(3)} × ${asn}  (${only.country || '?'})  /16: ${net16}`);
        console.log(`        ${list.slice(0, 6).join(' ')}${list.length > 6 ? ' …' : ''}`);
    }
    const countries = new Set(Object.values(info).map(x => x.country));
    console.log(`\nстран: ${countries.size} (${[...countries].join(', ')})`);
    console.log(groups.size >= 3
        ? '→ сетей >=3: есть из чего собрать аккаунты с подарком'
        : '→ сетей мало: для подарка этого не хватит, нужен другой источник адресов');
})();
