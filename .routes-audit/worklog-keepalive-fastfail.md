# worklog: keepalive-proxy fast-fail 5xx
- [start] создан worklog, приступаю к разбору routing/keepalive-proxy.js
- [1-2] добавлена константа RETRY_FAST_FAIL_MS=2000 (после RETRY_DELAY_MS, с обоснованием по замеру 17.09) и функция isFastFail5xx(status,buf,elapsedMs) сразу после isTransientBody: status>=500 && elapsed<порог && нет структурных retryable/retry_after
- [3] в makeUpstream заведён `const attemptT0 = Date.now();` (перед const upReq = t.requester), в колбэке ответа считаются fastFailMs/fastFail и быстрый 5xx уходит в ветку постоянных ошибок с отдельной строкой в лог; existing else-ветка не тронута
- [4] в selftest добавлено 10 проверок на isFastFail5xx (живой 502 Odyssey за 490мс = постоянная; тот же за 2500мс и ровно 2000мс = ретрай; retryable:true, retry_after, error_category=origin = ретрай; 429/401/200 мимо правила)
- [5] `node routing/keepalive-proxy.js selftest` -> "selftest OK", exit 0. Изменён только routing/keepalive-proxy.js (git diff --stat), ничего не перезапускалось/не коммитилось
