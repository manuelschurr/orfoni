# orfoni design

orfoni is a native app for running and following Claude Code sessions on a remote machine. You open it on Windows or on an Android phone, see every session grouped by project, read each conversation as a chat, answer Claude's approval requests and questions with a tap, run shell commands, open a terminal into any session, and start new sessions. The sessions run on the VPS and keep running when no app is connected.

Status: design, revised 2026-10-26. Nothing is built yet. orfoni v0, a local Windows terminal manager from March 2026, lives at `~/code/orfoni-v0` and shares only the name with this design.

## What v1 must do

These requirements come from Manuel unless marked otherwise.

- Run Claude Code sessions on the VPS. A session keeps running when every client is closed.
- One app for Windows and Android, showing the same state on both.
- Log in with the existing SSH key, the way Tabby does. No new open ports and no web login.
- Show a session list that is always visible on the desktop and is the start screen on the phone, grouped by project folder.
- For each session, show what it is about, how far it has got, and whether it needs you or has an answer.
- Show each conversation in the style of claude.ai: your messages and Claude's replies as chat bubbles, on desktop and phone.
- Let the chat and a terminal show the same session at the same time, the way claude.ai and a tmux pane in Tabby do today.
- Run shell commands from the app, inside the session, without switching to another app.
- Open a terminal into a session, and open a plain shell in the session's folder.
- Write a short AI summary per session through the Claude API, within the $100 monthly API budget.
- Start new sessions on the VPS from the app.
- Keep the memory guardrails: a runaway test kills only itself, never the box or the other sessions.
- Depend on no Claude Code feature that the docs label research preview or alpha.
- Keep sessions running when the hub restarts (inferred).

These are out of scope for v1: notifications, machines other than the VPS, agents other than Claude Code, and integration with `worktree-orchestrator` or its dev servers.

## One process, two views

claude.ai and Tabby can show the same session at once because there is only one `claude` process. It runs in a tmux pane. Tabby shows that process's terminal, and Remote Control mirrors the same process to the website. Neither view starts a second process.

orfoni uses the same model. Every session is an ordinary interactive `claude` process in a tmux pane on the VPS. The terminal is always there, in the app or in Tabby. The chat is a second view of the same process, built from documented hooks. The app sends your chat messages into the same process's input, so whatever you type in the chat lands where typing in the terminal would.

Three designs were considered.

- Drive Claude Code headless through the Agent SDK, with typed messages for the chat. A spike on 2026-10-26 showed that this works, but the chat gets its own `claude` process. A session then cannot be open in the chat and in a terminal at once, shell commands have no home, and a hub restart kills every running turn, because the processes are children of the hub. Rejected.
- Run interactive Claude Code in tmux and build the chat from hooks. One process serves both views, sessions outlive the hub, and the existing per-pane memory caps keep working. Chosen.
- Use Claude Code's own multi-session features. Agent view is labelled research preview. Remote Control connects sessions only to Anthropic's own apps, claude.ai and the Claude app, and its protocol is not public. Rejected. Remote Control keeps working alongside orfoni, because orfoni sessions are ordinary interactive sessions.

## How the pieces fit

```
orfoni app on Windows and Android     Tauri 2 + Svelte 5
    │  one SSH connection, authenticated with your key
    ├─ control channel ──► `orfoni-hub connect`, JSON messages
    └─ terminal channels ─► `tmux attach` into a session, on demand

VPS
    orfoni-hub                         Node + TypeScript, systemd user service
        session states and chat      ◄─ Claude Code hooks, posted to the hub's Unix socket
        your chat messages           ──► the session's input, through tmux
        approvals and questions      ◄─► hook requests held open until someone answers
        history and titles           ◄─ listSessions() and getSessionMessages()
        summaries                    ──► Claude API, Haiku 5.5
        memory per session           ◄─ each pane's cgroup files
    tmux server for orfoni             one process per tmux session, each in its own memory-capped scope
        orfoni-<id>                    a Claude session
        orfoni-<id>-sh<n>              a plain shell opened from that session, in its folder
```

The app stores nothing. All state lives on the VPS, so the desktop and the phone always agree. The hub is the only new server program. It never runs Claude itself. It starts sessions in tmux, listens to their hooks, and types into them.

## What the spikes showed

Three spikes on 2026-10-26 tested the assumptions this design depends on. All numbers are measured.

Interactive session in tmux, with hooks that log every event:

