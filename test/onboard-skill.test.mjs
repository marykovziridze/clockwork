// Tests for the onboarding skill and workflow (build contract CONTRACT-ONBOARD §2, §4, §5): onboard/SKILL.md,
// onboard/workflows/onboard.js, onboard/mapping.md, onboard/plan-template.md. Offline; temp files in os.tmpdir(),
// removed afterwards. Every allowed subcommand and flag is read from the real tools, never from a list kept here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OB_DIR = path.join(KIT, 'onboard');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const SKILL = read(OB_DIR, 'SKILL.md');
const WF = read(OB_DIR, 'workflows', 'onboard.js');
const MAPPING = read(OB_DIR, 'mapping.md');
const PLAN_TPL = read(OB_DIR, 'plan-template.md');
const ONBOARD_SRC = read(OB_DIR, 'onboard.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw onboard skill test ')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ── what the tools really accept ─────────────────────────────────────────────
// onboard.mjs: the usage header ("//   node onboard.mjs <sub> …flags") and the `case '<sub>':` labels in main().
function onboardCli() {
  const subs = {};
  for (const m of ONBOARD_SRC.matchAll(/^\/\/\s+node onboard\.mjs (\w+)([^\n]*)$/gm)) subs[m[1]] = new Set([...m[2].matchAll(/--([a-z][a-z-]*)/g)].map((x) => x[1]));
  const cases = new Set([...ONBOARD_SRC.matchAll(/^\s+case '(\w+)': \{/gm)].map((m) => m[1]));
  return { subs, cases };
}
const installFlags = () => new Set([...read(KIT, 'install.mjs').match(/const USAGE = '([^']+)'/)[1].matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
const registryCommands = () => new Set([...read(KIT, 'templates', 'claude', 'tools', 'registry.mjs').match(/const COMMANDS = \{([^}]+)\}/)[1].matchAll(/(\w+):/g)].map((m) => m[1]));
const registryFlags = () => new Set([...read(KIT, 'templates', 'claude', 'tools', 'registry.mjs').split('\n').filter((l) => l.startsWith('//')).join('\n').matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
const doctorFlags = () => new Set([...read(KIT, 'templates', 'claude', 'hooks', 'clockwork-doctor.mjs').matchAll(/'--([a-z][a-z-]*)'/g)].map((m) => m[1]));

// Every "onboard.mjs <word> …" in a text: the subcommand and the flags up to the end of that command.
function onboardUses(text) {
  const uses = [];
  for (const m of text.matchAll(/onboard\.mjs"?\s+([a-z]+)([^\n]*)/g)) {
    const rest = m[2].split(/\s>{1,2}\s|;|\||`|\)/)[0]; // the command ends at a redirect, ; | ` or )
    uses.push({ sub: m[1], flags: [...rest.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map((x) => x[1]), at: `${m[1]}${rest}`.slice(0, 100) });
  }
  return uses;
}

// ── run the workflow body with stub agents (no model calls) ──────────────────
function schemaDefault(s) {
  if (!s) return null;
  if (s.enum) return s.enum[0];
  switch (s.type) {
    case 'object': return Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, schemaDefault(v)]));
    case 'array': return [];
    case 'string': return '';
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    default: return null;
  }
}
function checkSchema(s, where) {
  assert.equal(s.type, 'object', `${where}: schema root must be an object`);
  const walk = (x, p) => {
    if (x.type === 'object') { for (const r of x.required || []) assert.ok(x.properties && r in x.properties, `${where}: required "${r}" not in properties at ${p}`); for (const [k, v] of Object.entries(x.properties || {})) walk(v, `${p}.${k}`); }
    if (x.type === 'array') { assert.ok(x.items, `${where}: array without items at ${p}`); walk(x.items, `${p}[]`); }
  };
  walk(s, '$');
}
async function simulate(argsIn, overrides = {}) {
  const calls = [], phases = [], logs = [];
  const agent = async (prompt, opts = {}) => {
    assert.equal(typeof prompt, 'string');
    if (opts.schema) checkSchema(opts.schema, opts.label);
    calls.push({ prompt, ...opts });
    const key = Object.keys(overrides).find((k) => opts.label === k || opts.label.startsWith(`${k}-`) || opts.label.startsWith(k));
    const base = schemaDefault(opts.schema);
    return key ? (typeof overrides[key] === 'function' ? overrides[key](base, prompt, opts) : { ...base, ...overrides[key] }) : base;
  };
  const parallel = async (thunks) => Promise.all(thunks.map(async (t) => { try { return await t(); } catch { return null; } }));
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let prev = item;
    try { for (const st of stages) prev = await st(prev, item, i); return prev; } catch { return null; }
  }));
  const body = WF.replace(/^export const meta =/m, 'const meta =');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', `${body}\nreturn meta`);
  const meta = await fn(agent, parallel, pipeline, (t) => phases.push(t), (m) => logs.push(m), argsIn);
  return { calls, phases, logs, meta };
}
const ARGS = { kit: '/kit', project: '/Users/x/Desktop/Demo Project', staging: '/Users/x/dev/.clockwork-onboard/demo-project-20260930-1200', date: '2026-09-30', case: 'B', discoverJson: '/s/discover.json', censusBefore: '/s/census-before.json' };
const HAPPY = {
  inventory: { sources: [
    { path: 'CLAUDE.md', bytes: 9000, lens: 'instructions', reader: 'text', textPath: 'CLAUDE.md', units: [{ label: '1', from: 1, to: 200 }], registeredInV1DocMap: false, sweep: false, why: '' },
    { path: 'PM/notes 1.md', bytes: 3000, lens: 'comms', reader: 'text', textPath: 'PM/notes 1.md', units: [{ label: '1', from: 1, to: 400 }, { label: '2', from: 401, to: 520 }], registeredInV1DocMap: false, sweep: true, why: '' },
    { path: 'docs/brief.docx', bytes: 30000, lens: 'comms', reader: 'converted', textPath: '.clockwork-onboard/converted/docs/brief.docx.txt', units: [{ label: '1', from: 1, to: 90 }], registeredInV1DocMap: false, sweep: true, why: '' },
  ], notRead: [{ path: 'visuals/a.png', why: 'image' }], notChecked: [] },
  map: { registryDir: '.claude', siteDir: '.', stack: 'nextjs', projectName: 'Demo', install: { adopt: false, allowSynced: false },
    condense: [{ id: 'instr', kind: 'instructions', sources: ['CLAUDE.md'], targets: ['AGENTS.md', 'CLAUDE.md'], brief: 'split' }, { id: 'design', kind: 'design', sources: ['DESIGN.md'], targets: ['.claude/rules/design-system.md'], brief: 'condense' }],
    seeds: [{ file: 'TASKS.md', section: '## Open', prefix: 'T', title: 'Branch x: keep, merge or drop', cells: 'a|b|src', status: '⏸ PARKED', source: 'branch x @abc123' }],
    sweepSources: ['PM/notes 1.md', 'docs/brief.docx'], questions: [], notes: [] },
  'install+migrate': { installExit: 0, installLast: 'OK applied 40 change(s)', migrateExit: 0, migrateLast: 'OK migrate 0 change(s)', stopped: false },
  extract: { items: [{ n: 1, type: 'task', summary: 'Do x', quote: 'we will do x', where: 'line 3', owner: '', due: '', dated: '', confidence: 'high' }, { n: 2, type: 'fact', summary: 'Y', quote: 'made up', where: 'line 9', owner: '', due: '', dated: '', confidence: 'low' }] },
  quotes: { checks: [{ n: 1, found: true, exact: 'we will do x' }, { n: 2, found: false, exact: '' }] },
  merge: { items: [{ key: 'k1', type: 'task', summary: 'Do x', quote: 'we will do x', sources: [{ path: 'PM/notes 1.md', where: 'line 3' }], file: 'TASKS.md', section: '## Open', prefix: 'T', title: 'Do x', cells: 'done|tbd|PM/notes 1.md line 3', status: '⬜ OPEN', supersededBy: '' }] },
  dispatch: { minted: [{ key: 'k1', id: 'T-1', file: 'TASKS.md' }] },
  check: { lost: 0, doctorExit: 0, registryCheckExit: 0 },
  verifier: { verdict: 'nothing_found' },
  sample: { found: 1, missing: [] },
  report: { planPath: '/s/ONBOARDING-PLAN.md', planBytes: 9000, questions: 2, approved: false },
};

