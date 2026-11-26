"""Focused regression tests for the existing SmailPro mail reader.

All test mail bodies are fixtures. No browser, signup or network is started.
Run with the farm venv: python -m unittest discover -s tests -v
"""
import contextlib
import io
import sys
import time as real_time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uc_mail_smailpro as mail


class Clock:
    def __init__(self):
        self.now = 0.0

    def time(self):
        return self.now

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

    def strftime(self, fmt):
        return real_time.strftime(fmt)


class ScriptedBox(mail.SmailproBox):
    def __init__(self, bodies):
        super().__init__()
        self.bodies = list(bodies)
        self.reads = 0

    def inbox(self):
        return {"status": 200, "count": 1,
                "msgs": [{"mid": "fixture-mid", "from": "UncensoredLabs",
                          "subject": "Verify your email address"}]}

    def message(self, mid):
        self.reads += 1
        outcome = self.bodies.pop(0) if len(self.bodies) > 1 else self.bodies[0]
        if isinstance(outcome, Exception):
            raise outcome
        return {"status": 200, "body": outcome}


class LinkTests(unittest.TestCase):
    def test_verification_url_in_href_survives_html(self):
        url = ("https://uncensoredlabs.dev/api/auth/verify-email"
               "?token=fixture&callbackURL=%2Flogin")
        body = '<a href="' + url.replace("&", "&amp;") + '">Verify email</a>'
        box = ScriptedBox([body])
        with patch.object(mail, "time", Clock()), contextlib.redirect_stdout(io.StringIO()):
            found = box.wait_link(deadline=20)
        self.assertEqual(found, url)

    def test_transient_body_error_does_not_blacklist_message(self):
        url = "https://uncensoredlabs.dev/api/auth/verify-email?token=fixture"
        box = ScriptedBox([RuntimeError("temporary fetch failure"), url])
        with patch.object(mail, "time", Clock()), contextlib.redirect_stdout(io.StringIO()):
            found = box.wait_link(deadline=25)
        self.assertEqual(found, url)
        self.assertEqual(box.reads, 2)

    def test_empty_body_is_retried(self):
        url = "https://uncensoredlabs.dev/api/auth/verify-email?token=fixture"
        box = ScriptedBox(["", url])
        with patch.object(mail, "time", Clock()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(box.wait_link(deadline=25), url)
        self.assertEqual(box.reads, 2)

    def test_spam_url_is_not_a_verification_link(self):
        box = ScriptedBox(['<a href="https://mapleworld2.com/activate">Account activation</a>'])
        with patch.object(mail, "time", Clock()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(box.wait_link(deadline=25), "")
        self.assertEqual(box.reads, 1)

    def test_provider_name_in_foreign_url_is_not_accepted(self):
        urls = ("https://evil.example/uncensoredlabs.dev/verify",
                "https://uncensoredlabs.dev.evil.example/verify",
                "https://evil.example/?provider=uncensoredlabs")
        for url in urls:
            with self.subTest(url=url):
                box = ScriptedBox([url])
                with patch.object(mail, "time", Clock()), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(box.wait_link(deadline=20), "")


class CodeTests(unittest.TestCase):
    def test_code_read_retries_after_transient_error(self):
        box = ScriptedBox([RuntimeError("temporary fetch failure"), "Verification code: A7B8C9"])
        with patch.object(mail, "time", Clock()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(box.wait_code(deadline=25), "A7B8C9")
        self.assertEqual(box.reads, 2)

    def test_code_read_retries_empty_body(self):
        box = ScriptedBox(["", "Verification code: A7B8C9"])
        with patch.object(mail, "time", Clock()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(box.wait_code(deadline=25), "A7B8C9")
        self.assertEqual(box.reads, 2)

    def test_code_value_is_not_written_to_diagnostics(self):
        box = ScriptedBox(["Verification code: A7B8C9"])
        output = io.StringIO()
        with patch.object(mail, "time", Clock()), contextlib.redirect_stdout(output):
            self.assertEqual(box.wait_code(deadline=25), "A7B8C9")
        self.assertNotIn("A7B8C9", output.getvalue())


class PayloadPage:
    url = mail.SMAILPRO

    def __init__(self):
        self.refreshes = 0

    def evaluate(self, script, arg):
        if script == mail.GET_PAYLOAD_JS:
            self.refreshes += 1
            return {"payload": "fresh"}
        if arg.get("payload") != "fresh":
            return {"status": 403, "count": 0, "msgs": [], "body": ""}
        if script == mail.FETCH_INBOX_JS:
            return {"status": 200, "count": 0, "msgs": []}
        return {"status": 200, "body": "fixture"}


class PayloadTests(unittest.TestCase):
    def test_inbox_renews_payload_before_each_poll(self):
        box = mail.SmailproBox()
        box.pg = PayloadPage()
        box.triple = {"address": "fixture@gmail.com", "timestamp": "fixture", "key": "fixture"}
        box.kind = "temp_gmail"
        for _ in range(2):
            box.payload = "expired"
            self.assertEqual(box.inbox()["status"], 200)
        self.assertEqual(box.pg.refreshes, 2)

    def test_message_renews_payload_before_read(self):
        box = mail.SmailproBox()
        box.pg = PayloadPage()
        box.triple = {"address": "fixture@gmail.com", "timestamp": "fixture", "key": "fixture"}
        box.kind = "temp_gmail"
        box.payload = "expired"
        self.assertEqual(box.message("fixture-mid")["body"], "fixture")
        self.assertEqual(box.pg.refreshes, 1)

    def test_payload_refresh_failure_never_reuses_old_payload(self):
        box = mail.SmailproBox()
        box.pg = PayloadPage()
        box.pg.evaluate = lambda script, arg: {"status": 403, "error": "payload denied"}
        box.triple = {"address": "fixture@gmail.com", "timestamp": "fixture", "key": "fixture"}
        box.payload = "expired"
        with self.assertRaisesRegex(RuntimeError, "payload"):
            box.refresh_payload()
        self.assertIsNone(box.payload)

    def test_http_error_is_not_a_successful_empty_inbox(self):
        class DeniedPage(PayloadPage):
            def evaluate(self, script, arg):
                if script == mail.GET_PAYLOAD_JS:
                    return {"payload": "fresh"}
                return {"status": 403, "count": 0, "msgs": []}

        box = mail.SmailproBox()
        box.pg = DeniedPage()
        box.triple = {"address": "fixture@gmail.com", "timestamp": "fixture", "key": "fixture"}
        box.kind = "temp_gmail"
        with self.assertRaisesRegex(RuntimeError, "inbox.*403"):
            box.inbox()

    def test_http_error_is_not_a_successful_empty_message(self):
        class DeniedPage(PayloadPage):
            def evaluate(self, script, arg):
                if script == mail.GET_PAYLOAD_JS:
                    return {"payload": "fresh"}
                return {"status": 503, "body": ""}

        box = mail.SmailproBox()
        box.pg = DeniedPage()
        box.triple = {"address": "fixture@gmail.com", "timestamp": "fixture", "key": "fixture"}
        box.kind = "temp_gmail"
        with self.assertRaisesRegex(RuntimeError, "message.*503"):
            box.message("fixture-mid")


if __name__ == "__main__":
    unittest.main()
