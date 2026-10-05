import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

from compact_output import LIMIT, compact_output, expand_tap

RUNNER = str(Path(__file__).with_name("run.py"))


def passing(n, name=None, indent="", kind=True):
    name = name or f"synthetic case {n}"
    return (f"{indent}# Subtest: {name}\n{indent}ok {n} - {name}\n{indent}  ---\n{indent}  duration_ms: 0.125\n"
            + (f"{indent}  type: 'test'\n" if kind else "") + f"{indent}  ...\n")


def corpus():
    return ("TAP version 13\n" + "".join(passing(n) for n in range(1, 91))
            + "1..90\n# tests 90\n# pass 90\n# fail 0\n# skipped 0\n# duration_ms 42.125\n")


class CompactOutputTests(unittest.TestCase):
    def check_roundtrip(self, source):
        raw = source.encode()
        result = compact_output(raw)
        self.assertTrue(result["packed"])
        self.assertEqual(expand_tap(result["output"].decode()).encode(), raw)
        return result

    def test_exact_reconstruction(self):
        result = self.check_roundtrip(corpus())
        self.assertEqual(result["records"], 90)
        self.assertLess(result["output_bytes"], result["source_bytes"] * 0.6)

    def test_failure_blocks_and_unknown_lines_remain_literal(self):
        suffix = ('# Subtest: assertion\nnot ok 91 - assertion\n  ---\n  expected: |\n    first\n    second\n'
                  '  actual: |\n    first\n    third\n  operator: deepStrictEqual\n  stack: |\n'
                  '    at synthetic (example.test.mjs:42:3)\n  ...\nWARNING permissions\n'
                  'ok 92 - future # TODO\nok 93 - absent # SKIP unavailable\nmeaningful non-keyword line\n')
        result = self.check_roundtrip(corpus() + suffix)
        self.assertTrue(result["output"].endswith(suffix.encode()))

    def test_nested_unicode_quotes_and_legacy(self):
        self.check_roundtrip(corpus() + passing(91, 'ação "quotes" \\ caminho 😀', "    ") + passing(92, kind=False))

    def test_tap_shaped_expected_value_inside_failure_is_not_packed(self):
        suffix = 'not ok 91 - compare expected TAP\n  ---\n  expected: |\n' + passing(1, indent="    ") + '  ...\n'
        result = self.check_roundtrip(corpus() + suffix)
        self.assertTrue(result["output"].endswith(suffix.encode()))
        self.assertEqual(result["records"], 90)

    def test_unknown_record_shapes_remain_literal(self):
        for suffix in (passing(1).replace("ok 1 - synthetic case 1", "ok 1 - different"),
                       passing(1).replace("  ...", "  extra: keep me\n  ..."), passing(1)[:-5]):
            result = self.check_roundtrip(corpus() + suffix)
            self.assertTrue(result["output"].endswith(suffix.encode()))

    def test_fail_closed(self):
        for raw in (b"hello\n", b"plain data\n" * 900, (corpus() + "@pass user content\n").encode(),
                    corpus().replace("\n", "\r\n").encode(), corpus().encode() + b"\xff"):
            result = compact_output(raw)
            self.assertFalse(result["packed"])
            self.assertEqual(result["output"], raw)
        raw = corpus().encode()
        self.assertEqual(compact_output(raw, max_bytes=20)["output"], raw)
        self.assertEqual(compact_output(raw, min_reduction=0.99)["output"], raw)

    def test_corruption_rejected(self):
        packed = compact_output(corpus().encode())["output"].decode()
        with self.assertRaisesRegex(ValueError, "integrity"):
            expand_tap(packed.replace('synthetic case 1"', 'tampered"'))

    def run_child(self, code, *args):
        return subprocess.run([sys.executable, RUNNER, "--", sys.executable, "-c", code, *args], capture_output=True, timeout=10)

    def test_exit_status_and_arguments(self):
        result = self.run_child('import sys;print(sys.argv[1]);print("stderr visible",file=sys.stderr);sys.exit(7)', 'literal; $HOME')
        self.assertEqual(result.returncode, 7)
        self.assertIn(b'literal; $HOME', result.stdout)
        self.assertIn(b'stderr visible', result.stdout)

    def test_actual_delivery_packs_before_stdout(self):
        source = corpus() + "unmarked diagnostic\n"
        result = self.run_child('import sys;sys.stdout.write(sys.argv[1]);sys.exit(3)', source)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(expand_tap(result.stdout.decode()), source)
        self.assertLess(len(result.stdout), len(source))

    def test_oversize_and_missing_command(self):
        size = LIMIT + 123
        result = self.run_child(f'import sys;sys.stdout.write("x"*{size})')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"x" * size)
        result = subprocess.run([sys.executable, RUNNER, "--", "/nonexistent/local-context-fixture"], capture_output=True)
        self.assertEqual(result.returncode, 127)
        self.assertIn(b'spawn_failed', result.stderr)

    @unittest.skipUnless(os.name == "posix", "POSIX signals")
    def test_signal_status(self):
        result = self.run_child('import os,signal;os.kill(os.getpid(),signal.SIGTERM)')
        self.assertEqual(result.returncode, 143)

    @unittest.skipUnless(os.name == "posix", "POSIX groups")
    def test_cancellation_reaches_child(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "ready"
            code = 'import os,time,pathlib,sys;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(30)'
            process = subprocess.Popen([sys.executable, RUNNER, "--", sys.executable, "-c", code, str(marker)], stdout=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(marker.exists())
                pid = int(marker.read_text())
                process.terminate()
                process.communicate(timeout=5)
                self.assertEqual(process.returncode, 143)
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
