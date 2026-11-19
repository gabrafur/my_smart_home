"""Synthetic tests; no live container, policy or unit is read."""
import json
import unittest

import derive

OLD, NEW = 'a' * 64, 'b' * 64
OLAB, NLAB = '/srv/app/docker-compose.yml', '/srv/app/docker-compose.yml,/srv/app/docker-compose.override.yml'


DOCK, NDOCK = 'd' * 64, 'e' * 64


def chain(identity=OLD, label=OLAB, docker=DOCK):
    reader = ("CONTAINER_ID='%s'\nIMAGE='sha256:%s'\nLABELS={'com.docker.compose.project.config_files':'%s'}\nDOCKER_SHA='%s'\n"
              % (identity, 'c' * 64, label, docker)).encode()
    guard = ("SOURCE = b'LABELS={\\'com.docker.compose.project.config_files\\':\\'%s\\'}\\nCONTAINER_ID=\\'%s\\'\\n'\n"
             "CONTAINER_ID = '%s'\nLABELS = {'com.docker.compose.project.config_files': '%s'}\nOTHER='%s'\nDOCKER='%s'\n"
             % (label, identity, identity, label, '/srv/app/docker-compose.yml', docker)).encode()
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

    def test_docker_binary_update_alone_matches_a_chain_built_for_the_new_digest(self):
        self.assertEqual(derive.derive(chain(), OLD, OLD, OLAB, OLAB, DOCK, NDOCK), chain(OLD, OLAB, NDOCK))

    def test_docker_update_can_combine_with_a_recreated_container(self):
        self.assertEqual(derive.derive(chain(), OLD, NEW, OLAB, NLAB, DOCK, NDOCK), chain(NEW, NLAB, NDOCK))

    def test_docker_refusals(self):
        good = chain()
        for args in [(good, OLD, OLD, OLAB, OLAB, DOCK, DOCK), (good, OLD, OLD, OLAB, OLAB, 'f' * 64, NDOCK),
                     (good, OLD, OLD, OLAB, OLAB, DOCK, None), (good, OLD, OLD, OLAB, OLAB, DOCK, 'X' * 64)]:
            with self.assertRaises(ValueError):
                derive.derive(*args)

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


IMG1, IMG2 = '1' * 64, '2' * 64


def chain9(identity=OLD, image=IMG1, version='5.0.9', label=OLAB):
    evidence = json.dumps({'schema_version': 1, 'core_version': version, 'passed': True},
                          separators=(',', ':')).encode()
    review = json.dumps({'schema_version': 1, 'core_version': version, 'isolated_evidence_sha256': derive.sha(evidence)},
                        indent=2).encode()
    activation = json.dumps({'schema_version': 1, 'core_version': version, 'image_digest': 'sha256:' + image},
                            indent=2).encode()
    reader = ("CONTAINER_ID='%s'\nIMAGE='sha256:%s'\nLABELS={'com.docker.compose.project.config_files':'%s'}\n"
              % (identity, image, label)).encode()
    guard = ("SOURCE = b'LABELS={\\'com.docker.compose.project.config_files\\':\\'%s\\'}\\nCONTAINER_ID=\\'%s\\'\\n'\n"
             "CONTAINER_ID = '%s'\nLABELS = {'com.docker.compose.project.config_files': '%s'}\n"
             "need(activation['core_version'] == '%s')\nneed(evidence.get('core_version') == '%s')\n"
             % (label, identity, identity, label, version, version)).encode()
    reader_policy = json.dumps({'container_id': identity, 'enabled': True, 'image': 'sha256:' + image,
                                'source_sha256': derive.sha(reader)}, separators=(',', ':')).encode()
    reader_unit = b'ExecStart=python reader.py ' + derive.sha(reader_policy).encode() + b'\n'
    admin_policy = json.dumps({'backend': {'host': 'h'}, 'sources': {'native_guard.py': derive.sha(guard), 'engine.py': 'e' * 64},
                               'native_guard_producer': {'source_sha256': derive.sha(guard),
                                   'runtime_activation_sha256': derive.sha(activation),
                                   'isolated_review_sha256': derive.sha(review),
                                   'continuity_metadata_reader': {
                                   'python_sha256': 'f' * 64, 'reader_policy_sha256': derive.sha(reader_policy),
                                   'reader_source_sha256': derive.sha(reader), 'service_unit_sha256': derive.sha(reader_unit)}}},
                              separators=(',', ':')).encode()
    admin_unit = b'ExecStart=python bootstrap.py ' + derive.sha(admin_policy).encode() + b'\n'
    return dict(reader=reader, reader_policy=reader_policy, reader_unit=reader_unit, guard=guard,
                admin_policy=admin_policy, admin_unit=admin_unit, activation=activation, review=review, evidence=evidence)


class DeriveImage(unittest.TestCase):
    def test_result_equals_a_chain_built_for_the_new_image(self):
        self.assertEqual(derive.derive_image(chain9(), OLD, NEW, IMG1, IMG2, '5.0.9', '5.0.10', OLAB),
                         chain9(NEW, IMG2, '5.0.10'))

    def test_refusals(self):
        good = chain9()
        def broken(name, old, new):
            value = dict(good); value[name] = value[name].replace(old, new); return value
        cases = [
            (good, OLD, OLD, IMG1, IMG2, '5.0.9', '5.0.10'), (good, OLD, NEW, IMG1, IMG1, '5.0.9', '5.0.10'),
            (good, OLD, NEW, IMG1, IMG2, '5.0.9', '5.0.9'), (good, OLD, NEW, IMG1, IMG2, '5.0.9', 'x.y'),
            (good, 'd' * 64, NEW, IMG1, IMG2, '5.0.9', '5.0.10'), (good, OLD, NEW, 'd' * 64, IMG2, '5.0.9', '5.0.10'),
            (good, OLD, NEW, IMG1, IMG2, '5.0.8', '5.0.10'),
            (broken('review', b'"core_version": "5.0.9"', b'"core_version": "5.0.8"'), OLD, NEW, IMG1, IMG2, '5.0.9', '5.0.10'),
            (broken('activation', b'sha256:' + IMG1.encode(), b'sha256:' + b'd' * 64), OLD, NEW, IMG1, IMG2, '5.0.9', '5.0.10'),
            (broken('guard', b"evidence.get('core_version') == '5.0.9'", b"evidence.get('core_version') == '0'"), OLD, NEW, IMG1, IMG2, '5.0.9', '5.0.10'),
            ({k: v for k, v in good.items() if k != 'evidence'}, OLD, NEW, IMG1, IMG2, '5.0.9', '5.0.10'),
        ]
        for args in cases:
            with self.assertRaises((ValueError, KeyError, TypeError)):
                derive.derive_image(*args, OLAB)


if __name__ == '__main__':
    unittest.main()
