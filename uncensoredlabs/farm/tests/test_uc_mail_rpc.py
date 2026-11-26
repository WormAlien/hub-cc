"""Real subprocess tests for the generic JSON-lines mail transport.

No browser, network, registration, or real credentials are involved.
"""
import base64
import os
import subprocess
import sys
import textwrap
import threading
import time
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from uc_mail_rpc import MailProcessClient

FIXTURE_MARKER = "uc-mail-rpc-transport-fixture"


class MailProcessClientTests(unittest.TestCase):
    def start_client(self, source, on_log=None):
        proc = subprocess.Popen(
            [sys.executable, "-u", "-c", textwrap.dedent(source), FIXTURE_MARKER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        self.addCleanup(self.reap, proc)
        client = MailProcessClient(proc, on_log=on_log)
        self.addCleanup(self.close_client, client)
        return client, proc

    def close_client(self, client):
        client.close(1)
        self.assertIsNotNone(client.proc.poll(), "client child was not reaped")
        self.assertTrue(all(stream.closed for stream in
                            (client.proc.stdin, client.proc.stdout, client.proc.stderr)),
                        "client pipe was not closed")
        self.assertFalse(any(thread.is_alive() for thread in
                             [client._writer, *client._readers, client._logger]),
                         "client left a transport thread running")

    def reap(self, proc):
        if proc.poll() is None:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill.exe", "/PID", str(proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=2, check=False,
                )
            else:
                proc.kill()
        proc.wait(timeout=2)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                stream.close()
        self.assertIsNotNone(proc.poll(), "test child was not reaped")

    def test_json_reply_and_request_roundtrip(self):
        client, proc = self.start_client("""
            import json, sys
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                print(json.dumps({"ok": True, "echo": request}), flush=True)
        """)
        self.assertEqual(client.read_response(2), {"ok": True, "ready": True})
        request = {"cmd": "echo", "value": "fixture"}
        self.assertEqual(client.ask(request, timeout=2), {"ok": True, "echo": request})

    def test_interleaved_diagnostics_are_delivered_even_while_idle(self):
        logs = []
        stdout_seen = threading.Event()
        stderr_seen = threading.Event()

        def log(line):
            logs.append(line)
            if "idle stdout fixture" in line:
                stdout_seen.set()
            if "idle stderr fixture" in line:
                stderr_seen.set()

        client, proc = self.start_client("""
            import json, sys, time
            print("before reply fixture", flush=True)
            print(json.dumps({"ok": True}), flush=True)
            time.sleep(0.08)
            print("idle stdout fixture", flush=True)
            print("idle stderr fixture", file=sys.stderr, flush=True)
            for line in sys.stdin:
                if json.loads(line).get("cmd") == "quit":
                    break
        """, on_log=log)
        self.assertEqual(client.read_response(2), {"ok": True})
        self.assertTrue(stdout_seen.wait(0.8), "idle stdout diagnostic was lost")
        self.assertTrue(stderr_seen.wait(0.8), "idle stderr diagnostic was lost")
        self.assertIn("[stdout] before reply fixture", logs)
        self.assertIn("[stdout] idle stdout fixture", logs)
        self.assertIn("[stderr] idle stderr fixture", logs)

    def test_silent_child_obeys_read_deadline(self):
        client, proc = self.start_client("""
            import json, time
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            time.sleep(30)
        """)
        client.read_response(2)
        errors = []

        def read():
            try:
                client.read_response(0.12)
            except Exception as error:
                errors.append(error)

        started = time.monotonic()
        caller = threading.Thread(target=read, daemon=True)
        caller.start()
        caller.join(0.7)
        hung = caller.is_alive()
        if hung:
            self.reap(proc)
            caller.join(2)
        self.assertFalse(hung, "read_response ignored its monotonic deadline")
        self.assertLess(time.monotonic() - started, 0.7)
        self.assertTrue(errors and isinstance(errors[0], TimeoutError),
                        "silence must raise TimeoutError")

    def test_late_response_after_timeout_cannot_satisfy_another_request(self):
        client, proc = self.start_client("""
            import json, sys, time
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                time.sleep(0.3)
                print(json.dumps({"ok": True, "reply": request.get("id")}), flush=True)
        """)
        client.read_response(2)
        with self.assertRaises(TimeoutError):
            client.ask({"id": "first"}, timeout=0.08)
        time.sleep(0.35)
        with self.assertRaisesRegex(RuntimeError, "poison"):
            client.ask({"id": "second"}, timeout=0.5)
        with self.assertRaisesRegex(RuntimeError, "poison"):
            client.read_response(0.5)

    def test_invalid_json_reply_poisoning_is_not_skipped_as_a_log(self):
        client, proc = self.start_client("""
            import json, sys
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                print('{"ok": broken}', flush=True)
                print(json.dumps({"ok": True}), flush=True)
        """)
        client.read_response(2)
        with self.assertRaisesRegex(RuntimeError, "protocol"):
            client.ask({"cmd": "fixture"}, timeout=1)
        with self.assertRaisesRegex(RuntimeError, "poison"):
            client.ask({"cmd": "retry"}, timeout=1)

    def test_process_exit_and_stdout_eof_are_prompt_and_poisoned(self):
        client, proc = self.start_client("""
            import json, sys
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            sys.exit(7)
        """)
        self.assertEqual(client.read_response(2), {"ok": True, "ready": True})
        started = time.monotonic()
        with self.assertRaises(EOFError):
            client.read_response(2)
        self.assertLess(time.monotonic() - started, 0.7)
        with self.assertRaisesRegex(RuntimeError, "poison"):
            client.ask({"cmd": "retry"}, timeout=1)


    def test_concurrent_asks_are_serialized_through_the_reply(self):
        client, proc = self.start_client("""
            import json, queue, sys, threading, time
            requests = queue.Queue()
            def read():
                for line in sys.stdin:
                    requests.put(json.loads(line))
            threading.Thread(target=read, daemon=True).start()
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            while True:
                request = requests.get()
                if request.get("cmd") == "quit":
                    break
                time.sleep(0.15)
                print(json.dumps({"echo": request["id"],
                                  "pipelined": not requests.empty()}), flush=True)
        """)
        client.read_response(2)
        gate = threading.Barrier(3)
        replies = {}
        errors = []

        def ask(identity):
            gate.wait(2)
            try:
                replies[identity] = client.ask({"id": identity}, timeout=2)
            except Exception as error:
                errors.append(type(error).__name__)

        callers = [threading.Thread(target=ask, args=(identity,), daemon=True)
                   for identity in ("first", "second")]
        for caller in callers:
            caller.start()
        gate.wait(2)
        for caller in callers:
            caller.join(3)
        self.assertFalse(any(caller.is_alive() for caller in callers), "ask callers hung")
        self.assertFalse(errors, "concurrent ask raised a transport error")
        self.assertEqual(set(replies), {"first", "second"})
        for identity, reply in replies.items():
            self.assertEqual(reply, {"echo": identity, "pipelined": False})


    def test_diagnostic_secrets_are_redacted_without_changing_reply_payload(self):
        logs = []
        complete = threading.Event()

        def log(line):
            logs.append(line)
            if "fixture diagnostics complete" in line:
                complete.set()

        values = {name: "fixture_" + uuid.uuid4().hex
                  for name in ("token", "payload", "key", "code")}
        header = base64.urlsafe_b64encode(b'{"alg":"HS256"}').decode().rstrip("=")
        body = base64.urlsafe_b64encode(b'{"sub":"local fixture"}').decode().rstrip("=")
        signature = base64.urlsafe_b64encode(uuid.uuid4().bytes).decode().rstrip("=")
        jwt = ".".join((header, body, signature))
        api_secret = "ul_" + uuid.uuid4().hex
        client, proc = self.start_client("""
            import json, sys
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                values = request["values"]
                print("trace https://fixture.invalid/path?" +
                      "&".join(key + "=" + value for key, value in values.items()) +
                      "&safe=visible", flush=True)
                print(json.dumps(values), file=sys.stderr, flush=True)
                print("trace bearer " + request["jwt"], flush=True)
                print("api diagnostic " + request["api"], file=sys.stderr, flush=True)
                print("fixture diagnostics complete", file=sys.stderr, flush=True)
                print(json.dumps({"ok": True, "code": values["code"]}), flush=True)
        """, on_log=log)
        reply = client.ask({"values": values, "jwt": jwt, "api": api_secret}, timeout=2)
        self.assertTrue(reply.get("code") == values["code"],
                        "redaction must not mutate the JSON response")
        self.assertTrue(complete.wait(1), "diagnostics were not delivered")
        client.close(1)
        text = "\n".join(logs)
        self.assertFalse(any(secret in text for secret in (*values.values(), jwt, api_secret)),
                         "a diagnostic exposed a synthetic secret")
        self.assertIn("[REDACTED]", text)
        self.assertIn("safe=visible", text)
        self.assertEqual(len(logs), 5, "diagnostic lines were discarded")


    def test_blocked_stdin_write_cannot_exceed_ask_deadline(self):
        client, proc = self.start_client("""
            import json, time
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            time.sleep(30)
        """)
        client.read_response(2)
        errors = []

        def ask():
            try:
                client.ask({"data": "x" * (2 * 1024 * 1024)}, timeout=0.15)
            except Exception as error:
                errors.append(error)

        started = time.monotonic()
        caller = threading.Thread(target=ask, daemon=True)
        caller.start()
        caller.join(0.8)
        hung = caller.is_alive()
        if hung:
            self.reap(proc)
            caller.join(2)
        self.assertFalse(hung, "stdin pipe write ignored the ask deadline")
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertTrue(errors and isinstance(errors[0], TimeoutError),
                        "blocked write must raise TimeoutError")
        with self.assertRaisesRegex(RuntimeError, "poison"):
            client.ask({"cmd": "retry"}, timeout=0.2)


    @unittest.skipUnless(os.name == "nt", "Windows owned process-tree cleanup")
    def test_windows_close_reaps_owned_descendant_tree(self):
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel.TerminateProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel.CloseHandle.restype = wintypes.BOOL
        client, proc = self.start_client("""
            import json, os, subprocess, sys, time
            child = subprocess.Popen([sys.executable, "-u", "-c",
                "import os,time; print(os.getpid(), flush=True); time.sleep(30)",
                sys.argv[1]],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            actual_pid = int(child.stdout.readline())
            print(json.dumps({"child": actual_pid, "actual": os.getpid()}), flush=True)
            time.sleep(30)
        """)
        hello = client.read_response(2)
        child_pid = hello["child"]
        handle = kernel.OpenProcess(0x00100000 | 0x0001, False, child_pid)
        self.assertTrue(handle, "descendant process handle could not be opened")
        parent_handle = kernel.OpenProcess(0x00100000 | 0x0001, False, hello["actual"])
        self.assertTrue(parent_handle, "actual fixture parent handle could not be opened")

        def cleanup_child():
            for owned_handle in (handle, parent_handle):
                if kernel.WaitForSingleObject(owned_handle, 0) == 258:
                    kernel.TerminateProcess(owned_handle, 1)
                    kernel.WaitForSingleObject(owned_handle, 2000)
                kernel.CloseHandle(owned_handle)

        self.addCleanup(cleanup_child)
        started = time.monotonic()
        caller = threading.Thread(target=client.close, args=(0.2,), daemon=True)
        caller.start()
        caller.join(1.6)
        hung = caller.is_alive()
        child_exited = kernel.WaitForSingleObject(handle, 0) == 0
        if not child_exited:
            kernel.TerminateProcess(handle, 1)
            kernel.WaitForSingleObject(handle, 2000)
        if hung:
            kernel.TerminateProcess(parent_handle, 1)
            kernel.WaitForSingleObject(parent_handle, 2000)
            caller.join(2)
        self.assertFalse(hung, "close blocked on an inherited descendant pipe")
        self.assertTrue(child_exited, "owned descendant survived close")
        self.assertLess(time.monotonic() - started, 1.6)
        self.assertIsNotNone(proc.poll(), "owned Popen was not reaped")


    def test_stderr_larger_than_pipe_capacity_is_continuously_drained(self):
        count = 0
        complete = threading.Event()

        def log(line):
            nonlocal count
            if line.startswith("[stderr] pipe fixture "):
                count += 1
                if count == 256:
                    complete.set()

        client, proc = self.start_client("""
            import json, sys
            for line in sys.stdin:
                if json.loads(line).get("cmd") == "quit":
                    break
                for _ in range(256):
                    sys.stderr.write("pipe fixture " + "x" * 8192 + "\\n")
                sys.stderr.flush()
                print(json.dumps({"ok": True}), flush=True)
        """, on_log=log)
        self.assertEqual(client.ask({"cmd": "fixture"}, timeout=3), {"ok": True})
        self.assertTrue(complete.wait(1), "large stderr diagnostics were lost")
        self.assertEqual(count, 256)

    def test_callback_failure_does_not_stop_diagnostics_or_rpc(self):
        seen = 0
        complete = threading.Event()

        def log(line):
            nonlocal seen
            seen += 1
            if seen == 1:
                raise RuntimeError("fixture callback failure")
            complete.set()

        client, proc = self.start_client("""
            import json, sys
            print("first fixture diagnostic", flush=True)
            print("second fixture diagnostic", flush=True)
            print(json.dumps({"ok": True}), flush=True)
            for line in sys.stdin:
                if json.loads(line).get("cmd") == "quit":
                    break
        """, on_log=log)
        self.assertEqual(client.read_response(2), {"ok": True})
        self.assertTrue(complete.wait(0.7), "callback failure stopped log delivery")
        self.assertEqual(seen, 2)


    def test_extra_reply_before_new_request_is_a_protocol_desync(self):
        emitted = threading.Event()
        client, proc = self.start_client("""
            import json, sys
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                print(json.dumps({"ok": True, "id": request["id"]}), flush=True)
                print(json.dumps({"ok": True, "extra": True}), flush=True)
                print("extra fixture emitted", flush=True)
        """, on_log=lambda line: emitted.set())
        client.read_response(2)
        self.assertEqual(client.ask({"id": "first"}, timeout=2),
                         {"ok": True, "id": "first"})
        self.assertTrue(emitted.wait(1), "extra reply fixture was not emitted")
        with self.assertRaisesRegex(RuntimeError, "protocol"):
            client.ask({"id": "second"}, timeout=1)
        with self.assertRaisesRegex(RuntimeError, "poison"):
            client.read_response(1)


    def test_invalid_timeout_does_not_send_or_poison_the_client(self):
        client, proc = self.start_client("""
            import json, sys
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                print(json.dumps({"ok": True}), flush=True)
        """)
        for timeout in (-1, float("nan"), float("inf"), "invalid"):
            with self.subTest(kind=type(timeout).__name__):
                with self.assertRaises(ValueError):
                    client.ask({"cmd": "fixture"}, timeout=timeout)  # type: ignore[arg-type]
        self.assertEqual(client.ask({"cmd": "fixture"}, timeout=2), {"ok": True})


    @unittest.skipUnless(os.name == "nt", "Windows pipe inheritance on owner exit")
    def test_process_exit_is_prompt_when_descendant_keeps_stdin_open(self):
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel.TerminateProcess.restype = wintypes.BOOL
        kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel.CloseHandle.restype = wintypes.BOOL
        client, proc = self.start_client("""
            import json, os, subprocess, sys
            child = subprocess.Popen([sys.executable, "-u", "-c",
                "import os,sys,time; print(os.getpid(), file=sys.stderr, flush=True); time.sleep(30)",
                sys.argv[1]],
                stderr=subprocess.PIPE, text=True)
            print(json.dumps({"child": int(child.stderr.readline())}), flush=True)
            sys.stdin.readline()
            os._exit(7)
        """)
        child_pid = client.read_response(2)["child"]
        handle = kernel.OpenProcess(0x00100000 | 0x0001, False, child_pid)
        self.assertTrue(handle, "fixture descendant handle could not be opened")

        def stop_descendant():
            if kernel.WaitForSingleObject(handle, 0) == 258:
                kernel.TerminateProcess(handle, 1)
                kernel.WaitForSingleObject(handle, 2000)

        def cleanup_descendant():
            stop_descendant()
            kernel.CloseHandle(handle)

        self.addCleanup(cleanup_descendant)
        assert proc.stdin is not None
        proc.stdin.write("fixture exit\n")
        proc.stdin.flush()
        proc.wait(2)
        started = time.monotonic()
        try:
            with self.assertRaises(EOFError):
                client.ask({"data": "x" * (2 * 1024 * 1024)}, timeout=2)
            self.assertLess(time.monotonic() - started, 0.7)
        finally:
            stop_descendant()


    def test_binary_pipes_are_decoded_without_a_reader_thread_leak(self):
        logs = []
        proc = subprocess.Popen([sys.executable, "-u", "-c", textwrap.dedent("""
            import json, sys
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                print("binary fixture diagnostic", flush=True)
                print(json.dumps({"ok": True}), flush=True)
        """), FIXTURE_MARKER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
        self.addCleanup(self.reap, proc)
        client = MailProcessClient(proc, on_log=logs.append)
        self.addCleanup(self.close_client, client)
        self.assertEqual(client.ask({"cmd": "fixture"}, timeout=2), {"ok": True})
        client.close(1)
        self.assertIn("[stdout] binary fixture diagnostic", logs)

    def test_slow_callback_does_not_extend_response_deadline(self):
        entered = threading.Event()
        release = threading.Event()

        def log(line):
            entered.set()
            release.wait(2)

        self.addCleanup(release.set)
        client, proc = self.start_client("""
            import json, time
            print(json.dumps({"ready": True}), flush=True)
            time.sleep(0.1)
            print("slow sink fixture", flush=True)
            time.sleep(30)
        """, on_log=log)
        client.read_response(2)
        self.assertTrue(entered.wait(1), "fixture log sink was not called")
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                client.read_response(0.1)
            self.assertLess(time.monotonic() - started, 0.6)
        finally:
            release.set()

    def test_graceful_close_sends_quit_and_preserves_final_stderr(self):
        logs = []
        client, proc = self.start_client("""
            import json, sys
            print(json.dumps({"ready": True}), flush=True)
            for line in sys.stdin:
                if json.loads(line).get("cmd") == "quit":
                    print("quit fixture received", file=sys.stderr, flush=True)
                    sys.exit(0)
        """, on_log=logs.append)
        client.read_response(2)
        client.close(0.5)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("[stderr] quit fixture received", logs)
        client.close(0)
        with self.assertRaisesRegex(RuntimeError, "closed"):
            client.ask({"cmd": "fixture"}, timeout=0.2)

    def test_bounded_close_does_not_kill_an_unrelated_subprocess(self):
        client, proc = self.start_client("""
            import json, time
            print(json.dumps({"ready": True}), flush=True)
            time.sleep(30)
        """)
        other, other_proc = self.start_client("""
            import json, sys
            print(json.dumps({"ready": True}), flush=True)
            for line in sys.stdin:
                if json.loads(line).get("cmd") == "quit":
                    break
        """)
        client.read_response(2)
        other.read_response(2)
        started = time.monotonic()
        client.close(0.1)
        self.assertLess(time.monotonic() - started, 2.4)
        self.assertIsNotNone(proc.poll(), "owned fixture was not reaped")
        self.assertIsNone(other_proc.poll(), "unrelated process was killed")


    def test_encoded_query_and_nested_diagnostic_fields_are_redacted(self):
        logs = []
        secret = "fixture_" + uuid.uuid4().hex
        client, proc = self.start_client("""
            import json, sys
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                secret = request["fixture"]
                print("trace https%3A%2F%2Ffixture.invalid%2Fpath%3Ftoken%3D" + secret +
                      "%26safe%3Dvisible", flush=True)
                print(json.dumps({"payload": {"nested": secret}, "safe": "visible"}),
                      file=sys.stderr, flush=True)
                print("trace https://fixture.invalid/path?%74oken=" + secret +
                      "&safe=visible", flush=True)
                print(json.dumps({"ok": True}), flush=True)
        """, on_log=logs.append)
        self.assertEqual(client.ask({"fixture": secret}, timeout=2), {"ok": True})
        client.close(1)
        self.assertFalse(any(secret in line for line in logs),
                         "an encoded or nested diagnostic exposed a synthetic secret")
        self.assertTrue(any("visible" in line for line in logs),
                        "safe diagnostic context was discarded")


    def test_nonstandard_json_constant_is_a_protocol_error(self):
        client, proc = self.start_client("""
            import json, sys
            print(json.dumps({"ready": True}), flush=True)
            for line in sys.stdin:
                if json.loads(line).get("cmd") == "quit":
                    break
                print('{"ok": true, "value": NaN}', flush=True)
        """)
        client.read_response(2)
        with self.assertRaisesRegex(RuntimeError, "protocol"):
            client.ask({"cmd": "fixture"}, timeout=1)
        with self.assertRaisesRegex(RuntimeError, "poison"):
            client.read_response(0.2)


    def test_request_lock_timeout_is_bounded_and_poisoned(self):
        received = threading.Event()
        client, proc = self.start_client("""
            import json, sys, time
            print(json.dumps({"ready": True}), flush=True)
            sys.stdin.readline()
            print("lock fixture received", flush=True)
            time.sleep(30)
        """, on_log=lambda line: received.set())
        client.read_response(2)
        errors = []

        def first_ask():
            try:
                client.ask({"cmd": "first"}, timeout=2)
            except Exception as error:
                errors.append(type(error).__name__)

        caller = threading.Thread(target=first_ask, daemon=True)
        caller.start()
        self.assertTrue(received.wait(1), "first request never reached child")
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                client.ask({"cmd": "second"}, timeout=0.1)
            self.assertLess(time.monotonic() - started, 0.6)
            with self.assertRaisesRegex(RuntimeError, "poison"):
                client.read_response(0.3)
        finally:
            client.close(0.1)
            caller.join(2)
        self.assertFalse(caller.is_alive(), "first request caller survived cleanup")


    def test_malformed_reply_keeps_redacted_protocol_diagnostic(self):
        logs = []
        secret = "fixture_" + uuid.uuid4().hex
        client, proc = self.start_client("""
            import json, sys
            for line in sys.stdin:
                request = json.loads(line)
                if request.get("cmd") == "quit":
                    break
                print('{"token": "' + request["fixture"] + '", "ok": broken}', flush=True)
        """, on_log=logs.append)
        with self.assertRaisesRegex(RuntimeError, "protocol"):
            client.ask({"fixture": secret}, timeout=2)
        client.close(0.1)
        self.assertTrue(any("broken" in line and "[REDACTED]" in line for line in logs),
                        "malformed reply diagnostic was discarded")
        self.assertFalse(any(secret in line for line in logs),
                         "malformed reply exposed a synthetic secret")


if __name__ == "__main__":
    unittest.main()
