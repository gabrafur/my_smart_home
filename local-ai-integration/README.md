# Local AI RTX integration

This directory is the Home Assistant repository's consumer boundary for the
standalone [`local-ai-rtx`](https://github.com/gabrafur/local-ai-rtx) runtime.

`local-ai-rtx.lock.json` pins the repository, tag, commit, release asset, and
SHA-256 digest. `manage-runtime.mjs` validates that lock, installs the verified
release into an immutable content-addressed directory, and verifies the runtime
contract after activation.

```bash
make validate-local-ai
make install-local-ai-runtime
node local-ai-integration/manage-runtime.mjs verify \
  --runtime-dir "$HOME/.local/share/local-ai-rtx/current"
```

Machine-private configuration, endpoint values, preflight helpers, telemetry,
and canary state remain outside Git. Updating the dependency requires a new
upstream release, its verified SHA-256, a lockfile change, integration tests,
and an explicit install. `make install-local-ai-runtime` assigns the configured
`LOCAL_AI_RUNTIME_GROUP` (default `docker`) so the bridge keeps read access. The
active stack is never restarted by the installer.
