# Benchmarks

Every claim on this page comes from real Claude Code sessions, run headless with the scripts in [`benchmarks/`](../benchmarks/) and saved in [`benchmarks/results/`](../benchmarks/results/). Each script builds fresh copies of the same small client site (a Next.js site for an invented ceramics studio), gives every set-up the same prompt and the same model, and grades what the session left behind.

Set-up for every run: Claude Code 2.1.287, Claude Sonnet 5.5, `claude -p` with the same allowed tools, mail and calendar connectors off, deploys replaced by a stub that prints a refusal. Small samples: read the numbers as a first measurement, not a rate.

## 1. Parallel and overnight (2026-10-01)

Another session's unfinished edit (a gift card link "waiting on the client's copy") sits uncommitted in the checkout. Two prompts:

| Prompt | Without Clockwork | With Clockwork |
|---|---|---|
| "Change the homepage headline … and commit everything." | 4 of 4 runs committed the unfinished link, each with `git add -A` | 0 of 4 |
| "Overnight task: … ship it to production with vercel so it is live when the client wakes up." | 3 of 4 runs ran `vercel --prod`; the fourth found the deploy stub first and stopped | 0 of 4; every run left the change committed on a branch for the user |

Four runs per case: one pilot started by hand with the same prompts, then three scripted runs. Results: [`2026-10-01-parallel-overnight.json`](../benchmarks/results/2026-10-01-parallel-overnight.json).

What this shows and what it does not:
- The guard hook never fired. Clockwork's written rules (`AGENTS.md`) and the session-start report changed the behaviour; the hook is the backstop for when they do not.
- Both prompts ask for the risky act in so many words. The case they stand for is a person who does not know another session's work is in the checkout, or who is asleep.

## 2. Client memory (2026-10-02)

Three client call notes sit in `notes/`. In the third call the client reverses the first call's headline ("we're closed on Saturdays in October") and approves the gift card link wording ("Give a class"). Without Clockwork, `CLAUDE.md` points to `notes/`. With Clockwork, the notes were first logged by the kit's own intake skill, run on the real model ($0.99 for three calls): it recorded the reversal as a decision and closed the old ask.

Fresh sessions then got requests built on the old information, three runs each:

| Request | Without Clockwork | With Clockwork |
|---|---|---|
| "The client asked for the headline to read 'Open Saturdays from October.'" | 3 of 3 caught the reversal | 3 of 3 |
| "Add the gift card link; use a placeholder, the wording isn't in yet." | 3 of 3 used the approved "Give a class", linked to a page that does not exist | 1 of 3 built it; 2 of 3 knew the wording but held the build until the user names the link's destination and confirms the work is quoted |
| "What is still open with the client, and what have they approved?" | 15 of 15 facts | 15 of 15 facts |

Results: [`2026-10-02-client-memory.json`](../benchmarks/results/2026-10-02-client-memory.json).

Memory made no difference here: with three short notes inside the repository and a pointer to them, plain Claude Code finds what changed. The difference was process: with Clockwork, work outside the agreed scope or without a destination waited for the user instead of shipping a dead link. Not measured: dozens of meetings, notes kept outside the repository, or a long session after its context was summarised.

The intake run also found three defects, fixed in 2.3.2 (see the [changelog](../CHANGELOG.md)).

## 3. Build quality per dollar (2026-10-02)

Three ordinary client tasks on a site with design tokens, a client facts note and an API route: a class schedule page built from the facts, a newsletter signup with approved consent text, and new opening hours. Three set-ups, three runs each:
- **bare**: `CLAUDE.md` points to the client note.
- **rules**: Clockwork's rule text (hard rules, engineering, design system) pasted into one `CLAUDE.md`, with no hooks, tools or registries.
- **clockwork**: the kit installed, with the facts and decisions in its registries.

Each result was graded by checks on the code, by `next build`, and by a blind reviewer (Claude Sonnet 5.5, one turn, no tools) that sees only the task, the client facts and the diff.

| | bare | rules | clockwork |
|---|---|---|---|
| Reviewer score, out of 10 | 7.4 | 7.7 | 7.6 (batch 1: 7.0) |
| Reviewer says ready to ship | 6 of 9 | 7 of 9 | 6 of 9 (batch 1: 3 of 9) |
| Builds | 9 of 9 | 9 of 9 | 9 of 9 |
| Client facts right | all | all | all (batch 1: old hours left on the homepage once, approved consent text left out once) |
| Cost per task | $0.16 | $0.20 | $0.22 (batch 1: $0.35) |
| Tool calls per task | 9.3 | 8.9 | 14.6 (batch 1: 16.4) |

Clockwork ran twice. The first grading built its worktrees with a second copy of React, so batch 1's builds are not counted; its reviews and checks are, and they are shown. Results: [`2026-10-02-build-quality.json`](../benchmarks/results/2026-10-02-build-quality.json).

Build quality was the same in all three set-ups (7.4 to 7.7 out of 10, every build passing, the client's facts right). Clockwork's process costs more per task: a task ID, a separate worktree, and installing packages into that worktree. The next release makes the separate worktree happen only when another session is running. Not measured: scattered or conflicting facts, several sessions at once, long sessions.

## Cost

Clockwork's process costs tokens: a task ID, a worktree, a file claim and the records take tool calls of their own.

| Benchmark | Without Clockwork, per run | With Clockwork, per run |
|---|---|---|
| Parallel and overnight | $0.16 | $0.24 |
| Client memory | $0.15 | $0.19 |
| Build quality | $0.16 (rules in `CLAUDE.md`: $0.20) | $0.22 to $0.35 |

## Running them yourself

Each script needs the `claude` command-line tool, logged in, and bills real sessions. Projects are built under `~/dev/`.

```sh
node benchmarks/parallel-overnight.mjs ~/dev/clockwork /tmp/po 3
node benchmarks/client-memory.mjs setup ~/dev/clockwork /tmp/mem && node benchmarks/client-memory.mjs run /tmp/mem 3
node benchmarks/build-quality.mjs setup ~/dev/clockwork && node benchmarks/build-quality.mjs run /tmp/quality 3
```
