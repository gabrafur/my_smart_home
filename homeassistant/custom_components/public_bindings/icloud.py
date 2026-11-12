"""Synchronous iCloud protocol operations, called only in an executor."""

from http.client import RemoteDisconnected
from typing import Any


def is_interrupted_transport(error: BaseException) -> bool:
    """Recognize a closed HTTP connection, never infer it from provider text."""
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if isinstance(error, RemoteDisconnected):
            return True
        error = error.__cause__ or error.__context__
    return False


def refresh_devices(api: Any) -> bool:
    """Resolve the lazy Find My manager and refresh it off the event loop."""
    # api.devices is a property that can itself perform an HTTP request.
    manager = getattr(api, "devices", None)
    refresh = getattr(manager, "refresh", None)
    if not callable(refresh):
        return False
    refresh(True)
    return True


class OTPRequired(RuntimeError):
    """Stop automatic recovery; never send a code here."""


class RecoveryUnavailable(RuntimeError):
    """A bounded recovery was inconclusive or refused."""


async def refresh_account_with_recovery(hass, entry, lock):
    """One authorized recovery and reload; concurrent callers share its result."""
    account = entry.runtime_data
    requires_otp = getattr(account, 'location_session_requires_otp', None)
    if callable(requires_otp) and requires_otp():
        raise OTPRequired('ICLOUD_OTP_REQUIRED')
    api = getattr(account, 'api', None)
    rejected = False
    try:
        if await hass.async_add_executor_job(refresh_devices, api):
            return True
    except Exception as error:
        if callable(requires_otp) and requires_otp():
            raise OTPRequired('ICLOUD_OTP_REQUIRED') from None
        classifier = getattr(account, 'location_session_failure', None)
        if not callable(classifier) or not classifier(error):
            raise
        rejected = True
    if not rejected and api is not None:
        return False
    async with lock:
        current = entry.runtime_data
        if current is account:
            recover = getattr(account, 'recover_location_session', None)
            if not callable(recover):
                return False
            result = await hass.async_add_executor_job(recover)
            if result == 'otp_required':
                raise OTPRequired('ICLOUD_OTP_REQUIRED')
            if result != 'session_ready':
                raise RecoveryUnavailable('ICLOUD_SESSION_RECOVERY_UNAVAILABLE')
            if not await hass.config_entries.async_reload(entry.entry_id):
                raise RecoveryUnavailable('ICLOUD_SESSION_RECOVERY_UNAVAILABLE')
            current = entry.runtime_data
        # Prove service access after renewal, not merely token acceptance.
        api = getattr(current, 'api', None)
        requires_otp = getattr(current, 'location_session_requires_otp', None)
        if callable(requires_otp) and requires_otp():
            raise OTPRequired('ICLOUD_OTP_REQUIRED')
        if api is not None and (getattr(api, 'native_requires_2fa', False)
                                or getattr(api, 'native_requires_2sa', False)):
            raise OTPRequired('ICLOUD_OTP_REQUIRED')
        if not getattr(current, '_manual_platforms_loaded', False):
            raise RecoveryUnavailable('ICLOUD_SESSION_RECOVERY_UNAVAILABLE')
        if not await hass.async_add_executor_job(refresh_devices, api):
            raise RecoveryUnavailable('ICLOUD_SESSION_RECOVERY_UNAVAILABLE')
        return True
