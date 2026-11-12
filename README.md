# orfoni

orfoni lets you run and follow Claude Code sessions on a remote machine from Windows or Android. Each session runs as an ordinary interactive `claude` in its own tmux session on the server. orfoni shows it as a chat and as a terminal at the same time, lets you answer Claude's approvals and questions from either one, and keeps every session running when no client is connected.

Status: milestone 4 of 4 under way. The server side, `orfoni-hub`, the Windows app and a first Android app work, and a command-line client covers the basics. The design is in [docs/design.md](docs/design.md).

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

Run `orfoni` without arguments for every command. A session argument accepts any unique prefix of the session ID. `orfoni stop` ends a session's Claude Code and keeps the session, so a later message resumes it. `orfoni rm` stops it and removes it from the hub. `orfoni plan` shows the plan's limits and what the hub does about them, which the Windows section below describes, and `orfoni plan start-window 05:30` and `orfoni plan continue off` change it.

To open a session's terminal on the server, run `tmux -L orfoni attach -t =orfoni-<session>`. The `=` makes tmux match the name exactly, so it never attaches to one of the session's shells instead.

## Windows

Each release on the repository's Releases page carries the Windows installer, `orfoni_<version>_x64-setup.exe`, which the `windows` GitHub Actions workflow builds. The installer is not signed, so Windows SmartScreen warns about it, and More info, then Run anyway, installs it. The app needs Microsoft Edge WebView2, which Windows 10 and 11 normally have already.

From 0.3.19 on, orfoni updates itself. When a newer release is out, the session list shows Update to <version> under the orfoni name. A click downloads it, checks that it carries the release key's signature, installs it without further questions, and starts orfoni again. orfoni looks for one when it starts, each time it connects to the hub, and as soon as the hub says a release is out, which `tools/release.sh` tells the hub with `orfoni announce-release` once the release is published. Versions up to 0.3.21 look every six hours instead. Earlier versions have no updater, so 0.3.19 is installed by hand once.

On the first start the app asks for the connection settings:

- Host and port of the server, port 22 unless your SSH server listens elsewhere.
- User, `root` unless you log in as someone else.
- Private key file, `~/.ssh/id_ed25519` by default, which means `C:\Users\<you>\.ssh\id_ed25519`. Browse picks another file.
- Hub command, `"$HOME/.local/bin/orfoni-hub" connect` by default, which matches the install script above.

The key must be an OpenSSH private key file, the kind `ssh-keygen` writes. A PuTTY `.ppk` key does not work. PuTTYgen converts one with Conversions, then Export OpenSSH key. When the key has a passphrase, the app asks for it on each start and keeps it in memory only.

The first connection to a server shows the SHA-256 fingerprint of the server's host key and asks whether to trust it. The fingerprint identifies the server, so compare it with what the server itself reports, for example with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server, before you trust it. The app stores the fingerprint in `known-hosts.json` in its data folder, `%APPDATA%\com.orfoni.app`, and refuses the connection if the server ever shows a different key, because that happens when the server was reinstalled and also when someone intercepts the connection. If you know why the key changed, remove the server's entry from that file and connect again.

The settings button at the bottom of the session list opens the settings again. Saving them reconnects.

Each session in the list shows its summary under the title, its task progress such as `3/7`, and its memory once that passes 1 GB or a process in it was killed for using too much. The time next to the title says how long ago a message last passed between you and Claude: one you sent, a reply, a request, or the end of a turn. The hub stores it with the session, so a restart of the hub leaves it as it was. A bold title marks an answer you have not opened yet. Opening a session, from the list, a notification or the new session dialog, puts the cursor in its message box, so you can start typing at once. What you type in a session's message box stays there until you send or delete it, while you open other sessions and after orfoni closes. Images and PDFs you attached stay too, until orfoni closes. The open session's header shows where it stands, a task bar, its memory against the session's limit, and how full its context window is. Past 80% the context gauge says that Claude Code compacts the conversation soon, and a Compact button sends `/compact` while the session takes input. The bar at the bottom of the list shows the server's free memory, whether summaries are on, with today's spend, and how much of your plan's 5-hour and weekly limits you have used, with when each resets. Context and plan use come from Claude Code's status line, which reports them once Claude has answered.

