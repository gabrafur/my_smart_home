"""Reuse native forms, with explicit authorization for OTP delivery."""

import logging
from typing import Any

from pyicloud.exceptions import PyiCloudException

from homeassistant.components.icloud.config_flow import IcloudFlowHandler

_LOGGER = logging.getLogger(__name__)


class ManualOtpFlowHandler(IcloudFlowHandler, domain="icloud"):
    """Opening a repair or submitting an invalid code never sends an OTP."""

    async def _request_2fa_code(self, errors: dict[str, str]) -> dict[str, str]:
        try:
            result = await self.hass.async_add_executor_job(
                self.api.request_manual_2fa_code
            )
        except (PyiCloudException, AttributeError):
            _LOGGER.warning("Manual iCloud verification code request failed")
            errors["base"] = "send_verification_code"
            return errors
        except Exception:
            # Avoid logging provider responses, account identifiers or tokens.
            _LOGGER.warning("Unexpected failure requesting an iCloud verification code")
            errors["base"] = "send_verification_code"
            return errors
        if result is False:
            errors["base"] = "send_verification_code"
        return errors

    async def async_step_verification_code(
        self,
        user_input: dict[str, Any] | None = None,
        errors: dict[str, str] | None = None,
    ):
        # Native optional fields may be absent when requesting a code without
        # entering one, or when submitting an empty form.
        if user_input is not None:
            user_input = {
                "request_new_code": False,
                "verification_code": "",
                **user_input,
            }
        return await super().async_step_verification_code(user_input, errors)
