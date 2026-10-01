// Tests for templates/claude/tools/overnight.sh and the overnight skill files.
// Offline. Mock pmset / claude / caffeinate on PATH, mock osascript via CLOCKWORK_OSASCRIPT,
// fake HOME. No Terminal window is ever opened; nothing outside os.tmpdir() is written.
// Run: node --test test/overnight.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'templates/claude/tools/overnight.sh');
const SKILL_DIR = path.join(ROOT, 'templates/claude/skills/overnight');
const SETTINGS_TEMPLATE = path.join(ROOT, 'templates/claude/overnight-settings.json');
const darwin = process.platform === 'darwin';
const opts = { skip: darwin ? false : 'overnight.sh is macOS-only (pmset, Terminal.app)' };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-overnight-'));
const spawned = [];
after(() => {
  for (const p of spawned) { try { process.kill(p, 'SIGKILL'); } catch {} }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const VALID_PLAN = `# Overnight plan

Goal: all 12 pages pass the mobile check at 390px
Verification command: node scripts/check-mobile.mjs
Stop time: 06:00
Turn cap: 150
Spend cap: $100
Ledger: PM/overnight/OVERNIGHT-LEDGER.md

## Authority scope
- Allowed: edit code in worktrees; preview deploys.
- Not allowed: production deploy, merge to main, client messages.

## Bucket 1: has a pass/fail
- T-12: footer overflow, check: check-mobile.mjs

## Bucket 2: is a judgement
- none

## Bucket 3: needs the user
- none yet
`;

let counter = 0;
function fixture({ plan = VALID_PLAN, power = 'ac', version = '2.1.285', settingsFile = true, projectSettings, localSettings, userSettings, claudeSecs = 3, guard = true, files = {} } = {}) {
  const dir = path.join(tmpRoot, `fx${++counter}`);
  const project = path.join(dir, 'Casa Lumen'); // a space on purpose
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const mocklog = path.join(dir, 'mocklog');
  for (const d of [path.join(project, '.claude'), bin, path.join(home, '.claude'), mocklog]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(project, '.claude/clockwork.json'), JSON.stringify({ overnight: { stopAt: '06:00', sessionName: 'casa-lumen-overnight' } }));
  if (settingsFile) fs.copyFileSync(SETTINGS_TEMPLATE, path.join(project, '.claude/overnight-settings.json'));
  if (guard) { fs.mkdirSync(path.join(project, '.claude/hooks'), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'templates/claude/hooks/guard-bash.mjs'), path.join(project, '.claude/hooks/guard-bash.mjs')); }
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true }); fs.writeFileSync(path.join(project, f), c); }
  if (plan !== null) { fs.mkdirSync(path.join(project, 'PM/overnight'), { recursive: true }); fs.writeFileSync(path.join(project, 'PM/overnight/OVERNIGHT-PLAN.md'), plan); }
  if (projectSettings) fs.writeFileSync(path.join(project, '.claude/settings.json'), projectSettings);
  if (localSettings) fs.writeFileSync(path.join(project, '.claude/settings.local.json'), localSettings);
  if (userSettings) fs.writeFileSync(path.join(home, '.claude/settings.json'), userSettings);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [fs.realpathSync(project)]: { hasTrustDialogAccepted: true } } }));

  const sh = (name, body) => { const f = path.join(bin, name); fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(f, 0o755); };
  sh('pmset', power === 'ac'
    ? `echo "Now drawing from 'AC Power'"; echo " -InternalBattery-0 (id=1)	100%; charged; 0:00 remaining present: true"`
    : `echo "Now drawing from 'Battery Power'"; echo " -InternalBattery-0 (id=1)	34%; discharging; 1:06 remaining present: true"`);
  sh('claude', `if [ "\${1:-}" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi
{ pwd; for a in "$@"; do printf '%s\\n' "$a"; done; } > "${mocklog}/claude-args.txt"
sleep ${claudeSecs}`);
  sh('caffeinate', `echo "$@" > "${mocklog}/caffeinate-args.txt"
while [ "\${1:-}" != "-w" ] && [ $# -gt 0 ]; do shift; done
pid="\${2:-}"; while kill -0 "$pid" 2>/dev/null; do sleep 1; done`);
  // mock osascript: pulls the `do script "..."` argument and runs it in the background instead of opening a window
  sh('osascript-mock', `touch "${mocklog}/osascript-called"
cmd=""
for a in "$@"; do case "$a" in 'do script "'*) cmd="\${a#do script \\"}"; cmd="\${cmd%\\"}";; esac; done
[ -n "\${MOCK_OSA_FAIL:-}" ] && { echo "osascript: not allowed" >&2; exit 1; }
cmd=$(printf '%s' "$cmd" | sed -e 's/\\\\\\\\/\\\\/g' -e 's/\\\\"/"/g')
printf '%s\\n' "$cmd" > "${mocklog}/osascript-cmd.txt"
nohup bash -c "$cmd" </dev/null >/dev/null 2>&1 &`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    CLOCKWORK_OSASCRIPT: path.join(bin, 'osascript-mock'),
    CLOCKWORK_HEARTBEAT_SECS: '1',
    CLOCKWORK_TICK_SECS: '1',
    CLOCKWORK_MANAGED_SETTINGS: path.join(dir, 'managed-settings.json'), // never read this Mac's real managed file
  };
  delete env.CLAUDE_CONFIG_DIR;
  return { dir, project, bin, home, mocklog, env, plan: path.join(project, 'PM/overnight/OVERNIGHT-PLAN.md') };
}