- Text pasted into the session with `tmux paste-buffer -p` and submitted with Enter arrived as one prompt. The `UserPromptSubmit` hook received the exact text. That held for a two-line message. Longer ones behave differently, as the next spike shows.
- When Claude asked to write a file, the permission dialog appeared in the terminal while the `PermissionRequest` hook was still waiting. When the hook answered after 15 s, the dialog closed and the file was written in the same second.
- In a second run, the terminal answered the dialog while the hook was still waiting. The file was written immediately, and the hook's late answer changed nothing. The first answer wins, from either side.
- A pasted `! echo ... > bm.txt` ran as a shell command inside the session. The file appeared, the output showed in the session, and Claude saw it.
- `MessageDisplay` delivered each assistant message's text with a message ID and a `final` flag, and `Stop` delivered the final reply as `last_assistant_message`.

Agent SDK, used only to read sessions:

- `listSessions()` listed the five newest sessions of one project folder in 252 ms and of a second one in 81 ms, including the sessions running in tmux at the time, with the same titles.
- `getSessionMessages()` read a 78 MB session transcript in 677 ms and returned 375 messages, including thinking, text, tool calls, and tool results.

Memory caps:

- tmux already puts every pane into its own systemd scope. All 9 panes running at the time had `MemoryMax=8589934592`, `MemorySwapMax=6442450944`, and `OOMPolicy=continue`.

A third spike, after the final review on 2026-10-26, tested how long messages arrive. It used Claude Code 2.1.310, `claude --model haiku` in a scratch tmux server, and a hook that logged the `UserPromptSubmit` input. The test message had 5 lines and 914 characters, with quotes, backticks, an emoji, Japanese text, and one line that ends in a backslash.

- Pasting the whole message in one bracketed paste collapsed it to `[Pasted text #1 +4 lines]` in the input box, and the hook received `\n\n<pasted_content id="565c">\n` before the text and `\n</pasted_content id="565c">\n` after it. Claude Code does this for a paste of more than 3 lines or more than 800 characters, and tells Claude that pasted content may contain instructions the user did not write.
- Typing each line with `send-keys -l` and a backslash plus Enter between lines did not arrive exactly. One typed backslash stayed in the text, and the first Enter did not submit.
- Typing each line with `send-keys -l` and Ctrl+J between lines arrived exactly in 5 of 5 runs. A message with a 5,100-character line did not. Typed in one piece or in 400-character pieces, part of it arrived wrapped in `<pasted_content>` once the input arrived faster than Claude Code read it.
- Pasting each line in newline-free bracketed pastes of at most 400 characters, with Ctrl+J between lines, arrived exactly in 6 of 6 runs of the 914-character message and 6 of 6 runs of a 5,176-character message. A 66,854-character message with 61 lines arrived exactly in 5 of 6 runs. In the other run one 59-character piece was missing. A pasted `! echo bm-$((6*7))` ran in bash mode and printed `bm-42`, and a pasted `/clear` cleared the conversation.
- Claude Code removes trailing whitespace from every prompt, and keeps leading whitespace.
- Enter after a final backslash inserts a newline instead of submitting, with every input method. A space after the backslash makes Enter submit, and the trim removes the space again.
- A tab is lost when typed, because Tab is a key binding, and turns into four spaces when pasted.
- Escape during a turn ended it without a `Stop` hook. When no reply had appeared yet, Claude Code put the interrupted prompt back into the input box. No `idle_prompt` notification followed within 110 s, while after a normal `Stop` one arrived 60 s later.

## The hub

`orfoni-hub` is one Node program written in TypeScript. TypeScript fits because the app's UI is TypeScript, so both sides share one package of message types, and because the Agent SDK's session readers are TypeScript. It runs as a systemd user service.

The hub has these jobs:

