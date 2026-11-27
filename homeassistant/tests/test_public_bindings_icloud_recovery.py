"""Real async recovery adapter, synthetic provider and reload only."""
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('bindings_recovery',
    Path(__file__).resolve().parents[1] / 'custom_components/public_bindings/icloud.py')
sut = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sut)

class SessionRejected(Exception): pass

class RecoveryTest(unittest.IsolatedAsyncioTestCase):
    def setup_case(self, *, missing=False, result='session_ready', post_error=None):
        self.calls=[]
        class Api:
            native_requires_2fa=False
            native_requires_2sa=False
            def __init__(api, error=None): api.error=error
            @property
            def devices(api): return api
            def refresh(api, locate):
                self.calls.append('refresh')
                if api.error: raise api.error
        account=SimpleNamespace(api=None if missing else Api(SessionRejected()),
            location_session_failure=lambda e:isinstance(e,SessionRejected),
            location_session_requires_otp=lambda:False)
        def recover(): self.calls.append('recover');return result
        account.recover_location_session=recover
        entry=SimpleNamespace(entry_id='synthetic',runtime_data=account)
        async def reload(entry_id):
            self.calls.append('reload')
            entry.runtime_data=SimpleNamespace(api=Api(post_error),_manual_platforms_loaded=True)
            return True
        hass=SimpleNamespace(async_add_executor_job=asyncio.to_thread,
            config_entries=SimpleNamespace(async_reload=reload))
        return hass,entry,asyncio.Lock()

    async def test_rejected_or_missing_client_renews_reloads_and_proves_refresh(self):
        for missing in [False,True]:
            case=self.setup_case(missing=missing)
            self.assertTrue(await sut.refresh_account_with_recovery(*case))
            self.assertEqual(self.calls.count('recover'),1)
            self.assertEqual(self.calls.count('reload'),1)
            self.assertEqual(self.calls[-1],'refresh')

    async def test_concurrent_residents_share_the_reload(self):
        case=self.setup_case()
        results=await asyncio.gather(sut.refresh_account_with_recovery(*case),
                                     sut.refresh_account_with_recovery(*case))
        self.assertEqual(results,[True,True])
        self.assertEqual(self.calls.count('recover'),1)
        self.assertEqual(self.calls.count('reload'),1)

    async def test_otp_stops_before_reload_and_never_sends_a_code(self):
        case=self.setup_case(result='otp_required')
        with self.assertRaises(sut.OTPRequired): await sut.refresh_account_with_recovery(*case)
        self.assertNotIn('reload',self.calls)
        case=self.setup_case()
        case[1].runtime_data.location_session_requires_otp=lambda:True
        with self.assertRaises(sut.OTPRequired): await sut.refresh_account_with_recovery(*case)
        self.assertEqual(self.calls,[])

    async def test_transport_unknown_and_spent_budget_do_not_loop(self):
        for error in [ConnectionError('synthetic'),RuntimeError('synthetic')]:
            case=self.setup_case();case[1].runtime_data.api.error=error
            with self.assertRaises(type(error)): await sut.refresh_account_with_recovery(*case)
            self.assertEqual(self.calls,['refresh'])
        case=self.setup_case(result='unavailable')
        with self.assertRaises(sut.RecoveryUnavailable): await sut.refresh_account_with_recovery(*case)
        self.assertEqual(self.calls.count('recover'),1)
        self.assertNotIn('reload',self.calls)

    async def test_token_accepted_but_provider_still_rejects_is_not_success(self):
        case=self.setup_case(post_error=SessionRejected())
        with self.assertRaises(SessionRejected): await sut.refresh_account_with_recovery(*case)
        self.assertEqual(self.calls.count('recover'),1)
        self.assertEqual(self.calls.count('reload'),1)

    async def test_challenge_discovered_by_native_refresh_is_an_otp_stop(self):
        case=self.setup_case()
        account=case[1].runtime_data
        account.location_session_requires_otp=lambda:bool(self.calls)
        account.api.error=RuntimeError('synthetic guarded challenge')
        with self.assertRaises(sut.OTPRequired):
            await sut.refresh_account_with_recovery(*case)
        self.assertEqual(self.calls,['refresh'])

    async def test_caller_arriving_during_reload_waits_for_the_reloaded_entry(self):
        # 27/11/2026: the second resident's call reached the entry while the
        # first call reloaded it and failed as "provider unavailable".
        hass,entry,lock=self.setup_case()
        reloading=asyncio.Event();release=asyncio.Event()
        state={'loaded':True}
        original=hass.config_entries.async_reload
        async def slow_reload(entry_id):
            state['loaded']=False;reloading.set();await release.wait()
            result=await original(entry_id);state['loaded']=True;return result
        hass.config_entries.async_reload=slow_reload
        loaded=lambda:state['loaded']
        first=asyncio.create_task(sut.refresh_account_with_recovery(hass,entry,lock,loaded=loaded))
        await reloading.wait()
        second=asyncio.create_task(sut.refresh_account_with_recovery(hass,entry,lock,loaded=loaded))
        await asyncio.sleep(0.05)
        self.assertFalse(second.done(),'the second call must wait for the reload')
        release.set()
        self.assertEqual(await asyncio.gather(first,second),[True,True])
        self.assertEqual(self.calls,['refresh','recover','reload','refresh','refresh'])

    async def test_refreshes_of_one_account_never_overlap(self):
        hass,entry,lock=self.setup_case()
        entry.runtime_data.api.error=None
        active={'now':0,'max':0}
        def refresh(api):
            active['now']+=1;active['max']=max(active['max'],active['now'])
            import time;time.sleep(0.05);active['now']-=1;return True
        original=sut.refresh_devices;sut.refresh_devices=refresh
        try:
            await asyncio.gather(*(sut.refresh_account_with_recovery(hass,entry,lock) for _ in range(3)))
        finally:
            sut.refresh_devices=original
        self.assertEqual(active['max'],1)

    async def test_entry_still_unloaded_after_waiting_is_a_stable_code(self):
        case=self.setup_case()
        with self.assertRaises(sut.RecoveryUnavailable):
            await sut.refresh_account_with_recovery(*case,loaded=lambda:False)
        self.assertEqual(self.calls,[])
