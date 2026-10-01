// Tests for templates/claude/hooks/clockwork-doctor.mjs — node --test, offline, fixtures in os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, copyFileSync, realpathSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPrivate, PRIVATE_FILE } from './private.mjs';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = join(KIT, 'templates', 'claude', 'hooks', 'clockwork-doctor.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'cw-doctor-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const CONFIG = {
  clockworkVersion: '2.0.0', project: 'Acme', stack: 'nextjs', registryDir: '.claude', siteDir: '.',
  idPrefixes: { T: 'TASKS.md', C: 'CLIENT.md', CD: 'CLIENT.md', A: 'OPEN-ASKS.md', Q: 'APPROVAL-QUEUE.md' },
  sizeBudgets: {
    'AGENTS.md': { warn: 7000, error: 8192 }, 'CLAUDE.md': { warn: 1800, error: 2048 },
    '.claude/rules/design-system.md': { warn: 20480, error: 28672 },
    'TASKS.md': { warn: 160000, error: 400000 }, 'CLIENT.md': { warn: 120000, error: 300000 },
    'FACTS.md': { warn: 20000, error: 40000 }, 'DOC-MAP.md': { warn: 6000, error: 8192 },
    'MEETING-LOG.md': { warn: 120000, error: 300000 },
  },
  rowBudget: 1500, headerBudget: 1500, mustRead: ['AGENTS.md', 'CLAUDE.md'], mustReadBudget: 10240,
  agingDays: { openClientAsk: 14, touchpoint: 14, builtUnverified: 7, warnAge: 7 },
  backupDir: 'PM/archive/registry-backups',
};
const head = (title, counters) => `# ${title}\nOne-line purpose.\n**Last updated:** 2026-09-29\n${counters.map((c) => `> **ID counter — next free: \`${c}\`**`).join('\n')}\n`;
const CLEAN = {
  '.claude/clockwork.json': JSON.stringify(CONFIG, null, 2),
  'AGENTS.md': '# Acme\n\n## Hard rules\n- Registries only through registry.mjs.\n',
  'CLAUDE.md': '@AGENTS.md\n',
  '.claude/rules/design-system.md': '# Design system\n| Rule | Value |\n|---|---|\n',
  '.claude/TASKS.md': `${head('TASKS', ['T-3'])}\n## Open\n| ID | Task | Status |\n|---|---|---|\n| T-1 | Build hero opened 2026-09-28 | ⬜ OPEN |\n| T-2 | Fix nav | 🔧 BUILT 2026-09-28 |\n`,
  '.claude/CLIENT.md': `${head('CLIENT', ['C-2', 'CD-2'])}\n## Client asks\n| ID | Ask | Owner | Status |\n|---|---|---|---|\n| C-1 | Send logo files opened 2026-09-25 | John | ⬜ OPEN |\n\n## Confirmed Decisions\n| ID | Decision | Status |\n|---|---|---|\n| CD-1 | **Block theme for the whole site** (2026-09-20) | ✅ VERIFIED |\n\n## Standing Obligations\n| ID | Obligation | Status |\n|---|---|---|\n`,
  '.claude/OPEN-ASKS.md': `${head('OPEN-ASKS', ['A-1'])}\n## Open\n| ID | Ask | Status |\n|---|---|---|\n`,
  '.claude/APPROVAL-QUEUE.md': `${head('APPROVAL-QUEUE', ['Q-1'])}\n## Queue\n| ID | Item | Status |\n|---|---|---|\n`,
  '.claude/FACTS.md': '# FACTS\n- Launch is 17 Oct.\n',
  '.claude/DOC-MAP.md': '# DOC-MAP\n- Tasks: `.claude/TASKS.md`\n- Old: `.claude/OLD.md` moved to archive\n- Agenda: `PM/meetings/13 Aug 26 - Kickoff/agenda.md`\n',
  '.claude/MEETING-LOG.md': '# MEETING-LOG\nWhat was said.\n\n## 2026-09-27 — Call with John\n- Asked for logo files → C-1.\n',
  'PM/meetings/13 Aug 26 - Kickoff/agenda.md': 'agenda\n',
};

