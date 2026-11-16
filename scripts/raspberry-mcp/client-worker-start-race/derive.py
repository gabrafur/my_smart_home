"""Pure derivation: wait for the restarted client events worker to finish exec before reading its identity.

raspberry-mcp-events.service is Type=simple: ``systemctl start`` returns right after the
fork, and on this host the sandboxed child stays ``(python3)`` with UID 0 for about
730 ms before exec. The client lifecycle read the worker identity ~300 ms after the
start, inside that window, so ``worker_identity`` refused (uid/argv) and every client
cutover or rollback ended ``uncertain_observe_only`` at ``tunnel_start_pending`` even
though all services had started.

``post_start`` now retries only those pre-exec identity refusals, bounded by the
lifecycle ``maximum_phase_seconds``; any other refusal, or the deadline, still raises.
Pins of native_binding.py move exactly as in client-rollback-completion/derive.py.
"""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    'rollback_completion_derive', Path(__file__).resolve().parent.parent / 'client-rollback-completion' / 'derive.py')
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)
NAMES = _base.NAMES
need, sha, swap = _base.need, _base.sha, _base.swap

OLD = ("        identity=self.worker_identity();expected=next(r for r in self.package['files']if r['slot']=='client_events_worker')"
       "['before_sha256'if self.rolling else'after_sha256']\n")
NEW = ("        identity=None;identity_deadline=time.monotonic()+self.policy['maximum_phase_seconds']\n"
       "        while identity is None:\n"
       "            # Type=simple: the forked child keeps the pre-exec uid/argv for a moment.\n"
       "            try:identity=self.worker_identity()\n"
       "            except ValueError as error:\n"
       "                if error.args not in(('client_worker_uid_changed',),('client_worker_argv_changed',),('client_worker_cgroup_changed',),"
       "('client_worker_birth_unconfirmed',))or time.monotonic()>=identity_deadline:raise\n"
       "                time.sleep(.05)\n"
       "        expected=next(r for r in self.package['files']if r['slot']=='client_events_worker')"
       "['before_sha256'if self.rolling else'after_sha256']\n")


def patch(source):
    need(b'identity_deadline' not in source, 'native_binding_already_waits')
    return swap(source, OLD.encode(), NEW.encode(), 'post_start_identity_anchor')


def derive(before):
    need(type(before) is dict and set(before) == set(NAMES) and all(type(v) is bytes for v in before.values()), 'six_inputs')
    return _base.repin(before, 'native_binding', patch(before['native_binding']))
