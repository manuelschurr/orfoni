# orfoni

orfoni lets you run and follow Claude Code sessions on a remote machine from Windows or Android. Each session runs as an ordinary interactive `claude` in its own tmux session on the server. orfoni shows it as a chat and as a terminal at the same time, lets you answer Claude's approvals and questions from either one, and keeps every session running when no client is connected.

Status: milestone 3 of 4. The server side, `orfoni-hub`, and the Windows app work, and a command-line client covers the basics. The Android app comes later. The design is in [docs/design.md](docs/design.md).

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

Each session gets a one-sentence summary of what it is about and where it stands, written by Claude Haiku 5.5 through the Claude API. To turn summaries on, write an API key to `~/.config/orfoni/anthropic-api-key` and run `chmod 600` on it. The hub reads the key each time it writes a summary, so it needs no restart. Do not put the key in `ANTHROPIC_API_KEY` for the hub or its tmux server, because Claude Code reads that variable too and would bill your sessions to the key instead of your subscription. Without a key everything else works and the summaries stay empty. The bar at the bottom of the app says why summaries are off or failing. The hub stops writing summaries for the day after 1,000 summaries or $2 of estimated spend. `ORFONI_SUMMARY_MODEL` picks another model.

Sessions that orfoni starts keep a task list, which is where the progress you see comes from. Claude Code hides its task tools from current models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set, so the hub sets it for its sessions. Set `ORFONI_TASK_TOOLS=0` in the hub's environment to leave them off.

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

Each session in the list shows its summary under the title, its task progress such as `3/7`, and its memory once that passes 1 GB or a process in it was killed for using too much. A bold title marks an answer you have not opened yet. The open session's header shows where it stands, a task bar, and its memory against the session's limit. The bar at the bottom of the list shows the server's free memory and whether summaries are on, with today's spend. The window title reads `orfoni (n)`, where n counts the sessions that wait on you or have an answer you have not opened.

While a session works, its chat shows a timer with what Claude Code's own status line says, such as the step it is on or a request waiting for a retry. Claude Code's task list shows in a sidebar on the right of the session while Claude has one, and the sidebar collapses to a strip that keeps the count of done tasks. The hub reads the status line from the session's tmux screen once a second while a client views a working session, and the task list from Claude Code's task files in `~/.claude/tasks/`. Both are internal to Claude Code, like the session registry below, so a Claude Code update can hide them without breaking anything else. Typing `/` in the message box suggests the session's slash commands, skills included. To list them, the hub runs Claude Code for a few seconds in the session's folder through the Agent SDK, which loads that folder's settings and MCP servers, so it lists only folders Claude Code already trusts, and it keeps the list for 10 minutes. The suggestions leave out `/model`, `/effort` and `/fast`, because typed into a session they also change the defaults of every new session. The header changes the model and effort of one session instead.

Fork in the header takes a conversation in a second direction from where it stands. It asks for the fork's first message, then starts a second session in the same folder that carries the whole conversation so far, on the same model, effort and permission mode, and is titled after that message with ⑂. The first session stays as it is, so you can go on in both at once. They share the folder, so two forks that both change files can get in each other's way. A session forks once Claude has finished the turn. Claude Code's own `/fork` makes a background session in a separate git worktree instead, which orfoni lists read-only under that worktree's folder.

The pencil next to a session's title, or a double click on the title, renames the session. orfoni also gives the name to Claude Code, which shows it on claude.ai and in `claude --resume`: at once while the session takes input, in the middle of a turn too, after you have answered when Claude is asking you something, and when it starts again if it is not running.

Sessions you started outside orfoni, in Tabby's tmux, from Termius, or as a background session, show under their folder below orfoni's own, in a quieter style with where they run. orfoni finds them in Claude Code's session registry in `~/.claude/sessions/`, an internal Claude Code file, so a Claude Code update can empty that list without breaking anything else. Opening one shows its chat read-only. Port into orfoni ends Claude Code where it runs and continues the conversation as an orfoni session with everything an orfoni session has. It refuses a session that is busy or has moved on to another conversation, and anything typed there but not sent is lost.

## Develop

```sh
npm install
npm test
npm run build
npm run test:e2e
```

`npm run test:e2e` drives the installed hub with real Claude Code sessions on the `haiku` model, so it needs the services running and uses a little of your Claude usage.

The app also runs in a browser on the server, where a development bridge in `tools/dev-bridge` connects it to the hub and to tmux. The Playwright checks drive the app that way. The bridge keeps its own dependencies outside the npm workspaces, and the checks need Playwright's Chromium:

```sh
npm ci --prefix tools/dev-bridge
npx playwright install chromium
npx playwright test -c app/e2e
```

The checks start the bridge and Vite, run real Claude Code sessions on the `haiku` model through the installed hub, and remove the sessions they started.

The bridge listens on 127.0.0.1:4790 and refuses every connection that does not carry its token, because a terminal it opens is a shell on the server. It takes the token from `ORFONI_BRIDGE_TOKEN`, or generates one at start and prints the address to open. The Playwright checks generate a token for each run. To run them against a bridge that is already running, export that bridge's token as `ORFONI_BRIDGE_TOKEN` first. To use the browser build yourself, run `node tools/dev-bridge/bridge.mjs` and `npm run dev -w app`, then open the address the bridge printed.

## License

MIT, see [LICENSE](LICENSE).
