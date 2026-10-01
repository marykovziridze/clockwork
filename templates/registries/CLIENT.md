# CLIENT — what the client asked, owes, decided and expects on a schedule
Every line is written only with `node "$CLOCKWORK_TOOLS/registry.mjs"`: asks and decisions with mint/append/status, obligations with `line CLIENT.md --section "## Standing Obligations"`.
**Last updated:** 2026-09-30
> **ID counter — next free: `C-1`**
> **ID counter — next free: `CD-1`**

## Client asks
Open asks in both directions: what the client asked of us, and what we are waiting on from them.
Mint: `node "$CLOCKWORK_TOOLS/registry.mjs" mint C --title "…" --cells "who|owed by|source"`

| ID | Ask | Who | Owed by | Source | Status |
|---|---|---|---|---|---|

## Confirmed Decisions
Append-only. A reversal is a new row that names the row it replaces; the old row becomes `✖ VOID`. **Bold the settled phrase.**
Mint: `node "$CLOCKWORK_TOOLS/registry.mjs" mint CD --title "…" --cells "date · who|source" --status "✅ VERIFIED"`

| ID | Decision | Date · who | Source | Status |
|---|---|---|---|---|

## Standing Obligations
Recurring or dated commitments, referenced by name (no IDs). They never close; they have a next due date.
Seed: check-in slot (e.g. 30 min fortnightly) · launch date · guarantee end · domain and SSL renewal · retainer covered-vs-quoted line · external deadlines.

| Obligation | Cadence or date | Owner | Next due | Source |
|---|---|---|---|---|
