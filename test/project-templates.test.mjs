// Tests for the B8 templates: AGENTS.md, CLAUDE.md, registries/*, claude/rules/{registries,stack-*}.md,
// claude/skills/{handover,pre-send}/SKILL.md. node --test, offline, fixtures in os.tmpdir(), cleaned up.
// Budgets: CONTRACT §2. Registry format: CONTRACT §5. Integration runs the real registry.mjs and doctor.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T = join(KIT, 'templates');
const TMP = mkdtempSync(join(tmpdir(), 'cw-b8-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const read = (rel) => readFileSync(join(T, rel), 'utf8');
const bytes = (rel) => Buffer.byteLength(read(rel));
const lines = (rel) => read(rel).replace(/\n$/, '').split('\n').length;
const REGISTRIES = ['TASKS', 'CLIENT', 'FACTS', 'MEETING-LOG', 'OPEN-ASKS', 'APPROVAL-QUEUE', 'DOC-MAP', 'ROUTING'].map((n) => `${n}.md`);

// ── budgets (CONTRACT §2) ────────────────────────────────────────────────────
test('byte and line budgets', () => {
  const limits = [
    ['AGENTS.md', 8192, 120], ['CLAUDE.md', 2048, 30],
    ['claude/rules/registries.md', 3072], ['claude/rules/stack-nextjs.md', 5120], ['claude/rules/stack-wordpress.md', 5120], ['claude/rules/engineering.md', 3072],
    ['claude/skills/handover/SKILL.md', 10240], ['claude/skills/pre-send/SKILL.md', 10240],
    ...['verifier', 'checker', 'builder', 'extractor'].map((a) => [`claude/agents/${a}.md`, 5120]),
    ...REGISTRIES.map((r) => [`registries/${r}`, 1536]),
  ];
  for (const [rel, maxB, maxL] of limits) {
    assert.ok(bytes(rel) <= maxB, `${rel} is ${bytes(rel)} bytes, budget ${maxB}`);
    if (maxL) assert.ok(lines(rel) <= maxL, `${rel} has ${lines(rel)} lines, budget ${maxL}`);
  }
  assert.ok(bytes('AGENTS.md') < 7000, `AGENTS.md ${bytes('AGENTS.md')} bytes is over the doctor's 7000 warn level`);
  assert.ok(bytes('CLAUDE.md') < 1800, 'CLAUDE.md is over the doctor warn level');
  assert.ok(bytes('AGENTS.md') + bytes('CLAUDE.md') <= 10240, 'always-loaded context over 10 KB');
});

// ── AGENTS.md / CLAUDE.md content contract ──────────────────────────────────
test('CLAUDE.md line 1 is exactly @AGENTS.md (D12)', () => {
  assert.equal(read('CLAUDE.md').split('\n')[0], '@AGENTS.md');
});

test('AGENTS.md Hard rules section is extractable the way session-start.mjs does it', () => {
  const text = read('AGENTS.md');
  const m = text.match(/^##\s+Hard rules\b.*$/im); // same regex as templates/claude/hooks/session-start.mjs hardRules()
  assert.ok(m, 'no "## Hard rules" heading');
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##\s/m);
  const section = text.slice(m.index, next < 0 ? text.length : m.index + m[0].length + next).trim();
  assert.ok(section.length <= 3500, `Hard rules section is ${section.length} chars; the hook truncates at 3500`);
  const rules = section.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.ok(rules.length >= 8, `only ${rules.length} numbered hard rules`);
  for (const must of ['registry.mjs', 'git add -A', '--no-verify', 'worktree', 'fresh verifier', 'Never invent client content', '&&'])
    assert.ok(section.includes(must), `Hard rules miss "${must}"`);
});

test('AGENTS.md has the lifecycle, the exact CLAIM template (§9) and the pointer table', () => {
  const text = read('AGENTS.md');
  const life = text.split('## Session lifecycle')[1].split('\n## ')[0];
  const steps = life.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.ok(steps.length >= 10 && steps.length <= 13, `lifecycle has ${steps.length} steps`);
  assert.ok(text.includes('`CLAIM <session> · branch <b> · worktree <path> · IDs <T-…> · files: <exact paths> · until <condition>`'));
  for (const s of ['⬜ OPEN', '🔎 VERIFYING', '🔧 BUILT', '✅ VERIFIED', '🚀 LIVE-UNVERIFIED', '⏸ PARKED', '✖ VOID']) assert.ok(text.includes(s), `status ${s} missing`);
  for (const s of ['## Hard rules', '## Definition of done', '## Client-facing work', '## Where things are', '## Parallel sessions']) assert.ok(text.includes(s), s);
  for (const s of ['handover', 'pre-send', 'intake', 'verify', 'overnight', 'verifier', 'registry.mjs', 'verify-change.js']) assert.ok(text.includes(s), `pointer ${s}`);
});

test('AGENTS.md placeholders all resolve from clockwork.json', () => {
  const cfg = JSON.parse(read('clockwork.json'));
  const ph = [...read('AGENTS.md').matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]);
  assert.ok(ph.length >= 5);
  for (const k of ph) assert.notEqual(k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), cfg), undefined, `{{${k}}} not in clockwork.json`);
});

