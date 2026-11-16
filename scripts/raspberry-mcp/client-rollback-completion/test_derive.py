import hashlib
import json
import unittest

import derive as d


def sha(b):
    return hashlib.sha256(b).hexdigest()


SOURCE = ("import re\n" + d.DIAG_OLD + "\nclass ClientNativeIO:\n    def unresolved(self):\n        for row in []:\n"
          + d.UNRESOLVED_OLD + "\n" + d.FUNCTIONS_ANCHOR + "\n    if True:\n" + d.STATUS_OLD + "    return None\n").encode()


def fixture():
    pin = sha(SOURCE)
    owner = json.dumps({'installer_sources': {'native_binding.py': pin}}).encode()
    enrollment = json.dumps({'sources': {'native_binding.py': pin}}, indent=1).encode()
    approval = json.dumps({'source_hashes': {'native_binding.py': pin}}).encode()
    catalogue = json.dumps({'files': [{'slot': 'native_binding', 'after_sha256': pin}]}).encode()
    files = [{'slot': 'native_binding', 'after_sha256': pin}, {'slot': 'installer_enrollment', 'after_sha256': sha(enrollment)}]
    boot = json.dumps({'files': files, 'expires_at': 0, 'manifest_sha256': sha(d.canonical({'files': files, 'expires_at': 0})),
                       'owner_authorization_sha256': '0' * 64}).encode()
    return {'native_binding': SOURCE, 'owner_policy': owner, 'install_enrollment': enrollment,
            'package_enrollment_approval': approval, 'catalogue_manifest': catalogue, 'bootstrap_manifest': boot}


class DeriveTests(unittest.TestCase):
    def test_patches_three_anchors_and_moves_pins(self):
        after = d.derive(fixture())
        src = after['native_binding']
        for marker in (b'held_lock_path_changed', b'or rb_completion_proof(', b'rollback=rb_completion_status(op,row)', b'def rb_completion_proof'):
            self.assertIn(marker, src)
        new = sha(src)
        self.assertEqual(json.loads(after['owner_policy'])['installer_sources']['native_binding.py'], new)
        boot = json.loads(after['bootstrap_manifest'])
        self.assertEqual(boot['files'][0]['after_sha256'], new)
        self.assertEqual(boot['files'][1]['after_sha256'], sha(after['install_enrollment']))
        self.assertEqual(boot['manifest_sha256'], sha(d.canonical({'files': boot['files'], 'expires_at': 0})))

    def test_refuses_repeat_and_missing_anchor(self):
        before = fixture()
        with self.assertRaisesRegex(ValueError, 'native_binding_already_patched'):
            d.derive(dict(before, native_binding=d.derive(before)['native_binding']))
        with self.assertRaisesRegex(ValueError, 'diagnostic_anchor'):
            d.patch(SOURCE.replace(d.DIAG_OLD.encode(), b'X'))


if __name__ == '__main__':
    unittest.main()
