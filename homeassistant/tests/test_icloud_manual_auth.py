"""Exercise the installed guarded package with synthetic HA/provider boundaries."""

import asyncio
from contextlib import contextmanager
import importlib
import importlib.util
from pathlib import Path
from socket import gaierror
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import icloud_native_fixture

ROOT = Path(__file__).resolve().parents[1] / 'custom_components' / 'icloud'


class FakeService:
    """Provider boundary only; authentication policy comes from the real adapter."""
    def __init__(self, *args, **kwargs):
        self.options = kwargs
        self.deliveries = self.primary_calls = self.metadata_calls = self.validations = 0
        self.challenge = True
        self._auth_data = {}
        self.security_key_names = []

    @property
    def requires_2fa(self): return self.challenge
    @property
    def requires_2sa(self): return False

    def _try_reuse_cached_session(self, force_refresh, pause_2fa):
        if force_refresh or not pause_2fa:
            raise AssertionError('unsafe_cached_session_arguments')
        return False

    def _update_state(self): pass

    def _srp_authentication(self, *, pause_2fa):
        assert pause_2fa is True
        self.primary_calls += 1
        self._requires_mfa = self.challenge
        self.request_2fa_code()
        return False

    def authenticate(self, **kwargs):
        self.primary_calls += 1
        self.authentication_options = kwargs
        # The native fallback must still be suppressed by the actual subclass.
        self.request_2fa_code()

    def _get_mfa_auth_options(self):
        self.metadata_calls += 1
        return {'synthetic_route': 'trusted'}

    def _supports_trusted_device_bridge(self): return True
    def _can_request_sms_2fa_code(self): return False

    def request_2fa_code(self):
        self.deliveries += 1
        return True

    def validate_2fa_code(self, code):
        self.validations += 1
        return False


