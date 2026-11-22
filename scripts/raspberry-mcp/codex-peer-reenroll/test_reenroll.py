"""Synthetic suite for the Codex peer re-enrollment (no host, network or Root access)."""
import base64
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

import reenroll

OLD = 'a' * 64
NEW = 'b' * 64
VERSION = '0.172.0-linux-arm64'


def enrollment(**ident):
    identity = {'executable_gid': 1001, 'executable_mode': 448, 'executable_path': '/x/codex',
                'executable_sha256': OLD, 'executable_size': 10, 'executable_uid': 1001,
                'listen_kind': 'unix_local_socket', 'role': 'app-server'}
    identity.update(ident)
    cfg = {'daemon_cgroup': '0::/system.slice/cron.service', 'daemon_identity': identity, 'enabled': True,
           'owner_confirmation_sha256': 'c' * 64, 'schema': 'raspberry-task-peer-attestor-v2'}
    return reenroll.canonical(cfg) + b'\n'


def tarball(members):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, body in members:
            info = tarfile.TarInfo(name)
            info.size = len(body)
            archive.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


def metadata(body, version=VERSION, **dist):
    data = {'tarball': reenroll.TARBALL % version,
            'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(body).digest()).decode()}
    data.update(dist)
    return {'name': '@openai/codex', 'version': version, 'dist': data}


def fake_fetcher(meta, body):
    def fetch(url, limit, sink=None):
        if sink is None:
            assert url == reenroll.REGISTRY + VERSION
            return json.dumps(meta).encode()
        assert url == reenroll.TARBALL % VERSION
        sink(body[:5])
        sink(body[5:])
        return len(body)
    return fetch


class Derive(unittest.TestCase):
    def test_changes_only_the_executable_identity(self):
        after = json.loads(reenroll.derive(enrollment(), NEW, 42))
        before = json.loads(enrollment())
        self.assertEqual(after['daemon_identity']['executable_sha256'], NEW)
        self.assertEqual(after['daemon_identity']['executable_size'], 42)
        after['daemon_identity'].update(executable_sha256=OLD, executable_size=10)
        self.assertEqual(after, before)

    def test_keeps_the_exact_serialization(self):
        out = reenroll.derive(enrollment(), NEW, 42)
        self.assertTrue(out.endswith(b'}\n'))
        self.assertEqual(reenroll.canonical(json.loads(out)) + b'\n', out)

    def test_refuses_unknown_serialization(self):
        pretty = json.dumps(json.loads(enrollment()), indent=1).encode()
        with self.assertRaisesRegex(reenroll.Refused, 'enrollment_serialization_unknown'):
            reenroll.derive(pretty, NEW, 42)

    def test_refuses_invalid_identity(self):
        for sha, size in (('not-a-sha', 42), (NEW, 0), (NEW, True), (NEW, reenroll.MAX_EXECUTABLE + 1)):
            with self.assertRaisesRegex(reenroll.Refused, 'executable_identity_invalid'):
                reenroll.derive(enrollment(), sha, size)


class Registry(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.work = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_returns_the_published_binary_identity(self):
        binary = b'codex-binary-bytes'
        body = tarball([('package/package.json', b'{}'), (reenroll.MEMBER, binary)])
        got = reenroll.registry_identity(VERSION, self.work, fake_fetcher(metadata(body), body))
        self.assertEqual(got, (hashlib.sha256(binary).hexdigest(), len(binary)))
        self.assertEqual(list(self.work.iterdir()), [], 'the download is always removed')

    def test_refuses_a_tarball_that_does_not_match_the_registry_integrity(self):
        body = tarball([(reenroll.MEMBER, b'real')])
        tampered = tarball([(reenroll.MEMBER, b'tampered')])
        with self.assertRaisesRegex(reenroll.Refused, 'registry_integrity_mismatch'):
            reenroll.registry_identity(VERSION, self.work, fake_fetcher(metadata(body), tampered))
        self.assertEqual(list(self.work.iterdir()), [])

    def test_refuses_metadata_for_another_package_version_or_host(self):
        body = tarball([(reenroll.MEMBER, b'x')])
        bad = [dict(metadata(body), name='evil'), metadata(body, version='0.1.0-linux-arm64'),
               metadata(body, tarball='https://example.invalid/codex.tgz'), metadata(body, integrity='sha1-abc')]
        for meta in bad:
            with self.assertRaises(reenroll.Refused):
                reenroll.check_metadata(meta, VERSION)

    def test_refuses_archives_without_exactly_one_regular_binary(self):
        for members in ([('package/other', b'x')], [(reenroll.MEMBER, b'x'), (reenroll.MEMBER, b'y')]):
            path = self.work / 'a.tgz'
            path.write_bytes(tarball(members))
            with self.assertRaises(reenroll.Refused):
                reenroll.member_identity(path)

    def test_installed_version_pattern_is_closed(self):
        for good in ('0.171.0-linux-arm64', '1.2.3-beta.4-linux-arm64'):
            self.assertTrue(reenroll.VERSION.fullmatch(good))
        for bad in ('0.171.0', '0.171.0-linux-x64', '../0.1.0-linux-arm64', '0.171.0-linux-arm64/'):
            self.assertIsNone(reenroll.VERSION.fullmatch(bad))


class OperatorHome(unittest.TestCase):
    """The host_operator home comes from the sealed enrollment uid, never from a tracked name."""

    @staticmethod
    def passwd(home):
        def lookup(uid):
            if uid != 1001:
                raise KeyError(uid)
            return type('Entry', (), {'pw_dir': home})()
        return lookup

    def test_paths_follow_the_enrolled_uid(self):
        home = reenroll.operator_home({'executable_uid': 1001}, self.passwd('/home/example_operator/'))
        self.assertEqual(home, Path('/home/example_operator'))
        self.assertEqual(str(home / reenroll.CONTROL_SOCKET),
                         '/home/example_operator/.codex/app-server-control/app-server-control.sock')

    def test_root_unknown_or_bool_uid_is_refused(self):
        for ident in ({'executable_uid': 0}, {'executable_uid': True}, {'executable_uid': 1002}, {}):
            with self.assertRaises(reenroll.Refused):
                reenroll.operator_home(ident, self.passwd('/home/example_operator'))

    def test_unsafe_home_is_refused(self):
        for home in ('relative/home', '/', '/home/../root'):
            with self.assertRaises(reenroll.Refused):
                reenroll.operator_home({'executable_uid': 1001}, self.passwd(home))


class Backoff(unittest.TestCase):
    def test_backs_off_only_for_the_same_failed_binary(self):
        last = {'live_sha256': NEW, 'state': 'failed', 'reason': 'registry_unavailable:URLError', 'at_epoch': 1000}
        self.assertTrue(reenroll.backoff_active(last, NEW, clock=lambda: 1000 + 60))
        self.assertFalse(reenroll.backoff_active(last, NEW, clock=lambda: 1000 + reenroll.BACKOFF_FAILURE + 1))
        self.assertFalse(reenroll.backoff_active(last, 'c' * 64, clock=lambda: 1060))

    def test_registry_mismatch_waits_longer(self):
        last = {'live_sha256': NEW, 'state': 'refused', 'reason': 'live_binary_differs_from_registry', 'at_epoch': 0}
        self.assertTrue(reenroll.backoff_active(last, NEW, clock=lambda: reenroll.BACKOFF_FAILURE + 1))
        self.assertFalse(reenroll.backoff_active(last, NEW, clock=lambda: reenroll.BACKOFF_MISMATCH + 1))

    def test_no_backoff_after_success_or_without_history(self):
        self.assertFalse(reenroll.backoff_active({'live_sha256': NEW, 'state': 'reenrolled', 'at_epoch': 0}, NEW,
                                                 clock=lambda: 1))
        self.assertFalse(reenroll.backoff_active(None, NEW))


class Run(unittest.TestCase):
    """run() end to end against temporary files, with the host observation and registry faked."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.saved = {k: getattr(reenroll, k) for k in ('ENROLLMENT', 'STATE', 'LOCK', 'sealed_enrollment', 'observe',
                                                        'installed_version', 'registry_identity', 'os')}
        reenroll.ENROLLMENT = root / 'enrollment.json'
        reenroll.ENROLLMENT.write_bytes(enrollment())
        reenroll.STATE = root / 'state'
        reenroll.STATE.mkdir()
        reenroll.LOCK = root / 'lock'
        reenroll.LOCK.write_bytes(b'')
        reenroll.sealed_enrollment = lambda: reenroll.ENROLLMENT.read_bytes()
        reenroll.installed_version = lambda ident: VERSION
        self.peer = {'pid': 7, 'sha256': NEW, 'size': 42, 'stat': [1, 2, 42, 3, 4], 'socket': [1, 9]}
        reenroll.observe = lambda ident, cgroup, cache=None: dict(self.peer)
        self.registry_calls = 0

        def registry(version, workdir):
            self.registry_calls += 1
            return (NEW, 42)
        reenroll.registry_identity = registry

        class NoChown:  # tests run unprivileged; everything else is the real os module
            def __getattr__(self, name):
                return getattr(self.real, name)
            real = self.saved['os']

            @staticmethod
            def chown(*_):
                return None
        reenroll.os = NoChown()

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(reenroll, k, v)
        self.folder.cleanup()

    def test_reenrolls_a_registry_verified_binary_and_keeps_the_previous_enrollment(self):
        before = reenroll.ENROLLMENT.read_bytes()
        out = reenroll.run(clock=lambda: 1000)
        self.assertEqual(out['state'], 'reenrolled')
        self.assertEqual(reenroll.ENROLLMENT.read_bytes(), reenroll.derive(before, NEW, 42))
        backups = list((reenroll.STATE / 'previous').iterdir())
        self.assertEqual([b.read_bytes() for b in backups], [before])

    def test_current_binary_needs_no_registry_check(self):
        reenroll.ENROLLMENT.write_bytes(reenroll.derive(enrollment(), NEW, 42))
        self.assertEqual(reenroll.run()['state'], 'current')
        self.assertEqual(self.registry_calls, 0)

    def test_binary_that_differs_from_the_registry_is_never_enrolled(self):
        reenroll.registry_identity = lambda version, workdir: ('d' * 64, 42)
        before = reenroll.ENROLLMENT.read_bytes()
        out = reenroll.run()
        self.assertEqual((out['state'], out['reason']), ('refused', 'live_binary_differs_from_registry'))
        self.assertEqual(reenroll.ENROLLMENT.read_bytes(), before)

    def test_registry_outage_backs_off_without_writing(self):
        def down(version, workdir):
            self.registry_calls += 1
            raise OSError('offline')
        reenroll.registry_identity = down
        before = reenroll.ENROLLMENT.read_bytes()
        first = reenroll.run(clock=lambda: 1000)
        self.assertEqual(first['state'], 'failed')
        (reenroll.STATE / 'status.json').write_text(json.dumps(first))
        self.assertEqual(reenroll.run(clock=lambda: 1060)['state'], 'backoff')
        self.assertEqual(self.registry_calls, 1)
        self.assertEqual(reenroll.ENROLLMENT.read_bytes(), before)

    def test_peer_change_during_the_check_aborts_the_swap(self):
        calls = iter([dict(self.peer), dict(self.peer, pid=8)])
        reenroll.observe = lambda ident, cgroup, cache=None: next(calls)
        before = reenroll.ENROLLMENT.read_bytes()
        with self.assertRaisesRegex(reenroll.Refused, 'peer_changed_during_check'):
            reenroll.run()
        self.assertEqual(reenroll.ENROLLMENT.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
