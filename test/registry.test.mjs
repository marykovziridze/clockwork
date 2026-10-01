// Tests for templates/claude/tools/registry.mjs (CONTRACT §3, §5, §6). Offline; fixtures in os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPrivate, PRIVATE_FILE } from './private.mjs';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'claude', 'tools', 'registry.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cw registry test '));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of ['CLOCKWORK_ROOT', 'CLOCKWORK_REGISTRY_FAULT', 'CLOCKWORK_LOCK_TIMEOUT_MS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[k];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let n = 0;

function project({ counter = 'T-3', rows = null, config = {}, archive = null, extraHeader = '' } = {}) {
  const root = path.join(TMP, `Client Project ${++n}`, 'La Test');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), JSON.stringify({ clockworkVersion: '2.0.0', project: 'Test', registryDir: '.claude', siteDir: '.', ...config }, null, 2));
  const body = rows ?? ['| T-1 | first | ✅ VERIFIED · opened 2026-09-01 |', '| T-2 | second | ⬜ OPEN |'];
  fs.writeFileSync(path.join(root, '.claude', 'TASKS.md'),
    `# TASKS\nWhat to build next.\n**Last updated:** 2026-09-01\n> **ID counter — next free: \`${counter}\`**\n${extraHeader}\n## Open\n\n| ID | Task | Status |\n|---|---|---|\n${body.join('\n')}\n\n## Notes\nfree text\n`);
  if (archive !== null) fs.writeFileSync(path.join(root, '.claude', 'TASKS-ARCHIVE.md'), archive);
  return root;
}
const tasks = (root) => path.join(root, '.claude', 'TASKS.md');
function run(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, env: { ...ENV, ...env }, encoding: 'utf8' });
  const lines = r.stdout.trim().split('\n');
  return { code: r.status, out: r.stdout, err: r.stderr, last: lines[lines.length - 1] };
}
function runAsync(cwd, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [TOOL, ...args], { cwd, env: ENV });
    let out = ''; c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out, last: out.trim().split('\n').pop() }));
  });
}
const rowIds = (text) => [...text.matchAll(/^\|\s*(T-\d+)\s*\|/gm)].map((m) => m[1]);

test('mint, next, append, status: one write each, counter bumped, row verified', () => {
  const root = project();
  assert.equal(run(root, ['next', 'T']).last, 'OK T-3');
  const m = run(root, ['mint', 'T', '--title', 'third | with pipe']);
  assert.equal(m.code, 0, m.out); assert.equal(m.last, 'OK T-3');
  let t = fs.readFileSync(tasks(root), 'utf8');
  assert.match(t, /next free: `T-4`/);
  assert.match(t, /^\| T-3 \| third \\\| with pipe \| ⬜ OPEN · opened \d{4}-\d{2}-\d{2} \|$/m);
  assert.ok(t.indexOf('| T-3 |') < t.indexOf('## Notes'), 'row lands at the end of the ## Open table');
  assert.equal(run(root, ['append', 'T-2', '--text', 'evidence a']).last, 'OK T-2');
  assert.equal(run(root, ['status', 'T-2', '🔧 BUILT']).last, 'OK T-2');
  t = fs.readFileSync(tasks(root), 'utf8');
  assert.match(t, /^\| T-2 \| second \| 🔧 BUILT · evidence a \|$/m);
  // refusals exit 1 and leave the file alone
  const before = sha(tasks(root));
  for (const args of [['status', 'T-2', 'DONE'], ['status', 'T-2', '🚀 LIVE-UNVERIFIED'], ['append', 'T-99', '--text', 'x'], ['mint', 'T', '--title', 'x'.repeat(1600)], ['mint', 'Z', '--title', 'x']]) {
    const r = run(root, args); assert.equal(r.code, 1, `${args.join(' ')} → ${r.out}`); assert.match(r.last, /^ERR /);
  }
  assert.equal(sha(tasks(root)), before);
  assert.equal(run(root, ['status', 'T-2', '🚀 LIVE-UNVERIFIED — the user: ship it before the call']).code, 0);
});

test('mint refuses when the counter is behind (ID already has a row in live or archive)', () => {
  const root = project({ counter: 'T-2', archive: '# TASKS-ARCHIVE\n\n## Rotated\n\n| ID | Task | Status |\n|---|---|---|\n| T-2 | x | ✅ VERIFIED |\n', rows: ['| T-1 | a | ⬜ OPEN |'] });
  const r = run(root, ['mint', 'T', '--title', 'x']);
  assert.equal(r.code, 1); assert.match(r.last, /T-2 already has a row in TASKS-ARCHIVE\.md/);
  const c = run(root, ['check']);
  assert.equal(c.code, 1); assert.match(c.out, /counter says next free T-2 but T-2 already has a row/);
});

test('(a) race: 20 parallel mints get 20 unique consecutive IDs, 20 rows, counter start+20', async () => {
  const root = project({ counter: 'T-100', rows: [] });
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => runAsync(root, ['mint', 'T', '--title', `racer ${i}`])));
  for (const r of res) assert.equal(r.code, 0, r.out);
  const ids = res.map((r) => r.last.replace('OK ', '')).sort();
  const want = Array.from({ length: 20 }, (_, i) => `T-${100 + i}`).sort();
  assert.deepEqual(ids, want);
  const t = fs.readFileSync(tasks(root), 'utf8');
  assert.deepEqual(rowIds(t).sort(), want);
  assert.match(t, /next free: `T-120`/);
  assert.equal(run(root, ['check']).code, 0);
  assert.ok(!fs.existsSync(path.join(root, '.claude', '.state', 'locks', 'registry.lock')), 'lock released');
});

