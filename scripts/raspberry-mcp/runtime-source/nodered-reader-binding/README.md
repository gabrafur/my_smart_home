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
revocation, fixed Docker metadata and broker/transport gates. They do not
prove a live network repair, a client confirmation or autonomous execution.

See the [operator reference](../../../../docs/raspberry-mcp/reference/nodered-reader-binding.md)
for scope, installation dependencies, recovery and deployment limitations.
No policy, credential, live identifier, ledger, unit or installation approval
is distributed here. Copying these files cannot enable maintenance.
