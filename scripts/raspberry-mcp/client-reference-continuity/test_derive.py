import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import derive as d

FIXTURE = Path(__file__).resolve().parent / 'fixture_reference_closure.py'


def module(body):
    path = Path(tempfile.mkdtemp()) / 'nb.py'
    path.write_bytes(body)
    spec = importlib.util.spec_from_file_location('nb', path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class IO:
    def __init__(self, refs): self.refs = refs
    def ref_read(self, key): return self.refs[key]


def sha(b): return hashlib.sha256(b).hexdigest()


def package():
    rows = {'client_continuation_policy': ('a' * 64, 'b' * 64), 'client_events_worker': ('c' * 64, 'd' * 64),
            'client_repair_projection': ('e' * 64, 'f' * 64), 'client_frontend_projection': ('e' * 64, 'f' * 64)}
    return {'files': [{'slot': k, 'before_sha256': v[0], 'after_sha256': v[1]} for k, v in rows.items()]}


def refs(m, continuity):
    repair = (json.dumps({'source_hashes': {m.REF_PROJECTOR: 'e' * 64}}, indent=2) + '\n').encode()
    component = json.dumps({'dependencies': {m.REF_WORKER: 'c' * 64, m.REF_PATHS['repair']: sha(repair)}}).encode()
    policy = sha(component)
    def unit(verb, entry):
        target = ('continuity_entry.py ' + '9' * 64) if entry else ('root_bootstrap.py ' + policy)
        return ('[Service]\nExecStart=/usr/bin/python3 -I -S -B /usr/local/lib/raspberry-component-repair/' + target + ' ' + verb + '\n').encode()
    return {'repair': repair, 'component': component, 'job': unit('worker %i', continuity), 'validate': unit('validate %i', continuity),
            'guard': unit('guard', False)}


class ReferenceContinuityTests(unittest.TestCase):
    def setUp(self):
        self.old = module(FIXTURE.read_bytes())
        self.new = module(d.patch(FIXTURE.read_bytes()))

    def test_legacy_units_unchanged_behaviour(self):
        for m in (self.old, self.new):
            raw, result = m.ClientReferenceClosure(IO(refs(m, False)), package()).plan()
            self.assertNotEqual(result['job'], raw['job'])

    def test_continuity_units_are_kept_and_guard_repinned(self):
        r = refs(self.new, True)
        with self.assertRaisesRegex(ValueError, 'reference_unit_foreign'):
            self.old.ClientReferenceClosure(IO(r), package()).plan()
        raw, result = self.new.ClientReferenceClosure(IO(r), package()).plan()
        self.assertEqual(result['job'], raw['job'])
        self.assertEqual(result['validate'], raw['validate'])
        self.assertNotEqual(result['guard'], raw['guard'])

    def test_continuity_guard_or_tampered_lines_refused(self):
        r = refs(self.new, True)
        r['job'] = r['job'] + b'ExecStart=/bin/true\n'
        r['job'] = r['job'].replace(b'worker %i', b'worker %i --extra')
        with self.assertRaisesRegex(ValueError, 'reference_unit_foreign'):
            self.new.ClientReferenceClosure(IO(r), package()).plan()

    def test_refuses_repeat(self):
        with self.assertRaisesRegex(ValueError, 'already_continuity_aware'):
            d.patch(d.patch(FIXTURE.read_bytes()))


if __name__ == '__main__':
    unittest.main()
