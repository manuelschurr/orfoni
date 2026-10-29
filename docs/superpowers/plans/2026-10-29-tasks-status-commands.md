# Task list, live status, and slash commands implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Claude Code's task list and its live status line in orfoni, the way the terminal shows them, and autocomplete slash commands, skills included, in the composer (Manuel, 2026-10-29: "claude code shows a todo list sometimes in longer sessions, orfoni needs to show that as well", "the current status shown there is also very useful, that also shows issues like waiting for api response", "I want auto-complete for working slash commands, like clear or poteto-mode or other skills I have").

**Architecture:** The hub builds each session's task list from the TaskCreated and TaskCompleted hooks and the TaskCreate and TaskUpdate tool inputs it already receives. It reads the status line from the session's tmux pane while a client views a working session. It lists a folder's slash commands through the Agent SDK's `supportedCommands()`. The app shows the list and the status line under the working indicator and in the header, and suggests commands as the composer starts with `/`.

**Tech Stack:** as before.

**Spec:** this plan. The protocol is on main: `TaskItem`, `SessionSummary.taskList` and `SessionSummary.activity` (null until there is one), `SlashCommand`, and the `listCommands` request with its app result shape. The hub's `summary()` returns null for both new fields until H1 and H2 fill them.

## Global Constraints

- **Tasks.** In a real transcript TaskCreate's input is `{ subject, description }` and may carry `activeForm`; TaskUpdate's is `{ taskId, status }` and may carry `subject` and `activeForm`; task IDs are short strings such as `"1"`; the TaskCreated hook carries `task_id` and `task_subject` and so does TaskCompleted. A task is pending when created, takes the status a TaskUpdate gives it (`pending`, `in_progress`, `completed`), and leaves the list on `deleted`. Its `activeForm` comes from TaskCreate (matched by subject until TaskCreated gives the ID) or a later TaskUpdate. The list keeps creation order, starts again at null after `/clear`, survives a hub restart (a state file change migrates, never sets aside), and `tasks` (done and total) is derived from it, so a deleted task no longer counts.
- **Status line.** A spike on 2026-10-29 captured these lines from a working session's pane: `✽ Writing the story… (42s · ↓ 965 tokens · thinking some more with high effort)`, `✻ Writing the story… (14s · ↓ 965 tokens · thinking with high effort)`, `✽ Brewing… (2s · thinking with high effort)`. The glyph cycles through `✢ ✳ ✶ ✻ ✽ ·`. The text is the in-progress task's `activeForm` with `…`, or a stock verb. Parse the last line on the screen that is a glyph, a space, text, a space, and a parenthesised list joined by ` · `: `text` keeps its `…`, `details` are the list's parts without a first part that is an elapsed time such as `42s`, `2m 5s`, or `1h 3m`. Anything else gives null, so a format change only hides the line. Capture with `tmux capture-pane -p` once a second, only for sessions that are working and that a client views, broadcast on change only, and never store it. Activity is null whenever the session is not working.
- **Commands.** A spike on 2026-10-29 showed `query({ prompt: <an async iterable that never yields>, options: { cwd, abortController } }).supportedCommands()` returning 189 commands for `/root/projects/swarm` in about 3 seconds without any API call, each `{ name, description, argumentHint, aliases? }`, with skills such as `pstack:poteto-mode` (alias `poteto-mode`) and built-ins such as `clear`, `compact`, `context`, and `review`, but not terminal-only ones such as `exit` or `resume`. The SDK process outlived an `abort()` until the spike's node process exited, so the hub must make sure every process it starts for this ends (abort, then end the query's iterator or close it, then check). Cache the list per folder for 10 minutes and share one request in flight per folder; a listing that takes over 20 seconds fails. Leave out `model` and `effort`, because typed into an interactive session they also change the user's defaults for every new session (the header changes them for one session), and leave out any command the SDK marks terminal-only.
- **Settings.** No test, check, or listing may change `~/.claude/settings.json`; live checks compare its `model`, `effortLevel`, and `modelSettings` before and after, and never type `/model` or `/effort`.
- No em dash characters anywhere. Markdown paragraphs stay on one line.

## Review Focus

- A TaskUpdate that arrives for a task ID the hub has not seen, or a TaskCompleted before TaskCreated. Expect a sensible list, never a crash.
- A hub restart in the middle of a task list. Expect the list back as it was.
- A screen with no status line, or a status line in a format the parser does not know. Expect activity null and the app's own indicator.
- Listing commands for a folder that does not exist or is not trusted, and many sessions in the same folder asking at once. Expect one listing, an error that says why, and no Claude process left behind.
- The composer with text that only starts like a command, such as a path `/root/...` followed by more words. Expect no suggestions once there is a space.

---

### Hub tasks

- [ ] **H1. Task list** in the reducer from the hooks and tool inputs above, with `tasks` derived from it, persisted across restarts. Tests first, including deleted, out-of-order events, `/clear`, and the restart.
- [ ] **H2. Status line.** A tmux capture function, a parser in its own module, and the once-a-second capture for viewed working sessions. Tests first for the parser (the spike's lines verbatim, unknown formats) and for the capture only running while needed.
- [ ] **H3. Commands.** `listCommands` with the lister injected through `HubOptions`, wired to the SDK in its own module, with the cache, the shared request, the timeout, the left-out commands, and the process cleanup. Tests first with a fake lister.
- [ ] **H4. Live checks** in `hub/test/e2e.test.ts`: a session that creates three tasks with activeForms, sets one in progress, and completes one shows that list; a viewed working session shows an activity and none once idle; `listCommands` for a project includes `clear` and not `model`, and no SDK process is left; the settings guard holds.

### App tasks

- [ ] **A1. Task list.** Under the working indicator while a turn runs, one line per task with a mark for pending, in progress (emphasised), and completed (muted); when the session is not working, the header's Tasks progress opens and closes the same list. Tests first.
- [ ] **A2. Status line.** The working indicator shows `activity.text` and `activity.details` joined by ` · ` after its own timer when the hub sends them, and its own Thinking, Running, or Writing otherwise. Tests first.
- [ ] **A3. Autocomplete.** When the composer's text starts with `/` and has no whitespace yet, a list of up to 8 matching commands (name or alias prefix first, then substring) with their descriptions; arrow keys move, Tab or Enter takes the highlighted one as `/name ` and keeps the cursor in the composer, Escape closes, a click takes one; the combobox pattern for accessibility. Commands load once per folder per connection and silently show nothing while loading or after a failure. Tests first.
- [ ] **A4. Checks.** Component tests for A1 to A3, and Playwright checks that a task list shows while a session works and that `/cl` suggests `/clear` and Tab completes it. They run once the hub work is merged and installed.
