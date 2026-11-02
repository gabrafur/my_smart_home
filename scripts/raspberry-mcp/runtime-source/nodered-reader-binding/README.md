# Closed Node-RED diagnostics reader binding

The eight modules are a reviewed source export. `SOURCE-MAP.json` in the
parent directory records their observed native hashes; it is evidence of
source provenance, not current admission or deployment authority.

Historical module docstrings saying `UNINSTALLED` or `UNACTIVATED` are retained
byte for byte. They do not describe the current runtime. Query the real MCP
capabilities for current admission and operation receipts for effects.

Run synthetic tests without root or a production policy:

```sh
python3 -I -S -B -m unittest discover -s scripts/raspberry-mcp/runtime-source/nodered-reader-binding -p 'test_*.py'
```

Tests use disposable files and simulated native adapters and sockets. They
use documentation-only address ranges, never addresses from a live policy. They
cover protected files, concurrency, duplicate requests, uncertainty, restore,
revocation, the bounded inactive-reader wait, fixed Docker metadata and
broker/transport gates. The frontend fixture preserves prior schemas and pairs
the fixed revocation action exclusively with its revocation tool. They do not
prove a live network repair, a client confirmation or autonomous execution.

The optional sealed client event policy is distinct from native admission and
server scheduling. Missing or invalid approval does not activate it; revocation
preserves operation receipts and closes further effects. A client approval
still requires each executor preflight and any confirmation the interface needs.
The native wait observes the existing reader for up to 30 seconds before an
intent; the fixed client timeout is 48 seconds, below the frontend's 50 seconds.
Neither deadline is a guarantee against OS or I/O delays. Uncertain effects
always require status and reconciliation instead of another write attempt.

See the [operator reference](../../../../docs/raspberry-mcp/reference/nodered-reader-binding.md)
for scope, installation dependencies, recovery and deployment limitations.
No policy, credential, live identifier, ledger, unit or installation approval
is distributed here. Copying these files cannot enable maintenance.
