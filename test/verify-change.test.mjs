// Tests for templates/claude/workflows/verify-change.js: runs the script body offline with mocked
// agent()/parallel()/phase()/log() and checks the verdict logic and the script-API constraints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'templates', 'claude', 'workflows', 'verify-change.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const body = SRC.replace(/^export const meta = /, 'const meta = ');
const metaText = SRC.slice(SRC.indexOf('{'), SRC.indexOf('\n}\n') + 2);

const ROWS = [{ id: 'DS-1', rule: 'section padding', value: '128px', how: 'styles(section, padding-top) at every width' },
  { id: 'DS-2', rule: 'body text contrast', value: '4.5:1', how: 'renderedContrast(p)' }];
const lens = (over = {}) => ({ harness_ok: true, harness: 'visible 390', negative_control: { what: 'selfTest', caught: true, evidence: 'allCaught' },
  findings: [], passes: [{ rule: 'DS-1', evidence: '128px at 390' }], not_measured: [], coverage: '40 elements', ...over });
const BLOCK = { severity: 'BLOCK', rule: 'DS-1', expected: '128px', measured: '96px', evidence: 'styles() at 1440', method: 'computed style' };

async function run(args, { pin, lensFor = () => lens(), refute = () => ({ remeasured: true, refuted: false, method: 'ink', evidence: 'same 96px' }), budget } = {}) {
  const calls = [];
  let live = 0, maxLive = 0;
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    live++; maxLive = Math.max(maxLive, live);
    await new Promise((r) => setTimeout(r, 2));
    live--;
    if (opts.label === 'pin') return pin === undefined ? { pinned: true, served_sha_evidence: 'dpl_x matches', rows: ROWS, widths: [390, 1440], locales: ['nl', 'de'], known_hangs: [], not_measured: [] } : pin;
    if (opts.label.startsWith('refute-')) return refute(prompt, opts);
    return lensFor(opts.label, prompt);
  };
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const pipeline = async () => { throw new Error('not used'); };
  const logs = [];
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', body);
  const out = await fn(agent, parallel, pipeline, () => {}, (m) => logs.push(m), args, budget);
  return { out, calls, maxLive, logs };
}
const ARGS = { url: 'https://preview.example.test', sha: 'abc1234', pages: ['/', '/about'], flows: ['contact form → CRM lead'], browserAgents: 2 };

