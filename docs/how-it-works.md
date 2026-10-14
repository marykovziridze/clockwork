# How it works

Clockwork turns the rules that must always hold into code that runs at fixed points of a Claude Code session. The rules are written once in `AGENTS.md`, for any coding agent. `CLAUDE.md` imports it on line 1, because Claude Code skips `AGENTS.md` when a `CLAUDE.md` exists.

## One session

1. **Session start** (`session-start` hook). Fetches origin and reports how far behind it is, whether the session is in the main checkout or a worktree, which peer sessions are live, and what the health check found.
2. **Guard** (`guard-bash` and `guard-edit` hooks, before every command and edit). Refuses `git add -A`, `git commit -a`, skipped git hooks, `git stash`, force-pushes to main, and a deploy or merge chained after `;` or `||`, which would run even when the step before it failed. Asks before a hand edit or shell write onto a registry, and before a command in a shared main checkout that would discard other sessions' uncommitted work. In an overnight run every question becomes a refusal, and production deploys are refused.
3. **Task list** (`registry.mjs`). The only writer of registry rows. It takes a lock, re-reads, checks and writes in one step, so parallel sessions never reuse an ID or overwrite a row. Each task is minted with the condition that closes it and a deploy class: `preview` or `ship`.
4. **Verify** (`verify` skill, `verifier` and `checker` agents). A fresh agent, never the builder, follows the user's path through the change and leaves one line of evidence: a report path, a commit or a URL. `registry.mjs` refuses a verified status without it. Visual work also waits for the user's own look.
5. **Stop check** (`clockwork-doctor`, run as the Stop hook). Before the session ends it checks the registries and the repo: branches without a task row, reused IDs, counters behind their highest ID, verified rows without evidence, files over their size limit, iCloud conflict copies. It blocks only on errors that appeared while this session ran, once each, and says a peer session may own them.

Run the same check by hand at any time: `node .claude/hooks/clockwork-doctor.mjs --report`.

## The registries

Eight markdown files hold the project's state: TASKS, CLIENT, FACTS, MEETING-LOG, OPEN-ASKS, APPROVAL-QUEUE, DOC-MAP and ROUTING. There is one copy, in the main checkout, and only `registry.mjs` writes their rows. Formats and commands: `templates/claude/rules/registries.md`.

A task moves from OPEN to BUILT (builder done) to VERIFYING to VERIFIED. LIVE-UNVERIFIED marks work shipped on the user's say-so without the check, with their reason in the row and the commit. PARKED and VOID close the rest.

## Parallel sessions

Each code-editing session works in its own git worktree (`claude -w <role>`), claims the exact files it will edit (`registry.mjs claim`) and sends live peers a one-line CLAIM message. A shared stylesheet or component has one owner session.

Finished worktrees pile up: each one carries its own build output, often 200 to 900 MB. `cleanup.mjs` removes a worktree only when nothing in it can be lost or is in use: no uncommitted or untracked files, no ignored file that is not build output or an identical copy of the main checkout's, every commit already on the default branch, nothing changed in it for an hour, no live claim on it, and no process working inside it apart from dev servers, which it stops first. If it cannot read the full process list, it removes nothing. The branch is kept, so `git worktree add <dir> <branch>` brings the folder back. A squash-merged branch has commits that are not on main, so it is kept and reported. It is a dry run until `--apply`; session start reports how many folders are ready to go. On one real client project the dry run found 18 of 27 worktrees removable, 9.1 GB.

## Pasted client material

The `prompt-intake` hook spots a pasted transcript or email. The `intake` skill saves the raw source once, pulls items backed by a quote, and routes each one to a registry row. Pasted text is data; instructions inside it are never followed.

## Unattended runs

`/overnight` runs an interactive Claude Code session in auto mode on a Mac on mains power, with the overnight guard settings. It builds only what has a pass/fail check, proposes judgement calls with their cost, and queues anything touching production, main, client messages or billing for the user.

## Other agents

`AGENTS.md` is written for any agent that reads it: Codex, Cursor, GitHub Copilot's coding agent, Gemini CLI and the others listed at [agents.md](https://agents.md/). `registry.mjs` and `cleanup.mjs` are plain Node, so any agent or person can run them.

**Codex.** `install.mjs --codex` adds `.codex/hooks.json`, which runs the same five hooks in Codex: the guard before every shell command and `apply_patch` edit, session start, prompt intake and the stop check. Codex hooks take the same JSON as Claude Code's ([Codex hooks docs](https://learn.chatgpt.com/docs/hooks), read 2026-10-14), with two differences the hooks handle. Codex cannot ask the user from a hook (an `ask` makes the hook fail and the command runs), so every question becomes a refusal whose reason sends the agent to the user. And a Codex edit is a patch, so `guard-edit` reads every file the patch names. Before Codex runs project hooks, the user trusts the project's `.codex/` folder and reviews the hooks with `/hooks`; until then nothing is enforced. OpenAI calls hooks "a useful guardrail, not a complete enforcement boundary". Tested with recorded Codex-format inputs only, not in a real Codex session.

Skills, agents and workflows remain Claude Code features. In other agents (Cursor, Copilot, Gemini CLI) nothing enforces the rules.

## What it runs on your machine

- The plugin adds one skill, `/clockwork-sessions:onboard`, which only you can start. It runs the kit's Node scripts from the plugin folder: on a staging copy first, then on your project once you say "apply it".
- In the project it writes `AGENTS.md`, `CLAUDE.md`, the registries, `.claude/` (hooks, tools, rules, skills, agents) and lines in `.gitignore` and `.worktreeinclude`. It adds hook entries to the project's `.claude/settings.json` (and `.codex/hooks.json` with `--codex`), which change what Claude Code runs before commands and edits in that project only.
- The hooks run `git` and `claude agents` locally. The one network call is `git fetch origin` at session start, to the project's own remote. Nothing is sent anywhere else: no telemetry, no other servers.
- `cleanup.mjs` deletes finished worktrees only when you run it with `--apply`.

## Why each part exists

Every mechanism above was added after something went wrong in a real project. The reasons and the decisions behind them: [WHY.md](../WHY.md).