@contextmanager
def loaded_adapter():
    """Load real package/wiring; scope every external stub to this context."""
    names = ['pyicloud', 'pyicloud.exceptions', 'requests', 'requests.exceptions',
             'homeassistant', 'homeassistant.components', 'homeassistant.components.icloud',
             'homeassistant.components.icloud.account', 'homeassistant.components.icloud.const',
             'homeassistant.components.icloud.config_flow', 'homeassistant.const',
             'homeassistant.exceptions', 'homeassistant.config_entries',
             'homeassistant.helpers', 'homeassistant.helpers.event',
             'homeassistant.helpers.storage', 'homeassistant.helpers.issue_registry', 'probatio']
    modules = {name: ModuleType(name) for name in names}
    core = modules['homeassistant.components.icloud']
    account = modules['homeassistant.components.icloud.account']
    for name in dir(icloud_native_fixture):
        if not name.startswith('__'): setattr(account, name, getattr(icloud_native_fixture, name))
    handlers = {}
    modules['homeassistant.config_entries'].HANDLERS = handlers
    modules['homeassistant.config_entries'].SOURCE_REAUTH = 'reauth'
    modules['homeassistant.helpers.issue_registry'].async_delete_issue = Mock()
    modules['pyicloud'].PyiCloudService = FakeService
    modules['pyicloud.exceptions'].PyiCloudAuthRequiredException = type('AuthRequired', (Exception,), {})
    modules['requests.exceptions'].ConnectionError = type('RequestConnectionError', (ConnectionError,), {})
    modules['requests.exceptions'].Timeout = type('RequestTimeout', (TimeoutError,), {})
    not_ready = type('ConfigEntryNotReady', (Exception,), {})
    modules['homeassistant.exceptions'].ConfigEntryNotReady = not_ready
    modules['homeassistant.const'].__version__ = '2026.10.1'
    modules['homeassistant.const'].CONF_USERNAME = 'username'
    modules['homeassistant.const'].CONF_PASSWORD = 'password'
    const = modules['homeassistant.components.icloud.const']
    for name, value in {'CONF_WITH_FAMILY': 'with_family', 'CONF_MAX_INTERVAL': 'max_interval',
                        'CONF_GPS_ACCURACY_THRESHOLD': 'gps_accuracy', 'DEFAULT_WITH_FAMILY': False,
                        'DEFAULT_MAX_INTERVAL': 30, 'DEFAULT_GPS_ACCURACY_THRESHOLD': 100,
                        'PLATFORMS': ['synthetic_platform'], 'STORAGE_KEY': 'synthetic_session',
                        'STORAGE_VERSION': 1}.items(): setattr(const, name, value)

    class Store:
        def __init__(self, hass, version, key):
            self.hass, self.key, self.path = hass, key, '/synthetic-not-read'
        async def async_load(self): return self.hass.stores.get(self.key)
        async def async_save(self, row): self.hass.stores[self.key] = dict(row)
    modules['homeassistant.helpers.storage'].Store = Store
    modules['homeassistant.helpers.event'].async_track_time_interval = Mock(return_value=lambda: None)

    class Account:
        def __init__(self, hass, username, password, store, with_family, interval, accuracy, entry):
            self.hass, self._config_entry = hass, entry
            self._username, self._password = username, password
            self._icloud_dir, self._with_family = store, with_family
            self.api = None
        def setup(self):
            self.api = account.PyiCloudService(self._username, self._password, self._icloud_dir.path)
            if self.api.requires_2fa: self._require_reauth()
        def _require_reauth(self): self._config_entry.async_start_reauth(self.hass)
        def cancel_fetch(self): pass
        def keep_alive(self, now=None): pass
    account.IcloudAccount = Account
    account.PyiCloudService = FakeService
    core.account = account
    core.CONFIG_SCHEMA = object()
    core.async_setup = AsyncMock(return_value=True)
    core.async_unload_entry = AsyncMock(return_value=True)
    core.async_setup_photo_cache = AsyncMock()
    core.IcloudCalendarCoordinator = Mock(side_effect=lambda *args: SimpleNamespace(async_refresh=AsyncMock()))
    core.IcloudRemindersCoordinator = Mock(side_effect=lambda *args: SimpleNamespace(async_refresh=AsyncMock()))

    class Flow:
        def __init_subclass__(cls, domain=None, **kwargs):
            super().__init_subclass__(**kwargs)
            if domain: handlers[domain] = cls
        async def async_set_unique_id(self, value): self.unique_id = value
        def async_show_form(self, **kwargs): return {'type': 'form', **kwargs}
        def async_abort(self, **kwargs): return {'type': 'abort', **kwargs}
        def async_create_entry(self, **kwargs): return {'type': 'create_entry', **kwargs}
    flow = modules['homeassistant.components.icloud.config_flow']
    flow.IcloudFlowHandler = Flow
    flow.PyiCloudService = FakeService
    core.config_flow = flow
    modules['probatio'].Schema = lambda fields: SimpleNamespace(schema=fields)
    modules['probatio'].Required = modules['probatio'].Optional = lambda name, **kwargs: name

    with patch.dict(sys.modules, modules), patch('socket.socket', side_effect=AssertionError('network_forbidden')):
        spec = importlib.util.spec_from_file_location('icloud_guard_fixture', ROOT / '__init__.py',
                                                     submodule_search_locations=[str(ROOT)])
        sut = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = sut
        spec.loader.exec_module(sut)
        alias = importlib.import_module(spec.name + '.manual_auth')
        config_flow = importlib.import_module(spec.name + '.config_flow')
        bridge = importlib.import_module(spec.name + '.native_bridge')
        yield SimpleNamespace(sut=sut, alias=alias, flow=config_flow.ManualIcloudFlow,
                              bridge=bridge, account=account, core=core, handlers=handlers,
                              NotReady=not_ready, NativeService=FakeService)


def synthetic_hass_entry():
    async def executor(fn, *args): return await asyncio.to_thread(fn, *args)
    entry = SimpleNamespace(entry_id='synthetic_entry', unique_id='synthetic',
                            data={'username': 'synthetic@example.invalid', 'password': 'synthetic-only',
                                  'with_family': False, 'max_interval': 30, 'gps_accuracy': 100},
                            async_start_reauth=Mock(),async_get_active_flows=Mock(return_value=[]))
    hass = SimpleNamespace(stores={}, async_add_executor_job=executor,
                           config_entries=SimpleNamespace(flow=SimpleNamespace(async_abort=Mock()), async_update_entry=Mock(),
                               async_reload=AsyncMock(return_value=True),
                               async_forward_entry_setups=AsyncMock()))
    return hass, entry