function run(fx, args = [], extraEnv = {}) {
  const r = spawnSync('bash', [SCRIPT, '--project', fx.project, '--plan', fx.plan, ...args], {
    env: { ...fx.env, ...extraEnv }, encoding: 'utf8', timeout: 120000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const has = (out, re) => assert.match(out, re, out);

test('dry-run on AC power with a complete plan passes and writes nothing', opts, () => {
  const fx = fixture();
  const r = run(fx, ['--dry-run']);
  assert.equal(r.code, 0, r.out);
  has(r.out, /PASS {2}AC power connected/);
  has(r.out, /PASS {2}claude 2\.1\.285/);
  has(r.out, /PASS {2}plan: goal set/);
  has(r.out, /PASS {2}stop time 06:00/);
  has(r.out, /WARN {2}keep the lid OPEN/);
  has(r.out, /WARN {2}weekly usage limit/);
  has(r.out, /WARN {2}background commands stop after 30 min/);
  has(r.out, /Mac sleep|after >30 min of Mac sleep/);
  has(r.out, /DRY-RUN OK/);
  assert.ok(!fs.existsSync(path.join(fx.project, '.claude/.state')), 'dry-run must not create .state');
  assert.ok(!fs.existsSync(path.join(fx.mocklog, 'osascript-called')), 'dry-run must not call osascript');
});

test('battery power is refused, and only --allow-battery turns it into a warning', opts, () => {
  const fx = fixture({ power: 'battery' });
  const refused = run(fx, ['--dry-run']);
  assert.equal(refused.code, 1, refused.out);
  has(refused.out, /FAIL {2}on battery power/);
  has(refused.out, /PREFLIGHT FAILED/);
  const allowed = run(fx, ['--dry-run', '--allow-battery']);
  assert.equal(allowed.code, 0, allowed.out);
  has(allowed.out, /WARN {2}ON BATTERY, allowed by --allow-battery/);
});

test('claude older than 2.1.234 fails; 2.1.234 itself passes', opts, () => {
  const old = run(fixture({ version: '2.1.233' }), ['--dry-run']);
  assert.equal(old.code, 1, old.out);
  has(old.out, /FAIL {2}claude 2\.1\.233 is older than 2\.1\.234/);
  const edge = run(fixture({ version: '2.1.234' }), ['--dry-run']);
  assert.equal(edge.code, 0, edge.out);
});

test('each missing plan field fails by name', opts, () => {
  const cases = [
    [/^Goal:.*\n/m, /FAIL {2}plan: 'Goal:'/],
    [/^Verification command:.*\n/m, /FAIL {2}plan: 'Verification command:'/],
    [/^Stop time:.*\n/m, /FAIL {2}plan: 'Stop time:' must be HH:MM/],
    [/^Turn cap:.*\n/m, /FAIL {2}plan: 'Turn cap:'/],
    [/^Spend cap:.*\n/m, /FAIL {2}plan: 'Spend cap:'/],
    [/## Authority scope[\s\S]*?(?=## Bucket 1)/, /FAIL {2}plan: '## Authority scope'/],
    [/## Bucket 2[\s\S]*?(?=## Bucket 3)/, /FAIL {2}plan: '## Bucket 2'/],
  ];
  for (const [remove, expected] of cases) {
    const fx = fixture({ plan: VALID_PLAN.replace(remove, '') });
    const r = run(fx, ['--dry-run']);
    assert.equal(r.code, 1, `${expected}\n${r.out}`);
    has(r.out, expected);
  }
});

test('the unfilled plan template is refused', opts, () => {
  const tpl = fs.readFileSync(path.join(SKILL_DIR, 'plan-template.md'), 'utf8');
  const r = run(fixture({ plan: tpl }), ['--dry-run']);
  assert.equal(r.code, 1, r.out);
  has(r.out, /FAIL {2}plan: 'Goal:'/);
  has(r.out, /FAIL {2}plan: 'Verification command:'/);
  has(r.out, /FAIL {2}plan: 'Turn cap:'/);
  has(r.out, /FAIL {2}plan: '## Bucket 1'/);
});

test('missing plan file and missing overnight-settings.json fail', opts, () => {
  const a = run(fixture({ plan: null }), ['--dry-run']);
  assert.equal(a.code, 1, a.out);
  has(a.out, /FAIL {2}plan file not found/);
  const b = run(fixture({ settingsFile: false }), ['--dry-run']);
  assert.equal(b.code, 1, b.out);
  has(b.out, /FAIL {2}\.claude\/overnight-settings\.json is missing/);
});

test('--until overrides the plan stop time and is reported', opts, () => {
  const r = run(fixture(), ['--dry-run', '--until', '07:30']);
  assert.equal(r.code, 0, r.out);
  has(r.out, /WARN {2}--until 07:30 overrides the plan's stop time 06:00/);
  has(r.out, /PASS {2}stop time 07:30/);
  const bad = run(fixture(), ['--dry-run', '--until', '7pm']);
  assert.equal(bad.code, 1, bad.out);
  has(bad.out, /FAIL {2}stop time '7pm' is not HH:MM/);
});

test('stale lock (dead PID) warns; a live run holding the lock fails', opts, () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.project, '.claude/.state'), { recursive: true });
  const lock = path.join(fx.project, '.claude/.state/overnight.lock');
  // a PID that is certainly dead
  const dead = spawnSync('bash', ['-c', 'sleep 0 & echo $!; wait']).stdout.toString().trim();
  fs.writeFileSync(lock, `pid=${dead}\nclaude_pid=${dead}\nname=old-run\n`);
  const stale = run(fx, ['--dry-run']);
  assert.equal(stale.code, 0, stale.out);
  has(stale.out, /WARN {2}stale lock from a dead run/);
  assert.ok(fs.existsSync(lock), 'dry-run must not delete the stale lock');

  // a live process whose command line contains overnight.sh
  const live = spawn('bash', ['-c', 'exec -a overnight.sh sleep 60'], { stdio: 'ignore', detached: true });
  spawned.push(live.pid);
  fs.writeFileSync(lock, `pid=${live.pid}\nname=live-run\n`);
  const busy = run(fx, ['--dry-run']);
  assert.equal(busy.code, 1, busy.out);
  has(busy.out, /FAIL {2}another overnight run is live/);
  has(busy.out, /live-run/);

  // a live PID that is NOT overnight.sh/claude (recycled PID) does not block
  const other = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
  spawned.push(other.pid);
  fs.writeFileSync(lock, `pid=${other.pid}\nname=recycled\n`);
  const recycled = run(fx, ['--dry-run']);
  assert.equal(recycled.code, 0, recycled.out);
  has(recycled.out, /WARN {2}stale lock/);
});

test('a project or local autoContinueAtUsageLimit override is detected', opts, () => {
  const a = run(fixture({ projectSettings: '{ "autoContinueAtUsageLimit": true }' }), ['--dry-run']);
  assert.equal(a.code, 1, a.out);
  has(a.out, /FAIL .*settings\.json sets autoContinueAtUsageLimit: a project\/local value turns auto-continue OFF/);
  const b = run(fixture({ localSettings: '{ "autoContinueAtUsageLimit": false }' }), ['--dry-run']);
  assert.equal(b.code, 1, b.out);
  has(b.out, /FAIL .*settings\.local\.json sets autoContinueAtUsageLimit/);
  const c = run(fixture({ userSettings: '{ "autoContinueAtUsageLimit": false }' }), ['--dry-run']);
  assert.equal(c.code, 1, c.out);
  has(c.out, /FAIL {2}user settings .* turn autoContinueAtUsageLimit OFF/);
  const clean = run(fixture({ projectSettings: '{ "hooks": {} }' }), ['--dry-run']);
  assert.equal(clean.code, 0, clean.out);
  has(clean.out, /PASS {2}no settings file turns autoContinueAtUsageLimit off/);
});

test('project override is only a warning when overnight-settings.json sets it true', opts, () => {
  const fx = fixture({ projectSettings: '{ "autoContinueAtUsageLimit": false }' });
  const f = path.join(fx.project, '.claude/overnight-settings.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.autoContinueAtUsageLimit = true;
  fs.writeFileSync(f, JSON.stringify(j));
  const r = run(fx, ['--dry-run']);
  assert.equal(r.code, 0, r.out);
  has(r.out, /WARN {2}settings\.json sets autoContinueAtUsageLimit, but/);
});

test('auto mode turned off by any settings file fails the preflight; the fallback to Manual is a WARN to look at the window', opts, () => {
  const fx = fixture({ localSettings: JSON.stringify({ permissions: { disableAutoMode: 'disable' } }) });
  const r = run(fx, ['--dry-run']);
  assert.equal(r.code, 1, r.out);
  has(r.out, /FAIL {2}auto mode is turned off by disableAutoMode "disable" in: .*settings\.local\.json/);
  const fx2 = fixture();
  fs.writeFileSync(fx2.env.CLOCKWORK_MANAGED_SETTINGS, JSON.stringify({ disableAutoMode: 'disable' }));
  has(run(fx2, ['--dry-run']).out, /FAIL {2}auto mode is turned off .*managed-settings\.json/);
  const ok = run(fixture(), ['--dry-run']);
  has(ok.out, /PASS {2}no settings file turns auto mode off/); has(ok.out, /WARN {2}auto mode can still be unavailable.*confirm its mode shows auto/);
});

test('an empty commands.previewDeploy is a WARN naming how to get a preview; a set one passes', opts, () => {
  has(run(fixture(), ['--dry-run']).out, /WARN {2}clockwork\.json commands\.previewDeploy is empty.*git push -u origin <branch>.*every item ends FLAGGED/);
  const fx = fixture();
  fs.writeFileSync(path.join(fx.project, '.claude/clockwork.json'), JSON.stringify({ stack: 'nextjs', commands: { previewDeploy: 'vercel deploy' }, overnight: { stopAt: '06:00', sessionName: 'x-overnight' } }));
  has(run(fx, ['--dry-run']).out, /PASS {2}clockwork\.json commands\.previewDeploy is set/);
});

test('usage errors exit 2', opts, () => {
  const a = spawnSync('bash', [SCRIPT, '--plan', 'x'], { encoding: 'utf8' });
  assert.equal(a.status, 2);
  const b = spawnSync('bash', [SCRIPT, '--bogus'], { encoding: 'utf8' });
  assert.equal(b.status, 2);
  const c = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(c.status, 0);
  assert.match(c.stdout, /--allow-battery/);
});

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
  return null;
}

test('launch with mocks: window command, PID handoff, caffeinate -w, heartbeat, stop time, lock release', opts, async () => {
  const fx = fixture({ claudeSecs: 7 });
  fs.writeFileSync(path.join(fx.home, '.claude', 'clockwork-overnight-deny.json'), JSON.stringify(['mcp__claude_ai_Client_Wordpress']));
  const stopEpoch = Math.floor(Date.now() / 1000) + 3;
  const r = run(fx, [], { CLOCKWORK_STOP_EPOCH: String(stopEpoch) });
  assert.equal(r.code, 0, r.out);
  has(r.out, /LAUNCHED name=casa-lumen-overnight claude_pid=\d+/);
  const claudePid = Number(r.out.match(/claude_pid=(\d+)/)[1]);
  spawned.push(claudePid);

  const state = path.join(fx.project, '.claude/.state');
  const log = fs.readdirSync(state).find((f) => /^overnight-\d{4}-\d{2}-\d{2}\.log$/.test(f));
  assert.ok(log, 'dated heartbeat log exists');
  const logPath = path.join(state, log);
  assert.ok(fs.existsSync(path.join(state, 'overnight.lock')), 'lock exists while running');
  assert.match(fs.readFileSync(path.join(state, 'overnight.lock'), 'utf8'), /^pid=\d+\nclaude_pid=\d+/);

  // the mock claude got exactly the documented flags, the project as cwd, and /goal as the initial prompt
  const args = await waitFor(() => fs.existsSync(path.join(fx.mocklog, 'claude-args.txt')) && fs.readFileSync(path.join(fx.mocklog, 'claude-args.txt'), 'utf8'));
  assert.ok(args, 'claude mock was started by the launcher');
  const lines = args.trim().split('\n');
  assert.equal(fs.realpathSync(lines[0]), fs.realpathSync(fx.project), 'cwd is the project (path has a space)');
  assert.deepEqual(lines.slice(1, 6), ['-n', 'casa-lumen-overnight', '--permission-mode', 'auto', '--settings']);
  assert.equal(lines[6], '.claude/.state/overnight-settings.json', 'the merged, gitignored settings file');
  const merged = JSON.parse(fs.readFileSync(path.join(fx.project, '.claude/.state/overnight-settings.json'), 'utf8'));
  assert.deepEqual(merged.permissions.deny.slice(0, 3), JSON.parse(fs.readFileSync(SETTINGS_TEMPLATE, 'utf8')).permissions.deny.slice(0, 3));
  assert.ok(merged.permissions.deny.includes('mcp__claude_ai_Client_Wordpress'), "this Mac's deny rules are merged in");
  assert.match(lines[7], /every Bucket 1 item in PM\/overnight\/OVERNIGHT-PLAN\.md/);
  assert.match(lines[7], /^\/goal all 12 pages pass the mobile check at 390px/);
  assert.match(lines[7], /node scripts\/check-mobile\.mjs/);
  assert.match(lines[7], /stop time 06:00/);
  assert.match(lines[7], /150 turns/);
  assert.ok(!args.includes('bypassPermissions') && !args.includes('--dangerously-skip-permissions'));
  assert.match(fs.readFileSync(path.join(fx.mocklog, 'osascript-cmd.txt'), 'utf8'), /overnight-launch\.sh/);

  // caffeinate -i -s -w <claude pid>
  const caff = await waitFor(() => fs.existsSync(path.join(fx.mocklog, 'caffeinate-args.txt')) && fs.readFileSync(path.join(fx.mocklog, 'caffeinate-args.txt'), 'utf8'));
  assert.equal(caff.trim(), `-i -s -w ${claudePid}`);

  // heartbeat streams lines; STOP TIME REACHED is written; heartbeat ends when claude dies; lock released
  const stopped = await waitFor(() => /STOP TIME REACHED/.test(fs.readFileSync(logPath, 'utf8')));
  assert.ok(stopped, 'STOP TIME REACHED written\n' + fs.readFileSync(logPath, 'utf8'));
  const exited = await waitFor(() => /CLAUDE EXITED/.test(fs.readFileSync(logPath, 'utf8')), 30000);
  const text = fs.readFileSync(logPath, 'utf8');
  assert.ok(exited, 'heartbeat noticed the exit\n' + text);
  assert.match(text, /OVERNIGHT START name=casa-lumen-overnight/);
  assert.match(text, /heartbeat claude_pid=\d+ alive=yes minutes_to_stop=/);
  assert.match(text, /ledger: \(none at /);
  const gone = await waitFor(() => !fs.existsSync(path.join(state, 'overnight.lock')), 10000);
  assert.ok(gone, 'lock removed after claude exits');
});

test('the heartbeat prints the last ledger lines', opts, async () => {
  const fx = fixture({ claudeSecs: 4 });
  fs.writeFileSync(path.join(fx.project, 'PM/overnight/OVERNIGHT-LEDGER.md'), '| 02:10 | T-5 built | $12 |\n| 02:40 | T-5 verified | $15 |\n');
  const r = run(fx, [], { CLOCKWORK_STOP_EPOCH: String(Math.floor(Date.now() / 1000) + 600) });
  assert.equal(r.code, 0, r.out);
  spawned.push(Number(r.out.match(/claude_pid=(\d+)/)[1]));
  const state = path.join(fx.project, '.claude/.state');
  const logPath = path.join(state, fs.readdirSync(state).find((f) => f.endsWith('.log')));
  assert.ok(await waitFor(() => /ledger: \| 02:40 \| T-5 verified/.test(fs.readFileSync(logPath, 'utf8'))), fs.readFileSync(logPath, 'utf8'));
  assert.ok(await waitFor(() => /CLAUDE EXITED/.test(fs.readFileSync(logPath, 'utf8')), 30000));
});

test('a failing window opener aborts the launch and releases the lock', opts, () => {
  const fx = fixture();
  const r = run(fx, [], { MOCK_OSA_FAIL: '1' });
  assert.equal(r.code, 1, r.out);
  has(r.out, /FAIL {2}opening the Terminal window failed/);
  assert.ok(!fs.existsSync(path.join(fx.project, '.claude/.state/overnight.lock')), 'lock released');
});

test('a second launch while one is live is refused before any window opens', opts, async () => {
  const fx = fixture({ claudeSecs: 6 });
  const far = String(Math.floor(Date.now() / 1000) + 600);
  const first = run(fx, [], { CLOCKWORK_STOP_EPOCH: far });
  assert.equal(first.code, 0, first.out);
  spawned.push(Number(first.out.match(/claude_pid=(\d+)/)[1]));
  fs.rmSync(path.join(fx.mocklog, 'osascript-called'), { force: true });
  const second = run(fx, [], { CLOCKWORK_STOP_EPOCH: far });
  assert.equal(second.code, 1, second.out);
  has(second.out, /FAIL {2}another overnight run is live/);
  assert.ok(!fs.existsSync(path.join(fx.mocklog, 'osascript-called')), 'no second window');
  assert.ok(await waitFor(() => !fs.existsSync(path.join(fx.project, '.claude/.state/overnight.lock')), 30000), 'first run cleans up');
});

test('skill files: frontmatter, size budgets, verified facts named', () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const plan = fs.readFileSync(path.join(SKILL_DIR, 'plan-template.md'), 'utf8');
  assert.match(skill, /^---\nname: overnight\n/);
  assert.match(skill, /\ndisable-model-invocation: true\n/);
  assert.match(skill, /\ndescription: .{40,}/);
  assert.ok(Buffer.byteLength(skill) <= 10240, `SKILL.md ${Buffer.byteLength(skill)} B > 10 KB`);
  assert.ok(Buffer.byteLength(plan) <= 3072, `plan-template.md ${Buffer.byteLength(plan)} B > 3 KB`);
  for (const needle of ['overnight.sh', '--dry-run', 'date', 'OPEN-ASKS', '/schedule', 'handover', 'sitemap/IA', 'never override a design sign-off', '3 blocked actions in a row', 'Remote Control', 'every Bucket 1 item', '06:00']) {
    assert.ok(skill.includes(needle), `SKILL.md mentions ${needle}`);
  }
  assert.ok(!/no other order has a source|then project rules, then current code/.test(skill + plan), 'the unsourced ranking (L35 failed verification) is gone');
  assert.ok(plan.includes('sitemap/IA'), 'plan-template carries the sourced ranking');
  assert.ok(!/long builds go through a subagent/.test(skill), 'no unsupported subagent advice');
  assert.ok(!/bypassPermissions/.test(skill.replace(/never[^.\n]*bypassPermissions[^.\n]*/i, '')), 'skill never tells anyone to use bypassPermissions');
  // the plan template carries every field the launcher checks
  for (const field of ['Goal:', 'Verification command:', 'Stop time:', 'Turn cap:', 'Spend cap:', '## Authority scope', '## Bucket 1', '## Bucket 2', '## Bucket 3']) {
    assert.ok(plan.includes(field), `plan-template has ${field}`);
  }
});

test('overnight.sh is executable and passes bash -n', opts, () => {
  assert.ok(fs.statSync(SCRIPT).mode & 0o111, 'executable bit set');
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('preflight: Remote Control, unknown MCP servers, deploy scripts the guard misses, /goal length', opts, () => {
  const fx = fixture({ userSettings: '{"remoteControlAtStartup": true}', files: { '.claude/scripts/deploy-theme-ftp.py': 'x', '.claude/scripts/measure.py': 'x' } });
  fs.writeFileSync(path.join(fx.home, '.claude.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(fx.home, '.claude.json'), 'utf8')), mcpServers: { 'resend-agency': {}, 'mailer-x': {}, 'chrome-devtools': {} } }));
  const r = run(fx, ['--dry-run']);
  has(r.out, /PASS {2}Remote Control off for the night window/);
  has(r.out, /WARN {2}MCP server\(s\) with no overnight deny rule: resend-agency mailer-x\./);
  has(r.out, /WARN {2}claude\.ai connectors \(mcp__claude_ai_\*\) and plugin MCP servers \(mcp__plugin_\*\) are in no file this check can read/);
  assert.doesNotMatch(r.out, /PASS {2}every configured MCP server/, 'never a PASS for servers it cannot see');
  has(r.out, /WARN {2}no .*clockwork-overnight-deny\.json: each client's own connectors/);
  has(r.out, /PASS {2}production deploy paths blocked overnight \(1 found/);
  has(r.out, /WARN {2}clockwork\.json commands\.productionDeploy is empty/);
  has(r.out, /PASS {2}\/goal condition is \d+ characters/);
  has(r.out, /WARN {2}auto mode pauses and waits for a person after 3 blocked actions in a row or 20 in total/);
  has(r.out, /WARN {2}the first launch of each saved workflow in auto mode asks for consent once: run \/verify-change and \/build-slices/);
  assert.equal(r.code, 0, r.out);

  const noRc = fixture({ userSettings: '{"remoteControlAtStartup": true}' });
  const f = path.join(noRc.project, '.claude/overnight-settings.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8')); delete j.remoteControlAtStartup; fs.writeFileSync(f, JSON.stringify(j));
  has(run(noRc, ['--dry-run']).out, /FAIL {2}user settings turn Remote Control on at startup/);

  const open = fixture({ files: { '.claude/clockwork.json': JSON.stringify({ commands: { productionDeploy: 'lftp -f push.txt' }, productionPatterns: ['vercel --prod'] }) } });
  const o = run(open, ['--dry-run']);
  assert.equal(o.code, 0, 'productionDeploy is turned into a pattern, so it is covered\n' + o.out);
  const noGuard = fixture({ guard: false });
  has(run(noGuard, ['--dry-run']).out, /FAIL {2}.*guard-bash\.mjs is missing/);

  const long = fixture({ plan: VALID_PLAN.replace('Goal: all 12 pages pass the mobile check at 390px', `Goal: ${'x'.repeat(4100)}`) });
  has(run(long, ['--dry-run']).out, /FAIL {2}the \/goal condition is \d+ characters, over the 4,000 limit/);
});

test('the heartbeat writes a STALLED line when the ledger does not change', opts, async () => {
  const fx = fixture({ claudeSecs: 5 });
  const r = run(fx, [], { CLOCKWORK_STOP_EPOCH: String(Math.floor(Date.now() / 1000) + 600), CLOCKWORK_STALL_SECS: '1' });
  assert.equal(r.code, 0, r.out);
  spawned.push(Number(r.out.match(/claude_pid=(\d+)/)[1]));
  const state = path.join(fx.project, '.claude/.state');
  const logPath = path.join(state, fs.readdirSync(state).find((f) => f.endsWith('.log')));
  assert.ok(await waitFor(() => /STALLED\? no ledger change/.test(fs.readFileSync(logPath, 'utf8'))), fs.readFileSync(logPath, 'utf8'));
  assert.ok(await waitFor(() => /CLAUDE EXITED/.test(fs.readFileSync(logPath, 'utf8')), 30000));
});

test('--plan elsewhere: the /goal names that file, not a fixed path; a bad per-Mac deny file fails', opts, async () => {
  const fx = fixture({ claudeSecs: 3 });
  const other = path.join(fx.dir, 'plans', 'tonight plan.md');
  fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, VALID_PLAN);
  fs.rmSync(fx.plan);
  const r = spawnSync('bash', [SCRIPT, '--project', fx.project, '--plan', other], { env: { ...fx.env, CLOCKWORK_STOP_EPOCH: String(Math.floor(Date.now() / 1000) + 600) }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  spawned.push(Number(r.stdout.match(/claude_pid=(\d+)/)[1]));
  const args = await waitFor(() => fs.existsSync(path.join(fx.mocklog, 'claude-args.txt')) && fs.readFileSync(path.join(fx.mocklog, 'claude-args.txt'), 'utf8'));
  const goal = args.trim().split('\n')[7];
  assert.ok(goal.includes(fs.realpathSync(other)), goal);
  assert.doesNotMatch(goal, /OVERNIGHT-PLAN\.md/, 'no file the preflight never read');
  const bad = fixture();
  fs.writeFileSync(path.join(bad.home, '.claude', 'clockwork-overnight-deny.json'), '{"deny": "not a list"}');
  has(run(bad, ['--dry-run']).out, /FAIL {2}.*clockwork-overnight-deny\.json is not a JSON array of deny rules/);
});
