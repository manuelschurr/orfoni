# Desktop app implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build milestone 2 of orfoni: a Windows desktop app that logs in to the VPS with an SSH key and shows every session as a claude.ai style chat, with approvals, questions, plan approvals, starting sessions, and a terminal into any session.

**Architecture:** The app is Tauri 2 with a Svelte 5 UI. Its Rust side holds one SSH connection (russh, ring backend) with one channel running `orfoni-hub connect` for JSON messages and one PTY channel per open terminal running `tmux attach`. The UI talks to the hub only through two small transport interfaces, so the same UI also runs in a browser on the VPS against a development bridge, which is how the end-to-end checks drive it with Playwright.

**Tech Stack:** Tauri 2, Svelte 5 (runes), Vite, TypeScript (strict, ESM), vitest, Playwright, xterm.js 6 with the fit, webgl, and unicode11 add-ons, marked and DOMPurify for markdown, Rust with russh 0.65 (`default-features = false`, features `ring`, `rsa`, `flate2`) and tokio, `node-pty` in the development bridge only.

**Spec:** `docs/design.md`, plus the milestone 1 plan `docs/superpowers/plans/2026-10-26-hub-core.md` for the hub it talks to.

## Global Constraints

- The app keeps no session state of its own. Everything it shows comes from the hub, so a reconnect rebuilds the screen from `listSessions` and `openSession`.
- The hub command is `"$HOME/.local/bin/orfoni-hub" connect` by default and can be changed in the settings. A non-interactive SSH command does not have `~/.local/bin` on its PATH (spike, 2026-10-26).
- Terminal targets use tmux's exact syntax: `tmux -L orfoni attach -t =orfoni-<sessionId>` for a session and `=orfoni-<sessionId>-sh<n>` for a shell, the name `openShell` returns.
- russh is built with `default-features = false` and the features `ring`, `rsa`, and `flate2`, so the Windows build needs no NASM or CMake.
- Host keys are checked trust-on-first-use. The first connection to a host shows its SHA-256 fingerprint and stores it after the user confirms. A changed key refuses the connection with a message that names both fingerprints.
- The settings file stores host, port, user, key path, and hub command. A key passphrase is asked for when the key needs one and is kept in memory only.
- Each terminal channel is owned by one task that receives writes through a queue. No lock is shared between a keystroke and any other work (lesson from v0).
- Terminal output reaches the UI as raw bytes through a Tauri `Channel` with `InvokeResponseBody::Raw`, never as a JSON array of numbers (lesson from v0).
- The development bridge binds 127.0.0.1 only and is never installed as a service.
- The UI follows the design's chat section: your messages and Claude's replies as bubbles, Claude's reply streaming in, markdown with code blocks, tool calls as compact cards that expand, and request cards with buttons.
- No em dash characters in code, docs, UI text, or commit messages. Markdown paragraphs stay on one line.

## Review Focus

- The laptop sleeps or the network drops while a session runs. Expect the app to show "reconnecting", reconnect with backoff, and rebuild the session list and the open chat without duplicated items. Test in Task 7 and Task 11.
- A tool call returns a very large output, for example a 2 MB log. Expect the card to stay collapsed, show at most the first 200 lines when opened, and the chat to stay responsive. Test in Task 5.
- The VPS host key changes. Expect the connection to be refused with both fingerprints shown, and nothing sent over it. Test in Task 7.
- A message is typed while the session waits for an approval. Expect the composer to say that the session waits for an answer and keep the text, instead of losing it. Test in Task 3 and Task 5.
- The terminal and the chat show the same session at once. Expect a prompt typed in the terminal to appear in the chat as a user bubble, and a message sent from the chat to appear in the terminal. Test in Task 11.

---

### Task 1: App scaffold

**Files:**
- Create: `app/package.json`, `app/vite.config.ts`, `app/svelte.config.js`, `app/tsconfig.json`, `app/index.html`, `app/src/main.ts`, `app/src/App.svelte`, `app/src-tauri/` (from `create-tauri-app`, identifier `com.orfoni.app`, product name `orfoni`)
- Modify: root `package.json` workspaces, root `tsconfig.json` references, `vitest.config.ts` include list, `.gitignore` (`app/src-tauri/target/`)
- Test: `app/src/App.test.ts`

