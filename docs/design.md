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
        session states and chat      ◄─ Claude Code hooks, posted to 127.0.0.1
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

Two spikes on 2026-10-26 tested the assumptions this design depends on. All numbers are measured.

Interactive session in tmux, with hooks that log every event:

- Text pasted into the session with `tmux paste-buffer -p` and submitted with Enter arrived as one prompt. The `UserPromptSubmit` hook received the exact text.
- When Claude asked to write a file, the permission dialog appeared in the terminal while the `PermissionRequest` hook was still waiting. When the hook answered after 15 s, the dialog closed and the file was written in the same second.
- In a second run, the terminal answered the dialog while the hook was still waiting. The file was written immediately, and the hook's late answer changed nothing. The first answer wins, from either side.
- A pasted `! echo ... > bm.txt` ran as a shell command inside the session. The file appeared, the output showed in the session, and Claude saw it.
- `MessageDisplay` delivered each assistant message's text with a message ID and a `final` flag, and `Stop` delivered the final reply as `last_assistant_message`.

Agent SDK, used only to read sessions:

- `listSessions()` listed the five newest sessions of one project folder in 252 ms and of a second one in 81 ms, including the sessions running in tmux at the time, with the same titles.
- `getSessionMessages()` read a 78 MB session transcript in 677 ms and returned 375 messages, including thinking, text, tool calls, and tool results.

Memory caps:

- tmux already puts every pane into its own systemd scope. All 9 panes running at the time had `MemoryMax=8589934592`, `MemorySwapMax=6442450944`, and `OOMPolicy=continue`.

## The hub

`orfoni-hub` is one Node program written in TypeScript. TypeScript fits because the app's UI is TypeScript, so both sides share one package of message types, and because the Agent SDK's session readers are TypeScript. It runs as a systemd user service.

The hub has these jobs:

- Start a session by creating a tmux session in the project folder that runs `claude --session-id <uuid> --name <title>`. Stop a session by ending its tmux session.
- Receive Claude Code's hook events over HTTP on 127.0.0.1. Each hook adds the tmux pane ID as a header, so the hub knows which pane sent it.
- Turn hook events into session states and chat messages, and forward both to connected apps.
- Send your chat messages into the session with `tmux paste-buffer -p` followed by Enter, only while the session is waiting for input or working. Claude Code queues a message typed while it works.
- Hold `PermissionRequest` hook requests open until an app answers. If the terminal answers first, the hub sees the tool run and withdraws the card.
- Answer questions from `AskUserQuestion` and plan approvals from `ExitPlanMode` the same way. The hooks docs describe answering both through `updatedInput`.
- Interrupt a turn by sending Escape to the pane.
- Read history and titles through the Agent SDK's `listSessions()` and `getSessionMessages()`. Claude's own transcript store is the source of truth for both. These functions read files and start no Claude process.
- Open a plain shell in the session's folder as its own tmux session, tagged with the Claude session it belongs to, and close those shells when the Claude session is stopped.
- Write summaries and track which answers you have not read yet.
- Read memory use and out-of-memory kills for each pane.

The hub stores only what Claude Code and tmux do not: summaries, read state, and the list of project folders. It keeps them in one small file with a version field and writes it atomically, by writing a temporary file and renaming it.

Sessions do not depend on the hub. If the hub is down, Claude keeps working, because a hook that fails defaults to continuing. When the hub comes back, it rebuilds each session's state from tmux and the transcripts.

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

`MessageDisplay` holds each batch of text until the hook returns, so the hub answers it immediately and does its work afterwards. Its hook entry gets a short timeout, so a hub that hangs delays the terminal by seconds at most.

## Session states

Each session has one state, and every event moves it to a defined next state. The app shows the state as the colour of the session's dot and sorts the list by it.

| State | Meaning | Enters on | Leaves on |
|---|---|---|---|
| `offline` | No `claude` process runs in the session's tmux session | `SessionEnd`, the pane exits | you send a message, which starts `claude --resume` |
| `working` | A turn is running | `UserPromptSubmit`, an answered request | a request, `Stop`, `StopFailure` |
| `needs_approval` | Claude waits for permission to use a tool | `PermissionRequest` | an answer from the app or the terminal |
| `needs_answer` | Claude asked a question or wants a plan approved | `AskUserQuestion` or `ExitPlanMode` | an answer from the app or the terminal |
| `answered` | The turn finished and you have not read the reply | `Stop` | you open the session |
| `idle` | The turn finished and you have read the reply | you open an `answered` session | `UserPromptSubmit` |
| `failed` | The turn ended with an error | `StopFailure` | `UserPromptSubmit` |

A row in the session list is a tmux session. Claude's session ID is a property of that row. It changes when you run `/clear`, and the chat then starts empty while the earlier conversation stays in the project's history.

Sessions started outside orfoni, such as panes in an existing multi-pane tmux session in Tabby, still report through the hooks and show up in the list. Each hook also sends `$TMUX`, which names the tmux server, so the hub can follow and answer them where they run. orfoni offers to move such a session into its own tmux session by resuming it there.

## The app

The app is Tauri 2 with a Svelte 5 UI, built for Windows and Android from one codebase. The Rust side opens one SSH connection with `russh`, a pure-Rust SSH library. On that connection it runs `orfoni-hub connect` for the control channel and opens a terminal channel whenever you open a terminal.