- Start a session by creating a tmux session in the project folder that runs `claude --session-id=<uuid> --name <title>`. Stop a session by ending its tmux session.
- Receive Claude Code's hook events on a Unix socket in the hub's runtime directory, `$XDG_RUNTIME_DIR/orfoni/hooks.sock`. The directory has mode 0700, so no other account on the VPS can post hooks. Each hook is a short `curl --unix-socket` command that posts the event with the orfoni session ID as a header, so the hub knows which session sent it.
- Accept a Claude session ID only as a UUID, from hooks and from the state file, and pass it to `claude` only glued to its option, as `--resume=<id>`. The ID arrives in hook input, so without both rules a forged hook could add options to `claude`'s arguments.
- Turn hook events into session states and chat messages, and forward both to connected apps.
- Send your chat messages into the session as bracketed pastes of at most 400 characters without a newline, with Ctrl+J between lines and Enter at the end, only while the session is waiting for input or working. Claude Code queues a message typed while it works. Pastes that small stay plain text, while one paste of a long message would reach Claude as untrusted pasted content (spike, 2026-10-26).
- Hold `PermissionRequest` hook requests open until an app answers. The hub links each request to the oldest running tool call, from the main conversation or from a subagent, that has the same tool name and the same input and no request yet. If the terminal answers Yes first, the hub sees that call finish and withdraws the card. If the terminal answers No or Escape, Claude Code kills the hook within 0.3 s and ends the turn without `PostToolUse`, `PostToolUseFailure`, or `Stop` (measured 2026-10-26). The hub then sees the held connection close, withdraws the card, and marks the session `idle`. Claude Code 2.1.314 ignores a hook's allow for a few tools, such as deleting an artifact, and tells the hook nothing, so the terminal keeps asking (measured 2026-10-30). Their dialog opens on No without digit shortcuts, which ordinary ones never do. When a request becomes its session's oldest open one, and so the one whose dialog the terminal shows, the hub reads the dialog off the screen and marks an approval whose dialog opens on No as one Claude Code takes only in its terminal. The hub refuses an allow for it and passes on a deny, which Claude Code takes.
- Answer questions from `AskUserQuestion` and plan approvals from `ExitPlanMode` the same way. The hooks docs describe answering both through `updatedInput`.
- Interrupt a turn by sending Escape to the pane, and mark the session `idle`, because Claude Code fires no `Stop` after an interrupt (measured 2026-10-26).
- Read history and titles through the Agent SDK's `listSessions()` and `getSessionMessages()`. Claude's own transcript store is the source of truth for both. These functions read files and start no Claude process.
- Open a plain shell in the session's folder as its own tmux session, tagged with the Claude session it belongs to, and close those shells when the Claude session is stopped.
- Write summaries and track which answers you have not read yet.
- Read memory use and out-of-memory kills for each pane.
- Send continue to a session once the plan limit its turn ran into has reset, and start the day's first 5-hour window at a set time, as Plan limits below describes.
- Keep a copy of each file Claude sends, and give the app the bytes of a sent file or of a file in a session's folder a piece at a time, as Sent files below describes.

The hub stores only what Claude Code and tmux do not: summaries, read state, the list of project folders, the plan settings with the last start of a window, and for a session at a limit when the limit resets. It keeps them in one small file with a version field and writes it atomically, by writing a temporary file and renaming it. That file and the per-session settings files have mode 0600, in directories with mode 0700. The copies of sent files are the one other thing it stores, in `sent/` next to that file, as Sent files below describes.

Sessions do not depend on the hub. If the hub is down, Claude keeps working, because a hook that fails defaults to continuing. When the hub comes back, it rebuilds each session's state from tmux and the transcripts. A session whose tmux session runs comes back `idle` when the last user or assistant message of its transcript is an assistant message with `stop_reason` `end_turn`, and `working` otherwise.

## Hooks

The hub needs these hooks, configured in the user settings so they cover every session on the VPS, including sessions started in Tabby:

| Hook | What the hub learns |
|---|---|
| `SessionStart`, `SessionEnd` | A conversation started or ended in a pane, including after `/clear` |
| `UserPromptSubmit` | Your message, typed in either view |
| `MessageDisplay` | Claude's reply, line by line as it appears |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | Each tool call with its input and result |
| `PermissionRequest` | Claude waits for an approval |
| `TaskCreated`, `TaskCompleted` | Progress through Claude's task list |
| `Stop`, `StopFailure` | The turn ended, with the final reply or the error |
| `Notification` | With `notification_type` `idle_prompt`, that the session has waited 60 s for input, which corrects a session the hub still thinks is working |

`MessageDisplay` holds each batch of text until the hook returns, so the hub answers it immediately and does its work afterwards. Its hook entry gets a short timeout, so a hub that hangs delays the terminal by seconds at most.

The hooks are command hooks that run `curl ... || true`, not Claude Code's `http` hook type. `SessionStart` accepts only command hooks. A failed `http` hook also prints an error line in the terminal on every event while the hub is down, and the curl command fails silently instead (spike, 2026-10-26).

## Session states

Each session has one state, and every event moves it to a defined next state. The app shows the state as the colour of the session's dot and sorts the list by it.

| State | Meaning | Enters on | Leaves on |
|---|---|---|---|
| `offline` | No `claude` process runs in the session's tmux session | `SessionEnd`, the session's tmux session is gone, also when `claude` exits before `SessionStart` | you send a message, which starts `claude --resume=<id>`, or a new conversation when the session never had one |
| `working` | A turn is running | `UserPromptSubmit`, a request answered from the app or with Yes in the terminal | a request, `Stop`, `StopFailure`, an interrupt, an `idle_prompt` notification |
| `needs_approval` | Claude waits for permission to use a tool | `PermissionRequest` | an answer from the app or the terminal |
| `needs_answer` | Claude asked a question or wants a plan approved | `AskUserQuestion` or `ExitPlanMode` | an answer from the app or the terminal |
| `answered` | The turn finished and you have not read the reply | `Stop`, an `idle_prompt` notification while `working` | you open the session |
| `idle` | The turn finished and you have read the reply | you open an `answered` session, the terminal answers a request with No or Escape, an interrupt | `UserPromptSubmit` |
| `failed` | The turn ended with an error | `StopFailure` | `UserPromptSubmit` |