**Interfaces:**
- Produces: a Vite SPA that imports `@orfoni/protocol`, a Tauri shell that opens it, and the scripts `npm run dev -w app` (browser), `npm run tauri -w app -- dev`, and `npm run tauri -w app -- build --debug`.

- [ ] **Step 1: Write the failing test.** `App.test.ts` renders `App` with `@testing-library/svelte` and expects the text `orfoni`.
- [ ] **Step 2: Run `npx vitest run app` and confirm it fails.**
- [ ] **Step 3: Scaffold the app** with Svelte 5 and TypeScript, no SvelteKit, no CSS framework.
- [ ] **Step 4: Run the test and confirm it passes.** Then run `cargo build --manifest-path app/src-tauri/Cargo.toml` and confirm it compiles on the VPS.
- [ ] **Step 5: Commit** with the message `Scaffold the desktop app`.

### Task 2: Hub additions for the app

**Files:**
- Modify: `packages/protocol/src/index.ts`, `hub/src/hub.ts`, `cli/src/args.ts`, `cli/src/main.ts`, `README.md`
- Test: `packages/protocol/src/index.test.ts`, `hub/src/hub.test.ts`, `cli/src/args.test.ts`

**Interfaces:**
- Produces in the protocol: `listProjectDirs` (no params) resolving `{ dirs: { path: string; lastActive: number | null }[] }`, and `removeSession { sessionId }` resolving `{}` and broadcasting `sessionRemoved`.
- `listProjectDirs` returns the folders directly under `~/projects` and `~/code`, plus every `projectDir` of a known session, without duplicates, sorted by `lastActive` (the newest `stateSince` of that folder's sessions) and then by path.
- `removeSession` stops the session as `stopSession` does, deletes it from the hub's state, and removes its settings file.
- The CLI gets `orfoni rm <session>`, and the README's `--via` example uses `"$HOME/.local/bin/orfoni-hub" connect`.

- [ ] **Step 1: Write the failing tests.** `listProjectDirs` lists a folder under a fake home's `projects` and a session folder outside it, once each, newest first. `removeSession` kills the tmux session, broadcasts `sessionRemoved`, and the session is gone from `listSessions` and from `state.json`. `parseArgs(['rm', 'ab'])` gives the remove command.
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.** The hub takes its home directory from `HubOptions` so tests use a temporary one.
- [ ] **Step 4: Run `npm test` and `npx tsc -b` and confirm they pass.**
- [ ] **Step 5: Commit** with the message `Let clients list project folders and remove sessions`.

### Task 3: Client state

**Files:**
- Create: `app/src/lib/transport.ts`, `app/src/lib/hub-client.svelte.ts`, `app/src/lib/fake-transport.ts`
- Test: `app/src/lib/hub-client.test.ts`

**Interfaces:**
- `transport.ts`:
  - `interface HubTransport { send(line: string): void; onLine(listener: (line: string) => void): void; onStatus(listener: (status: ConnectionStatus) => void): void; close(): void }`
  - `type ConnectionStatus = { kind: 'connecting' } | { kind: 'connected' } | { kind: 'reconnecting'; attempt: number; error: string } | { kind: 'failed'; error: string }`
  - `interface TerminalTransport { open(target: string, cols: number, rows: number): Promise<TerminalStream> }` and `interface TerminalStream { write(data: Uint8Array): void; resize(cols: number, rows: number): void; onData(listener: (data: Uint8Array) => void): void; onExit(listener: () => void): void; close(): void }`
- `hub-client.svelte.ts`: `class HubClient` built on a `HubTransport`, with `$state` fields `status`, `sessions: Map<SessionId, SessionSummary>`, `projects` (sessions grouped by `projectDir`, each group sorted by `stateSince`, newest first), `selected: SessionId | null`, and `chats: Map<SessionId, ChatItem[]>`; and the methods `request(method, params)`, `select(sessionId)`, `send(sessionId, text)`, `decide(requestId, decision)`, `interrupt`, `stop`, `remove`, `startSession`, `openShell`, and `listProjectDirs`.
- Chat items are upserted by identity: `id` for `user`, `assistant`, and `notice`, `toolUseId` for `tool`, and `requestId` for the request kinds. A `sessionUpdated` whose `claudeSessionId` differs from the known one clears that session's chat. After a transport reconnect the client re-runs `listSessions` and re-opens the selected session.
- `send` while the session is `needs_approval` or `needs_answer` rejects with `not_ready` without calling the hub, so the composer can keep the text.

- [ ] **Step 1: Write the failing tests** against `FakeTransport`, which records sent lines and lets a test push hub lines: grouping and order of `projects`, upsert of a streaming assistant item into one item, a changed `claudeSessionId` clearing the chat, request and response correlation by `id`, `send` refused with `not_ready` in `needs_approval`, and a reconnect re-running `listSessions` and `openSession` for the selected session.
- [ ] **Step 2: Run `npx vitest run app` and confirm the tests fail.**
- [ ] **Step 3: Implement `transport.ts`, `hub-client.svelte.ts`, and `fake-transport.ts`.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** with the message `Keep the app's view of the hub in one client`.

### Task 4: Development bridge and browser transports

**Files:**
- Create: `tools/dev-bridge/package.json`, `tools/dev-bridge/bridge.mjs`, `app/src/lib/ws-transport.ts`, `app/e2e/playwright.config.ts`, `app/e2e/app.spec.ts`
- Test: `app/src/lib/ws-transport.test.ts`

**Interfaces:**
- `bridge.mjs` listens on `127.0.0.1:4790`. A WebSocket on `/hub` spawns the hub command and relays text lines both ways. A WebSocket on `/terminal?target=<name>&cols=<n>&rows=<n>` spawns `tmux -L orfoni attach -t <name>` in a `node-pty` PTY, relays binary frames both ways, and treats a text frame `{"resize":[cols,rows]}` as a resize.
- `ws-transport.ts` implements `HubTransport` and `TerminalTransport` over those WebSockets, with the same reconnect behavior as the Tauri transport.
- `app.spec.ts` starts with one check, `the session list loads`, which opens the app served by Vite with `?transport=ws`, and expects every session from `orfoni list` to appear.

- [ ] **Step 1: Write the failing tests.** `ws-transport.test.ts` runs against a WebSocket server started in the test: lines arrive split and joined correctly, and a dropped socket reports `reconnecting` and reconnects.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the bridge and the transports.** Install Playwright's Chromium with `npx playwright install chromium`.
- [ ] **Step 4: Run the unit tests and confirm they pass.** Run `npx playwright test -c app/e2e` with the bridge and Vite running and confirm `the session list loads` fails until Task 5 renders the list.
- [ ] **Step 5: Commit** with the message `Add a development bridge and browser transports`.

### Task 5: Chat interface

**Files:**
- Create under `app/src/lib/ui/`: `Sidebar.svelte`, `SessionRow.svelte`, `ChatView.svelte`, `Bubble.svelte`, `Markdown.svelte`, `ToolCard.svelte`, `ApprovalCard.svelte`, `QuestionCard.svelte`, `PlanCard.svelte`, `Composer.svelte`, `SessionHeader.svelte`, `NewSessionDialog.svelte`, `StatusBar.svelte`, `theme.css`
- Modify: `app/src/App.svelte`
- Test: `app/src/lib/ui/*.test.ts` for the rules below

**Interfaces:**
- Consumes: `HubClient` (Task 3).
- The sidebar groups sessions by project folder, shows each session's state as a coloured dot with a text label for screen readers, its title or first prompt, and how long ago its state changed. Sessions that need you come first within a group.
- The chat shows user items as right-aligned bubbles and assistant items as left-aligned markdown that grows while it streams. Markdown goes through marked and DOMPurify.
- A tool card shows the tool name and a one-line summary (the command for Bash, the file path for Read, Write, and Edit), collapsed by default. Opened, it shows the input and at most the first 200 lines of the output, with a note of how many lines were left out.
- An approval card shows Allow, Always allow, and Deny. A question card shows each question with its options as buttons, and checkboxes for `multiSelect`. A plan card renders the plan as markdown with Approve and Reject. A card that is no longer pending shows its outcome and no buttons.
- The composer sends on Enter, adds a newline on Shift+Enter, and keeps its text when a send fails, showing the reason under it.
- The header shows the title, state, and the buttons Terminal, New shell, Interrupt (while working), Stop, and Remove (with a confirmation that names the session).
- The new session dialog picks a folder from `listProjectDirs` or a typed absolute path, a first prompt, a model, and a permission mode, and shows the trust hint when `needsTrust` is true.
- Load the frontend-design skill before writing the styles. Light and dark themes follow the system setting.

- [ ] **Step 1: Write the failing tests** for the rules above that a component test can see: tool output cut at 200 lines with the count of left-out lines, a non-pending card without buttons, the composer keeping text on a rejected send, and the sidebar putting `needs_approval` before `idle` within a group.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the components.**
- [ ] **Step 4: Run the tests and the Playwright check from Task 4 and confirm they pass.** Take a screenshot of the chat with a real session and look at it.
- [ ] **Step 5: Commit** with the message `Show sessions as chats`.

### Task 6: Terminal panel

**Files:**
- Create: `app/src/lib/ui/TerminalPanel.svelte`
- Modify: `app/src/lib/ui/SessionHeader.svelte`, `app/src/App.svelte`
- Test: `app/src/lib/ui/TerminalPanel.test.ts`

**Interfaces:**
- Consumes: `TerminalTransport` (Task 3).
- Terminal and New shell open a panel with one xterm.js instance per open terminal, loaded with the fit, unicode11, and webgl add-ons. The webgl add-on is disposed on context loss and the DOM renderer takes over.
- The panel measures its size with the fit add-on before it opens the stream, and passes that size to `open`, so tmux draws at the right size from the first byte.
- A closed panel closes its stream and disposes its xterm instance.

- [ ] **Step 1: Write the failing test:** opening the panel calls `open` with the size the fit add-on measured, and closing it calls `close` on the stream.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement the panel.**
- [ ] **Step 4: Run the test and confirm it passes.** Then open a terminal in the browser build, type `echo panel-$((6*7))`, and see `panel-42`.
- [ ] **Step 5: Commit** with the message `Open a terminal into a session`.

### Task 7: SSH core in Rust

**Files:**
- Create under `app/src-tauri/src/`: `ssh.rs`, `known_hosts.rs`, `terminal.rs`, `settings.rs`
- Create: `app/src-tauri/tests/ssh.rs` with a test helper that starts a private `sshd` on a free port of 127.0.0.1, with temporary host and client keys and `UsePAM yes`
- Modify: `app/src-tauri/Cargo.toml`

**Interfaces:**
- `ssh.rs`: `struct Connection` with `async fn connect(settings: &Settings, passphrase: Option<&str>, known_hosts: &KnownHosts) -> Result<Connection, SshError>`, `async fn open_hub(&self) -> Result<HubChannel, SshError>`, and `async fn open_terminal(&self, target: &str, cols: u32, rows: u32) -> Result<TerminalChannel, SshError>`. `SshError` distinguishes `HostKeyUnknown { fingerprint }`, `HostKeyChanged { expected, found }`, `PassphraseNeeded`, `AuthFailed`, `Io`, and `Closed`.
- `HubChannel` exposes an async stream of complete lines and a `send(line)`. `TerminalChannel` exposes an async stream of byte chunks, `write`, `resize`, and `close`, owned by one task with a queue.
- `known_hosts.rs`: `KnownHosts` stored as JSON in the app data directory, keyed by `host:port`, holding the SHA-256 fingerprint.
- A dropped connection is retried with backoff of 1, 2, 4, 8, and then every 15 seconds, and reported to the UI as `reconnecting`.

- [ ] **Step 1: Write the failing integration tests** against the private sshd: the first connection to a new host fails with `HostKeyUnknown` and succeeds once the fingerprint is stored; a changed host key fails with `HostKeyChanged`; the hub channel relays a line to a stub hub command (`cat`) and back; a terminal channel running `sh` echoes `term-$((6*7))` as `term-42` and accepts a resize; killing the sshd makes the hub stream end with `Closed`.
- [ ] **Step 2: Run `cargo test --manifest-path app/src-tauri/Cargo.toml` and confirm they fail.**
- [ ] **Step 3: Implement the modules.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** with the message `Connect to the VPS over SSH from Rust`.

### Task 8: Tauri commands and transport

**Files:**
- Create: `app/src-tauri/src/commands.rs`, `app/src/lib/tauri-transport.ts`
- Modify: `app/src-tauri/src/lib.rs`, `app/src/main.ts`
- Test: `app/src/lib/tauri-transport.test.ts`

**Interfaces:**
- Commands: `connect(passphrase?: string)` returning the connection status or a host-key or passphrase question, `trust_host(fingerprint)`, `hub_send(line)`, `terminal_open(target, cols, rows, onData: Channel)` returning a terminal ID, `terminal_write(id, data)`, `terminal_resize(id, cols, rows)`, `terminal_close(id)`, `settings_get()`, and `settings_set(settings)`. Hub lines and status changes reach the UI through a `Channel` passed to `connect`.
- `tauri-transport.ts` implements `HubTransport` and `TerminalTransport` on those commands. The UI picks it when `window.__TAURI_INTERNALS__` exists and the WebSocket transport when the URL has `?transport=ws`.

- [ ] **Step 1: Write the failing test** for `tauri-transport.ts` with `@tauri-apps/api/mocks`: a hub line pushed through the mocked channel reaches `onLine`, and `send` invokes `hub_send` with the line.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Implement the commands and the transport.**
- [ ] **Step 4: Run the test and confirm it passes.** Then build the Linux debug app, start it under Xvfb against the private sshd from Task 7 with a fake home that has the hub, and capture a screenshot that shows the session list.
- [ ] **Step 5: Commit** with the message `Wire the app to the SSH core`.

### Task 9: Settings and first connection

**Files:**
- Create: `app/src/lib/ui/SettingsView.svelte`, `app/src/lib/ui/HostKeyDialog.svelte`, `app/src/lib/ui/PassphraseDialog.svelte`
- Test: `app/src/lib/ui/SettingsView.test.ts`

**Interfaces:**
- The first start shows the settings: host, port (default 22), user (default `root`), key path (default `~/.ssh/id_ed25519`, with a file picker), and hub command (default from the Global Constraints).
- A `HostKeyUnknown` result shows the fingerprint and asks to trust it. A `HostKeyChanged` result shows both fingerprints and offers no way to continue. A `PassphraseNeeded` result asks for the passphrase.

- [ ] **Step 1: Write the failing tests:** an empty host blocks saving, and the changed-key dialog has no continue button.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the views.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** with the message `Set up the connection on first start`.

### Task 10: Windows build

**Files:**
- Create: `.github/workflows/windows.yml`
- Modify: `README.md`

**Interfaces:**
- The workflow runs on `workflow_dispatch` and on tags `v*`, on `windows-latest`, installs Node 22 and stable Rust, runs `npm ci`, `npm test`, and builds the app with `tauri-apps/tauri-action`, and uploads the NSIS installer as an artifact.
- The README explains how to install and set up the app on Windows.

- [ ] **Step 1: Write the workflow and check it with `actionlint` if available, else by reading it against the tauri-action documentation.**
- [ ] **Step 2: After Manuel agrees to the push, run it with `gh workflow run windows.yml` and confirm the artifact appears.**
- [ ] **Step 3: Commit** with the message `Build the Windows installer on GitHub Actions`.

### Task 11: End-to-end checks in the browser

**Files:**
- Modify: `app/e2e/app.spec.ts`

Each check runs the browser build through the development bridge against the installed hub with real Claude Code sessions on the `haiku` model.

- [ ] **Step 1: Write the checks.**
  - `start a session and see the reply as a bubble`
  - `allow an approval from its card`
  - `answer a question from its card`
  - `approve a plan from its card`
  - `a message waiting on an approval keeps its text`
  - `interrupt a running turn`
  - `a prompt typed in the terminal shows up in the chat`
  - `remove a session`
  - `reconnect after the bridge restarts without duplicated items`
- [ ] **Step 2: Run `npx playwright test -c app/e2e` and confirm every check passes.**
- [ ] **Step 3: Commit** with the message `Add end-to-end checks for the app`.