test('(b) stale lock: dead PID and old mtime are broken with a notice; a live fresh lock is waited on then refused', () => {
  const root = project();
  const lock = path.join(root, '.claude', '.state', 'locks', 'registry.lock');
  const plant = (pid, ageS = 0) => {
    fs.mkdirSync(lock, { recursive: true });
    const o = path.join(lock, 'owner.json');
    fs.writeFileSync(o, JSON.stringify({ pid, host: os.hostname(), token: `planted-${pid}`, cmd: 'test', since: 'x' }));
    if (ageS) { const t = new Date(Date.now() - ageS * 1000); fs.utimesSync(o, t, t); fs.utimesSync(lock, t, t); }
  };
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  plant(dead);
  let r = run(root, ['mint', 'T', '--title', 'after dead holder']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, new RegExp(`broke stale registry lock .*holder PID ${dead} is not running`));
  plant(process.pid, 120);
  r = run(root, ['mint', 'T', '--title', 'after old lock']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /broke stale registry lock .*older than 60 s/);
  plant(process.pid);
  const before = sha(tasks(root));
  r = run(root, ['mint', 'T', '--title', 'blocked'], { CLOCKWORK_LOCK_TIMEOUT_MS: '300' });
  assert.equal(r.code, 1); assert.match(r.last, /^ERR registry lock busy/);
  assert.equal(sha(tasks(root)), before);
  fs.rmSync(lock, { recursive: true });
});

test('(c) mint refused while a branch or claude -w worktree named t<n>-* exists; --claim-branch registers it', () => {
  const root = project({ counter: 'T-5' });
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\n.claude/.state/\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  git(root, 'branch', 't5-someone-else');
  const before = sha(tasks(root));
  let r = run(root, ['mint', 'T', '--title', 'mine']);
  assert.equal(r.code, 1); assert.match(r.last, /T-5: branch\/worktree t5-someone-else already exists/);
  assert.equal(sha(tasks(root)), before);
  r = run(root, ['mint', 'T', '--title', 'register the branch', '--claim-branch', 't5-someone-else']);
  assert.equal(r.code, 0, r.out); assert.equal(r.last, 'OK T-5');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-t6-cc', path.join(root, '.claude', 'worktrees', 't6-cc'));
  r = run(root, ['mint', 'T', '--title', 'next']);
  assert.equal(r.code, 1); assert.match(r.last, /T-6: branch\/worktree .*t6-cc/);
});

test('(d) rotate: archives settled rows verbatim with stubs; a planted lossy write aborts and restores byte-identical', () => {
  const rows = [
    '| T-1 | done one | ✅ VERIFIED · evidence reports/v1.md |',
    '| T-2 | void | ✖ VOID · counter gap |',
    '| T-3 | built | 🔧 BUILT |',
    '| T-4 | done but owed | ✅ VERIFIED · the user\'s look owed |',
    '| T-5 | recent done | ✅ VERIFIED |',
  ];
  const arch = '# TASKS-ARCHIVE\n\nOld rows.\n\n## Rotated 2026-08-01\n\n| ID | Task | Status |\n|---|---|---|\n| T-0 | older | ✅ VERIFIED |\n';
  for (const fault of ['rotate-pre-gate', 'rotate-post-write']) {
    const root = project({ counter: 'T-6', rows, archive: arch });
    const a = path.join(root, '.claude', 'TASKS-ARCHIVE.md');
    const b = { live: sha(tasks(root)), arch: sha(a) };
    const r = run(root, ['rotate', 'TASKS.md', '--keep-recent', '1'], { CLOCKWORK_REGISTRY_FAULT: fault });
    assert.equal(r.code, 1, r.out); assert.match(r.last, /^ERR integrity gate failed/);
    if (fault === 'rotate-post-write') assert.match(r.out, /RESTORED .*byte-identical/);
    assert.equal(sha(tasks(root)), b.live, `${fault}: live restored`);
    assert.equal(sha(a), b.arch, `${fault}: archive restored`);
  }
  const root = project({ counter: 'T-6', rows, archive: arch });
  const a = path.join(root, '.claude', 'TASKS-ARCHIVE.md');
  const dry = run(root, ['rotate', 'TASKS.md', '--keep-recent', '1', '--dry-run']);
  assert.equal(dry.last, 'OK rotate dry-run 2 rows');
  assert.ok(!fs.existsSync(path.join(root, 'PM')), 'dry run writes no backup');
  const r = run(root, ['rotate', 'TASKS.md', '--keep-recent', '1']);
  assert.equal(r.code, 0, r.out); assert.equal(r.last, 'OK rotate 2 rows');
  assert.match(r.out, /held back .*T-4/);
  const live = fs.readFileSync(tasks(root), 'utf8'), archived = fs.readFileSync(a, 'utf8');
  assert.match(live, /^\| T-1 \| → archived \d{4}-\d{2}-\d{2} \(TASKS-ARCHIVE\.md\) \| ✅ VERIFIED \|$/m);
  assert.match(live, /^\| T-2 \| → archived .* \| ✖ VOID \|$/m);
  for (const keep of [rows[2], rows[3], rows[4]]) assert.ok(live.includes(keep));
  assert.ok(archived.startsWith(arch) && archived.includes(rows[0]) && archived.includes(rows[1]));
  const bdir = path.join(root, 'PM', 'archive', 'registry-backups');
  const [folder] = fs.readdirSync(bdir);
  assert.match(folder, /^\d{4}-\d{2}-\d{2}-\d{4}-rotate-tasks$/);
  assert.match(fs.readFileSync(path.join(bdir, folder, 'SHA256SUMS'), 'utf8'), /  TASKS\.md\n/);
  assert.equal(run(root, ['check']).code, 0);
  assert.equal(run(root, ['rotate', 'TASKS.md', '--keep-recent', '1']).last, 'OK rotate 0 rows', 'stubs are never re-archived');
});

