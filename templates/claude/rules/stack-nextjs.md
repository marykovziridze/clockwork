---
# Loads when Claude reads a matching file. Format: https://code.claude.com/docs/en/memory#path-specific-rules
paths:
  - "**/*.{ts,tsx,js,jsx,mjs,css}"
  - "**/next.config.*"
  - "**/vercel.json"
  - "**/supabase/**"
  - "**/package.json"
---

# Stack traps: Next.js · Vercel · Supabase · Tailwind

Managed by Clockwork. Each line is a trap that cost a real session time. Add a project's own traps to AGENTS.md or a new rule file, not here.

## Build and run
- The real build is the gate, not the typecheck. A function prop passed to a client component, or an `as const` that narrows a `useState` type, passes `tsc` and lint and fails the build.
- Never pipe a build into `| grep | head`: it can kill the build after "Compiled successfully" and leave a half-written `.next`. Send output to a log file and read the tail.
- Stop a stale server by PID: `lsof -nP -iTCP:<port> -sTCP:LISTEN`, then `kill <pid>`. `pkill -f 'next start'` misses a renamed `next-server` that keeps serving the old build.
- A repo on iCloud Desktop gets `" 2"` conflict copies in `node_modules` and `.next`, and every route fails. Keep code off iCloud; delete both folders and reinstall.

## Rendering and caching
- On a Partial Prerender route, `curl` sees only the shell: content markers read 0 and `notFound()` still returns 200. Check what a page renders in a real browser (the DOM), never by curl or status code.
- Cache Components: a `"use cache"` child of a dynamic route becomes its own hole instead of joining the static shell. Measure the postponed boundaries before and after.
- A hook keyed on `usePathname()` does not fire when only the query string changes (`?category=`). Key it on `useSearchParams()` too.
- The Vercel Data Cache is shared across deployments of one project. When you change what feeds a cached call, change its cache key in the same commit, or the new build reads the old value with no error.

## Vercel
- A push is not a deploy until proven: find the deployment and check that the served page shows the change.
- A branch deployed to production is overwritten by the next deploy of main. Ship main's tip, after merging main into the branch.
- A `*.vercel.app` preview is an unknown host, so domain-based locale routing shows only some locales there. Use the project's staging aliases; write down which you repointed and restore them.
- After a project migration, check that `.vercel/project.json` points at the new project and the domain is served by it.

## Supabase and data
- `supabase.auth.signOut()` signs out every device by default. Pass `{ scope: 'local' }`.
- A temporary auth user that writes to an audit table other tables reference cannot be deleted afterwards. Test with a real second account.
- Number a migration when it is minted, not when it is merged: two parallel branches both took the same number.
- A data change and the code that reads it ship as one flip: deploy the code before removing strings it reads.
- A required env var that is blank must stop the app from starting. Remove any fallback that cannot work in production.
- Snapshot stored content before editing it through the API or SQL.

## Tailwind and CSS
- A utility passed in `className` does not reliably beat the shared component's own utility; CSS source order decides. Use `!` (as in `!pt-0`), the way the repo already does.
- `cn()` / tailwind-merge only resolves classes it knows. Register custom `@theme` tokens with `extendTailwindMerge`, or it keeps both classes or deletes the wrong one.
- Tailwind v4 `translate-x-*` animates the CSS `translate` property. A custom transition list needs `translate`, not only `transform`.
- When a utility seems not to apply, read the class string on the served element before changing code.