let n = 0;
function fixture(changes = {}, { git = false } = {}) {
  const root = join(TMP, `p${++n}`);
  const files = { ...CLEAN, ...changes };
  for (const [p, c] of Object.entries(files)) {
    if (c === null) continue;
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  if (git) { g(root, 'init', '-q', '-b', 'main'); g(root, 'add', '.'); g(root, 'commit', '-q', '-m', 'init'); }
  return realpathSync(root);
}
function g(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const env = (root, extra = {}) => { const e = { ...process.env, CLAUDE_PROJECT_DIR: root, CLOCKWORK_TODAY: '2026-09-30', ...extra }; delete e.CLOCKWORK_ROOT; return e; };
function run(root, args = ['--report', '--json'], opts = {}) {
  const r = spawnSync(process.execPath, [DOCTOR, ...args], { cwd: opts.cwd || tmpdir(), env: env(root, opts.env), input: opts.input ?? '', encoding: 'utf8', timeout: 30000 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { /* crash output is not JSON */ } }
  return { code: r.status, out: r.stdout, errOut: r.stderr, json };
}
const codes = (j, lv) => j[lv].map((f) => f.key);
const has = (j, lv, key) => codes(j, lv).includes(key);

test('clean fixture (git repo): exit 0, no errors or warnings, files and row counts listed', () => {
  const root = fixture({}, { git: true });
  const r = run(root);
  assert.equal(r.code, 0, r.out + r.errOut);
  assert.deepEqual(codes(r.json, 'errors'), []);
  assert.deepEqual(codes(r.json, 'warns'), []);
  assert.equal(r.json.filesRead['.claude/TASKS.md'].rows.T, 2);
  assert.equal(r.json.filesRead['.claude/CLIENT.md'].rows.CD, 1);
  const text = run(root, ['--report']);
  assert.equal(text.code, 0);
  assert.match(text.out, /Files read \(\d+\):/);
  assert.match(text.out, /\.claude\/TASKS\.md — [\d.]+ KB, 2 T- rows/);
  assert.match(text.out, /Result: no errors/);
});

test('counter behind the highest used ID → ERROR', () => {
  const r = run(fixture({ '.claude/TASKS.md': CLEAN['.claude/TASKS.md'].replace('`T-3`', '`T-2`') }));
  assert.equal(r.code, 1);
  assert.ok(has(r.json, 'errors', 'COUNTER:T'));
});

test('ID only in the counter header, no row → ERROR', () => {
  const t = CLEAN['.claude/TASKS.md'].replace('`T-3`**', '`T-5`**\n> T-4 is reserved for the gallery.');
  const r = run(fixture({ '.claude/TASKS.md': t }));
  assert.ok(has(r.json, 'errors', 'CTRONLY:T-4'));
  assert.ok(!has(r.json, 'errors', 'CTRONLY:T-3'), 'an ID never mentioned is not flagged');
});

test('duplicate ID: two rows in one file → ERROR; live + archive → WARN; a stub is not a duplicate', () => {
  const live = CLEAN['.claude/TASKS.md'].replace('| T-2 | Fix nav | 🔧 BUILT 2026-09-28 |', '| T-2 | → archived 2026-09-30 (TASKS-ARCHIVE.md) | ✅ VERIFIED |');
  const arch = '# TASKS-ARCHIVE\n\n## Archived\n| ID | Task | Status |\n|---|---|---|\n| T-1 | Old reuse | ✅ VERIFIED |\n| T-2 | Fix nav | ✅ VERIFIED |\n';
  const r = run(fixture({ '.claude/TASKS.md': live, '.claude/TASKS-ARCHIVE.md': arch }));
  assert.ok(has(r.json, 'warns', 'DUP_ARCH:T-1'), 'full row in live and archive');
  assert.ok(!codes(r.json, 'warns').concat(codes(r.json, 'errors')).some((k) => k.endsWith(':T-2') && k.startsWith('DUP')), 'a stub is not a duplicate');
  const twice = CLEAN['.claude/TASKS.md'].replace('| T-2 |', '| T-1 | Same ID again | ⬜ OPEN |\n| T-2 |');
  assert.ok(has(run(fixture({ '.claude/TASKS.md': twice })).json, 'errors', 'DUP:T-1'), 'two rows in one file');
  const arch2 = '# TASKS-ARCHIVE\n\n## Archived\n| ID | Task | Status |\n|---|---|---|\n| T-0 | A | ✅ VERIFIED |\n| T-0 | B | ✅ VERIFIED |\n';
  assert.ok(has(run(fixture({ '.claude/TASKS-ARCHIVE.md': arch2 })).json, 'warns', 'DUP_IN_ARCH:T-0'), 'archive duplicates are history: WARN');
});

test('branch and worktree named t<n>-* with no row → ERROR; with a row → fine', () => {
  const root = fixture({}, { git: true });
  g(root, 'branch', 't9-gallery');
  g(root, 'branch', 't1-hero');
  g(root, 'worktree', 'add', '-q', '-b', 'worktree-t8-footer', join(root, '.claude', 'worktrees', 't8-footer'));
  const r = run(root);
  assert.ok(has(r.json, 'errors', 'BRANCH:T-9'));
  assert.ok(has(r.json, 'errors', 'BRANCH:T-8'));
  assert.ok(!has(r.json, 'errors', 'BRANCH:T-1'));
});

test('iCloud conflict copy → ERROR; offloaded placeholder → WARN (never blocks Stop) with the download message', () => {
  const r = run(fixture({ '.claude/TASKS 2.md': 'stale copy', '.claude/.FACTS.md.icloud': '' }));
  assert.ok(has(r.json, 'errors', 'CONFLICT:.claude/TASKS 2.md'));
  assert.ok(has(r.json, 'warns', 'OFFLOADED:.claude/FACTS.md') && !has(r.json, 'errors', 'OFFLOADED:.claude/FACTS.md'));
  assert.match(r.json.warns.find((w) => w.code === 'OFFLOADED').text, /^not checked: \/.+\/\.claude\/FACTS\.md is offloaded by iCloud — open it in Finder or run `brctl download "\/.+\/\.claude\/FACTS\.md"`, then re-run$/);
  const root = fixture({}, { git: true });
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main 2'), readFileSync(join(root, '.git', 'refs', 'heads', 'main')));
  assert.ok(has(run(root).json, 'errors', 'GITREF:main 2'), 'duplicate git ref from iCloud');
});

test('second registry copy → WARN; worktree copies are ignored', () => {
  const r = run(fixture({ 'old-site/.claude/TASKS.md': 'old', '.claude/worktrees/x/.claude/TASKS.md': 'wt copy' }));
  assert.ok(has(r.json, 'warns', 'COPY:old-site/.claude/TASKS.md'));
  assert.ok(!codes(r.json, 'warns').some((k) => k.includes('worktrees')));
});

test('size budgets, line budget and must-read total come from clockwork.json', () => {
  const r = run(fixture({ 'AGENTS.md': `# A\n${'x'.repeat(9000)}\n`, 'CLAUDE.md': `@AGENTS.md\n${`${'a'.repeat(35)}\n`.repeat(40)}`, '.claude/FACTS.md': 'f'.repeat(25000) }));
  assert.ok(has(r.json, 'errors', 'SIZE:AGENTS.md'));
  assert.ok(has(r.json, 'warns', 'SIZE:FACTS.md'));
  assert.ok(has(r.json, 'warns', 'LINES:CLAUDE.md'));
  assert.ok(has(r.json, 'warns', 'MUSTREAD:total'));
  const cfg = { ...CONFIG, sizeBudgets: { ...CONFIG.sizeBudgets, 'FACTS.md': { warn: 30000, error: 40000 } } };
  const r2 = run(fixture({ '.claude/clockwork.json': JSON.stringify(cfg), '.claude/FACTS.md': 'f'.repeat(25000) }));
  assert.ok(!has(r2.json, 'warns', 'SIZE:FACTS.md'), 'raised budget in clockwork.json is honoured');
  const r3 = run(fixture({ '.claude/rules/design-system.md': null }));
  assert.ok(has(r3.json, 'warns', 'MISSING:.claude/rules/design-system.md'));
});

test('row budget, header budget, line ceiling (config), LIVE-UNVERIFIED reason, missing section', () => {
  const t = CLEAN['.claude/TASKS.md']
    .replace('Build hero opened', `Build hero ${'detail '.repeat(240)} opened`)
    .replace('One-line purpose.', `Purpose ${'note '.repeat(330)}`)
    .replace('| T-2 | Fix nav | 🔧 BUILT 2026-09-28 |', '| T-2 | Fix nav | 🚀 LIVE-UNVERIFIED |');
  const c = CLEAN['.claude/CLIENT.md'].replace('## Standing Obligations', '## Other');
  const r = run(fixture({ '.claude/TASKS.md': t, '.claude/CLIENT.md': c, '.claude/clockwork.json': JSON.stringify({ ...CONFIG, lineCeiling: 1000 }) }));
  assert.ok(has(r.json, 'warns', 'ROW:TASKS.md:T-1'));
  assert.ok(has(r.json, 'warns', 'HEADER:TASKS.md'));
  assert.ok(has(r.json, 'errors', 'LINE:TASKS.md'));
  assert.ok(has(r.json, 'warns', 'LIVEREASON:T-2'));
  assert.ok(has(r.json, 'warns', 'SECTION:CLIENT.md:Standing Obligations'));
});

test('dead references: paths with spaces are checked; moved lines are skipped', () => {
  const d = CLEAN['.claude/DOC-MAP.md'] + '- Notes: `PM/meetings/13 Aug 26 - Kickoff/notes.md`\n- `PM/old file.md` superseded by FACTS\n';
  const r = run(fixture({ '.claude/DOC-MAP.md': d }));
  const dead = codes(r.json, 'warns').filter((k) => k.startsWith('DEADREF'));
  assert.deepEqual(dead, ['DEADREF:.claude/DOC-MAP.md:PM/meetings/13 Aug 26 - Kickoff/notes.md']);
  assert.ok(r.json.ran.some((x) => /dead references: 3 anchored paths/.test(x)), r.json.ran.join('\n'));
});

test('aging: old open C-##, stale meeting log, old BUILT row; undated rows are counted, not hidden', () => {
  const c = CLEAN['.claude/CLIENT.md'].replace('opened 2026-09-25', 'opened 2026-09-01').replace('`C-2`', '`C-3`')
    .replace('| C-1 |', '| C-2 | Photo credits | John | ⬜ OPEN |\n| C-1 |');
  const t = CLEAN['.claude/TASKS.md'].replace('🔧 BUILT 2026-09-28', '🔧 BUILT 2026-09-01');
  const m = CLEAN['.claude/MEETING-LOG.md'].replace('2026-09-27', '2026-09-01');
  const r = run(fixture({ '.claude/CLIENT.md': c, '.claude/TASKS.md': t, '.claude/MEETING-LOG.md': m }));
  assert.ok(has(r.json, 'warns', 'AGE_C:C-1'));
  assert.ok(has(r.json, 'warns', 'TOUCH:meeting-log'));
  assert.ok(has(r.json, 'warns', 'AGE_BUILT:T-2'));
  assert.ok(r.json.notChecked.some((x) => /1 of 2 open C- rows/.test(x)), r.json.notChecked.join('\n'));
});

test('uncommitted tracked changes → WARN', () => {
  const root = fixture({}, { git: true });
  writeFileSync(join(root, 'AGENTS.md'), '# Acme\nchanged\n');
  const r = run(root);
  assert.ok(has(r.json, 'warns', 'DIRTY:.'));
});

test('C-## mentioned with no owner row → WARN', () => {
  const c = `${CLEAN['.claude/CLIENT.md'].replace('`C-2`', '`C-10`')}\nJohn also mentioned C-9 on the call.\n`;
  const r = run(fixture({ '.claude/CLIENT.md': c }));
  assert.ok(has(r.json, 'warns', 'NOOWNER:C-9'));
  assert.ok(!has(r.json, 'warns', 'NOOWNER:C-10'), 'the next-free ID is never flagged');
});

test('legacy CLIENT-REQUESTS mirror: orphan → ERROR, unmirrored → WARN; missing CLIENT.md never ERRORs', () => {
  const creq = '# CLIENT-REQUESTS\n\n## Live\n| ID | Ask | Status |\n|---|---|---|\n| C-1 | Logo | 🔴 open |\n| C-5 | Hosting login | 🔴 open |\n';
  const r = run(fixture({ '.claude/CLIENT-REQUESTS.md': creq }));
  assert.ok(has(r.json, 'errors', 'ORPHAN:C-5'));
  assert.ok(has(r.json, 'warns', 'UNMIRRORED:C-5'));
  assert.ok(!has(r.json, 'errors', 'ORPHAN:C-1'));
  const r2 = run(fixture({ '.claude/CLIENT-REQUESTS.md': creq, '.claude/CLIENT.md': null }));
  assert.ok(!codes(r2.json, 'errors').some((k) => k.startsWith('ORPHAN')));
  assert.ok(r2.json.notChecked.some((x) => /Client-ask ownership/.test(x)));
});

test('rule 13: self-contradicting decision and a settled decision re-asked → WARN; struck text is ignored', () => {
  const c = CLEAN['.claude/CLIENT.md'].replace('`CD-2`', '`CD-4`')
    .replace('| CD-1 |', '| CD-2 | **Hero video autoplay muted** — still open: captions | ✅ VERIFIED |\n| CD-3 | Fonts ~~still open~~ settled | ✅ VERIFIED |\n| CD-1 |')
    .replace('Send logo files', 'Should the hero video autoplay muted? Send logo files');
  const r = run(fixture({ '.claude/CLIENT.md': c }));
  const self = codes(r.json, 'warns').filter((k) => k.startsWith('SELFOPEN'));
  assert.equal(self.length, 1, self.join(','));
  assert.ok(has(r.json, 'warns', 'REOPENED:C-1'));
});

test('Stop mode: pre-existing ERROR reported once, never blocks; a new ERROR blocks once; stop_hook_active is honoured', () => {
  const root = fixture({ '.claude/TASKS.md': CLEAN['.claude/TASKS.md'].replace('`T-3`', '`T-2`') }, { git: true });
  const b = run(root, ['--write-baseline', '--session', 's1']);
  assert.equal(b.code, 0, b.errOut);
  assert.match(b.out, /^OK baseline \.claude\/\.state\/doctor-baseline-s1\.json \(1 errors/);
  const stop = (extra = {}) => run(root, [], { input: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd: root, ...extra }) });
  const s1 = stop();
  assert.equal(s1.code, 0);
  const j1 = JSON.parse(s1.out);
  assert.equal(j1.decision, undefined);
  assert.match(j1.systemMessage, /1 error\(s\).*not blocking \(present when the session started/);
  assert.equal(stop().out, '', 'reported once, then silent');
  writeFileSync(join(root, '.claude', 'TASKS 2.md'), 'conflict');
  const s3 = JSON.parse(stop().out);
  assert.equal(s3.decision, 'block');
  assert.match(s3.reason, /TASKS 2\.md/);
  assert.match(s3.reason, /node "\/[^"]+\/\.claude\/tools\/registry\.mjs" dedupe <ID> \(safe if a peer runs it too/, 'the block names a fix that needs no hand edit, by absolute path (D13)');
  assert.doesNotMatch(s3.reason, /COUNTER|T-2 is already used/, 'the pre-existing error is not in the block reason');
  assert.equal(stop({ stop_hook_active: true }).out.includes('"decision"'), false, 'never blocks twice in a row');
  writeFileSync(join(root, '.claude', '.state', 'doctor-baseline-s9.json'), '{"someOtherFormat":true}');
  assert.equal(JSON.parse(stop({ session_id: 's9' }).out).decision, undefined, 'a baseline in another format never blocks');
  const s5 = stop();
  assert.equal(s5.out.includes('"decision"'), false, 'the same new error does not block again this session');
});

// iCloud offload, faked (CLOCKWORK_FAKE_OFFLOADED: registry.mjs offloadState treats these paths as offloaded; no real
// iCloud is touched). An offloaded file is never read: a WARN names it, the checks that need it are NOT CHECKED, and
// a Stop never blocks on it (a half-read registry would otherwise make false "no row" ERRORs).
const MSG = (p) => `not checked: ${p} is offloaded by iCloud — open it in Finder or run \`brctl download "${p}"\`, then re-run`;
test('offloaded TASKS.md (faked): WARN with the download message, T- checks not checked, Stop does not block', () => {
  const root = fixture({}, { git: true });
  const tasks = join(root, '.claude', 'TASKS.md');
  for (const s of ['off', 'ctl']) assert.equal(run(root, ['--write-baseline', '--session', s]).code, 0);
  g(root, 'branch', 't9-gallery'); // a branch for an ID with no row: a new ERROR that blocks when TASKS.md is read
  const stop = (sid, extra) => run(root, [], { input: JSON.stringify({ session_id: sid, hook_event_name: 'Stop', stop_hook_active: false, cwd: root }), env: extra });
  assert.equal(JSON.parse(stop('ctl').out).decision, 'block', 'control: with TASKS.md on disk the new branch blocks');
  const OFF = { CLOCKWORK_FAKE_OFFLOADED: tasks };
  const r = run(root, ['--report', '--json'], { env: OFF });
  assert.equal(r.code, 0, r.out + r.errOut);
  assert.deepEqual(codes(r.json, 'errors'), [], 'no ERROR from a file that was not read');
  assert.equal(r.json.warns.find((w) => w.code === 'NOTREAD')?.text, MSG(tasks));
  assert.ok(!r.json.filesRead['.claude/TASKS.md'], 'never read');
  assert.ok(r.json.notChecked.some((x) => /^T- ID checks .*TASKS\.md not read/.test(x)), r.json.notChecked.join('\n'));
  assert.ok(r.json.notChecked.some((x) => /^Branch and worktree names vs T- rows: TASKS\.md not read/.test(x)));
  assert.ok(!codes(r.json, 'warns').some((k) => k.startsWith('MISSING')), 'offloaded is not "missing"');
  const s = stop('off', OFF);
  assert.equal(s.code, 0);
  const j = JSON.parse(s.out);
  assert.equal(j.decision, undefined, 'an offloaded registry never blocks Stop');
  assert.ok(j.systemMessage.includes(MSG(tasks)), j.systemMessage);
});
test('offloaded clockwork.json (faked): --report exits 2 with the message; Stop exits 0 without blocking', () => {
  const root = fixture();
  const cfgFile = join(root, '.claude', 'clockwork.json');
  const OFF = { CLOCKWORK_FAKE_OFFLOADED: cfgFile };
  const r = run(root, ['--report'], { env: OFF });
  assert.equal(r.code, 2);
  assert.ok(r.errOut.includes(MSG(cfgFile)), r.errOut);
  const s = run(root, [], { input: JSON.stringify({ session_id: 'x', stop_hook_active: false, cwd: root }), env: OFF });
  assert.equal(s.code, 0);
  assert.equal(JSON.parse(s.out).decision, undefined);
  assert.ok(JSON.parse(s.out).systemMessage.includes(MSG(cfgFile)));
});
test('offloaded CLAUDE.md and design-system.md (faked): not read, not "missing", named under NOT CHECKED', () => {
  const root = fixture();
  const cl = join(root, 'CLAUDE.md'), ds = join(root, '.claude', 'rules', 'design-system.md');
  const r = run(root, ['--report', '--json'], { env: { CLOCKWORK_FAKE_OFFLOADED: [cl, ds].join(':') } });
  assert.equal(r.code, 0, r.out + r.errOut);
  assert.deepEqual(r.json.warns.filter((w) => w.code === 'NOTREAD').map((w) => w.text).sort(), [MSG(ds), MSG(cl)].sort());
  assert.ok(!codes(r.json, 'warns').some((k) => k.startsWith('MISSING')));
  assert.ok(r.json.notChecked.includes('AGENTS.md import: CLAUDE.md or AGENTS.md was not read.'));
  assert.ok(r.json.notChecked.includes('Design rules: .claude/rules/design-system.md not read.'));
});

test('Stop mode under /goal: stop_hook_active alone does not skip the check; right after its own block it reports instead', () => {
  const root = fixture({}, { git: true });
  assert.equal(run(root, ['--write-baseline', '--session', 'g1']).code, 0);
  const stop = (extra = {}) => run(root, [], { input: JSON.stringify({ session_id: 'g1', hook_event_name: 'Stop', cwd: root, ...extra }) });
  writeFileSync(join(root, '.claude', 'TASKS 2.md'), 'conflict');
  const s1 = JSON.parse(stop({ stop_hook_active: true }).out);
  assert.equal(s1.decision, 'block', 'a /goal continuation (stop_hook_active) with a new ERROR still blocks');
  assert.match(s1.reason, /may be a peer session's/);
  writeFileSync(join(root, '.claude', 'CLIENT 2.md'), 'conflict');
  const s2 = stop({ stop_hook_active: true });
  assert.equal(s2.out.includes('"decision"'), false, 'the Stop right after our own block never blocks');
  assert.match(JSON.parse(s2.out).systemMessage, /CLIENT 2\.md|error/);
  const s3 = JSON.parse(stop({ stop_hook_active: true }).out);
  assert.equal(s3.decision, 'block', 'the next Stop blocks the error that was only reported');
  assert.match(s3.reason, /CLIENT 2\.md/);
});

test('Stop mode: stdin written late (after node started) is still read', async () => {
  const root = fixture({}, { git: true });
  assert.equal(run(root, ['--write-baseline', '--session', 'late']).code, 0);
  writeFileSync(join(root, '.claude', 'TASKS 2.md'), 'conflict');
  const out = await new Promise((done) => {
    const c = spawn(process.execPath, [DOCTOR], { cwd: root, env: env(root) });
    let o = ''; c.stdout.on('data', (d) => { o += d; });
    c.on('close', (code) => done({ code, o }));
    setTimeout(() => { c.stdin.end(JSON.stringify({ session_id: 'late', hook_event_name: 'Stop', stop_hook_active: false, cwd: root })); }, 600);
  });
  assert.equal(out.code, 0);
  assert.equal(JSON.parse(out.o).decision, 'block', 'late stdin: still a Stop check, not the CLI report');
});

test('Stop mode: no baseline → never blocks, says so; garbage stdin → warning, exit 0', () => {
  const root = fixture({ '.claude/TASKS 2.md': 'conflict' });
  const s = run(root, [], { input: JSON.stringify({ session_id: 'nobase', stop_hook_active: false }) });
  assert.equal(s.code, 0);
  const j = JSON.parse(s.out);
  assert.equal(j.decision, undefined);
  assert.match(j.systemMessage, /No start-of-session baseline/);
  const bad = run(root, [], { input: 'not json' });
  assert.equal(bad.code, 0);
  assert.match(JSON.parse(bad.out).systemMessage, /not JSON/);
});

test('planted crash: --report exits 2 and says so; Stop mode fails open with a message', () => {
  const root = fixture({ '.claude/TASKS.md': null });
  mkdirSync(join(root, '.claude', 'TASKS.md')); // a folder where a file should be: every read of it throws
  const r = run(root, ['--report']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /CRASHED \(\d+\)/);
  assert.match(r.out, /Result: CRASHED/);
  assert.match(r.errOut, /crashed/);
  const s = run(root, [], { input: JSON.stringify({ session_id: 'c1', stop_hook_active: false }) });
  assert.equal(s.code, 0);
  assert.match(JSON.parse(s.out).systemMessage, /crashed/);
});

test('broken or missing config: --report exits 2, Stop exits 0 with a message', () => {
  const root = fixture({ '.claude/clockwork.json': '{ nope' });
  const r = run(root, ['--report']);
  assert.equal(r.code, 2);
  assert.match(r.errOut, /not valid JSON/);
  const s = run(root, [], { input: JSON.stringify({ session_id: 'x' }) });
  assert.equal(s.code, 0);
  assert.match(JSON.parse(s.out).systemMessage, /could not run/);
  const none = mkdtempSync(join(TMP, 'none-'));
  const r2 = run(none, ['--report']);
  assert.equal(r2.code, 2);
  assert.match(r2.errOut, /no \.claude\/clockwork\.json/);
});

test('--report does not wait for stdin (a pipe left open must not hang it)', async () => {
  const root = fixture();
  const child = spawn(process.execPath, [DOCTOR, '--report'], { cwd: tmpdir(), env: env(root), stdio: ['pipe', 'pipe', 'pipe'] });
  const code = await new Promise((res) => {
    const t = setTimeout(() => { child.kill(); res('hung'); }, 15000);
    child.on('exit', (c) => { clearTimeout(t); res(c); });
  });
  child.stdin.destroy();
  assert.equal(code, 0);
});

test('root: CLAUDE_PROJECT_DIR inside a linked worktree resolves to the main checkout', () => {
  const root = fixture({}, { git: true });
  const wt = join(root, '.claude', 'worktrees', 'w1');
  g(root, 'worktree', 'add', '-q', '-b', 'w1', wt);
  const r = run(wt);
  assert.equal(r.code, 0, r.out + r.errOut);
  assert.equal(r.json.root, root);
});

test('--summary stays within 12 lines', () => {
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`.claude/X${i} 2.md`, 'x']));
  const root = fixture({ ...many, ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`.claude/X${i}.md`, 'x'])), 'old/.claude/TASKS.md': 'x' });
  const r = run(root, ['--summary']);
  assert.equal(r.code, 1);
  assert.ok(r.out.trim().split('\n').length <= 12, r.out);
});

