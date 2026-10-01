# Intake routing: item type → where it goes

Project-owned: change rows to fit this project, keep the columns. `intake.mjs` reads this table; `intake.mjs routes` checks it.
- **Prefix** set → a new row, minted by `node "$CLOCKWORK_TOOLS/registry.mjs" mint <Prefix> --file <File> --section "<Section>" --title "<Title>" --cells "<Cells>" [--status "<Status>"]`.
- **Prefix** `—` and File is a registry → one line, written by `intake.mjs landed … --write --line "…"` (through `registry.mjs line`; works from a worktree).
- File `reply` → no row: it goes in dispatch.md under "Held for the user" and in the answer to the user.
- Placeholders: `{summary}` `{speaker}` `{owner}` `{due}` `{due_note}` ("due <date>" after the owner, or nothing) `{date}` (meeting date) `{source}` (folder/file @ where) `{closes_when}` `{ref}`. Write `\|` for a cell break inside a table cell.
- A type may have two minting rows; both are minted (design_rule: the decision, then the task to rewrite the design table).

| Type | File | Section | Prefix | Title | Cells | Status |
|---|---|---|---|---|---|---|
| decision | CLIENT.md | ## Confirmed Decisions | CD | {summary} | {date} · {speaker}\|{source} | ✅ VERIFIED |
| client_ask | CLIENT.md | ## Client asks | C | {summary} | {speaker}\|{owner}{due_note}\|{source} | ⬜ OPEN |
| commitment | CLIENT.md | ## Client asks | C | We owe: {summary} | {speaker}\|us: {owner}, due {due}\|{source} | ⬜ OPEN |
| task | TASKS.md | ## Open | T | {summary} | {closes_when}\|tbd\|{source} | ⬜ OPEN |
| risk | TASKS.md | ## Open | T | Risk: {summary} | resolved, or accepted by the user\|tbd\|{source} | ⬜ OPEN |
| fact | FACTS.md | ## Facts | — | | | |
| deadline | CLIENT.md | ## Standing Obligations | — | | | |
| question_for_user | reply | Held for the user | — | | | |
| commercial | CLIENT.md | ## Client asks | C | Commercial question: {summary} | {speaker}\|the user: quote before content\|{source} | ⬜ OPEN |
| design_rule | CLIENT.md | ## Confirmed Decisions | CD | Design rule {ref}: {summary} | {date} · {speaker}\|{source} | ✅ VERIFIED |
| design_rule | TASKS.md | ## Open | T | Rewrite design-system.md row {ref} to: {summary}; list pages built under the old rule | row rewritten, pages listed\|preview\|{source} | ⬜ OPEN |
| client_approval | CLIENT.md | ## Confirmed Decisions | CD | Client approved {ref}: {summary} | {date} · {speaker}\|{source} | ✅ VERIFIED |

Rules the tool applies before this table (not editable here):
- An item with `new_scope: true` routes as `commercial`, never as a task.
- An item with `conflicts`, or a metric not proven producible, is held for the user instead of written.
- `outward: true` (send, publish, delete, share) gets the title prefix "User approves: ". No session sends it.
- A deadline that changes a FACTS line (launch date) is filed as `fact`.
- `client_approval` with `ref` Q-<n>: after its CD row is minted, that Q row is set to `✅ VERIFIED approved <date> → CD-<n>`.