A message to an `offline` session whose transcript holds no conversation starts `claude` with a new `--session-id`. Both alternatives fail there: `claude --resume=<id>` prints "No conversation found" and exits 1, and `claude --session-id=<id>` prints "Session ID ... is already in use" and exits 1, because Claude Code wrote a transcript with only the session's title when it started (measured 2026-10-26).

A row in the session list is a tmux session. Claude's session ID is a property of that row. It changes when you run `/clear`, and the chat then starts empty while the earlier conversation stays in the project's history.

Sessions started outside orfoni, such as panes in an existing multi-pane tmux session in Tabby, still report through the hooks and show up in the list. Each hook also sends `$TMUX`, which names the tmux server, so the hub can follow and answer them where they run. orfoni offers to move such a session into its own tmux session by resuming it there.

## The app

The app is Tauri 2 with a Svelte 5 UI, built for Windows and Android from one codebase. The Rust side opens one SSH connection with `russh`, a pure-Rust SSH library. On that connection it runs `orfoni-hub connect` for the control channel and opens a terminal channel whenever you open a terminal.

The session list shows each project folder as a group. Each session row shows its state, title, summary, and how long ago a message last passed between you and Claude. The hub stores that time with the session and, after a restart, takes the transcript's last entry when that is newer, because a restart starts every session in a new state and the time of the state change then says nothing. Within a folder, a session idle or ended for more than 48 hours folds into one line after the folder's other sessions, which opens them in place, so the list leads with the sessions in use without removing any. A session that works, waits on you, has an unread reply or failed never folds, nor does the one that is open. The app decides this from the time and state the hub already sends, and each device remembers which folders are open. On the desktop the list stays on the left. On the phone it is the start screen, and tapping a session opens its chat.

The chat view follows claude.ai. Your messages and Claude's replies are bubbles, and Claude's reply appears line by line as it is written. Markdown renders, including code blocks. Tool calls show as compact cards that expand to show a command and its output or a file diff. An approval request shows as a card with Allow, Always allow, and Deny, or, when Claude Code takes the answer only in its terminal, with a button that opens the terminal, like the note about trusting a folder. A question shows as a card with its options. Claude's task list shows as a progress bar. The message box completes slash commands, sends `!` commands as shell commands inside the session, and stops a running turn.

Each session has two terminal actions. Terminal opens the session's own pane, so you see and type into the same `claude` process the chat shows. New shell opens a plain shell in the session's folder as its own tmux session. Every tmux session holds exactly one process, because tmux shares the current window between all clients attached to one tmux session. With one process per tmux session, the session's terminal and its shells can be open side by side without switching each other's view. Both actions use xterm.js and attach through tmux, which repaints the whole screen on attach. On the phone the terminal has a row of keys for Esc, Tab, Shift+Tab, Ctrl+C, and the arrows, and a normal text field for typing, because Android keyboards often skip the input events that xterm.js relies on.

## Messages between the app and the hub

The app and the hub exchange newline-delimited JSON over the control channel. The shared `protocol` package defines every message as a TypeScript type, and both sides parse incoming JSON into those types where it arrives. Requests from the app include listing projects and sessions, opening a session with its history, sending a message, answering a request, interrupting a turn, starting, stopping, and renaming a session, opening a shell, listing a session's folder, and reading a piece of a file. Events from the hub include state changes, new chat messages, new lines of a reply, pending requests, withdrawn requests, new summaries, and memory readings.

## Memory guardrails

tmux puts every pane into its own systemd scope, and a drop-in applies `MemoryMax=8G`, `MemorySwapMax=6G`, and `OOMPolicy=continue` to all of them. orfoni sessions and shells are tmux panes, so they get the same limits with no extra work. Tools that Claude runs, such as a test suite, inherit the pane's scope, so an out-of-memory kill stays inside that one session. `earlyoom` keeps running as before and kills the biggest memory user, preferring test and build processes, before the VPS stalls.

The hub reads `memory.current` and the `oom_kill` count in `memory.events` from each pane's scope. The session row shows the memory use, and a kill appears in the chat as a notice. Starting a new session warns when the VPS has little memory available.