// Smoke: temp COPIES of live projects' registry files (read-only source), with a generated clockwork.json.
// Opt-in only (CLOCKWORK_LIVE=1): the default suite never reads a live project. iCloud may have offloaded a file
// there, and reading one can hang forever (seen 2026-09-30): such files are skipped, and said.
// The projects are listed in the machine's private file (test/private.mjs), never in the kit: live.smoke[] entries
// { name, src, dirs: [[from, to]], registryDir, siteDir, extra: [files], design }.
const LIVE = process.env.CLOCKWORK_LIVE === '1';
const { offloadState } = await import(join(KIT, 'templates', 'claude', 'tools', 'registry.mjs'));
function copyTop(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src)) {
    const p = join(src, e);
    if (!statSync(p).isFile() || !/\.(md|json)$/.test(e) || e === 'clockwork.json') continue;
    if (offloadState(p) !== 'local') { console.log(`SMOKE skipped ${p}: offloaded by iCloud (never read)`); continue; }
    copyFileSync(p, join(dst, e));
  }
}
const smoke = LIVE ? (loadPrivate()?.live?.smoke || []) : [];
if (!smoke.length) test('smoke: --report on temp copies of live projects', { skip: LIVE ? `no live.smoke[] in ${PRIVATE_FILE}` : 'reads a live project: CLOCKWORK_LIVE=1 only' }, () => {});
for (const s of smoke) {
  test(`smoke: --report on a temp copy of ${s.name} does not crash`, { skip: !existsSync(s.src) && 'live project not on this machine' }, () => {
    const root = join(TMP, `smoke-${s.name.replace(/\W/g, '')}`);
    for (const [from, to] of s.dirs) copyTop(join(s.src, from), join(root, to));
    for (const f of s.extra) if (existsSync(join(s.src, f))) {
      if (offloadState(join(s.src, f)) !== 'local') { console.log(`SMOKE skipped ${join(s.src, f)}: offloaded by iCloud (never read)`); continue; }
      copyFileSync(join(s.src, f), join(root, f));
    }
    const { '.claude/rules/design-system.md': ds, ...budgets } = CONFIG.sizeBudgets;
    const cfg = { ...CONFIG, project: s.name, registryDir: s.registryDir, siteDir: s.siteDir, idPrefixes: { T: 'TASKS.md', C: 'CLIENT.md' },
      mustRead: ['CLAUDE.md'], sizeBudgets: { ...budgets, [s.design]: ds } };
    delete cfg.sizeBudgets['AGENTS.md'];
    writeFileSync(join(root, '.claude', 'clockwork.json'), JSON.stringify(cfg, null, 2));
    const r = run(realpathSync(root));
    assert.notEqual(r.code, 2, r.errOut + JSON.stringify(r.json?.crashed));
    assert.ok(r.json, 'report parsed');
    const by = (lv) => Object.entries(r.json[lv].reduce((a, f) => ({ ...a, [f.code]: (a[f.code] || 0) + 1 }), {})).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`SMOKE ${s.name}: exit ${r.code} · errors ${r.json.errors.length} [${by('errors')}] · warns ${r.json.warns.length} [${by('warns')}] · not checked ${r.json.notChecked.length} · files ${Object.keys(r.json.filesRead).length}`);
  });
}

