#!/bin/sh
set -eu

# DuloNode 1.0.11 does not retry its initial cloud deployment when DNS is
# unavailable during boot. Apply the reviewed, idempotent compatibility patch
# before Node-RED loads the module, then preserve the image's canonical command.
node /data/tools/prepare-runtime-flows.mjs
node /data/tools/patch-dulonode-retry.mjs
exec npm start -- --userDir /data
