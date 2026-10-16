# Manual iCloud reauthentication

[Português (primary)](ICLOUD_MANUAL_AUTH.md) · [English](ICLOUD_MANUAL_AUTH.en.md)

`homeassistant/custom_components/icloud/` is a small adapter around the native
integration. It preserves the domain, config entry, services, platforms and
`/config/.storage/icloud` session storage. It does not create another account
or replace user data. Platforms and the original flow come from installed Core.

Transport failures during startup (including DNS, connection and timeout errors
wrapped by pyicloud) become `ConfigEntryNotReady`, allowing Home Assistant to
retry setup with its native backoff. Authentication failures without a transport
cause and programming errors keep their original behavior; retries never request OTPs.

Startup, session renewal and background authentication use `pause_2fa=True`.
Because pyicloud 2.7.0 may still request an OTP when paused-token login fails,
`ManualOtpService.request_2fa_code()` also suppresses automatic delivery. This
does not validate codes, bypass authentication or mark an unverified session trusted.

When Apple requires reauthentication, the repair remains pending. Opening it or
entering an invalid code never sends another code. When ready:

1. Open **Settings → Devices & services → Apple iCloud → Reauthenticate**, or
   the corresponding repair.
2. Select **Request a new verification code** and submit the form.
3. Enter the code from Apple with the request-new-code option unchecked.

Only that explicit submission calls `request_manual_2fa_code()`. Legacy 2SA
retains its explicit device selection. The library continues to persist trusted
sessions and tokens; Apple can invalidate them later.

## Compatibility and maintenance

Verified with Home Assistant Core 2026.10.1 and pyicloud 2.7.0. The adapter
replaces the native `account` and `config_flow` client factories, registers
a flow subclass and wraps native setup to classify transient transport failures. It does not modify container files or
patch other pyicloud consumers. After Core or pyicloud updates, run the native
compatibility tests inside the container before declaring runtime validation
complete. The manifest pins the pyicloud dependency.

UI resources were extracted from the official image recorded in `upstream.json`.
Hashes identify their original bytes. Verification-step instructions were
changed in English and Portuguese, and service account examples use the reserved
`example.invalid` domain. `LICENSE.upstream` preserves Core's Apache-2.0 license.

```sh
scripts/run-resource-safe.sh python3 -m unittest homeassistant.tests.test_icloud_manual_auth
scripts/run-resource-safe.sh docker exec -w /config homeassistant python tests/test_icloud_manual_auth.py
```

Tests simulate failures, retries, manual requests and invalid codes without
contacting Apple or generating OTPs. For initial deployment, validate configuration
and restart only Home Assistant. Verify entities, Recorder preservation and
unexpected repairs afterwards. Roll back by removing only this local adapter and
restarting Home Assistant, preserving `.storage` and entity registries.

## Safe restarts and manual buttons

All five Node-RED `input_button` triggers use `ignorePrevStateNull: true` and
`outputInitially: false`. Restoring an entity at Home Assistant startup emits
`old_state: null`; that is not a press. `ignorePrevStateUnknown: false` preserves
the first real press because an unused button already exists with state
`unknown`. Restoration must never initiate lock/unlock, vehicle refresh,
storage maintenance or documentation review.

Generators preserve this contract. To reapply it without reorganizing canvases,
run `node nodered/tools/install-input-button-restoration-guards.mjs`, followed
by the normal observability and layout gates. Run
`node nodered/tools/test-input-button-restoration.mjs` to replay three restores,
a first press, a duplicate, an unrelated entity and disconnection against the
installed native controller, without calling services or devices. Existing tab
dry-run tests cover downstream decisions and the effects boundary.
