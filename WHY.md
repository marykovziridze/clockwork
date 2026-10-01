# Why Clockwork works this way

Each part below exists because something went wrong in a real project. Lesson IDs (L##) point to the author's build notes, which are not part of the kit. Docs are at code.claude.com/docs/en/, read 2026-09-30 against Claude Code 2.1.285.

## Mechanisms

**AGENTS.md plus a 2 KB CLAUDE.md.** One short rules file for every tool. CLAUDE.md starts with `@AGENTS.md` because Claude Code skips AGENTS.md whenever a CLAUDE.md exists (docs: memory, "AGENTS.md"). The v1 "42k chars" ceiling had no source; each session read 155-275 KB first. L128, L129, L114.

**clockwork.json.** Project settings (stack, folders, size budgets, production commands) are data, not code. The v1 doctor was hand-edited per project and broke on 2 of 4 layouts. L120.

**registry.mjs (the only writer of registry rows).** Sessions minting IDs at the same time reused numbers and overwrote each other's rows. The tool takes a lock, re-reads, checks and writes in one step. Backups get a new folder every time. Rotation moves only done rows to the archive file. guard-edit and guard-bash ask before a hand edit or shell write onto a registry (deny overnight). L02, L04, L16, L107, L115, L116.

**Status markers, including 🚀 LIVE-UNVERIFIED.** "Shipped because the user said so" and "checked by a verifier" must look different. L38.

**OPEN-ASKS and APPROVAL-QUEUE.** Asks the user made in chat got lost. Verified work reached the client without the user's look. L18, L137.

**clockwork-doctor (Stop hook and command).** The doctor checks what prose could not: branches without a task row, IDs that exist only in a counter, sizes of every must-read file, aging, and iCloud duplicate copies. It exits non-zero on a crash; v1 reported success. L03, L113, L114, L118, L119, L121, L124.

**session-start hook.** Each session starts knowing where it is (main copy or worktree), how far behind origin it is, which peer sessions are live, and what the doctor found. Work had started stale and blind to peers. L06 (docs-backed: cross-session-messaging, `claude agents --json`), L10, L118.

**guard-bash hook.** In one shared checkout, `git add -A` sweeps and whole-folder deploys reverted other sessions' work four times in one day. A PreToolUse hook (runs before each shell command) stops it; prose did not. In a shared main checkout, `reset --hard`, `clean -f` and a `restore` of any folder or registry file are asked about: they destroy every session's uncommitted work. Overnight it also blocks production deploys (Vercel, gh, `commands.productionDeploy`, deploy scripts) and uploads (e.g. curl, wget, scp, rsync, ssh). guard-edit asks before a code edit in the main checkout while other worktrees exist, or of a file another session claimed. Overnight, every ask is a deny. A seatbelt, not a wall: it misses a command built at run time, and reads a script only if an interpreter runs it (`bash up.sh`, not `./up.sh`). Permissions and auto mode are the other layers. L01, L101, L23, L29 (partly holds; backed by the permissions docs).

**Worktree per session and the claim message.** "One branch per task" does not help when there is one checkout. Each code-editing session gets its own worktree (`claude -w`; docs: worktrees) and tells peers which files it holds. L01, L05, L07, L19.

**prompt-intake hook and intake skill.** v1 asked, in prose, for pasted client material to be logged. It did not happen. Now a hook spots a paste and the skill saves the raw source once, pulls quote-backed items, and routes each to a row. L139-L145, L18.

**verify skill, verifier and checker agents, measure.js.** Builders' screenshots and "done" claims were often wrong, so closure needs a fresh verifier. It checks the browser is really showing the page, runs a check that can fail, and reads rendered values, never class names. L37, L39, L54, L55, L56, L59, L60, L63.

**design-system.md as a table.** v1 appended every ruling, so files grew to 45-260 KB, one rule written four times. A table of current rules, each with a number and a method, is rewritten in place. L80, L81, L88, L94. P1 and P2 are two live projects, not named. Project rows ship no spacing numbers (tokens are per project); where the author's design standards and P1/P2 disagree (hover, backplates, OKLCH vs hex) the row says "decide per project" (D14). BAN-1 bans pills and glass unless a row allows it. 2026-10-01, blank is not skip: sourced Baseline floors (M3, WCAG, Apple HIG, installed design skills) hold each unfilled row they back, so a page with no padding cannot pass. Budget 16 KB (project 20/28 KB): loads only for UI files.

**rules/engineering.md.** v1 ENGINEERING §B (no `any`, validated input, server-side secrets, translated strings) had been dropped; it comes back path-scoped to code files. Source: the author's engineering standards, "Code rules" and "Git & flow".

**Stack profiles.** v1 assumed Next.js + Supabase + Vercel; a live project was WordPress. Traps now live per stack. L112.

**Overnight skill and overnight.sh.** The old launcher was a one-night script that could not run again. The kit launcher checks power, auto mode and a preview route, keeps the Mac awake, holds a lock, writes a heartbeat log, and starts a plan with a measurable end state and a stop time. Client connectors are denied from `~/.claude/clockwork-overnight-deny.json`, not from the kit file every client repo carries. Plan, ledger and scratch live in `PM/`: `.claude/` is a protected path (docs: permission-modes), prompted by day, classifier-judged at night. L24, L25, L27, L28, L31, L32.

**Handover and pre-send skills.** Work in flight needs a resume table others can act on. Anything to a client is first checked against its source and against what was already sent. L146, L147, L148. (L33's fixed section list did not hold.)

**Installer with manifest, VERSION and CHANGELOG.** Project forks of the v1 doctor drifted ahead of the kit with no way back. A manifest tells kit files from local edits. The installer refuses synced folders by default, because git hangs on offloaded iCloud files. L122, L103.

**Onboarding, never an in-place install.** Live projects hold ratified rules, old counters and hundreds of documents (one had 551). `/clockwork-onboard` changes a staging copy, proves by a before/after count that nothing was lost, asks the user about conflicts, and applies only on their yes.

## Decisions (CONTRACT §10; do not re-open without new evidence)

- **D1 Every session mints IDs through registry.mjs**, not a single "minter" session. A lock is simpler than a role that must always be alive. L02.
- **D2 One worktree per code-editing session; registries only in the main copy**, written by tools. Tools resolve a worktree back to the main copy. L01, L04.
- **D3 Preview deploys are free after build and checks.** Production deploy or merge to main needs the user in that session, or 🚀 LIVE-UNVERIFIED with their reason. Never claim a verifier ran when it did not. L07, L38, L53. The author's working notes disagree here (L160: backend and content go live after the fresh pass without asking; elsewhere: ask before deploying). D3 asks, on purpose, and AGENTS.md lets the user give the go by setting `ship` in the session.
- **D4 The Stop hook blocks only on errors that appeared while this session ran**, once each. It cannot tell whose they are (one git user), so the block says a peer may own it: message that peer instead of editing. v1 re-blocked every turn on a size limit other sessions caused. L117 is contested, so old errors are reported, not blocked on. Under `/goal` every Stop has `stop_hook_active` set, so the doctor skips only right after its own block.
- **D5 Subagents and workflows only for independent slices**, by decision table. Models by alias (`opus`, `sonnet`, `haiku`): measure, then pin; no dated model IDs. Haiku 4.5 retires not sooner than 2026-10-15 (platform.claude.com model-deprecations, read 2026-09-30). L43; L42 partly failed verification, so the CLAUDE.md table is labelled unmeasured starting points. "Effort before more agents": Anthropic's cost guide (platform.claude.com optimizing-for-cost-and-intelligence). Official pages disagree on Haiku for subagents, so extraction starts on `sonnet`.
- **D6 Overnight = an interactive session in a Terminal.app window** (tmux is not installed), auto mode, overnight settings, `caffeinate` on mains power, `/goal … or stop at 06:00`, never `bypassPermissions`. Auto-continue after a usage-limit reset works only in interactive claude.ai-subscription sessions, and after ~30 min of sleep waits for Enter (docs: interactive-mode). A Remote Control session does not start that wait on its own, so the overnight settings turn Remote Control off. Auto mode pauses after 3 blocks in a row or 20 in total (permission-modes), so the heartbeat writes a STALLED line. The `/goal` ends when every Bucket 1 item is verified or flagged, not when one command passes. L24, L25.
- **D7 Tasks live in markdown registries** (one builder, many parallel sessions). A GitHub Issues workflow for teams is a separate product.
- **D8 Design rules live only in `.claude/rules/design-system.md`**, loaded for matching paths, rewritten in place; history goes to CLIENT `## Confirmed Decisions`. L80, L81.
- **D9 The user's personal communication rules stay in `~/.claude/`.** AGENTS.md must be safe to show a client and work with any tool.
- **D10 Builder screenshots are iteration evidence only.** Closure = a fresh verifier AND, for visual work, the user's look. Neither replaces the other. L37, L58.
- **D11 Placeholder content must be impossible to publish** (flagged in data), not banned by text search. L98.
- **D12 CLAUDE.md starts with `@AGENTS.md`.** Verified in the memory docs (reading AGENTS.md needs v2.1.277+).
- **D13 A project may keep `.claude/` gitignored.** `.worktreeinclude` copies the kit into each `claude -w` worktree (without it no hooks run there; tested 2.1.285); tools are called by absolute path. **D15, D16** Live projects move to 2.0 only through `/clockwork-onboard`, which runs in any project.

## What changed from v1

| v1 part | Where it went |
|---|---|
| project-clockwork-playbook.md (53 KB) | template files under `templates/`; reasons here |
| Part A folder skeleton, Part B day-0 checklist | `install.mjs` |
| Part C DOC-MAP / ROUTING / FACTS templates | `templates/registries/` |
| Part C DESIGN-SYSTEM (append-only) | `rules/design-system.md` (table, rewritten in place) |
| Part D registry conventions, rotation | `rules/registries.md` + `registry.mjs` (mint, rotate, backup) |
| Part G maintenance | doctor checks + session-start summary |
| Part H enforcement block (prose) | hooks: guard-bash, guard-edit, prompt-intake, session-start, Stop doctor |
| Part I lessons learned | this file (links, no stories) |
| Part J clockwork-doctor | `hooks/clockwork-doctor.mjs` (config-driven, fails honestly) |
| Part K + ENGINEERING.template.md | `AGENTS.md` hard rules + `rules/stack-*.md` |
| "separate branches = zero collision" | removed; replaced by worktree per session + claim message |
| TOOLING.md | removed; README lists what is wired |
| not in v1 | overnight, intake, verify, handover, pre-send, agents, workflows, OPEN-ASKS, APPROVAL-QUEUE |
