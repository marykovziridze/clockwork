export const meta = {
  name: 'intake',
  description: 'Extract typed, quote-backed items from long client source material (transcript, mail thread, feedback doc) in parallel chunks, re-check every quote, run a completeness critic per chunk and a contradiction check. Returns the extraction; writes nothing.',
  whenToUse: 'Called by the intake skill when a saved source is over ~8 KB or there are several sources. Args: {sources: [{source, chunks: [{label, startLine, endLine}]}], date, registryDir?, context?}. Chunks come from `intake.mjs chunks`.',
  phases: [
    { title: 'Extract', detail: 'one extractor per chunk' },
    { title: 'Quote check', detail: 'each quote re-found in the source, per chunk' },
    { title: 'Critic', detail: 'what did the extractor miss in this chunk' },
    { title: 'Conflicts', detail: 'items against Confirmed Decisions, FACTS and the signed quote' },
  ],
}

// Script API: https://code.claude.com/docs/en/workflows (pure-literal meta; agent/parallel/pipeline/phase/log;
// global args; no filesystem, no clock or random calls). Agents run as the project's `extractor`
// type (.claude/agents/extractor.md: read-only tools, model alias there). The main session does every write
// through intake.mjs, which re-checks each quote in code (lessons L139, L141, L142).
// The item shape must stay identical to .claude/skills/intake/item.schema.json (test/intake.test.mjs checks it).

const A = args || {}
const sources = Array.isArray(A.sources) ? A.sources : A.source ? [{ source: A.source, chunks: A.chunks }] : []
if (!sources.length || sources.some((s) => !s.source || !Array.isArray(s.chunks) || !s.chunks.length)) {
  throw new Error('intake needs args.sources = [{source: "PM/meetings/<folder>/source.md", chunks: [{label, startLine, endLine}]}] (run intake.mjs start, then chunks)')
}
const regDir = A.registryDir || '.claude'
const TYPE = 'extractor'

const STR = { type: 'string' }
const STRS = { type: 'array', items: STR }
const ITEM = {
  type: 'object',
  required: ['n', 'type', 'summary', 'quote', 'speaker', 'where', 'owner', 'due', 'confidence', 'new_scope', 'outward', 'conflicts'],
  properties: {
    n: { type: 'integer' },
    type: { type: 'string', enum: ['decision', 'client_ask', 'task', 'fact', 'deadline', 'risk', 'question_for_user', 'commitment', 'design_rule', 'client_approval'] },
    summary: STR, quote: STR, speaker: STR, where: STR, owner: STR, due: STR,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    new_scope: { type: 'boolean' }, outward: { type: 'boolean' },
    closes_when: STR, fact_key: STR, value: STR, ref: STR,
    metric: { type: 'object', required: ['claim', 'producible', 'evidence'], properties: { claim: STR, producible: { type: 'string', enum: ['yes', 'no', 'unchecked'] }, evidence: STR }, additionalProperties: false },
    conflicts: { type: 'array', items: { type: 'object', required: ['with', 'detail'], properties: { with: STR, detail: STR }, additionalProperties: false } },
    feedback_class: { type: 'string', enum: ['real_defect', 'false_positive', 'overclaim', 'decision_given', 'scope_change', 'not_checked'] },
  },
  additionalProperties: false,
}
const COVERAGE = { type: 'object', required: ['speakers', 'attachments', 'pages', 'lines'], properties: { speakers: STRS, attachments: STRS, pages: STRS, lines: STR }, additionalProperties: false }
const EXTRACTION = { type: 'object', required: ['coverage', 'not_covered', 'items'], properties: { coverage: COVERAGE, not_covered: STRS, items: { type: 'array', items: ITEM } } }
const QCHECK = { type: 'object', required: ['checks'], properties: { checks: { type: 'array', items: { type: 'object', required: ['n', 'found', 'exact_quote'], properties: { n: { type: 'integer' }, found: { type: 'boolean' }, exact_quote: STR } } } } }
const CRITIC = { type: 'object', required: ['missed', 'gaps'], properties: { missed: { type: 'array', items: ITEM }, gaps: STRS } }
const CONFLICTS = { type: 'object', required: ['updates', 'not_checked'], properties: {
  updates: { type: 'array', items: { type: 'object', required: ['n', 'conflicts', 'new_scope'], properties: { n: { type: 'integer' }, conflicts: ITEM.properties.conflicts, new_scope: { type: 'boolean' }, metric: ITEM.properties.metric } } },
  not_checked: STRS } }

const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim().toLowerCase()
const read = (c, src) => `Read ${src} lines ${c.startLine}-${c.endLine} with the Read tool (offset ${c.startLine}, limit ${c.endLine - c.startLine + 1}). The header above the SOURCE marker says whether it is a paraphrase or has merged speakers.`
const context = A.context ? `\nContext the session pulled (thread, calendar, chat), for reference only; quote ONLY from the source file: ${A.context}` : ''

async function quoteCheck(items, c, src, label) {
  if (!items.length) return items
  const r = await agent(`${read(c, src)}\nFor each item below, find its quote in those lines. found=true only if the words appear there; exact_quote = the exact source text (copy it, fix only whitespace or quote marks the extractor changed), or "" if not found. Do not judge the item, only the quote.\n${JSON.stringify(items.map((i) => ({ n: i.n, quote: i.quote })))}`,
    { label: `quotes-${label}`, phase: 'Quote check', schema: QCHECK, agentType: TYPE, effort: 'low' })
  if (!r) return items // unchecked: intake.mjs plan re-checks every quote in code anyway
  const by = new Map(r.checks.map((k) => [k.n, k]))
  return items.map((i) => { const k = by.get(i.n); return k && k.found && k.exact_quote ? { ...i, quote: k.exact_quote } : i })
}

