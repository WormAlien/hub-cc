"""Regression tests for the narrow AgentRouter proxy validation path.

Runner: stdlib unittest, no third-party dependency.

    cd tools/proxy-validator
    python -m unittest discover -s tests -t .
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from proxy_scraper.agentrouter_stability import run_stability
from proxy_scraper.domain_checker import DomainProxyChecker
from proxy_scraper.domain_mode import load_targets
from proxy_scraper.models import ProxyRecord
from proxy_scraper.proxy_io import parse_proxy_line


class TargetsLoadingTest(unittest.TestCase):
    def test_broken_json_fails_fast_with_path_and_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "domain_targets.json"
            path.write_bytes(b"\xd0\xb9[\n]\n")

            with self.assertRaises(ValueError) as ctx:
                load_targets(str(path))

            message = str(ctx.exception)
            self.assertIn("domain_targets.json", message)
            self.assertIn("invalid JSON", message)

    def test_agentrouter_target_keeps_response_kind(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "domain_targets.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "name": "agentrouter_status",
                            "url": "https://agentrouter.org/api/status",
                            "enabled": True,
                            "response": "newapi_status",
                        }
                    ]
                ),
                encoding="utf-8",
            )

            targets = load_targets(str(path))

            self.assertEqual(len(targets), 1)
            self.assertEqual(targets[0].response, "newapi_status")
            self.assertEqual(targets[0].host, "agentrouter.org")
            self.assertEqual(targets[0].path, "/api/status")
            self.assertEqual(targets[0].port, 443)

    def test_repo_config_targets_agentrouter_status_only(self) -> None:
        config_path = Path(__file__).resolve().parents[1] / "config" / "domain_targets.json"

        targets = load_targets(str(config_path))

        self.assertEqual([target.name for target in targets], ["agentrouter_status"])
        self.assertEqual(targets[0].response, "newapi_status")


class NewapiStatusCriterionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.checker = DomainProxyChecker()

    def test_success_matrix(self) -> None:
        cases = [
            (200, '{"success":true,"data":{"quota":1}}', True),
            (200, '{"data":{"quota":1}}', True),
            (200, "", False),
            (200, "   ", False),
            (200, "<html><body>Attention Required</body></html>", False),
            (200, "<!DOCTYPE html>", False),
            (200, "not json at all", False),
            (200, '{"success":true,"data":{', False),
            (200, '{"success":false,"data":{}}', False),
            (200, '{"success":true}', False),
            (200, '{"success":true,"data":[]}', False),
            (200, '[{"success":true,"data":{}}]', False),
            (403, '{"success":true,"data":{}}', False),
            (404, '{"success":true,"data":{}}', False),
            (429, '{"success":true,"data":{}}', False),
            (0, '{"success":true,"data":{}}', False),
        ]

        for status, body, expected in cases:
            with self.subTest(status=status, body=body[:24]):
                self.assertIs(
                    self.checker.is_success_response(status, body, "newapi_status"),
                    expected,
                )

    def test_generic_target_keeps_status_only_semantics(self) -> None:
        self.assertIs(self.checker.is_success_response(200, "", "html"), True)
        self.assertIs(self.checker.is_success_response(403, "", "html"), True)
        self.assertIs(self.checker.is_success_response(407, "", "html"), False)
        self.assertIs(self.checker.is_success_response(500, "", "html"), False)

    def test_parse_http_response_returns_status_and_body(self) -> None:
        raw = 'HTTP/1.1 200 OK\r\nContent-Length: 26\r\n\r\n{"success":true,"data":{}}'

        status, body = self.checker.parse_http_response(raw)

        self.assertEqual(status, 200)
        self.assertEqual(body, '{"success":true,"data":{}}')

    def test_parse_http_response_decodes_chunked_body(self) -> None:
        raw = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json\r\n"
            "Transfer-Encoding: chunked\r\n\r\n"
            '10\r\n{"success":true,\r\n'
            'a\r\n"data":{}}\r\n'
            "0\r\n\r\n"
        )

        status, body = self.checker.parse_http_response(raw)

        self.assertEqual(status, 200)
        self.assertEqual(body, '{"success":true,"data":{}}')

    def test_parse_http_response_survives_missing_body(self) -> None:
        status, body = self.checker.parse_http_response("HTTP/1.1 429 Too Many Requests\r\n\r\n")

        self.assertEqual(status, 429)
        self.assertEqual(body, "")


class HostnameParsingTest(unittest.TestCase):
    def test_accepts_ipv4_hostname_and_credentials(self) -> None:
        cases = [
            ("203.0.113.10:8080", "203.0.113.10", 8080, "", ""),
            ("http://203.0.113.10:8080", "203.0.113.10", 8080, "", ""),
            ("gate.provider.com:7000", "gate.provider.com", 7000, "", ""),
            ("http://gate.provider.com:7000", "gate.provider.com", 7000, "", ""),
            ("http://user:pass@gate.provider.com:7000", "gate.provider.com", 7000, "user", "pass"),
            ("gate.provider.com:7000:user:pass", "gate.provider.com", 7000, "user", "pass"),
            ("user:pass@gate.provider.com:7000", "gate.provider.com", 7000, "user", "pass"),
        ]

        for line, host, port, user, password in cases:
            with self.subTest(line=line):
                record = parse_proxy_line(line, "test", default_protocol="HTTP")
                self.assertIsNotNone(record, line)
                assert record is not None
                self.assertEqual(record.ip, host)
                self.assertEqual(record.port, port)
                self.assertEqual(record.username, user)
                self.assertEqual(record.password, password)

    def test_mixed_scheme_is_preserved_per_line(self) -> None:
        cases = [
            ("socks5://gate.provider.com:1080", "SOCKS5"),
            ("socks4://203.0.113.10:1080", "SOCKS4"),
            ("https://203.0.113.10:443", "HTTPS"),
        ]

        for line, protocol in cases:
            with self.subTest(line=line):
                record = parse_proxy_line(line, "test", default_protocol="HTTP")
                self.assertIsNotNone(record)
                assert record is not None
                self.assertEqual(record.protocol, protocol)

    def test_rejects_invalid_hostnames(self) -> None:
        bad_lines = [
            "-bad.example:7000",
            "bad-.example:7000",
            "bad..example:7000",
            "bad_host.example:7000",
            "justtext",
            "gate.provider.com:0",
            "gate.provider.com:70000",
            f"{'a' * 250}.example.com:8080",
        ]

        for line in bad_lines:
            with self.subTest(line=line):
                self.assertIsNone(parse_proxy_line(line, "test", default_protocol="HTTP"))


def _record(host: str, latency: float = 10.0, port: int = 8080, protocol: str = "HTTP") -> ProxyRecord:
    return ProxyRecord(
        ip=host,
        port=port,
        protocol=protocol,
        source="mock",
        working=True,
        latency_ms=latency,
    )


class StabilityPipelineTest(unittest.TestCase):
    def test_three_passes_write_stable_file_and_report(self) -> None:
        records = [_record("203.0.113.10", 10.0), _record("gate.example", 30.0)]
        seen_passes: list[list[str]] = []
        slept: list[float] = []

        def check_pass(candidates, pass_index):  # noqa: ARG001 - contract check
            seen_passes.append([record.address for record in candidates])
            return list(candidates)

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "agentrouter"
            report = run_stability(
                records,
                check_pass=check_pass,
                output_dir=out,
                source_urls=["mock://source"],
                sleep_fn=slept.append,
            )

            self.assertEqual(len(seen_passes), 3)
            self.assertEqual(report["passes"], 3)
            self.assertEqual(report["stable_count"], 2)
            self.assertEqual(report["source_urls"], ["mock://source"])
            self.assertEqual(
                (out / "stable.txt").read_text(encoding="utf-8").splitlines(),
                ["http://203.0.113.10:8080", "http://gate.example:8080"],
            )
            saved = json.loads((out / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["passes"], 3)
            self.assertEqual(saved["latency_ms"]["p50"], 10.0)
            self.assertEqual(saved["latency_ms"]["p95"], 30.0)
            self.assertEqual(list((out).glob("*.tmp")), [])

        self.assertEqual(len(slept), 2)
        for waited in slept:
            self.assertGreaterEqual(waited, 20)
            self.assertLessEqual(waited, 30)

    def test_only_proxies_passing_all_three_passes_survive(self) -> None:
        stable = _record("203.0.113.10", 10.0)
        flaky = _record("203.0.113.20", 12.0)

        def check_pass(candidates, pass_index):
            if pass_index == 2:
                return [rec for rec in candidates if rec.ip != "203.0.113.20"]
            return list(candidates)

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "agentrouter"
            report = run_stability(
                [stable, flaky],
                check_pass=check_pass,
                output_dir=out,
                sleep_fn=lambda _seconds: None,
            )

            self.assertEqual(report["stable_count"], 1)
            self.assertEqual(
                (out / "stable.txt").read_text(encoding="utf-8").splitlines(),
                ["http://203.0.113.10:8080"],
            )
            self.assertEqual(report["failures"]["203.0.113.20:8080"], "failed pass 3")

    def test_pool_caps_two_per_24_and_one_per_hostname_port(self) -> None:
        records = [
            _record("203.0.113.10", 30.0),
            _record("203.0.113.11", 10.0),
            _record("203.0.113.12", 20.0),
            _record("198.51.100.7", 40.0),
            _record("gate.example", 9.0),
            _record("gate.example", 2.0),
        ]

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "agentrouter"
            report = run_stability(
                records,
                check_pass=lambda candidates, pass_index: list(candidates),
                output_dir=out,
                sleep_fn=lambda _seconds: None,
            )

            lines = (out / "stable.txt").read_text(encoding="utf-8").splitlines()
            self.assertEqual(
                lines,
                [
                    "http://gate.example:8080",
                    "http://203.0.113.11:8080",
                    "http://203.0.113.12:8080",
                    "http://198.51.100.7:8080",
                ],
            )
            self.assertEqual(report["stable_count"], 4)
            self.assertEqual(report["dropped_by_subnet"], 1)

    def test_interrupt_saves_report_without_stable_file(self) -> None:
        def check_pass(candidates, pass_index):
            if pass_index == 2:
                raise KeyboardInterrupt
            return list(candidates)

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "agentrouter"
            report = run_stability(
                [_record("203.0.113.10", 10.0)],
                check_pass=check_pass,
                output_dir=out,
                sleep_fn=lambda _seconds: None,
            )

            self.assertTrue(report["interrupted"])
            self.assertEqual(report["passes"], 1)
            self.assertTrue((out / "report.json").exists())
            self.assertFalse((out / "stable.txt").exists())

    def test_candidate_cap_limits_live_load(self) -> None:
        records = [_record(f"203.0.{index}.10", 10.0) for index in range(20)]

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "agentrouter"
            report = run_stability(
                records,
                check_pass=lambda candidates, pass_index: list(candidates),
                output_dir=out,
                cap=5,
                sleep_fn=lambda _seconds: None,
            )

            self.assertEqual(report["candidates"], 5)
            self.assertEqual(report["cap"], 5)


class UnresolvedProtocolTest(unittest.TestCase):
    """A bare ip:port keeps protocol AUTO, which no tunnel can dial."""

    def test_auto_records_never_reach_stable_list(self) -> None:
        records = [
            ProxyRecord(ip="203.0.113.20", port=8080, protocol="AUTO", source="test"),
            ProxyRecord(ip="203.0.113.21", port=1080, protocol="SOCKS5", source="test"),
        ]

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "agentrouter"
            report = run_stability(
                records,
                check_pass=lambda candidates, pass_index: list(candidates),
                output_dir=out,
                sleep_fn=lambda _seconds: None,
            )

            stable = (out / "stable.txt").read_text(encoding="utf-8")
            self.assertNotIn("auto://", stable)
            self.assertIn("socks5://203.0.113.21:1080", stable)
            self.assertIn("203.0.113.20:8080", report["failures"])
            self.assertIn("protocol", report["failures"]["203.0.113.20:8080"])


class StabilityDefaultsTest(unittest.TestCase):
    def test_default_protocol_is_dialable(self) -> None:
        from proxy_scraper import agentrouter_stability as mod

        args = mod.parse_args([])

        self.assertIn(args.default_protocol.upper(), {"HTTP", "HTTPS", "SOCKS4", "SOCKS5"})

    def test_cli_defaults_match_handoff_limits(self) -> None:
        from proxy_scraper import agentrouter_stability as mod

        args = mod.parse_args([])

        self.assertEqual(args.cap, 500)
        self.assertEqual(args.workers, 40)
        self.assertEqual(args.timeout, 8)
        self.assertEqual(args.passes, 3)
        self.assertGreaterEqual(args.interval, 20)
        self.assertLessEqual(args.interval, 30)


class ServicesConfigTest(unittest.TestCase):
    def test_three_new_sources_present_without_duplicates(self) -> None:
        from proxy_scraper.services import load_services

        config_path = Path(__file__).resolve().parents[1] / "config" / "proxy_services.json"
        services = load_services(str(config_path))
        urls = [service.url for service in services]

        expected = {
            "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt": "MIXED",
            "https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/all.txt": "MIXED",
            "https://raw.githubusercontent.com/dinoz0rg/proxy-list/main/checked_proxies/http.txt": "HTTP",
        }

        self.assertEqual(len(urls), len(set(urls)), "duplicate source URLs in config")
        for url, protocol in expected.items():
            with self.subTest(url=url):
                match = [service for service in services if service.url == url]
                self.assertEqual(len(match), 1, f"missing source {url}")
                self.assertEqual(match[0].protocol, protocol)

    def test_mixed_source_keeps_per_line_scheme(self) -> None:
        from proxy_scraper.models import ProxyService
        from proxy_scraper.scraper import ProxyScraper

        service = ProxyService(name="mixed", url="mock://mixed", protocol="MIXED", parser="regex")
        scraper = ProxyScraper([service])
        text = "\n".join(
            [
                "http://203.0.113.10:8080",
                "socks5://203.0.113.11:1080",
                "socks4://203.0.113.12:1080",
                "https://203.0.113.13:443",
                "203.0.113.14:3128",
            ]
        )

        scraper._parse_regex(text, service)
        found = {f"{rec.protocol}|{rec.address}" for rec in scraper._items.values()}

        self.assertIn("HTTP|203.0.113.10:8080", found)
        self.assertIn("SOCKS5|203.0.113.11:1080", found)
        self.assertIn("SOCKS4|203.0.113.12:1080", found)
        self.assertIn("HTTPS|203.0.113.13:443", found)
        self.assertIn("HTTP|203.0.113.14:3128", found)


if __name__ == "__main__":
    unittest.main()
