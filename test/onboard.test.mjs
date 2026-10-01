// Tests for onboard/onboard.mjs (CONTRACT-ONBOARD §3). Offline; every fixture lives in os.tmpdir() (names with
// spaces on purpose) and is removed afterwards. `claude agents` is replaced by a stub via CLOCKWORK_CLAUDE_BIN.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(KIT, 'onboard', 'onboard.mjs');
const REGISTRY = path.join(KIT, 'templates', 'claude', 'tools', 'registry.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw onboard test ')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const STUB = path.join(TMP, 'claude stub.mjs');
fs.writeFileSync(STUB, `#!/usr/bin/env node
import fs from 'node:fs';
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.STUB_FAIL) { console.error('stub: boom'); process.exit(3); }
process.stdout.write(process.env.STUB_SESSIONS || '[]');
`);
fs.chmodSync(STUB, 0o755);

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  CLOCKWORK_CLAUDE_BIN: STUB, CLOCKWORK_SYNCED_ROOTS: '', CLAUDE_CODE_SESSION_ID: 'self-123', CLAUDE_PID: '999999', CLOCKWORK_ONBOARD_HOME: path.join(TMP, 'staging home') };
for (const k of ['CLOCKWORK_ROOT', 'CLAUDE_PROJECT_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'STUB_FAIL', 'STUB_SESSIONS', 'STUB_LOG']) delete ENV[k];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let n = 0;
const dir = (label) => { const d = path.join(TMP, `${label} ${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
function put(root, files) { for (const [rel, body] of Object.entries(files)) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); } return root; }
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: { ...ENV, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const lines = r.stdout.trim().split('\n');
  const last = lines[lines.length - 1];
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(lines.slice(0, -1).join('\n')); } catch { /* not json */ } }
  return { code: r.status, out: r.stdout, err: r.stderr, last, json };
}
function treeHash(root) { // every file + its bytes, to prove "wrote nothing"
  const out = []; const stack = [''];
  while (stack.length) { const rel = stack.pop(); for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) { const r = path.join(rel, e.name); if (e.isDirectory()) stack.push(r); else out.push(`${r}:${sha(fs.readFileSync(path.join(root, r)))}`); } }
  return sha(out.sort().join('\n'));
}

// ── fixtures ────────────────────────────────────────────────────────────────
const V1_TASKS = `# TASKS — what we build next
> **Next free T-##: T-462.** *(**T-461 minted 2026-09-29** — remove a login.)*
> **Never reuse an ID.** Void — never assigned: T-58, T-59.

## 🚦 Board
| ID | Task | Status |
|---|---|---|
| **T-460** | build the thing | ✅ VERIFIED |
| T-461 | remove a login | ⬜ OPEN |
| T-75 | DE/AT domain propagation | ⬜ OPEN |
| T-75 | Site copy sweep — a different task that reused the ID | 🔧 BUILT |
| ~~T-12~~ | ~~old closed task~~ | ✅ done |
| T-13 | → archived 2026-09-01 (TASKS-ARCHIVE.md) | ✅ VERIFIED |
`;
function caseA() {
  const root = dir('Client A');
  put(root, {
    '.claude/hooks/clockwork-doctor.mjs': '// v1 doctor\n',
    '.claude/TASKS.md': V1_TASKS,
    '.claude/TASKS 2.md': V1_TASKS.replace('T-462', 'T-450'),
    '.claude/ROUTING.md': '# ROUTING\nwhere things go\n',
    '.claude/DOC-MAP.md': '# DOC-MAP\nwhere things live\n',
    'CLAUDE.md': '# Project\n- Never deploy on Fridays.\n- Always run the build before a commit.\n',
    'pyproject.toml': '[project]\nname = "x"\n',
    '.gitignore': '.claude/\n',
  });
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.gitignore', 'pyproject.toml'); git(root, 'commit', '-qm', 'init');
  return root;
}

test('discover classifies case A, B and C and writes nothing', () => {
  const a = caseA();
  const before = treeHash(a);
  const log = path.join(TMP, 'stub-discover.log');
  const ra = run(['discover', a, '--json'], { STUB_LOG: log, STUB_SESSIONS: JSON.stringify([{ pid: 1, sessionId: 'self-123', cwd: a, kind: 'interactive', name: 'me' }, { pid: 2, sessionId: 'peer-1', cwd: a, kind: 'interactive', name: 'client-a-build' }]) });
  assert.equal(ra.code, 0, ra.out + ra.err);
  assert.match(ra.last, /^OK discover case A/);
  assert.equal(ra.json.case, 'A');
  assert.ok(ra.json.caseReasons.some((r) => /v1 doctor/.test(r)));
  assert.ok(ra.json.caseReasons.some((r) => /ROUTING\.md \+ DOC-MAP\.md/.test(r)));
  assert.equal(ra.json.stack.guess, 'python');
  const t = ra.json.registries.find((r) => r.path === '.claude/TASKS.md');
  assert.deepEqual(t.counters.map((c) => c.format), ['> **Next free X-##: X-n.**']);
  assert.equal(t.boldIds, 1);
  assert.deepEqual(t.duplicates.map((d) => d.id), ['T-75']);
  assert.ok(ra.json.conflictCopies.some((c) => c.path === '.claude/TASKS 2.md'));
  assert.equal(ra.json.git[0].claudeIgnored, true, 'an ignored .claude/ on purpose is reported');
  assert.deepEqual(ra.json.liveSessions.sessions.map((s) => s.name), ['client-a-build'], 'own session filtered out, peer kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]), ['agents', '--json', '--cwd', a]);
  assert.equal(treeHash(a), before, 'discover wrote nothing');

  const b = put(dir('Client B'), {
    'CLAUDE.md': '# Rules\n- use pnpm\n', 'docs/setup.md': '# Setup\nrun it\n', '.cursor/rules/style.mdc': 'prefer small functions\n',
    'package.json': JSON.stringify({ dependencies: { next: '16.0.0', react: '19' } }), 'app/page.tsx': 'export default function P() { return null }\n',
  });
  const rb = run(['discover', b, '--json']);
  assert.equal(rb.code, 0, rb.out);
  assert.equal(rb.json.case, 'B');
  assert.equal(rb.json.stack.guess, 'nextjs');
  assert.ok(rb.json.docs.some((d) => d.path === '.cursor/rules/style.mdc' && d.kind === 'instructions'));
  assert.ok(rb.json.docs.some((d) => d.path === 'docs/setup.md' && d.kind === 'docs'));

  const c = put(dir('Client C'), {
    'README.md': 'This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).\n\n## Getting Started\nnpm run dev\n',
    'src/app.js': 'function f() {\n  // TODO: handle empty cart\n  return 1;\n}\n',
    'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
  });
  git(c, 'init', '-q', '-b', 'main'); git(c, 'add', '-A'); git(c, 'commit', '-qm', 'first');
  const rc = run(['discover', c, '--json']);
  assert.equal(rc.code, 0, rc.out);
  assert.equal(rc.json.case, 'C');
  assert.equal(rc.json.codeTodos.count, 1);
  assert.ok(rc.json.caseReasons.some((r) => /1 commits/.test(r)), rc.json.caseReasons.join(' | '));
  const human = run(['discover', c]);
  assert.match(human.out, /Case C — no documentation/);
});

test('discover reports live sessions it could not check instead of skipping silently', () => {
  const r = run(['discover', caseA(), '--json'], { STUB_FAIL: '1' });
  assert.equal(r.code, 0);
  assert.equal(r.json.liveSessions.checked, false);
  assert.ok(r.json.notChecked.some((x) => /live sessions/.test(x)));
});

test('stage copies the project, skips dependencies, secrets and big files, and writes a hash manifest', () => {
  const p = caseA();
  put(p, { 'node_modules/lib/index.js': 'x', '.env': 'SECRET=1\n', '.env.local': 'SECRET=2\n', 'keys/server.pem': 'KEY', '.claude/worktrees/t1/file.md': 'wt', 'notes/plan.md': '# plan\n' });
  fs.writeFileSync(path.join(p, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
  git(p, 'remote', 'add', 'origin', 'https://user:tok@example.invalid/x.git');
  const to = path.join(TMP, `staging ${++n}`);
  const r = run(['stage', p, '--to', to, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.last, /^OK staged /);
  for (const gone of ['node_modules', '.env', '.env.local', 'keys/server.pem', 'big.bin', '.claude/worktrees']) assert.ok(!fs.existsSync(path.join(to, gone)), `${gone} must not be staged`);
  for (const kept of ['CLAUDE.md', '.claude/TASKS.md', '.claude/TASKS 2.md', 'notes/plan.md', '.git/HEAD']) assert.ok(fs.existsSync(path.join(to, kept)), `${kept} must be staged`);
  const man = JSON.parse(read(to, 'staging-manifest.json'));
  assert.equal(man.project, p);
  assert.equal(man.files['CLAUDE.md'].sha256, sha(fs.readFileSync(path.join(p, 'CLAUDE.md'))));
  assert.ok(!man.files['.env'] && !man.files['big.bin']);
  assert.deepEqual(man.excluded.big.map((x) => x.path), ['big.bin']);
  assert.deepEqual(man.excluded.secrets.map((x) => x.path).sort(), ['.env', '.env.local', 'keys/server.pem']);
  assert.ok(man.excluded.folders.some((f) => f.rel === 'node_modules'));
  assert.equal(git(to, 'config', 'remote.origin.pushurl'), 'no-push://clockwork-onboard-staging-copy', 'the staging copy can never push');
  assert.equal(git(p, 'config', '--default', 'none', 'remote.origin.pushurl'), 'none', 'the real repo is untouched');
  assert.equal(run(['stage', p, '--to', to]).code, 1, 'refuses a non-empty staging folder');
  assert.equal(run(['stage', p, '--to', path.join(p, 'inside')]).code, 1, 'refuses staging inside the project');
  const def = run(['stage', p]);
  assert.equal(def.code, 0, def.out);
  assert.ok(fs.readdirSync(ENV.CLOCKWORK_ONBOARD_HOME).some((d) => /^client-a-\d+-\d{8}-\d{4}$/.test(d)), 'default staging name is <slug>-<YYYYMMDD-HHMM>');
});

test('census counts struck IDs, counter-only IDs and hashes every doc line', () => {
  const p = caseA();
  const r = run(['census', p, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const c = r.json;
  assert.equal(c.ids['T-12'].struck, true);
  assert.equal(c.ids['T-58'].counterOnly, true, 'an ID named only in a header note is counted');
  assert.equal(c.ids['T-462'].counter, true, 'the counter value is recorded');
  assert.equal(c.ids['T-462'].rows.length, 0);
  assert.equal(c.ids['T-75'].rows.filter((x) => x.file === '.claude/TASKS.md').length, 2);
  assert.ok(c.summary.prefixes.T.struck >= 1 && c.summary.prefixes.T.counterOrMentionOnly >= 2);
  assert.equal(c.summary.prefixes.T.counter, 462);
  assert.ok(c.files['CLAUDE.md'].lines.length === 3);
  const out = path.join(TMP, `census ${++n}.json`);
  assert.equal(run(['census', p, '--out', out]).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).version, 1);
});

// Every counter-line format found in the live projects on 2026-09-30, one registry file each.
const FORMATS = {
  'a/.claude/TASKS.md': ['> **Next free T-##: T-462.** *(**T-461 minted** — note)*', ['T-462'], '*(**T-461 minted** — note)*'],
  'b/.claude/CLIENT.md': ['> Next free: **C-37** · **CD-21**. ✅ **handover sent — C-34 CLOSED.**', ['C-37', 'CD-21'], '✅ **handover sent — C-34 CLOSED.**'],
  'c/.claude/TASKS.md': ['> **Next free: T-242** · Last updated: 2026-09-30 (T-208 reopened)', ['T-242'], 'Last updated: 2026-09-30 (T-208 reopened)'],
  'd/.claude/CLIENT.md': ['> **Next free: C-36** · **Next free: D-21** — the counter holds the number.', ['C-36', 'D-21'], 'the counter holds the number.'],
  'e/.claude/CLIENT.md': ['> **Next free IDs:** C-147 (client items) *(C-146 minted)*', ['C-147'], '(client items) *(C-146 minted)*'],
  'f/.claude/CLIENT-REQUESTS.md': ['> **Next free C-##: C-147** *(mirror)*', ['C-147'], '*(mirror)*'],
  'g/.claude/CLIENT.md': ['> **ID counter — next free: C-52** (never reuse)', ['C-52'], '(never reuse)'],
  'h/.claude/TASKS.md': ['> Next free: **T-258**. 🟢 release note', ['T-258'], '🟢 release note'],
  'i/.claude/TASKS.md': ['> **Next free: T-31** — minting means a row', ['T-31'], 'minting means a row'],
  'j/.claude/TASKS.md': ['**Next free: T-9**', ['T-9'], ''],
};
function migrateFixture() {
  const p = dir('Client M');
  for (const [rel, [counter]] of Object.entries(FORMATS)) {
    const isClient = /CLIENT\.md$/.test(rel);
    put(p, { [rel]: `# ${path.basename(rel, '.md')}\nPurpose line.\n${counter}\n\n## ${isClient ? '🔁 Standing Obligations (recurring + dated)' : 'Open'}\n| ID | Title | Status |\n|---|---|---|\n| **${isClient ? 'C' : 'T'}-1** | first | ⬜ OPEN |\n| ~~**${isClient ? 'C' : 'T'}-2**~~ | ~~second~~ | ✅ done |\n` });
  }
  put(p, {
    '.claude/clockwork.json': JSON.stringify({ clockworkVersion: '2.0.0', project: 'M', registryDir: '.claude', siteDir: '.' }, null, 2),
    '.claude/TASKS.md': V1_TASKS,
    '.claude/TASKS 2.md': V1_TASKS.replace('T-462', 'T-450'),
    '.claude/CLIENT.md': '# CLIENT\n**Last updated:** 2026-09-29\n> **ID counter — next free: C-5** (never reuse)\n> Decisions so far: CD-7 was reversed.\n\n## Client asks\n| ID | Ask | Status |\n|---|---|---|\n| C-4 | send logo | ⬜ OPEN |\n\n## Confirmed Decisions (APPEND-ONLY — a reversal is a NEW row)\n| ID | Decision | Status |\n|---|---|---|\n| CD-3 | orange logo | ✅ VERIFIED |\n',
    'CLAUDE.md': '# Rules\n- Never deploy on Fridays.\n',
  });
  const to = path.join(TMP, `staging ${++n}`);
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  return { p, to };
}

test('migrate normalises every legacy counter format and bold IDs, voids duplicates, moves conflict copies', () => {
  const { p, to } = migrateFixture();
  const before = path.join(to, '.clockwork-onboard', 'census-before.json');
  assert.equal(run(['census', to, '--out', before]).code, 0);
  const snap = treeHash(to);
  const dry = run(['migrate', to, '--dry-run']);
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.last, /dry run, nothing written/);
  assert.equal(treeHash(to), snap, '--dry-run wrote nothing');

  const r = run(['migrate', to, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const COUNTER_RE = /next free: `([A-Z]+)-(\d+)`/g;
  for (const [rel, [, ids, note]] of Object.entries(FORMATS)) {
    const text = read(to, rel);
    const header = text.slice(0, text.indexOf('\n## '));
    assert.deepEqual([...header.matchAll(COUNTER_RE)].map((m) => `${m[1]}-${m[2]}`), ids, `${rel}: registry.mjs sees exactly the old counters`);
    for (const id of ids) assert.ok(header.includes(`> **ID counter — next free: \`${id}\`**`), `${rel}: canonical line for ${id}`);
    if (note) assert.ok(header.includes(`> ${note}`), `${rel}: the rest of the old line is kept as a note`);
    assert.ok(!/\| ~?~?\*\*[A-Z]+-\d+\*\*/.test(text), `${rel}: no bold row IDs left`);
    assert.match(text, /\| ~~[CT]-2~~ \|/, `${rel}: struck + bold → struck`);
  }
  // section rename keeps the legacy heading as a sub-heading
  const cl = read(to, 'b/.claude/CLIENT.md');
  assert.match(cl, /\n## Standing Obligations\n### 🔁 Standing Obligations \(recurring \+ dated\)\n/);
  const root = read(to, '.claude/CLIENT.md');
  assert.match(root, /\n## Confirmed Decisions\n### Confirmed Decisions \(APPEND-ONLY — a reversal is a NEW row\)\n/);
  // missing CD counter added above every CD number used in any registry of the project
  assert.match(root, /> \*\*ID counter — next free: `CD-22`\*\*/); // CD-21 is the highest CD number in any registry (b/)
  // duplicates: both T-75 rows keep their ID. They are DIFFERENT items, so the second is not voided: it is marked
  // as an ID collision in its title cell and keeps its own status (a real open task never disappears).
  const t = read(to, '.claude/TASKS.md');
  assert.equal((t.match(/^\| T-75 \|/gm) || []).length, 2, 'never renumbered');
  assert.match(t, /\| T-75 \| Site copy sweep — a different task that reused the ID ⚠ ID collision with TASKS\.md:11: needs a new ID \(plan question\) \| 🔧 BUILT \|/);
  assert.doesNotMatch(t, /✖ VOID/, 'a different item is never voided');
  assert.deepEqual(r.json.collisions.map((c) => c.id), ['T-75']);
  assert.match(t, /\| T-75 \| DE\/AT domain propagation \| ⬜ OPEN \|/);
  assert.ok(r.json.questions.some((q) => /T-75 has 2 rows.*different item.*status kept/.test(q)));
  assert.ok(r.json.questions.some((q) => /no section maps to "## Open"/.test(q)), 'a non-matching TASKS section becomes a question, not a guess');
  // conflict copy moved, not merged, with a note
  assert.ok(!fs.existsSync(path.join(to, '.claude/TASKS 2.md')));
  assert.equal(read(to, '.claude/.clockwork-backups/conflict-copies/.claude/TASKS 2.md'), V1_TASKS.replace('T-462', 'T-450'));
  assert.match(read(to, '.claude/.clockwork-backups/conflict-copies/NOTE.md'), /`\.claude\/TASKS 2\.md` \| `\.claude\/TASKS\.md`/);
  // originals kept verbatim; D prefix registered
  const orig = read(to, r.json.originals);
  assert.ok(orig.includes('> **Next free T-##: T-462.** *(**T-461 minted 2026-09-29** — remove a login.)*'));
  assert.equal(JSON.parse(read(to, '.claude/clockwork.json')).idPrefixes.D, 'CLIENT.md');
  // registry.mjs reads the migrated files
  const reg = spawnSync(process.execPath, [REGISTRY, 'next', 'T'], { env: { ...ENV, CLOCKWORK_ROOT: to }, encoding: 'utf8' });
  assert.match(reg.stdout, /OK T-462\s*$/, reg.stdout + reg.stderr);
  const regCd = spawnSync(process.execPath, [REGISTRY, 'next', 'CD'], { env: { ...ENV, CLOCKWORK_ROOT: to }, encoding: 'utf8' });
  assert.match(regCd.stdout, /OK CD-22\s*$/, regCd.stdout);
  // idempotent
  const again = run(['migrate', to, '--json']);
  assert.equal(again.code, 0);
  assert.equal(again.json.changes.length, 0, JSON.stringify(again.json.changes.slice(0, 2)));
  // nothing lost across the whole migrate
  const afterC = path.join(to, '.clockwork-onboard', 'census-after.json');
  assert.equal(run(['census', to, '--out', afterC]).code, 0);
  const cmp = run(['compare', before, afterC, '--json']);
  assert.equal(cmp.code, 0, JSON.stringify(cmp.json?.lost?.slice(0, 5)) + cmp.out.slice(-400));
  assert.ok(cmp.json.backupOnly.some((x) => /TASKS 2\.md/.test(x.where) || /TASKS 2\.md/.test(x.to || '')), 'lines living only in the moved conflict copy are listed, not hidden');
  // the real project was never touched
  assert.equal(read(p, '.claude/TASKS.md'), V1_TASKS);
  // refuses outside a staging copy
  assert.equal(run(['migrate', p]).code, 1);
});

test('compare catches a dropped ID and a dropped rule line; old backups do not hide a loss', () => {
  const { to } = migrateFixture();
  const b = path.join(TMP, `before ${++n}.json`), a = path.join(TMP, `after ${n}.json`);
  put(to, { 'PM/archive/registry-backups/2026-09-01/CLAUDE.md': read(to, 'CLAUDE.md') }); // a pre-existing backup
  assert.equal(run(['census', to, '--out', b]).code, 0);
  fs.writeFileSync(path.join(to, '.claude/CLIENT.md'), read(to, '.claude/CLIENT.md').replace(/^\| CD-3 .*\n/m, ''));
  fs.writeFileSync(path.join(to, 'CLAUDE.md'), '# Rules\n');
  assert.equal(run(['census', to, '--out', a]).code, 0);
  const r = run(['compare', b, a, '--json']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.last, /^ERR \d+ item\(s\) LOST/);
  assert.ok(r.json.lost.some((x) => x.type === 'id-row' && x.id === 'CD-3'), 'dropped ID found');
  assert.ok(r.json.lost.some((x) => x.type === 'line' && x.where === 'CLAUDE.md:2' && /Never deploy on Fridays/.test(x.text)), 'dropped rule found even though an old backup still has it');
  // a plan that archives the line verbatim accounts for it, but the ID stays LOST
  const plan = path.join(TMP, `plan ${n}.md`);
  fs.writeFileSync(plan, '---\napproved: false\n---\n# Plan\n## Archived verbatim\n- `CLAUDE.md:2` → PM/archive/old-claude.md (kept out of git)\n## Questions\n- none\n');
  const r2 = run(['compare', b, a, '--plan', plan, '--json']);
  assert.equal(r2.code, 1);
  assert.ok(!r2.json.lost.some((x) => x.where === 'CLAUDE.md:2'));
  assert.ok(r2.json.planned.some((x) => x.where === 'CLAUDE.md:2'));
  const human = run(['compare', b, a]);
  assert.match(human.out, /LOST \(\d+\):/);
  assert.match(human.out, /CD-3 had a row before/);
});

test('onboard.mjs imports its row and counter patterns and its duplicate rule from registry.mjs (no copies to drift)', async () => {
  const mine = fs.readFileSync(TOOL, 'utf8');
  assert.match(mine, /^import \{[^}]*\bROW_RE\b[^}]*\bCOUNTER_RE\b[^}]*\browIdOf\b[^}]*\bcountsAsRow\b[^}]*\} from '\.\.\/templates\/claude\/tools\/registry\.mjs';$/m);
  assert.doesNotMatch(mine, /const (ROW_RE|COUNTER_RE) = /, 'no local copy of a registry.mjs pattern');
  const ob = await import(TOOL), reg = await import(REGISTRY);
  assert.equal(ob.ROW_RE, reg.ROW_RE); assert.equal(ob.COUNTER_RE, reg.COUNTER_RE);
  // one fixture, both tools: onboarding's duplicates are exactly the IDs registry.mjs check reports
  const text = '# TASKS\n> **ID counter — next free: `T-20`**\n\n## Open\n| ID | Task | Status |\n|---|---|---|\n'
    + '| T-1 | Same | ⬜ OPEN |\n| T-1 | Same | ⬜ OPEN |\n| T-2 | Real | ⬜ OPEN |\n| T-2 | → archived 2026-09-01 (TASKS-ARCHIVE.md) |\n'
    + '| T-12 | Parent | ⬜ OPEN |\n| T-12a | Sub-item | ⬜ OPEN |\n| T-7 | Note | ⬜ OPEN |\n| T-7 · update 2026-08-25 | more | ⬜ OPEN |\n'
    + '| ~~T-5~~ | old | ✖ VOID |\n| T-5 | new | ⬜ OPEN |\n| T-9 | Copy | ✖ VOID — duplicate of T-9, see TASKS.md:18 |\n| T-9 | Copy | ⬜ OPEN |\n';
  const mineIds = ob.duplicatesOf(ob.parseRegistry(text)).map((d) => d.id).sort();
  assert.deepEqual(mineIds, ['T-1', 'T-5']);
  const root = dir('Row rule'); fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), JSON.stringify({ clockworkVersion: '2.0.0', project: 'R', registryDir: '.claude', siteDir: '.' }));
  fs.writeFileSync(path.join(root, '.claude', 'TASKS.md'), text);
  const r = spawnSync(process.execPath, [REGISTRY, 'check'], { env: { ...process.env, CLOCKWORK_ROOT: root }, encoding: 'utf8' });
  const kitIds = [...r.stdout.matchAll(/ERROR: TASKS\.md: (T-\d+) has \d+ rows/g)].map((m) => m[1]).sort();
  assert.deepEqual(kitIds, mineIds, r.stdout);
});

