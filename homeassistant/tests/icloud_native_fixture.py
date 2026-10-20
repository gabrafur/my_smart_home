from __future__ import annotations
ATTR_ACCOUNT_FETCH_INTERVAL='ATTR_ACCOUNT_FETCH_INTERVAL'
ATTR_BATTERY='ATTR_BATTERY'
ATTR_BATTERY_STATUS='ATTR_BATTERY_STATUS'
ATTR_DEVICE_NAME='ATTR_DEVICE_NAME'
ATTR_DEVICE_STATUS='ATTR_DEVICE_STATUS'
ATTR_LOW_POWER_MODE='ATTR_LOW_POWER_MODE'
ATTR_OWNER_NAME='ATTR_OWNER_NAME'
DEVICE_BATTERY_LEVEL='DEVICE_BATTERY_LEVEL'
DEVICE_BATTERY_STATUS='DEVICE_BATTERY_STATUS'
DEVICE_CLASS='DEVICE_CLASS'
DEVICE_DISPLAY_NAME='DEVICE_DISPLAY_NAME'
DEVICE_ID='DEVICE_ID'
DEVICE_LOCATION='DEVICE_LOCATION'
DEVICE_LOCATION_LATITUDE='DEVICE_LOCATION_LATITUDE'
DEVICE_LOST_MODE_CAPABLE='DEVICE_LOST_MODE_CAPABLE'
DEVICE_LOW_POWER_MODE='DEVICE_LOW_POWER_MODE'
DEVICE_NAME='DEVICE_NAME'
DEVICE_PERSON_ID='DEVICE_PERSON_ID'
DEVICE_STATUS='DEVICE_STATUS'
DEVICE_STATUS_CODES='DEVICE_STATUS_CODES'
class IcloudDevice:
    """Representation of a iCloud device."""

    _attr_attribution = "Data provided by Apple iCloud"

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
        if self._status[DEVICE_PERSON_ID]:
            self._attrs[ATTR_OWNER_NAME] = account.family_members_fullname[
                self._status[DEVICE_PERSON_ID]
            ]
        elif account.owner_fullname is not None:
            self._attrs[ATTR_OWNER_NAME] = account.owner_fullname

    def update(self, status) -> None:
        """Update the iCloud device."""
        self._status = status

        self._status[ATTR_ACCOUNT_FETCH_INTERVAL] = self._account.fetch_interval

        device_status = DEVICE_STATUS_CODES.get(self._status[DEVICE_STATUS], "error")
        self._attrs[ATTR_DEVICE_STATUS] = device_status

        self._battery_status = self._status[DEVICE_BATTERY_STATUS]
        self._attrs[ATTR_BATTERY_STATUS] = self._battery_status
        device_battery_level = self._status.get(DEVICE_BATTERY_LEVEL, 0)
        if self._battery_status != "Unknown" and device_battery_level is not None:
            self._battery_level = int(device_battery_level * 100)
            self._attrs[ATTR_BATTERY] = self._battery_level
            self._attrs[ATTR_LOW_POWER_MODE] = self._status[DEVICE_LOW_POWER_MODE]

            if (
                self._status[DEVICE_LOCATION]
                and self._status[DEVICE_LOCATION][DEVICE_LOCATION_LATITUDE]
            ):
                location = self._status[DEVICE_LOCATION]
                if self._location is None:
                    dispatcher_send(self._account.hass, self._account.signal_device_new)
                self._location = location

    def play_sound(self) -> None:
        """Play sound on the device."""
        if self._account.api is None:
            return

        self._account.api.authenticate()
        _LOGGER.debug("Playing sound for %s", self.name)
        self.device.play_sound()

    def display_message(self, message: str, sound: bool = False) -> None:
        """Display a message on the device."""
        if self._account.api is None:
            return

        self._account.api.authenticate()
        _LOGGER.debug("Displaying message for %s", self.name)
        self.device.display_message("Subject not working", message, sound)

    def lost_device(self, number: str, message: str) -> None:
        """Make the device in lost state."""
        if self._account.api is None:
            return

        self._account.api.authenticate()
        if self._status[DEVICE_LOST_MODE_CAPABLE]:
            _LOGGER.debug("Make device lost for %s", self.name)
            self.device.lost_device(number, message, None)
        else:
            _LOGGER.error("Cannot make device lost for %s", self.name)

    @property
    def unique_id(self) -> str:
        """Return a unique ID."""
        return self._device_id

    @property
    def name(self) -> str:
        """Return the Apple device name."""
        return self._name

    @property
    def device(self) -> AppleDevice:
        """Return the Apple device."""
        return self._device

    @property
    def device_class(self) -> str:
        """Return the Apple device class."""
        return self._device_class

    @property
    def device_model(self) -> str:
        """Return the Apple device model."""
        return self._device_model

    @property
    def battery_level(self) -> int | None:
        """Return the Apple device battery level."""
        return self._battery_level

    @property
    def battery_status(self) -> str | None:
        """Return the Apple device battery status."""
        return self._battery_status

    @property
    def location(self) -> dict[str, Any] | None:
        """Return the Apple device location."""
        return self._location

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return the attributes."""
        return self._attrs
