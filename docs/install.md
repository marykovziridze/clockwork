# Install and upgrade

Needs Claude Code, git and Node.js (tested on 24.14). Overnight runs need macOS. Clone the kit outside iCloud, for example to `~/dev/clockwork`: git hangs on files iCloud has offloaded.

Every run of `install.mjs` is a dry run (it prints the plan and writes nothing) until you add `--apply`. Below, `K="<kit folder>/install.mjs"`.

| Goal | Command |
|---|---|
| New project | `node "$K" "<project>" --stack nextjs` (or `wordpress`, `python`, `other`), then the same with `--apply` |
| Upgrade | `node "$K" "<project>" --apply`. Unedited kit files are replaced; edited ones are kept as conflicts (`--force-managed` backs up, then replaces) |
| Existing project | "Bring an existing project in" below; `--apply` refuses a project with its own records (decision D15 in WHY.md) |
| Registries in a sub-folder | add `--registry-dir "site/.claude"` and `--site-dir site` |
| `/clockwork-onboard` in every project | `node "$K" --global-skill --apply` (copies `onboard/` to `~/.claude/skills/`; backs up a changed one) |

Also `--project "Name"`. `--apply` refuses a synced folder (iCloud Drive, Desktop with iCloud sync, OneDrive, Dropbox) unless you add `--allow-synced`. Kit tools skip iCloud-offloaded files, because reading one can hang, and say so.

Exit codes: 0 ok, 1 refused or conflicts, 2 crashed. The installer never rewrites a project-owned file; it prints a `FIX` line instead.

**Commit (and push) before any `claude -w` session.** A worktree holds only committed files, from origin's default branch; `--apply` prints the command. A project may keep `.claude/` gitignored (D13): `.worktreeinclude` then copies the kit into each worktree.

## Bring an existing project in

Run `/clockwork-onboard` in the project. It handles three cases: a project on Clockwork v1, a project with its own documents, and a project with none. A project already on 2.0 or later gets sweep mode (documents only).

All work happens on a staging copy and ends in `ONBOARDING-PLAN.md` with questions. A before/after count proves nothing was lost. The real folder changes only after you say "apply it", with a backup.

## What lands in a project

- **Project-owned** (created once, never overwritten): `AGENTS.md`, `CLAUDE.md` (line 1 `@AGENTS.md`), `.claude/clockwork.json`, the registries (TASKS, CLIENT, FACTS, MEETING-LOG, OPEN-ASKS, APPROVAL-QUEUE, DOC-MAP, ROUTING), `.claude/rules/design-system.md`, `.claude/skills/intake/routing.md`.
- **Kit-managed** (replaced on upgrade, listed in `.claude/.clockwork-manifest.json`): `.claude/hooks/` (5), `tools/` (3), `agents/` (4), `skills/` (5), `workflows/` (3), `rules/` (registries, engineering, `stack-nextjs` or `stack-wordpress`), `overnight-settings.json`.
- **Merged** (lines only added): `.claude/settings.json` (hook wiring), `.worktreeinclude`, `.gitignore`.
- **Per Mac, in no repo**: `~/.claude/clockwork-overnight-deny.json`, deny rules for each client's own connectors.
