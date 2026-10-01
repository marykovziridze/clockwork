export const meta = {
  name: 'verify-change',
  description: 'Fresh multi-lens verification of one deployed change at a pinned URL + sha: design-system rows (one agent per rule group, Baseline floors included), craft review by eye, design fidelity against the Figma frame or reference, screenshot review, flows, widths x locales, accessibility, adversarial refuter. Returns PASS / BLOCK / PARTIAL with evidence and a not-measured list.',
  whenToUse: 'Closing a BUILT row that touches several pages or needs more than one lens. Args: {url, sha, pages, rulesPath, flows, design?: {<page>: <Figma frame URL or reference>}, groups?: ["SP","TY"], widths?, locales?, date?, scratchDir?, browserAgents?}. One page, one lens: use the verifier agent directly.',
  phases: [
    { title: 'Pin', detail: 'confirm the URL serves the sha; read the rules table' },
    { title: 'Measure', detail: 'one fresh verifier per lens and page' },
    { title: 'Refute', detail: 'every BLOCK gets a second independent refuter' },
    { title: 'Verdict', detail: 'computed in code from the evidence' },
  ],
}

// Script API: https://code.claude.com/docs/en/workflows (meta literal, agent/parallel/pipeline/phase/log,
// global args and budget; no filesystem, no clock or random calls). Agents run as the project's `verifier` type
// (.claude/agents/verifier.md), so its model line decides the model: measure, then pin. The cheap stages
// (pin, refute) pass a lower effort; measuring stages keep the agent's own.
// Why each part exists: fresh cold verifier (L37), pin URL+sha (L45, L60), harness first (L54),
// negative control (L55), BLOCKs re-derived by a second reader (L76), not-measured list (L77).

const A = args || {}
if (!A.url || !A.sha) throw new Error('verify-change needs args.url (deployed preview, not localhost) and args.sha')
const pages = Array.isArray(A.pages) && A.pages.length ? A.pages : [A.url]
const rulesPath = A.rulesPath || '.claude/rules/design-system.md'
const flows = Array.isArray(A.flows) ? A.flows : []
// Not under .claude/: writes there are protected paths, never auto-approved (permission-modes.md "Protected paths").
const scratch = A.scratchDir || `PM/.scratch/verify/${String(A.sha).slice(0, 12)}`
const BROWSER_AGENTS = Math.max(1, Math.min(4, Number(A.browserAgents) || 2)) // cap browsers on one Mac (L14)
const TYPE = A.agentType || 'verifier'
const design = A.design && typeof A.design === 'object' ? A.design : {}
const onlyGroups = Array.isArray(A.groups) && A.groups.length ? A.groups : null
const BUDGET = typeof budget !== 'undefined' && budget && budget.total ? budget : null

const S = (extra) => ({ type: 'object', ...extra })
const STR = { type: 'string' }
const NOT_MEASURED = { type: 'array', items: S({ properties: { what: STR, why: STR }, required: ['what', 'why'] }) }
const FINDING = S({
  properties: {
    severity: { type: 'string', enum: ['BLOCK', 'WARN'] },
    rule: STR, page: STR, width: { type: 'number' }, locale: STR,
    expected: STR, measured: STR, evidence: STR, method: STR,
  },
  required: ['severity', 'rule', 'expected', 'measured', 'evidence', 'method'],
})
const LENS = S({
  properties: {
    harness_ok: { type: 'boolean' },
    harness: STR,
    negative_control: S({ properties: { what: STR, caught: { type: 'boolean' }, evidence: STR }, required: ['what', 'caught', 'evidence'] }),
    findings: { type: 'array', items: FINDING },
    passes: { type: 'array', items: S({ properties: { rule: STR, evidence: STR }, required: ['rule', 'evidence'] }) },
    not_measured: NOT_MEASURED,
    coverage: STR,
  },
  required: ['harness_ok', 'harness', 'negative_control', 'findings', 'passes', 'not_measured', 'coverage'],
})
const PIN = S({
  properties: {
    pinned: { type: 'boolean' },
    served_sha_evidence: STR,
    rows: { type: 'array', items: S({ properties: { id: STR, rule: STR, value: STR, how: STR }, required: ['id', 'rule', 'how'] }) },
    widths: { type: 'array', items: { type: 'number' } },
    locales: { type: 'array', items: STR },
    known_hangs: { type: 'array', items: STR },
    not_measured: NOT_MEASURED,
  },
  required: ['pinned', 'served_sha_evidence', 'rows', 'widths', 'locales', 'not_measured'],
})
const REFUTE = S({
  properties: { remeasured: { type: 'boolean' }, refuted: { type: 'boolean' }, method: STR, evidence: STR },
  required: ['remeasured', 'refuted', 'method', 'evidence'],
})

