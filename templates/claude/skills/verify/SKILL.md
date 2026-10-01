---
name: verify
description: Close a BUILT task with a fresh verifier. Pins the preview URL + sha, briefs the `verifier` agent or runs the `verify-change` workflow, reads its PASS / BLOCK / PARTIAL, and writes the result to the task row. Use before any row becomes ✅ VERIFIED, after every fix (a fix is new surface), and when the user asks "is it verified?".
---

# Verify a change

Closure needs a fresh verifier's evidence, not the builder's word. This project skill replaces Claude Code's bundled `/verify` (same name: the project skill wins, https://code.claude.com/docs/en/skills "Resolve skills that share a name"). Why each step exists: lessons L37, L39, L45, L46, L49, L60, L66, L76, L77 (kit WHY.md).

## 1. Ready to verify?
- The row is `🔧 BUILT`, the work is committed, and a **preview deployment of that exact sha** exists. Get its URL and the sha (`git rev-parse --short HEAD` in the builder's worktree).
- No preview? Localhost cannot close a task. "I could not test it" is a problem to solve (deploy a preview, run locally against the real database with a minted test session), not a status. Until then the row stays BUILT, with the reason appended.
- Mark it: `node "$CLOCKWORK_TOOLS/registry.mjs" status T-<n> "🔎 VERIFYING"`.

## 2. Pick the shape
| Change | Run |
|---|---|
| One page, a few design rows, no flow | the `verifier` agent (Agent tool, agent type `verifier`) |
| Several pages, a user flow, or several locales | the `verify-change` workflow |
| Expensive to be wrong (launch, migration, client data) | `verify-change`, plus a second verifier with a different method; the two never coordinate |

Cost: `verify-change` starts one agent per rule group per page, plus responsive, accessibility, screenshot review and design fidelity per page, plus one refuter per BLOCK; its first log line prints the count. About 150k tokens each: 5 pages with the full table is about 56 agents, about 8M tokens. Pass `groups` for the rows the change touches (overnight: always).

Never verify in the builder's session, never with a fork (`/subtask` copies the builder's context), never on the builder's screenshots.

## 3. Brief it cold
The verifier starts with no context. Everything it needs is in the brief:
```
Verify T-<n> on <preview URL> at sha <sha>.
Closes when: <user action> → <visible result>.
Changed: <exact files>. Must NOT change: <pages/components/selectors, from the checker>.
I believe <X>; I may be wrong: measure it, do not trust it.
Disputed numbers (each is your explicit job): <number, where, who says what>.
Known instrument hangs: <networkidle0, full-page screenshots, ...>.
Flows: <steps> · proof = <downstream record> · test data <wf-test-… marker> · cleanup <how>.
Widths and locales: from .claude/rules/design-system.md (or: <override>).
Design source per page: <Figma frame URL, or the reference>. Visual work without one can only be PARTIAL.
Time box: <minutes>. Report: reports/T-<n>-verify-<sha7>.md, written as you go.
```
Workflow call (args pass as JSON; dates come in args, the script cannot read the clock):
```
verify-change args: {"url": "<preview URL>", "sha": "<sha>", "pages": ["/", "/about"],
  "rulesPath": ".claude/rules/design-system.md",
  "flows": [{"name": "contact form", "steps": "…", "downstream": "lead in CRM with email wf-test-…", "cleanup": "delete that lead"}],
  "design": {"/about": "<Figma frame URL>"}, "groups": ["SP", "TY"],
  "date": "<YYYY-MM-DD>", "browserAgents": 2}
```
The workflow pins the build, runs one fresh verifier per lens and page (design-system rows by group plus the Baseline floors, a craft review by eye at 390/768/1440, design fidelity against the `design` frame, screenshot review for rows judged by eye, responsive + locales, accessibility, each flow, an adversarial refuter), gives every BLOCK a second independent reader, and computes the verdict in code. A visual change with no `design` entry for a page gets no fidelity check there: report it as PARTIAL, naming the page.

## 4. Read the verdict
- **Re-derive before acting.** A BLOCK, a cleanup claim or a named cause from a verifier is a claim. The workflow already ran a second reader; for a single verifier's BLOCK, check it against the source of truth (design file, rules row, served HTML) yourself or run a refuter.
- **Check the not-measured list first.** PASS with anything unmeasured is PARTIAL, whatever the headline says.

| Verdict | Row update |
|---|---|
| PASS, non-visual work | `status T-<n> "✅ VERIFIED verifier PASS sha <sha7> · reports/T-<n>-verify-<sha7>.md"` (one call: the tool refuses a bare ✅ VERIFIED) |
| PASS, visual work | stays `🔎 VERIFYING`; `append T-<n> --text "verifier PASS sha <sha7> · reports/… · the user's look owed"`. After the user's look: `status T-<n> "✅ VERIFIED the user's look <date> · verifier PASS reports/T-<n>-verify-<sha7>.md"` (repeat the report: the tool checks this call's text) |
| PARTIAL | `status T-<n> "🔧 BUILT"`; `append` the not-measured items and the report path |
| BLOCK | `status T-<n> "🔧 BUILT"`; `append T-<n> --text "verifier BLOCK: <n> findings · reports/…"`; back to the builder |
| The user ships without a pass | `status T-<n> "🚀 LIVE-UNVERIFIED <their reason>"`; the same reason goes in the commit. Never write that a verifier ran. |

(All commands: `node "$CLOCKWORK_TOOLS/registry.mjs" …`, from any folder or worktree.)

## 5. After a fix
A fix is new surface. Re-run the verifier on the fixed sha and ask it explicitly whether the fix over-reached. Re-verify every page a changed shared selector or component matches. After per-page passes on a multi-page change, run one whole-product sweep for cross-page drift.

## 6. Tell the user what was checked
Name the checks, widths, locales and flows that ran and the ones that did not: "Verified on preview abc1234 at 390, 1440 and 1920 in nl and de; contact flow proven by the CRM lead; 2560 and EN not measured." Never just "verified".
