#!/usr/bin/env bash
# A throwaway SSH server for the app on the test phone: it listens on the server's loopback only, with its own host key, test key and authorized_keys, and adb reverse makes it the phone's 127.0.0.1:2422. The system sshd and ~/.ssh stay untouched.
set -euo pipefail

dir=/var/tmp/claude-0/orfoni-android-sshd
port=2422
adb=${ADB:-/opt/android-sdk/platform-tools/adb}

mkdir -p -m 700 "$dir"
[ -f "$dir/host_key" ] || ssh-keygen -q -t ed25519 -N '' -C orfoni-android-host -f "$dir/host_key"
[ -f "$dir/client_key" ] || ssh-keygen -q -t ed25519 -N '' -C orfoni-android-test -f "$dir/client_key"
install -m 600 "$dir/client_key.pub" "$dir/authorized_keys"
cat > "$dir/sshd_config" <<CONFIG
Port $port
ListenAddress 127.0.0.1
HostKey $dir/host_key
AuthorizedKeysFile $dir/authorized_keys
PidFile $dir/sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
UsePAM yes
StrictModes no
CONFIG

if ! { [ -f "$dir/sshd.pid" ] && kill -0 "$(cat "$dir/sshd.pid")" 2>/dev/null; }; then
	/usr/sbin/sshd -f "$dir/sshd_config" -E "$dir/sshd.log"
fi
"$adb" reverse "tcp:$port" "tcp:$port" > /dev/null
echo "sshd on 127.0.0.1:$port, reachable from the phone at 127.0.0.1:$port"
echo "test key: $dir/client_key"
echo "host key: $(ssh-keygen -lf "$dir/host_key.pub" -E sha256 | awk '{print $2}')"