test('meta is a pure literal first statement with the phases used in the body', () => {
  assert.match(SRC, /^export const meta = \{/);
  const meta = new Function(`return (${metaText})`)();
  assert.equal(meta.name, 'verify-change');
  assert.doesNotMatch(metaText, /\$\{|\.\.\.|\w\(/, 'no interpolation, spread or calls in meta');
  const titles = meta.phases.map((p) => p.title);
  for (const m of SRC.matchAll(/phase(?:\(|: )'([^']+)'/g)) assert.ok(titles.includes(m[1]), `phase ${m[1]} not in meta`);
});

test('script uses no forbidden APIs (Date.now, Math.random, new Date(), import, require, fs)', () => {
  assert.doesNotMatch(body, /Date\.now|Math\.random|new Date\(\s*\)|\bimport\s*\(|\brequire\s*\(|\bfs\./);
  assert.doesNotMatch(body, /:\s*(string|number|boolean)\b\s*[,)=]/, 'no TypeScript annotations');
});

test('missing url or sha throws instead of verifying nothing', async () => {
  await assert.rejects(() => run({ url: 'https://x.test' }), /args\.url .* args\.sha/);
  await assert.rejects(() => run(undefined), /needs args\.url/);
});

test('an unpinned target returns PARTIAL and runs no lens', async () => {
  const { out, calls } = await run(ARGS, { pin: { pinned: false, served_sha_evidence: 'no build id found', rows: [], widths: [], locales: [], not_measured: [] } });
  assert.equal(out.verdict, 'PARTIAL');
  assert.equal(calls.length, 1);
  assert.match(out.reason, /no build id found/);
});

test('all lenses clean with proven instruments -> PASS; every row and width reaches the prompts', async () => {
  const { out, calls, maxLive } = await run(ARGS);
  assert.equal(out.verdict, 'PASS', JSON.stringify(out.not_measured));
  const lensCalls = calls.filter((c) => c.opts.phase === 'Measure');
  assert.equal(lensCalls.length, 2 * 4 + 1 + 1, '4 lenses (design rows, craft, responsive, accessibility) x 2 pages + 1 flow + adversarial');
  assert.ok(lensCalls.every((c) => c.opts.agentType === 'verifier' && c.opts.schema));
  const ds = lensCalls.filter((c) => c.opts.label.startsWith('design-system'));
  for (const c of ds) { assert.match(c.prompt, /DS-1/); assert.match(c.prompt, /DS-2/); assert.match(c.prompt, /390, 1440/); }
  assert.ok(lensCalls.some((c) => /nl, de/.test(c.prompt)), 'locales reach the responsive lens');
  assert.ok(maxLive <= 2, `browser cap exceeded: ${maxLive}`);
  assert.ok(lensCalls.every((c) => /abc1234/.test(c.prompt) && /harnessOk/.test(c.prompt)));
});

test('a BLOCK confirmed by the second refuter -> BLOCK', async () => {
  const { out, calls } = await run(ARGS, { lensFor: (label) => label.startsWith('design-system-DS-1') ? lens({ findings: [BLOCK] }) : lens() });
  assert.equal(out.verdict, 'BLOCK');
  assert.equal(out.confirmed_blocks.length, 1);
  const ref = calls.filter((c) => c.opts.label.startsWith('refute-'));
  assert.equal(ref.length, 1);
  assert.match(ref[0].prompt, /DIFFERENT method from "computed style"/);
});

test('a BLOCK the refuter disproves does not count, but stays visible', async () => {
  const { out } = await run(ARGS, { lensFor: (l) => l.startsWith('design-system-DS-1') ? lens({ findings: [BLOCK] }) : lens(),
    refute: () => ({ remeasured: true, refuted: true, method: 'ink at 1440', evidence: '128px' }) });
  assert.equal(out.verdict, 'PASS');
  assert.equal(out.refuted.length, 1);
});

test('refuter died -> unconfirmed BLOCK -> PARTIAL, never PASS', async () => {
  const { out } = await run(ARGS, { lensFor: (l) => l.startsWith('accessibility') ? lens({ findings: [BLOCK] }) : lens(), refute: () => null });
  assert.equal(out.verdict, 'PARTIAL');
  assert.equal(out.unconfirmed_blocks.length, 2);
});

test('a refuter that could not re-measure leaves the BLOCK unconfirmed -> PARTIAL', async () => {
  const { out } = await run(ARGS, { lensFor: (l) => l.startsWith('design-system-DS-1') ? lens({ findings: [BLOCK] }) : lens(),
    refute: () => ({ remeasured: false, refuted: false, method: 'none', evidence: 'no browser' }) });
  assert.equal(out.verdict, 'PARTIAL');
  assert.match(out.unconfirmed_blocks[0].why, /could not re-measure: no browser/);
});

test('negative control not caught -> that lens\'s passes become not-measured -> PARTIAL', async () => {
  const { out } = await run(ARGS, { lensFor: (l) => l.startsWith('responsive') ? lens({ negative_control: { what: 'selfTest', caught: false, evidence: 'overflow missed' } }) : lens() });
  assert.equal(out.verdict, 'PARTIAL');
  assert.ok(out.not_measured.some((n) => /instrument unproven/.test(n.why)));
});

test('a dead lens agent or a thrown schema failure -> PARTIAL with the lens named', async () => {
  const { out } = await run(ARGS, { lensFor: (l) => { if (l.startsWith('functional-flow')) throw new Error('schema failed 5x'); return l.startsWith('adversarial') ? null : lens(); } });
  assert.equal(out.verdict, 'PARTIAL');
  assert.ok(out.not_measured.some((n) => /functional-flow on contact form/.test(n.what)));
  assert.ok(out.not_measured.some((n) => /adversarial/.test(n.what)));
});

test('a lens that reports not_measured items makes the verdict PARTIAL', async () => {
  const { out } = await run(ARGS, { lensFor: (l) => l.startsWith('functional-flow') ? lens({ not_measured: [{ what: 'CRM record', why: 'no CRM tool' }] }) : lens() });
  assert.equal(out.verdict, 'PARTIAL');
  assert.ok(out.not_measured.some((n) => /CRM record/.test(n.what)));
});

test('design rows split into one agent per group; screenshot-review rows get their own lens; groups scope the run', async () => {
  const rows = [...ROWS, { id: 'SP-1', rule: 'gap scale', value: '', how: 'styles() gaps' }, { id: 'BAN-1', rule: 'no pill buttons', value: '', how: 'screenshot review; grep' }];
  const pin = { pinned: true, served_sha_evidence: 'ok', rows, widths: [390], locales: ['nl'], known_hangs: [], not_measured: [] };
  const { calls } = await run({ ...ARGS, pages: ['/'] }, { pin });
  const m = calls.filter((c) => c.opts.phase === 'Measure').map((c) => c.opts.label);
  assert.ok(m.some((l) => l.startsWith('design-system-DS')) && m.some((l) => l.startsWith('design-system-SP')));
  const shot = calls.find((c) => c.opts.label.startsWith('screenshot-review'));
  assert.match(shot.prompt, /BAN-1/); assert.doesNotMatch(calls.find((c) => c.opts.label.startsWith('design-system-DS')).prompt, /BAN-1|SP-1/);
  const scoped = await run({ ...ARGS, pages: ['/'], groups: ['SP'] }, { pin });
  assert.ok(!scoped.calls.some((c) => c.opts.label.startsWith('design-system-DS')));
  assert.ok(scoped.out.not_measured.some((n) => /rows DS/.test(n.what) && /args\.groups/.test(n.why)), 'a scoped-out group is listed, never silently skipped');
});

test('design fidelity lens runs only for pages with a design source, and uses the Figma frame', async () => {
  const { calls } = await run({ ...ARGS, design: { '/about': 'https://www.figma.com/design/abc?node-id=1-2' } });
  const df = calls.filter((c) => c.opts.label.startsWith('design-fidelity'));
  assert.equal(df.length, 1);
  assert.match(df[0].prompt, /\/about/); assert.match(df[0].prompt, /get_screenshot/); assert.match(df[0].prompt, /node-id=1-2/);
});

test('cheap stages pass a lower effort; a token budget drops lens tasks visibly, never the adversarial one', async () => {
  const { calls, out, logs } = await run(ARGS, { budget: { total: 400000, remaining: () => 300000, spent: () => 100000 } });
  assert.equal(calls.find((c) => c.opts.label === 'pin').opts.effort, 'low');
  const m = calls.filter((c) => c.opts.phase === 'Measure');
  assert.equal(m.length, 2);
  assert.ok(m.some((c) => c.opts.label.startsWith('adversarial')));
  assert.equal(out.verdict, 'PARTIAL');
  assert.ok(out.not_measured.some((n) => /token budget/.test(n.why)));
  assert.ok(logs.some((l) => /token budget/.test(l)));
  const r = await run(ARGS, { lensFor: (l) => l.startsWith('design-system-DS-1') ? lens({ findings: [BLOCK] }) : lens() });
  assert.equal(r.calls.find((c) => c.opts.label.startsWith('refute-')).opts.effort, 'medium');
});

test('the first log line states the agent count and a token estimate; scratch is outside .claude/', async () => {
  const { logs, calls, out } = await run(ARGS);
  assert.match(logs[0], /^verify-change: \d+ lens agent\(s\) \+ 1 pin \+ one refuter per BLOCK, about \d+\.\dM tokens/);
  assert.match(logs[0], /args\.groups/);
  assert.match(logs[0], /measure\.js install .* not measured/, 'the measure.js re-typing cost is named, as an assumption');
  assert.match(out.scratch, /^PM\/\.scratch\/verify\//);
  const ds = calls.find((c) => /Lens: design-system rows/.test(c.prompt));
  assert.match(ds.prompt, /at 390 and 1440, and at every width the row itself names/);
});

test('D14: design rows with an unfilled {{…}} are not sent to any lens and do not stop a PASS; they are listed as not measurable: unfilled', async () => {
  const rows = [...ROWS, { id: 'MO-2', rule: 'Hover, focus, press timing: decide per project', value: '`{{ms · easing}}`', how: 'transition per state' },
    { id: 'SP-6', rule: 'text column is a track', value: 'minmax(0,1fr) min({{prose}},100%)', how: 'SP-5 at 1440' }];
  const pin = { pinned: true, served_sha_evidence: 'ok', rows, widths: [390], locales: ['nl'], known_hangs: [], not_measured: [] };
  const { out, calls } = await run({ ...ARGS, flows: [] }, { pin });
  assert.equal(out.verdict, 'PASS', JSON.stringify(out.not_measured));
  assert.deepEqual(out.unfilled_rows.map((r) => r.id), ['MO-2', 'SP-6']);
  assert.ok(out.unfilled_rows.every((r) => r.why === 'not measurable: unfilled'));
  assert.ok(!calls.some((c) => /MO-2|SP-6/.test(c.prompt) && c.opts.label !== 'pin'), 'no lens is asked to measure an unfilled row');
  assert.match(calls.find((c) => c.opts.label === 'pin').prompt, /keep any \{\{…\}\} placeholder exactly as written/);
});

// Blank is not skip (2026-10-01): an unfilled row is held to the Baseline row that backs it.
const BL = [
  { id: 'BL-1', rule: 'No text or control inside the side gutter', value: 'phone 16px · tablet and desktop 24px', how: 'baselineScan().edges at 320, 390' },
  { id: 'BL-2', rule: 'Sections breathe (backs SP-2, SP-3)', value: '48px at every width', how: 'baselineScan().sections @W' },
  { id: 'BL-9', rule: 'Body text line length (backs SP-5)', value: '≤ 75 characters', how: 'baselineScan().measure @W' },
];
const pinWith = (rows) => ({ pinned: true, served_sha_evidence: 'ok', rows, widths: [390, 1440], locales: ['nl'], known_hangs: [], not_measured: [] });

test('an unfilled row a Baseline row backs is measured against that floor; only rows with no value and no baseline are not measurable, and the verdict line names them', async () => {
  const rows = [...ROWS, ...BL,
    { id: 'SP-2', rule: 'Section padding is the section size token', value: '`{{Section size}}`', how: 'equal hero padding-top @W' },
    { id: 'SP-3', rule: 'Gap between sections by meaning', value: '`{{3 steps}}`', how: 'gap() between sections' },
    { id: 'SP-5', rule: 'Prose 66–75 characters a line', value: '65ch', how: 'characters per body line @W' },
    { id: 'MO-2', rule: 'Hover timing: decide per project', value: '`{{ms · easing}}`', how: 'transition per state' }];
  const { out, calls, logs } = await run({ ...ARGS, pages: ['/'], flows: [] }, { pin: pinWith(rows) });
  assert.equal(out.verdict, 'PASS', JSON.stringify(out.not_measured));
  assert.deepEqual(out.baseline.held, [{ id: 'SP-2', via: 'BL-2' }, { id: 'SP-3', via: 'BL-2' }]);
  assert.deepEqual(out.baseline.superseded, ['BL-9'], 'SP-5 is filled: the project value governs, BL-9 is not measured');
  assert.deepEqual(out.baseline.applied, ['BL-1', 'BL-2']);
  assert.deepEqual(out.unfilled_rows, [{ id: 'MO-2', why: 'not measurable: unfilled' }]);
  const bl = calls.find((c) => c.opts.label.startsWith('design-system-BL'));
  assert.ok(bl, 'the Baseline rows get their own lens');
  assert.match(bl.prompt, /BL-1/); assert.match(bl.prompt, /BL-2: Sections breathe .*\[floor for unfilled SP-2, SP-3\]/);
  assert.doesNotMatch(bl.prompt, /BL-9/); assert.match(bl.prompt, /baselineScan\(\)/);
  assert.ok(!calls.some((c) => c.opts.label !== 'pin' && /SP-2:|SP-3:|MO-2/.test(c.prompt)), 'the unfilled rows themselves reach no lens');
  assert.match(out.verdict_line, /^PASS · not measurable \(unfilled, no baseline\): MO-2 · held to Baseline: SP-2→BL-2, SP-3→BL-2$/);
  assert.ok(logs.some((l) => l.includes(out.verdict_line)), 'the verdict log line carries the not-measurable list');
  assert.match(calls.find((c) => c.opts.label === 'pin').prompt, /the Baseline BL-n rows included/);
});

test('negative control: with no Baseline rows in the table, an unfilled SP-2 is still not measurable (the floor comes only from a backing row)', async () => {
  const rows = [...ROWS, { id: 'SP-2', rule: 'Section padding', value: '`{{Section size}}`', how: 'padding-top @W' }];
  const { out } = await run({ ...ARGS, pages: ['/'], flows: [] }, { pin: pinWith(rows) });
  assert.deepEqual(out.unfilled_rows, [{ id: 'SP-2', why: 'not measurable: unfilled' }]);
  assert.deepEqual(out.baseline.held, []);
});

test('args.groups scopes project rows but never drops the Baseline floors', async () => {
  const rows = [...ROWS, ...BL, { id: 'SP-1', rule: 'gap scale', value: '8px', how: 'styles() gaps' }];
  const { calls, out } = await run({ ...ARGS, pages: ['/'], flows: [], groups: ['SP'] }, { pin: pinWith(rows) });
  assert.ok(calls.some((c) => c.opts.label.startsWith('design-system-BL')));
  assert.ok(!out.not_measured.some((n) => /rows BL/.test(n.what)));
  assert.ok(out.not_measured.some((n) => /rows DS/.test(n.what)));
});

test('craft lens: one agent per page, three widths, names the installed audit skill; its BLOCK goes to the second refuter', async () => {
  const CRAFT_BLOCK = { severity: 'BLOCK', rule: 'craft: card text touches its edge', expected: '≥ 16px inset', measured: '4px', evidence: 'baselineScan().cards at 390; shot-390.png', method: 'screenshot + baselineScan' };
  const { out, calls, logs } = await run(ARGS, { lensFor: (l) => l.startsWith('craft') ? lens({ findings: [CRAFT_BLOCK] }) : lens() });
  const craft = calls.filter((c) => c.opts.label.startsWith('craft'));
  assert.equal(craft.length, 2, 'one per page, not per width');
  assert.match(craft[0].prompt, /\$HOME\/\.claude\/skills\/bencium-design-audit\/SKILL\.md/);
  assert.match(craft[0].prompt, /At 390, 768 and 1440 \(this one agent does all three\)/);
  assert.match(craft[0].prompt, /missing or cramped padding/);
  const ref = calls.filter((c) => c.opts.label.startsWith('refute-craft'));
  assert.equal(ref.length, 2, 'every craft BLOCK gets a second reader');
  assert.equal(out.verdict, 'BLOCK');
  assert.ok(out.confirmed_blocks.every((b) => b.lens === 'craft'));
  assert.match(logs[0], /1 craft agent per page/);
});