The Memory screen answers which sessions to stop. On request the hub reads `memory.current` and `memory.swap.current` from the scope of each orfoni session's pane and of its shells, and of each session outside orfoni whose process runs in a scope named `tmux-spawn-*.scope`, since any other cgroup, such as an SSH login's, holds more than that session. Swap counts because idle sessions get swapped out: on 2026-11-06 one session held 352 MB of RAM and 2.7 GB of swap, and 13 sessions held 6.7 GB of the 12 GB of swap. The app lists them by RAM and swap together, with when a message last passed, and offers Stop for orfoni's own sessions.

## Summaries

The hub writes a summary when a turn finishes and when a session starts waiting on you. The input is your recent messages, Claude's final reply, and the session title. The output is two short lines: what the session is about, and where it stands. The model is Haiku 5.5 through the Claude API, with an API key that stays on the VPS. At the list price of $0.10 per million input tokens, 300 summaries a day with 20,000 input tokens each cost about $18 a month. The real volume is unknown.

Sessions themselves run on Manuel's Claude subscription through the normal `claude` login, exactly as they do in Tabby today.

## Plan limits

The subscription the sessions run on has a 5-hour and a weekly limit. A 5-hour window starts with the first message after the one before has ended. The hub does two things about the limits by itself, each a setting in its state file that the app and the command-line client change (Manuel, 2026-11-10).

It sends continue after a limit. A turn that runs into a limit ends with `StopFailure` and the error `rate_limit`, and the session sits at its prompt. On 2026-11-09 the 5-hour limit stopped the sessions at 21:12, it reset at 01:00, and they sat until someone typed Continue at 09:10. Claude Code names the reset time only in the transcript: the entry it writes for the failed turn carries it in seconds, under `quotaLimits` from 2.1.265 on and also under `apiErrorParams.rate_limit_info` from 2.1.319 on, while the hook input and `getSessionMessages()` leave both out (measured 2026-11-10 on the transcripts of six sessions). The hub reads the end of the transcript file the hook names, only when the file is named after the session's conversation, and sends `continue` a minute after the reset, one session after the other. The session keeps the limit for as long as it stands where the failed turn left it, in the state file too, and a message, an interrupt, a new conversation or the end of Claude Code drops it. A continue the limit refuses again is sent again five minutes later at the earliest, and after three in a row without a tool call or the end of a turn the hub stops until you write. The state stays `failed`, with the limit as a field of the session, because a new state or chat item would break the apps already installed.

It starts the window early. Given a start time, a time of day in the hub's time zone, the hub has a short exchange with Haiku from that time on, as soon as no window is running. The exchange goes through the Agent SDK's `query()` on the `claude` the sessions run, in a folder of its own, without settings, tools or a transcript, so it is no session, shows in no list and sends no notification. On 2026-11-10 it took 3.5 s and 1,792 tokens, 604 of them for the exchange itself, and Claude Code reported for it the same two windows the sessions' status lines showed, so it counts toward the plan like a message in a session. The rate limit event Claude Code sends with the exchange tells the hub what happened. A window that resets four hours on or later began with the exchange or within the hour before, and the day's start is done. One that was already running is waited out, and the hub has the exchange again a minute after it resets, as it does when a session's status line told it of a running window beforehand. An exchange that failed is tried again a quarter of an hour later, unless a limit refused it. Five hours after the start time the day's start is over, since any window running at the start time has ended by then.

## Sent files

Claude sends files with Claude Code's `SendUserFile` tool. orfoni shows each call as a card with Claude's caption and its files, and a click opens a file on the device, Windows or Android. A browser of the session's folder opens files the same way (Manuel, 2026-11-11). Most sent files do not stay on the VPS. On 2026-11-11, 88 of the 215 paths Claude had sent were gone, and only 20 of those had been under `/tmp/claude-0`. So the hub copies a file when Claude sends it, because looking for it later would miss most of the lost ones.

A card is a field on the existing tool item. A SendUserFile call stays a `tool` item, and the hub adds an optional `sent` field to it with the caption, whether Claude asked to render images, and per file its name, resolved path, size, whether it is an image, and what a click would find: `sending`, `kept`, `original` (no copy, the file on the VPS as it is now), `missing` or `tooLarge`. A new chat item kind would break the installed apps, as the `peer` item did on 2026-11-06. Their parser drops a key it does not know, so they show the call as before and the hub can be installed ahead of a release. The app reads `sent` with a fallback to nothing, so a later hub that changes it costs this app a card and never the line. The hub adds `sent` only on the way out, in `outgoing()` for broadcasts and in `show()` for the answers to `openSession` and `openOtherSession`, and never to its model of the chat, so the reducer and history stay as they were. `show()` looks up each file the hub has no copy of on disk, so a card says a file is gone before anyone clicks it.

