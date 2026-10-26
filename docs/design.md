# orfoni design

orfoni is a native app for running and following Claude Code sessions on a remote machine. You open it on Windows or on an Android phone, see every session grouped by project, read each conversation as a chat, answer Claude's approval requests and questions with a tap, and start new sessions. The sessions run on the VPS and keep running when no app is connected.

Status: design, written 2026-10-26. Nothing is built yet. orfoni v0, a local Windows terminal manager from March 2026, lives at `~/code/orfoni-v0` and shares only the name with this design.

## What v1 must do

These requirements come from Manuel unless marked otherwise.

- Run Claude Code sessions on the VPS. A session keeps running when every client is closed.
- One app for Windows and Android, showing the same state on both.
- Log in with the existing SSH key, the way Tabby does. No new open ports and no web login.
- Show a session list that is always visible on the desktop and is the start screen on the phone, grouped by project folder.
- For each session, show what it is about, how far it has got, and whether it needs you or has an answer.
- Show each conversation in the style of claude.ai: your messages and Claude's replies as chat bubbles, on desktop and phone.
- Write a short AI summary per session through the Claude API, within the $100 monthly API budget.
- Start new sessions on the VPS from the app.
- Keep the memory guardrails: a runaway test kills only itself, never the box or the other sessions.
- Depend on no Claude Code feature that the docs label research preview or alpha.
- Resume any session after a hub restart or a VPS reboot (inferred).
- Keep every session reachable from a plain terminal as a fallback (inferred).

These are out of scope for v1: notifications, machines other than the VPS, agents other than Claude Code, a terminal view inside the app, and integration with `worktree-orchestrator` or its dev servers.

## How the pieces fit

```
orfoni app on Windows and Android     Tauri 2 + Svelte 5, stores nothing
    │  one SSH connection, authenticated with your key
    └─ runs `orfoni-hub connect` and exchanges JSON messages over it

VPS
    orfoni-hub                         Node + TypeScript, systemd user service
        sessions and their states    ◄─ Agent SDK messages
        approvals and questions      ◄─ the SDK's canUseTool callback
        history and titles           ◄─ listSessions() and getSessionMessages()
        summaries                    ──► Claude API, Haiku 5.5
        memory per session           ◄─ each session's cgroup files
    claude                             one process per live session, each in its own memory-capped systemd scope
```

The app is a view. All state lives on the VPS, so the desktop and the phone always agree. The hub is the only new server program. It drives Claude Code through the Claude Agent SDK, Anthropic's documented TypeScript library that runs the `claude` binary as a subprocess and exchanges typed messages with it.

## Why the Agent SDK and not a terminal

A chat view needs Claude's conversation as structured messages: who said what, which tool ran with which input, and which request waits for a decision. A terminal only carries screen output. Three ways to get structured messages were considered.

The first option keeps interactive Claude Code in tmux and reconstructs the chat from outside. Hooks report events, the transcript file holds the history, and the app types your input into the terminal with `tmux send-keys`. This needs no new Claude Code features, but it is fragile. Typed input breaks on multi-line text and on dialogs such as permission prompts and multiple-choice questions, the transcript format is not a documented contract, and the docs say the transcript can lag behind the conversation.

The second option, chosen here, is the Agent SDK. It hands over every message as a typed object, streams Claude's reply as it is written, calls back into the hub when Claude needs an approval or asks a question, and lists and reads past sessions through documented functions. It also loads the same settings, CLAUDE.md files, skills, hooks, and MCP servers as the CLI.

The third option is Claude Code's own multi-session features. Agent view is ruled out because the docs label it research preview. Remote Control is ruled out because it connects sessions only to Anthropic's own apps, claude.ai and the Claude app, and its protocol is not public.

The SDK path has costs. A session cannot be open in the orfoni chat and in a terminal at the same time, because each would run its own `claude` process on one conversation. A hub restart interrupts turns that are running, because the `claude` processes are children of the hub. The section on risks covers both.

## What the spike showed

A spike on 2026-10-26 tested the assumptions this design depends on, using SDK version 0.3.310 on the VPS. All numbers are measured.

