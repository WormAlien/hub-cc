import json
from pathlib import Path
from typing import List

from .models import ProxyService


DEFAULT_SERVICES = [
    # Maintained APIs
    {
        "name": "ProxyScrape HTTP API",
        "url": "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ProxyScrape/proxyscrape-api",
    },
    {
        "name": "ProxyScrape SOCKS4 API",
        "url": "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=all",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ProxyScrape/proxyscrape-api",
    },
    {
        "name": "ProxyScrape SOCKS5 API",
        "url": "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ProxyScrape/proxyscrape-api",
    },
    {
        "name": "Proxy-List.download HTTP API",
        "url": "https://www.proxy-list.download/api/v1/get?type=http",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/proxy-list/proxy-list.github.io",
    },
    {
        "name": "Proxy-List.download HTTPS API",
        "url": "https://www.proxy-list.download/api/v1/get?type=https",
        "protocol": "HTTPS",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/proxy-list/proxy-list.github.io",
    },
    {
        "name": "Proxy-List.download SOCKS4 API",
        "url": "https://www.proxy-list.download/api/v1/get?type=socks4",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/proxy-list/proxy-list.github.io",
    },
    {
        "name": "Proxy-List.download SOCKS5 API",
        "url": "https://www.proxy-list.download/api/v1/get?type=socks5",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/proxy-list/proxy-list.github.io",
    },
    {
        "name": "GeoNode HTTP API",
        "url": "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http",
        "protocol": "HTTP",
        "parser": "geonode",
        "enabled": True,
        "origin_repo": "https://github.com/geonode/geonode",
    },
    {
        "name": "GeoNode HTTPS API",
        "url": "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=https",
        "protocol": "HTTPS",
        "parser": "geonode",
        "enabled": True,
        "origin_repo": "https://github.com/geonode/geonode",
    },
    {
        "name": "GeoNode SOCKS5 API",
        "url": "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5",
        "protocol": "SOCKS5",
        "parser": "geonode",
        "enabled": True,
        "origin_repo": "https://github.com/geonode/geonode",
    },
    {
        "name": "GeoNode SOCKS4 API",
        "url": "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks4",
        "protocol": "SOCKS4",
        "parser": "geonode",
        "enabled": True,
        "origin_repo": "https://github.com/geonode/geonode",
    },
    # High-quality GitHub lists
    {
        "name": "iPlocate HTTP",
        "url": "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/iplocate/free-proxy-list",
    },
    {
        "name": "iPlocate HTTPS",
        "url": "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/https.txt",
        "protocol": "HTTPS",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/iplocate/free-proxy-list",
    },
    {
        "name": "iPlocate SOCKS4",
        "url": "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks4.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/iplocate/free-proxy-list",
    },
    {
        "name": "iPlocate SOCKS5",
        "url": "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/iplocate/free-proxy-list",
    },
    {
        "name": "Proxifly HTTP",
        "url": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/proxifly/free-proxy-list",
    },
    {
        "name": "Proxifly SOCKS4",
        "url": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks4/data.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/proxifly/free-proxy-list",
    },
    {
        "name": "Proxifly SOCKS5",
        "url": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/proxifly/free-proxy-list",
    },
    {
        "name": "TheSpeedX HTTP",
        "url": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/TheSpeedX/PROXY-List",
    },
    {
        "name": "TheSpeedX SOCKS4",
        "url": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/TheSpeedX/PROXY-List",
    },
    {
        "name": "TheSpeedX SOCKS5",
        "url": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/TheSpeedX/PROXY-List",
    },
    {
        "name": "monosans HTTP",
        "url": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/monosans/proxy-list",
    },
    {
        "name": "monosans SOCKS4",
        "url": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/monosans/proxy-list",
    },
    {
        "name": "monosans SOCKS5",
        "url": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/monosans/proxy-list",
    },
    {
        "name": "ShiftyTR HTTP",
        "url": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ShiftyTR/Proxy-List",
    },
    {
        "name": "ShiftyTR HTTPS",
        "url": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt",
        "protocol": "HTTPS",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ShiftyTR/Proxy-List",
    },
    {
        "name": "ShiftyTR SOCKS4",
        "url": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ShiftyTR/Proxy-List",
    },
    {
        "name": "ShiftyTR SOCKS5",
        "url": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ShiftyTR/Proxy-List",
    },
    {
        "name": "jetkai HTTP",
        "url": "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/jetkai/proxy-list",
    },
    {
        "name": "jetkai HTTPS",
        "url": "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-https.txt",
        "protocol": "HTTPS",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/jetkai/proxy-list",
    },
    {
        "name": "jetkai SOCKS4",
        "url": "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks4.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/jetkai/proxy-list",
    },
    {
        "name": "jetkai SOCKS5",
        "url": "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/jetkai/proxy-list",
    },
    {
        "name": "mmpx12 HTTP",
        "url": "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/mmpx12/proxy-list",
    },
    {
        "name": "mmpx12 HTTPS",
        "url": "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt",
        "protocol": "HTTPS",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/mmpx12/proxy-list",
    },
    {
        "name": "mmpx12 SOCKS4",
        "url": "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/mmpx12/proxy-list",
    },
    {
        "name": "mmpx12 SOCKS5",
        "url": "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/mmpx12/proxy-list",
    },
    {
        "name": "prxchk HTTP",
        "url": "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/prxchk/proxy-list",
    },
    {
        "name": "prxchk SOCKS4",
        "url": "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks4.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/prxchk/proxy-list",
    },
    {
        "name": "prxchk SOCKS5",
        "url": "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/prxchk/proxy-list",
    },
    {
        "name": "ClearProxy Checked HTTP",
        "url": "https://raw.githubusercontent.com/ClearProxy/checked-proxy-list/main/http/raw/all.txt",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ClearProxy/checked-proxy-list",
    },
    {
        "name": "ClearProxy Checked SOCKS4",
        "url": "https://raw.githubusercontent.com/ClearProxy/checked-proxy-list/main/socks4/raw/all.txt",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ClearProxy/checked-proxy-list",
    },
    {
        "name": "ClearProxy Checked SOCKS5",
        "url": "https://raw.githubusercontent.com/ClearProxy/checked-proxy-list/main/socks5/raw/all.txt",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/ClearProxy/checked-proxy-list",
    },
    # HTML lists
    {
        "name": "free-proxy-list.net HTTP",
        "url": "https://free-proxy-list.net/",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/clarketm/proxy-list",
    },
    {
        "name": "free-proxy-list.net HTTPS",
        "url": "https://free-proxy-list.net/",
        "protocol": "HTTPS",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/clarketm/proxy-list",
    },
    {
        "name": "sslproxies.org HTTP",
        "url": "https://www.sslproxies.org/",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/clarketm/proxy-list",
    },
    {
        "name": "sslproxies.org HTTPS",
        "url": "https://www.sslproxies.org/",
        "protocol": "HTTPS",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/clarketm/proxy-list",
    },
    {
        "name": "us-proxy.org HTTP",
        "url": "https://www.us-proxy.org/",
        "protocol": "HTTP",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/iw4p/proxy-scraper",
    },
    {
        "name": "us-proxy.org HTTPS",
        "url": "https://www.us-proxy.org/",
        "protocol": "HTTPS",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/iw4p/proxy-scraper",
    },
    {
        "name": "socks-proxy.net SOCKS4",
        "url": "https://www.socks-proxy.net/",
        "protocol": "SOCKS4",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/iw4p/proxy-scraper",
    },
    {
        "name": "socks-proxy.net SOCKS5",
        "url": "https://www.socks-proxy.net/",
        "protocol": "SOCKS5",
        "parser": "regex",
        "enabled": True,
        "origin_repo": "https://github.com/iw4p/proxy-scraper",
    },
]


