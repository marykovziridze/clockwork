# Onboarding map: what goes where

How codes: **M** moved as is · **K** condensed, rows cite a Source (`old/file.md:12`) · **V** archived verbatim (`reports/onboarding-<date>/originals/<path>` or a byte-identical copy) · **P** kept in place + DOC-MAP entry · **Q** question for the user, with a default.

## Non-negotiables
1. **Nothing is deleted or lost.** Every rule, fact, task, decision and ID maps to a named place or stays put (DOC-MAP: "kept, not migrated"); census before/after proves it. K files are also V. A file offloaded by iCloud is never read: listed as not copied, not as lost.
2. **Staging first**: all work on a copy off iCloud; secrets (`.env*`, keys, credentials) never staged. Only `apply` writes the project, after the user approves the plan (backup, hash check, no other live session; they may override).
3. **Nothing invented.** Case C seeds rows only from a cited source (its table); unknowns are numbered Qs with a default.
4. **The user decides.** Disagreeing sources or a rule of unclear status = Q, never a silent pick. Personal instructions are flagged, never put in AGENTS.md (D9). Past choices stay.

Sweep: items in a P document become rows citing file:line; kept or swept documents get a `documents.md` line each (extracted? authoritative?), a DOC-MAP line per folder. An old decision or design rule = OPEN-ASKS question ("still decided?"); a CD `✅ VERIFIED` row only if it names who ratified it and when. Facts in instruction files (contacts, roles, scope, stack, integrations) → FACTS/CLIENT owner tables; prices → a commercial C row, never an always-loaded file. A stale file (old ledger, brief) stays P, "not authoritative", + a Q.

## Case A: Clockwork v1
| Source | Destination | How |
|---|---|---|
| TASKS/CLIENT/FACTS/MEETING-LOG | same file and folder (`--registry-dir` if not `.claude`) | M: `migrate` fixes counters, bold IDs, section names, duplicates (VOID, never renumbered) |
| Registries in two folders (incl. PM/approvals/), CLIENT-REQUESTS mirror | registryDir = folder with live counters; others copied in (old copy removed by hand) | Q (default: that) |
| ROUTING.md, DOC-MAP.md | kept; missing template sections appended | P; lines only added |
| TOOLING, ENGINEERING, code-hygiene | AGENTS.md or `.claude/rules/project-*.md` | K + V; text kit hooks now enforce = V only |
| Big CLAUDE.md | AGENTS.md (project rules) + CLAUDE.md (`@AGENTS.md` + Claude-only) | K + V; personal = flagged |
| Long append-only DESIGN-SYSTEM.md | each line in `design-coverage.md`: a design-system.md row, `retired` + proof, `kept` verbatim in `DESIGN-SYSTEM-ARCHIVE.md` (binding, pointed at) or `not a rule` + why | K (Source = file:line); apply refuses unmapped lines |
| (same) history | `DESIGN-SYSTEM-ARCHIVE.md`; rulings naming who and when: CD rows | V; CD rows cite file:line |
| loop.md, loop-progress ledgers, HANDOVER-* | stay; open items: TASKS rows | P + sweep; durable rules: K into AGENTS.md |
| Project hooks, commands, skills, agents | stay; kit hooks wired alongside | P; a kit-managed file (v1 doctor): `install --adopt` replaces it, backup = V; Q if project-only logic |
| `name 2.md` conflict copies | `.claude/.clockwork-backups/conflict-copies/` | M by `migrate`; Q: diff by hand |
| Registry backups, PM/archive | stay | P |
| `.claude/` ignored in git | keep; `migrate` lists Clockwork files (not registries) in `.worktreeinclude` | P (their choice) |
| Root not a git repo (code in a sub-repo) or a linked worktree | root: Q (worktrees come from the sub-repo); worktree: onboard the main checkout | Q; apply refuses worktrees |

## Case B: other documentation (also case A's)
| Source | Destination | How |
|---|---|---|
| Big CLAUDE.md | as case A | K + V |
| AGENTS.md already there | stays; kit sections merged in, project rules kept | K + V; Q if over 8 KB |
| README | stays; commands to `clockwork.json` commands | P; commands K (Source) |
| docs/ | stays | P + sweep |
| `.cursor/rules`, `.windsurfrules`, copilot-instructions | stay (other tools read them); shared rules to AGENTS.md | P + K; conflict with AGENTS = Q |
| Tasks kept in GitHub Issues | untouched; GitHub Issues stays the task store | P; issues NOT copied to TASKS.md, linked from DOC-MAP + AGENTS "Where things are" |
| Task lists, TODO.md, backlog, roadmap | stay; each open item a TASKS row | P + sweep |
| loop.md, ledgers, handovers | as case A | P + sweep |
| Meeting notes, transcripts, emails | stay; a MEETING-LOG row each | P + sweep |
| PM folder, briefs, specs, PDFs, docx | stay | P + sweep (not readable = listed) |
| Design tokens, tailwind config, theme.json | stay (code); `{{…}}` / "decide per project" design values filled from THIS project only, else empty + one Q | P; K (Source) |
| DESIGN-GUIDE, style/brand guide, own design-system.md | as case A DESIGN-SYSTEM | K + V |
| Figma links | FACTS line per file (url + where found) | K (Source) |
| Hooks, commands, skills already there | stay; kit files wired alongside | P; same name as a kit file = Q (never `--force-managed`) |
| CLAUDE.local.md, other personal notes | stay, never copied to shared files | P; flagged |
| Code TODO/FIXME | as case C | Q |

## Case C: no documentation
| Source | Destination | How |
|---|---|---|
| package.json / composer.json scripts | `clockwork.json` commands, stack | K (Source = file:line); none = left empty |
| Git history, remotes, branches | FACTS (repo, remote, main branch, first/last commit) | K (Source = commit hash) |
| Unmerged branches | one `⏸ PARKED` TASKS row each | K; Q: keep, merge or drop (default parked) |
| Commit messages | not made into decisions | listed in reports only |
| Code TODO/FIXME comments | one `⏸ PARKED` TASKS row per file, lines listed | Q (default parked, not open) |
| Issue exports (csv/json) | TASKS rows with the issue number | K (Source) |
| Loose files (notes, briefs, screenshots) | stay; images listed, not read | P + sweep |
| Tokens, tailwind, theme.json | as case B | P |
| Client, owner, deploy target, who approves | unknown until said | Q, never guessed |