class ManualOtpServiceTest(unittest.TestCase):
    def setUp(self):
        self.env = self.enterContext(loaded_adapter())
        self.saved = []
        self.gate = self.env.sut.AuthGate(self.saved.append,
                                        {'schema_version': 1, 'state': self.env.sut.State.USER})
        with self.env.bridge.bind_gate(self.gate):
            self.client = self.env.alias.ManualOtpService('synthetic@example.invalid', 'synthetic-only')

    def prepare(self):
        result = self.client.prepare_manual_session()
        self.assertEqual(result.state, self.env.sut.State.READY)
        self.assertEqual(self.client.deliveries, 0)
        self.assertEqual(self.client.metadata_calls, 1)
        self.assertTrue(self.client.authentication_options['pause_2fa'])

    def test_initial_login_and_repeated_background_failures_never_deliver(self):
        self.assertFalse(self.client.options['authenticate'])
        self.assertTrue(self.client.options['pause_2fa'])
        for _ in range(3):
            with self.assertRaises(self.env.bridge.ManualActionRequired):
                self.client.authenticate(force_refresh=True, pause_2fa=False)
        self.assertEqual(self.client.primary_calls, 0)
        self.assertEqual(self.client.deliveries, 0)
        self.assertTrue(self.client.requires_2fa)

    def test_manual_delivery_does_not_unlock_background_delivery(self):
        self.prepare()
        sent = self.client.request_manual_2fa_code()
        self.assertEqual(sent.state, self.env.sut.State.CODE)
        self.assertEqual(self.client.deliveries, 1)
        with self.assertRaises(self.env.bridge.ManualActionRequired): self.client.authenticate()
        self.assertFalse(self.client.request_2fa_code())
        self.assertFalse(self.client.request_manual_2fa_code().effect_attempted)
        self.assertEqual(self.client.deliveries, 1)

    def test_manual_provider_failure_does_not_trigger_automatic_retry(self):
        self.prepare()
        with patch.object(FakeService, 'request_2fa_code', side_effect=RuntimeError('synthetic provider failure')) as call:
            result = self.client.request_manual_2fa_code()
            self.assertEqual(result.state, self.env.sut.State.UNCERTAIN)
            self.assertFalse(self.client.request_manual_2fa_code().effect_attempted)
            self.assertFalse(self.client.prepare_manual_session().effect_attempted)
            self.assertFalse(self.client.request_2fa_code())
            call.assert_called_once()
        restored = self.env.sut.AuthGate(self.saved.append, self.saved[-1])
        effect = Mock()
        restored.submit('request_challenge', effect, explicit_submission=True)
        restored.cached_session(effect)
        effect.assert_not_called()


