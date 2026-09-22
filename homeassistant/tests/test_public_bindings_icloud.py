"""The lazy iCloud manager must not perform I/O on the HA event loop."""

import ast
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest

COMPONENT = Path(__file__).resolve().parents[1] / "custom_components/public_bindings"
SPEC = importlib.util.spec_from_file_location("bindings_icloud", COMPONENT / "icloud.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ICloudRefreshTest(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, api):
        # Execute the actual integration adapter without importing a full HA runtime.
        tree = ast.parse((COMPONENT / "__init__.py").read_text())
        adapter = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)
                       and n.name == "force_icloud_location_refresh")
        account = SimpleNamespace(username="test-account", api=api)
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(async_loaded_entries=lambda domain: [
                SimpleNamespace(runtime_data=account)]),
            async_add_executor_job=asyncio.to_thread,
        )
        namespace = {"Any": Any, "hass": hass, "HomeAssistantError": RuntimeError,
                     "refresh_devices": MODULE.refresh_devices}
        exec(compile(ast.Module(body=[adapter], type_ignores=[]), "adapter", "exec"), namespace)
        await namespace[adapter.name]("test-account")

    async def test_lazy_manager_and_refresh_both_run_off_event_loop(self):
        calls = []

        def assert_worker(label):
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                calls.append(label)
            else:
                raise AssertionError("network access on the event loop")

        class Api:
            @property
            def devices(self):
                assert_worker("manager")
                return self

            def refresh(self, force):
                assert_worker("refresh")
                calls.append(force)

        await self.invoke(Api())
        self.assertEqual(calls, ["manager", "refresh", True])

    async def test_missing_provider_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "provider is unavailable"):
            await self.invoke(None)

    async def test_provider_failure_is_not_reported_as_success(self):
        class Api:
            @property
            def devices(self):
                raise ConnectionError("synthetic provider failure")

        with self.assertRaisesRegex(ConnectionError, "synthetic provider failure"):
            await self.invoke(Api())


if __name__ == "__main__":
    unittest.main()
