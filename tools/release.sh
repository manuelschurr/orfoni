#!/usr/bin/env bash
# Publishes a release: the windows workflow builds the Windows installer and makes the GitHub release v<major>.<minor>.<run number>, then the Android APK built on this server is attached to it.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
repo=manuelschurr/orfoni
base=$(node -p "require('$root/app/src-tauri/tauri.conf.json').version.split('.').slice(0, 2).join('.')")
before=$(gh run list --repo "$repo" --workflow windows --limit 1 --json databaseId --jq '.[0].databaseId // 0')
gh workflow run windows --repo "$repo" --ref main
for _ in $(seq 1 30); do
	run=$(gh run list --repo "$repo" --workflow windows --limit 1 --json databaseId,number --jq '.[0]')
	[ "$(jq -r .databaseId <<< "$run")" != "$before" ] && break
	sleep 2
done
id=$(jq -r .databaseId <<< "$run")
version="$base.$(jq -r .number <<< "$run")"
echo "windows run $id builds v$version"
gh run watch "$id" --repo "$repo" --exit-status --interval 30 > /dev/null
"$root/tools/android/release.sh" "$version"
echo "released v$version: https://github.com/$repo/releases/tag/v$version"