class NativeFlowTest(unittest.IsolatedAsyncioTestCase):
    """Run the actual local flow even when the host lacks the native HA runtime."""
    async def asyncSetUp(self):
        self.env = self.enterContext(loaded_adapter())
        self.hass, self.entry = synthetic_hass_entry()
        self.enterContext(patch.object(self.env.sut, 'emit_proof', new_callable=AsyncMock))
        self.assertTrue(await self.env.sut.async_setup_entry(self.hass, self.entry))
        self.flow = self.env.flow()
        self.flow.hass = self.hass
        self.flow._get_reauth_entry = lambda: self.entry
        await self.flow.async_step_reauth(self.entry.data)
        self.api = self.flow.api
        self.initial_primary_calls = self.api.primary_calls

    async def prepared(self):
        result = await self.flow.async_step_manual_reauth({})
        self.assertEqual(result['step_id'], 'verification_code')
        self.assertEqual(self.api.deliveries, 0)

    async def test_default_setup_attempts_silent_login_but_never_delivers_OTP(self):
        self.assertEqual(self.initial_primary_calls, 1)
        self.assertTrue(self.api.auth_gate.automatic_recovery)
        self.assertEqual(self.api.auth_gate.state, self.env.sut.State.PRIMARY)
        self.assertEqual(self.api.deliveries, 0)

    async def test_opening_repair_empty_submit_and_invalid_code_do_not_deliver(self):
        await self.flow.async_step_manual_reauth()
        self.assertEqual(self.api.primary_calls, self.initial_primary_calls)
        await self.prepared()
        for user_input in (None, {}, {'verification_code': 'synthetic-invalid'}):
            result = await self.flow.async_step_verification_code(user_input)
            self.assertEqual(result['type'], 'form')
        self.assertEqual(self.api.deliveries, 0)
        self.assertEqual(self.api.validations, 0)
        await self.flow.async_step_verification_code({'request_new_code': True})
        await self.flow.async_step_verification_code({'verification_code': 'synthetic-invalid'})
        self.assertEqual(self.api.deliveries, 1)
        self.assertEqual(self.api.validations, 1)
        self.assertEqual(self.api.auth_gate.state, self.env.sut.State.CODE)

    async def test_explicit_request_delivers_once_without_validating_empty_code(self):
        await self.prepared()
        for _ in range(2):
            result = await self.flow.async_step_verification_code({'request_new_code': True})
        self.assertEqual(result['step_id'], 'verification_code')
        self.assertEqual(self.api.deliveries, 1)
        await self.flow.async_step_verification_code({'verification_code': ''})
        self.assertEqual(self.api.validations, 0)

    async def test_failed_manual_request_stays_pending_without_retry(self):
        await self.prepared()
        with patch.object(FakeService, 'request_2fa_code', side_effect=RuntimeError('synthetic')) as send:
            result = await self.flow.async_step_verification_code({'request_new_code': True})
            self.assertEqual(result['errors']['base'], 'delivery_unknown')
            await self.flow.async_step_verification_code({'request_new_code': True})
            await self.flow.async_step_manual_reauth({})
            send.assert_called_once()
        self.assertEqual(self.hass.stores['icloud_manual_reauth.synthetic_entry']['state'],
                         self.env.sut.State.UNCERTAIN)

    async def test_existing_accounts_and_config_flows_use_the_same_guard(self):
        self.assertIs(self.env.account.PyiCloudService, self.env.sut.GuardedService)
        self.assertIs(self.env.alias.ManualOtpService, self.env.sut.GuardedService)
        self.assertIs(self.env.handlers['icloud'], self.env.flow)
        self.assertIsInstance(self.entry.runtime_data, self.env.sut.GuardedAccount)
        self.assertIs(self.api.auth_gate, self.env.sut.GATES[self.entry.entry_id])
        self.assertIs(self.env.core.config_flow.PyiCloudService, FakeService)

    async def test_waiting_unload_does_not_unload_platforms_never_loaded(self):
        self.assertFalse(self.entry.runtime_data._manual_platforms_loaded)
        with patch.object(self.entry.runtime_data, 'cancel_fetch') as cancel:
            self.assertTrue(await self.env.sut.async_unload_entry(self.hass, self.entry))
            cancel.assert_called_once()
        self.env.core.async_unload_entry.assert_not_awaited()
        self.assertNotIn(self.entry.entry_id, self.env.sut.GATES)

    async def test_missing_persisted_gate_blocks_setup_before_provider_access(self):
        with patch.object(self.env.sut, 'load_native_gate', side_effect=OSError('synthetic storage failure')), \
             patch.object(self.env.sut.GuardedAccount, 'setup') as setup:
            with self.assertRaises(self.env.NotReady):
                await self.env.sut.async_setup_entry(self.hass, self.entry)
            setup.assert_not_called()


