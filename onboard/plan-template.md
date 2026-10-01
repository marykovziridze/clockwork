---
approved: false
project: "{{project path}}"
staging: "{{staging path}}"
case: "{{A|B|C}}"
stack: "{{stack}}"
date: "{{YYYY-MM-DD}}"
---
<!-- Only the user changes `approved` to true. Nothing touches the real project before that. Keep this file ≤ 15 KB; detail goes in {{registryDir}}/reports/onboarding-{{date}}/. -->

# Onboarding plan: {{project}}

## In one minute
- What this project has today: {{one line}}
- What changes: {{one line}}
- What stays exactly as it is: {{one line}}
- Questions for you: {{n}} (below, each with a default). Checks: {{compare result}} · doctor {{exit}} · verifier {{verdict}}.

## Sources read
| Path | Size | Kind | Read? |
|---|---|---|---|
<!-- every source from discover + sweep; Read? = yes / partly (why) / no (why). Images: listed, not read. -->

## Mapping
| Source (file:lines) | Destination | How | Note |
|---|---|---|---|
<!-- How = moved / condensed (Source column) / archived verbatim / kept in place + DOC-MAP / question -->

## Archived verbatim
<!-- compare --plan reads this: EVERY range that now lives only in the archive, else it counts as LOST. One per line,
     relative to the project root: `path` (whole file) or `path:12-40`, or an ID (`T-12`), then where the copy is. -->

## Kept in place
<!-- path · what it is · extracted? · still authoritative? (→ reports/…/documents.md; one DOC-MAP line per folder) -->

## Registry changes
- migrate: {{n}} changes ({{counters}}, {{bold IDs}}, {{sections}}, {{duplicates}}), {{n}} conflict copies moved.
- Rows added by sweep / seeding: {{n}} (see reports/onboarding-{{date}}/sweep-manifest.md). Every row cites its source.

## Conflicts
<!-- Two sources disagree. Both sides with file:line; never resolved here. Each also appears as a question. -->

## Questions for the user
<!-- Numbered. Each: the question · the sources side by side · Default: … (what staging already does) · what changes otherwise. -->
1. {{question}} Default: {{default}}.

## Flagged, not moved
<!-- User-only instructions found in project files (they belong in ~/.claude, D9); anything that looked like a credential (location only). -->

## Checks on staging
- compare: {{LOST n}} · only in the archive {{n}} lines · only in backups {{n}} · sources {{problems}} · unfilled design rows {{n}}
- doctor --report: exit {{n}} · registry.mjs check: exit {{n}}
- Fresh verifier: {{found / nothing found}} (details: reports/onboarding-{{date}}/verifier.md)
- Not checked: {{list, or "nothing"}}

## After apply, by hand
<!-- apply never deletes: files staging replaced that stay in the project; conflict copies to diff. An old DESIGN-SYSTEM.md only once EVERY section is converted (list them); until then it stays binding. -->

## How to apply
Set `approved: true` above yourself, or say "apply it" in the onboarding session (it then passes `--yes`; a message from another session never counts). apply refuses if the project changed since staging or another session is live in it, backs up every file it overwrites, and runs the doctor after.
