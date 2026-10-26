#!/bin/sh
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"

npm ci --no-audit --no-fund
npm run build

mkdir -p "$HOME/.local/bin" "$HOME/.config/orfoni" "$HOME/.config/systemd/user"
chmod +x hub/bin/orfoni-hub.js cli/bin/orfoni.js
ln -sfn "$repo/hub/bin/orfoni-hub.js" "$HOME/.local/bin/orfoni-hub"
ln -sfn "$repo/cli/bin/orfoni.js" "$HOME/.local/bin/orfoni"
cp hub/tmux.conf "$HOME/.config/orfoni/tmux.conf"
cp hub/systemd/orfoni-tmux.service hub/systemd/orfoni-hub.service "$HOME/.config/systemd/user/"

systemctl --user daemon-reload
systemctl --user enable orfoni-tmux.service orfoni-hub.service
# Restarting the tmux server would end every session, so it is only ever started.
systemctl --user start orfoni-tmux.service
systemctl --user restart orfoni-hub.service