test('git that hangs: reported under NOT CHECKED as a stall (not "no repository"); git refs are still walked', () => {
  const root = fixture({}, { git: true });
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main 2'), 'x'); // iCloud duplicate ref
  const bin = join(TMP, `hang-bin-${n}`); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const t0 = Date.now();
  const r = run(root, ['--report'], { env: { PATH: `${bin}:${process.env.PATH}`, CLOCKWORK_GIT_TIMEOUT_MS: '700' } });
  assert.ok(Date.now() - t0 < 15000, 'one timeout, then git is skipped');
  assert.match(r.out, /NOT CHECKED[\s\S]*git did not answer within 0\.7 s/);
  assert.doesNotMatch(r.out, /is not a git repository/);
  assert.match(r.out, /duplicate git refs made by iCloud/);
  assert.equal(r.code, 1);
});

test('kit files never committed → WARN with the exact commit command; committed → quiet', () => {
  const root = fixture({ '.claude/settings.json': '{}' });
  g(root, 'init', '-q', '-b', 'main'); g(root, 'commit', '-q', '--allow-empty', '-m', 'empty');
  const j = run(root).json;
  const w = j.warns.find((x) => x.code === 'UNTRACKED');
  assert.ok(w, 'untracked kit files are flagged');
  assert.match(w.text, /git -C ".*" add -- ".claude\/clockwork\.json" ".claude\/settings\.json" "AGENTS\.md" "CLAUDE\.md" && git -C/);
  g(root, 'add', '.'); g(root, 'commit', '-q', '-m', 'install');
  assert.equal(run(root).json.warns.some((x) => x.code === 'UNTRACKED'), false);
});

