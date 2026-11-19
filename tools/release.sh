#!/usr/bin/env bash
# Publishes a release: the windows workflow builds the Windows installer and makes the GitHub release v<major>.<minor>.<run number>, while this server builds the Android APK at that version, which goes on the release once it exists. A run ID continues a release whose windows run is already under way, as after this script was stopped.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
repo=manuelschurr/orfoni
base=$(node -p "require('$root/app/src-tauri/tauri.conf.json').version.split('.').slice(0, 2).join('.')")
if [ $# -gt 0 ]; then
	run=$(gh run view "$1" --repo "$repo" --json databaseId,number)
else
	before=$(gh run list --repo "$repo" --workflow windows --limit 1 --json databaseId --jq '.[0].databaseId // 0')
	gh workflow run windows --repo "$repo" --ref main
	for _ in $(seq 1 30); do
		run=$(gh run list --repo "$repo" --workflow windows --limit 1 --json databaseId,number --jq '.[0]')
		[ "$(jq -r .databaseId <<< "$run")" != "$before" ] && break
		sleep 2
	done
	[ "$(jq -r .databaseId <<< "$run")" != "$before" ] || { echo "the windows run did not show up within a minute" >&2; exit 1; }
fi
id=$(jq -r .databaseId <<< "$run")
version="$base.$(jq -r .number <<< "$run")"
echo "windows run $id builds v$version"
log=$(mktemp --suffix=-apk.log)
echo "the APK builds meanwhile, logging to $log"
"$root/tools/android/release.sh" build "$version" > "$log" 2>&1 &
apk=$!
if ! gh run watch "$id" --repo "$repo" --exit-status --interval 30 > /dev/null; then
	echo "windows run $id failed, so v$version gets no APK; waiting for its build to end" >&2
	wait "$apk" || true
	exit 1
fi
if ! wait "$apk"; then
	tail -n 30 "$log" >&2
	echo "the APK build failed; the whole log is in $log, and tools/android/release.sh $version builds and attaches it again" >&2
	exit 1
fi
"$root/tools/android/release.sh" attach "$version"
echo "released v$version: https://github.com/$repo/releases/tag/v$version"
# The apps connected to the hub look for the update now instead of at their next start. The release is out either way, so a hub that is down only means they find it when they next connect.
node "$root/cli/bin/orfoni.js" --via "$HOME/.local/bin/orfoni-hub connect" announce-release "$version" || echo "the hub was not told about v$version; apps find it when they next connect"