const COMMON = `Target: ${A.url} at sha ${A.sha}. You are a fresh verifier: you did not build this and have no stake in it passing. Nothing the builder reported is evidence.
Before any browser read: install .claude/tools/measure.js (see its header), emulate the width, and check harnessOk in the SAME call that measures. harnessOk false twice = stop browser work and list it under not_measured with the harness output.
Read computed style, text ink or served pixels, never class names or source. Run a negative control (window.__cw.selfTest(), or a known-bad input for your lens) and report whether it was caught.
Write partial findings to ${scratch}/<your label>.md as you go. Open your own page (isolatedContext = your label); never resize or drive another session's page. Anything you could not measure goes in not_measured with the reason.`

// Run thunks with at most n at once (browser cap). Start order follows finish times, so a resumed
// run may re-run some agents instead of reading them from cache.
async function limited(n, thunks) {
  const out = new Array(thunks.length)
  let next = 0
  async function lane() { while (next < thunks.length) { const i = next++; try { out[i] = await thunks[i]() } catch (e) { out[i] = null } } }
  await Promise.all(Array.from({ length: Math.min(n, thunks.length) }, lane))
  return out
}

phase('Pin')
const pin = await agent(`${COMMON}
Job: pin the target before anyone measures. (1) Prove ${A.url} serves sha ${A.sha}: find the deployment id or build marker in the served HTML/headers and match it to the sha (git log -1 ${A.sha}); name the method. If you cannot prove it, pinned=false. (2) Read ${rulesPath}: return every row of every table in it (the Baseline BL-n rows included) as {id, rule, value, how}: rule and value cells copied verbatim (keep any {{…}} placeholder exactly as written), "how to measure" column verbatim; return its widths and locales rows${A.widths ? ` (caller overrides widths: ${JSON.stringify(A.widths)})` : ''}${A.locales ? ` (caller overrides locales: ${JSON.stringify(A.locales)})` : ''}. (3) List known instrument hangs for this site you find in the rules or reports (e.g. networkidle0, full-page screenshots).`,
  { label: 'pin', phase: 'Pin', schema: PIN, agentType: TYPE, effort: 'low' })

