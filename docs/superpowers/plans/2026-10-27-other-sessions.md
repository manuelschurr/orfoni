# Other sessions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List the Claude Code sessions orfoni did not start under their project folder, show their chat read-only, and port one into orfoni, which ends its process and resumes the conversation in an orfoni session.

**Architecture:** The hub reads Claude Code's session registry in `~/.claude/sessions/` every 5 seconds and broadcasts the list of other sessions. `openOtherSession` reads a session's transcript through the existing history reader. `portSession` checks the session, ends it with SIGTERM, waits for it to exit, and starts an orfoni session with `--resume=<id>`. The app shows other sessions in the sidebar and a read-only view with a Port button.

**Tech Stack:** as in milestones 1 to 3.

**Spec:** `docs/design.md`, section "Other sessions". The protocol is already on main in commit 6e2ac75: `OtherSession`, `listOtherSessions`, `openOtherSession`, `portSession`, and the `otherSessions` broadcast, with the app's result shapes in `app/src/lib/hub-client.svelte.ts`.

## Global Constraints

- The registry is `~/.claude/sessions/*.json`, one file per running Claude Code process. Read only these fields: `pid`, `procStart`, `sessionId`, `cwd`, `name`, `status`, `statusUpdatedAt`, `startedAt`, `kind`, `tmux`. Never use `messagingSocketPath` or any other internal channel.
- An entry is live only when `/proc/<pid>/stat` exists and its 22nd field equals `procStart`. Anything else is skipped and never signalled.
- A file that does not parse is skipped. A missing registry folder means no other sessions. The hub logs a registry problem once, not every 5 seconds.
- `status` maps `idle` to `idle` and every other value to `busy`. `tmux` is the text before the first `:` of the registry's `tmux` field (`swarm:@0.%14` gives `swarm`), or null. `background` is `kind === 'bg'`. `statusSince` is `statusUpdatedAt`, or `startedAt` when that is missing.
- orfoni's own sessions are never other sessions: leave out entries whose `sessionId` is the `claudeSessionId` of an orfoni session, and entries whose tmux session name is `orfoni-<id>` for an orfoni session id.
- The hub reads the registry every 5 seconds and broadcasts `otherSessions` only when the list changed.
- `portSession` re-reads the registry entry for `pid` and refuses with `not_found` when it is gone or now on another conversation, and with `not_ready` when it is busy. Then it sends SIGTERM, waits up to 10 seconds for the process to exit, and refuses with `internal` if it is still alive, launching nothing. Then it starts an orfoni session in the entry's folder with `--resume=<claudeSessionId>`, the same settings file and hooks as every orfoni session, the requested permission mode, and the registry name as the orfoni title without a `--name` flag, because a resumed conversation keeps its Claude Code name. The result is `{ session, needsTrust }`, and the hub broadcasts the new session and the shorter list of other sessions.
- Process signalling and liveness go through injected functions, so unit tests never signal a real process.
- In live checks, port only a throwaway session the check started itself. Manuel's real sessions are in the same registry.
- No em dash characters in code, docs, UI text, or commit messages. Markdown paragraphs stay on one line.

## Review Focus

- A session that runs `/clear` between the list and the port is now on another conversation. Expect `not_found` and nothing signalled.
- A busy session. Expect `not_ready` and nothing signalled.
- A stale registry file, or a pid that was reused by another process. Expect it never listed and never signalled.
- A process that ignores SIGTERM. Expect an error after 10 seconds and no orfoni session.
- orfoni's own sessions, including in the seconds after a `/clear` before the hub learns the new conversation ID. Expect them never listed as other sessions.

---

### Hub tasks

- [ ] **H1. Registry reader** in `hub/src/others.ts`: read and parse the registry folder, check liveness, and map entries to `OtherSession`. Tests first, with registry files and `/proc` stat files in a temporary folder: a valid entry maps as the constraints say, an unparsable file is skipped, a dead pid and a reused pid are skipped, an unknown status reads as busy, and a missing folder gives an empty list.
- [ ] **H2. Listing and reading.** The hub polls the registry, leaves out its own sessions, broadcasts `otherSessions` on change, answers `listOtherSessions`, and answers `openOtherSession` with the session and its chat from `readHistory` and `normalizeHistory`, or `not_found`. Tests first: the broadcast happens once per change, orfoni sessions are left out by conversation ID and by tmux name, and the chat comes from the session's own transcript and folder.
- [ ] **H3. Porting** as the constraints say. Tests first for each refusal, for SIGTERM followed by the launch with `--resume=<id>`, the title, and the permission mode, for the 10 second timeout, and for the broadcasts after a port.
- [ ] **H4. Live check** in `hub/test/e2e.test.ts`: start `claude --model haiku` with a short prompt in a trusted scratch folder in its own tmux server, outside orfoni. Wait for it in `otherSessions`, open it and see its reply, port it, and expect an orfoni session whose chat holds the earlier reply, the old pane back at its shell, and the other session gone from the list. Run it against a hub instance with this branch's code, with its own runtime, state, and tmux socket, never the installed hub.

### App tasks

- [ ] **A1. Client state.** `HubClient` asks for `listOtherSessions` once connected, keeps the list current from `otherSessions` messages, and adds `openOther(pid)` and `port(other, permissionMode)`. Selecting an other session is separate from selecting an orfoni session. Tests first with the fake transport.
- [ ] **A2. Sidebar.** Other sessions appear inside their project folder's group, after the orfoni sessions, in a quieter style. A row shows the name or "Untitled session", where it runs (`tmux swarm`, `background`, or `no tmux`), busy or idle in words for screen readers, and the time since `statusSince`. Tests first.
- [ ] **A3. Other session view.** A header with the name, folder, where it runs, busy or idle, and a "Port into orfoni" button, disabled while busy with a reason. Below it the chat, read-only through the same item components as an orfoni session, reloaded when `statusSince` changes. If the session disappears from the list, the view says it ended. The port dialog says that orfoni ends the session where it runs now and continues the conversation here, that unsent input there is lost, and offers the permission mode field from the new session dialog, shared as one component, starting on Auto. A successful port selects the new orfoni session. Tests first.
- [ ] **A4. Checks.** Component tests for A1 to A3. A Playwright check that starts a throwaway `claude` outside orfoni, sees it under its folder, ports it, and lands in the new orfoni session. It runs once the hub work is merged and installed.
