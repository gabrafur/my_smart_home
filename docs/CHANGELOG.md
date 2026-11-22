# Changelog

## Como ler / How to read

Mudanças relevantes para quem usa ou faz fork do projeto, a partir dos tipos de
[Conventional Commits](CONVENCAO_COMMITS.md). Novidades (`feat`) e desempenho
(`perf`) são listados; correções (`fix`) aparecem só como contagem e ficam
detalhadas no histórico do Git. As versões seguem CalVer `vAAAA.MM.N`: cada
tag publica uma Release no GitHub com a seção correspondente deste arquivo.
Para um fork, acompanhe as Releases em vez da `main`, que recebe commits
automáticos todos os dias. A revisão semanal da documentação acrescenta as
entradas novas em *Não lançado*. Os assuntos dos commits são em inglês.

Notable changes for users and forks, from
[Conventional Commit](COMMIT_CONVENTION.en.md) types. Features (`feat`) and
performance (`perf`) changes are listed; fixes (`fix`) appear only as a count
and stay detailed in Git history. Versions follow CalVer `vYYYY.MM.N`: each tag
publishes a GitHub Release with the matching section of this file. A fork
should follow Releases rather than `main`, which receives automated commits
every day. The weekly documentation review appends new entries under
*Unreleased*. Commit subjects are in English. Months before the first release
are listed by month; 2026-06 and 2026-07 predate the commit convention.

## Não lançado / Unreleased

Sem mudanças desde `v2026.11.0`. / No changes since `v2026.11.0`.

## v2026.11.0 — 2026-11-22

### Novidades / Added

- **release**: publish CalVer releases from the changelog
- **docs-review**: maintain documentation in general every week
- **docs**: flag broken inline Mermaid blocks in docs-check
- **mcp**: re-enroll registry-verified Codex binaries after updates
- **ha**: show dashboards in each resident's profile language
- **mcp**: let eva control every household device
- **mcp**: let eva run the air conditioner, PC shutdown and gate pulse
- **ha**: split dashboards into Casa and admin-only Sistema
- **scripts**: validate on the owner's PC when reachable
- **review**: flag a pending Docker update recovery record
- **ha**: stop recording duplicated codex token counters
- **mcp**: add read-only live Home Assistant state tool for Eva
- **dashboard**: show Git, offsite and restore as separate results
- **updates**: hold Node-RED image until the sealed review follows
- **mcp**: add OAuth edge so Claude can reach the Raspberry MCP
- **review**: warn when a Zigbee device battery is at 20% or less
- **arch**: stale-entity review, Function size budget, house dashboard
- **review**: flag silent Zigbee devices missed by coordinator recovery
- **review**: watch Eva's continuation policy and name every chain drift
- **updates**: let containers update when a pre-change gate refuses Core
- **updates**: report core service readiness after every host stage
- **memory**: record each container's sampled daily maximum
- **memory**: record each container's daily memory peak
- **updates**: report core service readiness after the DietPi stage
- **publish**: keep which checks failed when pre-push refuses
- **host**: stop containers cleanly at shutdown and add CI parity run
- **review**: flag missing live-restore and memory limits on the host
- **mcp**: report exhausted ChatGPT/Codex usage clearly to Eva and owner
- **mcp**: explain Codex task refusals with account usage status
- **mcp**: let the fixed installer accept the broad client policy
- **mcp**: let eva switch registered household lights
- **mcp**: revoke own node-red admin tokens left after apply
- **mcp**: detect node-red administration chain drift early
- **nodered**: route technical incidents to the Eva private outbox
- carry private Node-RED notices to the Eva spool
- **mcp**: admit the broad Eva task profile with bounded retention
- route operator-only notices through a private spool
- add proactive maintenance review with tracked recommendations
- make cloud rollback setup portable for forks
- retain rollback images in verified cloud storage
- **zigbee**: maintain coordinator firmware with verified recovery
- **nodered**: prepare scoped administration and lighting repair
- **mcp**: identify Zigbee targets and communicate with threads
- add bounded task result events to MCP
- expose reviewed MCP guides through read-only catalogue
- enable bounded event driven reader maintenance
- expose repair outcomes and coordinate parallel agents
- expose approved client event policy in storage metadata
- add desktop browser maintenance skill

