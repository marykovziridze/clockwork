# APPROVAL-QUEUE — verified work the client has not approved yet
Between "verified" and "the client has seen it". Rows written only with `node "$CLOCKWORK_TOOLS/registry.mjs"`.
**Last updated:** 2026-09-30
> **ID counter — next free: `Q-1`**

## Queue
Status: `⬜ OPEN` verified, not yet shown · `🔎 VERIFYING` shown, waiting for the client · `✅ VERIFIED` approved (Confirmed Decision minted) · `✖ VOID` withdrawn.
A conditional approval stays open until the corrected result is shown back. Batch rows into one report per send.
Mint: `node "$CLOCKWORK_TOOLS/registry.mjs" mint Q --title "…" --cells "link|task ID|sent in"`

| ID | What the client must see | Link | Task | Sent in | Status |
|---|---|---|---|---|---|