if (!pin || !pin.pinned) {
  return {
    verdict: 'PARTIAL', url: A.url, sha: A.sha, date: A.date || null,
    reason: pin ? `could not prove the URL serves the sha: ${pin.served_sha_evidence}` : 'pin agent died',
    confirmed_blocks: [], unconfirmed_blocks: [], refuted: [], warnings: [], passes: 0,
    not_measured: [{ what: 'everything', why: 'target not pinned to the sha; a verdict on another build is not a verdict' }],
  }
}
const widths = A.widths || (pin.widths.length ? pin.widths : [320, 390, 768, 1024, 1440, 1710, 1920, 2560])
const locales = A.locales || (pin.locales.length ? pin.locales : ['default'])
const hangs = (pin.known_hangs || []).length ? `Known instrument hangs, avoid them: ${pin.known_hangs.join('; ')}.` : ''
const rowText = (r) => `- ${r.id}: ${r.rule}${r.value ? ` = ${r.value}` : ''} | how: ${r.how}`
// Rows judged by looking (how = "screenshot review") get their own lens; the rest split by group (SP, TY, CO …),
// so one agent measures a handful of rows, not the whole table, and a PASS is reachable.
// A row whose rule or value still holds an unfilled {{…}} is not a rule yet (design-system.md, D14). Blank is not
// skip: a Baseline row (BL-n, public floors with a source) that "backs" it holds the page to its floor meanwhile.
// Only an unfilled row no Baseline row backs is listed as "not measurable: unfilled"; it never makes a PASS impossible.
// A Baseline row whose backed rows are all filled is superseded by the project's values; one that backs nothing always applies.
const isUnfilled = (r) => /\{\{[^}]*\}\}/.test(`${r.rule} ${r.value || ''}`)
const isBaseline = (r) => /^BL-\d+$/.test(String(r.id))
const backsOf = (r) => ((/\(backs ([^)]+)\)/.exec(r.rule) || [])[1] || '').split(/,\s*/).filter(Boolean)
const baseRows = pin.rows.filter(isBaseline)
const projRows = pin.rows.filter((r) => !isBaseline(r))
const backerOf = (id) => baseRows.find((b) => backsOf(b).includes(id))
const heldToBaseline = projRows.filter((r) => isUnfilled(r) && backerOf(r.id)).map((r) => ({ id: r.id, via: backerOf(r.id).id }))
const unfilled = projRows.filter((r) => isUnfilled(r) && !backerOf(r.id)).map((r) => ({ id: r.id, why: 'not measurable: unfilled' }))
const superseded = baseRows.filter((b) => backsOf(b).length && backsOf(b).every((id) => projRows.some((r) => r.id === id && !isUnfilled(r))))
const activeBase = baseRows.filter((b) => !superseded.includes(b)).map((b) => {
  const held = heldToBaseline.filter((h) => h.via === b.id).map((h) => h.id)
  return held.length ? { ...b, rule: `${b.rule} [floor for unfilled ${held.join(', ')}]` } : b
})
const ruleRows = [...projRows.filter((r) => !isUnfilled(r)), ...activeBase]
const looked = ruleRows.filter((r) => /screenshot review/i.test(r.how))
const groups = {}
for (const r of ruleRows.filter((x) => !looked.includes(x))) {
  const g = String(r.id).split('-')[0] || 'rows'
  // Baseline floors run whatever args.groups says: they are what catches a page with no padding at all.
  if (!onlyGroups || onlyGroups.includes(g) || g === 'BL') (groups[g] = groups[g] || []).push(r)
}
const skippedGroups = onlyGroups ? [...new Set(ruleRows.map((r) => String(r.id).split('-')[0]))].filter((g) => !onlyGroups.includes(g) && g !== 'BL') : []
// Craft lens: one agent per page (all three widths in it), reading the installed design-audit skill. Chosen over
// impeccable critique (needs its own detector script and two sub-agents) and interface-design (dashboards only):
// bencium's audit is purely visual and covers spacing, rhythm, alignment and every viewport.
const CRAFT_SKILL = '$HOME/.claude/skills/bencium-design-audit'
const BASE_NOTE = 'Baseline rows (BL-n): install measure.js, emulate each width the row names, run window.__cw.baselineScan() and read the list the row names; every item in it is a finding with its numbers (BLOCK), unless it falls under the exemption the row itself states. '

