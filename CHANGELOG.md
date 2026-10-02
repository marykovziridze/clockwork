# Changelog

## 2.3.3 (2026-10-02)

**Added**
- `docs/benchmarks.md` and `benchmarks/`: three benchmarks run on real Claude Code sessions, each with its script and cleaned results. Parallel and overnight: Clockwork took the bad outcome from 4 of 4 and 3 of 4 runs to 0 of 4. Client memory: no difference when the notes sit in the repository. Build quality: no better than the same rules in one `CLAUDE.md`, at a higher cost.

## 2.3.2 (2026-10-02)

**Fixed** (found by running intake on a real model for the first time)
- Intake gave every task the deploy class `tbd`, which `registry.mjs` does not accept. Tasks now carry `preview` or `ship`: the extractor may set `deploy_class`, and `preview` is the default. A project's own older routing.md with `tbd` is mended when the plan is made.
- A promise to send something read "User approves: We owe: …", and one without a date ended in an empty "due". It now reads "User approves: …", and no "due" appears without a date. The due date also kept its space ("Sam · due …", not "Sam· due …").
- `registry.mjs append <ID> "…"` without `--text` was refused. Sessions wrote it that way in two separate live runs; it now works.
- 872 offline tests (869 pass, 3 skipped without `CLOCKWORK_LIVE=1`), run 2026-10-02.

## 2.3.1 (2026-10-01)

**Changed**
- The cycle figure in README.md is redrawn in the style of the launch film: bar ticks, and a hand that ticks round the dial and stops red one tick before Guard and Stop check, the two steps that can refuse. The motion is CSS inside the SVG, with no script; with reduced motion the hand stands still at Guard.

## 2.3.0 (2026-10-01)

**Added**
- `LICENSE` (MIT) and a public front page. README.md is rewritten around the cycle; the detail moved to `docs/` (install, how it works, test status, sharing a copy). The cycle figure ships in light and dark (`docs/assets/`), with its text as outlines.
- `publishAllow` in the private file: exact strings `publish.mjs` lets through although they hold a private term or word, such as the author's name on the LICENSE and the repo URL. Case-sensitive; the rest of the line is still checked.
- A test for the public pages: every relative link resolves, the figures carry no live text, and README.md, docs/ and LICENSE hold no emoji or em dashes.

**Changed**
- `AGENTS.md` for new projects: in agents other than Claude Code, where `$CLOCKWORK_TOOLS` is not set, the session writes the tools path out. Existing projects keep their own AGENTS.md.
- 871 offline tests (868 pass, 3 skipped without `CLOCKWORK_LIVE=1`), run 2026-10-01.

## 2.2.0 — 2026-10-01

