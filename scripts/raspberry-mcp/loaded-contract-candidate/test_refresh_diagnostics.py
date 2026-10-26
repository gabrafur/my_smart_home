"""Isolated AST extraction: no HA imports, provider, network or configuration."""
import ast
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest

SECRET = 'PRIVATE_SENTINEL_ACCOUNT_LOCATION_ERROR'
SOURCE = Path(__file__).resolve().parents[3] / 'homeassistant/custom_components/public_bindings/__init__.py'


def extract():
    module = ast.parse(SOURCE.read_text())
    setup = next(n for n in module.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'async_setup')
    nodes = [n for n in setup.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in ('record_icloud_refresh', 'call_binding')]
    assert len(nodes) == 2
    return compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(SOURCE), 'exec')


class HomeAssistantError(Exception): pass
class ServiceNotFound(Exception): pass
class PrivateFailure(Exception): pass


class DiagnosticsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []; self.rows = {}; self.provider_error = None; self.downstream_error = None
        self.binding = {'target_service': 'icloud.update', 'location_refresh_provider': 'icloud', 'location_refresh_public_entity_id': 'fixture', 'data': {'account': SECRET}}
        self.bindings = {(r, a): self.binding for r in ('resident_primary', 'resident_secondary', 'other') for a in ('refresh_location', 'other')}
        async def wait(): self.events.append('wait')
        async def provider(account):
            self.assertEqual(account, SECRET); self.events.append('provider')
            if self.provider_error: raise self.provider_error
        async def downstream(domain, service, data, *, blocking):
            self.assertEqual((domain, service, data, blocking), ('icloud', 'update', {'account': SECRET}, True))
            self.events.append('downstream')
            if self.downstream_error: raise self.downstream_error
        env = {'Any': object, 'ServiceCall': object, 'datetime': datetime, 'timezone': timezone,
               'HomeAssistantError': HomeAssistantError, 'services': self.bindings,
               'wait_until_started': wait, 'force_icloud_location_refresh': provider,
               'entities': {'fixture': ('resident_primary', {'target_entity_id': 'fixture_target'})},
               '_binding_targets': lambda b: (b['target_entity_id'],),
               'location_target_ids': {'fixture_target'}, 'LOCATION_REFRESH_PROVIDERS': {'icloud'},
               'is_best_effort_notification': lambda *a: False,
               'hass': SimpleNamespace(services=SimpleNamespace(async_call=downstream)),
               'refresh_diagnostics': self.rows}
        exec(extract(), env)
        self.call = env['call_binding']; self.record = env['record_icloud_refresh']; self.env = env

    async def invoke(self, role='resident_primary', action='refresh_location'):
        self.env['entities']['fixture'] = (role, {'target_entity_id': 'fixture_target'})
        return await self.call(SimpleNamespace(data={'role': role, 'action': action}))

    def assert_row(self, stage, outcome, category):
        row = self.rows['resident_primary']
        self.assertEqual(set(row), {'stage', 'outcome', 'observed_at', 'exception_class'})
        self.assertEqual((row['stage'], row['outcome'], row['exception_class']), (stage, outcome, category))
        self.assertIsNotNone(datetime.fromisoformat(row['observed_at']).tzinfo)
        self.assertNotIn(SECRET, str(self.rows))

    async def test_provider_error_preserved_without_downstream(self):
        self.provider_error = HomeAssistantError(SECRET)
        with self.assertRaises(HomeAssistantError) as raised: await self.invoke()
        self.assertIs(raised.exception, self.provider_error)
        self.assertEqual(self.events, ['wait', 'provider'])
        self.assert_row('provider_refresh', 'error', 'HomeAssistantError')

    async def test_downstream_error_preserved_without_extra_calls(self):
        self.downstream_error = ServiceNotFound(SECRET)
        with self.assertRaises(ServiceNotFound) as raised: await self.invoke()
        self.assertIs(raised.exception, self.downstream_error)
        self.assertEqual(self.events, ['wait', 'provider', 'downstream'])
        self.assert_row('downstream_call', 'error', 'ServiceNotFound')

    async def test_success_preserves_order_and_signature(self):
        await self.invoke()
        self.assertEqual(self.events, ['wait', 'provider', 'downstream'])
        self.assert_row('downstream_call', 'completed', None)

    async def test_private_exception_class_and_text_hidden(self):
        self.provider_error = PrivateFailure(SECRET)
        with self.assertRaises(PrivateFailure): await self.invoke()
        self.assert_row('provider_refresh', 'error', 'other')
        self.assertNotIn('PrivateFailure', str(self.rows))

    async def test_other_role_or_action_no_record(self):
        await self.invoke(role='other'); await self.invoke(action='other')
        self.assertEqual(self.rows, {})
        self.assertEqual(self.events, ['wait', 'provider', 'downstream'] * 2)

    async def test_two_rows_only_and_no_history(self):
        await self.invoke(); await self.invoke(role='resident_secondary'); await self.invoke()
        self.assertEqual(set(self.rows), {'resident_primary', 'resident_secondary'})
        self.assertEqual(len(self.rows), 2)
        self.assertEqual(self.events, ['wait', 'provider', 'downstream'] * 3)

    def test_recorder_started_completed_and_allowlist(self):
        names = ('HomeAssistantError', 'ServiceNotFound', 'PyiCloudServiceUnavailable', 'PyiCloudServiceNotActivatedException', 'TimeoutError', 'ConnectionError')
        for name in names:
            self.record('resident_primary', 'provider_refresh', 'error', type(name, (Exception,), {})(SECRET))
            self.assert_row('provider_refresh', 'error', name)
        for outcome in ('started', 'completed'):
            self.record('resident_primary', 'provider_refresh', outcome)
            self.assert_row('provider_refresh', outcome, None)
        before = self.rows.copy()
        self.record('other', 'provider_refresh', 'error', PrivateFailure(SECRET))
        self.record('resident_primary', 'private_stage', 'error', PrivateFailure(SECRET))
        self.assertEqual(self.rows, before)

    async def test_diagnostic_failure_does_not_change_success_or_original_error(self):
        class BrokenClock:
            @staticmethod
            def now(*args): raise RuntimeError(SECRET)
        self.env['datetime'] = BrokenClock
        await self.invoke(); self.assertEqual(self.rows, {})
        self.provider_error = HomeAssistantError(SECRET)
        with self.assertRaises(HomeAssistantError) as raised: await self.invoke()
        self.assertIs(raised.exception, self.provider_error)
        self.assertEqual(self.rows, {})


if __name__ == '__main__': unittest.main()
