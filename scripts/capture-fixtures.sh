#!/usr/bin/env bash
# Re-capture a page into the fixture set. Politeness is the point: 2 s between requests.
# Usage: ./scripts/capture-fixtures.sh packages/shared/test/fixtures <topic-url>...
set -euo pipefail
OUT="${1:?usage: capture-fixtures.sh <outdir> <url>...}"; shift
mkdir -p "$OUT"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
for url in "$@"; do
  name=$(printf '%s' "$url" | sed -E 's#.*topic/([0-9]+)-.*#\1#')
  printf '→ %s  %s\n' "$name" "$url"
  curl -sSL --compressed -m 30 -A "$UA" "$url" -o "$OUT/$name.html"
  sleep 2
done
printf 'captured %s file(s) in %s\n' "$(ls -1 "$OUT"/*.html | wc -l)" "$OUT"
