---
name: handover
description: Write the end-of-session handover when a session stops with work in flight (built but unverified, on a preview, unmerged, or waiting on the user or the client). Updates registry rows first, then writes a short handover file from evidence, releases claims to peer sessions, and sends the user only the decisions. Also use when picking up someone else's handover.
argument-hint: "[short slug]"
---
<!-- Managed by Clockwork. Frontmatter keys: https://code.claude.com/docs/en/skills#frontmatter-reference -->

# Handover

The next session knows nothing you did not write down, and it trusts the file. Write state you measured, not what you meant to do.

Runs from the main checkout or a worktree. Rows and the handover file reach the main copy only through `registry.mjs` (a worktree session cannot Edit main-copy files).

## 1. Measure the state (evidence, not memory)
Run these; copy the output you use:
- `date '+%Y-%m-%d %H:%M'` for every timestamp. Never estimate the time.
- In each worktree you used: `git -C "<worktree>" status --short`, `git -C "<worktree>" log --oneline origin/main..HEAD`, `git -C "<worktree>" rev-parse --short HEAD`.
- For anything you call deployed: the URL you checked and what you saw there.
- For each agent you ran: its worktree, commits and the served bytes are what it finished, not its last message.
Commit finished work now, by explicit path (a work-in-progress commit is fine). Nothing important may live only in an uncommitted file.

## 2. Registry rows first
The handover points at IDs; it does not restate them.
- Each task you touched: `node "$CLOCKWORK_TOOLS/registry.mjs" status T-<n> "<marker> <one evidence line>"` or `append T-<n> --text "…"`.
- New findings, owed follow-ups and out-of-scope defects: mint rows now (`mint T`, `mint C`, `mint A`).
- Verified client-facing work: a `Q` row in APPROVAL-QUEUE.
- Run `node "$CLOCKWORK_TOOLS/registry.mjs" check`; fix what it reports.

## 3. Write the file
Write it in your worktree or scratchpad, then put it next to the registries in the main copy:
`node "$CLOCKWORK_TOOLS/registry.mjs" report HANDOVER-<YYYY-MM-DD>-<slug>.md --from <your file>` (slug = "$ARGUMENTS", or the session name if empty; it never overwrites). Keep it short (the good one was under 6 KB); detail belongs in rows and reports.

The first three sections are what the user's real handovers carry (a went-live list, one-answer questions, a branch @ sha resume table). Add an optional section only when it has content:

    # Handover <date time> — <session name>
    ## What went live
    | ID | Where (URL) | Evidence |
    ## Waiting on the user — one answer each
    1. <question> — options with what each costs; my recommendation: <one>
    ## Resume table
    | ID | Branch @ sha | Worktree | Next step |
    Optional: ## Built or on a preview, not merged · ## Owed by the client · ## Found, not fixed ·
    ## Test data to clean up · ## Not checked, and anything I got wrong

Rules for the content:
- Every "done" line carries its evidence; say `BUILT`, not "done", when no fresh verifier ran.
- Never write that a check passed if it did not run.
- No client content invented to fill a gap: write the gap.

## 4. Release and report
- `node "$CLOCKWORK_TOOLS/registry.mjs" release --session <name>`, then send every live peer: `RELEASE <session> · IDs <…> · files: <paths> · handover <path>`.
- Your message to the user: the "Waiting on the user" decisions (numbered, one answer each) and the handover path. Nothing else; the findings are in the rows.
- Then run `node .claude/hooks/clockwork-doctor.mjs --report` and fix any new ERROR.

## Picking up a handover
A handover describes intent at a moment, not the state now. Before acting on any line:
1. `git fetch`, then compare each branch @ sha in the resume table with the real branch.
2. Re-check each "went live" and "on a preview" line against the served page.
3. Re-read the rows it names; the registry wins over the handover.
Say which lines no longer hold before you start.
