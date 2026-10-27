# Model and effort implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the model and effort level each orfoni session runs on, keep them current when they change, and let Manuel change them from the app, at start, when porting, and while the session runs (Manuel, 2026-10-27: "show model and effort, and let me adjust it").

**Architecture:** The hub learns both from Claude Code's status line, the documented JSON that Claude Code pipes to a status line command, which carries `model.id`, `model.display_name`, and `effort.level`, the live value that follows `/model` and `/effort`. Each orfoni session's settings file gets a `statusLine` whose command copies that JSON to the hub and then pipes it into the status line command Manuel already uses, so his status line in the terminal stays as it is. The app changes a running session's model or effort by sending `/model <alias>` or `/effort <level>` through `send`, the same commands he would type. New sessions take `--model` and `--effort`, and so do ported ones.

**Tech Stack:** as before.

**Spec:** this plan and `docs/design.md`. The protocol is on main: `Effort`, `SessionSummary.model` and `SessionSummary.effort` (null until Claude Code first reports), `startSession.effort`, and `portSession.model` and `portSession.effort`. The hub's `summary()` returns null for both until H1 fills them.

## Global Constraints

- A spike on 2026-10-27 (`claude --model haiku --effort low --settings <file>` in its own tmux server) showed: the wrapped status line still printed Manuel's line (`Haiku 5.5 | effort: low | ...`); the copy reached the file within seconds of start with `model.display_name` `Haiku 5.5` and `effort.level` `low`; after `/effort high` and then `/model sonnet` typed in the terminal, the copies said `high` and then `Sonnet 5.5` with `high` kept, each within 7 seconds with `refreshInterval: 5`.
- The status line command is `input=$(cat)`, then the input posted to the hub socket at `http://localhost/status` with `curl -sS -m 1 --unix-socket '<socket>' -H 'Content-Type: application/json' -H "X-Orfoni-Session: $ORFONI_SESSION" --data-binary @-`, its output and errors discarded and its failure ignored, then the input piped into the original command, whose output is the status line. Without an original command it prints nothing. `refreshInterval` is 10 seconds.
- The original command is the `statusLine.command` of the first of these that has one: `<projectDir>/.claude/settings.local.json`, `<projectDir>/.claude/settings.json`, `<home>/.claude/settings.json`. A file that is missing or does not parse is skipped. Manuel's is `/root/.claude/statusline.sh`, which takes about 0.06 seconds.
- The hub accepts a status line post only from a known orfoni session, parses `model.id`, `model.display_name`, and the optional `effort.level` at the boundary, ignores everything else in it, and broadcasts `sessionUpdated` only when the model or effort changed. Both are shown, not stored: after a hub restart they come back with the next refresh.
- The model aliases are `fable`, `opus`, `sonnet`, and `haiku` (from `claude --help`). The effort levels are `low`, `medium`, `high`, `xhigh`, and `max`. Labels: Fable, Opus, Sonnet, Haiku; Low, Medium, High, Extra high, Max. A model id that matches no alias still shows its display name.
- Changing a running session sends `/model <alias>` or `/effort <level>` through `send`, and only while the session is idle or answered.
- No em dash characters anywhere. Markdown paragraphs stay on one line.

## Review Focus

- A project whose own settings define a status line. Expect that one wrapped, not Manuel's user one.
- The hub is down or slow. Expect the terminal's status line to appear as before, never blocked or broken by the copy.
- A model that does not support effort. Expect no effort shown and no effort control that sends a level the model ignores.
- A session changed from the terminal. Expect the app to follow within the refresh interval.
- A status line post for a session the hub does not know, or with a body that does not parse. Expect it ignored, with nothing logged more than once.

---

### Hub tasks

- [ ] **H1. Status line.** `hookSettings` takes the original command and adds the wrapped `statusLine`; the hub finds the original command at launch as the constraints say; `hook-server` routes `POST /status` to the hub; the hub applies the model and effort to the session and fills `summary()`. Tests first, including the exact command shape, the settings lookup order, and a post that changes nothing broadcasting nothing.
- [ ] **H2. Start and port flags.** `startSession` passes `--effort <level>`, and `portSession` passes `--model <model>` and `--effort <level>`. Tests first.
- [ ] **H3. Live check** in `hub/test/e2e.test.ts`: start a session with `--model haiku` and effort `low`, expect `Haiku` in the session's model name and effort `low`; send `/effort high` and expect `high` within 20 seconds.

### App tasks

- [ ] **A1. Session header.** Show the model's display name and the effort label, and two compact selects to change them, enabled only while the session is idle or answered, sending `/model <alias>` or `/effort <level>`. A failed send says so. The values follow the hub's reports, so a change shows once Claude Code reports it. Tests first.
- [ ] **A2. Dialogs.** The new session dialog adds Fable to its models and an effort field that starts on Claude Code's default; the port dialog gets the same model and effort fields. The fields are shared components, as the permission mode field already is. Tests first.
- [ ] **A3. Checks.** Component tests for A1 and A2, and a Playwright check that changes a session's effort from the header and sees the new level there. It runs once the hub work is merged and installed.