test('design file: unfilled {{…}} values and a leftover v1 DESIGN-SYSTEM.md are WARNs', () => {
  const root = fixture({ '.claude/rules/design-system.md': '| SP-1 | `{{tight}}` |\n| SP-2 | `{{section}}` |\n', '.claude/DESIGN-SYSTEM.md': '# v1\n'.repeat(50) });
  const j = run(root).json;
  assert.match(j.warns.find((x) => x.code === 'DSHOLES').text, /2 unfilled/);
  assert.ok(j.warns.some((x) => x.code === 'DSV1'));
});

test('a ✅ VERIFIED task row with no evidence is an ERROR; with a report path or sha it is not', () => {
  const tasks = (row) => ({ '.claude/TASKS.md': `${head('TASKS', ['T-4'])}\n## Open\n| ID | Task | Status |\n|---|---|---|\n| T-1 | a | ⬜ OPEN |\n| T-2 | b | 🔧 BUILT 2026-09-28 |\n| T-3 | c | ${row} |\n` });
  assert.ok(has(run(fixture(tasks('✅ VERIFIED · opened 2026-09-30'))).json, 'errors', 'NOEVIDENCE:T-3'));
  assert.equal(has(run(fixture(tasks('✅ VERIFIED reports/T-3-verify.md · opened 2026-09-30'))).json, 'errors', 'NOEVIDENCE:T-3'), false);
  assert.equal(has(run(fixture(tasks('✅ VERIFIED 1a2b3c4 checked at 390 and 1440'))).json, 'errors', 'NOEVIDENCE:T-3'), false);
});

