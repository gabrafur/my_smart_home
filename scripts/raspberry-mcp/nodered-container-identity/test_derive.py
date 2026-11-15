"""Synthetic tests; no live container, policy or unit is read."""
import json
import unittest

import derive

OLD, NEW = 'a' * 64, 'b' * 64
OLAB, NLAB = '/srv/app/docker-compose.yml', '/srv/app/docker-compose.yml,/srv/app/docker-compose.override.yml'


def chain(identity=OLD, label=OLAB):
    reader = ("CONTAINER_ID='%s'\nIMAGE='sha256:%s'\nLABELS={'com.docker.compose.project.config_files':'%s'}\n"
              % (identity, 'c' * 64, label)).encode()
    guard = ("SOURCE = b'LABELS={\\'com.docker.compose.project.config_files\\':\\'%s\\'}\\nCONTAINER_ID=\\'%s\\'\\n'\n"
             "CONTAINER_ID = '%s'\nLABELS = {'com.docker.compose.project.config_files': '%s'}\nOTHER='%s'\n"
             % (label, identity, identity, label, '/srv/app/docker-compose.yml')).encode()
    reader_policy = json.dumps({'container_id': identity, 'enabled': True, 'image': 'sha256:' + 'c' * 64,
                                'source_sha256': derive.sha(reader)}, separators=(',', ':')).encode()
    reader_unit = b'ExecStart=python reader.py ' + derive.sha(reader_policy).encode() + b'\n'
    admin_policy = json.dumps({'backend': {'host': 'h'}, 'sources': {'native_guard.py': derive.sha(guard), 'engine.py': 'e' * 64},
                               'native_guard_producer': {'source_sha256': derive.sha(guard), 'continuity_metadata_reader': {
                                   'python_sha256': 'f' * 64, 'reader_policy_sha256': derive.sha(reader_policy),
                                   'reader_source_sha256': derive.sha(reader), 'service_unit_sha256': derive.sha(reader_unit)}}},
                              separators=(',', ':')).encode()
    admin_unit = b'ExecStart=python bootstrap.py ' + derive.sha(admin_policy).encode() + b'\n'
    return dict(reader=reader, reader_policy=reader_policy, reader_unit=reader_unit, guard=guard,
                admin_policy=admin_policy, admin_unit=admin_unit)


class Derive(unittest.TestCase):
    def test_result_equals_a_chain_built_for_the_new_container(self):
        self.assertEqual(derive.derive(chain(), OLD, NEW, OLAB, NLAB), chain(NEW, NLAB))

    def test_identity_only_change_keeps_the_label(self):
        self.assertEqual(derive.derive(chain(), OLD, NEW, OLAB, OLAB), chain(NEW, OLAB))

    def test_unrelated_text_equal_to_the_label_is_untouched(self):
        self.assertIn(b"OTHER='/srv/app/docker-compose.yml'", derive.derive(chain(), OLD, NEW, OLAB, NLAB)['guard'])

    def test_refusals(self):
        good = chain()
        def broken(name, old, new):
            value = dict(good); value[name] = value[name].replace(old, new); return value
        cases = [
            (good, OLD, OLD, OLAB, NLAB), (good, OLD, 'B' * 64, OLAB, NLAB), (good, OLD, NEW, OLAB, "x' or"),
            (good, 'd' * 64, NEW, OLAB, NLAB), (good, OLD, NEW, '/other/compose.yml', NLAB),
            (broken('reader_policy', b'true', b'false'), OLD, NEW, OLAB, NLAB),
            (broken('reader_unit', derive.sha(good['reader_policy']).encode(), b'0' * 64), OLD, NEW, OLAB, NLAB),
            (broken('admin_policy', derive.sha(good['guard']).encode(), b'0' * 64), OLD, NEW, OLAB, NLAB),
            (broken('admin_unit', derive.sha(good['admin_policy']).encode(), b'0' * 64), OLD, NEW, OLAB, NLAB),
            ({k: v for k, v in good.items() if k != 'guard'}, OLD, NEW, OLAB, NLAB),
            (chain(NEW, OLAB), OLD, NEW, OLAB, NLAB),
        ]
        for args in cases:
            with self.assertRaises((ValueError, KeyError)):
                derive.derive(*args)


if __name__ == '__main__':
    unittest.main()