The session list shows each project folder as a group. Each session row shows its state, title, summary, and how long ago it changed. On the desktop the list stays on the left. On the phone it is the start screen, and tapping a session opens its chat.

The chat view follows claude.ai. Your messages and Claude's replies are bubbles, and Claude's reply appears line by line as it is written. Markdown renders, including code blocks. Tool calls show as compact cards that expand to show a command and its output or a file diff. An approval request shows as a card with Allow, Always allow, and Deny. A question shows as a card with its options. Claude's task list shows as a progress bar. The message box completes slash commands, sends `!` commands as shell commands inside the session, and stops a running turn.

Each session has two terminal actions. Terminal opens the session's own pane, so you see and type into the same `claude` process the chat shows. New shell opens a plain shell in the session's folder as its own tmux session. Every tmux session holds exactly one process, because tmux shares the current window between all clients attached to one tmux session. With one process per tmux session, the session's terminal and its shells can be open side by side without switching each other's view. Both actions use xterm.js and attach through tmux, which repaints the whole screen on attach. On the phone the terminal has a row of keys for Esc, Tab, Shift+Tab, Ctrl+C, and the arrows, and a normal text field for typing, because Android keyboards often skip the input events that xterm.js relies on.

## Messages between the app and the hub

The app and the hub exchange newline-delimited JSON over the control channel. The shared `protocol` package defines every message as a TypeScript type, and both sides parse incoming JSON into those types where it arrives. Requests from the app include listing projects and sessions, opening a session with its history, sending a message, answering a request, interrupting a turn, starting, stopping, and renaming a session, and opening a shell. Events from the hub include state changes, new chat messages, new lines of a reply, pending requests, withdrawn requests, new summaries, and memory readings.

## Memory guardrails

tmux puts every pane into its own systemd scope, and a drop-in applies `MemoryMax=8G`, `MemorySwapMax=6G`, and `OOMPolicy=continue` to all of them. orfoni sessions and shells are tmux panes, so they get the same limits with no extra work. Tools that Claude runs, such as a test suite, inherit the pane's scope, so an out-of-memory kill stays inside that one session. `earlyoom` keeps running as before and kills the biggest memory user, preferring test and build processes, before the VPS stalls.

The hub reads `memory.current` and the `oom_kill` count in `memory.events` from each pane's scope. The session row shows the memory use, and a kill appears in the chat as a notice. Starting a new session warns when the VPS has little memory available.

## Summaries

The hub writes a summary when a turn finishes and when a session starts waiting on you. The input is your recent messages, Claude's final reply, and the session title. The output is two short lines: what the session is about, and where it stands. The model is Haiku 5.5 through the Claude API, with an API key that stays on the VPS. At the list price of $0.10 per million input tokens, 300 summaries a day with 20,000 input tokens each cost about $18 a month. The real volume is unknown.

Sessions themselves run on Manuel's Claude subscription through the normal `claude` login, exactly as they do in Tabby today.

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
4. Android. The phone layout, the terminal key row, key storage on the phone, and the Android build.

## Risks and open questions

- Answering `AskUserQuestion` and `ExitPlanMode` from the app is documented for `PreToolUse` hooks but untested here. A `PreToolUse` hook that waits for the app may also hold back the terminal's dialog, unlike `PermissionRequest`. Test both before building the cards.
- A message pasted while you type in the terminal mixes with your typing. The app warns when the terminal for that session is attached and the prompt is not empty, or the hub waits until the prompt is empty.
- Typing into the session depends on Claude Code's input box accepting a bracketed paste followed by Enter. A self-test on hub start catches a change in that behaviour.
- A `PermissionRequest` hook has a 600 s timeout by default. After that the app can no longer answer, and the request stays open in the terminal. Raise the timeout, or show the request as "answer in the terminal".
- The hooks go into the user settings, which changes every Claude session on the VPS. Hooks that fail do no harm, but each session sends events to the hub.
- `getSessionMessages()` returns the conversation since the last compaction. A compacted session returned 4 messages from a transcript with 41 user entries. The chat shows the compaction summary as a collapsed card.
- The SDK is at version 0.3, and its earlier session API was removed (the "TypeScript SDK V2 session API (removed)" page). The hub uses only two reader functions, keeps them in one module, and pins the SDK version.
- The terminal returns as a feature, with the lessons from v0: one reader per channel, the size set before attaching, the Unicode 11 widths add-on, and no shared lock between keystrokes and other work.
- Android needs `russh` to cross-compile, a safe place for the SSH key, and Tauri's younger Android support to hold up.

## Lessons from v0

orfoni v0 was written in about 3.5 hours and never fixed. Its review found these patterns, which v1 must not repeat:

- One global lock on the path of every keystroke, held during blocking writes.
- A state file without a version that was replaced by an empty one whenever it failed to parse.
- Errors swallowed, so failures showed up as blank screens.
- Claude started by typing `claude` into a shell instead of as the pane's own process, so its exit left a shell behind and nothing noticed.
- UI state not tied to the session it belongs to, which let Destroy delete the wrong session.
- Terminal code without a single test.
