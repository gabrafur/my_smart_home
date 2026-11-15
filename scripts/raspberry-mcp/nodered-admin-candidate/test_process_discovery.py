"""Synthetic discovery and own-child pidfd regression; no residential reads."""
import copy
import errno
import os
import subprocess
import time
import unittest
from unittest.mock import patch

import process_discovery as d


class ExitProofTests(unittest.TestCase):
    def test_live_zombie_and_reaped_child(self):
        child = subprocess.Popen(['/bin/sleep', '30'])
        try:
            self.assertFalse(d.kernel_proves_process_exited(child.pid))
            child.terminate()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if d.kernel_proves_process_exited(child.pid):
                    break
            else:
                self.fail('own child did not exit')
            self.assertFalse(d.kernel_proves_process_absent(child.pid))
            child.wait(timeout=3)
            self.assertTrue(d.kernel_proves_process_absent(child.pid))
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()

    def test_pidfd_permission_failure_is_not_exit_proof(self):
        with patch.object(d.os, 'pidfd_open', side_effect=PermissionError(errno.EACCES, 'fixture')):
            self.assertFalse(d.kernel_proves_process_exited(123))

    def test_unreadable_live_process_and_non_race_errors_refuse(self):
        for code in [errno.ENOENT, errno.ESRCH, errno.EINVAL, errno.EACCES, errno.EIO]:
            class IO:
                def process(self, pid):
                    raise OSError(code, 'fixture')
            with patch.object(d, 'kernel_proves_process_exited', return_value=False):
                with self.assertRaises(ValueError if code in (errno.ENOENT, errno.ESRCH, errno.EINVAL) else OSError):
                    d.read_process_identities([123], IO())

    def test_init_unreadable_stays_strict_even_if_exited(self):
        with patch.object(d, 'proc_text', side_effect=FileNotFoundError(errno.ENOENT, 'fixture')), \
             patch.object(d, 'kernel_proves_process_exited', return_value=True):
            with self.assertRaisesRegex(ValueError, 'transient_process_unavailable'):
                d.read_process_tree(10)

    def test_exited_descendant_is_a_leaf(self):
        def read(pid, suffix, limit):
            if pid == 10:
                return '20'
            raise FileNotFoundError(errno.ENOENT, 'fixture')
        with patch.object(d, 'proc_text', side_effect=read), \
             patch.object(d, 'kernel_proves_process_exited', return_value=True):
            self.assertEqual(d.read_process_tree(10), [10, 20])


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.identities = {
            pid: {'birth_ticks': pid * 10, 'state': 'S', 'uids': [1] * 4,
                  'gids': [1] * 4, 'root_identity': [1, 2], 'netns_identity': [1, 3],
                  'mountinfo_sha256': 'a' * 64, 'cgroup_identity': 'b' * 64,
                  'parent_pid': parent}
            for pid, parent in [(10, 1), (20, 10)]}
        self.anchor = {'pid': 100, 'birth_ticks': 1000, 'uid': 1, 'gid': 1,
                       'root_identity': [1, 2], 'netns_identity': [1, 3],
                       'mountinfo_sha256': 'a' * 64, 'image_digest': 'c' * 64,
                       'runtime_ancestor_pins': {}, 'backend_listener': {'socket_inode': 999}}
        outer = self
        class IO:
            def process(self, pid):
                if pid not in outer.identities:
                    raise FileNotFoundError(errno.ENOENT, 'fixture')
                return copy.deepcopy(outer.identities[pid])
            def peer_listener(self, pid, backend_host, activation):
                return {'pid': pid, 'socket_inode': 888}
        self.io = IO()
        self.exited = {30, 100}
        self.listeners = {20: 888}
        def listener(pid, anchor):
            if pid not in self.listeners:
                raise ValueError('process_owned_listener_missing')
            return self.listeners[pid]
        for target, value in [
            ('read_process_tree', lambda _: [10, 20, 30]),
            ('kernel_proves_process_exited', lambda pid: pid in self.exited),
            ('read_listener_inode', listener),
            ('credential_metadata', lambda *args: None),
        ]:
            patcher = patch.object(d, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def discover(self):
        return d.discover(self.anchor, self.io, None, None, None,
                          lambda a, b: a == b, '192.0.2.1', {},
                          lambda pins, anchor: {'init_pid': 10, 'image': 'c' * 64})

    def test_exited_unselected_descendant_does_not_block_selected_owner(self):
        observed, finish = self.discover()
        self.assertEqual(observed['pid'], 20)
        self.assertEqual(observed['backend_listener']['socket_inode'], 888)
        finish()

    def test_second_live_listener_owner_is_not_discarded(self):
        self.identities[30] = {**self.identities[20], 'birth_ticks': 300}
        self.listeners[30] = 888
        self.exited.remove(30)
        with self.assertRaisesRegex(ValueError, 'unique_descendant_listener_unconfirmed'):
            self.discover()

    def test_selected_owner_exit_and_pid_reuse_still_refuse(self):
        _, finish = self.discover()
        self.identities[20]['birth_ticks'] += 1
        with self.assertRaisesRegex(ValueError, 'container_or_descendant_read_race'):
            finish()
        del self.identities[20]
        self.exited.add(20)
        self.listeners.clear()
        with self.assertRaisesRegex(ValueError, 'unique_descendant_listener_unconfirmed'):
            finish()

    def test_unselected_listener_race_requires_kernel_exit_proof(self):
        self.identities[30] = {**self.identities[20], 'birth_ticks': 300}
        original = d.read_listener_inode
        def read(pid, anchor):
            if pid == 30:
                raise ValueError('listener_fd_read_race')
            return original(pid, anchor)
        with patch.object(d, 'read_listener_inode', read):
            _, finish = self.discover()
            finish()
            self.exited.remove(30)
            with self.assertRaisesRegex(ValueError, 'listener_fd_read_race'):
                self.discover()

    def test_selected_owner_credentials_and_ancestry_stay_strict(self):
        self.identities[20]['uids'] = [2] * 4
        with self.assertRaisesRegex(ValueError, 'runtime_owner_or_liveness_changed'):
            self.discover()
        self.identities[20]['uids'] = [1] * 4
        self.identities[20]['cgroup_identity'] = 'd' * 64
        with self.assertRaisesRegex(ValueError, 'anchor_container_cgroup_mismatch'):
            self.discover()


if __name__ == '__main__':
    unittest.main()
