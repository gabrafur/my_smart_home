# Fixed repair control

The `persistent_revocable` policy admits only the fixed health-summary verifier
catalogue. It does not reopen historical task administration, supply arbitrary
prompts, change thread permissions, or replace required interface confirmations.
The configured task/thread identity remains private installation data.

The runtime uses the current v2 native peer and passes the verified connected
socket to its RPC adapter. New submissions require both task and repair admission.
Revocation blocks new effects while preserving exact status, result and
reconciliation. Capabilities report admission, not actual thread execution.

An explicitly enrolled fixed thread can use the supported resume API with a
Root-adopted owner scope and broad-access addendum. The enrolled profile uses
full access with on-request approvals and the user as reviewer; broad access
does not imply automatic approval. Model/provider/cwd/approval/reviewer/sandbox
and thread identity must match the real resume response before a turn starts.
Optional effort and runtime roots are reported or unreported without inventing
proof. Project cwd/roots are context, not filesystem confinement under full
access. No network-connectivity claim follows from the sandbox mode.

A durable operation/profile/peer-bound intent precedes resume. Lost response or
uncertain outcome blocks the same and later automatic resumptions; only the exact
operation may be reconciled. Successful readback is persisted before turn/start.
Resume explicitly applies the enrolled configuration and loads the thread; it is
not a read-only operation or an implicit restoration of historical defaults.
No new thread, private transcript hydration, arbitrary instructions or legacy
administrative grant is introduced. Approval-needed remains a nonterminal turn
and must be handled in the existing authenticated interface. Other native clients
can still race between profile readback and turn/start; there is no global CAS.

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
and immutable archives. If any resume intent exists, revoke fixed repair admission
before reverting profile-aware sources; retain that revocation and every resume
receipt. Source rollback does not restore an unobserved earlier profile or unload
the thread. Observe the same operation after uncertainty.

Targeted isolated checks are `test_standing.py`, `test_archive.py` and
`test_rpc_standing.cjs`, plus `test_resume.py` and `test_resume_profile.cjs`. They use temporary SQLite state and mocked RPC; the
archive file fixture substitutes only its test owner's UID. Installed finite
regressions and integrated quota/retention tests are also required by the release
qualification. No test dispatches a real thread or changes production.

### Historical reservations without a timestamp

An acknowledged terminal reservation with a verified result hash and no trusted
creation time is charged as one submission in **every** rolling 24-hour window.
Its NULL timestamp, identifier and result remain intact. This conservative
charge can reduce capacity indefinitely; it never infers an age or resets the
quota. Unsettled, corrupt, wrong-task or nonterminal unknown records still
refuse new submissions. Invalid known timestamps also fail closed.

Capabilities expose `quota_observation.unknown_timestamp_reserved_count`, the
current charged count and the explicit policy, including after revocation.
Failed readback is `unconfirmed`, not zero. Unknown-time rows cannot be compacted
by the old-terminal archive path. Exact future evidence requires a separately
reviewed correction; ordinary operation does not repair historical timestamps.