Plan limits in that bar opens the two things orfoni does about the limits by itself. The hub does both on the server, so neither needs an app to be open.

Start the 5-hour window early takes a start time, which is a time of day in the server's time zone. A 5-hour window starts with your first message after the one before has ended, so a day that starts at 08:40 has its first reset at 13:40. From the start time on, the hub has a short exchange with Haiku as soon as no window is running, so the window is under way, and its reset nearer, when you start. A window still running at the start time is waited out, and the hub starts one a minute after it resets. Five hours after the start time the day's start is over, since any window running at the start time has ended by then. The exchange goes through Claude Code on the login your sessions use, outside every session, so it shows in no list and sends no notification, and it uses under 2,000 tokens. The dialog shows the next start and how the last one went, and a start that failed shows why in the bar. It is off until you give it a time, in the dialog or with `orfoni plan start-window 05:30`.

Continue sessions after a limit sends the message continue to a session whose turn ran into a plan limit, a minute after that limit resets, one session after the other. It is on unless you turn it off. Until the continue the session reads Limit reached, its header says when the limit resets and when orfoni sends continue, and its row in the list shows that time. A message from you takes the continue away, and so does Stop, which is how to keep one session from going on by itself. A continue the limit refuses again is sent again five minutes later, and after three in a row the hub says so in the chat and sends no more until you write. A hub restart before the reset still sends the continue. The hub reads the reset time from the entry Claude Code writes into its transcript for the failed turn, which is internal to Claude Code, so a Claude Code update can leave the hub unable to tell when a limit resets, and it then sends nothing. Sessions outside orfoni get no continue, because orfoni does not type into them.

A turn the API drops, such as one that ends on API Error: Connection lost mid-response, gets a continue too, half a minute later. Until then the session reads API error and shows when orfoni sends continue, and the app tells you nothing about it. A continue that fails the same way is sent again two minutes later, then ten, and after three in a row the hub says so in the chat, the app tells you the session failed, and orfoni sends no more until you write. A message from you or Stop takes the continue away, as after a limit. Errors that a continue cannot get past, such as a failed login, a billing problem or a message the safeguards flagged, get none.

A click on the free memory in that bar opens the Memory screen, which shows the server's free RAM and swap and then every session that holds memory, the largest first by RAM and swap together, with how long ago a message last passed in it. A session's figures include the shells opened from it, and a session outside orfoni shows too when it runs in a tmux pane of its own, because the hub reads each figure from the pane's memory-capped scope and a session started straight from an SSH login shares its scope with the whole login. Stop ends a session's Claude Code and its shells, and keeps the session, so a message there starts it again. The screen leaves Stop to the session's own header while Claude works there or waits on you, so that a stray click in the list cannot end a turn. The figures refresh every 5 seconds while the screen is open. The window title reads `orfoni (n)`, where n counts the sessions that wait on you or have an answer you have not opened.

While the orfoni window is in the background, a session that needs your approval or an answer, has answered, or stopped with an error shows a Windows notification with its title and folder. A click on the notification, while it is on screen, opens that session and brings the window to the front. A session that cannot go on without you also makes orfoni's taskbar button flash until you switch to the window. A turn that a background command, a subagent or a monitor started gives no notification when it ends and leaves the session read or unread as it was, because Claude Code's own way to tell you about something is its PushNotification tool: what Claude sends with it shows as the notification instead and flashes the taskbar button. Windows' own notification settings turn the notifications off for orfoni like for any other app.

Claude Code tells Claude about a finished background command or a monitor's event in a message of its own. The chat shows each as a quiet line with what happened, such as the monitor's event, rather than as a message from you. A background subagent's report, and a message another Claude session sends, reach Claude the same way. The chat folds each into a quiet line like a run of tool calls, with an arrow for a message coming in and the task Claude gave the subagent or the other session's name, and a click opens the message as Claude reads it.