- `listSessions()` listed the five newest sessions of one project folder in 252 ms and of a second one in 81 ms. The list included the sessions running in tmux at the time, with the same titles, so sessions started in a terminal show up too.
- `getSessionMessages()` read a 78 MB session transcript in 677 ms and returned 375 messages, including thinking, text, tool calls, and tool results.
- A live session with the `haiku` model reached its init message after 1.4 s. The `Write` tool asked for approval through `canUseTool` after 3.7 s. The turn produced 23 streaming events and finished after 4.9 s, and the file existed afterwards.
- The init message reported 28 tools, 199 slash commands, and the MCP servers from the user settings, so sessions start with the same setup as the CLI.
- The new session appeared in `listSessions()` with the AI-generated title "Create hello.txt file".
- `spawnClaudeCodeProcess` started the `claude` process through `systemd-run --user --scope`. The scope reported `MemoryMax=8589934592`, `MemorySwapMax=6442450944`, and `OOMPolicy=continue`, the same limits as today's tmux panes.
- `claude -p --resume <id>` from the plain CLI continued the session that the SDK had created and remembered the earlier turn.

## Login and the subscription

Sessions run on Manuel's Claude subscription through the `claude` binary's own login, the same login the CLI uses. The Claude Code docs support non-interactive use on a subscription. `claude setup-token` exists to generate a long-lived token "for CI and scripts" and requires a subscription. The Agent SDK overview says that third-party developers may not offer claude.ai login or rate limits to the users of their products without approval. orfoni is a personal tool on Manuel's own machine with his own login, so that rule does not apply as long as orfoni stays personal. If orfoni is ever published for other people, check this rule first.

The summaries use the Claude API with an API key that stays on the VPS, billed to the separate monthly API budget.

## The hub

`orfoni-hub` is one Node program written in TypeScript. TypeScript is the obvious choice because the Agent SDK ships for TypeScript and Python, and the app's UI is TypeScript, so both sides share one package of message types. It runs as a systemd user service.

The hub has these jobs:

- Keep one SDK `query()` per live session in streaming input mode, so you can send follow-up messages, interrupt a turn, and attach images.
- Forward every SDK message to connected apps, normalized into the shared message types.
- Hold pending approvals and questions from `canUseTool` until an app answers, then pass the decision to Claude.
- Start sessions in a project folder, stop them, and resume them with the session ID when you write to a session that has no running process.
- Read history and titles through `listSessions()` and `getSessionMessages()`. Claude's own transcript store is the source of truth for both.
- Write summaries and track which answers you have not read yet.
- Read memory use and out-of-memory kills for each session.

The hub stores only what Claude Code does not: summaries, read state, and the list of project folders. It keeps them in one small file with a version field and writes it atomically, by writing a temporary file and renaming it.

All calls into the SDK live in one hub module. Nothing else imports the SDK, so an SDK change means changing one file.

## Session states

Each session has one state, and every event moves it to a defined next state. The app shows the state as the colour of the session's dot and sorts the list by it.

| State | Meaning | Enters on | Leaves on |
|---|---|---|---|
| `offline` | No `claude` process runs for this session | hub start, stop, process exit | you send a message, which resumes the session |
| `working` | A turn is running | you send a message, you answer a request | a request, the turn's result, a failure |
| `needs_approval` | Claude waits for permission to use a tool | `canUseTool` for any tool except `AskUserQuestion` | you allow or deny |
| `needs_answer` | Claude asked a question | `canUseTool` for `AskUserQuestion` | you answer |
| `answered` | The turn finished and you have not read the reply | the turn's result | you open the session |
| `idle` | The turn finished and you have read the reply | you open an `answered` session | you send a message |
| `failed` | The turn ended with an error or the process crashed | an error result, an unexpected exit | you send a message |

A session's identity is its Claude session ID. A `/clear` sent through orfoni starts a new conversation, which appears as a new session in the list.

## The app

The app is Tauri 2 with a Svelte 5 UI, built for Windows and Android from one codebase. The Rust side does one job. It opens an SSH connection with `russh`, a pure-Rust SSH library, runs `orfoni-hub connect` on the VPS, and passes JSON messages between that channel and the UI. The app contains no terminal emulator.

The session list shows each project folder as a group. Each session row shows its state, title, summary, and how long ago it changed. On the desktop the list stays on the left. On the phone it is the start screen, and tapping a session opens its chat.

