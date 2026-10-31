#!/usr/bin/env bash
# Builds the debug APK for arm64 on this server, installs it on the phone adb is connected to (or $ANDROID_SERIAL), and starts it.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
export ANDROID_HOME=${ANDROID_HOME:-/opt/android-sdk}
export NDK_HOME=${NDK_HOME:-$ANDROID_HOME/ndk/30.0.16248370}
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}
export PATH="$HOME/.cargo/bin:$ANDROID_HOME/platform-tools:$PATH"

if [ "${1:-}" != "--no-build" ]; then
	(cd "$root/app" && npx tauri android build --debug --target aarch64 --apk)
fi
adb install -r "$root/app/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
adb shell am start -n com.orfoni.app.debug/com.orfoni.app.MainActivity > /dev/null