test('rotate holds back a ✅ row that names the user\'s look, and a named look ("Sam\'s look") in rows from before 2.2.0', () => {
  const rows = ['| T-1 | old wording | ✅ VERIFIED · Sam\'s look |', '| T-2 | new wording | ✅ VERIFIED · the user\'s look |', '| T-3 | settled | ✅ VERIFIED |', '| T-4 | recent | ✅ VERIFIED |'];
  const root = project({ counter: 'T-5', rows });
  const r = run(root, ['rotate', 'TASKS.md', '--keep-recent', '1']);
  assert.equal(r.code, 0, r.out); assert.equal(r.last, 'OK rotate 1 rows');
  const live = fs.readFileSync(tasks(root), 'utf8');
  for (const keep of [rows[0], rows[1]]) assert.ok(live.includes(keep), keep);
});

// Opt-in only (CLOCKWORK_LIVE=1): the default suite never reads a live project, where iCloud may have offloaded the
// file (reading an offloaded file can hang forever; seen 2026-09-30). The file is live.legacyTasks in the machine's
// private file (test/private.mjs): a v1 TASKS.md with at least 20 rows and a "next free" counter.
test('(e) legacy v1 TASKS.md: header + 20 rows parse; check, next, mint, status work', { skip: process.env.CLOCKWORK_LIVE !== '1' && 'reads a live project: CLOCKWORK_LIVE=1 only' }, async (t) => {
  const src = loadPrivate()?.live?.legacyTasks;
  if (!src) { t.skip(`no live.legacyTasks in ${PRIVATE_FILE}`); return; }
  if (!fs.existsSync(src)) { t.skip(`${src} not on this machine`); return; }
  const { offloadState } = await import(new URL('../templates/claude/tools/registry.mjs', import.meta.url).href);
  if (offloadState(src) !== 'local') { t.skip(`${src} is offloaded by iCloud: not read`); return; }
  const text = fs.readFileSync(src, 'utf8'); // read-only; the copy goes to a temp fixture
  const lines = text.split('\n');
  const header = lines.slice(0, lines.findIndex((l) => l.startsWith('## '))).join('\n');
  const seen = new Set(), rows = [];
  for (const l of lines) { const m = /^\|\s*(T-\d+)\s*\|/.exec(l); if (m && !seen.has(m[1]) && l.split('|').length >= 6) { seen.add(m[1]); rows.push(l); } if (rows.length === 20) break; }
  assert.equal(rows.length, 20);
  const counter = /next free: `T-(\d+)`/.exec(header)[1];
  const root = path.join(TMP, 'legacy copy', 'site root');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), '{"project":"LR","registryDir":".claude","siteDir":"."}');
  const table = '## Open Tasks — Priority\n\n| ID | Task | Tier | Closes when | Status |\n|---|---|---|---|---|\n';
  fs.writeFileSync(tasks(root), `${header}\n${table}${rows.join('\n')}\n\n## Done\n`);
  const c = run(root, ['check']);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /TASKS\.md: 20 rows/);
  assert.match(c.out, new RegExp(`counter T: next free T-${counter}`));
  assert.match(c.out, /WARN: TASKS\.md: header is \d+ bytes/);
  assert.equal(run(root, ['next', 'T']).last, `OK T-${counter}`);
  const m = run(root, ['mint', 'T', '--title', 'legacy mint', '--section', '## Open Tasks — Priority', '--cells', 'V|fresh verifier']);
  assert.equal(m.code, 0, m.out); assert.equal(m.last, `OK T-${counter}`);
  const after = fs.readFileSync(tasks(root), 'utf8');
  assert.match(after, new RegExp(`^\\| T-${counter} \\| legacy mint \\| V \\| fresh verifier \\| ⬜ OPEN · opened `, 'm'));
  const changed = header.split('\n').filter((l, i) => after.split('\n')[i] !== l);
  assert.ok(changed.every((l) => /next free|Last updated/.test(l)), 'only the counter and Last updated header lines change');
  assert.ok(after.includes(rows[19]), 'existing rows untouched');
  const built = rows.map((r) => /^\|\s*(T-\d+)/.exec(r)[1]).find((id, i) => /\|\s*🔧 \*\*/.test(rows[i]));
  if (built) {
    assert.equal(run(root, ['status', built, '✅ VERIFIED reports/verify.md']).code, 0);
    assert.match(fs.readFileSync(tasks(root), 'utf8'), new RegExp(`^\\| ${built} \\|.*\\| ✅ VERIFIED reports/verify\\.md \\*\\*`, 'm'), 'legacy bold status keeps its text, only the marker changes');
  }
  const padded = rows.map((r) => /^\|\s*(T-0\d+)/.exec(r)?.[1]).find(Boolean);
  if (padded) assert.equal(run(root, ['append', `T-${Number(padded.slice(2))}`, '--text', 'unpadded lookup']).last, `OK ${padded}`);
});

test('(f) from inside a git worktree, writes land in the MAIN copy', () => {
  const root = project({ counter: 'T-7' });
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\n.claude/.state/\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  const wt = path.join(root, '.claude', 'worktrees', 'feature one');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-feature-one', wt);
  const wtTasks = path.join(wt, '.claude', 'TASKS.md'), wtBefore = sha(wtTasks);
  const r = run(path.join(wt, '.claude'), ['mint', 'T', '--title', 'from the worktree']);
  assert.equal(r.code, 0, r.out); assert.equal(r.last, 'OK T-7');
  assert.match(r.out, /registry writes go to the main copy/);
  assert.match(fs.readFileSync(tasks(root), 'utf8'), /^\| T-7 \| from the worktree \|/m);
  assert.equal(sha(wtTasks), wtBefore, 'worktree copy untouched');
  assert.equal(run(wt, ['next', 'T']).last, 'OK T-8');
});