// ── tests ────────────────────────────────────────────────────────────────────
test('SKILL.md: frontmatter per the skills docs, manual only, within budget', () => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(SKILL);
  assert.ok(fm, 'SKILL.md starts with a frontmatter block');
  assert.match(fm[1], /^name: clockwork-onboard$/m);
  assert.match(fm[1], /^disable-model-invocation: true$/m);
  assert.match(fm[1], /^description: \S.{20,}$/m);
  // Keys documented in https://code.claude.com/docs/en/skills.md "Frontmatter reference" (read 2026-09-30).
  const allowed = new Set(['name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable', 'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility']);
  for (const k of fm[1].split('\n').map((l) => /^([a-z_-]+):/.exec(l)?.[1]).filter(Boolean)) assert.ok(allowed.has(k), `unknown frontmatter key ${k}`);
  assert.ok(Buffer.byteLength(SKILL) <= 10240, `SKILL.md is ${Buffer.byteLength(SKILL)} bytes (budget 10 KB)`);
  assert.ok(Buffer.byteLength(MAPPING) <= 6144, `mapping.md is ${Buffer.byteLength(MAPPING)} bytes (budget 6 KB)`);
  assert.ok(Buffer.byteLength(PLAN_TPL) <= 3072, `plan-template.md is ${Buffer.byteLength(PLAN_TPL)} bytes (budget 3 KB)`);
});