test('registry files changed in the main copy are a separate WARN with the commit command, not mixed with code', () => {
  const root = fixture({ 'src/app.js': 'x\n' }, { git: true });
  writeFileSync(join(root, '.claude', 'TASKS.md'), readFileSync(join(root, '.claude', 'TASKS.md'), 'utf8') + '\n');
  writeFileSync(join(root, 'src', 'app.js'), 'y\n');
  const j = run(root).json;
  assert.match(j.warns.find((x) => x.code === 'REGDIRTY').text, /git add -- ".claude\/TASKS\.md" && git commit/);
  const d = j.warns.find((x) => x.code === 'DIRTY');
  assert.match(d.text, /src\/app\.js/); assert.doesNotMatch(d.text, /TASKS/);
});

test('kit paths gitignored on purpose (D13): fine when .worktreeinclude lists them; otherwise names the lines to add, never "un-ignore"', () => {
  const root = fixture({ '.claude/settings.json': '{}', '.gitignore': 'node_modules/\n.claude/\n' });
  g(root, 'init', '-q', '-b', 'main'); g(root, 'add', 'AGENTS.md', 'CLAUDE.md', '.gitignore'); g(root, 'commit', '-q', '-m', 'init');
  const j = run(root).json;
  const w = j.warns.find((x) => x.code === 'IGNORED');
  assert.ok(w, JSON.stringify(j.warns.map((x) => x.code)));
  assert.match(w.text, /\.gitignore:2 "\.claude\/"; fine, decision D13/); assert.match(w.text, /Add these lines to \.worktreeinclude: .*\.claude\/settings\.json/);
  assert.doesNotMatch(w.text, /un-ignore|\.claude\/\*"/);
  assert.equal(j.warns.some((x) => x.code === 'UNTRACKED'), false, 'no commit command that git would refuse');
  g(root, 'worktree', 'add', '-q', '-b', 'w1', join(root, '..', `wt-${n}`));
  assert.ok(has(run(root).json, 'errors', 'IGNORED:kit'), 'a live worktree already runs without the kit');
  writeFileSync(join(root, '.worktreeinclude'), readFileSync(join(KIT, 'templates', 'worktreeinclude'), 'utf8'));
  const ok = run(root).json;
  assert.equal(has(ok, 'errors', 'IGNORED:kit') || has(ok, 'warns', 'IGNORED:kit'), false, 'the kit .worktreeinclude covers every ignored kit path');
  assert.ok(ok.ran.some((r) => /gitignored on purpose \(D13\).*listed in \.worktreeinclude/.test(r)));
});

test('a "!pattern" check-ignore line re-includes a path: un-ignored, committed kit files are not reported (round-3 BLOCK)', () => {
  const root = fixture({ '.claude/settings.json': '{}', '.gitignore': '.claude/*\n!.claude/settings.json\n!.claude/clockwork.json\n!.claude/hooks/\n!.claude/tools/\n' });
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true }); writeFileSync(join(root, '.claude', 'hooks', 'clockwork-doctor.mjs'), '//\n');
  mkdirSync(join(root, '.claude', 'tools'), { recursive: true }); writeFileSync(join(root, '.claude', 'tools', 'registry.mjs'), '//\n');
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'add', '--', 'AGENTS.md', 'CLAUDE.md', '.gitignore', '.claude/settings.json', '.claude/clockwork.json', '.claude/hooks', '.claude/tools'); g(root, 'commit', '-q', '-m', 'init');
  g(root, 'worktree', 'add', '-q', '-b', 'w1', join(root, '..', `wt-neg-${n}`));
  const j = run(root).json;
  assert.equal(has(j, 'errors', 'IGNORED:kit') || has(j, 'warns', 'IGNORED:kit'), false, JSON.stringify(j.errors));
});

