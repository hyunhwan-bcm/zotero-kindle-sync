#!/usr/bin/env bash
# Package plugin/ into build/zotero-kindle-sync-<version>.xpi (a zip with manifest.json at the root).
set -euo pipefail
cd "$(dirname "$0")/../plugin"
ver=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
mkdir -p build
out="build/zotero-kindle-sync-${ver}.xpi"
rm -f "$out"
zip -qr "$out" manifest.json bootstrap.js prefs.js icon.svg src prefs -x '*.DS_Store'
echo "$out"