test('SKILL.md: the stop-before-apply point is unmissable and apply comes last', () => {
  const stop = SKILL.indexOf('STOP RULE');
  assert.ok(stop > 0 && stop < 1200, 'STOP RULE sits right under the title');
  assert.match(SKILL, /apply it/);
  assert.match(SKILL, /end your turn/i);
  const firstApplyCmd = SKILL.search(/onboard\.mjs" apply /);
  const showStep = SKILL.search(/^## \d+\. Show the user, then STOP/m);
  assert.ok(showStep > 0 && firstApplyCmd > showStep, 'the only apply command comes after the show-the-user-and-stop step');
  assert.equal([...SKILL.matchAll(/onboard\.mjs" apply /g)].length, 1, 'exactly one apply command');
  assert.doesNotMatch(SKILL, /approved:\s*true[^\n]*yourself(?![^\n]*[Nn]ever)/, 'never tells Claude to approve');
  assert.match(SKILL, /--allow-live/); // only with the user's explicit words
  assert.match(SKILL, /CLOCKWORK_KIT/, 'kit path has the env override');
});

test('SKILL.md and the workflow use only onboard.mjs subcommands and flags that exist', () => {
  const { subs, cases } = onboardCli();
  assert.deepEqual(new Set(Object.keys(subs)), cases, 'usage header and main() agree on subcommands');
  for (const [name, text] of [['SKILL.md', SKILL], ['onboard.js', WF.replaceAll('${OB}', 'node "/kit/onboard/onboard.mjs"')]]) {
    const uses = onboardUses(text);
    assert.ok(uses.length >= 5, `${name} names onboard.mjs commands`);
    for (const u of uses) {
      assert.ok(subs[u.sub], `${name}: "onboard.mjs ${u.sub}" is not a subcommand (${u.at})`);
      for (const f of u.flags) assert.ok(subs[u.sub].has(f), `${name}: onboard.mjs ${u.sub} has no --${f} (${u.at})`);
    }
  }
  for (const s of ['discover', 'stage', 'census', 'compare', 'apply']) assert.ok(onboardUses(SKILL).some((u) => u.sub === s), `SKILL.md runs ${s}`);
  for (const s of ['migrate', 'census', 'compare']) assert.ok(onboardUses(WF.replaceAll('${OB}', 'onboard.mjs')).some((u) => u.sub === s), `workflow runs ${s}`);
});

test('SKILL.md and the workflow use only install.mjs, registry.mjs and doctor flags that exist', () => {
  const inst = installFlags(), regCmds = registryCommands(), regFlags = registryFlags(), doc = doctorFlags();
  const wf = WF.replaceAll('${REGTOOL}', 'registry.mjs').replaceAll('${KIT}', '/kit').replaceAll('${S}', '/s');
  for (const [name, text] of [['SKILL.md', SKILL], ['onboard.js', wf]]) {
    for (const m of text.matchAll(/install\.mjs"?\s+"[^"]*"([^\n]*)/g)) for (const f of m[1].split(/\s>{1,2}\s|;|`/)[0].matchAll(/--([a-z][a-z-]*)/g)) assert.ok(inst.has(f[1]), `${name}: install.mjs has no --${f[1]}`);
    for (const m of text.matchAll(/registry\.mjs"?\s+([a-z]+)([^\n]*)/g)) {
      m[2] = m[2].split(/\s>{1,2}\s|;|`/)[0];
      if (['the', 'with', 'and', 'or'].includes(m[1])) continue; // prose, not a command
      assert.ok(regCmds.has(m[1]), `${name}: registry.mjs has no subcommand ${m[1]}`);
      for (const f of m[2].matchAll(/--([a-z][a-z-]*)/g)) assert.ok(regFlags.has(f[1]), `${name}: registry.mjs has no --${f[1]}`);
    }
    for (const m of text.matchAll(/clockwork-doctor\.mjs"([^\n]*)/g)) for (const f of m[1].split(/\s>{1,2}\s|;|`/)[0].matchAll(/--([a-z][a-z-]*)/g)) assert.ok(doc.has(f[1]), `${name}: doctor has no --${f[1]}`);
  }
  // Every other --flag the skill mentions belongs to a known tool, the claude CLI (--add-dir) or the skill itself (--only).
  const known = new Set([...Object.values(onboardCli().subs).flatMap((s) => [...s]), ...inst, ...regFlags, ...doc, 'add-dir', 'only']);
  for (const m of SKILL.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)) assert.ok(known.has(m[1]), `SKILL.md mentions unknown flag --${m[1]}`);
});

test('workflow: parses as an ES module (node --check on a .mjs copy) and follows the script rules', () => {
  const copy = path.join(TMP, 'onboard workflow.mjs');
  fs.writeFileSync(copy, WF);
  const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
  assert.equal(r.status, 0, `node --check failed:\n${r.stderr}`);
  const code = WF.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(WF, /^export const meta = \{/, 'meta is the first statement');
  const metaSrc = WF.slice(0, WF.indexOf('\n}\n') + 2);
  assert.doesNotMatch(metaSrc, /\$\{|\.\.\.|\w\(/, 'meta is a pure literal (no interpolation, spread or call)');
  for (const bad of [/Date\.now\s*\(/, /new Date\s*\(\s*\)/, /Math\.random\s*\(/, /\bimport\s*\(/, /\brequire\s*\(/, /\bprocess\./, /from 'node:/]) assert.doesNotMatch(code, bad, `script uses ${bad}`);
  const metaPhases = [...metaSrc.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
  const calledPhases = [...new Set([...code.matchAll(/\bphase\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.deepEqual(new Set(calledPhases), new Set(metaPhases), 'meta.phases titles match phase() calls exactly');
  for (const m of code.matchAll(/phase: '([^']+)'/g)) assert.ok(metaPhases.includes(m[1]), `agent phase "${m[1]}" is in meta.phases`);
});

test('workflow: a full stubbed run uses the right models, guards every prompt and never applies', async () => {
  const { calls, phases, logs, meta } = await simulate(ARGS, HAPPY);
  assert.equal(meta.name, 'clockwork-onboard');
  assert.deepEqual([...new Set(phases)], ['Discover', 'Map', 'Install', 'Condense', 'Seed', 'Sweep', 'Check', 'Verify', 'Report']);
  const by = (re) => calls.filter((c) => re.test(c.label));
  for (const c of by(/^(inventory|discover-|extract-|quotes-|install\+migrate|seed-rows|dispatch-|check$|sweep-checker|sample-)/)) assert.equal(c.model, 'sonnet', `${c.label} runs on sonnet`);
  for (const c of by(/^(map|condense-|merge-|verifier|report)$|^(condense|merge)-/)) assert.equal(c.model, 'opus', `${c.label} runs on opus`);
  assert.ok(by(/^discover-/).length >= 2, 'one discovery agent per source type, in parallel');
  assert.equal(by(/^verifier$/).length, 1);
  assert.match(by(/^verifier$/)[0].prompt, /PROVE that onboarding lost something, invented something, or decided something silently/);
  assert.match(by(/^verifier$/)[0].prompt, /FRESH verifier/);
  for (const c of calls) {
    assert.match(c.prompt, /SAFETY \(binding\)/, `${c.label} carries the safety guard`);
    assert.match(c.prompt, /is READ-ONLY/, `${c.label} says the real project is read-only`);
    assert.doesNotMatch(c.prompt, /onboard\.mjs"?\s+apply\s+"/, `${c.label} never runs apply`);
    assert.doesNotMatch(c.prompt, /(?<!never )--force-managed|--allow-live|--yes\b/, `${c.label} never passes an override flag`);
  }
  const inst = by(/^install\+migrate$/)[0].prompt;
  assert.match(inst, /install\.mjs" "\/Users\/x\/dev\/\.clockwork-onboard\/demo-project-20260930-1200" --project "Demo" --stack nextjs\s+\(dry run\)/);
  assert.match(inst, /--apply/);
  assert.match(inst, /migrate "\/Users\/x\/dev[^"]*" --dry-run --reports-dir "\.claude\/reports\/onboarding-2026-09-30"/);
  // a quote the checker could not find is reported, not silently dropped
  const report = by(/^report$/)[0].prompt;
  const data = JSON.parse(report.slice(report.indexOf('DATA: ') + 6));
  assert.equal(data.status, 'staged-for-review');
  assert.ok(data.sweep.dropped.some((d) => /quote not found/.test(d)), 'failed quotes are listed as dropped');
  assert.equal(data.sweep.units, 3);
  assert.match(report, /approved: false/);
  assert.ok(logs.some((l) => /^STOP\. Nothing was applied/.test(l)), 'last log line tells the session to stop');
});

test('workflow: a refused install stops before content steps but still writes the plan and says why', async () => {
  const { calls, logs } = await simulate({ ...ARGS, case: 'A' }, { ...HAPPY, 'install+migrate': { installExit: 1, installLast: 'ERR refused: v1 project needs --adopt', stopped: true, why: 'ERR refused: v1 project needs --adopt' } });
  assert.equal(calls.filter((c) => /^(condense|extract|merge|dispatch|verifier)/.test(c.label)).length, 0, 'no content step after a refused install');
  const report = calls.find((c) => c.label === 'report');
  assert.ok(report, 'the report step still runs');
  const data = JSON.parse(report.prompt.slice(report.prompt.indexOf('DATA: ') + 6));
  assert.equal(data.status, 'stopped');
  assert.equal(data.stoppedAt, 'Install');
  assert.ok(logs.some((l) => /status: stopped at Install/.test(l)));
});

test('workflow: an install that leaves conflicts continues; over-limit sweeps are named, not dropped', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ path: `PM/n${i}.md`, bytes: 10, lens: 'comms', reader: 'text', textPath: `PM/n${i}.md`, units: [{ label: '1', from: 1, to: 10 }], registeredInV1DocMap: false, sweep: true, why: '' }));
  const { calls } = await simulate({ ...ARGS, maxUnits: 3 }, {
    ...HAPPY,
    inventory: { sources: many, notRead: [], notChecked: [] },
    map: { ...HAPPY.map, sweepSources: many.map((s) => s.path) },
    'install+migrate': { installExit: 1, installLast: 'ERR applied 12 change(s), but 1 conflict(s) left untouched — see table', migrateExit: 0, stopped: false, conflicts: ['conflict  .claude/agents/verifier.md  exists but was not installed by the kit'] },
  });
  assert.ok(calls.some((c) => /^condense-/.test(c.label)), 'a partial install with conflicts continues');
  assert.equal(calls.filter((c) => /^extract-/.test(c.label)).length, 3, 'sweeps at most maxUnits units');
  const report = calls.find((c) => c.label === 'report');
  const data = JSON.parse(report.prompt.slice(report.prompt.indexOf('DATA: ') + 6));
  assert.deepEqual(data.sweep.notSwept, ['PM/n3.md', 'PM/n4.md']);
});

test('workflow: refuses args that would point staging at the real project', async () => {
  await assert.rejects(simulate({ ...ARGS, staging: `${ARGS.project}/staging` }, HAPPY), /must not overlap/);
  await assert.rejects(simulate({ ...ARGS, date: 'today' }, HAPPY), /YYYY-MM-DD/);
  const { date, ...noDate } = ARGS; void date;
  await assert.rejects(simulate(noDate, HAPPY), /args\.date/);
});

test('plan template: approved: false, the "Archived verbatim" section compare reads, and no stray items', async () => {
  assert.match(PLAN_TPL, /^---\napproved: false\n/);
  for (const h of ['Sources read', 'Mapping', 'Archived verbatim', 'Kept in place', 'Conflicts', 'Questions for the user', 'Flagged, not moved', 'Checks on staging', 'How to apply']) assert.match(PLAN_TPL, new RegExp(`^## ${h}$`, 'm'));
  // Real compare(): a file dropped from staging counts as LOST unless the plan's Archived verbatim section names it,
  // and the template's own comments add nothing.
  const { census, compare } = await import(path.join(OB_DIR, 'onboard.mjs'));
  const dir = path.join(TMP, 'plan fixture');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'old guide.md'), '# Old guide\nRule one stays.\nRule two stays.\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\nHello.\n');
  const before = census(dir);
  fs.rmSync(path.join(dir, 'docs', 'old guide.md'));
  const afterC = census(dir);
  assert.ok(compare(before, afterC, PLAN_TPL).lost.length > 0, 'the bare template accounts for nothing');
  const filled = PLAN_TPL.replace(/(## Archived verbatim\n(?:<!--[\s\S]*?-->\n)?)/, '$1- `docs/old guide.md` → .claude/reports/onboarding-2026-09-30/originals/docs/old guide.md\n');
  const r = compare(before, afterC, filled);
  assert.equal(r.lost.length, 0, `named in Archived verbatim → accounted for: ${JSON.stringify(r.lost)}`);
  assert.ok(r.planned.length > 0);
});

test('mapping.md: a table per case and every source type the contract names', () => {
  for (const c of ['A', 'B', 'C']) assert.match(MAPPING, new RegExp(`^## Case ${c}:[^\\n]*\\n\\| Source \\| Destination \\| How \\|`, 'm'), `case ${c} has a source → destination → how table`);
  for (const how of ['moved', 'condensed', 'archived verbatim', 'kept in place', 'question for the user']) assert.match(MAPPING, new RegExp(how, 'i'));
  const need = ['CLAUDE.md', 'AGENTS.md already', 'README', 'docs/', '.cursor/rules', 'copilot-instructions', 'GitHub Issues', 'ROUTING', 'DOC-MAP', 'TOOLING', 'ENGINEERING', 'code-hygiene', 'DESIGN-SYSTEM', 'tokens', 'tailwind', 'theme.json', 'Figma', 'Meeting notes', 'transcripts', 'TODO/FIXME', 'Git history', 'loop.md', 'loop-progress', 'handovers', 'hooks', 'commands', 'conflict copies'];
  for (const n of need) assert.ok(MAPPING.includes(n), `mapping.md covers "${n}"`);
  assert.match(MAPPING, /NOT copied to TASKS\.md/, 'GitHub Issues are linked, not duplicated');
  assert.match(MAPPING, /never overwritten|never `--force-managed`/, 'existing hooks/commands are kept');
});

// ── fixes from the nothing-lost and trial reviews (2026-09-30) ───────────────
test('workflow: repair restores into LIVE files from the before-copy; the verifier reads the before-copy, not the moving project', async () => {
  const { calls } = await simulate(ARGS, { ...HAPPY, check: { lost: 2, doctorExit: 0, registryCheckExit: 0 } });
  const repair = calls.find((c) => c.label === 'repair-lost');
  assert.ok(repair, 'a LOST result triggers one repair round');
  assert.match(repair.prompt, /\.clockwork-onboard\/pristine\/<same path>/);
  assert.match(repair.prompt, /never in the real project/);
  assert.match(repair.prompt, /back into its LIVE file/);
  assert.match(repair.prompt, /ONLY if the plan's "Archived verbatim" already names that exact line range/);
  assert.doesNotMatch(repair.prompt, /a lost line goes back verbatim into "[^"]*originals/);
  assert.equal(calls.filter((c) => /^re-check$|^check$/.test(c.label)).length, 2, 're-checked after the repair');
  const v = calls.find((c) => c.label === 'verifier').prompt;
  assert.match(v, /Before = the read-only before-copy "[^"]*\.clockwork-onboard\/pristine\/"/);
  assert.match(v, /sources-pairs\.md/);
  assert.match(v, /a question whose "Default" is not what staging actually did \(open the staged file/);
  assert.match(calls.find((c) => c.label === 'check').prompt, /onboard\.mjs" sources "/);
});

test('workflow: old-document decisions are questions, not ✅ VERIFIED rows; every swept document gets a DOC-MAP line', async () => {
  const { calls } = await simulate(ARGS, HAPPY);
  const merge = calls.find((c) => c.label === 'merge-1').prompt;
  assert.match(merge, /decision → OPEN-ASKS \(prefix A, section "## Open", title "Still decided\?/);
  assert.match(merge, /ONLY when the quoted text itself names who ratified it AND when/);
  assert.doesNotMatch(merge, /design_rule → a CD row and a TASKS row/);
  const disp = calls.find((c) => c.label === 'dispatch-1').prompt;
  const rows = JSON.parse(disp.slice(disp.indexOf('Rows: ') + 6));
  // DOC-MAP (8 KB budget) gets one line per folder, pointing at the per-document list in the reports folder.
  for (const f of ['PM', 'docs']) assert.ok(rows.some((row) => row['key'] === `docmap-${f}` && row.file === 'DOC-MAP.md' && row.title.includes(`\`${f}/\``) && /reports\/onboarding-2026-09-30\/documents\.md/.test(row.title)), `DOC-MAP line for ${f}/`);
  assert.equal(rows.filter((row) => row.file === 'DOC-MAP.md').length, 2, 'one DOC-MAP line per folder, not per document');
  for (const p of ['PM/notes 1.md', 'docs/brief.docx']) assert.ok(disp.includes(`${p} · `) && new RegExp(`${p.replace('.', '\\.')} · [^"]*extracted (yes|partly|no) · authoritative`).test(disp), `per-document line for ${p}`);
  assert.match(disp, /documents\.md" \(a plain report file, not a registry/);
  assert.match(disp, /migrate-latest\.json/);
  assert.match(disp, /shape --cells to ITS columns/);
  assert.match(disp, /key · path:line · destination file · ID or "line" · "verbatim quote"/);
  assert.match(calls.find((c) => c.label === 'sweep-checker').prompt, /docMapMissing/);
});

test('workflow: case C with seeded rows and nothing to sweep still runs the sweep checker', async () => {
  const { calls } = await simulate({ ...ARGS, case: 'C' }, { ...HAPPY, inventory: { sources: [], notRead: [], notChecked: [] }, map: { ...HAPPY.map, sweepSources: [], condense: [] } });
  assert.equal(calls.filter((c) => /^extract-/.test(c.label)).length, 0);
  assert.ok(calls.some((c) => c.label === 'sweep-checker'), 'seeded rows are checked like swept ones');
  assert.match(calls.find((c) => c.label === 'verifier').prompt, /at least 30 rows of sweep-manifest\.md, or all of them if there are fewer/);
});

test('workflow: condense scopes overflow rules, keeps design rules in design-system.md, routes facts, and names what it left out', async () => {
  const left = { leftOut: [{ source: 'CLAUDE.md', lines: '45-252', why: 'contacts → FACTS' }] };
  const { calls } = await simulate({ ...ARGS, case: 'A' }, { ...HAPPY, condense: left });
  const c = calls.find((x) => x.label === 'condense-instr').prompt;
  assert.match(c, /MUST start with "paths:" frontmatter/);
  assert.match(c, /Design rules go ONLY into design-system\.md \(decision D8\)/);
  assert.match(c, /stay under each WARN level/);
  assert.match(c, /old DESIGN-SYSTEM\.md stays the BINDING source/);
  assert.match(c, /Facts inside an instruction file/);
  const pa = calls.find((x) => x.label === 'plan-archived');
  assert.ok(pa, 'a serial step names the left-out ranges in the plan');
  assert.match(pa.prompt, /"source":"CLAUDE\.md","lines":"45-252"/);
  const inv = calls.find((x) => x.label === 'inventory').prompt;
  assert.match(inv, /OR a folder that contains it/);
  assert.match(inv, /Never sweep task reports next to the registries/);
});

// ── round 4 (2026-09-30): sweep mode for Clockwork 2 projects (D16), design fill step (D14), no unchecked quotes ──
test('workflow: sweep mode (Clockwork 2 already installed) skips install.mjs and condense, still sweeps and checks', async () => {
  const { calls, phases } = await simulate({ ...ARGS, case: 'A', mode: 'sweep' }, HAPPY);
  assert.match(calls.find((c) => c.label === 'map').prompt, /SWEEP MODE: Clockwork 2 is already installed here\. Plan NO install and NO condense jobs/);
  const inst = calls.find((c) => c.label === 'install+migrate').prompt;
  assert.doesNotMatch(inst, /install\.mjs" "/, 'install.mjs is not run in sweep mode');
  assert.match(inst, /registry\.mjs", "[^"]*clockwork\.json"/);
  assert.match(inst, /migrate "[^"]*" --reports-dir/);
  assert.equal(calls.filter((c) => /^condense-/.test(c.label)).length, 0, 'the plan\'s condense jobs are not run');
  assert.ok(calls.some((c) => /^extract-/.test(c.label)) && calls.some((c) => c.label === 'verifier'));
  assert.ok(phases.includes('Report'));
  await assert.rejects(simulate({ ...ARGS, mode: 'upgrade' }, HAPPY), /args\.mode/);
});

test('workflow: the design table is filled from this project only; unfilled rows become one question', async () => {
  const { calls } = await simulate(ARGS, { ...HAPPY, condense: { unfilled: ['SP-2: no section size in tokens.css'] } });
  assert.match(calls.find((c) => c.label === 'map').prompt, /Fill the design table \(decision D14\)[^\n]*even with no design document/);
  const d = calls.find((c) => c.label === 'condense-design').prompt;
  assert.match(d, /filled ONLY from THIS project's sources[^\n]*never from the kit's defaults, a skill or another project/);
  assert.match(d, /A kit row that contradicts this project's own source[^\n]*is a question/);
  const report = calls.find((c) => c.label === 'report').prompt;
  assert.match(report, /ONE question for all unfilled design rows/);
  assert.ok(JSON.parse(report.slice(report.indexOf('DATA: ') + 6)).condense.some((c) => c.unfilled.includes('SP-2: no section size in tokens.css')));
  assert.match(calls.find((c) => c.label === 'install+migrate').prompt, /fill only an EMPTY build, lint or test from a package\.json/);
  assert.match(calls.find((c) => c.label === 'seed-rows').prompt, /is "not set", never an invented value/);
});

test('workflow: an item whose quote was never checked is dropped and listed, never written', async () => {
  const { calls } = await simulate(ARGS, { ...HAPPY, quotes: () => null });
  const report = calls.find((c) => c.label === 'report').prompt;
  const data = JSON.parse(report.slice(report.indexOf('DATA: ') + 6));
  assert.ok(data.sweep.dropped.some((x) => /quote NOT CHECKED/.test(x)), data.sweep.dropped.join('\n'));
  const merge = calls.find((c) => c.label === 'merge-1');
  assert.ok(!merge, 'nothing unchecked reaches the merge step');
  assert.match(calls.find((c) => c.label === 'sweep-checker').prompt, /every path under the plan's "## Kept in place"/);
});

// The kit's _archive/ holds build history only: onboarding must work without it (it may be pruned or not installed).
test('onboard/ depends on nothing under _archive/; the non-negotiables live in mapping.md', () => {
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (read(p).includes('_archive')) hits.push(path.relative(KIT, p)); } };
  walk(OB_DIR);
  assert.deepEqual(hits, []);
  assert.match(MAPPING, /^## Non-negotiables\n1\. \*\*Nothing is deleted or lost\.\*\*/m);
  for (const k of ['Staging first', 'Nothing invented', 'The user decides', 'offloaded by iCloud']) assert.ok(MAPPING.includes(k), k);
  assert.ok(WF.includes('the mapping rules ${KIT}/onboard/mapping.md (its Non-negotiables section is binding)'));
});

// ── 2026-10-01: automatic design rule coverage (the user does not review side by side) ──────────────────────────
test('workflow: a design condense is followed by the mechanical coverage check and a fresh semantic check; one fix round; only true conflicts become questions', async () => {
  const { calls, logs } = await simulate(ARGS, { ...HAPPY,
    'coverage-check': { exit: 1, required: true, unmapped: 3, problems: ['x.md:4: row CO-9 is not in design-system.md'], last: 'ERR design coverage: 3 unmapped line(s)' },
    'coverage-semantic': (base, prompt, opts) => ({ ...base, checked: 12, mismatches: opts.label === 'coverage-semantic' ? [{ oldLine: 'DESIGN.md:7', destination: 'SP-2', problem: '"never" became "avoid"', fix: 'SP-2 says never' }] : [],
      conflicts: [{ question: 'DESIGN.md:9 says 8px, DESIGN.md:40 says 12px: which?', default: 'kept both verbatim', sources: ['DESIGN.md:9', 'DESIGN.md:40'] }] }),
    'coverage-recheck': { exit: 0, required: true, unmapped: 0, problems: [], last: 'OK design coverage: all 12 line(s) have a checked destination' },
  });
  const labels = calls.map((c) => c.label);
  const ci = labels.indexOf('condense-design');
  for (const l of ['coverage-check', 'coverage-semantic', 'coverage-fix', 'coverage-recheck', 'coverage-semantic-recheck']) assert.ok(labels.indexOf(l) > ci, `${l} runs after the design condense`);
  assert.ok(labels.indexOf('coverage-fix') < labels.indexOf('seed-rows'), 'fixed before any row is seeded');
  const cond = calls.find((c) => c.label === 'condense-design').prompt;
  assert.match(cond, /design-coverage\.md", a table "\| Old line \| Goes to \| Proof \|" with EVERY content line/);
  assert.match(cond, /kept verbatim in DESIGN-SYSTEM-ARCHIVE\.md, still binding/);
  assert.match(cond, /old DESIGN-SYSTEM\.md stays the BINDING source/);
  const mech = calls.find((c) => c.label === 'coverage-check');
  assert.match(mech.prompt, /onboard\.mjs" coverage "\/Users\/x\/dev\/\.clockwork-onboard\/demo-project-20260930-1200" --json/);
  assert.match(mech.prompt, /You write NOTHING in this step/);
  const sem = calls.find((c) => c.label === 'coverage-semantic');
  assert.equal(sem.model, 'opus'); assert.match(sem.prompt, /FRESH design-coverage checker: you did not condense/);
  assert.match(sem.prompt, /"must" is not "should", "never" is not "avoid"/);
  const fix = calls.find((c) => c.label === 'coverage-fix');
  assert.match(fix.prompt, /"never\\" became \\"avoid\\"|never\\" became/); assert.match(fix.prompt, /row CO-9 is not in/);
  assert.match(fix.prompt, /When unsure, keep it verbatim/);
  assert.match(calls.find((c) => c.label === 'report').prompt, /every design coverage conflict \(designCoverage\.conflicts/);
  const data = calls.find((c) => c.label === 'report').prompt;
  assert.match(data, /"designCoverage":\{[^]*"ok":true/);
  assert.match(data, /DESIGN\.md:9 says 8px/);
  assert.ok(logs.some((l) => /design coverage: every old line has a checked destination · 1 true conflict\(s\) for the user/.test(l)));
});

test('workflow: no design job (or sweep mode) runs no coverage step; a clean first check runs no fix round', async () => {
  const noDesign = { ...HAPPY, map: { ...HAPPY.map, condense: HAPPY.map.condense.filter((j) => j.kind !== 'design') } };
  assert.ok(!(await simulate(ARGS, noDesign)).calls.some((c) => /^coverage-/.test(c.label)));
  assert.ok(!(await simulate({ ...ARGS, case: 'A', mode: 'sweep' }, HAPPY)).calls.some((c) => /^coverage-/.test(c.label)));
  const clean = await simulate(ARGS, { ...HAPPY, 'coverage-check': { exit: 0, required: true, unmapped: 0, problems: [], last: 'OK' } });
  assert.ok(clean.calls.some((c) => c.label === 'coverage-check') && !clean.calls.some((c) => c.label === 'coverage-fix'));
});