`hub/src/send-user-file.ts` is the only code that reads Claude Code's SendUserFile formats, and neither is documented. Live, the PostToolUse `tool_response` names each file by its resolved absolute path and its size, one attachment per input path in input order (measured on 2.1.322). In history `getSessionMessages()` leaves that out, and the tool result text names each delivered file's resolved path on a line that ends in `→ file_uuid:` and an ID. Since the app never reads those formats, a change in a later Claude Code is fixed by installing the hub, not by releasing the apps. A call from a subagent gets no card and no copy, because the chat leaves out subagent tools; none of the 319 calls in the local transcripts on 2026-11-11 came from one. An image is told by its name (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) and not by Claude Code's `isImage`, which history does not carry, so a card shows the same live and rebuilt.

The copies are stored data of a new kind, in `sent/` under the state folder, `~/.local/state/orfoni/sent`. `SentCopies` in `hub/src/sent-copies.ts` is the only code that reads or writes it. Each call has a folder named by its tool use ID, which holds the bytes of the call's i-th file in a file named `i`, since two files of one call can share a name, and `call.json`. `call.json` is written last, so a folder with it holds every copy it lists, and a folder without it reads as no copy. It records when the hub kept the files and, per file, `kept` with the copy's size, `tooLarge`, or `unreadable`. Folders have mode 0700 and files 0600. The store is keyed by the call and not by the session, because a fork's transcript repeats the original's tool use IDs and `/clear` changes the conversation, so a fork finds the same copies, and removing a session drops nothing. The copies together stay under 1 GiB. After each copy the hub removes call folders without `call.json` that are older than an hour, which a crash left, and then the oldest calls until the rest fit. Every file Claude had sent that was still on the VPS on 2026-11-11 came to 78 MB. A file over 100 MiB (`MAX_FILE_BYTES`) gets no copy, and the app does not open one either, so one number means both kept and openable.

The hub holds the PostToolUse of a SendUserFile call of the main conversation until the copies exist, as it holds a `PermissionRequest` until it is answered. One predicate, `holdsResponse` in `hub/src/hooks/events.ts`, tells both `hook-server.ts` and `Hub.hook` which hooks are held, so the two cannot disagree. Holding means Claude's next step waits until the hub has the files, so Claude cannot change one first, and the item that shows the call ended already reads `kept`, with no second broadcast. A file the hub cannot read is recorded as `unreadable` and reads as gone, and neither that nor a file too large fails the hook. On 2026-11-12 the copy was written 30 ms before the tool result entry and 230 ms before Claude's next request, and Claude went on and ended its turn in each of 3 runs. The hook's 5 s curl timeout bounds the wait, and a hub that is down copies nothing, since the hook then fails open. Dropping old copies runs after the answer, so Claude never waits on it.

File bytes travel on the control channel, in pieces. `readFile {file, offset}` is an ordinary request, and its answer is `{size, version, data}` with at most 256 KiB of the file as base64, a line of about 350 KB. The app asks for offset 0 to learn the size and version, then two workers ask for the other offsets, and each piece lands at its offset in whatever order it arrives. A copy's version never changes, and a live file's is its modification time, size and inode, so a piece whose version differs from the first one's fails the transfer as changed. `FileTransfers` in `app/src/lib/files.svelte.ts` keeps at most two pieces in flight across every download and thumbnail in the app, first come first served. That bounds the head-of-line blocking: at most about 700 KB of file data sits ahead of an approval or a chat item, 0.6 s at 10 Mbit/s. A second SSH channel carrying raw bytes would be faster and never delay an approval, but it needs a hub subcommand, a framing format outside the protocol package, `sh` and `head` on the VPS, one more of sshd's `MaxSessions`, and a route in the development bridge, and Playwright would then test a path the app does not use. The files measured are small, the 127 still on the VPS on 2026-11-11 averaging about 600 KB with the largest at 3.4 MB, so its speed buys little. With pieces on the existing stream, the app, the browser build, the unit tests' `FakeTransport` and Playwright share one byte path. Pieces make long lines routine, so `ssh.rs` now looks for a line end from where it last stopped instead of from the start of its buffer.