class SetupRetryTest(unittest.IsolatedAsyncioTestCase):
    async def test_only_complete_authenticated_setup_releases_previous_attempt(self):
        env=self.enterContext(loaded_adapter())
        hass,entry=synthetic_hass_entry()
        self.enterContext(patch.object(env.sut,'emit_proof',new_callable=AsyncMock))
        auth_key='icloud_manual_reauth.'+entry.entry_id
        recovery_key='icloud_silent_recovery.'+entry.entry_id
        hass.stores[auth_key]={'schema_version':1,'state':'session_valid'}
        hass.stores[recovery_key]={'schema_version':1,'primary_attempted':True}
        self.enterContext(patch.object(FakeService,'_try_reuse_cached_session',return_value=True))
        self.enterContext(patch.object(FakeService,'requires_2fa',new=property(lambda self:False)))
        hass.config_entries.async_forward_entry_setups.side_effect=RuntimeError('synthetic platform failure')
        with self.assertRaises(RuntimeError):await env.sut.async_setup_entry(hass,entry)
        self.assertTrue(hass.stores[recovery_key]['primary_attempted'])
        self.assertNotEqual(env.sut.PHASES[entry.entry_id],'entry_ready')
        hass.config_entries.async_forward_entry_setups.side_effect=None
        async def photo_setup(*args):
            self.assertTrue(hass.stores[recovery_key]['primary_attempted'])
        env.core.async_setup_photo_cache.side_effect=photo_setup
        self.assertTrue(await env.sut.async_setup_entry(hass,entry))
        self.assertFalse(hass.stores[recovery_key]['primary_attempted'])
        self.assertEqual(env.sut.PHASES[entry.entry_id],'entry_ready')
        self.assertEqual(entry.runtime_data.api.primary_calls,0)
        self.assertEqual(entry.runtime_data.api.deliveries,0)

    async def test_wrapped_dns_failure_retries_then_native_setup_recovers(self):
        env = self.enterContext(loaded_adapter())
        hass, entry = synthetic_hass_entry()
        self.enterContext(patch.object(env.sut, 'emit_proof', new_callable=AsyncMock))
        dns = gaierror(-3, 'synthetic DNS unavailable')
        wrapped = RuntimeError('synthetic wrapped transport')
        wrapped.__cause__ = dns
        calls = []
        def setup(account):
            calls.append(account)
            if len(calls) == 1: raise wrapped
            account.api = SimpleNamespace(requires_2fa=False)
        with patch.object(env.account.IcloudAccount, 'setup', setup), \
             patch.object(FakeService, 'request_2fa_code') as send:
            with self.assertRaises(env.NotReady) as caught:
                await env.sut.async_setup_entry(hass, entry)
            self.assertIn('transport unavailable', str(caught.exception))
            self.assertEqual(len(calls), 1)
            self.assertTrue(await env.sut.async_setup_entry(hass, entry))
            self.assertEqual(len(calls), 2)
            self.assertEqual(env.sut.PHASES[entry.entry_id], 'entry_ready')
            hass.config_entries.async_forward_entry_setups.assert_awaited_once()
            send.assert_not_called()
        for error in (ValueError('synthetic config error'), RuntimeError('synthetic authentication error')):
            with patch.object(env.account.IcloudAccount, 'setup', side_effect=error):
                with self.assertRaises(type(error)) as caught:
                    await env.sut.async_setup_entry(hass, entry)
                self.assertIs(caught.exception, error)
        cycle = RuntimeError('synthetic cycle')
        cycle.__context__ = cycle
        self.assertFalse(env.sut.is_transport_failure(cycle))


def has_native_runtime():
    try:
        return importlib.util.find_spec('homeassistant.core') is not None
    except (ImportError, ValueError):
        return False