While a session works, its chat shows a timer with what Claude Code's own status line says, such as the step it is on or a request waiting for a retry. Claude Code's task list shows in a sidebar on the right of the session while Claude has one, and the sidebar collapses to a strip that keeps the count of done tasks. The hub reads the status line from the session's tmux screen once a second while a client views a working session, and the task list from Claude Code's task files in `~/.claude/tasks/`. Both are internal to Claude Code, like the session registry below, so a Claude Code update can hide them without breaking anything else. Typing `/` in the message box suggests the session's slash commands, skills included. To list them, the hub runs Claude Code for a few seconds in the session's folder through the Agent SDK, which loads that folder's settings and MCP servers, so it lists only folders Claude Code already trusts, and it keeps the list for 10 minutes. The suggestions leave out `/model`, `/effort` and `/fast`, because typed into a session they also change the defaults of every new session. The header changes the model and effort of one session instead.

An approval shows in the chat with Allow, Always allow and Deny. Claude Code takes a few approvals only in its terminal, such as deleting an artifact: it ignores an allow from the hub for them and keeps asking there. Their dialog opens on No, so that one stray keystroke cannot approve them, and the hub reads that off the session's screen when the approval comes up. For those the chat shows no buttons to answer, only one that opens the session's terminal, where you choose Yes or No. `orfoni allow` refuses them too.

Permissions in the header switches a session between Auto, Manual, Accept edits and Plan. Manual is Claude Code's default mode, which asks before Claude edits a file or runs a command that is not read-only. Like a change of model or effort, a change of mode restarts that session's Claude Code in the new mode and continues the conversation, once Claude has finished the turn.

To send images with a message, paste them into the message box, drop them onto it, or pick them with the paperclip. A message takes up to 5 PNG, JPEG, GIF or WebP images of at most 10 MB each. The app sends them to the hub over the same SSH connection, and the hub saves them in `~/.local/state/orfoni/uploads`, readable only by you, and pastes each path into Claude Code, which attaches the image the way it does a path pasted into its terminal. The chat then shows each image as `[Image #1]`, as Claude Code does. A large image can take Claude Code several seconds to attach, so such a message takes a moment to send. Claude Code keeps each image in its transcript, so the hub removes uploads after a day.

PDFs go the same way, up to 5 in a message of at most 20 MB each, the most Claude Code's Read tool takes. The hub saves each one under its own name in a folder of its own in uploads, with spaces and other characters an @ mention cannot hold turned into `_`, and types an @ mention of it ahead of your text, as you would in Claude Code's terminal. Claude then reads the PDF with its Read tool. Read asks first for a file outside the session's folder, so the settings file each session starts with allows reads in uploads, and a PDF needs no approval in Manual mode either. The chat shows each PDF by its name. What Claude has read stays in the transcript, and a long PDF that Claude reads a few pages at a time stays readable until the hub removes it after a day.

Files Claude sends you with Claude Code's SendUserFile tool show in the chat as a card with Claude's caption and a row for each file with its name and size. An image Claude asked to show, rather than only attach, shows on the card above its name when it is at most 4 MB, and a click on the image opens the file. A click on a row saves the file to your Downloads folder and opens it in its default app, and the row shows how much has arrived and then where the file went. A name already taken there gets a number, as in `report (1).pdf`, unless the file under that name holds the same bytes, as it does after a second click on the same row, and then orfoni opens that file instead of saving it again. A program, such as an `.exe`, `.msi`, `.bat`, `.ps1` or `.lnk` file, is saved and shown in its folder, because orfoni does not run programs. Every file orfoni saves carries the mark Windows gives a browser's downloads, so Office opens it in Protected View and SmartScreen checks a program before it runs. orfoni opens files of up to 100 MB.

