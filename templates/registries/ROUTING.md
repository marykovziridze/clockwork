# ROUTING — when X arrives, it goes HERE
No outcome ends a session as prose only: it leaves as a row with an ID, a FACTS line or a log entry.
**Last updated:** 2026-09-30

## Routes
| When this arrives | It goes | How |
|---|---|---|
| Transcript, email, feedback doc | MEETING-LOG entry + rows it implies | `intake` skill, same session |
| The user asks for something in chat | OPEN-ASKS | mint A |
| Client asks, or owes us, something | CLIENT · Client asks | mint C |
| Decision made or reversed | CLIENT · Confirmed Decisions (reversal = new row) | mint CD |
| Recurring or dated commitment | CLIENT · Standing Obligations | edit by name |
| A volatile fact changes | FACTS, same session | edit the line |
| Work to build, incl. internal follow-ups | TASKS | mint T |
| Defect outside the current task | TASKS, its own row | mint T, report it |
| Launch-day switch (DEV endpoint, mail recipient, noindex) | TASKS, own row next to the cutover | mint T |
| Client-facing work verified | APPROVAL-QUEUE | mint Q |
| Client approves | CD row; close the Q row | mint CD |
| Detail too long for a row | reports/, linked from the row | |
| Client files and media | DOC-MAP location; media never in git | |
| Writing to the client | draft → `pre-send` skill → the user sends | |
| Ending with work in flight | reports/ handover | `handover` skill |
