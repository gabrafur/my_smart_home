# Manual iCloud reauthentication

[Português (primary)](ICLOUD_MANUAL_AUTH.md) · [English](ICLOUD_MANUAL_AUTH.en.md)

`homeassistant/custom_components/icloud/` adapts the native integration while
preserving its domain, config entry, services, platforms and session storage in
`/config/.storage/icloud`. It does not create another account or replace user data.

Startup and polling can only reuse the saved session. Credential login, renewal
requiring authentication and code delivery require an explicit submission. The
client uses `pause_2fa=True` and blocks automatic `request_2fa_code()`, including
the library's fallback. Opening a form, restoring an entry or entering an invalid
code never requests another OTP.

Typed transport failures reaching setup, including wrapped DNS, connection and
timeout errors, become `ConfigEntryNotReady` for Home Assistant's backoff. Errors
without a transport cause are not classified by message text. Retry does not
authorize login or delivery. Failure to load the persisted guard stops setup
before creating a client.

When reauthentication is needed:

1. Open **Settings → Devices & services → Apple iCloud → Reauthenticate**.
   Opening the repair only displays its form.
2. Submit the reauthentication form to prepare the session. This loads challenge
   context without automatically sending a code.
3. When a challenge is available, select **Request a new verification code** and
   submit once. For legacy 2SA, explicitly select the trusted device shown by
   the flow.
4. Only after confirmed delivery, enter the code in the corresponding form.
   That form no longer offers another request during this challenge.

An empty or invalid code does not trigger another delivery. After a timeout or
unknown delivery result, persisted state prevents repetition, including after
restart: reconcile the outcome before another attempt. Stale forms cannot act
on an entry that has been reloaded. A security-key requirement or unsupported
provider route does not guarantee an OTP option.

Reauthentication finishes only after reload reaches `entry_ready`. This proves
local readiness, not recent synchronization with Apple. Sessions and tokens
remain managed by the library's storage.

## Compatibility and maintenance

Compatibility is reviewed for Home Assistant Core 2026.10.1 and 2026.10.4, with pyicloud 2.7.0.
`manual_auth.ManualOtpService` is a compatibility name for `GuardedService`;
`config_flow.py` registers `ManualIcloudFlow`, implemented in `manual_flow.py`.
The adapter replaces the client factory in `account` and uses a guarded local
flow. It does not replace the native flow's global client factory. `auth_gate.py`
maintains persisted policy and `native_bridge.py` adapts native interfaces.

Platforms load only when the session is ready. An entry awaiting manual action
can unload without trying to unload platforms that were never loaded. Local
guards do not modify image files or other pyicloud consumers.

```sh
scripts/run-resource-safe.sh python3 -m unittest discover -s homeassistant/tests -p 'test_icloud*.py'
```

Tests load the real local package with simulated HA/pyicloud boundaries and
block external sockets. They cover persisted state, display-only forms,
preparation without delivery, single delivery, invalid codes, uncertain outcomes,
wiring and transport retry. They run on the host without installing Home Assistant
or pyicloud and do not replace native compatibility checks: after version updates,
also validate in the pinned image, isolated, without network or private mounts.
`NativeRuntimeContractTest` retains real compatibility cases; it is skipped only
when the native runtime is unavailable and must run in the isolated image in
addition to the simulated host cases.

UI resources and licensing retain provenance in `upstream.json` and
`LICENSE.upstream`. Deployment requires hash checks and recoverable copies;
restart only Home Assistant when needed to load approved code. Rollback must use
the operation's verified package and preserve `.storage`; do not remove the
integration as an authentication repair attempt.

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

## Check before updating the image

The updater runs `scripts/icloud-image-preflight.py` in the digest-pinned
candidate before writing Compose or recreating Home Assistant. This disposable
container has no network, privileges or home configuration. Only the checker
and `device_owner.py` are mounted read-only. The process sets its own virtual
memory, CPU, file and time limits because this host has no cgroup memory control.

An unreviewed version, changed constructor hash, different pyicloud version or
collection failure blocks promotion. Do not remove the allowlist to accept new
versions automatically. Dry-run returns `not_checked`, creates no container and
does not establish compatibility. Other services do not need this iCloud check.

The 2026.10.4 review matched all 15 files of the image's iCloud directory against
the official commit's Git blobs. That directory has no changes from the reviewed
baseline. The constructor hash remains mandatory. Original 2026.10.1 provenance
and the license remain preserved; `validated_compatibility` adds the new review.

After loading the code, require a fresh HA-process proof with matching nonce and
revision, `ha_running` and `manual_auth_guard_loaded`. A proof predating startup
is insufficient. `entry_waiting_user` proves guarded waiting, not a ready Apple
session: the owner must still complete manual authentication in Home Assistant.
Never send OTP automatically or delete `.storage`. HTTP 200, a loaded guard and
remote synchronization are separate evidence.
