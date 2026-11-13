import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('operator_workspace', Path(__file__).with_name('operator_workspace.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateWorkspaceTest(unittest.TestCase):
    def require_fixture_workspace(self, workspace, boundary):
        # The host temporary directory may itself belong to a checkout. Keep
        # real markers inside this fixture; model its outside ancestors as
        # clean so each rejection tests the marker this case actually creates.
        exists = module.os.path.lexists
        with mock.patch.object(module.os.path, 'lexists', side_effect=lambda marker:
                               exists(marker) if Path(marker).is_relative_to(boundary) else False):
            return module.require_private_workspace(workspace)

    def test_private_workspace_allowed(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(self.require_fixture_workspace(root, root), Path(root).resolve())

    def test_alternate_checkout_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root); (p / '.git').mkdir(); w = p / 'private'; w.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, 'outside_git'):
                self.require_fixture_workspace(w, p)

    def test_worktree_and_dangling_git_marker_rejected(self):
        for dangling in (False, True):
            with self.subTest(dangling=dangling), tempfile.TemporaryDirectory() as root:
                p = Path(root)
                if dangling: (p / '.git').symlink_to(p / 'missing')
                else: (p / '.git').write_text('gitdir: /elsewhere')
                with self.assertRaisesRegex(ValueError, 'outside_git'):
                    self.require_fixture_workspace(p, p)

    def test_nonprivate_workspace_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root).chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'workspace_required'):
                self.require_fixture_workspace(root, root)
