#!/bin/sh
# Run as the host's user so a bind-mounted /data is not left root-owned.
#
# Unraid's convention is PUID=99 (nobody) / PGID=100 (users); that is the default here, so a
# Compose Manager stack produces appdata files the rest of the array can read. Any other Linux
# host should set PUID/PGID to its own ids.
#
# Started as root: fix ownership, then drop privileges for good (no supervisor, no second process).
# Started as a non-root user (e.g. `--user 1000`): run as-is — the caller already owns the volume,
# and `chown` would fail anyway.
#
# /usr/bin/setpriv ships with util-linux, which the node:*-slim base image already has; no gosu,
# no extra packages, nothing to keep patched.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
umask "${UMASK:-002}"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-99}"
  PGID="${PGID:-100}"
  mkdir -p "$DATA_DIR"
  # A failure here must not stop the app: a read-only mount or an id that cannot be chowned is
  # the operator's problem to see in the logs, not a reason to leave the container restart-looping.
  chown -R "${PUID}:${PGID}" "$DATA_DIR" 2>/dev/null || true
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi

exec "$@"
