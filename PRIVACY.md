# Privacy

Clockwork collects nothing. It has no server, no account, no telemetry and no analytics. The author receives no data from your use of it.

## What it stores
Everything Clockwork writes stays in the project you install it into, on your own machine:
- The registries (`TASKS.md`, `CLIENT.md`, `MEETING-LOG.md`, `APPROVAL-QUEUE.md` and the others). When you run intake on a transcript, email or feedback you paste, the session copies what it needs from it into these files, which can include people's names, email addresses and what they said.
- `.claude/.state/`: session names, file claims and worktree paths, so parallel sessions can see each other. It is git-ignored.

These files are plain text. You can read, edit or delete them at any time; deleting them removes the data. Whether they reach your git remote depends on what you commit and push.

## What it sends
- `git fetch origin` at session start, to the project's own remote. Clockwork makes no other network call.
- Clockwork runs inside Claude Code (or Codex). Those tools send your conversation to their provider as they always do, under that provider's terms; Clockwork adds nothing to that.

## Contact
Questions: [GitHub Discussions](https://github.com/marykovziridze/clockwork/discussions).
