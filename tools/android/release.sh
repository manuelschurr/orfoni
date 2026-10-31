#!/usr/bin/env bash
# Builds the signed release APK at the version of a GitHub release that the windows workflow made, and attaches it to that release, where Obtainium finds it.
set -euo pipefail

version=${1:?usage: tools/android/release.sh <version, such as 0.3.18>}
root=$(cd "$(dirname "$0")/../.." && pwd)
signing=$HOME/.config/orfoni/android/signing.properties
[ -f "$signing" ] || { echo "no release key; run tools/android/release-key.sh once" >&2; exit 1; }
gh release view "v$version" --repo manuelschurr/orfoni > /dev/null

export ANDROID_HOME=${ANDROID_HOME:-/opt/android-sdk}
export NDK_HOME=${NDK_HOME:-$ANDROID_HOME/ndk/30.0.16248370}
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}
export PATH="$HOME/.cargo/bin:$ANDROID_HOME/platform-tools:$PATH"
export ORFONI_ANDROID_SIGNING=$signing

(cd "$root/app" && npx tauri android build --apk --target aarch64 --config "{\"version\":\"$version\"}")
apk="$root/app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$apk"
out=$(mktemp -d)/orfoni_${version}_android-arm64.apk
cp "$apk" "$out"
gh release upload "v$version" "$out" --repo manuelschurr/orfoni --clobber
echo "attached $(basename "$out") to v$version"