The device saves the pieces through one `DeviceFiles` interface in `app/src/lib/device-files.ts`. In the app each piece goes to Rust still in base64, so the WebView never holds the bytes of a file it saves, and `downloads.rs` writes it at its offset into a part file in the app's cache. On Windows `file_finish` puts the part into Downloads under the first free numbered name, taken with `create_new` so two downloads of one name cannot collide, or opens a file already there with the same bytes. It writes a `Zone.Identifier` stream with `ZoneId=3`, as a browser does for its downloads, and opens the file with the opener's `open_path`, except that a program type from `PROGRAM_TYPES`, such as `.exe` or `.ps1`, is shown in its folder with `reveal_item_in_dir` instead of run. A card must not run a program Claude built, and 22 of the 315 SendUserFile calls in the local transcripts sent an EXE. On Android `DownloadsPlugin.kt` copies the part into MediaStore's Downloads under `Download/orfoni` on Android 10 and later, which needs no permission, or on 7 to 9 into the app's own external Download folder shared through the manifest's FileProvider. It then starts `ACTION_VIEW` with the type `MimeTypeMap` gives, and `ActivityNotFoundException` means saved but not opened. The browser build assembles the pieces into a Blob and clicks an `<a download>`, for development and Playwright. A transfer that fails, because the link dropped or the file changed, stops with a reason, and a click starts it again.

The explorer lists one level of the folder the session started in, which is an orfoni session's project folder, or the folder the registry names for a session outside orfoni while it runs. That is where the session started, not where Claude may have `cd`ed to. `listFolder {session, path}` takes a path of names joined by `/`, none of them empty, `.` or `..`, which the protocol checks, so only a symbolic link can lead out. `within` in `hub/src/folder.ts` takes the `realpath` of the root and of the target and requires the target to be the root or under it. A link that leads out or nowhere lists as `other` and does not open, and a link that stays inside counts as what it leads to. A listing reads the names with one `readdir`, sorts folders, then files, then the rest, each in natural order, keeps the first 1000, stats only those, and counts the rest as `omitted`, so a folder of 100 000 entries costs one `readdir` and one sort. Names that start with a dot are listed, since `.claude` and `.env` are what Manuel looks for.

The hub's file reads are not a security boundary. A sent file is named by its call, its place in the call and its path, and for a call with no record the hub reads the path the client sent, which lets a client read any file the hub's user can read. The explorer's confinement keeps what you browse to the session's folder, and it is not a guard against the client. Anyone who reaches the hub's socket has come in over the SSH login the hub runs under, and so already has a shell as that user. Reading the path the client sends saves the hub reading a transcript for each click.

## Other sessions

Manuel also starts Claude Code outside orfoni: in Tabby's tmux, from Termius on the phone, as a fork, or as a background session. orfoni lists these as other sessions under their project folder and can port one in, which moves the conversation into an orfoni session with the chat, approvals, states, summaries, and memory limits that orfoni gives its own sessions. Over time everything is meant to move into orfoni (Manuel, 2026-10-27).

The hub finds them in `~/.claude/sessions/`, where Claude Code keeps one JSON file per running session with its process ID, process start time, conversation ID, folder, name, idle or busy status, and tmux location. The hub reads the folder every 5 seconds, keeps entries whose process is alive with the recorded start time, leaves out orfoni's own sessions, and broadcasts the list when it changes. A file that does not parse is skipped, so a format change empties the list and breaks nothing else.

An other session shows its name, where it runs, whether it is busy, and its chat read from the transcript, refreshed when a turn ends. It has no composer, no approval cards, and no terminal in orfoni, because those need orfoni's hooks or would disturb the pane it runs in.

Porting checks that the session is idle and still on the same conversation, ends its process with SIGTERM, waits for it to exit, and resumes the conversation in a new orfoni session with `claude --resume=<id>`. A spike on 2026-10-27 showed the process exiting within 2 seconds with its transcript intact and its registry file removed, the pane returning to its shell, and the resumed session appending to the same transcript. Input typed into the old session but not sent is lost, and the session leaves claude.ai and comes back under the new process.

## Repository layout

```
app/                 Tauri app for Windows and Android
hub/                 orfoni-hub
packages/protocol/   message types shared by the app's UI and the hub
docs/                design notes
```

## Plan

Each milestone ends with a check on the real thing, not only tests.

1. Hub core without a UI. Start and stop sessions in tmux, receive hooks, keep session states, send messages, answer approvals and questions, interrupt, and read history, driven by a small command-line client over SSH.
2. Desktop app. SSH login with the key, the session list, the chat view, approvals and questions, the terminal and shell actions, and starting a session.
3. Summaries, the task progress bar, memory per session, and read state.
   - Other sessions: list the Claude Code sessions orfoni did not start, and port them in.
4. Android. The phone layout, the terminal key row, key storage on the phone, and the Android build.

## Risks and open questions

