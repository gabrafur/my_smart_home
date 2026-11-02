"""Synthetic waiting and post-wait validation; no native calls or real sleeps."""
import copy
import unittest
from unittest.mock import patch
import client
import native_manager as n
import test_controller as f

class WaitTests(f.BindingCore):
    def test_reader_becomes_inactive_before_effect(self):
        self.call(); self.manager.value['unit_active']='active'
        def wait(): self.manager.value['unit_active']='inactive'
        self.manager.wait_inactive=wait
        self.assertEqual(self.call('apply')['state'],'applied')
        self.assertEqual(len(self.manager.writes),1)
    def test_timeout_produces_no_intent_or_effect(self):
        self.call()
        def wait(): raise f.m.Refused('reader_active_no_effect_performed')
        self.manager.wait_inactive=wait
        with self.assertRaises(f.m.Refused): self.call('apply')
        self.assertEqual(self.store.events,['planned']);self.assertEqual(self.manager.writes,[])
    def test_changed_identity_value_or_expiry_refuse_before_intent(self):
        for kind in ('instance','peer','unit','allowed','expiry'):
            with self.subTest(kind=kind):
                self.setUp();self.call()
                def wait():
                    if kind=='instance': self.manager.value['container_id']='9'*64
                    if kind=='peer': self.manager.value['peer_ipv4']='192.0.2.8'
                    if kind=='unit': self.manager.value['unit_sha256']='8'*64
                    if kind=='allowed': self.manager.value['allowed']=sorted(f.policy()['base_allow']+['192.0.2.8/32'])
                    if kind=='expiry': self.now+=900
                self.manager.wait_inactive=wait
                with self.assertRaises(f.m.Refused): self.call('apply')
                self.assertEqual(self.store.events,['planned']);self.assertEqual(self.manager.writes,[])

class WaitNativeTests(unittest.TestCase):
    def test_inactive_observed_near_29_seconds_without_extra_poll(self):
        class Store:
            def assert_locked(self): pass
        tick=[0.0]
        class Runner:
            def __init__(self): self.calls=[]
            def run(self, argv, *, read_deadline_seconds=2):
                self.calls.append((argv,read_deadline_seconds))
                values={p:'' for p in n.PROPERTIES}
                values.update(ActiveState='inactive' if tick[0]>=29.5 else 'active',
                              MainPID='0' if tick[0]>=29.5 else '1')
                return '\n'.join(k+'='+v for k,v in values.items())
        runner=Runner();manager=n.Manager({},runner,Store(),{n.SIDECAR:'x',n.SNAPSHOT:'y'})
        with patch.object(n.time,'monotonic',side_effect=lambda:tick[0]), patch.object(n.time,'sleep',side_effect=lambda x:tick.__setitem__(0,tick[0]+x)):
            manager.wait_inactive()
        self.assertGreaterEqual(tick[0],29.5);self.assertLessEqual(tick[0],30)
        self.assertLessEqual(len(runner.calls),16)
        self.assertTrue(all(call[:4]==[n.SYSTEMCTL,'--no-pager','show',n.UNIT] for call,_ in runner.calls))
        self.assertLessEqual(runner.calls[-1][1],0.5)

    def test_fixed_show_only_and_poll_bound(self):
        class Store:
            def assert_locked(self): pass
        class Runner:
            def __init__(self): self.calls=[]
            def run(self, argv, *, read_deadline_seconds=2):
                self.calls.append(argv)
                values={p:'' for p in n.PROPERTIES};values.update(ActiveState='active',MainPID='1')
                return '\n'.join(k+'='+v for k,v in values.items())
        runner=Runner();manager=n.Manager({},runner,Store(),{n.SIDECAR:'x',n.SNAPSHOT:'y'})
        tick=[0.0]
        with patch.object(n.time,'monotonic',side_effect=lambda:tick[0]), patch.object(n.time,'sleep',side_effect=lambda x:tick.__setitem__(0,tick[0]+x)):
            with self.assertRaises(n.Refused): manager.wait_inactive()
        self.assertLessEqual(len(runner.calls),16)
        self.assertTrue(all(call[:4]==[n.SYSTEMCTL,'--no-pager','show',n.UNIT] for call in runner.calls))
        self.assertLessEqual(tick[0],30)
    def test_client_budget_covers_nominal_bounded_native_calls(self):
        # Wait 30s + three inspections (Docker 2s and show 2s each) + write 4s.
        self.assertEqual(n.WAIT_SECONDS,30); self.assertEqual(n.WAIT_MAX_POLLS,16)
        self.assertGreater(client.TIMEOUT_SECONDS,30+3*(2+2)+4)
        self.assertLess(client.TIMEOUT_SECONDS,50)

    def test_short_deadline_is_not_accepted_for_write(self):
        runner=n.PinnedRunner({n.SYSTEMCTL:'a'*64})
        argv=[n.SYSTEMCTL,'--no-ask-password','--runtime','set-property',n.UNIT,
              'IPAddressAllow=', 'IPAddressAllow=127.0.0.0/8',
              'IPAddressAllow=::1/128', 'IPAddressAllow=198.51.100.1/32',
              'IPAddressAllow=192.0.2.3/32']
        with patch.object(n,'root_file',side_effect=AssertionError('must not execute')):
            with self.assertRaisesRegex(n.Refused,'native_write_deadline_override_refused'):
                runner.run(argv,read_deadline_seconds=0.5)

    def test_invalid_read_deadlines_fail_before_execution(self):
        runner=n.PinnedRunner({n.SYSTEMCTL:'a'*64})
        argv=[n.SYSTEMCTL,'--no-pager','show',n.UNIT,
              *['--property='+p for p in n.PROPERTIES]]
        with patch.object(n,'root_file',side_effect=AssertionError('must not execute')):
            for value in (0,-1,2.01,float('inf'),float('nan'),True):
                with self.subTest(value=value), self.assertRaises(n.Refused):
                    runner.run(argv,read_deadline_seconds=value)

if __name__=='__main__': unittest.main()
