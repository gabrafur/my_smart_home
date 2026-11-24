# Global Node-RED failure notifications

[Português (principal)](NODERED_GLOBAL_FAILURE_NOTIFICATIONS.md) · [English](NODERED_GLOBAL_FAILURE_NOTIFICATIONS.en.md)

The `observabilidade_global` tab centralises failures from every functional
Node-RED tab. Each production incident calls the mobile hub for
`resident_primary` only and the persistent hub with a stable ID. The details of
`mobile_primary/notify_3` and `persistent_notification.create` are confined to
the [canonical hubs](NODERED_NOTIFICATION_HUBS.md) (Portuguese).

## Coverage

The generator `nodered/tools/install-global-flow-observer.mjs` adds to every
tab an isolated group with:

1. a `catch` for all errors, including those already handled locally;
2. a `status` for every node on the tab;
3. identification of the source tab;
4. a named `link out` to the central monitor.

Errors raised with `node.error` alert immediately. The same signature is
silenced for six hours to avoid storms. For Home Assistant and MQTT nodes,
individual errors are also suppressed while the shared connection is down and
for 90 seconds after reconnection, so the startup reads of many tabs do not
produce a burst for the same restart. The
[shared resume](NODERED_STARTUP_RECOVERY.md) (Portuguese) also keeps these
transient errors suppressed while Internet/VPN have not stabilised;
authentication errors stay immediate, and unrelated function errors keep
alerting immediately.

Only explicit text for a lost connection, unavailability, or pending
reconnection can open a shared incident; red colour, a domain condition, or a
failed service call do not mean the whole connection is down. Entity statuses
such as `offline : <time>` or `unavailable : <time>` do not prove an outage
either, even when they appear on several nodes. The adapter accepts the
explicit connection contract, including `home-assistant.status.disconnected`
and `home-assistant.status.error`. When it loads the policy, it removes only
those old entity-state evidences, preserving real and MQTT failures; normal
evaluation then closes the incident that lost corroboration.

A Home Assistant call with `NoConnectionError`, `Connection lost`, or the
websocket result envelope with code 3 and message `Connection lost` also feeds
that confirmation, even when it arrives before the disconnection status. A
generic timeout or a service failure is not enough. A vehicle refresh or cache
probe timeout belongs to the vehicle lifecycle, which retries, notifies once and
removes its notice on fresh telemetry, so the observer does not duplicate it. A
flow that owns the notice of a node lists its ID in `msg._observer_owned`; every
other node still alerts. Generated hub callers,
identified by the notification contract, share the Home Assistant grace period
to avoid a cascade while the queue waits for reconnection; an ordinary link
call still alerts. The vehicle refresh keeps evidence and deadlines during that
disconnection, without bypassing, creating a provider API failure, or
duplicating the error in its handler.

DuloNode unavailability statuses still consider errors and timeouts too. The
condition must persist for one minute before the push, but only when the
canonical Internet state is confirmed `online`. In `offline`, `recovering`,
`checking`, or `unknown`, the DuloNode status is a consequence or diagnostic of
the external dependency and does not open a second incident. Visual statuses of
domain functions do not open a global alert, because their incidents already
belong to the specific monitor.

A shared Home Assistant outage needs simultaneous corroboration from at least
two nodes; one node with an unavailable domain or entity does not represent the
whole server. Home Assistant and MQTT connections are aggregated, avoiding one
push per node when the shared dependency drops. The first explicit
reconnection signal closes every source of the same shared connection and
releases the next incident's alert after the reconnection grace period. The
adapter also recognises the native keys `home-assistant.status.connected` and
`home-assistant.status.running`, emitted untranslated by the integration.
`connecting`, a successful service call, and entity values do not prove
recovery. If the incident had already been notified, the monitor silently
removes the matching persistent notification without an extra recovery push.

The monitor does not include its own tab in the universal capture. A failure of
the node that sends the push or creates the persistent notification has a
dedicated `catch` that only logs the problem, without feeding the channel back
and recursing. Each persistent notification uses a stable identifier per
incident, so a repetition updates the existing alert instead of creating
copies.

The monitor's three central nodes — classification, temporal confirmation, and
effect separation — have a dedicated internal `catch`. That path skips the
failed processor, applies six-hour dedupe, and calls both delivery channels
directly. The internal handler and the log terminals are outside their own
scope to prevent recursive feedback.

When the mobile hub fails during an Internet outage that is already confirmed
or still recovering, the failure is still written to the private history and
returned to the caller, but it does not create another push or persistent
notification about the channel itself. `unknown` and `checking` are not treated
as confirmation of an outage and keep the delivery alert.

## Detailed cause history

The private history in `/data/failure-history/`, inside Node-RED, is the
diagnostic source for new failures. Every error received by a catch produces a
JSONL line before the notification gates, including duplicates and errors
suppressed during resume. Internal monitor and delivery errors are recorded
too. Domain alerts and confirmed unavailability are recorded at the dispatch
input; delivering the same error does not create a second copy.

Each record keeps time, source, correlation ID, the full message up to the
structural limit, code, stack trace, and chained causes when the producer
provides them. `reason`, `status`, `request_id`, `exit_code`, `signal`,
`stdout`, and `stderr` are kept when present in the return value or in the
explicit `msg.observer_diagnostic` contract. Confirmed statuses include the
original texts of the nodes that corroborated the unavailability. The summary
sent to the phone stays separate from the diagnostic.

The adapter strips credential patterns from the texts and never serialises the
whole `msg`. Individual fields are capped at 20,000 characters and cause chains
at eight levels; `truncated_fields` declares any cut. Fields the producer did
not provide stay absent or `null`, without inventing a cause. Older records
that already lost details cannot be reconstructed by this change.