// One task per lens x page (flows: one per flow). Each is independent, so they run without a barrier.
// The adversarial refuter goes first so a token budget never drops it.
const tasks = []
tasks.push({ lens: 'adversarial', page: pages.join(', '), prompt: `Lens: adversarial refuter. Your only job is to prove this change broken. Diff ${A.sha} against its parent: what did the fix over-reach into, what must not have changed, which other pages match the changed selectors or components (measure them too), which cross-page drift appeared. Every claim you make is a measurement with numbers.` })
for (const page of pages) {
  for (const [g, rows] of Object.entries(groups)) tasks.push({ lens: `design-system ${g}`, page, prompt: `Lens: design-system rows ${g} on ${page}. ${g === 'BL' ? BASE_NOTE : ''}Measure EVERY row below with its "how" method (locale ${locales[0]}) at 390 and 1440, and at every width the row itself names; "@W" in a row means all of ${widths.join(', ')}. (The responsive lens covers every width for overflow and cut text.) A row you cannot measure goes in not_measured; never pass it by reading source.\n${rows.map(rowText).join('\n')}` })
  if (design[page]) tasks.push({ lens: 'design-fidelity', page, prompt: `Lens: design fidelity on ${page} against its design source ${design[page]}. Fetch the frame with the Figma tools (get_screenshot for the picture, get_design_context or get_metadata for sizes) or open the reference. Emulate the frame's width. Compare rendered geometry with the frame: position, width and height of each section, heading, image and button; gaps and padding; font size, weight and line height. Take your own screenshot at that width and look at both side by side. Each difference over 2px, or any element missing, moved or added, is a finding with both numbers.` })
  if (looked.length) tasks.push({ lens: 'screenshot-review', page, prompt: `Lens: screenshot review on ${page}. Take viewport screenshots at 390 and 1440 (never full-page), open each image and look at it. Judge each row below by what you see, naming the element and the screenshot; a pass needs the screenshot path as evidence.\n${looked.map(rowText).join('\n')}` })
  tasks.push({ lens: 'craft', page, prompt: `Lens: craft review on ${page}, by eye, as a senior designer would. First read ${CRAFT_SKILL}/SKILL.md and ${CRAFT_SKILL}/design-principles.md (the installed design-audit skill): use its Step 1 audit dimensions only, not its plan output; ${rulesPath} wins wherever they differ. If the skill is missing, list that in not_measured and judge with the list below. At 390, 768 and 1440 (this one agent does all three): viewport screenshots only (never full-page), scroll through the whole page, open each image and look at it. Judge execution, never the design choice: an unusual layout, asymmetry, bold or sparse composition, or the absence of a hero, eyebrow or cards is never a finding by itself. Report every obvious craft defect: text or a control touching the screen edge or its box edge, missing or cramped padding, uneven spacing between like elements, edges that should line up and do not, a heading nearer the block above than its own text, stretched images, default-looking UI (browser-default buttons, fields, fonts or lists). Each finding names the element, the width and the screenshot path; a BLOCK also needs a number read with styles() or baselineScan(), a look without a number is a WARN. A pass needs the screenshot paths as evidence.` })
  tasks.push({ lens: 'responsive-locales', page, prompt: `Lens: responsive + locales on ${page}. For each width in ${widths.join(', ')} and each locale in ${locales.join(', ')}: overflowScan, textCut, images (imageResolution), anchors. Name the widths and locales covered and not covered.` })
  tasks.push({ lens: 'accessibility', page, prompt: `Lens: accessibility on ${page}. renderedContrast on all text (needsPixelCheck items: two screenshots with hideInk, report the floor), focus ring after real Tab presses (focusState), targetSizes, pause control on auto-moving content, fragment targets (anchorLanding). Widths: 390 and 1440 minimum.` })
}
for (const f of flows) {
  const name = typeof f === 'string' ? f : f.name
  tasks.push({ lens: 'functional-flow', page: name, prompt: `Lens: functional flow "${name}": ${JSON.stringify(f)}. Drive it end to end in the browser as the real user would. Proof is the downstream record (CRM row, stored file, email in the test inbox, analytics event arriving), never the UI toast or an HTTP 2xx. Before any write: state the blast radius, use only test accounts/markers named in the flow, clean up and read back. If you cannot read the downstream store with your tools, the flow is NOT MEASURED.` })
}
// Cost is stated up front, so nobody launches a multi-million-token run by accident (about 150k tokens per lens agent).
log(`verify-change: ${tasks.length} lens agent(s) + 1 pin + one refuter per BLOCK, about ${(tasks.length * 0.15).toFixed(1)}M tokens (estimate, ~150k each), plus the measure.js install each browser agent re-types per page load (~30 KB, assumed ~9k output tokens each time, not measured). ${Object.keys(groups).length} rule group(s) x ${pages.length} page(s), plus 1 craft agent per page (3 widths in one agent); pass args.groups to measure only the rows the change touches.`)
// No silent caps: with a token target set (budget.total), keep what fits (about 150k tokens per lens agent) and
// list the rest as not measured.
const dropped = []
if (BUDGET) {
  const fit = Math.max(1, Math.floor(BUDGET.remaining() / 150000))
  if (tasks.length > fit) { dropped.push(...tasks.splice(fit)); log(`token budget: ${dropped.length} lens task(s) not run: ${dropped.map((t) => `${t.lens} on ${t.page}`).join('; ')}`) }
}

