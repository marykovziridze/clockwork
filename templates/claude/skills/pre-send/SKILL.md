---
name: pre-send
description: Check anything going to a client before the user sends it (email, message, report, deck, attachment, answer to feedback). Compares the draft with everything already sent to that reader and with the signed quote, checks every fact at its source, checks questions and attachments, and returns a pass/fail list plus the corrected draft. Never sends anything.
argument-hint: "[draft file or pasted draft]"
---
<!-- Managed by Clockwork. Frontmatter keys: https://code.claude.com/docs/en/skills#frontmatter-reference -->

# Pre-send check

This skill checks and returns. It never sends, schedules or queues a message, and it never asks another session to. The user sends.

Draft: $ARGUMENTS (if empty, use the draft in the conversation).

## 1. Collect what the reader already has
- Everything already sent to this reader: MEETING-LOG entries, CLIENT rows, and the sent mail itself (search Sent by recipient when a mail connector is available; say so when it is not).
- The signed quote or proposal (FACTS names it) and the Confirmed Decisions that touch the topic.
- The tone-of-voice file if DOC-MAP lists one.

## 2. Run the checks
Mark each PASS or FAIL, with the evidence (file + line, URL, or command output):
1. **Consistent with what was sent.** Nothing contradicts an earlier message, a Confirmed Decision, or FACTS. A change of position is said out loud, not slipped in.
2. **Scope.** Read the quote before calling anything extra or included. New scope says it needs a quote before asking the client for content it depends on.
3. **Every fact checked at its source.** Each status, "fixed", date, price and number is checked where it lives (the served page, the mailbox, the third party's own confirmation, the data). Not yet confirmed by the third party: "ready, live once applied". Never describe how someone else's tool behaves; ask which tool they use.
4. **Nothing invented.** No made-up people, quotes, numbers or placeholder text. A metric called agreed can actually be produced from the data.
5. **Questions.** None about things we could observe or things we invented. All in one numbered list, each linking to the page or file it is about.
6. **Short and plain.** A mail is a few lines; detail goes in an attached or linked page. Plain words. Counts appear only if a second reader checked them.
7. **Attachments.** Only files the reader will use. Every reused file is searched for secrets before it goes, for example:
   `grep -rEn "sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|(api|secret)[_-]?key" "<file-or-unzipped-folder>"`
8. **Final read.** Read the whole draft once more after the last edit; stray fragments appear in the last change.
9. **Language.** If the draft is not in English, give the user an English version next to it.

## 3. Return
- The PASS/FAIL list, FAILs first, each with its evidence and the fix.
- The corrected draft.
- What to log after the user sends it: a MEETING-LOG entry, and the APPROVAL-QUEUE rows to move to `🔎 VERIFYING` (shown, waiting for the client).
Say which checks could not run and why. A skipped check is a FAIL until the user waives it.
