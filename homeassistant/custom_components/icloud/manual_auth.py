"""Keep background iCloud authentication separate from OTP delivery."""

from typing import Any

from pyicloud import PyiCloudService


class ManualOtpService(PyiCloudService):
    """Preserve native sessions while suppressing automatic OTP challenges."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # Also sends Apple's pause2FA flag during initial SRP authentication.
        kwargs["pause_2fa"] = True
        super().__init__(*args, **kwargs)

    def authenticate(
        self,
        force_refresh: bool = False,
        service: str | None = None,
        pause_2fa: bool | None = None,
    ) -> None:
        """Background retries must preserve the paused challenge policy."""
        super().authenticate(
            force_refresh=force_refresh, service=service, pause_2fa=True
        )

    def request_2fa_code(self) -> bool:
        """Do not let the library's automatic fallback send a code.

        pyicloud 2.7.0 can call this even with pause_2fa=True when its
        paused-token login fails. Returning False keeps authentication pending.
        Never mark a challenge as sent, validate a code or trust this session.
        """
        return False

    def request_manual_2fa_code(self) -> bool:
        """Deliver a code only at the explicitly submitted config-flow step."""
        return super().request_2fa_code()
