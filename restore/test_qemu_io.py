"""Pure argv tests; no QEMU, Docker, backup, private files or services."""
import unittest
import qemu_io


class QemuIOTests(unittest.TestCase):
    def baseline(self):
        return ['vm-1536m', '/loader', '-m', '1024M', '-nic', 'none',
                *qemu_io.ORIGINAL, '-sandbox', qemu_io.SANDBOX, '-S']

    def test_only_fixed_disk_slot_changes_and_input_is_preserved(self):
        before = self.baseline();original = before.copy()
        after = qemu_io.bounded_disk_io(before)
        self.assertEqual(before, original)
        self.assertEqual(after[:6], before[:6]);self.assertEqual(after[-3:], before[-3:])
        self.assertEqual(after[6:-3], list(qemu_io.BOUNDED))
        self.assertEqual(len(after), len(before)+2)
        self.assertIn('spawn=deny', after[-2])

    def test_different_free_path_or_duplicate_disk_is_refused(self):
        for args in [self.baseline()+list(qemu_io.ORIGINAL),
                     [v.replace('/disk/data.raw', '/other/data.raw') for v in self.baseline()]]:
            with self.assertRaisesRegex(ValueError, 'binding_changed'):qemu_io.bounded_disk_io(args)

    def test_missing_or_weakened_sandbox_is_refused(self):
        for args in [self.baseline()[:-3],
                     [v.replace('spawn=deny', 'spawn=allow') for v in self.baseline()],
                     self.baseline()+['-sandbox', qemu_io.SANDBOX]]:
            with self.assertRaisesRegex(ValueError, 'sandbox_changed'):qemu_io.bounded_disk_io(args)

    def test_another_or_duplicate_thread_pool_is_refused(self):
        for args in [qemu_io.bounded_disk_io(self.baseline()),
                     self.baseline()+['-object', 'iothread,id=other']]:
            with self.assertRaisesRegex(ValueError, 'requires_review'):qemu_io.bounded_disk_io(args)

    def test_invalid_types_are_not_interpreted_as_arguments(self):
        for args in [None, 'qemu', [True], ['x']*257]:
            with self.assertRaises(ValueError):qemu_io.bounded_disk_io(args)


if __name__ == '__main__':unittest.main()
