"""Fixed unprivileged verifier; no deployment, network, daemon RPC or sudo."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path('/usr/local/lib/raspberry-repair-control')
CHECKS = ['old_failure_later_publication', 'later_failure', 'missing_times',
          'conflicting_times', 'collection_failure', 'static_vs_current_events',
          'dedupe', 'uncertain_no_replay']


def main():
    if os.geteuid() != 1001 or sys.argv[1:] or Path(__file__).absolute() != ROOT/'verify_candidate.py':
        print(json.dumps({'state': 'blocked', 'reason': 'fixed_sealed_verifier_required',
            'production_changes': False}));return 1
    sys.path.insert(0, str(ROOT))
    sys.path.insert(1, '/usr/local/lib/raspberry-task-control')
    import repair_control
    import task_control
    repair_control.configuration(task_control)
    suite = unittest.defaultTestLoader.loadTestsFromNames(
        ['test_health_summary', 'test_repair_store', 'test_repair_control'])
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        result = unittest.TextTestRunner(stream=sink).run(suite)
    node = subprocess.run(['/usr/bin/node', '--jitless', '--no-expose-wasm',
        '--max-old-space-size=48', '--test', str(ROOT/'test_events.mjs')],
        capture_output=True, timeout=20, cwd=ROOT,
        env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent'})
    passed = result.wasSuccessful() and node.returncode == 0
    print(json.dumps({'state': 'complete' if passed else 'failed',
        'checks': {x: 'passed' if passed else 'failed' for x in CHECKS},
        'python_tests': result.testsRun, 'node_tests_exit': node.returncode,
        'production_changes': False, 'services_restarted': 0, 'daemon_RPC_called': False,
        'test_stdout_withheld': True}))
    return 0 if passed else 1


if __name__ == '__main__':
    try:raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({'state': 'blocked', 'reason': 'verification_unconfirmed',
            'exception_kind': type(exc).__name__, 'raw_error_withheld': True,
            'production_changes': False}));raise SystemExit(1)