**Changed**
- The kit names no person, client or company, so it can be shared. Kit files call the person who approves "the user" (approvals, the user's look, handover, "User approves: …" intake rows), and the intake type for questions to them is `question_for_user`. Project-owned files are never rewritten, so older projects keep their wording and still work: intake reads a routing row named `question_for_<name>`, and the registry treats a named look ("Sam's look") as open work.
- Onboarding has no special case for one company's team-kit folder any more. A project that keeps its tasks in GitHub Issues is mapped as a link, never copied into TASKS.md.
- Test fixtures use invented names. The live smoke tests read real project paths from `~/.claude/clockwork-private.json` (`$CLOCKWORK_PRIVATE`), never from the kit.
- `/clockwork-onboard`'s source default kit path is a placeholder; `install.mjs --global-skill` writes the real path, as before.

**Added**
- `publish.mjs`: pushes the committed kit to a git remote as one commit. It refuses while any published file or file name holds a `privateTerms` entry (anywhere), a `privateWords` entry (as a whole word) or the home folder path, and leaves out `_archive/` and `publishExclude` paths. Dry run by default; `--fresh` starts a new history.
- 866 offline tests (863 pass, 3 skipped without `CLOCKWORK_LIVE=1`), run 2026-10-01.

## 2.1.0 — 2026-10-01

**Added**
- iCloud offload handling across tools and hooks: a file iCloud has offloaded (size but no blocks on disk) is never read, because that read can wait forever. Each tool says which file and how to download it (`brctl download`). The guard hooks fail open with a one-line warning; overnight, guard-bash still denies on its built-in production checks and denies a script it cannot read.
- Baseline design floors in `rules/design-system.md`: sourced minimums (Material 3, WCAG, Apple HIG, installed design skills) that hold each unfilled project row. Minimums only; any layout is fine. Blank is not skip: the verifier measures them, so a page with no padding cannot pass.
- Craft lens in the verify workflow: a fresh reader judges how well the design is executed, never the design choice itself.
- Onboarding design-coverage gate: `onboard.mjs apply` refuses while a line of an old design file has no checked destination. It covers every design document discover lists (style and brand guides, design-tokens docs, a "Design System" folder) and a project's own `design-system.md`. When it cannot check, it says so and apply refuses.

**Changed**
- Tests no longer read live projects by default (`CLOCKWORK_LIVE=1` opts in), and a hung test fails after 3 minutes (`--test-timeout=180000`).

## 2.0.0 — 2026-09-30

Rebuilt from the v1 playbook into installable files. Reasons: `WHY.md`.

**Added**
- `install.mjs`: dry run by default, `--apply`, `--adopt` for v1 projects, a manifest of kit files, backups before any replace, refuses synced folders unless `--allow-synced`.
- Hooks: `session-start` (location, behind-origin, live peers, claimed files, doctor summary), `guard-bash` (blocks `git add -A`, `git commit -a`, `--no-verify`, `git stash`, force-push to main; overnight also blocks production commands, deploy scripts and scripts that upload), `guard-edit` (asks before a code edit in the main checkout while other worktrees exist), `prompt-intake` (spots pasted client material).
- `tools/registry.mjs`: the only writer of registry rows (mint, next, append, status, backup, rotate, check, show, list, line, report, claim, release) with a lock. `✅ VERIFIED` on a task needs evidence and a BUILT/VERIFYING row.
- `tools/overnight.sh` and the overnight skill: preflight, awake, lock, heartbeat log, `/goal` with a stop time.
- Skills: intake, verify, overnight, handover, pre-send. Agents: verifier, checker, builder, extractor. Workflows: verify-change, intake, build-slices. `tools/measure.js` for rendered-page checks.
- Registries: OPEN-ASKS, APPROVAL-QUEUE; status marker `🚀 LIVE-UNVERIFIED`.
- `clockwork.json` project config; `rules/engineering.md` (code rules, every stack); stack profiles for Next.js and WordPress; `.worktreeinclude`.
- `install.mjs --apply` prints the exact commit (and push) command; worktrees hold only committed files.
- Onboarding for existing projects (D15, D16): the `/clockwork-onboard` skill, `onboard/onboard.mjs` (discover, stage, census, compare, migrate, sources, rebase, apply) and the `onboard.js` workflow. Cases A (v1), B (own documents), C (none), and sweep mode for a project already on 2.0. Works on a staging copy; the real folder changes only on the user's "apply it", after a backup with `RESTORE.txt`. `install.mjs --global-skill --apply` installs the skill in `~/.claude/skills/` for every project.
- 745 offline tests (744 pass, 1 skipped without `CLOCKWORK_LIVE=1`), run 2026-09-30 with `node --test "<kit>/test/"`.

**Changed**
- CLAUDE.md is now 2 KB and starts with `@AGENTS.md`; the rules moved to AGENTS.md.
- The design system is a table in `.claude/rules/design-system.md`, rewritten in place, no longer append-only.
- The doctor reads its config, exits non-zero on a crash, and blocks at Stop only on errors the session created.
- Parallel sessions: a worktree per code-editing session and a claim message replace "separate branches = zero collision".

**Removed**
- The 53 KB playbook and ENGINEERING template as the source of rules (moved unchanged to `_archive/v1/`, with the v1 doctor template; not in shared copies).
- The unsourced "42k chars" CLAUDE.md ceiling.

**Fixed before release (review round 2)**
- Installer and doctor name a `.gitignore` line that ignores kit paths; the doctor errors when CLAUDE.md does not import AGENTS.md, and lists new archive, report and PM files in the registry commit command, with a different message for a worktree session.
- Claims compare one file however it is spelled or from whichever worktree; folders and globs cover what is under them; guard-edit asks before editing a file another session holds. `registry.mjs dedupe` fixes a duplicate ID without a hand edit; `line` keeps table rows inside their table.
- guard-bash also judges Monitor commands, asks before `reset --hard`/`restore .`/`clean -f` in a shared main checkout, and overnight blocks direct uploads (`curl -T`, wp-json writes, scp, sftp, rsync to a host, `wp --ssh`, `make deploy`).
- Overnight: the `/goal` names the plan file actually checked; plan, ledger and scratch moved from `.claude/` (protected) to `PM/`; client connector names left the kit file for `~/.claude/clockwork-overnight-deny.json`; the MCP check no longer claims to see claude.ai connectors.
- Skills: verify closes with one evidence-carrying `status` call, briefs the design source and states the cost; overnight names `build-slices` and `verify-change`; intake resumes a source saved but never routed and keeps a client ask's due date. Design rows MO-2, MO-3, CO-1, BAN-1 no longer contradict the ratified project rules.

**Fixed before release (review round 3)**
- A project may keep `.claude/` gitignored (D13): `.worktreeinclude` now carries the kit files (not the registries) into each `claude -w` worktree; install and the doctor never advise un-ignoring, ignore `!pattern` re-include lines from `git check-ignore -v`, and the doctor warns when a worktree's copy of rules or hooks differs from main. session-start prints the tools' absolute path and sets `$CLOCKWORK_TOOLS`.
- `install --apply` refuses a live project with its own records; onboarding (`/clockwork-onboard`) is the only way in (D15).
- One row rule for `registry.mjs` and the doctor: pointer rows, `✖ VOID — duplicate of` rows, `T-12a` and `T-5 · update` rows are not second rows. `registry.mjs` exports its parser and reads old counter formats in `next`/`check`. A second `claim` adds files (`--replace-claim` drops them).
- Contested design rows (hover timing and movement, backplates, colour space) are "decide per project" with an unfilled value; verifiers and `verify-change` skip unfilled rows and list them apart (D14). AGENTS.md has a first-session "fill the design table" step.
- guard-edit and guard-bash ask before hand edits and shell writes onto registries (deny overnight); guard-bash asks before restoring any folder or registry file in a shared checkout and, overnight, blocks ssh, curl/wget/HTTPie writes and inline uploading code. guard-edit names the path-scoped rules for a newly written file. The registry commit command lists only tool-made files.
- `onboard.mjs` imports its row and counter rules from `registry.mjs`, so onboarding marks exactly the duplicates the kit tools report (it no longer marks pointer, `T-12a` or `T-3 (again)` rows).
- Overnight preflight fails when a settings file turns auto mode off and warns when there is no preview route; the night session builds in a worktree, never the main checkout.
- 798 offline tests (797 pass, 1 skipped without `CLOCKWORK_LIVE=1`), run 2026-09-30.

**Known gaps**: see the acceptance table in `README.md`. Live projects move to 2.0 only through onboarding.
