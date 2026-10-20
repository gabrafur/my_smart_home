"""Candidate only. Narrow Core 2026.10.1 device-owner adaptation.
Constructor derived from Home Assistant Core; retain LICENSE.upstream on adoption.
No API calls, accounts, credentials or locations are read by this adapter.
"""
from __future__ import annotations
import hashlib
import inspect
import textwrap

EXPECTED_INIT = '69eacf8342e90c7c3f46b775fb60ef324c70835d5a353850be335f2ceed3ed17'

def prepare_device_class(core, version):
    if version != '2026.10.1':
        raise RuntimeError('unsupported_icloud_core_version')
    original_class = core.IcloudDevice
    if getattr(original_class, '_reviewed_owner_adapter', False):
        return original_class
    source = textwrap.dedent(inspect.getsource(original_class.__init__))
    if hashlib.sha256(source.encode()).hexdigest() != EXPECTED_INIT:
        raise RuntimeError('icloud_constructor_changed')
    ATTR_ACCOUNT_FETCH_INTERVAL = getattr(core, 'ATTR_ACCOUNT_FETCH_INTERVAL')
    ATTR_DEVICE_NAME = getattr(core, 'ATTR_DEVICE_NAME')
    ATTR_DEVICE_STATUS = getattr(core, 'ATTR_DEVICE_STATUS')
    ATTR_OWNER_NAME = getattr(core, 'ATTR_OWNER_NAME')
    DEVICE_CLASS = getattr(core, 'DEVICE_CLASS')
    DEVICE_DISPLAY_NAME = getattr(core, 'DEVICE_DISPLAY_NAME')
    DEVICE_ID = getattr(core, 'DEVICE_ID')
    DEVICE_NAME = getattr(core, 'DEVICE_NAME')
    DEVICE_PERSON_ID = getattr(core, 'DEVICE_PERSON_ID')
    DEVICE_STATUS = getattr(core, 'DEVICE_STATUS')
    class ReviewedOwnerDevice(original_class):
        _reviewed_owner_adapter = True
        def __init__(self, account: IcloudAccount, device: AppleDevice, status) -> None:
            """Initialize the iCloud device."""
            self._account = account

            self._device = device
            self._status = status

            self._name = self._status[DEVICE_NAME]
            self._device_id = self._status[DEVICE_ID]
            self._device_class = self._status[DEVICE_CLASS]
            self._device_model = self._status[DEVICE_DISPLAY_NAME]

            self._battery_level: int | None = None
            self._battery_status = None
            self._location = None

            self._attrs = {
                ATTR_ACCOUNT_FETCH_INTERVAL: self._account.fetch_interval,
                ATTR_DEVICE_NAME: self._device_model,
                ATTR_DEVICE_STATUS: None,
            }
            person_id = self._status.get(DEVICE_PERSON_ID)
            if person_id:
                resolved_owner = account.family_members_fullname.get(person_id)
                if resolved_owner is not None:
                    self._attrs[ATTR_OWNER_NAME] = resolved_owner
            elif DEVICE_PERSON_ID in self._status and account.owner_fullname is not None:
                self._attrs[ATTR_OWNER_NAME] = account.owner_fullname

    return ReviewedOwnerDevice
