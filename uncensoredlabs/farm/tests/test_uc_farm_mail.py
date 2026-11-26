"""Real-subprocess tests of the farm mail IPC seam, without a browser.

Each failing case names the client feature it needs:
- FarmMailClient(...)          -> real bounded read/ask/close
- on_log / on_stderr callbacks -> non-JSON diagnostics surfaced, not dropped
- stderr drained              -> pipe cannot deadlock on chatty children
- close(timeout)              -> reaps owned child, bounded, no wait() hang
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uc_farm_full as farm


class FarmMailIPCTests(unittest.TestCase):
    def child(self, source):
        proc = subprocess.Popen([sys.executable, "-u", "-c", source],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
        mb: dict[str, Any] = {"proc": proc}

        def cleanup():
            client = mb.get("client")
            if client:
                try:
                    client.close(timeout=0.5)
                except Exception:
                    pass
            if proc.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill.exe", "/PID", str(proc.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                else:
                    proc.kill()
            proc.wait(timeout=5)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream and not stream.closed:
                    stream.close()

        self.addCleanup(cleanup)
        return mb

    def client_of(self, mb, on_log=None):
        """Wrap the raw Popen the same way the farm now does."""
        from uc_mail_rpc import MailProcessClient
        mb["client"] = MailProcessClient(mb["proc"], on_log=on_log)
        self.addCleanup(lambda: mb["client"].close(timeout=0.5) if mb.get("client") else None)
        return mb["client"]

    def test_mail_diagnostics_reach_farm_output(self):
        source = ("import json,sys\n"
                  "req=json.loads(sys.stdin.readline())\n"
                  "print('wait_link: inbox HTTP 403',flush=True)\n"
                  "print(json.dumps({'ok':True,'link':'fixture'}),flush=True)\n")
        mb = self.child(source)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.client_of(mb, on_log=lambda line: print(line, flush=True))
            result = farm._mail_ask(mb, cmd="link", timeout=2)
            # The log callback is async: give the log thread a moment to run.
            time.sleep(0.3)
        self.assertEqual(result, {"ok": True, "link": "fixture"})
        self.assertIn("wait_link: inbox HTTP 403", out.getvalue())

    def test_silent_child_obeys_real_request_timeout(self):
        mb = self.child("import sys,time\nsys.stdin.readline()\ntime.sleep(5)\n")
        self.client_of(mb)
        result = []
        done = threading.Event()

        def ask():
            try:
                result.append(farm._mail_ask(mb, cmd="inbox", timeout=0.15))
            finally:
                done.set()

        worker = threading.Thread(target=ask, daemon=True)
        worker.start()
        self.assertTrue(done.wait(1.0), "readline blocked past request deadline")
        worker.join(timeout=1)
        self.assertFalse(result[0].get("ok"))
        self.assertTrue(result[0].get("error", "").lower().startswith("mail process response timed out"),
                        result[0].get("error"))

    def test_timeout_option_stays_client_side(self):
        source = ("import json,sys\n"
                  "req=json.loads(sys.stdin.readline())\n"
                  "print(json.dumps({'ok':True,'request':req}),flush=True)\n")
        mb = self.child(source)
        self.client_of(mb)
        result = farm._mail_ask(mb, cmd="inbox", timeout=2)
        self.assertEqual(result.get("request"), {"cmd": "inbox"})

    def test_mail_stop_reaps_owned_child(self):
        mb = self.child("import time\ntime.sleep(5)\n")
        self.client_of(mb)
        farm._mail_stop(mb)
        self.assertIsNotNone(mb["proc"].poll())


if __name__ == "__main__":
    unittest.main()