- Answering `AskUserQuestion` and `ExitPlanMode` from the app is documented for `PreToolUse` hooks but untested here. A `PreToolUse` hook that waits for the app may also hold back the terminal's dialog, unlike `PermissionRequest`. Test both before building the cards.
- A message pasted while you type in the terminal mixes with your typing. The app warns when the terminal for that session is attached and the prompt is not empty, or the hub waits until the prompt is empty.
- Typing into the session depends on undocumented behaviour of Claude Code's input box: a paste of at most 3 lines and 800 characters stays plain text, Ctrl+J inserts a newline, and trailing whitespace is trimmed. A change in any of them makes `send` report `not_delivered` for messages that arrived changed. A self-test on hub start would catch it.
- An interrupt before Claude's first reply puts the prompt back into the input box, so the next message from the app is appended to it and `send` reports `not_delivered`. The hub could clear the input box after an interrupt, but the keys that do that also act on an empty box: a second Ctrl+C exits Claude Code.
- Messages lose their tabs, which turn into four spaces. In one of six runs a 66,854-character message lost one 59-character piece, and `send` then reports `not_delivered`. Messages of a few thousand characters arrived exactly every time.
- A `PermissionRequest` hook has a 600 s timeout by default. After that the app can no longer answer, and the request stays open in the terminal. Raise the timeout, or show the request as "answer in the terminal".
- Telling which approvals Claude Code takes only in its terminal depends on their dialog opening on No, which is internal to Claude Code. If that changes, such an approval offers Allow again and Claude Code ignores it. The hub reads a dialog only for the oldest open request, so an approval behind one that the terminal answered stays unread until that one's tool finishes.
- The hooks go into the user settings, which changes every Claude session on the VPS. Hooks that fail do no harm, but each session sends events to the hub.
- `getSessionMessages()` returns the conversation since the last compaction. A compacted session returned 4 messages from a transcript with 41 user entries. The chat shows the compaction summary as a collapsed card.
- The SDK is at version 0.3, and its earlier session API was removed (the "TypeScript SDK V2 session API (removed)" page). The hub uses only two reader functions, keeps them in one module, and pins the SDK version.
- The terminal returns as a feature, with the lessons from v0: one reader per channel, the size set before attaching, the Unicode 11 widths add-on, and no shared lock between keystrokes and other work.
- Android needs `russh` to cross-compile, a safe place for the SSH key, and Tauri's younger Android support to hold up.
- The session registry in `~/.claude/sessions/` is an internal Claude Code file without documentation. orfoni reads it only to list and port other sessions, and a registry it cannot read leaves that list empty.
- The reset time of a plan limit comes from fields of the transcript that no documentation names. If Claude Code renames them, a session at a limit shows no reset time and gets no continue, and the hub logs that it could not tell.
- A continue goes to a session nobody is watching, in whatever permission mode it runs, and what it does then draws on the window that has just started. Stop keeps a session from going on, and the setting turns all of it off.
- No turn at a real limit has passed through the hub yet. The checks hand the hub the hook and the transcript of such a turn as Claude Code wrote them on 2026-11-09. Whether Claude Code has written the entry by the time the hook runs is unmeasured, so the hub reads the file up to five times over two seconds.
- That a short exchange starts a window when none is running rests on how the plan counts messages, which Anthropic can change. The hub tells from the reset time the exchange reports, and says in the app when it cannot.
- Claude Code offers `SendUserFile` only while a Remote Control client is connected or in a cloud session, and 2.1.322 also checks a first-party provider and server-side flags before it does. If any of that changes, Claude no longer has the tool and no cards appear, and nothing in orfoni can tell.
- The hub parses the SendUserFile `tool_response` and the result text of history, which Claude Code does not document. If the input changes, the call shows as the plain Sent files line in its tool group. If the response or the result text changes, the hub resolves each relative input path itself, against the hook's working directory live and against the session's folder in history, which is wrong after a `cd`, and a live card shows no sizes. A new hub fixes either without an app release.
- The Windows and Android ways of saving and opening a file have not run on a real device: the `Zone.Identifier` mark, the reveal of programs, the reuse of a file with the same bytes and `open_path` on a file marked as downloaded on Windows, and MediaStore, the FileProvider and `ACTION_VIEW` on a phone. Rust tests check the saving behind a fake opener, the Android debug APK builds, and Playwright checks only the browser build's download.

## Lessons from v0

orfoni v0 was written in about 3.5 hours and never fixed. Its review found these patterns, which v1 must not repeat:

- One global lock on the path of every keystroke, held during blocking writes.
- A state file without a version that was replaced by an empty one whenever it failed to parse.
- Errors swallowed, so failures showed up as blank screens.
- Claude started by typing `claude` into a shell instead of as the pane's own process, so its exit left a shell behind and nothing noticed.
- UI state not tied to the session it belongs to, which let Destroy delete the wrong session.
- Terminal code without a single test.
