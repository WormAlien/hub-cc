import urllib.request, urllib.error, json, sys, ssl

BASE = "https://api.wisdomsatan.club"

def call(method, path, body=None, headers=None, raw=False):
    url = BASE + path
    data = None
    h = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    if body is not None:
        if raw:
            data = body.encode("utf-8")
        else:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=30)
        status = r.status
        raw_hdrs = dict(r.getheaders())
        payload = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status = e.code
        raw_hdrs = dict(e.headers.items())
        payload = e.read().decode("utf-8", "replace")
    except Exception as e:
        print("EXC", type(e).__name__, e)
        return None
    print("=== %s %s -> %s ===" % (method, path, status))
    sc = raw_hdrs.get("Set-Cookie")
    if sc:
        print("SET-COOKIE:", sc)
    print(payload[:2000])
    print()
    return status, raw_hdrs, payload

if __name__ == "__main__":
    # probe list passed as argv marker
    marker = sys.argv[1] if len(sys.argv) > 1 else "register"
    if marker == "register_empty":
        call("POST", "/api/user/register", {})
    elif marker == "register_probes":
        # only username, no password
        call("POST", "/api/user/register", {"username": "probetest_zzz"})
        # short password
        call("POST", "/api/user/register", {"username": "probetest_zzz", "password": "a"})
        call("POST", "/api/user/register", {"username": "probetest_zzz", "password": "ab"})
        call("POST", "/api/user/register", {"username": "probetest_zzz", "password": "abcde"})
        call("POST", "/api/user/register", {"username": "probetest_zzz", "password": "abcdef"})
        call("POST", "/api/user/register", {"username": "probetest_zzz", "password": "abcdefg"})
