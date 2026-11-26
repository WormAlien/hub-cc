"""Мост «авторега → пул хаба» для UncensoredLabs.

Проблема, которую закрывает: авторега создаёт аккаунт и ключ, но кладёт их
только в свой `bank.jsonl`. Хаб читает `routing/uncensoredlabs-sessions.json`,
поэтому свежий ключ в ротацию не попадал никогда — `/__switch/api/uc/auto/status`
показывал `poolReady: 5` (старые аккаунты 23.11), при живом новом ключе.

Этот модуль пишет запись ровно в той форме, которую читает
`ucLoad()` в `routing/transparent-proxy.js`:

    {id, email, name, api_key, active, status, created, balanceCheckedAt,
     spent, balance, balanceSource, balanceError}

🪤 Поле ключа именно `api_key` (змейкой): по нему `ucLoad` строит множество
дублей, а ротатор берёт ключ. `secret` из ответа UC — это значение, имя — нет.

🪤 Блокировка обязательна: ферма гонит N аккаунтов параллельно, а
`durableWriteJson` в хабе и наш append режут один файл. Без замка часть записей
теряется молча — файл остаётся валидным, просто аккаунтов меньше.

🪤 `status: 'live'` не выставляем «на всякий случай»: хаб сам обновляет статус
через `ucProbe` и `ucApplyBalance`. Неверный `live` у мёртвого ключа ломает
ротацию сильнее, чем `unknown`.
"""
import json
import os
import time

# 🪤 Путь к пулу считается ОТ ФАЙЛА, а не хардкодом: скрипт лежит в
# <repo>/uncensoredlabs/farm/, а пул — в <repo>/routing/. Хардкод
# C:/Users/<user>/Desktop/... ломался на любой другой машине и на любом
# другом расположении репозитория.
_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_POOL = os.path.abspath(
    os.path.join(_HERE, "..", "..", "routing", "uncensoredlabs-sessions.json"))
POOL_FILE = os.environ.get("UL_POOL", _DEFAULT_POOL)


def _lock_path(pool=None):
    return str(pool or POOL_FILE) + ".lock"


def _read_rows(pool):
    try:
        raw = open(pool, encoding="utf-8").read()
        if raw.startswith("\ufeff"):
            raw = raw[1:]
        rows = json.loads(raw)
        return rows if isinstance(rows, list) else []
    except FileNotFoundError:
        return []
    except Exception:
        return []


def _write_rows(pool, rows):
    tmp = str(pool) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    os.replace(tmp, pool)


def pool_append(rec, pool=None, timeout=30):
    """Добавить аккаунт в пул хаба. Возвращает 1 (добавлен) или 0 (уже был).

    Дубли определяем по `api_key`: один аккаунт может пересоздать ключ, но
    пустой строкой ключа запись не считаем — иначе второй прогон без ключа
    затрёт первый по «совпадению пустоты».
    """
    pool = pool or POOL_FILE
    lock = _lock_path(pool)
    deadline = time.time() + timeout
    fd = None
    while time.time() < deadline:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            time.sleep(0.05)
        except FileNotFoundError:
            os.makedirs(os.path.dirname(pool), exist_ok=True)
            continue
    if fd is None:
        raise RuntimeError("pool lock: не дождались %s с" % timeout)
    try:
        rows = _read_rows(pool)
        key = rec.get("api_key") or ""
        if key:
            if any((r.get("api_key") or "") == key for r in rows if isinstance(r, dict)):
                return 0
        email = rec.get("email") or ""
        if email and any((r.get("email") or "") == email for r in rows if isinstance(r, dict)):
            # Тот же аккаунт с новым ключом: заменяем ключ, а не плодим строку.
            for r in rows:
                if isinstance(r, dict) and (r.get("email") or "") == email:
                    r["api_key"] = key or r.get("api_key")
                    r["balance"] = rec.get("balance", r.get("balance"))
                    r["balanceCheckedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z",
                                                          time.gmtime())
                    break
            _write_rows(pool, rows)
            return 1
        rows.insert(0, rec)
        _write_rows(pool, rows)
        return 1
    finally:
        try:
            os.close(fd)
            os.unlink(lock)
        except OSError:
            pass


def make_record(email, api_key, balance=None, balance_source="key",
                acc_id=None, note=None):
    """Запись в форме, которую читает ucLoad()."""
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    tag = (email or api_key or "uc")[-12:].replace("@", "_").replace(".", "_")
    rec = {
        "id": "uc_%d_%s" % (int(time.time() * 1000), tag),
        "email": email or "",
        "name": ("uc " + tag)[:40],
        "api_key": api_key or "",
        "active": True,
        # Не 'live': статус подтверждает хаб через ucProbe. Ложный 'live'
        # у мёртвого ключа портит ротацию сильнее, чем 'unknown'.
        "status": "unknown",
        "created": now,
        "balanceCheckedAt": now,
        "spent": 0,
    }
    if balance is not None:
        rec["balance"] = round(float(balance), 6)
        rec["balanceSource"] = balance_source
    if acc_id:
        rec["accountId"] = acc_id
    if note:
        rec["note"] = note
    return rec


if __name__ == "__main__":
    import sys

    if len(sys.argv) >= 3:
        email, key = sys.argv[1], sys.argv[2]
        bal = float(sys.argv[3]) if len(sys.argv) > 3 else None
        n = pool_append(make_record(email, key, bal))
        print(f"pool_append -> {n} (1=добавлен, 0=дубль)")
    else:
        rows = _read_rows(POOL_FILE)
        print(f"пул: {len(rows)} записей")
        for r in rows:
            k = r.get("api_key") or ""
            print(f"  {str(r.get('email'))[:30]:32} key={k[:22] or 'ПУСТО':24} "
                  f"active={r.get('active')} status={r.get('status')} "
                  f"bal={r.get('balance')}")
