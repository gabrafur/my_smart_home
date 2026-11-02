# Node-RED administration candidate

Uninstalled, default-closed implementation for one structured flow-administration
contract. It does not register MCP tools, create services, change policy or deploy
flows by being imported, tested, committed or published.

See `docs/raspberry-mcp/reference/nodered-administration.md` for authority,
transaction, privacy, native evidence and rollout requirements. `PROPOSAL.json`
is a scope proposal, not a live policy. The systemd files are templates only.

The engine uses mandatory injected transport and coordination; production uses
Root-owned sealed modules and native guards. Synthetic adapters in tests are not
production attestations. Readiness or approval booleans in MCP input are rejected.
No native Core preservation test can certify arbitrary contrib-node shutdown
handlers or physical device behavior.

`lighting.patch` is a review artifact against the public baseline. It must be
applied and generated in an isolated workspace first. Never apply it directly to
the active `/mnt/data/docker/nodered/flows.json` as a substitute for admitted API
revision CAS, validation and deploy.