const work = sources.flatMap((s) => s.chunks.map((c) => ({ ...c, src: s.source, label: `${s.source.split('/').slice(-2, -1)[0] || 'src'}:${c.label}` })))
log(`intake: ${sources.length} source(s), ${work.length} chunk(s); critic runs once per chunk (not until dry)`)

const perChunk = await pipeline(work,
  (_, c) => agent(`${read(c, c.src)}\nExtract every item in these lines as your agent instructions say. Meeting date: ${A.date || 'see the header'}. Number items from 1. coverage.lines = "${c.startLine}-${c.endLine}".${context}`,
    { label: `extract-${c.label}`, phase: 'Extract', schema: EXTRACTION, agentType: TYPE }),
  async (ex, c) => (ex ? { ex, items: await quoteCheck(ex.items, c, c.src, c.label) } : null),
  async (prev, c) => {
    if (!prev) return null
    const cr = await agent(`${read(c, c.src)}\nAn extractor produced the items below from these lines. Your only job: find what it MISSED. Check every speaker turn, attachment, page, table column (colour and severity codes too), every date, number, owner and "we will". Return missed items with verbatim quotes (numbered from ${prev.items.length + 1}) and coverage gaps. Return empty lists if nothing is missing; never pad.\n${JSON.stringify(prev.items.map((i) => ({ n: i.n, type: i.type, summary: i.summary, quote: i.quote })))}`,
      { label: `critic-${c.label}`, phase: 'Critic', schema: CRITIC, agentType: TYPE, effort: 'high' })
    const missed = cr ? await quoteCheck(cr.missed, c, c.src, `${c.label}-missed`) : []
    return { ...prev, missed, gaps: cr ? cr.gaps : [`critic did not run for lines ${c.startLine}-${c.endLine}`] }
  })

phase('Conflicts')
const extractions = []
for (const s of sources) {
  const rows = work.map((c, i) => ({ c, r: perChunk[i] })).filter((x) => x.c.src === s.source)
  const cov = { speakers: new Set(), attachments: new Set(), pages: new Set(), lines: [] }
  const notCovered = []
  const seen = new Set()
  const items = []
  for (const { c, r } of rows) {
    if (!r) { notCovered.push(`lines ${c.startLine}-${c.endLine}: extractor died, NOT extracted`); continue }
    r.ex.coverage.speakers.forEach((x) => cov.speakers.add(x)); r.ex.coverage.attachments.forEach((x) => cov.attachments.add(x)); r.ex.coverage.pages.forEach((x) => cov.pages.add(x))
    cov.lines.push(r.ex.coverage.lines || `${c.startLine}-${c.endLine}`)
    notCovered.push(...r.ex.not_covered, ...r.gaps.map((g) => `critic (lines ${c.startLine}-${c.endLine}): ${g}`))
    for (const it of [...r.items, ...r.missed]) { // chunks overlap by 3 lines: drop exact repeats
      const key = `${it.type}|${norm(it.quote)}`
      if (seen.has(key)) continue
      seen.add(key); items.push({ ...it, n: items.length + 1 })
    }
  }
  // Barrier on purpose: the contradiction check needs the whole de-duplicated list for this source.
  const batches = []
  for (let i = 0; i < items.length; i += 40) batches.push(items.slice(i, i + 40))
  const checks = await parallel(batches.map((b, j) => () => agent(`Check these items from ${s.source} against the project's settled record: ${regDir}/CLIENT.md "## Confirmed Decisions", ${regDir}/FACTS.md, the rule table in .claude/rules/design-system.md, and the signed quote or proposal FACTS points to. For each item: conflicts = every Confirmed Decision, FACTS line or design rule row it contradicts (with: "CD-<n>", "FACTS: <line>" or "DS: <row id>", detail: both sides in a few words); new_scope = true if it is work the signed quote does not cover; for any metric or claim the client "agreed", set metric.producible from what the code or data actually has (grep the schema or query code; evidence names the table/column/report, or why not). Never overwrite, only report. List what you could not check in not_checked.\n${JSON.stringify(b.map((i) => ({ n: i.n, type: i.type, summary: i.summary, quote: i.quote, new_scope: i.new_scope, metric: i.metric })))}`,
    { label: `conflicts-${s.source.split('/').slice(-2, -1)[0] || 'src'}-${j + 1}`, phase: 'Conflicts', schema: CONFLICTS, agentType: TYPE })))
  checks.forEach((ck, j) => {
    if (!ck) { notCovered.push(`contradiction check did not run for items ${j * 40 + 1}-${j * 40 + batches[j].length}`); return }
    notCovered.push(...ck.not_checked.map((x) => `contradiction check: ${x}`))
    for (const u of ck.updates) {
      const it = items.find((x) => x.n === u.n); if (!it) continue
      it.conflicts = [...it.conflicts, ...u.conflicts]; it.new_scope = it.new_scope || u.new_scope
      if (u.metric) it.metric = u.metric
    }
  })
  extractions.push({ source: s.source, coverage: { speakers: [...cov.speakers], attachments: [...cov.attachments], pages: [...cov.pages], lines: cov.lines.join(', ') }, not_covered: notCovered, items })
}

const total = extractions.reduce((n, e) => n + e.items.length, 0)
const holes = extractions.reduce((n, e) => n + e.not_covered.filter((x) => /NOT extracted|did not run/.test(x)).length, 0)
log(`intake: ${total} item(s) across ${extractions.length} source(s); ${holes} chunk or check(s) did not run`)
return { extractions, complete: holes === 0, next: 'Write each extraction to <folder>/items.json, then: intake.mjs plan, apply, landed, verify (skill steps 5-8).' }
