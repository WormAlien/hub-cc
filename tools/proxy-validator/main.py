#!/usr/bin/env python3
import argparse
import sys

from proxy_scraper.domain_mode import main as domain_main
from proxy_scraper.dolphin_mode import main as dolphin_main
from proxy_scraper.public_mode import main as public_main
from proxy_scraper.valid_mode import main as valid_main


def _choose_mode() -> str:
    print()
    print("Choose mode:")
    print("  1) Scrape public proxies -> export/proxies.txt")
    print("  2) Check export/proxies.txt -> export/protocols/http.txt, https.txt, socks4.txt, socks5.txt")
    print("  3) Check export/protocols/* -> export/domains/*.txt + export/all_valid.txt")
    print("  4) Dolphin-style check export/proxies.txt -> export/dolphin_proxy/*")
    value = input("Mode [1]: ").strip()
    return value if value in {"2", "3", "4"} else "1"


def _parse_entry_args(argv: list[str]) -> tuple[str, list[str]]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--mode", choices=["1", "2", "3", "4"], default="")
    ns, rest = parser.parse_known_args(argv)
    mode = ns.mode or _choose_mode()
    return mode, rest


if __name__ == "__main__":
    mode, rest = _parse_entry_args(sys.argv[1:])
    if mode == "2":
        raise SystemExit(valid_main(rest))
    if mode == "3":
        raise SystemExit(domain_main(rest))
    if mode == "4":
        raise SystemExit(dolphin_main(rest))
    raise SystemExit(public_main(rest))
