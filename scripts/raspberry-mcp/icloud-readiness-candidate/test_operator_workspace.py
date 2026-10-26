import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('operator_workspace', Path(__file__).with_name('operator_workspace.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateWorkspaceTest(unittest.TestCase):
    def test_private_workspace_allowed(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(module.require_private_workspace(root), Path(root).resolve())

    def test_alternate_checkout_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root); (p / '.git').mkdir(); w = p / 'private'; w.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, 'outside_git'):
                module.require_private_workspace(w)

    def test_worktree_and_dangling_git_marker_rejected(self):
        for dangling in (False, True):
            with self.subTest(dangling=dangling), tempfile.TemporaryDirectory() as root:
                p = Path(root)
                if dangling: (p / '.git').symlink_to(p / 'missing')
                else: (p / '.git').write_text('gitdir: /elsewhere')
                with self.assertRaisesRegex(ValueError, 'outside_git'):
                    module.require_private_workspace(p)

    def test_nonprivate_workspace_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root).chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'workspace_required'):
                module.require_private_workspace(root)
