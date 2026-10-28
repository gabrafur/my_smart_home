# Manual iCloud reauthentication

[Português (primary)](ICLOUD_MANUAL_AUTH.md) · [English](ICLOUD_MANUAL_AUTH.en.md)

`homeassistant/custom_components/icloud/` adapts the native integration while
preserving its domain, config entry, services, platforms and session storage in
`/config/.storage/icloud`. It does not create another account or replace user data.

Startup and polling first try the saved session. When it expires or is waiting
for recovery, the integration can make one normal login attempt using the
configured credentials, without requesting a code. The config entry option
`automatic_session_recovery` is a boolean defaulting to `true`; `false` keeps
recovery manual. The attempt calls native SRP directly with the saved password
instead of trying the expired token first. A challenge from that attempt, an
unknown outcome or an authentication failure waits for the user.

The client uses `pause_2fa=True` and blocks automatic `request_2fa_code()` and SMS
fallbacks. A login completed without another challenge allows normal session
use. Additional confirmation waits for the user. Opening a form, restoring an
entry or entering an invalid code never requests another OTP. Diagnostics do
not contain credentials or codes.

Silent recovery persists a checkpoint before contacting the provider. Transport
failure or an unknown response preserves uncertainty across restarts without
repeating login. The authentication state format remains unchanged. A separate
`icloud_silent_recovery.<entry_id>` Store contains only its version and a
`primary_attempted` boolean, saved before the effect. A confirmed expiry of a
previously valid session resets it. Completing authenticated native account,
coordinator, platform and photo-cache setup without a pending challenge also
closes the recovered incident, including recovery through the UI. Token
acceptance alone does not reset it. Any incomplete setup preserves the consumed
attempt. Restoring persisted state or restarting alone does not reset it.
Rollback preserves both files. Native cached-session transport backoff is
independent of this login attempt.

Typed transport failures reaching setup, including wrapped DNS, connection and
timeout errors, become `ConfigEntryNotReady` for Home Assistant's backoff. Errors
without a transport cause are not classified by message text. Retry does not
repeat login or authorize code delivery. Failure to load the persisted guard stops setup
before creating a client.

The authentication repair is closed only after full setup, loaded platforms,
a valid session and no challenge. Only reauthentication flows for that exact
entry are closed; other repairs are preserved.

If token validation succeeds but the device service rejects authentication
during setup, the same single saved-password attempt is used. After success,
native setup runs once more; another rejection waits for the user.

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
wiring and transport retry. `test_icloud_silent_recovery.py` covers saved-password
recovery, the restart-persistent marker, later expiry and service rejection after
token validation. Repair tests reject cleanup before full setup or for another
entry. They run on the host without installing Home Assistant
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


## Cached-session transport and concurrency

A typed or chained transport failure during saved-token validation preserves
`probe_cached_session` or `session_valid`. Conversion happens before the native
API exception handler can erase the transport cause. Setup uses HA's existing
backoff; keep-alive waits for its next native cycle without an immediate retry.
This path performs no primary login, authenticated renewal or OTP delivery.

The gate serializes validation and provides other consumers a locked state
snapshot. Contention defers work instead of interpreting a temporary checkpoint
as expired authentication. The validating and manual contexts avoid relocking
their own operation. Confirmed expiry allows the single saved-password attempt
described above. A challenge from that attempt, unknown failure or uncertain
delivery stays blocked. A legacy primary-authentication state may receive one
attempt only when no persisted attempt marker exists.
`test_icloud_cached_transport.py` covers these boundaries and deterministic
interleavings. Its public provider model supplements the isolated native-library
check. A loaded-code proof establishes the version, not Apple recovery.
