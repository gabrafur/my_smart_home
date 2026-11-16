import hashlib
import json
import unittest

import derive as d


def sha(b):
    return hashlib.sha256(b).hexdigest()


WORKER = b"x=1\nBROAD_EXPECTED = {'schema': 'eva_broad_task_profile_v1', 'lease_kind': 'persistent_revocable'}\n"
INSTALLER = ("import json\n" + d.ANCHOR + "\n" + d.OLD + "\n    return value\n").encode()


def fixture():
    pin = sha(INSTALLER)
    rows = lambda extra: [{'slot': 'fixed_installer', 'after_sha256': pin}] + extra
    owner = json.dumps({'installer_sources': {'fixed_installer.py': pin}, 'other': 1}).encode()
    enrollment = json.dumps({'sources': {'fixed_installer.py': pin}}, indent=1).encode()
    approval = json.dumps({'source_hashes': {'fixed_installer.py': pin}, 'enabled': False}).encode()
    catalogue = json.dumps({'files': rows([])}).encode()
    files = rows([{'slot': 'installer_enrollment', 'after_sha256': sha(enrollment)},
                  {'slot': 'package_enrollment_approval', 'after_sha256': sha(approval)}])
    digest = sha(d.canonical({'files': files, 'expires_at': 0}))
    boot = json.dumps({'files': files, 'expires_at': 0, 'manifest_sha256': digest, 'owner_authorization_sha256': '0' * 64}).encode()
    return {'fixed_installer': INSTALLER, 'owner_policy': owner, 'install_enrollment': enrollment,
            'package_enrollment_approval': approval, 'catalogue_manifest': catalogue, 'bootstrap_manifest': boot}


class DeriveTests(unittest.TestCase):
    def test_moves_installer_pins_and_bootstrap_digest(self):
        before = fixture()
        after = d.derive(before, WORKER)
        new = sha(after['fixed_installer'])
        self.assertIn(b'CLIENT_BROAD_EXPECTED=', after['fixed_installer'])
        self.assertEqual(json.loads(after['owner_policy'])['installer_sources']['fixed_installer.py'], new)
        self.assertEqual(json.loads(after['owner_policy'])['other'], 1)
        self.assertEqual(json.loads(after['install_enrollment'])['sources']['fixed_installer.py'], new)
        boot = json.loads(after['bootstrap_manifest'])
        self.assertEqual({r['slot']: r['after_sha256'] for r in boot['files']},
                         {'fixed_installer': new, 'installer_enrollment': sha(after['install_enrollment']),
                          'package_enrollment_approval': sha(after['package_enrollment_approval'])})
        self.assertEqual(boot['manifest_sha256'], sha(d.canonical({'files': boot['files'], 'expires_at': 0})))
        self.assertTrue(after['install_enrollment'].startswith(b'{\n'))

    def test_refuses_repeat_and_drift(self):
        before = fixture()
        after = d.derive(before, WORKER)
        with self.assertRaisesRegex(ValueError, 'installer_already_broad'):
            d.derive(dict(before, fixed_installer=after['fixed_installer']), WORKER)
        drift = dict(before, owner_policy=b'{"installer_sources":{"fixed_installer.py":"' + b'0' * 64 + b'"},"other":1}')
        with self.assertRaisesRegex(ValueError, 'owner_policy_installer_pin'):
            d.derive(drift, WORKER)
        with self.assertRaisesRegex(ValueError, 'worker_broad_contract'):
            d.derive(before, b'nothing')


if __name__ == '__main__':
    unittest.main()