The chat view follows claude.ai. Your messages and Claude's replies are bubbles, and Claude's reply streams in as it is written. Markdown renders, including code blocks. Tool calls show as compact cards that expand to show a command and its output or a file diff. An approval request shows as a card with Allow, Always allow, and Deny. A question from `AskUserQuestion` shows as a card with its options. Claude's task list shows as a progress bar. The message box supports slash-command completion from the list in the init message, attaching images, and stopping a running turn.

Each session also has "Open in terminal". The hub stops the session's process, and the app shows the `claude --resume <id>` command to paste into Tabby or Termius. The spike confirmed that a plain CLI resume continues an SDK session.

## Messages between the app and the hub

The app and the hub exchange newline-delimited JSON over the SSH channel. The shared `protocol` package defines every message as a TypeScript type, and both sides parse incoming JSON into those types where it arrives. Requests from the app include listing projects and sessions, opening a session with its history, sending a message, answering a request, interrupting a turn, starting, stopping, and renaming a session. Events from the hub include state changes, new messages, streaming text, pending requests, new summaries, and memory readings.

## Memory guardrails

The hub starts every `claude` process through `systemd-run --user --scope` with `MemoryMax=8G`, `MemorySwapMax=6G`, and `OOMPolicy=continue`, the same limits that tmux panes have today. Tools that Claude runs, such as a test suite, inherit the session's scope, so an out-of-memory kill stays inside that one session. `earlyoom` keeps running as before and kills the biggest memory user, preferring test and build processes, before the VPS stalls.

The hub reads `memory.current` and the `oom_kill` count in `memory.events` from each scope. The session row shows the memory use, and a kill appears in the chat as a notice. Starting a new session warns when the VPS has little memory available.

## Summaries

The hub writes a summary when a turn finishes and when a session starts waiting on you. The input is your recent messages, Claude's final reply, and the session title. The output is two short lines: what the session is about, and where it stands. The model is Haiku 5.5 through the Claude API. At the list price of $0.10 per million input tokens, 300 summaries a day with 20,000 input tokens each cost about $18 a month. The real volume is unknown.

## Repository layout

```
app/                 Tauri app for Windows and Android
hub/                 orfoni-hub
packages/protocol/   message types shared by the app's UI and the hub
docs/                design notes
```

## Plan

Each milestone ends with a check on the real thing, not only tests.

1. Hub core without a UI. Start, stream, approve, answer, interrupt, stop, resume, and list sessions, driven by a small command-line client over SSH.
2. Desktop app. SSH login with the key, the session list, the chat view, approvals and questions, and starting a session.
3. Summaries, the task progress bar, memory per session, and read state.
4. Android. The phone layout, key storage on the phone, and the Android build.

## Risks and open questions

- The SDK is at version 0.3, and its earlier session API was removed (the "TypeScript SDK V2 session API (removed)" page). Pin the SDK version, keep all SDK calls in one hub module, and use no option the reference marks alpha.
- A hub restart interrupts running turns. v1 accepts this, and the next message resumes the session. A small runner process per session could outlive the hub later.
- The SDK docs describe loading a marketplace plugin by passing its install path. It is unclear whether plugins enabled in the user settings load without that, and the spike's 199 slash commands suggest that at least some do. Check which plugins are active before relying on one.
- `getSessionMessages()` returns the conversation since the last compaction. A compacted session returned 4 messages from a transcript with 41 user entries. The chat shows the compaction summary as a collapsed card.
- A session that is still open in a terminal must not get a second process from orfoni. The hub needs a way to detect this, for example from recent transcript activity, and to show such sessions as read-only.
- Android needs `russh` to cross-compile, a safe place for the SSH key, and Tauri's younger Android support to hold up.

## Lessons from v0

orfoni v0 was written in about 3.5 hours and never fixed. Its review found these patterns, which v1 must not repeat:

- One global lock on the path of every keystroke, held during blocking writes.
- A state file without a version that was replaced by an empty one whenever it failed to parse.
- Errors swallowed, so failures showed up as blank screens.
- Commands typed into a shell instead of started as processes.
- UI state not tied to the session it belongs to, which let Destroy delete the wrong session.
- Terminal code without a single test.
