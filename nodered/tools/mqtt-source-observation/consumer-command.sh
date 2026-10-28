#!/bin/sh
set -eu
umask 077
# Read/write open preserves existing bytes; kernel flock is held across exec.
if [ -L /data/.mqtt-source-observer-consumer ] || [ -L /data/.mqtt-source-observer-consumer/lock ]; then
    printf '%s\n' '{"state":"unknown","collection_error":"consumer_lock_unsafe","full24h_proven":false}'
    exit 1
fi
exec 8<>/data/.mqtt-source-observer-consumer/lock
if ! /usr/bin/flock -n 8; then
    printf '%s\n' '{"state":"busy","collection_error":null,"full24h_proven":false}'
    exit 0
fi
exec /usr/local/bin/node /data/tools/mqtt-source-observation/consumer_cli.mjs "$@"
