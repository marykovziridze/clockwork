@AGENTS.md

# Claude Code only
- Skills: `/intake` (pasted client material) · `/verify` · `/overnight` · `/handover` · `/pre-send`.
- Agents: verifier · checker · builder · extractor. Workflows: intake · verify-change · build-slices (watch runs in `/workflows`).
- Start sessions named: `claude -n <project>-<role>`; code work in a worktree: `claude -w <role>`.
- Unattended runs (`/overnight`): build only what has a pass/fail; propose judgement calls with their cost; queue anything touching production, main, client messages or billing for the user.
- Hooks enforce the hard rules. A block is the rule working: take the safe path it names; never work around it.

## Fan out or not
| Work shape | Run it as |
|---|---|
| Independent slices (per page, file, source, audit lens) | workflow or subagents; one owner per file |
| One dependent chain (each step needs the last) | one session; lower effort before more agents |
| Registry rotation, renumbering, other structural edits | one session, serialized |
Multi-agent runs use about 15x the tokens of a chat (Anthropic, Jun 2025). Try a small slice first.

## Models: by alias; measure, then pin
Assumption: unmeasured starting points, not measured rules.
| Role | Start with |
|---|---|
| Extraction, routing, cheap checks | `sonnet` (`haiku` only with a fallback: Haiku 4.5 may retire from 2026-10-15) |
| Routine implementation | `sonnet` |
| Planning, review, fresh verifier | `opus` (or `fable` if the project prefers) |
| Multi-hour work where `opus` at higher effort falls short | `fable` |
Change effort before changing model. The kit's agents ship with these unmeasured pins; re-pin after measuring on this project. Never hard-code dated model IDs.
