---
# Loads only when a registry file is read. Format: https://code.claude.com/docs/en/memory#path-specific-rules
paths:
  - "**/{TASKS,CLIENT,FACTS,MEETING-LOG,OPEN-ASKS,APPROVAL-QUEUE,DOC-MAP,ROUTING}.md"
  - "**/*-ARCHIVE.md"
---

# Registries: format and how to write them

Managed by Clockwork; the doctor checks them.

## Format
- Header (above the first `## `): title, one-line purpose, `**Last updated:** YYYY-MM-DD`, one `next free` counter per ID prefix. Nothing else.
- A row is one table line starting `| <PREFIX>-<n> |`. The last cell is the status and opens with one marker: `⬜ OPEN` `🔎 VERIFYING` `🔧 BUILT` `✅ VERIFIED` `🚀 LIVE-UNVERIFIED` `⏸ PARKED` `✖ VOID`.
- A row stays under 1,500 characters. Longer detail goes to `reports/<ID>-<slug>.md`, linked from the row.
- IDs are never reused. A gap is a `✖ VOID` row, never a header note. An ID that exists only in the counter is a defect.
- Not second rows: a pointer (`→ archived`), a `✖ VOID — duplicate of …` row, `T-12a`, `T-5 · update …`.

## Write only through the tool (it locks, re-reads, writes, verifies)
`$T` = `$CLOCKWORK_TOOLS`: the main copy's tools, absolute (set by session-start). Hooks ask before a hand edit.
    node "$T/registry.mjs" mint T --title "…" [--cells "a|b"] [--status "⬜ OPEN"]
    node "$T/registry.mjs" append T-<n> --text "evidence or note"
    node "$T/registry.mjs" status T-<n> "✅ VERIFIED <one evidence line>"
    node "$T/registry.mjs" line FACTS.md --section "## Facts" --text "…" [--replace "<exact old line>"]
    node "$T/registry.mjs" show T-<n>  ·  list T --status BUILT  ·  check
    node "$T/registry.mjs" dedupe T-<n> [--keep <line>]      one row per ID; a reused ID's other rows get new IDs
The last output line is `OK <ID>` or `ERR <reason>`. On ERR, read the reason; never fall back to a hand edit.
Always the main copy. A registry in a worktree is a stale snapshot: read rows with `show`/`list`, never edit it.
Commits: a main-checkout session or the user commits registry changes and tool-made files (archives, reports, PM sources), by path (the doctor prints the command). A worktree session never commits them: it tells the user.

## Keep them honest
- Append evidence to a status cell; never replace someone else's text in it.
- A Confirmed Decision is never edited. A reversal is a new CD row; strike nothing silently.
- Before planning from open rows, check a sample against main and the live site: rows drift toward "looks fine".
- A client correcting a settled fact is a reversal row, not a re-opened question.

## Rotation and backups
- `registry.mjs rotate <FILE> --dry-run` first. It backs up, moves only rows whose status opens with `✅`/`✖`, leaves a stub, and refuses if any ID would go missing.
- Before a real rotation, tell live sessions to hold registry writes and take their pending rows as text. A session that keeps minting: do not rotate.
- When the weight is open work, not closed rows: triage with the user; no rotation.
- `registry.mjs backup --reason <slug>` before any bulk change.
