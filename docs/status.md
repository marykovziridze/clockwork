# What is tested

## Offline tests

`node --test --test-timeout=180000 test/` in the kit folder runs every test offline; a hung test fails after 3 minutes. Tests that need real projects or the `claude` binary run only with `CLOCKWORK_LIVE=1` and are skipped otherwise.

## Acceptance (2026-09-30)

**Passed:** install, re-run, IDs, guard and hooks on fresh Next.js and WordPress repos; `--adopt` on copies of two live projects; intake on an invented transcript.

**Not run yet:**
- a real overnight run, including a usage-limit reset;
- a real `claude -w` session writing tasks;
- the verify, intake and onboarding workflows on a real model (their tests use mocks);
- pulling mail or calendar items;
- a real Codex session: the Codex hooks are tested only with recorded Codex-format inputs (`test/codex-cleanup.test.mjs`);
- `/clockwork-sessions:onboard` run end to end from the installed plugin. Its install, the skill's inventory and `onboard.mjs` from the installed copy were checked in an isolated config folder;
- `cleanup.mjs --apply` on a real project: its dry run was run on one (18 of 27 worktrees removable, 9.1 GB), its removal only on test repositories.

Live projects join only through onboarding (decision D15 in [WHY.md](../WHY.md)).
