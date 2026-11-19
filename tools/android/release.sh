#!/usr/bin/env bash
# Builds the signed release APK at the version of a GitHub release that the windows workflow makes, and attaches it to that release, where Obtainium finds it. build and attach do one of the two, so the APK can build while the workflow still runs.
set -euo pipefail
case ${1:-} in
	build | attach) step=$1 && shift ;;
	*) step=both ;;
esac
version=${1:?usage: tools/android/release.sh [build|attach] <version, such as 0.3.18>}
root=$(cd "$(dirname "$0")/../.." && pwd)
repo=manuelschurr/orfoni
outputs=$root/app/src-tauri/gen/android/app/build/outputs/apk/universal/release
apk=$outputs/orfoni_${version}_android-arm64.apk

build() {
	local signing=$HOME/.config/orfoni/android/signing.properties
	[ -f "$signing" ] || { echo "no release key; run tools/android/release-key.sh once" >&2; exit 1; }
	export ANDROID_HOME=${ANDROID_HOME:-/opt/android-sdk}
	export NDK_HOME=${NDK_HOME:-$ANDROID_HOME/ndk/30.0.16248370}
	export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}
	export PATH="$HOME/.cargo/bin:$ANDROID_HOME/platform-tools:$PATH"
	export ORFONI_ANDROID_SIGNING=$signing
	(cd "$root/app" && npx tauri android build --apk --target aarch64 --config "{\"version\":\"$version\"}")
	"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify "$outputs/app-universal-release.apk"
	cp "$outputs/app-universal-release.apk" "$apk"
	echo "built $apk"
}

attach() {
	[ -f "$apk" ] || { echo "no APK for $version; run tools/android/release.sh build $version first" >&2; exit 1; }
	gh release upload "v$version" "$apk" --repo "$repo" --clobber
	echo "attached $(basename "$apk") to v$version"
}

case $step in
	build) build ;;
	attach) attach ;;
	both)
		gh release view "v$version" --repo "$repo" > /dev/null
		build
		attach
		;;
esac