The directory has mode `0700` and is outside Git. Hourly files are appended by
the File node, independently of the context flush, and survive restarts. The
visual policy `error_retention_days` controls retention (seven days by default,
1–30 days); the daily cleanup touches only expired files. The history contains
private operational data and must not be copied into documentation or public
memory.

The existing manual tests also go through the recorder, but end at
`global_observer_diagnostic_dry`, with no production file or notification. Use
reset → error (repeat it to test dedupe) → unavailability → evaluation and check
the simulated record. A recorder or cleanup failure goes to the runtime log
with the markers `NODERED_FAILURE_HISTORY_WRITE_FAILED` or
`NODERED_FAILURE_HISTORY_PURGE_FAILED`, without recursion. When investigating,
filter the JSONL files by `recorded_at`, `source_id`, or `incident_key`.

`test-failure-diagnostics.mjs` covers chained causes, credentials, explicit
truncation, suppressed errors, duplicates, status, domain, dry-run, reading
after restart, and retention. Serialisation lives in its own adapter to keep
the notification policy independent of storage.

The source `FONTE: entradas do Home Assistant` forwards connection errors and
statuses to the central classifier, with the same confirmation, recovery, and
dedupe as the other Home Assistant consumers. `NoConnectionError` in that
query is not an internal monitor failure. API errors without disconnection
evidence keep alerting; classifier failures keep the internal route without
recursion.

## Coverage audit

For every functional tab, the validator requires a universal `catch` that
includes handled errors and a universal `status`, both linked to the central
monitor. That covers exceptions and `node.error`, failures reported by nodes,
timeouts, and the explicit unavailability states of Home Assistant, MQTT, and
DuloNode. The two delivery channels and the monitor's own internal path are
validated separately. A complete runtime outage stays covered by the native
watchdog in Home Assistant, because a stopped Node-RED cannot observe itself.

Configuration nodes with no execution of their own do not emit errors or
statuses directly; their failures appear on the observed consumer nodes.
Domain conditions that raise neither error nor status must keep being modelled
by the specific functional monitors, so legitimate states do not become false
global incidents.

## Runtime unavailability

Home Assistant calls use `queue: all`. If the local connection to Home
Assistant drops, Node-RED keeps the call and tries to deliver it when the
connection returns. There is no push through Home Assistant while Home
Assistant itself is down.

Node-RED publishes retained `online`/`offline` on `nodered/status` using MQTT
birth, close, and LWT. The native package
`homeassistant/packages/nodered_flow_health.yaml` watches that topic outside
Node-RED. After 90 seconds offline, Home Assistant creates a persistent
notification and pushes to `resident_primary`; on return it closes the incident
and sends the recovery. A short deploy does not open an incident.

If Node-RED and Home Assistant are down at the same time, neither can produce a
push at that moment. When Home Assistant comes back while the retained LWT is
still `offline`, it detects and alerts. If both return before any external
observer records the outage, the interval cannot be reconstructed reliably;
monitoring from outside the host is required to cover that extreme case.

## Tests

On the `observabilidade_global` tab:

1. use `TESTE 1: reset`;
2. use `TESTE 2: erro de nó` and check the dry-run terminal;
3. use `TESTE 3: indisponível`;
4. use `TESTE 4: avaliar após 1 min` and check the dry-run terminal;
5. optionally, use `TESTE 5: enviar push real` for a smoke test of the central
   channel when end-to-end confirmation is needed.

The first four steps never call Home Assistant. The fifth is the explicit
`notification_delivery_under_test` exception: it sends a single push with
`TESTE` in the title and message, with no other household effect. The log
`NODERED_GLOBAL_NOTIFICATION_ACCEPTED ... delivery_test=true` confirms that
Home Assistant accepted the call; visual confirmation on the phone validates
the last mile. The smoke test does not create a persistent notification. It is
not required to deploy, commit, or push Node-RED changes that do not materially
modify the notification route.

Canonical validation:

```bash
npm --prefix nodered run flows:update-global-observer
npm --prefix nodered run flows:validate-observability
npm --prefix nodered run flows:test-global-observer
npm --prefix nodered run flows:validate-layout
npm --prefix nodered run flows:render-strict -- observabilidade_global
```

## Detection, decision, and acceptance evidence

The host producer keeps the first observation used to open the incident and
its first detection while it waits for confirmation. Later samples do not
replace those times. If a legacy incident had no source time, it stays unknown.
A new responsibility after `unknown` starts with the new observation, following
the existing lifecycle.

Node errors, status confirmation, and the integration inventory publish the
available detection and decision times. They do not invent an occurrence time
on the device. The internal path that prevents recursion also publishes its own
times. The final gate carries only the canonical fields to production and
dry-run. Domains that do not yet publish times keep a partial or unknown
observation; do not infer universal coverage.

The [hub contract](NODERED_NOTIFICATION_HUBS.md#horários-canônicos-e-limites-de-latência)
(Portuguese) documents the validation, intervals, and limits. Failure
classification and gates stay in the canonical producer; the time values do
not change confirmation, dedupe, lifecycle, or effect selection. No artificial
incident or real notification is needed to validate the instrumentation.

## Optional IPP printer unavailable

`ipp` in `setup_retry` with the exact communication-failure reason becomes
`optional_printer_unreachable`: an unknown-availability diagnostic, with no
recurring push and no re-authentication advice. The persistent message explains
that the printer may be switched off and keeps the previous key. The raw reason
is not published. The return of this condition is also silent; authentication,
configuration, migration, a missing reason, and other integrations keep
alerting normally. The decision belongs to the Node-RED observer's normaliser
and lifecycle; isolated test: `test-ipp-optional-availability.mjs`.