The hub keeps a copy of each file when Claude sends it, so the card opens the file as it was sent, after Claude has changed or deleted it and after the hub restarts. The copies together take at most 1 GiB in `~/.local/state/orfoni/sent`, readable only by you, and past that the hub drops the oldest first. Removing a session keeps its copies, because a fork of it shows the same cards. A file sent before the hub began keeping copies, while the hub was down, or from a session outside orfoni has no copy. Its row says so and opens the file as it is on the server now, or says that the file is gone. A row also says when a file is over 100 MB, which the hub does not keep, and why an open failed, such as the file changing while it downloaded or the connection dropping, and a click tries again.

The cards rest on SendUserFile, which Claude Code offers only while the session is connected to Remote Control, for example with `remoteControlAtStartup` on in Claude Code's settings. A session without Remote Control has no way to send you files. What Claude Code reports about each file it sends is internal to Claude Code, so after a Claude Code update a send can show only as Sent files among the session's tool calls, until a new hub reads the new format.

Files in the session's header opens the folder the session started in, beside the conversation where the task list goes, and the task list comes back when the files close. The window remembers whether the files were open. It lists one folder at a time, folders first and then files, each in natural order so that `a2` comes before `a10`, with names that start with a dot among them. A click on a folder opens it, the path above the list leads back up, and a click on a file opens it as a click on a sent file does. A folder of more than 1000 entries shows the first 1000 and says how many more it holds. A link that leads out of the session's folder takes no click. A session outside orfoni has Files in its header too, for as long as it runs.

Fork in the header takes a conversation in a second direction from where it stands. It asks for the fork's first message, then starts a second session in the same folder that carries the whole conversation so far, on the same model, effort and permission mode, and is titled after that message with ⑂. The first session stays as it is, so you can go on in both at once. They share the folder, so two forks that both change files can get in each other's way. A session forks once Claude has finished the turn. Claude Code's own `/fork` makes a background session in a separate git worktree instead, which orfoni lists read-only under that worktree's folder.

The pencil next to a session's title, or a double click on the title, renames the session. orfoni also gives the name to Claude Code, which shows it on claude.ai and in `claude --resume`: at once while the session takes input, in the middle of a turn too, after you have answered when Claude is asking you something, and when it starts again if it is not running.

Each folder in the session list shows the sessions a message passed in during the last 48 hours. The rest fold into one line below them, such as 11 older sessions, 2 still running, which opens them in place. The ones still running hold memory, which the Memory screen frees. A session that is working, waits on you, has an unread reply or failed stays in view however old it is, and so does the one you have open. A folder with nothing recent shows only its name and that line. Each device remembers which folders you opened.

Sessions you started outside orfoni, in Tabby's tmux, from Termius, or as a background session, show under their folder below orfoni's own, in a quieter style with where they run. orfoni finds them in Claude Code's session registry in `~/.claude/sessions/`, an internal Claude Code file, so a Claude Code update can empty that list without breaking anything else. Opening one shows its chat read-only. Port into orfoni ends Claude Code where it runs and continues the conversation as an orfoni session with everything an orfoni session has. It refuses a session that is busy or has moved on to another conversation, and anything typed there but not sent is lost.

The clock next to a folder's name in the session list opens the folder's earlier conversations, the ones `claude --resume` offers there, and Continue an earlier conversation in this folder in the new session dialog opens them for any folder. orfoni lists the newest 200 with each one's title, when it last changed and its first message, and the search box narrows them to the ones that hold every word you type. Continue session starts an orfoni session in the folder that goes on with the conversation, titled after it, on the model, effort and permissions you pick. The list leaves out a conversation that an orfoni session holds, which you open from the session list, and one that runs outside orfoni right now, which Port into orfoni takes over. orfoni reads the conversations from Claude Code's history in `~/.claude/projects/` through the Agent SDK.

## Android