test('AGENTS.md and CLAUDE.md are client-safe: no personal communication rules or home paths (D9)', () => {
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const t = read(f);
    for (const bad of [/~\/\.claude/, /\/Users\//, /communication\.md/i, /3 sentences/i, /great question/i, /Email TOV/i, /42k/i])
      assert.doesNotMatch(t, bad, `${f} contains ${bad}`);
  }
});

test('CLAUDE.md names skills, agents, workflows, the fan-out table and the model table by alias', () => {
  const t = read('CLAUDE.md');
  for (const s of ['/handover', '/pre-send', '/intake', '/verify', '/overnight', 'verifier', 'verify-change', '15x', 'measure, then pin', '`opus`', '`sonnet`', '`fable`', '2026-10-15', 'Hooks enforce'])
    assert.ok(t.includes(s), `CLAUDE.md misses "${s}"`);
  assert.doesNotMatch(t, /claude-(opus|sonnet|haiku|fable)-\d/, 'dated model IDs are not allowed (D5)');
});

// ── rules frontmatter (https://code.claude.com/docs/en/memory#path-specific-rules) ──
function frontPaths(rel) {
  const t = read(rel);
  assert.ok(t.startsWith('---\n'), `${rel} must start with frontmatter`);
  const end = t.indexOf('\n---\n', 4);
  assert.ok(end > 0, `${rel} frontmatter not closed`);
  const fm = t.slice(4, end).split('\n').filter((l) => !/^\s*#/.test(l));
  assert.equal(fm[0], 'paths:', `${rel}: first key must be paths`);
  const items = fm.slice(1).map((l) => /^ {2}- "([^"]+)"$/.exec(l)?.[1]);
  assert.ok(items.length && items.every(Boolean), `${rel}: paths must be a YAML list of quoted globs`);
  return items;
}
function expand(p) { const m = /\{([^{}]*)\}/.exec(p); return m ? m[1].split(',').flatMap((x) => expand(p.slice(0, m.index) + x + p.slice(m.index + m[0].length))) : [p]; }
function globRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith('**/', i)) { s += '(?:.*/)?'; i += 2; } else if (g.startsWith('**', i)) { s += '.*'; i += 1; } else if (g[i] === '*') s += '[^/]*';
    else s += g[i].replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}
const matches = (pats, file) => pats.flatMap(expand).some((p) => globRe(p).test(file));

test('rules/registries.md paths cover every registry file and archive, and nothing else', () => {
  const pats = frontPaths('claude/rules/registries.md');
  for (const r of REGISTRIES) {
    assert.ok(matches(pats, `.claude/${r}`), `.claude/${r} not matched`);
    assert.ok(matches(pats, `PM/${r}`), `PM/${r} not matched (registryDir may differ)`);
  }
  assert.ok(matches(pats, '.claude/TASKS-ARCHIVE.md'));
  for (const no of ['AGENTS.md', 'src/app/page.tsx', '.claude/rules/design-system.md']) assert.ok(!matches(pats, no), `${no} should not match`);
});

test('stack rules are path-scoped to their stack files', () => {
  const nx = frontPaths('claude/rules/stack-nextjs.md');
  for (const f of ['src/app/page.tsx', 'next.config.ts', 'app/globals.css', 'supabase/migrations/0001_init.sql', 'site/vercel.json']) assert.ok(matches(nx, f), `nextjs: ${f}`);
  assert.ok(!matches(nx, '.claude/TASKS.md'));
  const wp = frontPaths('claude/rules/stack-wordpress.md');
  for (const f of ['wp-content/themes/x/functions.php', 'wp-content/themes/x/style.css', 'theme/patterns/hero.php', 'theme/templates/page-winter.html', 'theme.json']) assert.ok(matches(wp, f), `wordpress: ${f}`);
  assert.ok(!matches(wp, '.claude/TASKS.md'));
  const en = frontPaths('claude/rules/engineering.md');
  for (const f of ['src/app/page.tsx', 'lib/x.ts', 'wp-content/themes/x/functions.php', 'scripts/build.py']) assert.ok(matches(en, f), `engineering: ${f}`);
  for (const f of ['.claude/TASKS.md', 'app/globals.css', 'AGENTS.md']) assert.ok(!matches(en, f), `engineering should not load for ${f}`);
});