test('(g) paths with spaces: backup into a spaced backupDir, SHA256SUMS valid, folder never reused', () => {
  const root = project({ config: { backupDir: 'PM/archive/registry backups' } });
  assert.ok(root.includes(' '));
  const r = run(root, ['backup', '--reason', 'before-edit']);
  assert.equal(r.code, 0, r.out);
  const dir = path.join(root, r.last.replace('OK ', ''));
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  for (const l of sums) { const [h, f] = l.split('  '); assert.equal(sha(path.join(dir, f)), h); assert.equal(sha(path.join(root, '.claude', f)), h); }
  const base = path.dirname(dir), d = new Date(Date.now() + 60_000), p2 = (x) => String(x).padStart(2, '0');
  fs.mkdirSync(path.join(base, `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-before-edit`));
  const again = run(root, ['backup', '--reason', 'before-edit']);
  assert.equal(again.code, 1); assert.match(again.last, /never reuse a folder/);
});

test('check flags duplicates; a crash exits 2 with ERR crash', () => {
  const root = project({ counter: 'T-3', rows: ['| T-1 | a | ⬜ OPEN |', '| T-01 | b | ⬜ OPEN |'] });
  const c = run(root, ['check']);
  assert.equal(c.code, 1); assert.match(c.out, /T-1 has 2 rows/);
  assert.match(run(root, ['append', 'T-1', '--text', 'x']).last, /matches 2 rows/);
  // zero-padded and legacy bold IDs are the same ID; an archive duplicate is a WARN, not an ERROR
  const legacy = project({ counter: 'T-06', rows: ['| T-05 | padded | ⬜ OPEN |', '| **T-06** | bold legacy | 🔧 BUILT |'],
    archive: '# A\n\n## Old\n\n| ID | T | S |\n|---|---|---|\n| T-01 | x | ✅ VERIFIED |\n| T-01 | y | ✅ VERIFIED |\n' });
  assert.equal(run(legacy, ['append', 'T-5', '--text', 'unpadded lookup']).last, 'OK T-05');
  assert.match(run(legacy, ['mint', 'T', '--title', 'x']).last, /T-06 already has a row in TASKS\.md/);
  const lc = run(legacy, ['check']);
  assert.match(lc.out, /WARN: TASKS-ARCHIVE\.md: 1 IDs have more than one archived row: T-1/);
  const bad = project();
  fs.rmSync(tasks(bad)); fs.mkdirSync(tasks(bad));
  const r = run(bad, ['next', 'T']);
  assert.equal(r.code, 2); assert.match(r.last, /^ERR crash:/);
});

