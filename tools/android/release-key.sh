#!/usr/bin/env bash
# Makes the key that signs orfoni's Android releases, once. Android installs an update only when it carries the same signature as the installed app, so this key must outlive the server: back up the folder it prints.
set -euo pipefail

dir=$HOME/.config/orfoni/android
if [ -f "$dir/release.jks" ]; then
	echo "the release key already exists in $dir"
	exit 0
fi
mkdir -p -m 700 "$dir"
password=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
umask 077
keytool -genkeypair -keystore "$dir/release.jks" -storetype PKCS12 -alias orfoni -keyalg RSA -keysize 4096 -validity 36500 -storepass "$password" -keypass "$password" -dname "CN=orfoni" > /dev/null 2>&1
printf 'storeFile=%s\nkeyAlias=orfoni\npassword=%s\n' "$dir/release.jks" "$password" > "$dir/signing.properties"
echo "made the release key in $dir; back up release.jks and signing.properties outside the server"
keytool -list -keystore "$dir/release.jks" -storepass "$password" -v 2>/dev/null | grep -m1 "SHA256:"