// ── apply ───────────────────────────────────────────────────────────────────
function applyFixture({ doctor = false } = {}) {
  const p = put(dir('Client P'), {
    'CLAUDE.md': '# Rules\n- Never deploy on Fridays.\n', 'keep.md': 'unchanged\n', 'code/app.js': 'console.log(1)\n', 'gone.md': 'will vanish from staging\n', '.env': 'SECRET=1\n',
  });
  const to = path.join(TMP, `staging ${++n}`);
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  put(to, { 'CLAUDE.md': '@AGENTS.md\n# Claude only\n', 'AGENTS.md': '# Rules\n- Never deploy on Fridays.\n', '.clockwork-onboard/census-before.json': '{}' });
  fs.rmSync(path.join(to, 'gone.md'));
  if (doctor) {
    fs.mkdirSync(path.join(to, '.claude', 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(KIT, 'templates', 'claude', 'hooks', 'clockwork-doctor.mjs'), path.join(to, '.claude', 'hooks', 'clockwork-doctor.mjs'));
    fs.copyFileSync(path.join(KIT, 'templates', 'clockwork.json'), path.join(to, '.claude', 'clockwork.json'));
  }
  return { p, to };
}
const approve = (to, v = 'true') => fs.writeFileSync(path.join(to, 'ONBOARDING-PLAN.md'), `---\napproved: ${v}\n---\n# Onboarding plan\n`);

test('apply refuses without approval, after the project changed, and with live sessions', () => {
  const { p, to } = applyFixture();
  const snap = treeHash(p);
  let r = run(['apply', to, p]);
  assert.equal(r.code, 1); assert.match(r.last, /^ERR no ONBOARDING-PLAN\.md/);
  approve(to, 'false');
  r = run(['apply', to, p]);
  assert.equal(r.code, 1); assert.match(r.last, /does not say "approved: true"/);
  fs.writeFileSync(path.join(to, 'ONBOARDING-PLAN.md'), '---\napproved: false\n---\n# Plan\nWhen the user agrees, set:\napproved: true\n');
  r = run(['apply', to, p]);
  assert.equal(r.code, 1, 'frontmatter approved: false wins over an example line in the body');
  approve(to);
  r = run(['apply', to, p], { STUB_SESSIONS: JSON.stringify([{ pid: 4, sessionId: 'peer-9', cwd: p, kind: 'interactive', name: 'client-p-build' }]) });
  assert.equal(r.code, 1); assert.match(r.last, /1 other Claude session\(s\) are live.*client-p-build.*--allow-live/);
  r = run(['apply', to, p], { STUB_FAIL: '1' });
  assert.equal(r.code, 1); assert.match(r.last, /could not check for live Claude sessions/);
  r = run(['apply', to, p], { STUB_SESSIONS: JSON.stringify([{ pid: 5, sessionId: 'self-123', cwd: p, kind: 'interactive', name: 'me' }]) });
  assert.equal(treeHash(p) === snap, false, 'own session alone does not block (apply ran)');
  // a fresh pair: the real project changes after staging
  const f2 = applyFixture(); approve(f2.to);
  fs.writeFileSync(path.join(f2.p, 'code/app.js'), 'console.log(2)\n');
  const snap2 = treeHash(f2.p);
  r = run(['apply', f2.to, f2.p]);
  assert.equal(r.code, 1); assert.match(r.last, /changed since staging.*code\/app\.js \(changed\)/);
  assert.equal(treeHash(f2.p), snap2, 'nothing written on refusal');
  // a file created in the project after staging at a path staging wants to write
  const f3 = applyFixture(); approve(f3.to);
  fs.writeFileSync(path.join(f3.p, 'AGENTS.md'), 'someone else wrote this\n');
  r = run(['apply', f3.to, f3.p]);
  assert.equal(r.code, 1); assert.match(r.last, /AGENTS\.md \(created in the project after staging\)/);
  // wrong project
  r = run(['apply', f3.to, p]);
  assert.equal(r.code, 1); assert.match(r.last, /was made from/);
});

test('apply backs up before writing, writes only differing files, never deletes, re-runs the doctor', () => {
  const { p, to } = applyFixture({ doctor: true });
  const keepBefore = fs.statSync(path.join(p, 'keep.md')).mtimeMs;
  const claudeBefore = fs.readFileSync(path.join(p, 'CLAUDE.md'));
  const r = run(['apply', to, p, '--yes', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const j = r.json;
  assert.deepEqual(j.writes.map((w) => w.path).sort(), ['.claude/clockwork.json', '.claude/hooks/clockwork-doctor.mjs', 'AGENTS.md', 'CLAUDE.md']);
  assert.equal(fs.statSync(path.join(p, 'keep.md')).mtimeMs, keepBefore, 'identical file not touched');
  assert.equal(read(p, 'CLAUDE.md'), '@AGENTS.md\n# Claude only\n');
  assert.ok(fs.existsSync(path.join(p, 'gone.md')), 'apply never deletes');
  assert.deepEqual(j.notRemoved, ['gone.md']);
  assert.equal(read(p, '.env'), 'SECRET=1\n');
  assert.ok(!fs.existsSync(path.join(p, 'staging-manifest.json')) && !fs.existsSync(path.join(p, '.clockwork-onboard')), 'staging bookkeeping is not applied');
  const b = path.join(p, j.backup);
  assert.match(j.backup, /^\.claude\/\.clockwork-backups\/\d{8}-\d{4}-onboard/);
  assert.deepEqual(fs.readFileSync(path.join(b, 'CLAUDE.md')), claudeBefore);
  const sums = fs.readFileSync(path.join(b, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.deepEqual(sums, [`${sha(claudeBefore)}  CLAUDE.md`]);
  assert.match(fs.readFileSync(path.join(b, 'CREATED.txt'), 'utf8'), /AGENTS\.md/);
  assert.ok(j.doctor.ran, 'doctor re-run in the real project');
  assert.ok([0, 1].includes(j.doctor.exit), `doctor exit ${j.doctor.exit}: ${j.doctor.tail}`);
  assert.match(j.doctor.tail, /clockwork-doctor|Result:/);
  // second apply: nothing differs
  // second apply: the project already holds the staged version of every file → nothing to do (not "changed")
  const backups = fs.readdirSync(path.join(p, '.claude', '.clockwork-backups')).length;
  const again = run(['apply', to, p, '--yes']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.last, /^OK apply: nothing differs/);
  assert.equal(fs.readdirSync(path.join(p, '.claude', '.clockwork-backups')).length, backups, 'no new backup folder');
  // a real change after the apply is still refused
  fs.writeFileSync(path.join(p, 'CLAUDE.md'), 'edited by someone else\n');
  assert.match(run(['apply', to, p, '--yes']).last, /changed since staging \(1 file\(s\): CLAUDE\.md \(changed\)\)/);
});

test('apply with --allow-live says so loudly', () => {
  const { p, to } = applyFixture(); approve(to);
  const r = run(['apply', to, p, '--allow-live'], { STUB_SESSIONS: JSON.stringify([{ pid: 4, sessionId: 'peer-9', cwd: p, kind: 'interactive', name: 'client-p-build' }]) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /!!! --allow-live: writing while 1 other session\(s\) are live: client-p-build/);
});

test('linked worktrees: a worktree project is staged without its .git pointer; worktrees inside a project are skipped', () => {
  const main = put(dir('Main repo'), { 'CLAUDE.md': '# Rules\n', 'README.md': '# Main\n' });
  git(main, 'init', '-q', '-b', 'main'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'init');
  const wt = path.join(TMP, `Org switcher ${++n}`);
  git(main, 'worktree', 'add', '-q', '-b', 'feature/x', wt);
  git(main, 'worktree', 'add', '-q', '-b', 't1-inner', path.join(main, '.worktrees', 't1'));
  const d = run(['discover', wt, '--json']);
  assert.equal(d.code, 0, d.out);
  assert.equal(d.json.git[0].linkedWorktree, true);
  const to = path.join(TMP, `staging ${++n}`);
  const s = run(['stage', wt, '--to', to, '--json']);
  assert.equal(s.code, 0, s.out);
  assert.ok(!fs.existsSync(path.join(to, '.git')), 'a .git pointer into another repository is never copied');
  assert.match(s.json.git[0].why, /linked worktree/);
  const dm = run(['discover', main, '--json']);
  assert.ok(!dm.json.docs.some((x) => x.path.startsWith('.worktrees/')), 'files of a nested worktree are not project docs');
  const to2 = path.join(TMP, `staging ${++n}`);
  assert.equal(run(['stage', main, '--to', to2]).code, 0);
  assert.ok(!fs.existsSync(path.join(to2, '.worktrees')), 'nested worktree not staged');
  assert.ok(fs.existsSync(path.join(to2, '.git', 'HEAD')));
});

// iCloud offload, faked: CLOCKWORK_FAKE_OFFLOADED (registry.mjs offloadState, imported by onboard.mjs) marks paths as
// offloaded. An offloaded file is never read: not copied, listed, and never counted as lost. No real iCloud here.
const OFF_NOTE = (p) => `not checked: ${p} is offloaded by iCloud — open it in Finder or run \`brctl download "${p}"\`, then re-run`;
test('offloaded files (faked): discover lists them, stage does not copy them, compare never counts them as lost', () => {
  const p = caseA();
  put(p, { 'notes/plan.md': '# plan\n- Keep the blue logo.\n' });
  const offPaths = [path.join(p, 'notes/plan.md'), path.join(p, '.claude/ROUTING.md')];
  const OFF = { CLOCKWORK_FAKE_OFFLOADED: offPaths.join(':') };
  const d = run(['discover', p, '--json'], OFF);
  assert.equal(d.code, 0, d.out + d.err);
  assert.deepEqual([...d.json.offloaded].sort(), ['.claude/ROUTING.md', 'notes/plan.md']);
  for (const x of offPaths) assert.ok(d.json.notChecked.includes(OFF_NOTE(x)), d.json.notChecked.join('\n'));
  assert.ok(d.json.warnings.some((w) => /2 file\(s\) are offloaded by iCloud and were not read/.test(w)));
  const to = path.join(TMP, `staging ${++n}`);
  const s = run(['stage', p, '--to', to], OFF);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /not copied \(offloaded by iCloud, so never read.*\): (\.claude\/ROUTING\.md, notes\/plan\.md|notes\/plan\.md, \.claude\/ROUTING\.md)/);
  for (const rel of ['notes/plan.md', '.claude/ROUTING.md']) assert.ok(!fs.existsSync(path.join(to, rel)), `${rel} not copied`);
  const man = JSON.parse(read(to, 'staging-manifest.json'));
  assert.deepEqual(man.excluded.offloaded.map((x) => x.path).sort(), ['.claude/ROUTING.md', 'notes/plan.md']);
  assert.ok(!man.files['notes/plan.md'], 'not in the manifest: apply never treats it as removed');
  // census: recorded as offloaded (never read); compare: not LOST, named under NOT CHECKED
  const b = path.join(TMP, `before ${++n}.json`), a = path.join(TMP, `after ${n}.json`), b0 = path.join(TMP, `before-local ${n}.json`);
  assert.equal(run(['census', p, '--out', b], OFF).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(b, 'utf8')).files['notes/plan.md'].offloaded, true);
  assert.equal(run(['census', to, '--out', a]).code, 0);
  const c = run(['compare', b, a, '--json']);
  assert.ok(!c.json.lost.some((x) => /notes\/plan\.md|ROUTING\.md/.test(`${x.where} ${x.text}`)), JSON.stringify(c.json.lost));
  assert.ok(c.json.notChecked.some((x) => x.startsWith('notes/plan.md: offloaded by iCloud in the before census')), c.json.notChecked.join('\n'));
  assert.match(run(['compare', b, a]).out, /NOT CHECKED \(\d+; offloaded by iCloud/);
  assert.equal(run(['census', p, '--out', b0]).code, 0);
  assert.ok(run(['compare', b0, a, '--json']).json.lost.some((x) => /Keep the blue logo/.test(x.text)), 'control: read locally, the missing line IS lost');
});

test('apply with offloaded project files (faked): never reads them; refuses only where staging would overwrite one', () => {
  const { p, to } = applyFixture(); approve(to);
  const snap = treeHash(p);
  const claude = path.join(p, 'CLAUDE.md');
  let r = run(['apply', to, p], { CLOCKWORK_FAKE_OFFLOADED: claude }); // staging rewrote CLAUDE.md
  assert.equal(r.code, 1, r.out);
  assert.match(r.last, /^ERR 1 project file\(s\) are offloaded by iCloud, so apply cannot compare them with staging or back them up/);
  assert.ok(r.last.includes(OFF_NOTE(claude)));
  assert.equal(treeHash(p), snap, 'nothing written');
  r = run(['apply', to, p, '--json'], { CLOCKWORK_FAKE_OFFLOADED: path.join(p, 'keep.md') }); // staging left keep.md alone
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(r.json.notCheckedOffloaded, ['keep.md']);
  assert.ok(!r.json.writes.some((w) => w.path === 'keep.md'));
  assert.ok(r.json.writes.some((w) => w.path === 'CLAUDE.md'), 'the rest applied');
});

// ── design coverage (2026-10-01): every line of the old design file has a checked destination ──────────────
const OLD_DS = '---\ntitle: x\n---\n# Design system\nIntro: this file holds our design rules.\n## Colour\n- Primary #E4572E.\n- Hover lifts cards 4px.\n| Token | Value |\n|---|---|\n| radius | 8px |\n- Buttons use pill shape.\n';
const COV_REL = '.claude/reports/onboarding-2026-10-01/design-coverage.md';
const COV_OK = [
  '# Design coverage', '| Old line | Goes to | Proof |', '|---|---|---|',
  '| `.claude/DESIGN-SYSTEM.md:5` | not a rule | intro sentence, no rule |',
  '| .claude/DESIGN-SYSTEM.md:7 | CO-1 | |',
  '| .claude/DESIGN-SYSTEM.md:8 | retired | CD-4 |',
  '| .claude/DESIGN-SYSTEM.md:11-12 | kept .claude/DESIGN-SYSTEM-ARCHIVE.md:11 | |', ''].join('\n');
function coverageFixture({ coverage = COV_OK, ds } = {}) {
  const p = put(dir('Design P'), { '.claude/DESIGN-SYSTEM.md': OLD_DS, 'keep.md': 'x\n' });
  const to = path.join(TMP, `staging ${++n}`);
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  put(to, {
    '.claude/rules/design-system.md': ds ?? '# Design system\nNot yet converted, still binding: `.claude/DESIGN-SYSTEM-ARCHIVE.md` lines 11-12.\n| Rule | Value / token | How to measure | Source |\n|---|---|---|---|\n| CO-1 Colour only as tokens | #E4572E | literals vs tokens | .claude/DESIGN-SYSTEM.md:7 |\n| SP-2 Section padding | 96px | padding-top | notes.md:3 |\n',
    '.claude/CLIENT.md': '# Client\n## Confirmed Decisions\n| ID | Decision | Date · who | Source | Status |\n|---|---|---|---|---|\n| CD-4 | Cards no longer lift on hover | 2026-09-01 · Sam | call | ✅ |\n',
    '.claude/DESIGN-SYSTEM-ARCHIVE.md': OLD_DS,
    ...(coverage === null ? {} : { [COV_REL]: coverage }),
  });
  return { p, to };
}

test('contentLines: frontmatter, headings, rules, table headers and separators are structure; fenced lines count', async () => {
  const { contentLines } = await import(TOOL);
  assert.deepEqual(contentLines(OLD_DS).map((x) => x.n), [5, 7, 8, 11, 12]);
  assert.deepEqual(contentLines('# H\n```css\n.a{padding:8px}\n```\n---\n<!-- note -->\ntext\n').map((x) => x.n), [3, 7]);
});

test('coverage: every content line mapped to a real row, a proven retirement, a verbatim kept copy or "not a rule" → OK; apply goes ahead', () => {
  const { p, to } = coverageFixture();
  const r = run(['coverage', to, '--json']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.required, true);
  assert.deepEqual(r.json.unmapped, []); assert.deepEqual(r.json.problems, []);
  assert.deepEqual(r.json.oldFiles, [{ path: '.claude/DESIGN-SYSTEM.md', contentLines: 5, mapped: 5 }]);
  const a = run(['apply', to, p, '--yes', '--json']);
  assert.equal(a.code, 0, a.out);
  assert.ok(a.json.writes.some((w) => w.path === '.claude/rules/design-system.md'));
});

test('coverage: an unmapped line makes apply refuse and write nothing (negative control for the OK case)', () => {
  const { p, to } = coverageFixture({ coverage: COV_OK.replace('| .claude/DESIGN-SYSTEM.md:11-12 | kept .claude/DESIGN-SYSTEM-ARCHIVE.md:11 | |\n', '| .claude/DESIGN-SYSTEM.md:11 | kept .claude/DESIGN-SYSTEM-ARCHIVE.md:11 | |\n') });
  const r = run(['coverage', to]);
  assert.equal(r.code, 1);
  assert.match(r.out, /UNMAPPED \.claude\/DESIGN-SYSTEM\.md:12: - Buttons use pill shape\./);
  assert.match(r.out, /\.claude\/DESIGN-SYSTEM\.md: 4 of 5 line\(s\) mapped/);
  const snap = treeHash(p);
  const a = run(['apply', to, p, '--yes']);
  assert.equal(a.code, 1);
  assert.match(a.last, /^ERR design coverage: 1 line\(s\) of the old design file have no destination .*DESIGN-SYSTEM\.md:12.*Nothing written\./);
  assert.equal(treeHash(p), snap);
});

test('coverage: each destination is verified: row exists and cites the line, retirement proof exists, kept copy is verbatim and pointed at, reasons given', () => {
  const bad = [
    '| Old line | Goes to | Proof |', '|---|---|---|',
    '| .claude/DESIGN-SYSTEM.md:5 | not a rule | |',
    '| .claude/DESIGN-SYSTEM.md:7 | CO-9 | |',
    '| .claude/DESIGN-SYSTEM.md:7 | SP-2 | |',
    '| .claude/DESIGN-SYSTEM.md:8 | retired | CD-99 |',
    '| .claude/DESIGN-SYSTEM.md:8 | retired | |',
    '| .claude/DESIGN-SYSTEM.md:11 | kept .claude/DESIGN-SYSTEM-ARCHIVE.md:12 | |',
    '| .claude/DESIGN-SYSTEM.md:12 | moved somewhere | |',
    '| .claude/DESIGN-SYSTEM.md:40 | not a rule | past the end |', ''].join('\n');
  const { to } = coverageFixture({ coverage: bad });
  const r = run(['coverage', to, '--json']);
  assert.equal(r.code, 1);
  const pr = r.json.problems.join('\n');
  assert.match(pr, /:3: "not a rule" needs its reason/);
  assert.match(pr, /:4: row CO-9 is not in \.claude\/rules\/design-system\.md/);
  assert.match(pr, /:5: row SP-2's Source does not cite DESIGN-SYSTEM\.md:7/);
  assert.match(pr, /:6: retired needs a proof that exists[^\n]*got "CD-99"/);
  assert.match(pr, /:7: retired needs a proof that exists[^\n]*got "nothing"/);
  assert.match(pr, /:8: \.claude\/DESIGN-SYSTEM-ARCHIVE\.md:12 is not the verbatim text of \.claude\/DESIGN-SYSTEM\.md:11/);
  assert.match(pr, /:9: unknown destination "moved somewhere"/);
  assert.match(pr, /:10: \.claude\/DESIGN-SYSTEM\.md:40 is outside the file \(13 lines\)/);
  assert.equal(r.json.unmapped.length, 5, 'a line whose only destination failed its check is still unmapped');
  // a kept copy with no pointer in design-system.md: no agent would read it
  const nop = coverageFixture({ ds: '# Design system\n| Rule | Value / token | How to measure | Source |\n|---|---|---|---|\n| CO-1 Colour only as tokens | #E4572E | literals | .claude/DESIGN-SYSTEM.md:7 |\n' });
  assert.match(run(['coverage', nop.to]).out, /has no line pointing at DESIGN-SYSTEM-ARCHIVE\.md as still binding/);
});

test('coverage: required only when onboarding rewrote design-system.md from an old design file; a missing coverage file is refused', () => {
  const none = coverageFixture({ coverage: null });
  const r = run(['coverage', none.to, '--json']);
  assert.equal(r.code, 1); assert.match(r.json.problems[0], /no design-coverage\.md under \.claude\/reports\/onboarding-\*/);
  assert.equal(r.json.unmapped.length, 5);
  // no old design file in the project: not required, apply unaffected
  const plain = put(dir('Plain P'), { 'CLAUDE.md': '# x\n' });
  const to = path.join(TMP, `staging ${++n}`);
  assert.equal(run(['stage', plain, '--to', to]).code, 0);
  put(to, { '.claude/rules/design-system.md': '# Design system\n' });
  const q = run(['coverage', to, '--json']);
  assert.equal(q.code, 0); assert.equal(q.json.required, false); assert.match(q.last, /not required \(no old design file/);
});

// ── 2026-10-01 (verifier): the coverage gate never skips silently ───────────────────────────────────────────
const GUIDE = '# Style\n- Buttons are pill shaped.\n- Primary #E4572E.\n- Never use pure black.\n';
const NEW_DS = (cite) => `# Design system\n| Rule | Value | How | Source |\n|---|---|---|---|\n| CO-1 Primary | #E4572E | x | ${cite} |\n`;
test('coverage: an old design file under any name discover lists as a design source (style guide, brand guidelines, a "Design System" folder) is covered, not skipped', async () => {
  const { isDesignDoc } = await import(TOOL);
  for (const f of ['docs/style-guide.md', 'brand-guidelines.md', 'DESIGN-GUIDE.md', 'design-tokens.md', 'Design System/colours.md', 'docs/branding/voice.md', 'styleguide.md', 'DESIGN-SYSTEM.md', 'design.md']) assert.ok(isDesignDoc(f), f);
  for (const f of ['docs/design/auth-flow.md', 'design-review-notes.md', 'README.md', 'tokens.json', 'styles.md']) assert.ok(!isDesignDoc(f), f);
  for (const rel of ['docs/style-guide.md', 'brand-guidelines.md', 'Design System/colours.md', 'design-tokens.md']) {
    const p = put(dir('Guide P'), { [rel]: GUIDE, 'keep.md': 'x\n' });
    const d = run(['discover', p, '--json']);
    assert.ok(d.json.design.files.some((f) => f.path === rel), `discover lists ${rel} as a design source`);
    const to = path.join(TMP, `staging ${++n}`);
    assert.equal(run(['stage', p, '--to', to]).code, 0);
    put(to, { '.claude/rules/design-system.md': NEW_DS(`${path.posix.basename(rel)}:3`) });
    const r = run(['coverage', to, '--json']);
    assert.equal(r.code, 1, rel); assert.equal(r.json.required, true, rel);
    assert.equal(r.json.unmapped.length, 3, rel);
    const snap = treeHash(p);
    const a = run(['apply', to, p, '--yes']);
    assert.equal(a.code, 1, rel); assert.match(a.last, /^ERR design coverage: 3 line\(s\) of the old design file have no destination/);
    assert.equal(treeHash(p), snap, 'nothing written');
  }
});

test('coverage: the project\'s own design-system.md rewritten in place needs a destination for every line it lost; lines kept word for word need none; the bare kit template is skipped', () => {
  const OWN = '# Design system\n| Rule | Value |\n|---|---|\n| CO-1 Primary | #E4572E |\n| SP-1 Section padding | 96px |\n| RA-1 Radius | 8px |\n- Cards never lift on hover.\n';
  const p = put(dir('Own DS P'), { '.claude/rules/design-system.md': OWN, 'keep.md': 'x\n' });
  const to = path.join(TMP, `staging ${++n}`);
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  put(to, { '.claude/rules/design-system.md': '# Design system\n| Rule | Value |\n|---|---|\n| CO-1 Primary | #E4572E |\n' });
  const r = run(['coverage', to, '--json']);
  assert.equal(r.code, 1); assert.equal(r.json.required, true);
  assert.equal(r.json.keptInPlace, 1, 'CO-1 is still there word for word');
  assert.deepEqual(r.json.unmapped.map((x) => x.split(': ')[0]), ['.claude/rules/design-system.md:5', '.claude/rules/design-system.md:6', '.claude/rules/design-system.md:7']);
  const snap = treeHash(p);
  assert.equal(run(['apply', to, p, '--yes']).code, 1);
  assert.equal(treeHash(p), snap, 'the old rules are not overwritten');
  // control: mapped (a kept verbatim copy for the lost lines) → OK
  put(to, { '.claude/rules/design-system.md': '# Design system\nStill binding: `.claude/DESIGN-SYSTEM-ARCHIVE.md`.\n| Rule | Value |\n|---|---|\n| CO-1 Primary | #E4572E |\n', '.claude/DESIGN-SYSTEM-ARCHIVE.md': OWN,
    '.claude/reports/onboarding-2026-10-01/design-coverage.md': '| Old line | Goes to | Proof |\n|---|---|---|\n| .claude/rules/design-system.md:5-7 | kept .claude/DESIGN-SYSTEM-ARCHIVE.md:5 | |\n' });
  assert.equal(run(['coverage', to]).code, 0);
  // the kit template as it ships holds no project rules: not an old design file
  const tpl = fs.readFileSync(path.join(KIT, 'templates', 'claude', 'rules', 'design-system.md'), 'utf8');
  const kp = put(dir('Kit DS P'), { '.claude/rules/design-system.md': tpl, 'keep.md': 'x\n' });
  const kto = path.join(TMP, `staging ${++n}`);
  assert.equal(run(['stage', kp, '--to', kto]).code, 0);
  put(kto, { '.claude/rules/design-system.md': tpl + '\n| CO-9 Filled | #000 | x | keep.md:1 |\n' });
  const k = run(['coverage', kto, '--json']);
  assert.equal(k.code, 0); assert.equal(k.json.required, false); assert.match(k.last, /not required \(no old design file/);
});

test('coverage: when it cannot check (an old design file iCloud kept out of staging, or no before-copy) it says so and apply refuses', () => {
  const p = put(dir('Off guide P'), { 'style-guide.md': GUIDE, 'keep.md': 'x\n' });
  const to = path.join(TMP, `staging ${++n}`);
  assert.equal(run(['stage', p, '--to', to], { CLOCKWORK_FAKE_OFFLOADED: path.join(p, 'style-guide.md') }).code, 0);
  assert.ok(!fs.existsSync(path.join(to, 'style-guide.md')), 'an offloaded file is not staged');
  put(to, { '.claude/rules/design-system.md': NEW_DS('keep.md:1') });
  const r = run(['coverage', to, '--json']);
  assert.equal(r.code, 1); assert.equal(r.json.required, true);
  assert.match(r.json.problems.join('\n'), /style-guide\.md: offloaded by iCloud when staged, so it is not in the before-copy .*brctl download .*re-stage/);
  const snap = treeHash(p);
  const a = run(['apply', to, p, '--yes']);
  assert.equal(a.code, 1); assert.match(a.last, /^ERR design coverage: .*style-guide\.md: offloaded by iCloud/);
  assert.equal(treeHash(p), snap);
  // no before-copy (an older staging copy): the gate cannot run, and says so
  const { p: q, to: qto } = coverageFixture();
  const pr = path.join(qto, '.clockwork-onboard', 'pristine');
  fs.renameSync(pr, `${pr}-gone`);
  const c = run(['coverage', qto]);
  assert.equal(c.code, 1); assert.match(c.last, /^ERR design coverage could not run: no before-copy/);
  const qsnap = treeHash(q);
  const qa = run(['apply', qto, q, '--yes']);
  assert.equal(qa.code, 1); assert.match(qa.last, /^ERR design coverage could not run: no before-copy .*Nothing written\./);
  assert.equal(treeHash(q), qsnap);
});
