"""Exercise the vendored Amazon Kids lifecycle without Home Assistant or network."""
import ast
import asyncio
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, call

ALEXA_MEDIA_ROOT = Path(__file__).resolve().parents[2] / 'homeassistant/custom_components/alexa_media'


def load_class(file, name, namespace):
    tree = ast.parse((ALEXA_MEDIA_ROOT / file).read_text())
    definition = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name)
    exec(compile(ast.Module(body=[definition], type_ignores=[]), file, 'exec'), namespace)
    return namespace[name]


class AlexaMediaAmazonKidsRegressionTest(unittest.IsolatedAsyncioTestCase):
    def test_coordinator_filters_by_capability_and_enabled_state(self):
        tree = ast.parse((ALEXA_MEDIA_ROOT / '__init__.py').read_text())
        loop = next(n for n in ast.walk(tree) if isinstance(n, ast.For)
                    and isinstance(n.target, ast.Name) and n.target.id == 'binary_sensor')
        body = compile(ast.Module(body=loop.body, type_ignores=[]), '__init__.py', 'exec')
        selected = set()
        for sensor in [SimpleNamespace(), SimpleNamespace(alexa_entity_id=None, enabled=True),
                       SimpleNamespace(alexa_entity_id='disabled', enabled=False),
                       SimpleNamespace(alexa_entity_id='contact', enabled=True)]:
            exec(body, {'binary_sensor':sensor, 'entities_to_monitor':selected})
        self.assertEqual(selected, {'contact'})

    async def test_sensor_reads_shared_state_and_unsubscribes(self):
        class Entity:
            def async_on_remove(self, callback):
                self.remove = callback
            def async_write_ha_state(self):
                pass
        Sensor = load_class('binary_sensor.py', 'AmazonKidsSensor', {'BinarySensorEntity':Entity, 'DATA_ALEXAMEDIA':'alexa_media'})
        unsubscribe = Mock()
        kids = SimpleNamespace(state=Mock(return_value={'kids':True}), async_add_listener=Mock(return_value=unsubscribe))
        sensor = Sensor(kids, SimpleNamespace(device_serial_number='synthetic', unique_id='synthetic_id'))
        self.assertFalse(sensor._attr_should_poll)
        self.assertFalse(hasattr(sensor, 'alexa_entity_id'))
        self.assertTrue(sensor.is_on)
        self.assertTrue(sensor.available)
        kids.state.return_value = {'kids':None}
        self.assertIsNone(sensor.is_on)
        self.assertFalse(sensor.available)
        await sensor.async_added_to_hass()
        kids.async_add_listener.assert_called_once_with(sensor.async_write_ha_state)
        sensor.remove()
        unsubscribe.assert_called_once()

    def shared_state_fixture(self):
        unsubscribe = Mock()
        schedule = Mock(return_value=unsubscribe)
        api = SimpleNamespace(get_child_profiles=AsyncMock(return_value=[]),
                              get_child_mode=AsyncMock(return_value=False))
        State = load_class('amazon_kids.py', 'AmazonKidsState', {
            'asyncio':asyncio, 'callback':lambda f:f, 'async_track_time_interval':schedule,
            'KIDS_SCAN_INTERVAL':timedelta(minutes=5), 'OPTION_NONE':'None',
            'AlexaAPI':api, '_LOGGER':Mock(), 'hide_email':lambda _: 'account',
        })
        state = State(object(), SimpleNamespace(email='synthetic'))
        return state, api, schedule, unsubscribe

    async def test_shared_poll_starts_once_refreshes_and_stops(self):
        state, api, schedule, unsubscribe = self.shared_state_fixture()
        state.track('synthetic', 'test_type')
        await state.async_start()
        await state.async_start()
        schedule.assert_called_once_with(state.hass, state._async_interval, timedelta(minutes=5))
        # A second platform start may enter the real only_unknown wrapper, but
        # must never re-poll a device whose state is already known.
        api.get_child_profiles.assert_awaited_once_with(state.login)
        api.get_child_mode.assert_awaited_once_with(state.login, 'synthetic', 'test_type')
        self.assertFalse(state.state('synthetic')['kids'])
        await state._async_interval(None)
        self.assertEqual(api.get_child_profiles.await_count, 2)
        self.assertEqual(api.get_child_mode.await_args_list, [
            call(state.login, 'synthetic', 'test_type'),
            call(state.login, 'synthetic', 'test_type'),
        ])
        state.async_stop()
        state.async_stop()
        unsubscribe.assert_called_once()
        self.assertIsNone(state._unsub)

    async def test_later_platform_start_initializes_only_new_devices(self):
        state, api, schedule, _ = self.shared_state_fixture()
        state.track('known', 'test_type')
        await state.async_start()
        state.track('new', 'test_type')
        await state.async_start()
        await state.async_start()
        schedule.assert_called_once()
        self.assertEqual(api.get_child_profiles.await_count, 2)
        self.assertEqual(api.get_child_mode.await_args_list, [
            call(state.login, 'known', 'test_type'),
            call(state.login, 'new', 'test_type'),
        ])
        self.assertFalse(state.state('known')['kids'])
        self.assertFalse(state.state('new')['kids'])
        state.async_stop()

    async def test_later_start_retries_unknown_reads_without_repolling_known_state(self):
        state, api, schedule, _ = self.shared_state_fixture()
        api.get_child_mode.side_effect = [False, None, False]
        state.track('known', 'test_type')
        await state.async_start()
        state.track('new', 'test_type')
        await state.async_start()
        self.assertIsNone(state.state('new')['kids'])
        await state.async_start()
        await state.async_start()
        schedule.assert_called_once()
        self.assertEqual(api.get_child_profiles.await_count, 3)
        self.assertEqual(api.get_child_mode.await_args_list, [
            call(state.login, 'known', 'test_type'),
            call(state.login, 'new', 'test_type'),
            call(state.login, 'new', 'test_type'),
        ])
        self.assertFalse(state.state('known')['kids'])
        self.assertFalse(state.state('new')['kids'])
        state.async_stop()

    async def test_concurrent_platform_starts_recheck_unknown_after_refresh_lock(self):
        state, api, schedule, _ = self.shared_state_fixture()
        state.track('known', 'test_type')
        await state.async_start()
        state.track('new', 'test_type')
        entered, release = asyncio.Event(), asyncio.Event()
        async def read_new(login, serial, device_type):
            self.assertEqual((login, serial, device_type), (state.login, 'new', 'test_type'))
            entered.set()
            await release.wait()
            return False
        api.get_child_mode.side_effect = read_new
        first = asyncio.create_task(state.async_start())
        second = asyncio.create_task(state.async_start())
        try:
            await asyncio.wait_for(entered.wait(), 1)
            await asyncio.sleep(0)
            self.assertEqual(api.get_child_mode.await_count, 2)
            release.set()
            await asyncio.wait_for(asyncio.gather(first, second), 1)
        finally:
            release.set()
            for task in (first, second):
                if not task.done():
                    task.cancel()
            await asyncio.gather(first, second, return_exceptions=True)
            state.async_stop()
        schedule.assert_called_once()
        self.assertEqual(api.get_child_profiles.await_count, 2)
        self.assertEqual(api.get_child_mode.await_args_list, [
            call(state.login, 'known', 'test_type'),
            call(state.login, 'new', 'test_type'),
        ])
        self.assertFalse(state.state('new')['kids'])


    async def test_shared_refresh_notifies_consumers_and_preserves_failed_reads(self):
        api = SimpleNamespace(get_child_profiles=AsyncMock(return_value=[]),
                              get_child_mode=AsyncMock(return_value=False))
        State = load_class('amazon_kids.py', 'AmazonKidsState', {
            'asyncio':asyncio, 'callback':lambda f:f, 'OPTION_NONE':'None',
            'AlexaAPI':api, '_LOGGER':Mock(), 'hide_email':lambda _: 'account',
        })
        state = State(object(), SimpleNamespace(email='synthetic'))
        state.track('synthetic', 'test_type')
        consumers = [Mock(), Mock(), Mock()]
        for listener in consumers:
            state.async_add_listener(listener)
        await state.async_refresh()
        api.get_child_mode.assert_awaited_once_with(state.login, 'synthetic', 'test_type')
        self.assertFalse(state.state('synthetic')['kids'])
        for listener in consumers:
            listener.assert_called_once_with()
        api.get_child_profiles.side_effect = RuntimeError('synthetic failure')
        api.get_child_mode.return_value = None
        await state.async_refresh()
        self.assertFalse(state.state('synthetic')['kids'], 'failed poll must preserve known state')


if __name__ == '__main__':
    unittest.main()