phase('Measure')
const results = await limited(BROWSER_AGENTS, tasks.map((t, i) => async () => {
  const label = `${t.lens.replace(/\s+/g, '-')}-${i}`
  let r = null
  try {
    r = await agent(`${COMMON}\n${hangs}\n${t.prompt}\nTime-box: stop starting new checks at about 70% of your turns and return what you have.`,
      { label, phase: 'Measure', schema: LENS, agentType: TYPE })
  } catch (e) { r = null }
  if (!r) return { task: t, label, dead: true }
  const blocks = r.findings.filter((f) => f.severity === 'BLOCK')
  // Second, independent reader for every BLOCK (L76). Pipelined per lens: no barrier across lenses.
  const verdicts = await parallel(blocks.map((f, j) => () => agent(`Target: ${A.url} at sha ${A.sha}. You are a second, independent verifier. Another agent claims this BLOCK:\n${JSON.stringify(f)}\nTry to refute it with a DIFFERENT method from "${f.method}" (a different instrument, width, or the source of truth: design file, rules row, served HTML). Install .claude/tools/measure.js and check harnessOk before any browser read. remeasured=true only if you took your own measurement; refuted=true only if it contradicts the claim.`,
    { label: `refute-${label}-${j}`, phase: 'Refute', schema: REFUTE, agentType: TYPE, effort: 'medium' })))
  return { task: t, label, r, blocks: blocks.map((f, j) => ({ ...f, lens: t.lens, second: verdicts[j] })) }
}))

phase('Verdict')
const confirmed = [], unconfirmed = [], refuted = [], warnings = [], notMeasured = [], lenses = []
let passes = 0
for (const t of dropped) notMeasured.push({ what: `${t.lens} on ${t.page}`, why: 'not run: the token budget ran out' })
for (const g of skippedGroups) notMeasured.push({ what: `design-system rows ${g}`, why: 'outside args.groups (scoped to the changed area)' })
for (const res of results) {
  if (!res || res.dead) {
    const t = res ? res.task : { lens: 'unknown', page: '' }
    notMeasured.push({ what: `${t.lens} on ${t.page}`, why: 'agent died or was stopped' })
    lenses.push({ lens: t.lens, page: t.page, ran: false })
    continue
  }
  const { task, r } = res
  const instrumentOk = r.harness_ok && r.negative_control.caught
  lenses.push({ lens: task.lens, page: task.page, ran: true, harness_ok: r.harness_ok, negative_control: r.negative_control, coverage: r.coverage })
  notMeasured.push(...r.not_measured.map((n) => ({ what: `${task.lens} on ${task.page}: ${n.what}`, why: n.why })))
  if (instrumentOk) passes += r.passes.length
  else if (r.passes.length) notMeasured.push({ what: `${task.lens} on ${task.page}: ${r.passes.length} passes`, why: r.harness_ok ? 'negative control not caught: instrument unproven' : `harness failed: ${r.harness}` })
  warnings.push(...r.findings.filter((f) => f.severity === 'WARN').map((f) => ({ ...f, lens: task.lens })))
  for (const b of res.blocks) {
    if (!b.second) unconfirmed.push({ ...b, why: 'second refuter died' })
    else if (!b.second.remeasured) unconfirmed.push({ ...b, why: `second reader could not re-measure: ${b.second.evidence}` })
    else if (b.second.refuted) refuted.push(b)
    else confirmed.push(b)
  }
}

const verdict = confirmed.length ? 'BLOCK' : (notMeasured.length || unconfirmed.length || passes === 0) ? 'PARTIAL' : 'PASS'
// The rows nobody could measure (unfilled, no Baseline row) are part of the verdict line, never a footnote.
const verdictLine = `${verdict}${unfilled.length ? ` · not measurable (unfilled, no baseline): ${unfilled.map((u) => u.id).join(', ')}` : ''}${heldToBaseline.length ? ` · held to Baseline: ${heldToBaseline.map((h) => `${h.id}→${h.via}`).join(', ')}` : ''}`
log(`verify-change ${verdictLine} · ${confirmed.length} confirmed BLOCK, ${unconfirmed.length} unconfirmed, ${refuted.length} refuted, ${notMeasured.length} not measured`)
return {
  verdict, verdict_line: verdictLine, url: A.url, sha: A.sha, date: A.date || null, served_sha_evidence: pin.served_sha_evidence,
  widths, locales, pages, confirmed_blocks: confirmed, unconfirmed_blocks: unconfirmed, refuted, warnings,
  passes, not_measured: notMeasured, unfilled_rows: unfilled,
  baseline: { held: heldToBaseline, superseded: superseded.map((b) => b.id), applied: activeBase.map((b) => b.id) }, lenses, scratch,
}
