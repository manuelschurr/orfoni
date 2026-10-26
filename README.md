# orfoni

orfoni lets you run and follow Claude Code sessions on a remote machine from Windows or Android. Each session runs as an ordinary interactive `claude` in its own tmux session on the server. orfoni shows it as a chat and as a terminal at the same time, lets you answer Claude's approvals and questions from either one, and keeps every session running when no client is connected.

Status: milestone 1 of 4. The server side, `orfoni-hub`, works with a command-line client. The Windows and Android app comes next. The design is in [docs/design.md](docs/design.md).

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

## Develop

```sh
npm install
npm test
npm run build
npm run test:e2e
```

`npm run test:e2e` drives the installed hub with real Claude Code sessions on the `haiku` model, so it needs the services running and uses a little of your Claude usage.
