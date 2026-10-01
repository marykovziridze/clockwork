// Tests for the onboarding fixes found by the break-it, nothing-lost and trial reviews (2026-09-30): staging safety
// (push, secrets, paths, worktrees, symlinks), compare that cannot be fooled by the archive or by a sentence that
// also sits in another file, migrate's duplicate/counter/worktree rules, apply resume, sources and rebase.
// Offline; every fixture lives in os.tmpdir() (names with spaces on purpose) and is removed afterwards.
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
const { census, compare, SECRET } = await import(TOOL);
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw onboard fixes ')));
after(() => { try { execFileSync('chmod', ['-R', 'u+w', TMP]); } catch { /* best effort */ } fs.rmSync(TMP, { recursive: true, force: true }); });

const STUB = path.join(TMP, 'claude stub.mjs');
fs.writeFileSync(STUB, `#!/usr/bin/env node\nprocess.stdout.write(process.env.STUB_SESSIONS || '[]');\n`);
fs.chmodSync(STUB, 0o755);
const ENV = Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  CLOCKWORK_CLAUDE_BIN: STUB, CLOCKWORK_SYNCED_ROOTS: '', CLAUDE_CODE_SESSION_ID: 'self-123', CLAUDE_PID: '999999', CLOCKWORK_ONBOARD_HOME: path.join(TMP, 'staging home') });
for (const k of ['CLOCKWORK_ROOT', 'CLAUDE_PROJECT_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'STUB_SESSIONS']) delete ENV[k];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitTry = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { env: ENV, encoding: 'utf8' });
let n = 0;
const dir = (label) => { const d = path.join(TMP, `${label} ${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const stagingPath = () => path.join(TMP, `staging ${++n}`);
function put(root, files) { for (const [rel, body] of Object.entries(files)) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); } return root; }
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env: { ...ENV, ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const lines = r.stdout.trim().split('\n');
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(lines.slice(0, -1).join('\n')); } catch { /* not json */ } }
  return { code: r.status, out: r.stdout, err: r.stderr, last: lines[lines.length - 1], json };
}
function allFiles(root) { const out = []; const st = ['']; while (st.length) { const r = st.pop(); for (const e of fs.readdirSync(path.join(root, r), { withFileTypes: true })) { const x = path.join(r, e.name); if (e.isDirectory()) st.push(x); else if (e.isFile()) out.push(x); } } return out; }
function treeHash(root) { return sha(allFiles(root).sort().map((r) => `${r}:${sha(fs.readFileSync(path.join(root, r)))}`).join('\n')); }
const approve = (to) => fs.writeFileSync(path.join(to, 'ONBOARDING-PLAN.md'), '---\napproved: true\n---\n# Onboarding plan\n');
const repo = (root) => { git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init'); return root; };

// ── stage safety ────────────────────────────────────────────────────────────
test('stage: a remote with two push URLs cannot push from staging, nor can an explicit URL', () => {
  const p = repo(put(dir('Push proj'), { 'README.md': '# push\n' }));
  const a = path.join(TMP, `remote a ${++n}.git`), b = path.join(TMP, `remote b ${n}.git`);
  execFileSync('git', ['init', '-q', '--bare', a], { env: ENV }); execFileSync('git', ['init', '-q', '--bare', b], { env: ENV });
  git(p, 'remote', 'add', 'origin', a);
  git(p, 'config', '--add', 'remote.origin.pushurl', a); git(p, 'config', '--add', 'remote.origin.pushurl', b);
  git(p, 'remote', 'add', 'up', b);
  const to = stagingPath();
  const r = run(['stage', p, '--to', to, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.git[0].pushDisabled, true);
  for (const rem of ['origin', 'up']) assert.deepEqual(git(to, 'remote', 'get-url', '--push', '--all', rem).split('\n'), ['no-push://clockwork-onboard-staging-copy'], `${rem}: every push URL is nowhere`);
  assert.notEqual(gitTry(to, 'push', 'origin', 'main').status, 0, 'push to the two-URL remote fails');
  assert.notEqual(gitTry(to, 'push', 'up', 'main').status, 0);
  assert.notEqual(gitTry(to, 'push', a, 'main').status, 0, 'an explicit path/URL push fails too');
  for (const bare of [a, b]) assert.notEqual(gitTry(bare, 'rev-parse', '--verify', 'refs/heads/main').status, 0, `${path.basename(bare)} received nothing`);
  assert.deepEqual(git(p, 'config', '--get-all', 'remote.origin.pushurl').split('\n'), [a, b], 'the real repo is untouched');
});

test('stage: common secret files are never copied, .env.example is, and a token in a remote URL does not reach staging', () => {
  const secrets = ['.env', '.envrc', '.env.local', '.git-credentials', '.aws/credentials', 'config/production.env', 'config/serviceAccountKey.json', '.htpasswd', 'terraform.tfvars', 'infra/terraform.tfstate', 'firebase-adminsdk-x1.json', 'kubeconfig', '.ssh/config', '.docker/config.json', '.pgpass', 'credentials'];
  const p = put(dir('Secret proj'), { 'README.md': '# s\n', '.env.example': 'API_KEY=\n', '.env.sample': 'A=\n', 'docs/env.md': '# env docs\n', ...Object.fromEntries(secrets.map((s) => [s, 'TOPSECRET\n'])) });
  repo(p);
  git(p, 'remote', 'add', 'origin', 'https://dev:ghp_FAKETOKEN123@github.com/x/y.git');
  git(p, 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic FAKEHEADER99');
  const to = stagingPath();
  const r = run(['stage', p, '--to', to, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const ex = r.json.excluded.secrets.map((x) => x.path).sort();
  for (const s of secrets) { assert.ok(ex.includes(s), `${s} is listed as a secret`); assert.ok(!fs.existsSync(path.join(to, s)), `${s} is not staged`); }
  for (const kept of ['.env.example', '.env.sample', 'docs/env.md']) assert.ok(fs.existsSync(path.join(to, kept)), `${kept} is documentation and is staged`);
  for (const f of allFiles(to)) { const t = fs.readFileSync(path.join(to, f), 'latin1'); assert.ok(!t.includes('FAKETOKEN123') && !t.includes('FAKEHEADER99') && !t.includes('TOPSECRET'), `${f} carries no credential`); }
  assert.equal(git(to, 'config', 'remote.origin.url'), 'https://github.com/x/y.git', 'the remote keeps its host, without the token');
  assert.equal(SECRET('notes/.env.template'), null);
  assert.ok(SECRET('deploy/.env.production'));
});

test('stage: staging cannot land inside the project through another spelling or a symlinked parent', () => {
  const p = put(dir('CaseProj'), { 'README.md': '# c\n' });
  const link = path.join(TMP, `link to proj ${++n}`); fs.symlinkSync(p, link);
  const r1 = run(['stage', p, '--to', path.join(link, 'new-parent', 'stg')]);
  assert.equal(r1.code, 1, r1.out); assert.match(r1.last, /must be outside the project/);
  assert.ok(!fs.existsSync(path.join(p, 'new-parent')), 'nothing written inside the project');
  if (process.platform === 'darwin') {
    const r2 = run(['stage', p, '--to', path.join(path.dirname(p), path.basename(p).toLowerCase(), 'staging-inside')]);
    assert.equal(r2.code, 1, r2.out); assert.match(r2.last, /must be outside the project/);
    assert.ok(!fs.existsSync(path.join(p, 'staging-inside')));
  }
});

test('stage: the staging .git forgets the real worktrees, so git worktree repair in staging cannot rewrite them', () => {
  const main = repo(put(dir('WT main'), { 'README.md': '# m\n' }));
  const outside = path.join(TMP, `wt outside ${++n}`);
  git(main, 'worktree', 'add', '-q', '-b', 'feat-out', outside);
  git(main, 'worktree', 'add', '-q', '-b', 'feat-in', path.join(main, '.claude', 'worktrees', 'in'));
  const realPointer = read(outside, '.git');
  const to = stagingPath();
  const r = run(['stage', main, '--to', to, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.git[0].worktreeMetadataDropped.length, 2);
  const listed = git(to, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  assert.deepEqual(listed, [`worktree ${to}`], 'only the staging checkout itself');
  gitTry(to, 'worktree', 'repair');
  assert.equal(read(outside, '.git'), realPointer, 'the real worktree still points at the real repo');
});

test('stage: a symlink into the project is re-pointed inside staging; one pointing outside is not staged; apply ignores the re-point', () => {
  const outsideDir = put(dir('outside target'), { 'x.md': 'outside\n' });
  const p = put(dir('Link proj'), { 'theme-src/style.md': 'real style\n', 'README.md': '# l\n' });
  fs.mkdirSync(path.join(p, 'site'));
  fs.symlinkSync(path.join(p, 'theme-src'), path.join(p, 'site', 'theme'));
  fs.symlinkSync('../theme-src/style.md', path.join(p, 'site', 'rel.md'));
  fs.symlinkSync(outsideDir, path.join(p, 'site', 'out'));
  const to = stagingPath();
  const r = run(['stage', p, '--to', to, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const t = fs.readlinkSync(path.join(to, 'site', 'theme'));
  assert.ok(!path.isAbsolute(t), `re-pointed as a relative link (${t})`);
  assert.equal(fs.realpathSync(path.join(to, 'site', 'theme')), fs.realpathSync(path.join(to, 'theme-src')));
  fs.appendFileSync(path.join(to, 'site', 'theme', 'style.md'), 'edited in staging\n');
  assert.equal(read(p, 'theme-src/style.md'), 'real style\n', 'an edit through the staged link stays in staging');
  assert.equal(fs.readlinkSync(path.join(to, 'site', 'rel.md')), '../theme-src/style.md');
  assert.ok(!fs.existsSync(path.join(to, 'site', 'out')), 'a link out of the project is not staged');
  assert.deepEqual(r.json.excluded.symlinks.map((x) => x.path), ['site/out']);
  // the before-copy exists, matches, and is read-only
  const pr = path.join(to, '.clockwork-onboard', 'pristine');
  assert.equal(read(pr, 'README.md'), '# l\n');
  assert.equal(fs.statSync(path.join(pr, 'README.md')).mode & 0o222, 0, 'before-copy files are read-only');
  fs.writeFileSync(path.join(to, 'theme-src', 'style.md'), 'real style\n'); // undo the probe edit
  approve(to);
  const a = run(['apply', to, p, '--yes', '--json']);
  assert.equal(a.code, 0, a.out + a.err);
  assert.ok(!a.json.symlinksNotApplied.includes('site/theme'), 'a link stage re-pointed is not reported as a change');
  assert.ok(fs.lstatSync(path.join(p, 'site', 'theme')).isSymbolicLink() && path.isAbsolute(fs.readlinkSync(path.join(p, 'site', 'theme'))), 'the real link is untouched');
});

// ── compare ─────────────────────────────────────────────────────────────────
function probe() {
  const p = put(dir('Probe'), {
    '.claude/TASKS.md': '# TASKS\n> **ID counter — next free: `T-3`**\n\n## Open\n| ID | Task | Status |\n|---|---|---|\n| T-1 | Ship the site | ⬜ OPEN |\n| T-2 | Fix VAT rounding | ⬜ OPEN |\n',
    'CLAUDE.md': '# Rules\n- Prices are always shown incl. VAT.\n- Never deploy on Fridays.\n',
    'PM/meetings/call.md': '# Call\n- Prices are always shown incl. VAT.\n',
  });
  const before = census(p);
  const orig = path.join(p, '.claude/reports/onboarding-2026-09-30/originals');
  put(orig, { '.claude/TASKS.md': read(p, '.claude/TASKS.md'), 'CLAUDE.md': read(p, 'CLAUDE.md') });
  fs.writeFileSync(path.join(p, '.claude/TASKS.md'), read(p, '.claude/TASKS.md').replace(/^\| T-2 .*\n/m, ''));
  fs.writeFileSync(path.join(p, 'CLAUDE.md'), '@AGENTS.md\n');
  fs.writeFileSync(path.join(p, 'AGENTS.md'), '# Rules\n- Never deploy on Fridays.\n');
  return { p, before, after: census(p) };
}
test('compare: an open row kept only in the archive is NOT LIVE ANY MORE, and a dropped rule is not hidden by the same sentence elsewhere', () => {
  const { before, after: afterC } = probe();
  const r = compare(before, afterC);
  assert.ok(r.lost.some((x) => x.type === 'id-not-live' && x.id === 'T-2'), JSON.stringify(r.lost));
  assert.ok(r.lost.some((x) => x.type === 'line-archive-only' && x.where === 'CLAUDE.md:2'), 'the VAT rule is LOST although a meeting note has the same sentence');
  assert.ok(!r.lost.some((x) => /Fridays/.test(x.text || '')), 'a rule that moved to AGENTS.md is moved, not lost');
  assert.equal(r.counts.notLiveIds, 1);
  assert.ok(r.counts.archiveOnlyLines >= 2);
  // Naming the range and the ID in the plan accounts for both; the headline still counts them.
  const plan = '---\napproved: false\n---\n## Archived verbatim\n<!-- template text: `CLAUDE.md` `T-1` names nothing -->\n- `CLAUDE.md:1-3` → originals (VAT rule: Sam Q3)\n- `.claude/TASKS.md:8` and `T-2` → originals\n';
  const r2 = compare(before, afterC, plan);
  assert.deepEqual(r2.lost, [], JSON.stringify(r2.lost));
  assert.ok(r2.reportOnly.some((x) => x.where === 'CLAUDE.md:2'));
  assert.ok(r2.planned.some((x) => x.id === 'T-2'));
  assert.equal(r2.counts.archiveOnlyNamedByPlan, r2.counts.archiveOnlyLines);
  // A plan that only mentions files inside an HTML comment accounts for nothing.
  assert.ok(compare(before, afterC, '## Archived verbatim\n<!--\n`CLAUDE.md` `T-2`\n-->\n').lost.length >= 2);
});

test('compare: a copy made during onboarding (DESIGN-SYSTEM-ARCHIVE.md, legacy/CLAUDE-v1.md) is not a live home; lines kept only there are LOST (final round)', () => {
  const locked = Array.from({ length: 12 }, (_, i) => `- Motion rule ${i + 1}: hover lifts 2px over 180ms (LOCKED BY OWNER 2026-09-02)`).join('\n');
  const p = put(dir('Copy proj'), {
    '.claude/DESIGN-SYSTEM.md': `# Design system\n## 1 Colour\n- Primary #E4572E.\n## 6 Motion and components\n${locked}\n`,
    'CLAUDE.md': '# Rules\n- Never deploy on Fridays.\n- Prices are always shown incl. VAT.\n- Use pnpm, never npm.\n',
  });
  const before = census(p);
  put(p, { '.claude/DESIGN-SYSTEM-ARCHIVE.md': read(p, '.claude/DESIGN-SYSTEM.md'), '.claude/legacy/CLAUDE-v1.md': read(p, 'CLAUDE.md') });
  fs.writeFileSync(path.join(p, '.claude/DESIGN-SYSTEM.md'), '# Design system\n## 1 Colour\n- Primary #E4572E.\n');
  fs.writeFileSync(path.join(p, 'CLAUDE.md'), '@AGENTS.md\n');
  fs.writeFileSync(path.join(p, 'AGENTS.md'), '# Rules\n- Never deploy on Fridays.\n');
  const r = compare(before, census(p));
  const where = r.lost.map((x) => x.where);
  for (let i = 5; i <= 16; i++) assert.ok(where.includes(`.claude/DESIGN-SYSTEM.md:${i}`), `DESIGN-SYSTEM.md:${i} is LOST: ${JSON.stringify(where)}`);
  assert.ok(where.includes('CLAUDE.md:3') && where.includes('CLAUDE.md:4'), JSON.stringify(where));
  assert.ok(!r.lost.some((x) => /Fridays/.test(x.text || '')), 'a rule moved to AGENTS.md is still a move');
  // naming the ranges in the plan accounts for them, as for any archive
  const ok = compare(before, census(p), '## Archived verbatim\n- `.claude/DESIGN-SYSTEM.md:4-16` → DESIGN-SYSTEM-ARCHIVE.md\n- `CLAUDE.md:1-4` → legacy copy\n');
  assert.deepEqual(ok.lost, [], JSON.stringify(ok.lost));
  // a copy under any other name is caught by its content: mostly the lines of one rewritten original
  const q = put(dir('Copy proj 2'), { 'docs/rules.md': `# Rules\n${locked}\n- Keep this one.\n` });
  const b2 = census(q);
  put(q, { 'docs/rules-before-onboarding.md': read(q, 'docs/rules.md') });
  fs.writeFileSync(path.join(q, 'docs/rules.md'), '# Rules\n- Keep this one.\n');
  assert.ok(compare(b2, census(q)).lost.filter((x) => x.type === 'line-archive-only').length >= 12);
});