### Desempenho / Performance

- **compose**: cap container memory, flush Node-RED context less
- **recorder**: also skip VPN and weekly-review state churn
- **recorder**: stop recording monitoring heartbeats nobody reads

Correções / Fixes: 113.

## 2026-10

### Novidades / Added

- **mcp**: bind revision admission to publication receipts
- **mcp**: prepare protected Node-RED revision records
- **mcp**: expose maintenance readiness and portable documentation
- add bounded storage diagnostics and recoverable maintenance
- authenticate isolated recovery archives before sealing
- add a bounded supervisor for recovery probes
- prepare native backup profile observation
- gate first backup generation on saved settings
- bind metadata backup dispatch to the launched worker
- guard first metadata backup dispatch with Root history
- stage metadata backup without rewriting prior receipts
- restore MQTT history without replaying old authority
- **mqtt**: include protected snapshots in verified backups
- **mqtt**: coordinate backups outside the consumer runtime
- **mqtt**: audit replacement images before source rebinding
- **mqtt**: seal replacement policy from fixed audit receipt
- **mqtt**: add fixed maintenance controller and source rebind
- record bounded MQTT maintenance and physical cadence
- install the latest device firmware automatically
- preserve MQTT windows across consumer restarts
- persist visual MQTT observation window decisions
- expose verified MQTT callback coverage horizons
- persist canvas checkpoints before MQTT acknowledgements
- preserve MQTT accounting across verified source closure
- add guarded MQTT deployment file transactions
- add opt-in native MQTT metadata observer sources
- require approval for Kia runtime facts
- retain per-revision Home Assistant timing receipts
- account for passive host observations and timing
- **nodered**: preserve canonical notification timing
- **mcp**: persist webhook transport completion evidence
- **mcp**: verify controlled Node-RED deployment and rollback
- **restore**: verify neutral recovery isolation
- **mcp**: expose loaded Node-RED and iCloud diagnostics
- **mcp**: expose bounded iCloud readiness observations
- **mcp**: prepare heartbeat repair worker and reconciliation
- **mcp**: coalesce notification events for current-state delivery
- **mcp**: attest native heartbeat code identity
- **mcp**: prepare protected repair worker process
- **mcp**: bind repair admission to existing task budgets
- **mcp**: prepare durable Node-RED repair worker
- **mcp**: prepare component identity and receipt boundaries
- **mcp**: expose sanitized notification diagnostics
- correlate scheduled collector evidence with native unit costs
- correlate collector signals and native invocation costs
- route sanitized host observations through Node-RED
- **mcp**: retain scheduled read-only acceptance evidence
- **mcp**: delegate administration and support portable clients
- **mcp**: prepare local isolation and snapshot installation
- **mcp**: prepare isolated Raspberry read-only diagnostics
- **backup**: activate scoped recycle-bin retention
- **backup**: add verified daily off-site backup gate
- **nodered**: turn off exterior lights at sunrise
- **rtx**: calculate dashboard metrics in Node-RED

### Desempenho / Performance

- **local-ai**: compact test output without losing information

Correções / Fixes: 90.

## 2026-09

### Novidades / Added