test('D13: a worktree copy of gitignored rules that differs from main is a WARN with the refresh command; an identical copy is not', () => {
  const root = fixture({ '.gitignore': '.claude/\n', '.claude/rules/engineering.md': '# eng v1\n' });
  g(root, 'init', '-q', '-b', 'main'); g(root, 'add', 'AGENTS.md', 'CLAUDE.md', '.gitignore'); g(root, 'commit', '-q', '-m', 'init');
  const wt = join(root, '..', `wt-copy-${n}`); g(root, 'worktree', 'add', '-q', '-b', 'w1', wt);
  mkdirSync(join(wt, '.claude', 'rules'), { recursive: true });
  for (const f of ['design-system.md', 'engineering.md']) copyFileSync(join(root, '.claude', 'rules', f), join(wt, '.claude', 'rules', f));
  assert.equal(run(root).json.warns.some((x) => x.code === 'WTCOPY'), false, 'identical copies: nothing to say');
  writeFileSync(join(root, '.claude', 'rules', 'design-system.md'), '# Design system\n| Rule | Value |\n|---|---|\n| SP-1 | 8px |\n');
  const w = run(root).json.warns.find((x) => x.code === 'WTCOPY');
  assert.ok(w); assert.match(w.text, /\.claude\/rules\/design-system\.md/); assert.doesNotMatch(w.text, /engineering\.md/);
  assert.match(w.text, /rsync -a -u ".*\/\.claude\/rules\/" ".*wt-copy-\d+\/\.claude\/rules\/"/);
});

test('D13: a design rule edited INSIDE a worktree is a WTEDIT that says to copy it into main, never a refresh that overwrites it (final BLOCK)', () => {
  const root = fixture({ '.gitignore': '.claude/\n', '.claude/rules/engineering.md': '# eng v1\n' });
  g(root, 'init', '-q', '-b', 'main'); g(root, 'add', 'AGENTS.md', 'CLAUDE.md', '.gitignore'); g(root, 'commit', '-q', '-m', 'init');
  const wt = join(root, '..', `wt-edit-${n}`); g(root, 'worktree', 'add', '-q', '-b', 'w1', wt);
  mkdirSync(join(wt, '.claude', 'rules'), { recursive: true });
  for (const f of ['design-system.md', 'engineering.md']) copyFileSync(join(root, '.claude', 'rules', f), join(wt, '.claude', 'rules', f));
  const ds = join(wt, '.claude', 'rules', 'design-system.md');
  writeFileSync(ds, readFileSync(ds, 'utf8') + '| SP-9 | The user ruled 24px gutter |\n');
  const later = new Date(Date.now() + 120000); utimesSync(ds, later, later); // edited after the worktree was made
  const j = run(root).json;
  const e = j.warns.find((x) => x.code === 'WTEDIT');
  assert.ok(e, JSON.stringify(j.warns.map((x) => x.code)));
  assert.match(e.text, /design-system\.md/); assert.match(e.text, /deletes it/); assert.match(e.text, /diff ".*\/\.claude\/rules\/design-system\.md" ".*wt-edit-\d+\/\.claude\/rules\/design-system\.md"/);
  assert.equal(j.warns.some((x) => x.code === 'WTCOPY'), false, 'no rsync main → worktree for an edit made there');
  // main moves on too: the stale file is refreshed, the edited one is excluded from the refresh
  writeFileSync(join(root, '.claude', 'rules', 'engineering.md'), '# eng v2\n');
  const both = run(root).json;
  const c = both.warns.find((x) => x.code === 'WTCOPY');
  assert.ok(c && both.warns.some((x) => x.code === 'WTEDIT'));
  assert.match(c.text, /engineering\.md/); assert.match(c.text, /rsync -a -u --exclude "design-system\.md"/);
});