test('stage: a disk without room for the copy is refused up front with the numbers, never an ENOSPC crash half-way (final round)', () => {
  const p = put(dir('Space proj'), { 'README.md': '# s\n', 'docs/a.md': 'x'.repeat(4096) });
  const to = stagingPath();
  const r = run(['stage', p, '--to', to], { CLOCKWORK_TEST_FREE_BYTES: '1000000' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ERR not enough disk space: staging needs about \d+\.\d GB .* 0\.0 GB free on the disk holding .*--to .*Nothing was copied/);
  assert.equal(fs.existsSync(to), false, 'no half-made staging folder');
  assert.equal(run(['stage', p, '--to', to], { CLOCKWORK_TEST_FREE_BYTES: String(10 * 1024 ** 3) }).code, 0, 'enough room: stages');
});

test('compare, sweep mode (D16): minting and appending through registry.mjs is not LOST; a deleted row or a counter going back still is', () => {
  const p = put(dir('Sweep proj'), {
    '.claude/clockwork.json': JSON.stringify({ clockworkVersion: '2.0.0', project: 'S', registryDir: '.claude', siteDir: '.', idPrefixes: { T: 'TASKS.md', C: 'CLIENT.md', CD: 'CLIENT.md' } }),
    '.claude/TASKS.md': '# TASKS\n**Last updated:** 2026-09-29\n> **ID counter — next free: `T-2`**\n\n## Open\n| ID | Task | Closes when | Deploy | Source | Status |\n|---|---|---|---|---|---|\n| T-1 | Add hello page | page loads | preview | none | ⬜ OPEN |\n',
    '.claude/CLIENT.md': '# CLIENT\n**Last updated:** 2026-09-29\n> **ID counter — next free: `C-1`**\n> **ID counter — next free: `CD-1`**\n\n## Client asks\n| ID | Ask | Status |\n|---|---|---|\n\n## Confirmed Decisions\n| ID | Decision | Status |\n|---|---|---|\n',
  });
  const before = census(p);
  const reg = (...a) => { const r = spawnSync(process.execPath, [REGISTRY, ...a], { env: Object.assign({}, ENV, { CLOCKWORK_ROOT: p }), encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr); };
  reg('mint', 'CD', '--title', 'Orange logo stays', '--status', '✅ VERIFIED', '--opened', 'none');
  reg('mint', 'T', '--title', 'Swept task', '--cells', 'closes when x|preview|notes.md:3');
  reg('append', 'T-1', '--text', 'swept from notes.md:4');
  const r = compare(before, census(p));
  assert.deepEqual(r.lost, [], JSON.stringify(r.lost));
  fs.writeFileSync(path.join(p, '.claude/TASKS.md'), read(p, '.claude/TASKS.md').replace(/^\| T-1 .*\n/m, '').replace('next free: `T-3`', 'next free: `T-1`'));
  const bad = compare(before, census(p));
  assert.ok(bad.lost.some((x) => x.type === 'id-row' && x.id === 'T-1'), JSON.stringify(bad.lost));
  assert.ok(bad.lost.some((x) => x.type === 'counter' && x.id === 'T'), JSON.stringify(bad.lost));
});

test('compare CLI: exits 1 on archive-only lines and prints the headline and both new sections', () => {
  const { p, before, after: afterC } = probe();
  const b = path.join(p, 'before.json'), a = path.join(p, 'after.json');
  fs.writeFileSync(b, JSON.stringify(before)); fs.writeFileSync(a, JSON.stringify(afterC));
  const r = run(['compare', b, a]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ONLY IN THE ONBOARDING ARCHIVE: \d+ line\(s\)/);
  assert.match(r.out, /NOT LIVE ANY MORE[^\n]*\(1\):\n\s+T-2 had a live row/);
  assert.match(r.out, /ONLY IN THE ARCHIVE, NOT NAMED BY THE PLAN[^\n]*\(2\):\n(?:\s+[^\n]+\n)*?\s+CLAUDE\.md:2 → [^\n]*Prices are always shown incl\. VAT/);
});

// ── migrate ─────────────────────────────────────────────────────────────────
function migrateProject() {
  const p = put(dir('Migrate proj'), {
    '.gitignore': '.claude/\n',
    'README.md': '# m\n',
    '.claude/clockwork.json': JSON.stringify({ clockworkVersion: '2.0.0', project: 'M', registryDir: '.claude', siteDir: '.' }, null, 2),
    '.claude/CLIENT.md': '# CLIENT\n**Last updated:** 2026-09-29\n> **Next free: C-5**\n\n## Client asks\n| ID | Ask | Status |\n|---|---|---|\n| C-4 | send logo | ⬜ OPEN |\n\n## ✅ Confirmed Decisions\n| Decision | Confirmed by | Date |\n|---|---|---|\n| Orange logo | Anna | 2026-08-01 |\n',
    '.claude/TASKS.md': '# TASKS\n> **Next free: T-10**\n\n## Open\n| ID | Task | Status |\n|---|---|---|\n| T-1 | Same title | ⬜ OPEN |\n| T-1 | Same title | ⬜ OPEN |\n| T-2 | Real task | ⬜ OPEN |\n| T-2 | ↩️ restored to live — see its row above |\n| T-3 (reopened) | CSP re-harden | ⬜ OPEN |\n| T-3 (again) | Preview-deploy CSP smoke test | 🔧 BUILT |\n| T-4 | Fix VAT | ✅ VERIFIED |\n| T-4 | Fix VAT | ⬜ OPEN (reopened) |\n',
    '.claude/TASKS-ARCHIVE.md': '# TASKS archive\n\n## Archived\n| ID | Task | Status |\n|---|---|---|\n| T-2 | Real task (old copy) | ✅ VERIFIED |\n',
    '.claude/OPEN-ASKS.md': '# OPEN-ASKS\n> **ID counter — next free: `A-1`**\n\n## Open questions\n| ID | Ask | Status |\n|---|---|---|\n',
  });
  repo(p);
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  return { p, to };
}
test('migrate: same-title duplicates VOID, different items marked as collisions, pointer rows and live+archive pairs asked', () => {
  const { to } = migrateProject();
  const before = census(to);
  const r = run(['migrate', to, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const t = read(to, '.claude/TASKS.md');
  assert.match(t, /\| T-1 \| Same title \| ✖ VOID — duplicate of T-1, see TASKS\.md:7 · ⬜ OPEN \|/, 'a true duplicate is voided');
  // The kit's one row rule (registry.mjs + doctor): a first cell "T-3 (…)" is not a row of T-3, so nothing is marked.
  assert.match(t, /\| T-3 \(reopened\) \| CSP re-harden \| ⬜ OPEN \|\n\| T-3 \(again\) \| Preview-deploy CSP smoke test \| 🔧 BUILT \|/);
  assert.match(t, /\| T-2 \| ↩️ restored to live — see its row above \|/, 'a pointer row is left as it is');
  assert.match(t, /\| T-4 \| Fix VAT ⚠ ID collision with TASKS\.md:\d+: needs a new ID \(plan question\) \| ⬜ OPEN \(reopened\) \|/, 'same title, other status: an open item is never voided');
  assert.doesNotMatch(t, /T-4[^\n]*VOID/);
  const qs = r.json.questions.join('\n');
  assert.doesNotMatch(qs, /T-2 has 2 rows/, 'a pointer row is not a second row (kit row rule)');
  assert.doesNotMatch(qs, /T-3 has 2 rows/);
  assert.match(qs, /T-2 has a full row here \(line \d+\) and in the archive \(\.claude\/TASKS-ARCHIVE\.md:6\)/);
  assert.match(qs, /T-4 has 2 rows[^\n]*counted by registry\.mjs check \+ doctor[^\n]*maybe reopened/);
  // sections: OPEN-ASKS has no "## Open"; the default names the nearest heading instead of a placeholder
  assert.deepEqual(r.json.sectionDefaults.find((d) => d.file === '.claude/OPEN-ASKS.md'), { file: '.claude/OPEN-ASKS.md', want: '## Open', use: '## Open questions' });
  assert.ok(JSON.parse(read(to, '.clockwork-onboard/migrate-latest.json')).sectionDefaults.length >= 1);
  // nothing lost across the whole migrate
  const cmp = compare(before, census(to));
  assert.deepEqual(cmp.lost, [], JSON.stringify(cmp.lost.slice(0, 3)));
});

test('migrate: a v1 CLIENT.md with Confirmed Decisions but no CD rows gets a CD counter and an ID table registry.mjs can mint into', () => {
  const { to } = migrateProject();
  assert.equal(run(['migrate', to]).code, 0);
  const c = read(to, '.claude/CLIENT.md');
  assert.match(c, /> \*\*ID counter — next free: `CD-1`\*\*/);
  assert.match(c, /\n## Confirmed Decisions\n\| Decision \| Confirmed by \| Date \|\n\|---\|---\|---\|\n\| Orange logo \| Anna \| 2026-08-01 \|\n\nDecisions with IDs[^\n]*\n\n\| ID \| Decision \| Date · who \| Source \| Status \|\n\|---\|---\|---\|---\|---\|/, c);
  const m = spawnSync(process.execPath, [REGISTRY, 'mint', 'CD', '--title', 'Orange logo stays', '--cells', '2026-08-01 · Anna|brief.md:4', '--status', '✅ VERIFIED', '--opened', 'none'], { env: { ...ENV, CLOCKWORK_ROOT: to }, encoding: 'utf8' });
  assert.match(m.stdout, /OK CD-1\s*$/, m.stdout + m.stderr);
  assert.match(read(to, '.claude/CLIENT.md'), /\| CD-1 \| Orange logo stays \| 2026-08-01 · Anna \| brief\.md:4 \| ✅ VERIFIED \|/);
});

test('migrate: .claude/ ignored in git → the Clockwork files (not the registries) go into .worktreeinclude', () => {
  const { to } = migrateProject();
  put(to, { '.worktreeinclude': '.env\n.env.*\n' });
  assert.equal(run(['migrate', to]).code, 0);
  const w = read(to, '.worktreeinclude');
  for (const l of ['.env', '.claude/rules/**', '.claude/hooks/**', '.claude/tools/**', '.claude/settings.json', '.claude/clockwork.json']) assert.ok(w.split('\n').includes(l), `${l} in .worktreeinclude`);
  assert.ok(!/TASKS|CLIENT/.test(w), 'registries stay in the main copy');
  assert.equal(run(['migrate', to]).code, 0);
  assert.equal(read(to, '.worktreeinclude'), w, 'idempotent');
});

// ── apply ───────────────────────────────────────────────────────────────────
test('apply: a failure half-way leaves a marker, restore commands and a way to finish with --resume', () => {
  const p = put(dir('Half proj'), { 'CLAUDE.md': '# Rules\n', 'docs/a.md': 'old a\n' });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  put(to, { 'AGENTS.md': '# Agents\n', 'CLAUDE.md': '@AGENTS.md\n', 'docs/a.md': 'new a\n' });
  approve(to);
  fs.chmodSync(path.join(p, 'docs'), 0o555);
  const r = run(['apply', to, p, '--yes']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.last, /^ERR apply stopped after writing 2 of 3 file\(s\).*HALF-APPLIED.*--resume.*RESTORE\.txt/);
  const bb = path.join(p, '.claude', '.clockwork-backups'); const bdir = path.join(bb, fs.readdirSync(bb)[0]);
  assert.ok(fs.existsSync(path.join(bdir, 'APPLYING.json')));
  const restore = read(bdir, 'RESTORE.txt');
  assert.match(restore, /cp -p "\.claude\/\.clockwork-backups\/[^"]+\/CLAUDE\.md" "CLAUDE\.md"/);
  assert.match(restore, /rm -f "AGENTS\.md"/);
  const again = run(['apply', to, p, '--yes']);
  assert.equal(again.code, 1); assert.match(again.last, /stopped half-way \(backup \.claude\/\.clockwork-backups\/[^)]+\)\. Finish it: the same command with --resume\. Or undo it: .*RESTORE\.txt/, 'a plain re-run never starts a second, split backup');
  assert.equal(fs.readdirSync(bb).length, 1, 'no second backup folder');
  fs.chmodSync(path.join(p, 'docs'), 0o755);
  const res = run(['apply', to, p, '--yes', '--resume']);
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(read(p, 'docs/a.md'), 'new a\n');
  assert.ok(!fs.existsSync(path.join(bdir, 'APPLYING.json')), 'marker removed when every write is done');
  assert.match(read(bdir, 'SHA256SUMS'), /  docs\/a\.md\n/);
  assert.equal(read(bdir, 'docs/a.md'), 'old a\n', 'the backup is the pre-apply file');
  assert.equal(run(['apply', to, p, '--yes', '--resume']).code, 1, 'nothing left to resume');
});

test('apply: refuses a linked git worktree and names the main checkout', () => {
  const main = repo(put(dir('Main co'), { 'README.md': '# m\n' }));
  const wt = path.join(TMP, `Linked wt ${++n}`);
  git(main, 'worktree', 'add', '-q', '-b', 'feature/x', wt);
  const to = stagingPath();
  assert.equal(run(['stage', wt, '--to', to]).code, 0);
  put(to, { 'AGENTS.md': '# a\n' }); approve(to);
  const r = run(['apply', to, wt, '--yes']);
  assert.equal(r.code, 1, r.out); assert.match(r.last, /linked git worktree of .*Onboard the main checkout/);
  assert.ok(!fs.existsSync(path.join(wt, 'AGENTS.md')));
});

test('apply: every doctor ERROR line is shown and the full report is kept with the backup', () => {
  const p = put(dir('Doc proj'), { 'CLAUDE.md': '# Rules\n' });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  fs.mkdirSync(path.join(to, '.claude', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(KIT, 'templates', 'claude', 'hooks', 'clockwork-doctor.mjs'), path.join(to, '.claude', 'hooks', 'clockwork-doctor.mjs'));
  fs.mkdirSync(path.join(to, '.claude', 'tools'), { recursive: true }); // the doctor reads rows with registry.mjs, installed next to it
  fs.copyFileSync(path.join(KIT, 'templates', 'claude', 'tools', 'registry.mjs'), path.join(to, '.claude', 'tools', 'registry.mjs'));
  fs.copyFileSync(path.join(KIT, 'templates', 'clockwork.json'), path.join(to, '.claude', 'clockwork.json'));
  put(to, { '.claude/TASKS.md': '# TASKS\n**Last updated:** 2026-09-30\n> **ID counter — next free: `T-9`**\n\n## Open\n| ID | Task | Status |\n|---|---|---|\n| T-5 | one | ⬜ OPEN |\n| T-5 | two | ⬜ OPEN |\n' });
  approve(to);
  const r = run(['apply', to, p, '--yes', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.doctor.exit, 1, r.json.doctor.tail);
  assert.match(r.json.doctor.errors[0], /^ERRORS \(\d+\)/);
  assert.ok(r.json.doctor.errors.some((l) => /T-5/.test(l)), r.json.doctor.errors.join('\n'));
  assert.ok(fs.existsSync(path.join(p, r.json.doctor.full)));
});

// ── sources ─────────────────────────────────────────────────────────────────
test('discover and census count a .docx/.pdf in docs/ or at the root; removing one is LOST (final round)', () => {
  const p = put(dir('Bin proj'), { 'docs/decisions.md': '# Decisions\n- a\n', 'README.md': '# r\n', 'docs/meeting-2026-09-10.docx': 'PK\u0003\u0004 fake docx\n', 'spec.pdf': '%PDF-1.4 fake\n', 'public/brochure.pdf': '%PDF-1.4 asset\n' });
  const d = run(['discover', p, '--json']);
  const paths = d.json.docs.map((x) => x.path);
  assert.ok(paths.includes('docs/meeting-2026-09-10.docx') && paths.includes('spec.pdf'), JSON.stringify(paths));
  assert.ok(!paths.includes('public/brochure.pdf'), 'a site asset is not a project document');
  const before = census(p);
  assert.ok(before.files['docs/meeting-2026-09-10.docx']?.binary);
  fs.rmSync(path.join(p, 'docs/meeting-2026-09-10.docx'));
  assert.ok(compare(before, census(p)).lost.some((x) => x.type === 'file' && x.where === 'docs/meeting-2026-09-10.docx'));
});

test('sources: the kit\'s optional stack pointer ("`.claude/rules/stack-other.md` if shipped") is not a missing path; any other missing path is (final round)', () => {
  const p = put(dir('Stack other proj'), { 'README.md': '# s\n' });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  put(to, { 'AGENTS.md': '# A\n| Code rules, stack traps | `.claude/rules/engineering.md` · `.claude/rules/stack-other.md` if shipped |\nFacts: `.claude/FACTS.md`\n', '.claude/rules/engineering.md': '# e\n' });
  const j = run(['sources', to, '--json']).json;
  assert.ok(!j.missingPaths.some((x) => /stack-other/.test(x)), j.missingPaths.join('\n'));
  assert.ok(j.missingPaths.some((x) => /FACTS\.md/.test(x)), 'a real missing path is still reported');
});

test('sources: a quote from a .docx is checked against its converted text, never the raw binary (final round)', () => {
  const p = put(dir('Docx proj'), { 'README.md': '# d\n', 'docs/meeting-2026-09-10.docx': 'PK\u0003\u0004 binary word/document.xml \u0000\u0001\n' });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  const rep = '.claude/reports/onboarding-2026-09-30';
  put(to, { [`${rep}/sweep-manifest.md`]: '# Sweep manifest\nk1 · docs/meeting-2026-09-10.docx:3 · TASKS.md · T-5 · "Action: Jan sends the new logo by Friday."\nk2 · meeting-2026-09-10.docx:2 · CLIENT.md · C-3 · "Client (Jan) says the site must be in Dutch and English."\n' });
  const before = run(['sources', to, '--json']);
  assert.match([...before.json.failures, ...before.json.noCite].join('\n'), /docx:3.*not in the before copy/, 'no converted text yet: said plainly, not a quote mismatch against binary');
  put(to, { '.clockwork-onboard/converted/docs/meeting-2026-09-10.docx.txt': 'Meeting 10 Sep\nClient (Jan) says the site must be in Dutch and English.\nAction: Jan sends the new logo by Friday.\n' });
  const r = run(['sources', to, '--json']);
  const probs = [...r.json.failures, ...r.json.noCite].join('\n');
  assert.doesNotMatch(probs, /docx/, probs);
  assert.ok(r.json.failures.length === 0, probs);
});

test('sources: every Source cell must resolve to a real line of the before-copy; manifest quotes must be in their source', () => {
  const p = put(dir('Src proj'), {
    '.claude/DESIGN-SYSTEM.md': '# Design\nPrimary colour is #E4572E.\nBody font Inter.\n',
    'Design System/guide.md': 'Headings use Outfit.\n',
    'notes/call.md': '# Call\nWe will fix the VAT rounding before launch.\n',
    'docs/auth.md': 'See CLAUDE.md -> Branch Rules - HARD RULE\n',
    'CLAUDE.md': '# Rules\n## Branch Rules\n- never push main\n',
  });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  const rep = '.claude/reports/onboarding-2026-09-30';
  put(to, {
    [`${rep}/originals/CLAUDE.md`]: read(p, 'CLAUDE.md'),
    'CLAUDE.md': '@AGENTS.md\n',
    'AGENTS.md': '# Agents\nFacts: `.claude/FACTS.md` · design: `.claude/rules/design-system.md`\n',
    '.claude/rules/design-system.md': '# Design system\n| Token | Value | Source |\n|---|---|---|\n| primary | #E4572E | .claude/DESIGN-SYSTEM.md:2 |\n| body | Inter | DESIGN-SYSTEM.md:3 |\n| heading | Outfit | Design System/guide.md:1 |\n| bad-line | x | .claude/DESIGN-SYSTEM.md:99 |\n| no-file | x | NOPE.md:1 |\n| no-cite | x | DS §Hard rules; L80 |\n| {{token}} | {{value}} | {{source}} |\n',
    [`${rep}/sweep-manifest.md`]: '# Sweep manifest\nk1 · notes/call.md:2 · TASKS.md · T-5 · "We will fix the VAT rounding before launch."\nk2 · notes/call.md:2 · TASKS.md · T-6 · "We will never fix anything at all."\n',
  });
  const r = run(['sources', to, '--json']);
  assert.equal(r.code, 1, r.out);
  const j = r.json;
  const probs = [...j.failures, ...j.noCite, ...j.missingPaths].join('\n');
  assert.match(probs, /design-system\.md:7: cites \.claude\/DESIGN-SYSTEM\.md:99, but [^\n]* has 3 lines/);
  assert.match(probs, /design-system\.md:8: cites NOPE\.md:1, but that file is not/);
  assert.match(probs, /design-system\.md:9: Source "DS §Hard rules; L80" names no file:line/);
  assert.match(probs, /sweep-manifest\.md:3: quote "We will never fix/);
  assert.match(probs, /AGENTS\.md:2 points at `\.claude\/FACTS\.md`, which does not exist/);
  assert.doesNotMatch(probs, /design-system\.md:(4|5|6|10)/, 'good rows, a basename-only citation, a path with spaces and a placeholder row pass');
  assert.ok(j.pointers.some((x) => /^docs\/auth\.md:1 mentions CLAUDE\.md/.test(x)), 'an old document pointing at a rewritten file is listed');
  const pairs = read(to, '.clockwork-onboard/sources-pairs.md');
  assert.match(pairs, /### \.claude\/rules\/design-system\.md:4 → \.clockwork-onboard\/pristine\/\.claude\/DESIGN-SYSTEM\.md:2\n```text\n\| primary[^\n]*\n```\n```text\nPrimary colour is #E4572E\./);
  // fixed → clean
  put(to, { '.claude/rules/design-system.md': '# Design system\n| Token | Value | Source |\n|---|---|---|\n| primary | #E4572E | .claude/DESIGN-SYSTEM.md:2 |\n', [`${rep}/sweep-manifest.md`]: '# Sweep manifest\nk1 · notes/call.md:2 · TASKS.md · T-5 · "We will fix the VAT rounding before launch."\n', 'AGENTS.md': '# Agents\n' });
  const ok = run(['sources', to]);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.last, /^OK sources: 2 citation\(s\) resolve/);
});

// ── rebase ──────────────────────────────────────────────────────────────────
test('rebase: takes in what changed in the project since stage (re-copy, migrated merge, new files) and then apply passes', () => {
  const tasks = '# TASKS\n> **Next free: T-3**\n\n## Open\n| ID | Task | Status |\n|---|---|---|\n| T-1 | one | ⬜ OPEN |\n| T-2 | two | ⬜ OPEN |\n';
  const p = put(dir('Rebase proj'), { '.claude/TASKS.md': tasks, 'README.md': '# r\n', 'notes.md': 'line one\nline two\n' });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  assert.equal(run(['census', to, '--out', path.join(to, '.clockwork-onboard', 'census-before.json')]).code, 0);
  assert.equal(run(['migrate', to]).code, 0);
  put(to, { 'AGENTS.md': '# a\n' });
  // a live session works in the real project meanwhile
  fs.writeFileSync(path.join(p, 'README.md'), '# r — updated by a live session\n');
  fs.writeFileSync(path.join(p, '.claude/TASKS.md'), tasks.replace('Next free: T-3', 'Next free: T-4') + '| T-3 | three, minted live | ⬜ OPEN |\n');
  put(p, { 'PM/new note.md': '# new\n' });
  approve(to);
  assert.match(run(['apply', to, p, '--yes']).last, /changed since staging.*rebase/);
  const realBefore = treeHash(p);
  const r = run(['rebase', to, p, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual([r.json.recopied, r.json.merged, r.json.added], [1, 1, 1], JSON.stringify(r.json));
  assert.equal(treeHash(p), realBefore, 'rebase never writes to the real project');
  assert.equal(read(to, 'README.md'), '# r — updated by a live session\n');
  const t = read(to, '.claude/TASKS.md');
  assert.match(t, /> \*\*ID counter — next free: `T-4`\*\*/, t);
  assert.match(t, /\| T-3 \| three, minted live \| ⬜ OPEN \|/);
  assert.equal(read(to, 'PM/new note.md'), '# new\n');
  assert.equal(read(path.join(to, '.clockwork-onboard', 'pristine'), '.claude/TASKS.md'), read(p, '.claude/TASKS.md'), 'the before-copy moves with the project');
  const cb = JSON.parse(read(to, '.clockwork-onboard/census-before.json'));
  assert.ok(cb.ids['T-3'], 'census-before rebuilt from the updated before-copy');
  const a = run(['apply', to, p, '--yes']);
  assert.equal(a.code, 0, a.out + a.err);
  assert.match(read(p, '.claude/TASKS.md'), /\| T-3 \| three, minted live/);
});

test('rebase: a clash on both sides writes nothing and names the file', () => {
  const p = put(dir('Clash proj'), { 'notes.md': 'line one\nline two\n', 'README.md': '# c\n' });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  fs.writeFileSync(path.join(to, 'notes.md'), 'line one — staging\nline two\n');
  fs.writeFileSync(path.join(p, 'notes.md'), 'line one — project\nline two\n');
  fs.writeFileSync(path.join(p, 'README.md'), '# c2\n');
  const snap = treeHash(to);
  const r = run(['rebase', to, p]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /CONFLICT notes\.md: changed in the project AND in staging/);
  assert.equal(treeHash(to), snap, 'nothing written when anything clashes');
  assert.match(r.last, /--taken/);
  // The session merges the project's change in by hand (here: into another file, as a condense would), then --taken.
  fs.writeFileSync(path.join(to, 'AGENTS.md'), '# Agents\n- line one — project\n');
  const t = run(['rebase', to, p, '--taken', 'notes.md', '--json']);
  assert.equal(t.code, 0, t.out);
  assert.equal(t.json.taken, 1);
  assert.equal(read(to, 'notes.md'), 'line one — staging\nline two\n', 'staging keeps its version');
  assert.equal(read(to, '.clockwork-onboard/pristine/notes.md'), 'line one — project\nline two\n', 'the before-copy moves to the project version');
  assert.equal(read(to, 'README.md'), '# c2\n', 'the rest of the rebase went through');
  // compare against the rebuilt census-before proves the project's new line landed live
  const cmp = compare(JSON.parse(read(to, '.clockwork-onboard/census-before.json')), census(to));
  assert.ok(!cmp.lost.some((x) => /line one — project/.test(x.text || '')), JSON.stringify(cmp.lost));
  approve(to);
  assert.equal(run(['apply', to, p, '--yes']).code, 0, 'apply accepts the rebased staging');
  assert.equal(run(['rebase', to, p, '--taken', 'nope.md']).code, 1, '--taken names only staged files');
});

// ── discover ────────────────────────────────────────────────────────────────
test('discover: warns about recent changes, registries in two folders and a root that is not a git repo', () => {
  const p = put(dir('Warn proj'), { '.claude/TASKS.md': '# TASKS\n> **ID counter — next free: `T-1`**\n\n## Open\n', 'PM/approvals/APPROVAL-QUEUE.md': '# Q\n> **ID counter — next free: `Q-1`**\n\n## Queue\n', 'site/package.json': '{}' });
  repo(path.join(p, 'site'));
  const r = run(['discover', p, '--json']);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.json.recentChanges.lastHour >= 3);
  assert.deepEqual(r.json.registryFolders.map((x) => x.dir).sort(), ['.claude', 'PM/approvals']);
  assert.deepEqual(r.json.rootNotGit, { subRepos: ['site'] });
  const w = r.json.warnings.join('\n');
  assert.match(w, /changed in the last hour/); assert.match(w, /registries sit in 2 folders/); assert.match(w, /root is not a git repository; code is in site/);
  assert.match(run(['discover', p]).out, /^! registries sit in 2 folders/m);
});

// ── round 4 (2026-09-30): submodules, more secret names, kit rows in sources, re-apply, v2 sweep mode ─────────
test('stage: a submodule in staging cannot push, carries no token, runs no hooks, and an absolute pointer stays inside staging', () => {
  const remote = path.join(TMP, `sub remote ${++n}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: ENV });
  const src = repo(put(dir('Sub src'), { 'lib.md': '# lib\n' }));
  git(src, 'push', '-q', remote, 'main');
  const p = repo(put(dir('Sub proj'), { 'README.md': '# p\n' }));
  git(p, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', remote, 'lib');
  git(p, 'commit', '-qm', 'sub');
  const mcfg = path.join(p, '.git', 'modules', 'lib', 'config');
  execFileSync('git', ['config', '-f', mcfg, 'remote.origin.url', 'https://dev:ghp_SUBTOKEN77@github.com/x/lib.git'], { env: ENV });
  execFileSync('git', ['config', '-f', mcfg, '--add', 'remote.origin.pushurl', remote], { env: ENV });
  fs.writeFileSync(path.join(p, 'lib', '.git'), `gitdir: ${path.join(p, '.git', 'modules', 'lib')}\n`); // old-style absolute pointer
  const to = stagingPath();
  const r = run(['stage', p, '--to', to, '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.git.find((g) => g.repo === '.').submodulesSealed, 1);
  assert.ok(!path.isAbsolute(/^gitdir:\s*(.+)$/m.exec(read(to, 'lib/.git'))[1]), 'the pointer is relative, inside staging');
  assert.equal(fs.realpathSync(git(path.join(to, 'lib'), 'rev-parse', '--absolute-git-dir')), fs.realpathSync(path.join(to, '.git', 'modules', 'lib')));
  assert.deepEqual(git(path.join(to, 'lib'), 'remote', 'get-url', '--push', '--all', 'origin').split('\n'), ['no-push://clockwork-onboard-staging-copy']);
  assert.ok(!read(to, '.git/modules/lib/config').includes('SUBTOKEN77'), 'the token is gone from the submodule config');
  fs.writeFileSync(path.join(to, '.git', 'modules', 'lib', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch "${path.join(TMP, 'hook-ran')}"\n`, { mode: 0o755 });
  git(path.join(to, 'lib'), 'commit', '-q', '--allow-empty', '-m', 'probe');
  assert.ok(!fs.existsSync(path.join(TMP, 'hook-ran')), 'project hooks do not run in staging');
  assert.notEqual(gitTry(path.join(to, 'lib'), 'push', 'origin', 'HEAD:refs/heads/leak').status, 0);
  assert.notEqual(gitTry(path.join(to, 'lib'), 'push', remote, 'HEAD:refs/heads/leak2').status, 0);
  assert.equal(git(remote, 'branch', '--list', 'leak*'), '', 'the real remote received nothing');
  assert.match(execFileSync('git', ['config', '-f', mcfg, 'remote.origin.url'], { env: ENV, encoding: 'utf8' }), /SUBTOKEN77/, 'the real submodule config is untouched');
});

test('SECRET: credential files by their common names are never staged; docs and design tokens are', () => {
  for (const s of ['credentials-prod.json', 'gcp-credentials.json', 'config/aws-credentials.yml', 'client_secret_1234.apps.googleusercontent.com.json', 'service_account.json', 'keys/serviceAccount-prod.json', 'deploy_key', 'deploy-key.pub', '.env.production.local', 'id_ed25519', 'server.key', 'cert.pem', '.npmrc', '.netrc'])
    assert.ok(SECRET(s), `${s} is a secret`);
  for (const d of ['.env.example', '.env.local.sample', 'config/.env.template', 'tokens.json', 'design/tokens.css', 'docs/credentials-howto.md', 'README.md', 'theme.json'])
    assert.equal(SECRET(d), null, `${d} is not a secret`);
});

test('SECRET, final round: MCP configs, local settings, saved tokens, key JSON, rclone and framework config files are never staged', () => {
  for (const s of ['.mcp.json', 'projects/ads/.mcp.json', '.claude/settings.local.json', 'token.json', 'token.pickle', 'google-oauth-token.json', 'sa-key.json', 'gcloud-key.json',
    'rclone.conf', 'api_keys.txt', 'appsettings.Production.json', 'app/config/parameters.yml', 'wp-config-local.php', 'local-config.php', 'env.local'])
    assert.ok(SECRET(s), `${s} is a secret`);
  for (const d of ['tokens.json', 'design-tokens.json', '.claude/settings.json', 'docs/api-keys.md', 'wp-config-sample.php', 'env.ts', 'next-env.d.ts', 'keyboard.json'])
    assert.equal(SECRET(d), null, `${d} is not a secret`);
});

test('sources: the kit\'s own rows and unfilled rows are not source problems; a row onboarding wrote still needs file:line', () => {
  const p = put(dir('Kit rows proj'), { 'tokens.css': ':root { --space-s: 8px; }\n', 'README.md': '# k\n' });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  const inst = spawnSync(process.execPath, [path.join(KIT, 'install.mjs'), to, '--stack', 'nextjs', '--project', 'K', '--apply'], { env: ENV, encoding: 'utf8' });
  assert.match(inst.stdout.trim().split('\n').pop(), /^OK/, inst.stdout + inst.stderr);
  const clean = run(['sources', to, '--json']);
  assert.equal(clean.code, 0, `an untouched kit install has no source problems:\n${clean.out}`);
  assert.ok(clean.json.unfilled.length > 0, 'unfilled {{…}} rows are listed');
  assert.match(clean.last, /unfilled row\(s\)/);
  const ds = path.join(to, '.claude', 'rules', 'design-system.md');
  const text = fs.readFileSync(ds, 'utf8');
  const kitRow = text.split('\n').find((l) => /^\| TY-2 /.test(l));
  fs.writeFileSync(ds, text.replace(kitRow, kitRow.replace('16px', '17px')) + '\n## Project\n| Rule | Value / token | How to measure | Source |\n|---|---|---|---|\n| PX-1 Small gap | 8px | styles() | tokens.css:1 |\n| PX-2 Written by onboarding, no source | 4px | styles() | P1 §8 |\n| MO-9 Hover timing | | forced :hover | decide per project |\n');
  const r = run(['sources', to, '--json']);
  assert.equal(r.code, 1, r.out);
  const probs = [...r.json.failures, ...r.json.noCite].join('\n');
  assert.match(probs, /TY-2/, 'a kit row onboarding changed must cite its project source');
  assert.match(probs, /PX-2/);
  assert.doesNotMatch(probs, /PX-1|MO-9/);
  assert.ok(r.json.unfilled.some((x) => /MO-9/.test(x)), 'an empty "decide per project" value is unfilled, not a problem');
});

test('compare --plan with a missing plan refuses cleanly (exit 1), never a stack trace', () => {
  const c = path.join(TMP, `census ${++n}.json`);
  fs.writeFileSync(c, JSON.stringify(census(put(dir('Plan-less'), { 'README.md': '# x\n' }))));
  const r = run(['compare', c, c, '--plan', path.join(TMP, 'no such plan.md')]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.last, /^ERR plan not found: /);
  assert.equal(r.err, '');
});

test('stage: a re-stage in the same minute gets a -2 folder instead of a refusal', () => {
  const p = put(dir('Same minute'), { 'README.md': '# s\n' });
  const env = { CLOCKWORK_ONBOARD_NOW: '2026-09-30T12:00:00' };
  const a = run(['stage', p, '--json'], env), b = run(['stage', p, '--json'], env);
  assert.equal(a.code, 0, a.out); assert.equal(b.code, 0, b.out);
  assert.equal(b.json.staging, `${a.json.staging}-2`);
});

test('discover: a project already on Clockwork 2 is onboarded in sweep mode (D16), not sent away', () => {
  const p = put(dir('Already v2'), { 'README.md': '# v2\n', 'notes/call.md': '# Call\n- ship Friday\n' });
  const inst = spawnSync(process.execPath, [path.join(KIT, 'install.mjs'), p, '--stack', 'other', '--project', 'V2', '--apply'], { env: ENV, encoding: 'utf8' });
  assert.match(inst.stdout.trim().split('\n').pop(), /^OK/, inst.stdout + inst.stderr);
  const r = run(['discover', p, '--json']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.json.mode, 'sweep');
  assert.ok(r.json.caseReasons.some((x) => /sweep mode/.test(x)));
  assert.ok(!r.json.caseReasons.some((x) => /v1 doctor|upgrade with install/.test(x)), r.json.caseReasons.join('\n'));
  assert.match(r.last, /sweep mode/);
  assert.equal(run(['discover', put(dir('Not v2'), { 'README.md': '# a real readme with enough words to count as documentation, more than three hundred bytes of text so that it is not treated as boilerplate at all; it describes the project, its goals, its owners and how to run it locally for development and review.\n' }), '--json']).json.mode, 'full');
});

test('sources: a manifest quote of a table row (pipes escaped as \\|) matches its source', () => {
  const p = put(dir('Pipe proj'), { 'FINDINGS.md': '# F\n| BDR Sales Agent | pending | AI Sales Researcher |\n' });
  const to = stagingPath();
  assert.equal(run(['stage', p, '--to', to]).code, 0);
  put(to, { '.claude/reports/onboarding-2026-09-30/sweep-manifest.md': '# Sweep manifest\nk1 · FINDINGS.md:2 · TASKS.md · T-1 · "\\| BDR Sales Agent \\| pending \\| AI Sales Researcher \\|"\nk2 · FINDINGS.md:2 · TASKS.md · T-2 · "\\| BDR Sales Agent \\| done \\|"\n' });
  const r = run(['sources', to, '--json']);
  const probs = r.json.failures.join('\n');
  assert.doesNotMatch(probs, /sweep-manifest\.md:2:/, probs);
  assert.match(probs, /sweep-manifest\.md:3: quote/, 'a quote that is not in the source still fails');
});