- **memory**: validate discoveries and require task review
- **notifications**: alert on operational actions and failures
- **notifications**: retain delivery history for seven days
- **nodered**: lint improvement and notification settings update
- **nodered**: automate Codex CLI updates
- **nodered**: recover Codex remote access automatically
- **nodered**: reclaim abandoned temporary memory
- **nodered**: add guarded ELK canvas layout
- **node-red**: monitor Home Assistant integration failures
- **node-red**: orchestrate safe HACS integration updates
- **alexa**: add chat dashboard text announcements
- **nodered**: centralize notification delivery hubs
- **nodered**: automate repository dependency updates
- **nodered**: centralize update orchestration
- **location**: centralize near_home radius policy
- **nodered**: alert on rtx availability loss
- make arrival light radius configurable
- **storage**: automate cleanup and recorder monitoring
- **location**: improve source activity dashboard
- **nodered**: persist and harden global failure alerts

Correções / Fixes: 115.

## 2026-08

### Novidades / Added

- **nodered**: add conservative host memory guardian
- **kia-uvo**: automate Codex conflict merges
- **nodered**: migrate Kia update checks to daily flow
- **nodered**: schedule weekly documentation review
- **nodered**: orchestrate daily host updates after backup
- **nodered**: monitor VPN health and notify failures
- **node-red**: centralize garage gate pulse control
- **node-red**: add Tuya health alerts and reminders
- **observability**: expose structured extraction canary status
- **local-ai**: add structured extraction canary runtime
- **observability**: expose restricted RTX pivot
- **local-ai**: enforce evidence-gated restricted routes
- **observability**: show local model bake-off results
- **local-ai**: add quality-first model bake-off
- **demo**: expand synthetic recovery evidence
- **homeassistant**: add per-user chat access and trusted context
- **local-ai**: benchmark high-potential RTX tasks
- **homeassistant**: expose confirmed local AI savings
- **local-ai**: confirm routed context delivery
- **local-ai**: enforce reliable RTX token savings
- improve RTX context quality and observability
- add vehicle door lock action
- clear Codex chat history and context
- translate local Codex activity
- **nodered**: update vehicle flow
- **homeassistant**: refine RTX dashboard metrics
- finalize automatic local AI routing
- organize favorites dashboard into three columns
- **creta**: improve dashboard and trip history
- organize RTX dashboard into ordered sections
- add deterministic recovery bootstrap and demo
- complete public privacy and validation P0
- improve Local AI routing and memory telemetry
- **homeassistant**: refine Codex usage summary
- improve Local AI audit and telemetry
- **docs**: add manual review trigger
- **codex**: aggregate host session usage
- **homeassistant**: add RTX refresh controls
- **nodered**: move Codex push test to alert flow
- **homeassistant**: improve Codex and RTX dashboards
- **codex**: add local AI health and model routing
- **creta**: organize dashboard layout
- **creta**: automate safe integration updates
- **creta**: expose refresh and vehicle controls
- **creta**: redesign vehicle dashboard
- **creta**: refresh on significant movement
- **creta**: sync Bluelink integration 3.10
- **codex**: add RTX local AI monitoring
- **codex**: add prompt routing and local AI context policy
- **codex**: add usage monitoring and alerts
- add bounded local AI helper
- **creta**: add automatic trip fuel estimates
- improve dashboard visualizations
- add Node-RED storage health maintenance
- add security context restart recovery
- move Raspberry Pi cooling to Node-RED
- centralize infrastructure monitoring in Node-RED
- expose weekly documentation review status
- automate weekly documentation reviews
- add automatic alarm disarm on arrival
- add verified coordinate history scrub tooling
- add CarPlay alarm action and template blueprint
- add shared Home Assistant agent history
- allow Codex assistants to control Home Assistant
- add secret scanner and CI check
- improve security lighting dashboard layout
- add single-pulse garage gate button
- add Raspberry Pi health monitoring
- pre-light security zone and activate gate lighting
- **creta**: add trip dashboard and overwrite analysis

Correções / Fixes: 119.

## 2026-07

### Novidades / Added

- replace cloud garage scene with local Zigbee relay
- add Codex assistant to Home Assistant chat
- add agent bridge alarm integration and power controls

Correções / Fixes: 5.

## 2026-06

Correções / Fixes: 1.
