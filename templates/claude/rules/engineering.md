---
# Path-scoped: https://code.claude.com/docs/en/memory#path-specific-rules
paths:
  - "**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte}"
  - "**/*.{py,php,rb,go,rs}"
---

# Code rules (every stack)

Managed by Clockwork. Source: the kit's v1 engineering standards (ENGINEERING §B, "Code rules" and "Git & flow"). Project additions go in AGENTS.md or a project rule file.

- Type honestly: no `any` (or its stack's equivalent).
- Validate external input where it enters: request bodies, webhook payloads, form input, third-party API responses.
- Fail honestly: never swallow an error in an empty `catch`, and never show a success state (a saved badge, a green check) for a write that did not happen. A read that returns zero rows where rows are required is a failure, not an empty success.
- Secrets stay server-side: never in client code, never in a tracked file. Third-party API calls that need a key run on the server.
- Every user-facing string goes through the project's translation files, in every configured locale. No hard-coded copy in components.
- Reuse the existing component or helper; never write a second one next to it.
- Content keys and anchor ids are stable slugs, never list positions or headings (both change when content is edited).
- Before commit: type check and build clean; no new dead code or orphaned files.
- Commit messages: conventional commits naming the task ID (`fix(nav): … (T-12)`).
