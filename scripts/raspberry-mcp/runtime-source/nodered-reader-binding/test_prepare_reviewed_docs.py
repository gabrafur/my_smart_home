"""Synthetic filesystem and Git replies only; never invoke Git or inspect repository."""
import datetime
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import prepare_reviewed_docs as module

HEAD = 'a' * 40


class ReviewedDocsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repository'
        self.root.mkdir()
        self.content = {name: ('Synthetic document ' + str(i) + '\n').encode() for i, name in enumerate(module.FILES)}
        for name, raw in self.content.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        self.calls = []
        self.branch, self.head, self.origin = b'main\n', (HEAD + '\n').encode(), (HEAD + '\n').encode()

    def git(self, root, arguments, limit):
        self.assertEqual(root, self.root)
        self.calls.append((arguments, limit))
        if arguments == ['symbolic-ref', '--quiet', '--short', 'HEAD']: return self.branch
        if arguments == ['rev-parse', '--verify', 'HEAD']: return self.head
        if arguments == ['rev-parse', '--verify', 'refs/remotes/origin/main']: return self.origin
        if len(arguments) == 2 and arguments[0] == 'show' and arguments[1].startswith('HEAD:'):
            return self.content[arguments[1][5:]]
        raise AssertionError('unexpected git arguments')

    def build(self, head=HEAD, runner=None):
        return module.build(head, root=self.root, git_runner=runner or self.git,
            clock=lambda: datetime.datetime(2026, 1, 2, 3, 4, 5, 999, datetime.timezone.utc))

    def test_exact_reviewed_receipt_and_fixed_git_calls(self):
        result = self.build()
        self.assertEqual(result, {'schema_version': 1, 'source': 'reviewed_public_MCP_docs_v1',
            'public_head': HEAD, 'observed_at': '2026-01-02T03:04:05Z',
            'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in self.content.items()}})
        self.assertEqual(sum(args[0] == 'show' for args, _ in self.calls), 3)
        self.assertEqual(len(self.calls), 9)

    def test_branch_head_and_remote_disagreements_fail_closed(self):
        for attr, value in [('branch', b'other\n'), ('head', b'b'*40+b'\n'), ('origin', b'b'*40+b'\n')]:
            with self.subTest(attr=attr):
                old = getattr(self, attr); setattr(self, attr, value)
                with self.assertRaisesRegex(ValueError, 'reviewed_main_head_mismatch'): self.build()
                setattr(self, attr, old)
        for invalid in ('A'*40, 'a'*39, 'a'*41, 'HEAD', '../main'):
            with self.subTest(head=invalid), self.assertRaisesRegex(ValueError, 'reviewed_head_invalid'): self.build(invalid)

    def test_changed_ref_during_collection_refused(self):
        def changing(root, arguments, limit):
            if len(self.calls) >= 6 and arguments == ['rev-parse', '--verify', 'HEAD']:
                self.head = b'b'*40+b'\n'
            return self.git(root, arguments, limit)
        with self.assertRaisesRegex(ValueError, 'reviewed_main_head_changed'): self.build(runner=changing)

    def test_dirty_missing_binary_and_oversize_files_are_refused(self):
        target = self.root / module.FILES[0]
        for raw in (b'dirty', b'bad\0data', b'\xff', b'x' * (module.MAX_BYTES + 1)):
            target.write_bytes(raw)
            with self.subTest(size=len(raw)), self.assertRaises((ValueError, UnicodeError)): self.build()
        target.unlink()
        with self.assertRaises(OSError): self.build()

    def test_file_symlink_hardlink_and_ancestor_symlink_are_refused(self):
        target = self.root / module.FILES[0]
        original = target.read_bytes(); target.unlink()
        external = self.root / 'external'; external.write_bytes(original)
        target.symlink_to(external)
        with self.assertRaises(OSError): self.build()
        target.unlink(); os.link(external, target)
        with self.assertRaisesRegex(ValueError, 'unsafe_document'): self.build()
        target.unlink(); target.write_bytes(original)
        directory = self.root / 'docs' / 'raspberry-mcp' / 'reference'
        directory.rename(self.root / 'moved-reference')
        directory.symlink_to(self.root / 'moved-reference', target_is_directory=True)
        with self.assertRaises(OSError): self.build()

    def test_git_failures_are_not_hidden_and_no_mutating_command_is_used(self):
        def failed(*args): raise TimeoutError('synthetic_git_timeout')
        with self.assertRaises(TimeoutError): self.build(runner=failed)
        self.build()
        for args, _ in self.calls:
            self.assertIn(args[0], ('symbolic-ref', 'rev-parse', 'show'))
        with patch.object(module, 'ROOT', self.root), patch.object(module, 'git', side_effect=AssertionError('not used')):
            with self.assertRaises(ValueError): module.build('invalid', root=self.root, git_runner=self.git)


if __name__ == '__main__': unittest.main()
