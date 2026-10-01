export const meta = {
  name: 'build-slices',
  description: 'Build independent slices in parallel: one builder per slice, each in its own worktree with a named write-list, at most 4 at once. Refuses overlapping write-lists, checks every slice stayed inside its list, and returns branch @ sha per slice plus a merge order. Writes no registry rows and merges nothing.',
  whenToUse: 'Several independent T rows (per page, component or file) whose write-lists do not overlap. Args: {base, slices: [{id, goal, closes_when, files, check}], builders?}. One dependent chain: one session instead (CLAUDE.md fan-out table). After it: merge each branch one at a time, then run verify-change.',
  phases: [
    { title: 'Plan', detail: 'refuse overlapping write-lists before anything runs' },
    { title: 'Build', detail: 'one builder per slice in its own worktree' },
    { title: 'Check', detail: 'files changed vs write-list, computed in code' },
  ],
}

// Script API: https://code.claude.com/docs/en/workflows (meta literal; agent/parallel/phase/log, args, budget;
// no filesystem, clock or random calls). agent() options used: agentType, isolation 'worktree', schema.
// Why: parallel builders collide unless each owns its files (L40, L47, L50); fan out only independent slices (L43).
// Model: the `builder` agent's own line (.claude/agents/builder.md): measure, then pin.

const A = args || {}
const slices = Array.isArray(A.slices) ? A.slices : []
if (!A.base || !slices.length) throw new Error('build-slices needs args.base (sha to build on) and args.slices [{id, goal, closes_when, files, check}]')
const BUILDERS = Math.max(1, Math.min(4, Number(A.builders) || 4)) // at most 4 build agents at once (overnight skill)

phase('Plan')
const owner = {}
const clashes = []
for (const s of slices) {
  if (!s.id || !s.goal || !Array.isArray(s.files) || !s.files.length) throw new Error(`slice ${s.id || '?'} needs id, goal and a non-empty files write-list`)
  for (const f of s.files) { if (owner[f] && owner[f] !== s.id) clashes.push(`${f}: ${owner[f]} and ${s.id}`); owner[f] = s.id }
}
if (clashes.length) throw new Error(`write-lists overlap, so these are not independent slices: ${clashes.join('; ')}. Give each file one owner, or build them in one session.`)

const RESULT = {
  type: 'object',
  properties: {
    id: { type: 'string' }, branch: { type: 'string' }, sha: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, passed: { type: 'boolean' }, output_tail: { type: 'string' } }, required: ['command', 'passed', 'output_tail'] } },
    not_checked: { type: 'array', items: { type: 'string' } },
    blocked: { type: 'string' },
  },
  required: ['id', 'branch', 'sha', 'files_changed', 'checks', 'not_checked', 'blocked'],
}

// No silent caps: with a token target set, build what fits (about 200k tokens per builder) and name the rest.
let todo = slices.slice()
const dropped = []
if (typeof budget !== 'undefined' && budget && budget.total) {
  const fit = Math.max(1, Math.floor(budget.remaining() / 200000))
  if (todo.length > fit) { dropped.push(...todo.splice(fit)); log(`token budget: not building ${dropped.map((s) => s.id).join(', ')}`) }
}

async function limited(n, thunks) {
  const out = new Array(thunks.length)
  let next = 0
  async function lane() { while (next < thunks.length) { const i = next++; try { out[i] = await thunks[i]() } catch (e) { out[i] = null } } }
  await Promise.all(Array.from({ length: Math.min(n, thunks.length) }, lane))
  return out
}

phase('Build')
const built = await limited(BUILDERS, todo.map((s) => () => agent(`Build task ${s.id}: ${s.goal}
Closes when: ${s.closes_when || 'see the row'}. Base sha: ${A.base}. Branch: ${String(s.id).toLowerCase().replace('-', '')}-<slug>.
Write-list (the ONLY files you may create or edit): ${s.files.join(', ')}. A needed file outside it: stop and put the reason in "blocked".
Checks to run and report with their real output: ${s.check || 'the build, lint and test commands in .claude/clockwork.json'}.
Commit by explicit path. Set the row to 🔧 BUILT with registry.mjs; never to VERIFIED. Other slices run at the same time in other worktrees: never touch their files.
Return your branch, the sha you committed, every file you changed (git diff --name-only ${A.base}..HEAD) and what you did not check.`,
  { label: `build-${s.id}`, phase: 'Build', agentType: 'builder', isolation: 'worktree', schema: RESULT })))

phase('Check')
const ok = [], problems = []
todo.forEach((s, i) => {
  const r = built[i]
  if (!r) { problems.push({ id: s.id, why: 'builder died or was stopped; nothing to merge' }); return }
  const outside = r.files_changed.filter((f) => !s.files.includes(f))
  const failed = r.checks.filter((c) => !c.passed).map((c) => c.command)
  if (r.blocked) problems.push({ id: s.id, why: `blocked: ${r.blocked}`, branch: r.branch, sha: r.sha })
  else if (outside.length) problems.push({ id: s.id, why: `changed files outside its write-list: ${outside.join(', ')}`, branch: r.branch, sha: r.sha })
  else if (failed.length || !r.checks.length) problems.push({ id: s.id, why: failed.length ? `checks failed: ${failed.join(', ')}` : 'no check ran', branch: r.branch, sha: r.sha })
  else ok.push({ id: s.id, branch: r.branch, sha: r.sha, files: r.files_changed, not_checked: r.not_checked })
})
for (const s of dropped) problems.push({ id: s.id, why: 'not built: the token budget ran out' })
log(`build-slices: ${ok.length} ready to merge, ${problems.length} need attention`)
return {
  base: A.base,
  ready: ok,
  merge_order: ok.map((x) => `${x.branch}@${String(x.sha).slice(0, 7)}`),
  problems,
  next: 'Merge the ready branches one at a time (fetch, rebase on the new tip, re-run checks, fast-forward), then run verify-change on the preview. Nothing here is verified.',
}
