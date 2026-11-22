# Raspberry MCP — English summary

[Português (principal)](README.md) · [English summary](README.en.md)

The Raspberry MCP exposes bounded observations and operations of the home
server to AI clients. Authority stays in the local Root policy (fixed targets,
quotas, identities, expiry and durable receipts) whichever client connects.
The canonical, detailed documentation is in Portuguese; this page summarizes it.

## Capabilities and limits

The [closed Node-RED reader binding catalogue](reference/nodered-reader-binding.md)
can preview and replace one derived container return peer for the diagnostics
reader, or restore its own previous value. It preserves fixed targets,
confirmations, shared locks, write limits and uncertain receipts; it does not
deploy flows, restart household services or enable recurring execution. The
versioned source export includes synthetic lifecycle and transport tests;
private policies and deployment identities remain local. The reference lists
the installation dependencies and remaining reproduction limits explicitly.

[Administration and portability](README.md) is the
current operational guide. Administrative objectives use the existing task
tools and an explicitly authorized profile, with the original expiry and
shared budgets preserved. Real MCP acceptance confirmed the executor's root
identity; this does not certify complete proactive operation. The optional
authenticated loopback HTTP transport was tested against the real Unix server
and remains separately deployable. It does not provide a public URL, OAuth
server, or certification for an untested chatbot. The schema template removes
private thread bindings, and the runtime source map distinguishes active code
from the older task-control candidate preserved below.

The [proactive maintenance review](reference/proactive-review.md)
inspects the host, repository and operational files on a versioned schedule and
budget, keeps a deduplicated ledger of recommendations with benefit, priority,
risk and proposed action, runs only catalogued reversible actions, and announces
changes through one stable persistent notification carried by the existing event
path. It is client-neutral and grants no repair authority.

[Existing-thread communication](reference/workspace-communication.md)
uses a separately enabled policy on the current task tools. It preserves the
recipient's profile, uses active-turn steering or idle-turn start, and refuses
unloaded threads without profile proof. Shared quotas, expiry, durable receipts
and uncertain-delivery blocking remain in force. A bounded sanitized reply must
be proven later than delivery; exact acknowledgement, turn completion and
household recovery remain separate evidence.

The [household lights and actions tools](reference/household-lights.md)
start with `ha_lights_read`/`ha_light_set` for the lights registered in a Root
policy, confirmed by readback. `ha_actions_read`/`ha_action_run` add a few
registered actions (air conditioner, PC shutdown, and a rate-limited garage-gate
pulse whose position stays unknown). `ha_entities_read`/`ha_service_call` reach
other household domains through a closed list of services per domain, with
connector confirmation, per-domain rate limits, and no automatic retry. Host
shutdown/reboot scripts, Home Assistant administration, and the raw gate relay
are denied in code; removing `generic` from the policy restores the narrower
scope.

The [Home Assistant state tool](reference/home-assistant-states.md)
(`ha_states_read`) reads, live and read-only, a fixed Root-policy list of status
entities with value, measurement time, age and availability; alarm, locks, gate
and location are not reachable.

The [Codex peer re-enrollment](reference/codex-peer-reenrollment.md)
service lets task control survive Codex CLI updates: every five minutes it updates
only the pinned executable hash and size, and only for the process really serving the
control socket whose binary is byte-identical to the npm registry build; the attestor
then re-attests by CAS.

The [general Node-RED administration contract](reference/nodered-administration.md)
has a default-closed implementation with structured graph edits, opaque
revision CAS, durable intents, native guards and own-operation rollback.
Recoverable deletion retains IDs; device testing and sensitive startup effects
require separate authority. Existing diagnostic and protected-host profiles are
preserved. Read the sealed policy for actual authorization; isolated tests and
publication do not prove production deployment.

The [notification contract](reference/notifications.md) separates
current collector health from retained private text. Authorized clients link
the public revision through `legacy_reference`, then read the exact private
revision and content digest. Credential filtering remains active. Portable
reader templates require explicit local identity binding and fail closed
until composed by the installer. Snapshot reload compares immutable text
values independently of JSON object-key ordering.

The documentation now has permanent functional paths under `docs/raspberry-mcp/`:
[architecture](architecture.md), [installation and authentication](installation.md),
[tools and schemas](tools.md), [operation and recovery](operations.md)
and [document migration](migration.md). Client/model choice does not
renew local authority, budgets or executor credentials. The implemented task
backend still depends on Codex; no alternative executor is certified. Detection,
diagnosis, admitted correction and native verification each require their own
evidence. Interface confirmations and expired-lease gates remain in force.

The [Node-RED transaction acceptance](../../scripts/raspberry-mcp/nodered-controlled-deployment.acceptance.json)
also records real MCP apply, rollback and reapply, each with a complete native
dry-run, dedupe, recovery and cleanup. Only six function bodies changed; service
start times were preserved. A strict admission correction accepts the current
task's own in-progress observation while retaining every other identity, busy
and reconciliation gate. These fixed consumed transactions do not establish
natural Events consumption, integration recovery or 24-hour independence.

An optional Kia `runtime_facts` reader requires separate approval and a
Root-owned binding for the existing validator's six entity roles. Its fixed
template returns only state kinds and timestamps, with no vehicle values,
attributes, location or private IDs. Missing or revoked approval prevents the
request; these observations do not establish loaded code, provider recovery
or natural polling. See the [read-scope contract](reference/component-repair.md#indicadores-nativos-kia-com-autorização-separada).

After changing MCP event definitions, rescan the server from its ChatGPT plugin
page while preserving the existing subscription and delivery limits. A loaded
local schema and an accepted webhook do not establish the remote catalog or
an assistant run; correlate the destination's actual execution and result.
Notification source, collector observation and processing timestamps describe
different stages and must not be substituted for end-to-end latency.
The notification collector can retain those clocks per revision in an optional,
immutable SQLite receipt, separate from signed event data. Missing history,
removals, reconnect snapshots and uncertain clock ordering remain unknown;
wall-clock differences do not establish continuous 24-hour coverage.

[Codex tasks and authorized threads](reference/task-control.md) documents the
prepared `codex_threads_list` extension, strict input schemas, read-only
pagination, partial host coverage and creation reconciliation. A durable thread
with an incompatible permission profile remains blocked for sending. The
installer preserves the current lease and authorized IDs; deployment and real
MCP client validation are still required. Native titles, private history and
unvalidated opening links are withheld.

The Portuguese documents describe diagnostics, sanitized evidence, capability coverage and maintenance boundaries. Listed tools do not establish deployment or permission to modify household services.

- [Evidence stage 2](maintenance/evidence-stage2.md)
- [Maintenance matrix](maintenance/matrix.md)
- [Maintenance stage 1](maintenance/stage1.md)
- [Operations proposals](maintenance/proposals.md)
