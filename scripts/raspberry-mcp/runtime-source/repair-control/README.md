# Fixed repair control

The `persistent_revocable` policy admits only the fixed health-summary verifier
catalogue. It does not reopen historical task administration, supply arbitrary
prompts, change thread permissions, or replace required interface confirmations.
The configured task/thread identity remains private installation data.

The runtime uses the current v2 native peer and passes the verified connected
socket to its RPC adapter. New submissions require both task and repair admission.
Revocation blocks new effects while preserving exact status, result and
reconciliation. Capabilities report admission; they do not prove that the
configured thread can execute. An unloaded legacy thread requires separate
profile enrollment and refuses with `legacy_resume_profile_unenrolled`; the
adapter never resumes it with implicit defaults.

Two reservations per rolling 24 hours remain the repair limit. Actual repair
attempts are also counted in the legacy six-attempt limit and the combined task
budget, with shared spacing and coordination locks. Pending and uncertain work
must be reconciled. A reservation without a legacy dispatch intent proves no
send occurred, retains its identity, and still requires acknowledgement. Missing
historical timestamps fail closed instead of inventing age or resetting quota.

Acknowledged terminal own work older than 24 hours can move to immutable central
archives containing exact jobs, audit rows and results. Verified archive readback
precedes atomic compaction; tombstones retain IDs and hashes for duplicate
requests. Partial file writes and publication recover the same archive without
replaying a task. Unrelated, recent, pending and uncertain records stay intact.
Limits remain 4,096 tombstones, the existing 1 MiB shared database boundary and
128 KiB per archive; capacity exhaustion refuses new work.

Installation must close source pins through repair policy, component policy and
its systemd unit literals under native custody. Use a reviewed finite CAS release
with beforeimages, exact readback and an own inverse. Before reverting to an old
reader, restore archived own rows through `Store.restore_archive`. A successor
job/audit collision refuses the inverse and preserves the current reader and
history; revoke new effects while resolving it. Keep additive database columns
and immutable archives. Observe the same operation after uncertainty.

Targeted isolated checks are `test_standing.py`, `test_archive.py` and
`test_rpc_standing.cjs`. They use temporary SQLite state and mocked RPC; the
archive file fixture substitutes only its test owner's UID. Installed finite
regressions and integrated quota/retention tests are also required by the release
qualification. No test dispatches a real thread or changes production.