def _default_objects() -> List[ProxyService]:
    return [ProxyService(**item) for item in DEFAULT_SERVICES]


def ensure_services_file(path: str) -> None:
    file_path = Path(path)
    if file_path.exists():
        return
    file_path.write_text(
        json.dumps(DEFAULT_SERVICES, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_services(path: str) -> List[ProxyService]:
    ensure_services_file(path)
    file_path = Path(path)
    try:
        raw = json.loads(file_path.read_text(encoding="utf-8-sig"))
    except Exception:
        return _default_objects()

    if not isinstance(raw, list):
        return _default_objects()

    result: List[ProxyService] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "")).strip()
        url = str(item.get("url", "")).strip()
        protocol = str(item.get("protocol", "")).strip().upper()
        parser = str(item.get("parser", "regex")).strip().lower()
        enabled = bool(item.get("enabled", True))
        origin_repo = str(item.get("origin_repo", "")).strip()
        if not name or not url or protocol not in {"HTTP", "HTTPS", "SOCKS4", "SOCKS5", "MIXED"}:
            continue
        if parser not in {"regex", "geonode"}:
            parser = "regex"
        result.append(
            ProxyService(
                name=name,
                url=url,
                protocol=protocol,
                parser=parser,
                enabled=enabled,
                origin_repo=origin_repo,
            )
        )

    return result or _default_objects()
