#!/usr/bin/env python3
"""Portable raw ABI parser regressions; live kernel acceptance requires macOS."""
import importlib.util
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location("identity", Path(__file__).with_name("mac-process-identity.py"))
assert spec is not None and spec.loader is not None
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class ProcargsTests(unittest.TestCase):
    def test_boundaries_and_environment_exclusion(self):
        args = ["/opt/homebrew/bin/node", "/Users/mac/Abuse Hub/routing/transparent-proxy.js", "extra arg", ""]
        data = struct.pack("=i", len(args)) + b"/opt/homebrew/Cellar/node/26.3.0/bin/node\0\0\0"
        data += b"\0".join(x.encode() for x in args) + b"\0SECRET=not-argv\0"
        self.assertEqual(identity.parse_procargs(data), args)

    def test_quotes_are_literal_not_shell_syntax(self):
        args = ["node", '/path with "quote"/script.js', "'extra argument'"]
        data = struct.pack("=i", len(args)) + b"/node\0\0" + b"\0".join(x.encode() for x in args) + b"\0"
        self.assertEqual(identity.parse_procargs(data), args)

    def test_malformed_buffers_fail_closed(self):
        for data in [b"", struct.pack("=i", -1) + b"/node\0", struct.pack("=i", 2) + b"/node\0node\0", struct.pack("=i", 1) + b"unterminated"]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                identity.parse_procargs(data)

    def test_non_mac_kernel_read_fails_closed(self):
        import sys
        if sys.platform != "darwin":
            with self.assertRaises(ValueError):
                identity.read_process(123)


if __name__ == "__main__":
    unittest.main()