@unittest.skipUnless(has_native_runtime(), 'Requires the isolated pinned Home Assistant image')
class NativeRuntimeContractTest(unittest.IsolatedAsyncioTestCase):
    """Retain real HA/pyicloud coverage separately from the always-run host cases."""
    async def asyncSetUp(self):
        import tempfile
        from homeassistant.core import HomeAssistant
        from homeassistant.config_entries import ConfigEntries
        from homeassistant.helpers.storage import Store
        from homeassistant.components.icloud.const import (
            CONF_WITH_FAMILY, CONF_MAX_INTERVAL, CONF_GPS_ACCURACY_THRESHOLD,
            DEFAULT_WITH_FAMILY, DEFAULT_MAX_INTERVAL, DEFAULT_GPS_ACCURACY_THRESHOLD)
        sys.path.insert(0, str(ROOT.parents[1]))
        self.addCleanup(lambda: sys.path.remove(str(ROOT.parents[1])))
        from custom_components import icloud as sut
        from custom_components.icloud.config_flow import ManualIcloudFlow
        self.sut = sut
        self.temp = tempfile.TemporaryDirectory(prefix='icloud-native-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.hass = HomeAssistant(self.temp.name)
        self.hass.config_entries = ConfigEntries(self.hass, {})
        await self.hass.config_entries.async_initialize()
        self.entry = SimpleNamespace(entry_id='synthetic_entry', unique_id='synthetic',
            options={'automatic_session_recovery':False},
            data={'username': 'synthetic@example.invalid', 'password': 'synthetic-only',
                  CONF_WITH_FAMILY: DEFAULT_WITH_FAMILY, CONF_MAX_INTERVAL: DEFAULT_MAX_INTERVAL,
                  CONF_GPS_ACCURACY_THRESHOLD: DEFAULT_GPS_ACCURACY_THRESHOLD}, async_start_reauth=Mock(),async_get_active_flows=Mock(return_value=[]))
        self.enterContext(patch('requests.sessions.Session.request', side_effect=AssertionError('network_forbidden')))
        self.enterContext(patch.object(self.hass.config_entries, 'async_get_entry', return_value=self.entry))
        self.enterContext(patch.object(sut, 'emit_proof', new_callable=AsyncMock))
        sut.GATES.clear(); sut.PHASES.clear()
        self.addCleanup(sut.GATES.clear); self.addCleanup(sut.PHASES.clear)
        await Store(self.hass, 1, 'icloud_manual_reauth.synthetic_entry').async_save(
            {'schema_version': 1, 'state': sut.State.USER.value})
        with patch.object(sut.GuardedAccount, '_require_reauth'):
            self.assertTrue(await sut.async_setup_entry(self.hass, self.entry))
        self.flow = ManualIcloudFlow()
        self.flow.hass = self.hass
        self.flow._get_reauth_entry = lambda: self.entry
        self.flow.async_set_unique_id = AsyncMock()
        await self.flow.async_step_reauth(self.entry.data)
        self.api = self.flow.api

    async def asyncTearDown(self):
        await self.sut.async_unload_entry(self.hass, self.entry)
        await self.hass.async_stop()

    async def prepare(self):
        from pyicloud import PyiCloudService
        from unittest.mock import PropertyMock
        with patch.object(PyiCloudService, 'authenticate'), \
             patch.object(PyiCloudService, 'requires_2fa', new_callable=PropertyMock, return_value=True), \
             patch.object(PyiCloudService, '_get_mfa_auth_options', return_value={
                 'mode': 'sms', 'trustedPhoneNumber': {'id': 1, 'pushMode': 'sms'}}):
            result = await self.flow.async_step_manual_reauth({})
            self.assertEqual(result['step_id'], 'verification_code')

    async def test_open_form_and_preparation_never_deliver(self):
        from pyicloud import PyiCloudService
        with patch.object(PyiCloudService, 'request_2fa_code') as send:
            await self.flow.async_step_manual_reauth()
            await self.prepare()
            await self.flow.async_step_verification_code({'verification_code': 'synthetic-invalid'})
            send.assert_not_called()

    async def test_single_delivery_and_invalid_code_preserve_challenge(self):
        from pyicloud import PyiCloudService
        await self.prepare()
        with patch.object(PyiCloudService, 'request_2fa_code', return_value=True) as send, \
             patch.object(PyiCloudService, 'validate_2fa_code', return_value=False) as verify:
            for _ in range(2):
                await self.flow.async_step_verification_code({'request_new_code': True})
            await self.flow.async_step_verification_code({'verification_code': ''})
            verify.assert_not_called()
            await self.flow.async_step_verification_code({'verification_code': 'synthetic-invalid'})
            send.assert_called_once(); verify.assert_called_once()
        self.assertEqual(self.api.auth_gate.state, self.sut.State.CODE)

    async def test_unknown_delivery_prevents_retry(self):
        from pyicloud import PyiCloudService
        from homeassistant.helpers.storage import Store
        await self.prepare()
        with patch.object(PyiCloudService, 'request_2fa_code', side_effect=RuntimeError('synthetic')) as send:
            result = await self.flow.async_step_verification_code({'request_new_code': True})
            self.assertEqual(result['errors']['base'], 'delivery_unknown')
            await self.flow.async_step_verification_code({'request_new_code': True})
            await self.flow.async_step_manual_reauth({})
            send.assert_called_once()
        saved = await Store(self.hass, 1, 'icloud_manual_reauth.synthetic_entry').async_load()
        self.assertEqual(saved['state'], self.sut.State.UNCERTAIN.value)

    async def test_native_registration_and_account_share_guard(self):
        from homeassistant.components.icloud import account
        from homeassistant.config_entries import HANDLERS
        from custom_components.icloud.config_flow import ManualIcloudFlow
        from custom_components.icloud.manual_auth import ManualOtpService
        self.assertIs(account.PyiCloudService, self.sut.GuardedService)
        self.assertIs(ManualOtpService, self.sut.GuardedService)
        self.assertIs(HANDLERS['icloud'], ManualIcloudFlow)
        self.assertIs(self.api.auth_gate, self.sut.GATES[self.entry.entry_id])


if __name__ == '__main__':
    unittest.main()


class RecoveredRepairTest(unittest.TestCase):
    def setUp(self):
        self.env=self.enterContext(loaded_adapter())
        self.hass,self.entry=synthetic_hass_entry()
        gate=self.env.sut.AuthGate(lambda row:None)
        with self.env.bridge.bind_gate(gate):client=self.env.sut.GuardedService()
        gate.record(self.env.sut.State.VALID);client.challenge=False
        account=self.env.sut.GuardedAccount.__new__(self.env.sut.GuardedAccount)
        account.api=client;account._manual_platforms_loaded=True
        self.entry.runtime_data=account
        self.env.sut.GATES[self.entry.entry_id]=gate
        self.env.sut.PHASES[self.entry.entry_id]='entry_ready'
        self.delete=sys.modules['homeassistant.helpers.issue_registry'].async_delete_issue

    def test_full_setup_closes_only_exact_entry_reauth(self):
        self.entry.async_get_active_flows.return_value=[{'handler':'icloud','flow_id':'synthetic_flow',
            'context':{'entry_id':self.entry.entry_id,'source':'reauth'}}]
        self.assertTrue(self.env.sut.finish_recovered_reauth(self.hass,self.entry))
        self.hass.config_entries.flow.async_abort.assert_called_once_with('synthetic_flow')
        self.delete.assert_called_once_with(self.hass,'homeassistant',
            'config_entry_reauth_icloud_'+self.entry.entry_id)

    def test_waiting_entry_never_clears_repair(self):
        self.env.sut.PHASES[self.entry.entry_id]='entry_waiting_user'
        self.assertFalse(self.env.sut.finish_recovered_reauth(self.hass,self.entry))
        self.delete.assert_not_called()

    def test_challenge_and_incomplete_platforms_keep_repair(self):
        self.entry.runtime_data.api.challenge=True
        self.assertFalse(self.env.sut.finish_recovered_reauth(self.hass,self.entry))
        self.entry.runtime_data.api.challenge=False
        self.entry.runtime_data._manual_platforms_loaded=False
        self.assertFalse(self.env.sut.finish_recovered_reauth(self.hass,self.entry))
        self.delete.assert_not_called()

    def test_other_entry_flow_is_never_aborted(self):
        self.entry.async_get_active_flows.return_value=[{'handler':'icloud','flow_id':'other',
            'context':{'entry_id':'other','source':'reauth'}}]
        self.assertFalse(self.env.sut.finish_recovered_reauth(self.hass,self.entry))
        self.hass.config_entries.flow.async_abort.assert_not_called();self.delete.assert_not_called()