From 0.3.18 on, releases also carry an Android APK, `orfoni_<version>_android-arm64.apk`, for phones with a 64-bit ARM processor, which nearly every phone of the last years has. To get new versions without downloading each one, install [Obtainium](https://github.com/ImranR98/Obtainium) and add `https://github.com/manuelschurr/orfoni` to it. Obtainium watches the releases and installs each new APK, in the background on Android 12 and later, after Android asked once whether it may install apps. Every release is signed with the same key, which is what lets a new version install over the old one.

On the first start the app asks for the connection settings as the Windows app does, with one difference: a phone has no `~/.ssh`, so orfoni keeps a key of its own in its private storage. Make a key on this phone creates one that never leaves the phone and shows its public key with a Copy button. Add that line to `~/.ssh/authorized_keys` of the user you log in as on the server, then save and connect. Import a key file takes an OpenSSH private key you already have instead, one with a passphrase too. The host key question works as on Windows.

On a phone orfoni shows one screen at a time, the session list or a session with its header, chat and message box. Android's back gesture goes back to the list, and from there leaves the app. More in the session's header holds the terminal, the shells, Files, Fork, Stop and Remove, the memory and context gauges, and the model, effort and permissions. On the phone's keyboard Enter adds a line, in the message box and in a fork's first message, and Send or Fork sends. A session opens without bringing up the keyboard, which a tap on the message box does, and so does the terminal, where a tap on the terminal brings it up, and a row of keys under it adds what a phone keyboard lacks: Ctrl for the next key typed, so that Ctrl and then c sends Ctrl+C, Esc, Tab, Shift+Tab and the four arrows. Some keyboards, SwiftKey among them, capitalize the first letter typed after the terminal opens; Shift turns it back.

A card of files Claude sent works on the phone as on Windows, with the hub's copy and the same limits. A tap on a row saves the file to Download/orfoni, where the Files app shows it, and opens it in the app Android picks for its type, or says that no app on the phone opens that kind of file. On Android 10 and later a file there stays after orfoni is uninstalled. On Android 7 to 9 the file goes to orfoni's own folder, `Android/data/com.orfoni.app/files/Download`, which Android removes with the app. Each tap saves the file again, as `report (1).pdf` when the name is taken. Files under More opens the session's folder as a sheet from the bottom of the screen, and Android's back gesture closes it.

Once connected, orfoni stays connected while it is in the background, so a session that needs your approval or an answer, has answered, or stopped with an error shows an Android notification, as on Windows. Each session has one notification, which its next notice replaces, and a tap on it opens orfoni on that session. Android shows a notification of its own, orfoni is connected, for as long as that lasts. On the first connection orfoni asks to be let off Android's battery limits. Doze, Android's sleep, does not cut the connection either way, but some phone makers' battery managers stop background apps that are not let off. Stay connected in the background in the settings turns this off, and then notifications arrive only while orfoni is open. Keeping the connection open uses some battery.

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

The Android build needs the Android SDK, NDK r30 and Rust's Android targets, found through `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME` (JDK 21). `tools/android/install.sh` builds a debug APK for arm64 and installs it on the phone adb is connected to, or on `$ANDROID_SERIAL`. The device checks drive that build on the phone through its WebView. `tools/android/test-server.sh` gives the phone a throwaway sshd on the server, with its own keys, through `adb reverse`, so the checks log in without touching the server's own sshd:

```sh
tools/android/install.sh
npx playwright test -c app/e2e-android
```

Releases are signed with one key. Make it once with `tools/android/release-key.sh` and back up `~/.config/orfoni/android` outside the server, since Android installs an update only when its signature matches. After the windows workflow published a release, `tools/android/release.sh <version>` builds the signed APK at that version and attaches it to the release. `tools/release.sh` does both in one go: it starts the windows workflow, waits for its release, and attaches the APK.

The Windows app installs only updates signed with the updater key. `npx tauri signer generate` made it once, without a passphrase, in `~/.config/orfoni/updater`. Its public half sits in `tauri.conf.json` and the private key in the repository secret `TAURI_SIGNING_PRIVATE_KEY`, and the workflow fails without it. Back it up with the Android key: without it, installed apps can no longer update, and a build with a new key has to be installed by hand. The workflow signs the installer and writes `latest.json` next to it, and `tools/check-update.mjs` checks the signature against the public key before the release goes out. Run without arguments, it checks the live release.

## License

MIT, see [LICENSE](LICENSE).
