# orfoni

orfoni lets you run and follow Claude Code sessions on a remote machine from Windows or Android. Each session runs as an ordinary interactive `claude` in its own tmux session on the server. orfoni shows it as a chat and as a terminal at the same time, lets you answer Claude's approvals and questions from either one, and keeps every session running when no client is connected.

Status: milestone 2 of 4. The server side, `orfoni-hub`, works with a command-line client, and the Windows app is in progress. The Android app comes later. The design is in [docs/design.md](docs/design.md).

## How it works

`orfoni-hub` runs on the server as a systemd user service. It starts each session in tmux with a settings file that points Claude Code's hooks at the hub, turns the hook events into session states and chat items, and types your messages into the session. Clients reach it through `orfoni-hub connect`, which works over SSH, so your SSH key is the only login.

A second user service, `orfoni-tmux`, runs the tmux server. Restarting the hub never touches the sessions, and every session gets the memory limits that apply to tmux panes on the machine.

## Install on the server

You need Node 22, tmux 3.4 or later, systemd, curl, and a logged-in Claude Code.

```sh
git clone https://github.com/manuelschurr/orfoni.git
cd orfoni
hub/scripts/install.sh
```

The script builds the code, links `orfoni-hub` and `orfoni` into `~/.local/bin`, installs both user services, and starts them. Run it again after pulling changes. It restarts the hub but never the tmux server, because restarting the tmux server ends every session.

## Use the command-line client

On the server:

```sh
orfoni start ~/code/my-project "Fix the failing test"
orfoni list
orfoni watch <session>
orfoni allow <request>
```

From another machine, pass the SSH command:

```sh
orfoni --via 'ssh my-server "\$HOME/.local/bin/orfoni-hub" connect' list
```

The command needs the full path because ssh runs it in a non-interactive shell, which does not have `~/.local/bin` on its `PATH`. The backslash keeps `$HOME` from being expanded on your machine, since orfoni runs the `--via` command through `sh`, so the server's shell expands it to the server's home.

Run `orfoni` without arguments for every command. A session argument accepts any unique prefix of the session ID. `orfoni stop` ends a session's Claude Code and keeps the session, so a later message resumes it. `orfoni rm` stops it and removes it from the hub.

To open a session's terminal on the server, run `tmux -L orfoni attach -t =orfoni-<session>`. The `=` makes tmux match the name exactly, so it never attaches to one of the session's shells instead.

## Windows

The Windows installer comes from the `windows` GitHub Actions workflow. Open the repository's Actions tab, pick the latest successful `windows` run (or start one with Run workflow), and download the `orfoni-windows-installer` artifact. It is a zip that holds the NSIS setup file. The installer is not signed, so Windows SmartScreen warns about it, and More info, then Run anyway, installs it. The app needs Microsoft Edge WebView2, which Windows 10 and 11 normally have already.

On the first start the app asks for the connection settings:

- Host and port of the server, port 22 unless your SSH server listens elsewhere.
- User, `root` unless you log in as someone else.
- Private key file, `~/.ssh/id_ed25519` by default, which means `C:\Users\<you>\.ssh\id_ed25519`. Browse picks another file.
- Hub command, `"$HOME/.local/bin/orfoni-hub" connect` by default, which matches the install script above.

The key must be an OpenSSH private key file, the kind `ssh-keygen` writes. A PuTTY `.ppk` key does not work. PuTTYgen converts one with Conversions, then Export OpenSSH key. When the key has a passphrase, the app asks for it on each start and keeps it in memory only.

The first connection to a server shows the SHA-256 fingerprint of the server's host key and asks whether to trust it. The fingerprint identifies the server, so compare it with what the server itself reports, for example with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server, before you trust it. The app stores the fingerprint in `known-hosts.json` in its data folder, `%APPDATA%\com.orfoni.app`, and refuses the connection if the server ever shows a different key, because that happens when the server was reinstalled and also when someone intercepts the connection. If you know why the key changed, remove the server's entry from that file and connect again.

The settings button at the bottom of the session list opens the settings again. Saving them reconnects.

## Develop

```sh
npm install
npm test
npm run build
npm run test:e2e
```

`npm run test:e2e` drives the installed hub with real Claude Code sessions on the `haiku` model, so it needs the services running and uses a little of your Claude usage.
