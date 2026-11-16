import importlib.util
import tempfile
import time
import unittest
from pathlib import Path

import derive as d

SOURCE = ("import time\nclass IO:\n    def __init__(self,ids):\n        self.ids=ids;self.policy={'maximum_phase_seconds':2};self.rolling=True\n"
          "        self.package={'files':[{'slot':'client_events_worker','before_sha256':'b','after_sha256':'a'}]}\n"
          "    def worker_identity(self):\n        v=self.ids.pop(0)\n        if isinstance(v,Exception):raise v\n        return v\n"
          "    def post_start(self):\n" + d.OLD + "        return identity,expected\n").encode()


def load(body):
    folder = tempfile.mkdtemp()
    path = Path(folder) / 'm.py'
    path.write_bytes(body)
    spec = importlib.util.spec_from_file_location('m', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RaceTests(unittest.TestCase):
    def test_retries_pre_exec_identity_then_succeeds(self):
        m = load(d.patch(SOURCE))
        io = m.IO([ValueError('client_worker_uid_changed'), ValueError('client_worker_argv_changed'), {'pid': 5}])
        self.assertEqual(io.post_start(), ({'pid': 5}, 'b'))

    def test_other_refusal_raises_immediately(self):
        m = load(d.patch(SOURCE))
        io = m.IO([ValueError('client_worker_identity_unconfirmed'), {'pid': 5}])
        with self.assertRaisesRegex(ValueError, 'client_worker_identity_unconfirmed'):
            io.post_start()

    def test_deadline_still_raises(self):
        m = load(d.patch(SOURCE))
        io = m.IO([ValueError('client_worker_uid_changed')] * 100)
        io.policy['maximum_phase_seconds'] = 0.1
        start = time.monotonic()
        with self.assertRaisesRegex(ValueError, 'client_worker_uid_changed'):
            io.post_start()
        self.assertLess(time.monotonic() - start, 1)

    def test_refuses_repeat(self):
        with self.assertRaisesRegex(ValueError, 'native_binding_already_waits'):
            d.patch(d.patch(SOURCE))


if __name__ == '__main__':
    unittest.main()
