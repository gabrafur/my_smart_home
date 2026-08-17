# Privacy model

This repository publishes restorable architecture, contracts, and examples
without publishing a household's identity or routine. Code and documentation
use logical roles; the real installation supplies local Git-ignored bindings.

## Public roles

| Role | Public responsibility |
| --- | --- |
| `resident_primary` | first logical resident |
| `resident_secondary` | second logical resident |
| `mobile_primary` | primary mobile device and notifier |
| `mobile_secondary` | secondary mobile device and notifier |
| `vehicle_primary` | primary vehicle |
| `garage_gate` | gate and pulse relay |
| `exterior_light` | exterior-lighting group |
| `security_panel` | security panel |

A role is not an `entity_id`. Physical entities, services, and topics belong to
the private binding described in
[PUBLIC_PRIVATE_BOUNDARY.en.md](PUBLIC_PRIVATE_BOUNDARY.en.md).

## What may be public

- architecture, invariants, contracts, tests, and recovery procedures;
- logical IDs, synthetic examples, and relative times;
- public product and integration names when technically required;
- sanitized canonical memories in `.codex/memories/`, indexed by `MEMORY.md`.

`restore/private-state-manifest.yaml` contains logical names and portable paths
only. Bundles, private payloads/checksums, and encryption keys stay outside Git;
the executable contract is in
[RESTORE_CONTRACT.en.md](RESTORE_CONTRACT.en.md).

Resident names, family relationships, addresses, coordinates, private IPs,
MACs, physical IDs, account identifiers, real trackers/notifiers, routines,
routes, real payloads or logs, credentials, and tokens are not public.

Historical records may remain when they retain technical value, but must use
logical roles, synthetic data, reduced precision, and an explicit sanitization
notice.

## Semantic validation

```bash
make privacy-check
make privacy-check-staged
```

The first command scans only Git-tracked content; the second scans only staged
content. An untracked file can never make the published tree valid. The scanner
covers identity-bearing entities, private networks, coordinates, MACs,
VIN/serial patterns, residential topics, event-related timestamps, state/backup
artifacts, images outside the public asset area, and image metadata.

An optional private denylist may be supplied through `PRIVACY_DENYLIST_FILE`.
It is Git-ignored and its values are never printed. Privacy and security scanner
findings contain only rule, file, line, and category.

## Public memory and private runtime

Public memory is subordinate to current code, tests, operational documentation,
and active architectural decisions. The checker requires every referenced
memory to be Git-tracked and rejects orphan memories and invalid links.

`.agent-history/`, `.claude/`, `.local-secrets/`, undeclared `.codex/` runtime,
and equivalent directories are not documentation sources and must not be
published. Knowledge found only there must be reported as
`knowledge_not_versioned` and manually converted into sanitized public content.

## Known limitations

- Semantic scanning reduces risk but does not replace human review or a
  site-specific private denylist.
- The checker does not query registries or real devices.
- Material already published in Git history requires a separate reviewed
  cleanup and rotation procedure; removing it from the current snapshot does
  not rewrite history.
- Public vendor and model names may need documented exceptions when they are
  part of a vendored integration's contract.
