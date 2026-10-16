"""Exercise automatic fallback and explicit OTP delivery without Apple access."""

import asyncio
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1] / "custom_components" / "icloud"


class FakeService:
    """Emulate the upstream fallback that can bypass pause_2fa on failure."""

    def __init__(self, *args, **kwargs):
        self.options = kwargs
        self.deliveries = 0
        self.requires_2fa = True
        self.authenticate()

    def authenticate(self, **kwargs):
        self.authentication_options = kwargs
        # This fallback is present in pyicloud 2.7.0 even with pause_2fa.
        self.request_2fa_code()

    def request_2fa_code(self):
        self.deliveries += 1
        return True


class ManualOtpServiceTest(unittest.TestCase):
    def setUp(self):
        module = ModuleType("pyicloud")
        module.PyiCloudService = FakeService
        spec = importlib.util.spec_from_file_location("manual_auth_under_test", ROOT / "manual_auth.py")
        adapter = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"pyicloud": module}):
            spec.loader.exec_module(adapter)
        self.client = adapter.ManualOtpService("test@example.invalid", "test-password")

    def test_initial_login_and_repeated_background_failures_never_deliver(self):
        self.assertTrue(self.client.options["pause_2fa"])
        for _ in range(3):
            self.client.authenticate(force_refresh=True, pause_2fa=False)
        self.assertEqual(self.client.deliveries, 0)
        self.assertTrue(self.client.authentication_options["pause_2fa"])
        self.assertTrue(self.client.requires_2fa)

    def test_manual_delivery_does_not_unlock_background_delivery(self):
        self.assertTrue(self.client.request_manual_2fa_code())
        self.assertEqual(self.client.deliveries, 1)
        self.client.authenticate()
        self.assertFalse(self.client.request_2fa_code())
        self.assertEqual(self.client.deliveries, 1)
        self.assertTrue(self.client.requires_2fa)

    def test_manual_provider_failure_does_not_trigger_automatic_retry(self):
        with patch.object(FakeService, "request_2fa_code", side_effect=RuntimeError("provider unavailable")):
            with self.assertRaisesRegex(RuntimeError, "provider unavailable"):
                self.client.request_manual_2fa_code()
            self.assertFalse(self.client.request_2fa_code())


def has_native_runtime():
    try:
        return importlib.util.find_spec("homeassistant.core") is not None
    except (ImportError, ValueError):
        return False


@unittest.skipUnless(has_native_runtime(), "Run these compatibility cases inside the Home Assistant container")
class NativeFlowTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        sys.path.insert(0, str(ROOT.parents[1]))
        from custom_components.icloud.config_flow import ManualOtpFlowHandler

        self.flow = ManualOtpFlowHandler()

        async def executor(fn, *args):
            return fn(*args)

        self.flow.hass = SimpleNamespace(async_add_executor_job=executor)
        self.flow.api = SimpleNamespace(
            requires_2fa=True,
            request_manual_2fa_code=Mock(return_value=True),
            request_2fa_code=Mock(side_effect=AssertionError("automatic delivery")),
            validate_2fa_code=Mock(return_value=False),
        )
        self.flow.async_show_form = lambda **kwargs: {"type": "form", **kwargs}

    async def test_opening_repair_empty_submit_and_invalid_code_do_not_deliver(self):
        for user_input in (None, {}, {"verification_code": "000000"}):
            result = await self.flow.async_step_verification_code(user_input)
            self.assertEqual(result["type"], "form")
        self.flow.api.request_manual_2fa_code.assert_not_called()
        self.flow.api.request_2fa_code.assert_not_called()

    async def test_explicit_request_delivers_once_without_validating_empty_code(self):
        result = await self.flow.async_step_verification_code({"request_new_code": True})
        self.assertEqual(result["errors"], {})
        self.flow.api.request_manual_2fa_code.assert_called_once_with()
        self.flow.api.validate_2fa_code.assert_not_called()

    async def test_failed_manual_request_stays_pending_without_retry(self):
        self.flow.api.request_manual_2fa_code.side_effect = RuntimeError("provider unavailable")
        result = await self.flow.async_step_verification_code({"request_new_code": True})
        self.assertEqual(result["errors"], {"base": "send_verification_code"})
        self.flow.api.request_manual_2fa_code.assert_called_once_with()

    async def test_existing_accounts_and_config_flows_use_the_same_guard(self):
        from homeassistant.components.icloud import account, config_flow
        from homeassistant.config_entries import HANDLERS
        from custom_components.icloud.manual_auth import ManualOtpService
        from custom_components.icloud.config_flow import ManualOtpFlowHandler

        self.assertIs(account.PyiCloudService, ManualOtpService)
        self.assertIs(config_flow.PyiCloudService, ManualOtpService)
        self.assertIs(HANDLERS["icloud"], ManualOtpFlowHandler)


class SetupRetryTest(unittest.IsolatedAsyncioTestCase):
    async def test_wrapped_dns_failure_retries_then_native_setup_recovers(self):
        import ast
        from socket import gaierror
        spec = importlib.util.spec_from_file_location("icloud_setup_retry", ROOT / "setup_retry.py")
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        tree = ast.parse((ROOT / "__init__.py").read_text())
        adapter = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
                       and n.name == "async_setup_entry")

        class NotReady(Exception):
            pass

        dns = gaierror(-3, "synthetic DNS unavailable")
        wrapped = RuntimeError("Request failed to iCloud")
        wrapped.__cause__ = dns
        native = AsyncMock(side_effect=[wrapped, True])
        namespace = {"core_async_setup_entry": native, "ConfigEntryNotReady": NotReady,
                     "is_transport_failure": helper.is_transport_failure}
        exec(compile(ast.Module(body=[adapter], type_ignores=[]), "setup", "exec"), namespace)
        hass, entry = object(), object()
        with self.assertRaises(NotReady):
            await namespace[adapter.name](hass, entry)
        self.assertTrue(await namespace[adapter.name](hass, entry))
        self.assertEqual(native.await_args.args, (hass, entry))

        for error in (ValueError("bad config"), RuntimeError("401 authentication required")):
            native.side_effect = error
            with self.assertRaises(type(error)) as caught:
                await namespace[adapter.name](hass, entry)
            self.assertIs(caught.exception, error)
        cycle = RuntimeError("cycle")
        cycle.__context__ = cycle
        self.assertFalse(helper.is_transport_failure(cycle))


if __name__ == "__main__":
    unittest.main()