// ── skills frontmatter (https://code.claude.com/docs/en/skills#frontmatter-reference) ──
const SKILL_KEYS = new Set(['name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable', 'allowed-tools', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility']);
test('skills have valid frontmatter: known keys, name = folder, description under 1,536 chars', () => {
  for (const name of ['handover', 'pre-send']) {
    const t = read(`claude/skills/${name}/SKILL.md`);
    assert.ok(t.startsWith('---\n'));
    const fm = t.slice(4, t.indexOf('\n---\n', 4)).split('\n');
    const kv = Object.fromEntries(fm.map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    for (const k of Object.keys(kv)) assert.ok(SKILL_KEYS.has(k), `${name}: unknown frontmatter key ${k}`);
    assert.equal(kv.name, name);
    assert.ok(kv.description && kv.description.length <= 1536);
  }
  assert.match(read('claude/skills/pre-send/SKILL.md'), /never sends/i);
});

// ── registry skeletons: header shape + no stray IDs (CONTRACT §5) ───────────
test('registry headers hold only title, purpose, Last updated and counters; no example IDs anywhere', () => {
  const counters = { 'TASKS.md': ['T'], 'CLIENT.md': ['C', 'CD'], 'OPEN-ASKS.md': ['A'], 'APPROVAL-QUEUE.md': ['Q'] };
  for (const r of REGISTRIES) {
    const t = read(`registries/${r}`);
    const head = t.slice(0, t.indexOf('\n## ')).split('\n').filter(Boolean);
    assert.match(head[0], /^# /, `${r} title`);
    assert.match(head[2], /^\*\*Last updated:\*\* \d{4}-\d{2}-\d{2}$/, `${r} Last updated line`);
    const ctr = head.slice(3);
    assert.deepEqual(ctr.map((l) => /^> \*\*ID counter — next free: `([A-Z]+)-1`\*\*$/.exec(l)?.[1]), counters[r] || [], `${r} counters`);
    assert.doesNotMatch(t.replace(/next free: `[A-Z]+-1`/g, ''), /\b[A-Z]{1,2}-\d+\b/, `${r} mentions a concrete ID; the doctor would count it`);
  }
});

// A relative `node .claude/tools/registry.mjs` fails from a worktree of a project that gitignores .claude/ (D13):
// every command the templates show uses the absolute tools path session-start exports as $CLOCKWORK_TOOLS.
test('templates never tell anyone to run registry.mjs by a relative path', () => {
  const hits = [];
  const walk = (rel) => { for (const e of readdirSync(join(T, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(r); else if (/node\s+"?\.?\/?\.claude\/tools\//.test(read(r))) hits.push(r); } };
  walk('');
  assert.deepEqual(hits, []);
  assert.match(read('registries/TASKS.md'), /`node "\$CLOCKWORK_TOOLS\/registry\.mjs"`/);
});
test('CLIENT.md line 2 matches the registry.mjs rule: every line, obligations included, goes through the tool', () => {
  const l2 = read('registries/CLIENT.md').split('\n')[1];
  assert.doesNotMatch(l2, /by hand/i);
  assert.match(l2, /line CLIENT\.md --section "## Standing Obligations"/);
  assert.match(read('registries/CLIENT.md'), /^## Standing Obligations$/m, 'the section the command names exists');
});

// ── integration: install the templates into a temp project, then run the real tools ──
function project() {
  const root = join(TMP, 'proj');
  mkdirSync(join(root, '.claude', 'tools'), { recursive: true });
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  for (const d of ['skills/handover', 'skills/pre-send', 'agents', 'workflows']) mkdirSync(join(root, '.claude', d), { recursive: true }); // other builders' folders, present after a real install
  const cfg = JSON.parse(read('clockwork.json'));
  cfg.commands = { build: 'pnpm build', lint: 'pnpm lint', test: 'pnpm test', previewDeploy: 'vercel', productionDeploy: 'vercel --prod' };
  writeFileSync(join(root, '.claude', 'clockwork.json'), JSON.stringify(cfg, null, 2));
  const fill = (s) => s.replace(/\{\{([\w.]+)\}\}/g, (_, k) => k.split('.').reduce((o, p) => o[p], cfg));
  writeFileSync(join(root, 'AGENTS.md'), fill(read('AGENTS.md')));
  writeFileSync(join(root, 'CLAUDE.md'), read('CLAUDE.md'));
  for (const r of REGISTRIES) copyFileSync(join(T, 'registries', r), join(root, '.claude', r));
  for (const r of readdirSync(join(T, 'claude', 'rules'))) copyFileSync(join(T, 'claude', 'rules', r), join(root, '.claude', 'rules', r));
  writeFileSync(join(root, '.claude', 'rules', 'design-system.md'), '# Design system\n'); // B9's file; only its presence matters here
  copyFileSync(join(T, 'claude', 'tools', 'registry.mjs'), join(root, '.claude', 'tools', 'registry.mjs'));
  copyFileSync(join(T, 'claude', 'hooks', 'clockwork-doctor.mjs'), join(root, '.claude', 'hooks', 'clockwork-doctor.mjs'));
  return realpathSync(root);
}
// CLOCKWORK_TOOLS: what session-start exports (the main copy's .claude/tools, absolute); the skeletons' commands use it.
const ENV = (root) => { const e = { ...process.env, CLAUDE_PROJECT_DIR: root, CLOCKWORK_TODAY: '2026-09-30', CLOCKWORK_TOOLS: join(root, '.claude', 'tools') }; delete e.CLOCKWORK_ROOT; return e; };
const sh = (root, cmd) => spawnSync('bash', ['-c', cmd], { cwd: root, env: ENV(root), encoding: 'utf8', timeout: 30000 });

test('integration: every skeleton\'s own Mint command works with registry.mjs, then check and the doctor are clean', () => {
  const root = project();
  let r = sh(root, 'node .claude/tools/registry.mjs check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const minted = [];
  for (const f of ['TASKS.md', 'CLIENT.md', 'OPEN-ASKS.md', 'APPROVAL-QUEUE.md']) {
    const cmds = [...read(`registries/${f}`).matchAll(/^Mint: `([^`]+)`$/gm)].map((m) => m[1]);
    assert.ok(cmds.length >= 1, `${f} has no Mint: line`);
    for (const c of cmds) {
      r = sh(root, c);
      assert.equal(r.status, 0, `${f}: ${c}\n${r.stdout}${r.stderr}`);
      const id = /OK ([A-Z]+-\d+)\s*$/.exec(r.stdout)?.[1];
      assert.ok(id, r.stdout);
      minted.push(id);
    }
  }
  assert.deepEqual(minted.sort(), ['A-1', 'C-1', 'CD-1', 'Q-1', 'T-1']);
  r = sh(root, 'node .claude/tools/registry.mjs status T-1 "🔧 BUILT 2026-09-30 build green"');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = sh(root, 'node .claude/tools/registry.mjs check');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // each minted row landed in its table with the right number of cells
  const tasks = readFileSync(join(root, '.claude', 'TASKS.md'), 'utf8');
  assert.match(tasks, /^\| T-1 \| … \| closes when … \| preview or ship \| source ID \| 🔧 BUILT/m);
  const client = readFileSync(join(root, '.claude', 'CLIENT.md'), 'utf8');
  assert.ok(client.indexOf('| CD-1 |') > client.indexOf('## Confirmed Decisions'), 'CD row must land in Confirmed Decisions');
  assert.ok(client.indexOf('| C-1 |') < client.indexOf('## Confirmed Decisions'), 'C row must land in Client asks');
  // CLIENT.md line 2: obligations go through `line`, not a hand edit; the command it names works on the skeleton
  r = sh(root, 'node "$CLOCKWORK_TOOLS/registry.mjs" line CLIENT.md --section "## Standing Obligations" --text "| Check-in | fortnightly | Sam | 2026-10-14 | kickoff |"');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(join(root, '.claude', 'CLIENT.md'), 'utf8'), /^\| Check-in \| fortnightly \| Sam \| 2026-10-14 \| kickoff \|$/m);

  r = sh(root, 'node .claude/hooks/clockwork-doctor.mjs --report --json');
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.errors.map((e) => e.key), [], JSON.stringify(j.errors, null, 1));
  const mine = ['HEADER', 'SECTION', 'DEADREF', 'SIZE', 'LINES', 'MUSTREAD', 'NOCOUNTER', 'ROW', 'EMPTY', 'MISSING', 'SELFOPEN', 'REOPENED', 'NOOWNER'];
  const bad = j.warns.filter((w) => mine.includes(w.code));
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('kit README stays within 4,096 bytes and keeps the hang-proof test command', () => {
  const readme = readFileSync(join(KIT, 'README.md'), 'utf8');
  assert.ok(Buffer.byteLength(readme) <= 4096, `README.md is ${Buffer.byteLength(readme)} bytes`);
  assert.ok(readme.includes('node --test --test-timeout=180000 test/'));
});