test('✅ VERIFIED on a task: refused from OPEN or without evidence; allowed from BUILT with a report path or sha', () => {
  const root = project({ rows: ['| T-1 | a | ⬜ OPEN |', '| T-2 | b | 🔧 BUILT · 1a2b3c4 |'] });
  const before = sha(tasks(root));
  const open = run(root, ['status', 'T-1', '✅ VERIFIED reports/T-1-verify.md']);
  assert.equal(open.code, 1); assert.match(open.last, /is OPEN, not 🔧 BUILT/);
  const bare = run(root, ['status', 'T-2', '✅ VERIFIED']);
  assert.equal(bare.code, 1); assert.match(bare.last, /needs the fresh verifier's evidence/);
  assert.equal(sha(tasks(root)), before, 'refusals write nothing');
  const ghost = run(root, ['status', 'T-2', '✅ VERIFIED reports/T-2-verify.md, PASS at 390/1440']);
  assert.equal(ghost.code, 1); assert.match(ghost.last, /evidence not found: reports\/T-2-verify\.md.*not who made it/);
  fs.mkdirSync(path.join(root, '.claude', 'reports'), { recursive: true }); fs.writeFileSync(path.join(root, '.claude', 'reports', 'T-2-verify.md'), 'PASS\n');
  assert.equal(run(root, ['status', 'T-2', '✅ VERIFIED reports/T-2-verify.md, PASS at 390/1440']).last, 'OK T-2');
  const minted = run(root, ['mint', 'T', '--title', 'x', '--status', '✅ VERIFIED abc1234']);
  assert.equal(minted.code, 1, 'a task is never minted closed');
  const m = run(root, ['mint', 'T', '--title', 'no criterion']);
  assert.equal(m.code, 0); assert.match(m.out, /WARN: a T row needs --cells "closes when/);
});

test('✅ VERIFIED in a git repository: a sha that is not a commit is refused, the verified commit is accepted (final round)', () => {
  const root = project({ rows: ['| T-1 | a | 🔧 BUILT |', '| T-2 | b | 🔧 BUILT |'] });
  git(root, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(root, 'a.txt'), 'a'); git(root, 'add', 'a.txt'); git(root, 'commit', '-qm', 'build T-1');
  const head = git(root, 'rev-parse', '--short', 'HEAD');
  const fake = run(root, ['status', 'T-1', '✅ VERIFIED abc1234']);
  assert.equal(fake.code, 1, fake.out); assert.match(fake.last, /evidence not found: abc1234/);
  assert.equal(run(root, ['status', 'T-1', `✅ VERIFIED verifier PASS sha ${head}`]).last, 'OK T-1');
  assert.equal(run(root, ['status', 'T-2', '✅ VERIFIED https://preview.example.com/t2 checked at 390 and 1440']).last, 'OK T-2', 'a URL cannot be checked offline and is taken');
});

test('show and list read the main copy; line appends or replaces one line; report never overwrites', () => {
  const root = project({ rows: ['| T-1 | a | ⬜ OPEN |', '| T-2 | b | 🔧 BUILT · x |'] });
  assert.match(run(root, ['show', 'T-2']).out, /TASKS\.md:\d+ \| T-2 \| b \| 🔧 BUILT/);
  assert.equal(run(root, ['show', 'T-9']).code, 1);
  const l = run(root, ['list', 'T', '--status', 'built']);
  assert.match(l.out, /\| T-2 \|/); assert.doesNotMatch(l.out, /\| T-1 \|/); assert.equal(l.last, 'OK list 1');
  fs.writeFileSync(path.join(root, '.claude', 'FACTS.md'), '# FACTS\nx\n**Last updated:** 2026-09-01\n\n## Facts\n| Fact | Value |\n|---|---|\n| Launch date | 1 Oct |\n\n## Other\n');
  assert.equal(run(root, ['line', 'FACTS.md', '--section', '## Facts', '--replace', '| Launch date | 1 Oct |', '--text', '| Launch date | 17 Oct |']).last, 'OK line FACTS.md');
  assert.equal(run(root, ['line', 'FACTS.md', '--section', '## Facts', '--text', '| Domains | a.nl |']).last, 'OK line FACTS.md');
  const f = fs.readFileSync(path.join(root, '.claude', 'FACTS.md'), 'utf8');
  assert.match(f, /\| Launch date \| 17 Oct \|\n\| Domains \| a\.nl \|\n\n## Other/); assert.doesNotMatch(f, /1 Oct/);
  assert.equal(run(root, ['line', 'FACTS.md', '--section', '## Facts', '--replace', '| nope |', '--text', 'y']).code, 1, 'replace must match exactly one line');
  assert.equal(run(root, ['line', 'TASKS.md', '--section', '## Open', '--text', '| T-9 | sneaky | ⬜ OPEN |']).code, 1, 'ID rows only through mint');
  const src = path.join(root, 'h.md'); fs.writeFileSync(src, '# Handover\n');
  assert.equal(run(root, ['report', 'HANDOVER-2026-09-30-x.md', '--from', src]).last, 'OK .claude/reports/HANDOVER-2026-09-30-x.md');
  assert.equal(run(root, ['report', 'HANDOVER-2026-09-30-x.md', '--from', src]).code, 1, 'never overwrites');
});

test('claims: a second session cannot claim a held file; release frees it; claims lists live ones', () => {
  const root = project();
  assert.equal(run(root, ['claim', '--session', 'acme-hero', '--files', 'src/hero.css,src/a.tsx', '--ids', 'T-2', '--branch', 't2-hero']).code, 0);
  const clash = run(root, ['claim', '--session', 'acme-nav', '--files', 'src/nav.tsx,src/hero.css']);
  assert.equal(clash.code, 1); assert.match(clash.last, /src\/hero\.css \(held by acme-hero\)/);
  assert.match(run(root, ['claims']).out, /acme-hero · t2-hero · IDs T-2 · files: src\/hero\.css, src\/a\.tsx/);
  assert.equal(run(root, ['release', '--session', 'acme-hero']).code, 0);
  assert.equal(run(root, ['claim', '--session', 'acme-nav', '--files', 'src/hero.css']).code, 0);
});

test('claims compare one file however it is spelled: ./, //, .., absolute main or worktree path, case on macOS, folder and glob cover', () => {
  const root = project({ counter: 'T-3' });
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\n.claude/.state/\n');
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a'); fs.writeFileSync(path.join(root, 'src', 'components', 'Button.tsx'), 'b');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  const w2 = path.join(root, '.claude', 'worktrees', 'w2');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-w2', w2);
  assert.equal(run(w2, ['claim', '--session', 's-a', '--files', 'src/a.ts,src/components']).code, 0);
  const spellings = ['./src/a.ts', 'src//a.ts', 'src/x/../a.ts', path.join(root, 'src', 'a.ts'), path.join(w2, 'src', 'a.ts'),
    'src/components/Button.tsx', 'src/components/New.tsx', 'src/*.ts', 'src', ...(process.platform === 'darwin' ? ['SRC/A.ts'] : [])];
  for (const f of spellings) {
    const r = run(w2, ['claim', '--session', 's-b', '--files', f]);
    assert.equal(r.code, 1, `${f} should clash: ${r.out}`); assert.match(r.last, /held by s-a/);
  }
  assert.equal(run(root, ['claim', '--session', 's-b', '--files', 'src/b.ts,src/*.css']).code, 0, 'a different file and a glob that matches nothing held pass');
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.claude', '.state', 'claims', 's-a.json'), 'utf8'));
  assert.deepEqual(stored.files, ['src/a.ts', 'src/components'], 'stored relative to the worktree, from the main copy');
  assert.equal(run(w2, ['claim', '--session', 's-c', '--files', '/etc/hosts']).code, 1, 'outside the project is refused');
});

test('dedupe: identical copies dropped; different rows need --keep and the others get new IDs; a second run is a no-op', () => {
  const root = project({ counter: 'T-3', rows: ['| T-1 | a | ⬜ OPEN |', '| T-1 | a | ⬜ OPEN |', '| T-2 | b | 🔧 BUILT |'] });
  const d = run(root, ['dedupe', 'T-1']);
  assert.equal(d.code, 0, d.out); assert.match(d.last, /dropped 1 identical, renumbered 0/);
  assert.equal(rowIds(fs.readFileSync(tasks(root), 'utf8')).filter((x) => x === 'T-1').length, 1);
  assert.match(run(root, ['dedupe', 'T-1']).last, /nothing to fix/);
  assert.equal(run(root, ['check']).code, 0);
  const two = project({ counter: 'T-3', rows: ['| T-1 | first task | ⬜ OPEN |', '| T-1 | other task | 🔧 BUILT · sha abc1234 |'] });
  const refused = run(two, ['dedupe', 'T-1']);
  assert.equal(refused.code, 1); assert.match(refused.last, /2 different rows .* --keep <line>/);
  const line = fs.readFileSync(tasks(two), 'utf8').split('\n').findIndex((l) => l.includes('first task')) + 1;
  const k = run(two, ['dedupe', 'T-1', '--keep', String(line)]);
  assert.equal(k.code, 0, k.out); assert.match(k.out, /T-1 line \d+ → T-3/);
  const t = fs.readFileSync(tasks(two), 'utf8');
  assert.match(t, /^\| T-1 \| first task \| ⬜ OPEN \|$/m);
  assert.match(t, /^\| T-3 \| other task \| 🔧 BUILT · sha abc1234 · renumbered from T-1 \(duplicate ID\) \d{4}-\d{2}-\d{2} \|$/m);
  assert.match(t, /next free: `T-4`/);
  assert.equal(run(two, ['check']).code, 0, 'no duplicate, counter ahead');
  assert.equal(run(two, ['append', 'T-1', '--text', 'now editable']).code, 0);
});

test('line into a table section: a row joins the table, a bullet is refused, a blank row is filled with --replace', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.claude', 'FACTS.md'), '# FACTS\nx\n**Last updated:** 2026-09-01\n\n## Facts\n| Fact | Value | As of | Source |\n|---|---|---|---|\n| Launch date | | | |\n| Domains | | | |\n');
  const bullet = run(root, ['line', 'FACTS.md', '--section', '## Facts', '--text', '- Launch date: 2026-12-01']);
  assert.equal(bullet.code, 1); assert.match(bullet.last, /is a table: write a table row/);
  assert.equal(run(root, ['line', 'FACTS.md', '--section', '## Facts', '--replace', '| Launch date | | | |', '--text', '| Launch date | 2026-12-01 | 2026-09-30 | PM/x @ 2 |']).code, 0);
  assert.equal(run(root, ['line', 'FACTS.md', '--section', '## Facts', '--text', '| Legal name | Acme BV | 2026-09-30 | PM/x @ 3 |']).code, 0);
  const f = fs.readFileSync(path.join(root, '.claude', 'FACTS.md'), 'utf8');
  assert.match(f, /\| Launch date \| 2026-12-01 \| 2026-09-30 \| PM\/x @ 2 \|\n\| Domains \| \| \| \|\n\| Legal name \| Acme BV/);
  assert.doesNotMatch(f, /\| Launch date \| \| \| \|/);
});

// ── round 4: one row rule for registry.mjs and the doctor, exports, old counters, claims that add ──────────────
const DOCTOR = path.resolve(path.dirname(TOOL), '..', 'hooks', 'clockwork-doctor.mjs');
const RULE_ROWS = [
  '| T-1 | a | ⬜ OPEN |', '| T-1 | → archived 2026-09-01 (TASKS-ARCHIVE.md) | ✅ VERIFIED |', // pointer row
  '| T-2 | b | ⬜ OPEN |', '| T-2 | b again | ✖ VOID — duplicate of T-2 (onboarding 2026-09-30) |', // onboarding's marker
  '| T-3 | c | ⬜ OPEN |', '| T-3a | sub-item | ⬜ OPEN |', '| T-3 · update 2026-08-25 | note | ⬜ OPEN |', // not rows of T-3
  '| T-4 | d | ⬜ OPEN |', '| ~~T-4~~ | old d | ⬜ OPEN |', // a struck row IS a row: a real duplicate
  '| T-5 | ↩️ restored to live |', '| T-5 | e | ⬜ OPEN |', // 2-cell pointer
];
test('one row rule: registry.mjs check and the doctor agree (pointer, VOID-duplicate, T-3a and "T-3 · update" are not second rows)', () => {
  const root = project({ counter: 'T-6', rows: RULE_ROWS });
  const c = run(root, ['check']);
  assert.equal(c.code, 1, c.out);
  const regDups = [...c.out.matchAll(/ERROR: TASKS\.md: (T-\d+) has \d+ rows/g)].map((m) => m[1]);
  assert.deepEqual(regDups, ['T-4'], c.out);
  const d = spawnSync(process.execPath, [DOCTOR, '--report', '--json', '--root', root], { env: Object.assign({}, ENV, { CLAUDE_PROJECT_DIR: '', CLOCKWORK_TODAY: '2026-09-30' }), encoding: 'utf8' });
  const docDups = JSON.parse(d.stdout).errors.filter((x) => x.code === 'DUP').map((x) => x.item.split(' ')[0]);
  assert.deepEqual(docDups, regDups, 'the doctor reports the same duplicates as registry.mjs check');
  for (const id of ['T-1', 'T-2', 'T-3', 'T-5']) assert.equal(run(root, ['append', id, '--text', 'x']).last, `OK ${id}`, `${id}: its one full row is found`);
  assert.match(run(root, ['append', 'T-4', '--text', 'x']).last, /T-4 matches 2 rows.*dedupe T-4/);
  assert.match(fs.readFileSync(tasks(root), 'utf8'), /^\| T-3a \| sub-item \| ⬜ OPEN \|$/m, 'the sub-item row is untouched');
  assert.match(run(root, ['mint', 'T', '--title', 'x']).last, /^OK T-6$/);
});

test('one row rule, final round: combined keys, italic IDs and escaped pipes read the same in check, mint, dedupe and the doctor', () => {
  const doctor = (root) => JSON.parse(spawnSync(process.execPath, [DOCTOR, '--report', '--json', '--root', root], { env: Object.assign({}, ENV, { CLAUDE_PROJECT_DIR: '', CLOCKWORK_TODAY: '2026-09-30' }), encoding: 'utf8' }).stdout);
  // a combined key keeps every ID taken: check reports the counter behind, mint refuses instead of re-issuing T-7
  const merged = project({ counter: 'T-7', rows: ['| T-6 | six | ⬜ OPEN |', '| ~~T-7 / T-8~~ | merged pair | ✅ VERIFIED abc1234 |', '| T-61 · T-89 · T-133 | archived triple | ✅ VERIFIED abc1234 |'] });
  const c = run(merged, ['check']);
  assert.match(c.out, /highest row T-133/, c.out);
  const before = sha(tasks(merged));
  const m = run(merged, ['mint', 'T', '--title', 'new']);
  assert.equal(m.code, 1, m.out); assert.match(m.last, /T-7 already has a row/);
  assert.equal(sha(tasks(merged)), before, 'no second T-7 row');
  assert.match(run(merged, ['append', 'T-8', '--text', 'x']).last, /combined-key/, 'a combined row is never edited');
  assert.equal(doctor(merged).errors.filter((x) => x.code === 'DUP').length, 0, 'a combined row is not a duplicate for the doctor either');
  // italic ID and an escaped pipe: the doctor and dedupe see the same rows
  const odd = project({ counter: 'T-10', rows: ['| *T-5* | five | ⬜ OPEN |', '| T-5 | five | ⬜ OPEN |', '| T-9 | nine \\| pipe | ⬜ OPEN |', '| T-9 | nine | ⬜ OPEN |'] });
  const regDups = [...run(odd, ['check']).out.matchAll(/ERROR: TASKS\.md: (T-\d+) has \d+ rows/g)].map((x) => x[1]).sort();
  const docDups = doctor(odd).errors.filter((x) => x.code === 'DUP').map((x) => x.item.split(' ')[0]).sort();
  assert.deepEqual(docDups, regDups, 'the doctor and check name the same duplicates');
  assert.deepEqual(regDups, ['T-5', 'T-9']);
  assert.match(run(odd, ['dedupe', 'T-5', '--keep', '11']).last, /^OK dedupe T-5: kept line 11, dropped 0 identical, renumbered 1/);
  assert.match(run(odd, ['dedupe', 'T-9', '--keep', '13']).last, /renumbered 1/);
  assert.equal(doctor(odd).errors.filter((x) => x.code === 'DUP').length, 0, 'after dedupe the doctor agrees nothing is left');
});

test('registry.mjs imported as a module runs nothing and exports its parser', () => {
  const src = `const R = await import(${JSON.stringify(new URL(`file://${TOOL}`).href)}); console.log(JSON.stringify(Object.keys(R).sort()));`
    + 'const p = R.parse("# T\\n> **ID counter — next free: `T-3`**\\n\\n## Open\\n| T-1 | a | ⬜ OPEN |\\n| T-1a | b | ⬜ OPEN |\\n");'
    + 'console.log(p.rows.length, p.counters[0].num, R.classify(R.statusOf(p.rows[0].text).text), R.rowIdOf("| T-12a | x |"), R.countsAsRow("| T-1 | → archived x | ✅ |"));';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { cwd: TMP, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [keys, facts] = r.stdout.trim().split('\n');
  for (const k of ['parse', 'cellsOf', 'statusOf', 'classify', 'ROW_RE', 'COUNTER_RE', 'rowIdOf', 'isPointer', 'isVoidDuplicate', 'countsAsRow']) assert.ok(JSON.parse(keys).includes(k), `exports ${k}`);
  assert.equal(facts, '1 3 OPEN null false');
  assert.doesNotMatch(r.stdout, /^(OK|ERR) /m, 'main() did not run');
});

test('old counter formats: next and check read them; mint refuses with the exact line to write', () => {
  const root = project({ counter: 'T-3' });
  const t = fs.readFileSync(tasks(root), 'utf8').replace(/> \*\*ID counter — next free: `T-3`\*\*/, '> **Next free: T-31** — the counter holds the number and nothing else. T-12 was voided.');
  fs.writeFileSync(tasks(root), t);
  fs.writeFileSync(path.join(root, '.claude', 'CLIENT.md'), '# CLIENT\nx\n> **Next free IDs:** C-9 · CD-3\n\n## Client asks\n| ID | Ask | Status |\n|---|---|---|\n| C-8 | a | ⬜ OPEN |\n');
  fs.writeFileSync(path.join(root, '.claude', 'OPEN-ASKS.md'), '# OPEN-ASKS\n> Next free: **A-4**\n\n## Open\n| ID | Ask | Status |\n|---|---|---|\n');
  const nx = run(root, ['next', 'T']);
  assert.equal(nx.last, 'OK T-31'); assert.match(nx.out, /old format/);
  assert.equal(run(root, ['next', 'C']).last, 'OK C-9'); assert.equal(run(root, ['next', 'CD']).last, 'OK CD-3'); assert.equal(run(root, ['next', 'A']).last, 'OK A-4');
  const c = run(root, ['check']);
  assert.equal(c.code, 0, c.out); assert.match(c.out, /counter T: next free T-31 \(old format\)/); assert.match(c.out, /WARN: TASKS\.md: line 4 holds the T counter in the old format/);
  const before = sha(tasks(root));
  const m = run(root, ['mint', 'T', '--title', 'x']);
  assert.equal(m.code, 1); assert.match(m.last, /old format.*> \*\*ID counter — next free: `T-31`\*\*/);
  assert.equal(sha(tasks(root)), before, 'nothing written');
  // a converted counter with the old line kept as a note below it: the note is not a second counter
  fs.writeFileSync(tasks(root), t.replace('> **Next free: T-31**', '> **ID counter — next free: `T-31`**\n> (was: Next free: T-31)'));
  assert.equal(run(root, ['next', 'T']).last, 'OK T-31');
  assert.equal(run(root, ['mint', 'T', '--title', 'x']).last, 'OK T-31');
});

test('a second claim by the same session adds files; --replace-claim drops them and says which', () => {
  const root = project();
  assert.equal(run(root, ['claim', '--session', 's-a', '--files', 'src/a.ts,src/b.ts', '--ids', 'T-1']).code, 0);
  const again = run(root, ['claim', '--session', 's-a', '--files', 'app/hello/page.tsx', '--ids', 'T-2']);
  assert.equal(again.last, 'OK claim 3 file(s)'); assert.match(again.out, /kept from your earlier claim: src\/a\.ts, src\/b\.ts/);
  assert.match(run(root, ['claim', '--session', 's-b', '--files', 'src/a.ts']).last, /already claimed: src\/a\.ts \(held by s-a\)/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.claude', '.state', 'claims', 's-a.json'), 'utf8'));
  assert.deepEqual(saved.ids, ['T-1', 'T-2']);
  const rep = run(root, ['claim', '--session', 's-a', '--files', 'app/hello/page.tsx', '--replace-claim']);
  assert.equal(rep.last, 'OK claim 1 file(s)'); assert.match(rep.out, /RELEASED \(no longer claimed by s-a\): src\/a\.ts, src\/b\.ts/);
  assert.equal(run(root, ['claim', '--session', 's-b', '--files', 'src/a.ts']).code, 0);
});

test('a visual close after the user\'s look: the bare call is refused with the exact command that works', () => {
  const root = project({ rows: ['| T-1 | a | 🔎 VERIFYING · verifier PASS sha abc1234 · reports/T-1-verify-abc1234.md · the user\'s look owed |', '| T-2 | b | ⬜ OPEN |'] });
  const bare = run(root, ['status', 'T-1', '✅ VERIFIED the user\'s look 2026-09-30']);
  assert.equal(bare.code, 1); assert.match(bare.last, /status T-1 "✅ VERIFIED the user's look \d{4}-\d\d-\d\d · verifier PASS reports\/T-1-verify-<sha7>\.md"/);
  fs.mkdirSync(path.join(root, '.claude', 'reports'), { recursive: true }); fs.writeFileSync(path.join(root, '.claude', 'reports', 'T-1-verify-abc1234.md'), 'PASS\n');
  assert.equal(run(root, ['status', 'T-1', '✅ VERIFIED the user\'s look 2026-09-30 · verifier PASS reports/T-1-verify-abc1234.md']).last, 'OK T-1');
});

// iCloud offload, faked: CLOCKWORK_FAKE_OFFLOADED makes offloadState treat those paths as offloaded (the real rule,
// size > 0 with 0 blocks, is checked on a stats object). No real iCloud file is ever touched here.
const OFFLOAD_MSG = /^ERR not checked: (\/.+) is offloaded by iCloud — open it in Finder or run `brctl download "\1"`, then re-run$/;
test('offloadState: size with no blocks = offloaded; folders, missing files and fakes', async () => {
  const { offloadState, offloadNote } = await import(new URL(`file://${TOOL}`).href);
  const root = project();
  assert.equal(offloadState(tasks(root)), 'local');
  assert.equal(offloadState(path.join(root, 'nope.md')), 'missing');
  assert.equal(offloadState(path.join(root, '.claude')), 'local', 'a folder is never "offloaded"');
  assert.equal(offloadState('/x', { isFile: () => true, size: 10, blocks: 0 }), 'offloaded');
  assert.equal(offloadState('/x', { isFile: () => true, size: 0, blocks: 0 }), 'local', 'an empty file is not offloaded');
  const prev = process.env.CLOCKWORK_FAKE_OFFLOADED;
  process.env.CLOCKWORK_FAKE_OFFLOADED = tasks(root);
  try { assert.equal(offloadState(tasks(root)), 'offloaded'); } finally { if (prev === undefined) delete process.env.CLOCKWORK_FAKE_OFFLOADED; else process.env.CLOCKWORK_FAKE_OFFLOADED = prev; }
  assert.equal(offloadNote('/a b/T.md'), 'not checked: /a b/T.md is offloaded by iCloud — open it in Finder or run `brctl download "/a b/T.md"`, then re-run');
});

test('offloaded TASKS.md (faked): every write refuses with the download message and leaves the file alone; check fails', () => {
  const root = project();
  const OFF = { CLOCKWORK_FAKE_OFFLOADED: tasks(root) };
  const before = sha(tasks(root));
  for (const args of [['mint', 'T', '--title', 'x'], ['append', 'T-2', '--text', 'y'], ['status', 'T-2', '🔧 BUILT'], ['line', 'TASKS.md', '--section', '## Notes', '--text', 'z'], ['rotate', 'TASKS.md'], ['backup', '--reason', 'pre-x']]) {
    const r = run(root, args, OFF);
    assert.equal(r.code, 1, `${args[0]}: ${r.out}${r.err}`);
    const m = OFFLOAD_MSG.exec(r.last.replace(/^ERR no backup made: /, 'ERR '));
    assert.ok(m && m[1].endsWith('/.claude/TASKS.md'), `${args[0]}: ${r.last}`);
  }
  assert.equal(sha(tasks(root)), before, 'nothing written');
  const c = run(root, ['check'], OFF);
  assert.equal(c.code, 1);
  assert.match(c.out, /^not checked: .+\/\.claude\/TASKS\.md is offloaded by iCloud/m);
  assert.match(c.last, /^ERR check incomplete: 1 offloaded file\(s\) not checked \(TASKS\.md\)/);
  assert.equal(run(root, ['mint', 'T', '--title', 'x']).last, 'OK T-3', 'control: works once the file is local');
});

test('offloaded clockwork.json (faked): the tool refuses before reading anything', () => {
  const root = project();
  const cfg = path.join(root, '.claude', 'clockwork.json');
  const r = run(root, ['next', 'T'], { CLOCKWORK_FAKE_OFFLOADED: cfg });
  assert.equal(r.code, 1, r.out + r.err);
  assert.ok(OFFLOAD_MSG.test(r.last) && r.last.includes('/.claude/clockwork.json'), r.last);
});
