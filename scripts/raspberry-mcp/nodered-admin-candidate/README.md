# Structured Node-RED administration

Implementation and review artifacts for one structured flow-administration
contract. Importing, testing, committing or publishing does not register tools,
grant privileges or deploy flows. Current installation and authorization come
from `nodered_admin_read` with `view=policy`, not this directory name.

See `docs/raspberry-mcp/reference/nodered-administration.md` for authority,
transaction, privacy, native evidence and rollout requirements. `PROPOSAL.json`
is a default-closed scope template, not a live policy. Systemd files are
templates; deployment must seal exact bindings, sources and expiry.

Production requires Root-owned sealed modules, actual shared locks and native
guards. Synthetic adapters are not production attestations. Client-supplied
approval/readiness flags are refused. Core retention checks do not certify
arbitrary contrib-node shutdown handlers or physical device behavior.

`lighting.patch` preserves the original review against an earlier public
baseline. The canonical implementation now lives in the Node-RED generator,
functions and regression tests. Do not reapply the artifact to corrected sources
or copy fixture flows over the active file instead of the admitted API CAS.

## Closed Eva private-event builtins

The engine admits `fs`/`crypto` only on the exact reviewed private-event exporter
and `fs` only on its status reader. Node identity, tab, complete function body,
empty initialization/finalization and output count are pinned together. Any
subsequent function patch rechecks that contract, including a function-only
patch that retains existing libraries. Generic modules, aliases, subpaths, npm
installation and arbitrary filesystem programs remain refused. Native Node-RED
resolves these exact builtin names without installing a package.

Admission does not deploy flows: existing exact-effect review, interface
confirmation, quotas, shared locks and API revision checks still apply. Tests
load the canonical function sources directly so changing their bytes requires
a separately reviewed pin update. Before reverting to an engine without this
function-only guard after a builtin flow deployment, use the existing native
revocation and retain it during source rollback; source rollback is not a flow
rollback and never erases operation journals.