test('CLAUDE.md without @AGENTS.md: ERROR, and AGENTS.md leaves the must-read total; below line 1 is a WARN', () => {
  const big = '# Acme\n\n## Hard rules\n' + '- rule\n'.repeat(1500);
  const j = run(fixture({ 'CLAUDE.md': '# Acme project\nnotes\n', 'AGENTS.md': big })).json;
  assert.ok(has(j, 'errors', 'IMPORT:claude-md'));
  assert.match(j.errors.find((x) => x.code === 'IMPORT').text, /line 1 of CLAUDE\.md exactly: @AGENTS\.md/);
  assert.equal(j.warns.some((x) => x.code === 'MUSTREAD'), false, 'a file no session loads is not counted as read');
  const later = run(fixture({ 'CLAUDE.md': '# Acme\n\n@AGENTS.md\n' })).json;
  assert.equal(has(later, 'errors', 'IMPORT:claude-md'), false); assert.ok(has(later, 'warns', 'IMPORT:claude-md'));
  assert.equal(has(run(fixture({})).json, 'errors', 'IMPORT:claude-md'), false);
});

test('registry changes: untracked archives, reports and PM sources are in the commit command; a worktree caller is told who commits', () => {
  const root = fixture({}, { git: true });
  writeFileSync(join(root, '.claude', 'TASKS.md'), readFileSync(join(root, '.claude', 'TASKS.md'), 'utf8') + '\n');
  writeFileSync(join(root, '.claude', 'TASKS-ARCHIVE.md'), '# TASKS-ARCHIVE\n');
  mkdirSync(join(root, '.claude', 'reports')); writeFileSync(join(root, '.claude', 'reports', 'HANDOVER-x.md'), 'h\n');
  mkdirSync(join(root, 'PM', 'meetings', '29 Sep 26 - Kickoff'), { recursive: true }); writeFileSync(join(root, 'PM', 'meetings', '29 Sep 26 - Kickoff', 'source.md'), 's\n');
  writeFileSync(join(root, 'scratch.txt'), 'not a registry file\n');
  const t = run(root).json.warns.find((x) => x.code === 'REGDIRTY').text;
  for (const f of ['.claude/TASKS.md', '.claude/TASKS-ARCHIVE.md', '.claude/reports/HANDOVER-x.md', 'PM/meetings/29 Sep 26 - Kickoff/source.md']) assert.ok(t.includes(`"${f}"`), `${f} in: ${t}`);
  assert.doesNotMatch(t, /scratch\.txt/); assert.match(t, /from the main checkout/);
  const wt = join(root, '..', `wt-reg-${n}`); g(root, 'worktree', 'add', '-q', '-b', 'w2', wt);
  const w = run(root, ['--report', '--json'], { env: { CLAUDE_PROJECT_DIR: wt, CLOCKWORK_CALLER_DIR: wt } }).json.warns.find((x) => x.code === 'REGDIRTY').text;
  assert.match(w, /You are in a worktree.*do not commit these yourself.*Tell the user or the session working in the main checkout/);
});

test('an open row past its "due YYYY-MM-DD" is a WARN; a closed one or a future date is not', () => {
  const client = `${head('CLIENT', ['C-4', 'CD-2'])}\n## Client asks\n| ID | Ask | Who | Owed by | Status |\n|---|---|---|---|---|\n| C-1 | Contact form | Jan | us · due 2026-09-15 | ⬜ OPEN |\n| C-2 | Logo | Jan | due 2026-10-15 | ⬜ OPEN |\n| C-3 | Old | Jan | due 2026-09-01 | ✅ VERIFIED done |\n\n## Confirmed Decisions\n| ID | Decision | Status |\n|---|---|---|\n| CD-1 | **x y z settled here** | ✅ VERIFIED |\n\n## Standing Obligations\n| Obligation | Next due |\n|---|---|\n`;
  const j = run(fixture({ '.claude/CLIENT.md': client })).json;
  assert.ok(has(j, 'warns', 'DUE:C-1')); assert.equal(has(j, 'warns', 'DUE:C-2'), false); assert.equal(has(j, 'warns', 'DUE:C-3'), false);
});

test('a duplicate ID names registry.mjs dedupe, in the report and in the Stop block', () => {
  const tasks = `${head('TASKS', ['T-3'])}\n## Open\n| ID | Task | Status |\n|---|---|---|\n| T-1 | a | ⬜ OPEN |\n| T-1 | a | ⬜ OPEN |\n`;
  const j = run(fixture({ '.claude/TASKS.md': tasks })).json;
  assert.match(j.errors.find((x) => x.code === 'DUP').text, /node "\/[^"]+\/\.claude\/tools\/registry\.mjs" dedupe <ID>/);
});

test('the registry commit command lists only files the tools make; other new files under .claude/ are named apart, never staged (round-3 MAJOR)', () => {
  const root = fixture({}, { git: true });
  writeFileSync(join(root, '.claude', 'TASKS.md'), readFileSync(join(root, '.claude', 'TASKS.md'), 'utf8') + '\n');
  writeFileSync(join(root, '.claude', 'mcp-notes.txt'), 'private\n');
  mkdirSync(join(root, '.claude', 'scripts')); writeFileSync(join(root, '.claude', 'scripts', 'helper.py'), 'x\n');
  mkdirSync(join(root, '.claude', 'reports')); writeFileSync(join(root, '.claude', 'reports', 'T-1-verify-abc1234.md'), 'r\n');
  mkdirSync(join(root, 'PM', 'archive', 'registry-backups', '2026-09-30-1200-x'), { recursive: true }); writeFileSync(join(root, 'PM', 'archive', 'registry-backups', '2026-09-30-1200-x', 'SHA256SUMS'), 's\n');
  const j = run(root).json;
  const t = j.warns.find((x) => x.code === 'REGDIRTY').text;
  for (const f of ['.claude/TASKS.md', '.claude/reports/T-1-verify-abc1234.md', 'PM/archive/registry-backups/2026-09-30-1200-x/SHA256SUMS']) assert.ok(t.includes(`"${f}"`), `${f} in: ${t}`);
  assert.doesNotMatch(t, /mcp-notes|helper\.py/);
  const s = j.warns.find((x) => x.code === 'STRAY');
  assert.ok(s); assert.match(s.text, /\.claude\/mcp-notes\.txt/); assert.match(s.text, /\.claude\/scripts\/helper\.py/); assert.doesNotMatch(s.text, /git add/);
});
