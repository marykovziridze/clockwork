// Tests for install.mjs (CONTRACT §1, §3, §4). Offline; fake templates tree + projects in os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw installer test ')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const put = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); if (mode) fs.chmodSync(p, mode); };
const read = (p) => fs.readFileSync(p, 'utf8');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const DOCTOR_CMD = 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/clockwork-doctor.mjs';
const START_CMD = 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start.mjs';

let n = 0;
function kit() {
  const k = path.join(TMP, `kit ${++n}`);
  const t = path.join(k, 'templates');
  put(path.join(k, 'VERSION'), '2.0.0\n');
  put(path.join(t, 'AGENTS.md'), '# Agents v1\n');
  put(path.join(t, 'CLAUDE.md'), '@AGENTS.md\n');
  put(path.join(t, 'clockwork.json'), JSON.stringify({ clockworkVersion: '0.0.0', project: 'Acme', stack: 'nextjs', registryDir: '.claude', overnight: { stopAt: '06:00', sessionName: 'acme-overnight' } }));
  put(path.join(t, 'worktreeinclude'), '# comment\n.env\n.env.*\n');
  put(path.join(t, 'registries', 'TASKS.md'), '# TASKS\n');
  put(path.join(t, 'claude', 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: START_CMD, timeout: 45 }] }],
    Stop: [{ hooks: [{ type: 'command', command: DOCTOR_CMD, timeout: 60 }] }],
  } }));
  put(path.join(t, 'claude', 'hooks', 'clockwork-doctor.mjs'), '// doctor v2\n');
  put(path.join(t, 'claude', 'hooks', 'session-start.mjs'), '// start v2\n');
  put(path.join(t, 'claude', 'tools', 'overnight.sh'), '#!/usr/bin/env bash\n', 0o755);
  put(path.join(t, 'claude', 'tools', 'registry.mjs'), '// registry\n');
  put(path.join(t, 'claude', 'tools', 'registry 2.mjs'), '// icloud dup\n');
  put(path.join(t, 'claude', 'rules', 'stack-nextjs.md'), '# next\n');
  put(path.join(t, 'claude', 'rules', 'stack-wordpress.md'), '# wp\n');
  put(path.join(t, 'claude', 'rules', 'registries.md'), '# registries\n');
  put(path.join(t, 'claude', 'rules', 'design-system.md'), '# design\n');
  put(path.join(t, 'claude', 'skills', 'intake', 'SKILL.md'), '# intake\n');
  put(path.join(t, 'claude', 'skills', 'intake', 'routing.md'), '# routing\n');
  return t;
}
function proj(name = 'Client Proj') {
  const p = path.join(TMP, `${name} ${++n}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function run(tpl, args, env = {}) {
  const r = spawnSync(process.execPath, [INSTALL, ...args], { env: { ...process.env, CLOCKWORK_TEMPLATES: tpl, CLOCKWORK_SYNCED_ROOTS: '', ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); out[path.relative(dir, p)] = `${sha(p)}:${s.mtimeMs}`; } } };
  walk(dir);
  return out;
}
const row = (out, file) => out.split('\n').find((l) => l.split(/\s+/)[1] === file) || '';
const manifest = (p) => JSON.parse(read(path.join(p, '.claude', '.clockwork-manifest.json')));

test('dry run (the default) writes nothing and prints the plan', () => {
  const t = kit(); const p = proj();
  put(path.join(p, 'package.json'), JSON.stringify({ dependencies: { next: '16' } }));
  const before = snapshot(p);
  const r = run(t, [p]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRY RUN/);
  assert.match(row(r.out, 'AGENTS.md'), /^create/);
  assert.match(r.out, /stack nextjs \(package\.json lists next\)/);
  assert.deepEqual(snapshot(p), before);
});

test('fresh install: mapping, owned vs managed, stack profile, gitignore, manifest, exec bit', () => {
  const t = kit(); const p = proj();
  const r = run(t, [p, '--apply', '--stack', 'nextjs', '--project', 'Acme Hotel']);
  assert.equal(r.code, 0, r.out);
  for (const f of ['AGENTS.md', 'CLAUDE.md', '.worktreeinclude', '.claude/TASKS.md', '.claude/settings.json', '.claude/hooks/clockwork-doctor.mjs',
    '.claude/rules/stack-nextjs.md', '.claude/rules/design-system.md', '.claude/skills/intake/routing.md', '.claude/tools/overnight.sh']) assert.ok(fs.existsSync(path.join(p, f)), f);
  assert.ok(!fs.existsSync(path.join(p, '.claude/rules/stack-wordpress.md')), 'other stack profile skipped');
  assert.ok(!fs.existsSync(path.join(p, '.claude/tools/registry 2.mjs')), 'iCloud dup in kit skipped');
  const cfg = JSON.parse(read(path.join(p, '.claude/clockwork.json')));
  assert.equal(cfg.project, 'Acme Hotel'); assert.equal(cfg.stack, 'nextjs'); assert.equal(cfg.clockworkVersion, '2.0.0');
  assert.equal(cfg.overnight.sessionName, 'acme-hotel-overnight');
  const m = manifest(p);
  assert.equal(m.version, '2.0.0');
  assert.ok(m.files['.claude/hooks/clockwork-doctor.mjs'] && m.files['.claude/skills/intake/SKILL.md'] && m.files['.claude/rules/stack-nextjs.md']);
  for (const owned of ['AGENTS.md', '.claude/clockwork.json', '.claude/skills/intake/routing.md', '.claude/rules/design-system.md', '.claude/TASKS.md', '.claude/settings.json'])
    assert.equal(m.files[owned], undefined, `${owned} not managed`);
  const gi = read(path.join(p, '.gitignore'));
  for (const l of ['.claude/.state/', '.claude/worktrees/', '.claude/.clockwork-backups/', 'PM/.scratch/']) assert.ok(gi.includes(l), l);
  assert.ok(fs.statSync(path.join(p, '.claude/tools/overnight.sh')).mode & 0o100, 'exec bit kept');
});

test('re-run is idempotent: nothing changes on disk', () => {
  const t = kit(); const p = proj();
  assert.equal(run(t, [p, '--apply', '--stack', 'python']).code, 0);
  const before = snapshot(p);
  const r = run(t, [p, '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 create · 0 replace · 0 merge · \d+ keep · 0 conflict/);
  assert.match(r.out, /stack python \(clockwork\.json\)/);
  assert.deepEqual(snapshot(p), before);
});

test('upgrade: unchanged managed files replaced, project-owned files never overwritten', () => {
  const t = kit(); const p = proj();
  run(t, [p, '--apply', '--stack', 'nextjs']);
  put(path.join(p, 'AGENTS.md'), '# our own rules\n');
  put(path.join(t, 'AGENTS.md'), '# Agents v2\n');
  put(path.join(t, 'claude', 'hooks', 'session-start.mjs'), '// start v3\n');
  put(path.join(t, 'claude', 'agents', 'verifier.md'), '# verifier\n');
  const r = run(t, [p, '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.match(row(r.out, '.claude/hooks/session-start.mjs'), /^replace/);
  assert.match(row(r.out, '.claude/agents/verifier.md'), /^create/);
  assert.equal(read(path.join(p, '.claude/hooks/session-start.mjs')), '// start v3\n');
  assert.equal(read(path.join(p, 'AGENTS.md')), '# our own rules\n');
  assert.equal(manifest(p).files['.claude/hooks/session-start.mjs'], sha(path.join(p, '.claude/hooks/session-start.mjs')));
});

test('conflict: a locally edited managed file is left alone; --force-managed backs it up then replaces', () => {
  const t = kit(); const p = proj();
  run(t, [p, '--apply', '--stack', 'nextjs']);
  const f = path.join(p, '.claude/hooks/clockwork-doctor.mjs');
  put(f, '// local fix\n');
  put(path.join(t, 'claude', 'hooks', 'clockwork-doctor.mjs'), '// doctor v3\n');
  const r = run(t, [p, '--apply']);
  assert.equal(r.code, 1, r.out);
  assert.match(row(r.out, '.claude/hooks/clockwork-doctor.mjs'), /^conflict .*edited locally/);
  assert.equal(read(f), '// local fix\n');
  const r2 = run(t, [p, '--apply', '--force-managed']);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(read(f), '// doctor v3\n');
  const bdir = path.join(p, '.claude/.clockwork-backups');
  const [stamp] = fs.readdirSync(bdir);
  assert.equal(read(path.join(bdir, stamp, '.claude/hooks/clockwork-doctor.mjs')), '// local fix\n');
});

test('D15: a project with its own root or docs/ task list is refused (no second, empty .claude/TASKS.md); AGENTS.md alone is a new project', () => {
  const t = kit();
  for (const rec of ['TASKS.md', 'docs/tasks.md', 'docs/DECISIONS.md']) {
    const p = proj('Case B');
    put(path.join(p, 'CLAUDE.md'), '# Own rules\n- use pnpm\n'); put(path.join(p, rec), '| ID | Task | Status |\n|---|---|---|\n| T-1 | x | open |\n');
    const before = snapshot(p);
    const r = run(t, [p, '--apply', '--stack', 'other']);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /ERR refused: existing project — onboard it with \/clockwork-onboard \(decision D15\)/);
    assert.ok(r.out.includes(rec), `names ${rec}`);
    assert.deepEqual(snapshot(p), before, `${rec}: nothing written`);
  }
  const fresh = proj('Next app'); put(path.join(fresh, 'AGENTS.md'), '<!-- BEGIN:nextjs-agent-rules -->\n# This is NOT the Next.js you know\n'); put(path.join(fresh, 'CLAUDE.md'), '@AGENTS.md\n');
  const ok = run(t, [fresh, '--apply', '--stack', 'nextjs']);
  assert.equal(ok.code, 0, ok.out); assert.ok(fs.existsSync(path.join(fresh, '.claude/TASKS.md')));
});

test('AGENTS.md names the stack profile only when one ships: other/python get no dead pointer; the doctor sees no dead path (final round)', () => {
  const REAL = path.resolve(path.dirname(INSTALL), 'templates');
  for (const [stack, want] of [['other', null], ['python', null], ['nextjs', 'stack-nextjs.md'], ['wordpress', 'stack-wordpress.md']]) {
    const p = proj(`Stack ${stack}`);
    const r = run(REAL, [p, '--stack', stack, '--apply']);
    assert.equal(r.code, 0, r.out);
    const row = read(path.join(p, 'AGENTS.md')).split('\n').find((l) => l.startsWith('| Code rules'));
    if (want) { assert.ok(row.includes(`\`.claude/rules/${want}\``), row); assert.ok(fs.existsSync(path.join(p, '.claude/rules', want))); }
    else assert.doesNotMatch(row, /stack-/, row);
    assert.doesNotMatch(row, /if shipped/);
    const d = spawnSync(process.execPath, [path.join(p, '.claude/hooks/clockwork-doctor.mjs'), '--report', '--json', '--root', p], { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: '' }) });
    assert.ok(!JSON.parse(d.stdout).warns.some((w) => w.code === 'DEADREF' && /stack-/.test(w.item)), `${stack}: ${d.stdout.slice(0, 400)}`);
  }
});

test('v1 project: refused without --adopt; --adopt backs up, replaces, merges settings without duplicates', () => {
  const t = kit(); const p = proj('Casa Lumen');
  put(path.join(p, '.claude/hooks/clockwork-doctor.mjs'), '// v1 doctor\n');
  put(path.join(p, 'CLAUDE.md'), '# Casa Lumen\n');
  const v1Stop = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/clockwork-doctor.mjs"';
  put(path.join(p, '.claude/settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node guard.mjs' }] }],
    Stop: [{ hooks: [{ type: 'command', command: v1Stop }] }] } }));
  const before = snapshot(p);
  const r = run(t, [p, '--apply', '--stack', 'wordpress']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /needs --adopt/);
  assert.deepEqual(snapshot(p), before, 'nothing written without --adopt');
  const live = run(t, [p, '--apply', '--adopt', '--stack', 'wordpress']);
  assert.equal(live.code, 1, live.out); assert.match(live.out, /ERR refused: existing project — onboard it with \/clockwork-onboard \(decision D15\)/);
  assert.deepEqual(snapshot(p), before, 'D15: a live folder is never adopted in place');
  put(path.join(p, '.clockwork-onboard', 'discover.json'), '{}'); // onboarding's staging copy
  const r2 = run(t, [p, '--apply', '--adopt', '--stack', 'wordpress']);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(read(path.join(p, '.claude/hooks/clockwork-doctor.mjs')), '// doctor v2\n');
  const bdir = path.join(p, '.claude/.clockwork-backups');
  assert.equal(read(path.join(bdir, fs.readdirSync(bdir)[0], '.claude/hooks/clockwork-doctor.mjs')), '// v1 doctor\n');
  const s = JSON.parse(read(path.join(p, '.claude/settings.json')));
  assert.equal(s.hooks.Stop.flatMap((g) => g.hooks).length, 1, 'doctor not wired twice');
  assert.equal(s.hooks.Stop[0].hooks[0].command, v1Stop);
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, START_CMD);
  assert.equal(read(path.join(p, 'CLAUDE.md')), '# Casa Lumen\n', 'CLAUDE.md not edited');
  assert.match(r2.out, /FIX {3}CLAUDE\.md: make line 1 exactly "@AGENTS\.md"/);
  assert.ok(fs.existsSync(path.join(p, '.claude/rules/stack-wordpress.md')));
  assert.ok(fs.existsSync(path.join(p, '.claude/.clockwork-manifest.json')));
});

test('settings merge adds missing hooks by command, never removes or reorders', () => {
  const t = kit(); const p = proj();
  const cur = { permissions: { allow: ['Bash(ls:*)'] }, model: 'opus', hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node other.mjs' }] }],
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  put(path.join(p, '.claude/settings.json'), JSON.stringify(cur));
  const r = run(t, [p, '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.match(row(r.out, '.claude/settings.json'), /^merge/);
  const s = JSON.parse(read(path.join(p, '.claude/settings.json')));
  assert.deepEqual(s.permissions, cur.permissions); assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command), ['node other.mjs', DOCTOR_CMD], 'existing first, kit hook appended');
  assert.deepEqual(s.hooks.SessionStart[0].hooks.map((h) => h.command), ['echo hi', START_CMD], 'added into the same matcher group, after existing');
  assert.match(row(run(t, [p]).out, '.claude/settings.json'), /^keep/);
});

test('existing .gitignore and .worktreeinclude get only the missing lines appended', () => {
  const t = kit(); const p = proj();
  put(path.join(p, '.gitignore'), 'node_modules/\n/.claude/worktrees');
  put(path.join(p, '.worktreeinclude'), '.env\nconfig/secrets.json\n');
  assert.equal(run(t, [p, '--apply']).code, 0);
  assert.equal(read(path.join(p, '.gitignore')), 'node_modules/\n/.claude/worktrees\n# Clockwork\n.claude/.state/\n.claude/.clockwork-backups/\nPM/.scratch/\n');
  assert.equal(read(path.join(p, '.worktreeinclude')), '.env\nconfig/secrets.json\n.env.*\n');
});

test('synced folder: --apply refused and nothing written; --allow-synced proceeds with a loud warning', () => {
  const t = kit(); const p = proj('Desktop Proj');
  const env = { CLOCKWORK_SYNCED_ROOTS: TMP };
  const before = snapshot(p);
  const dry = run(t, [p], env);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /WARNING: this project is inside a synced folder/);
  const r = run(t, [p, '--apply'], env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /git can hang/); assert.match(r.out, /'name 2\.md' duplicate/);
  assert.match(r.out, /ERR refused: synced folder/);
  assert.deepEqual(snapshot(p), before);
  const r2 = run(t, [p, '--apply', '--allow-synced'], env);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /--allow-synced given/);
  assert.ok(fs.existsSync(path.join(p, 'AGENTS.md')));
});

test('bad arguments exit 1 with usage', () => {
  const t = kit();
  assert.equal(run(t, []).code, 1);
  assert.equal(run(t, [proj(), '--stack', 'rails']).code, 1);
  assert.equal(run(t, [proj(), '--bogus']).code, 1);
  assert.equal(run(t, [path.join(TMP, 'missing dir')]).code, 1);
});

test('project iCloud conflict copies are reported, not touched', () => {
  const t = kit(); const p = proj();
  put(path.join(p, '.claude/TASKS.md'), '# T\n'); put(path.join(p, '.claude/TASKS 2.md'), '# T old\n');
  const r = run(t, [p]);
  assert.match(r.out, /\.claude\/TASKS 2\.md looks like an iCloud conflict copy of TASKS\.md/);
  assert.match(row(r.out, '.claude/TASKS.md'), /^keep/);
});

test('new AGENTS.md gets its {{…}} placeholders filled from clockwork.json; empty values stay as placeholders', () => {
  const t = kit(); const p = proj();
  put(path.join(t, 'AGENTS.md'), '# {{project}}\nStack {{stack}} in `{{registryDir}}/` · build `{{commands.build}}` · {{no.such}}\n');
  const r = run(t, [p, '--stack', 'wordpress', '--project', 'Acme Web', '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(p, 'AGENTS.md')), '# Acme Web\nStack wordpress in `.claude/` · build `{{commands.build}}` · {{no.such}}\n');
  put(path.join(p, 'AGENTS.md'), 'mine\n');
  assert.equal(run(t, [p, '--apply']).code, 0);
  assert.equal(read(path.join(p, 'AGENTS.md')), 'mine\n', 'an existing AGENTS.md is never rewritten');
});

test('registries already in a sub-repo: --apply refuses to create a second copy; --registry-dir installs into them', () => {
  const t = kit(); const p = proj();
  put(path.join(p, 'site', '.claude', 'TASKS.md'), '# TASKS live\n');
  put(path.join(p, 'staging-manifest.json'), '{}'); // an onboarding staging copy (D15)
  const dry = run(t, [p]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /Registries found in site\/\.claude/);
  const r = run(t, [p, '--apply']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ERR refused: registries already exist in site\/\.claude/);
  assert.ok(!fs.existsSync(path.join(p, '.claude', 'TASKS.md')), 'nothing written');
  const ok = run(t, [p, '--registry-dir', 'site/.claude', '--site-dir', 'site', '--apply']);
  assert.equal(ok.code, 0, ok.out);
  const cfg = JSON.parse(read(path.join(p, '.claude', 'clockwork.json')));
  assert.equal(cfg.registryDir, 'site/.claude'); assert.equal(cfg.siteDir, 'site');
  assert.equal(read(path.join(p, 'site', '.claude', 'TASKS.md')), '# TASKS live\n', 'the live registry is kept');
  assert.ok(!fs.existsSync(path.join(p, '.claude', 'TASKS.md')));
  assert.equal(run(t, [p, '--registry-dir', '../x']).code, 1);
});

test('a registry skeleton is not created when that registry already lives in another .claude folder', () => {
  const t = kit(); const p = proj();
  put(path.join(t, 'registries', 'FACTS.md'), '# FACTS skeleton\n');
  put(path.join(p, '.claude', 'FACTS.md'), '# FACTS live at root\n');
  put(path.join(p, 'site', '.claude', 'TASKS.md'), '# TASKS live\n');
  put(path.join(p, '.clockwork-onboard', 'discover.json'), '{}');
  const r = run(t, [p, '--registry-dir', 'site/.claude', '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.match(row(r.out, 'site/.claude/FACTS.md'), /^skip .*\.claude\/FACTS\.md exists — one copy only/);
  assert.ok(!fs.existsSync(path.join(p, 'site', '.claude', 'FACTS.md')));
});

test('after --apply it prints the exact commit command (git init when needed, push when origin exists); running it commits the install', () => {
  const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const t = kit(); const p = proj();
  const r = run(t, [p, '--apply', '--stack', 'nextjs']);
  assert.equal(r.code, 0, r.out);
  const cmd = r.out.split('\n').filter((l) => l.startsWith('NEXT  ')).map((l) => l.slice(6)).find((l) => l.includes(' commit -m '));
  assert.ok(cmd, r.out);
  assert.match(cmd, /git -C ".*" init && /); assert.doesNotMatch(cmd, /push/);
  const sh = spawnSync('bash', ['-c', cmd], { env: GENV, encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stderr);
  const files = spawnSync('git', ['-C', p, 'ls-files'], { env: GENV, encoding: 'utf8' }).stdout;
  for (const f of ['.claude/clockwork.json', '.claude/settings.json', 'AGENTS.md', 'CLAUDE.md', '.claude/hooks/clockwork-doctor.mjs', '.claude/.clockwork-manifest.json', '.gitignore']) assert.ok(files.includes(f), f);
  // a repo with an origin remote: no init, and push is part of the command
  const q = proj();
  for (const a of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', 'https://example.invalid/x.git']]) spawnSync('git', ['-C', q, ...a], { env: GENV });
  const r2 = run(t, [q, '--apply', '--stack', 'nextjs']);
  const cmd2 = r2.out.split('\n').find((l) => l.startsWith('NEXT  ') && l.includes(' commit -m '));
  assert.doesNotMatch(cmd2, / init /); assert.match(cmd2, /&& git -C ".*" push$/);
  assert.match(r2.out, /push too/);
});

test('a v1 DESIGN-SYSTEM.md gets a FIX line; a stack with no profile gets a plain notice', () => {
  const t = kit(); const p = proj();
  put(path.join(p, '.claude', 'DESIGN-SYSTEM.md'), '# old design\n'.repeat(100));
  const r = run(t, [p, '--stack', 'python']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /FIX {3}\.claude\/DESIGN-SYSTEM\.md \(v1 design file, [\d.]+ KB\) is not read by verifiers/);
  assert.match(r.out, /NOTE {2}no stack profile ships for "python" \(only nextjs and wordpress\)/);
  const r2 = run(t, [proj(), '--stack', 'nextjs']);
  assert.doesNotMatch(r2.out, /no stack profile|DESIGN-SYSTEM/);
});

test('a .gitignore that ignores .claude/ on purpose (D13): a NOTE, exit 0, never "un-ignore"; the commit command leaves those paths out', () => {
  const t = kit(); const p = proj();
  fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n.claude/\n');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: p });
  const dry = run(t, [p, '--stack', 'wordpress']);
  assert.equal(dry.code, 0, dry.out); assert.match(dry.out, /NOTE {2}\d+ kit path\(s\) are gitignored by \.gitignore:2 "\.claude\/"/);
  const r = run(t, [p, '--stack', 'wordpress', '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Keeping them ignored is fine \(decision D13\): \.worktreeinclude copies them/);
  assert.doesNotMatch(r.out, /un-ignore|"\.claude\/\*"|!\.claude/i);
  assert.match(r.out.trim().split('\n').pop(), /^OK applied/);
  const next = r.out.split('\n').find((l) => l.includes(' add -- '));
  assert.ok(next, r.out); assert.doesNotMatch(next, /"\.claude\//, 'no ignored path in the commit command'); assert.match(next, /"AGENTS\.md"/);
});

test('check-ignore "!pattern" lines re-include a path: an un-ignored kit path is not reported as ignored', () => {
  const t = kit(); const p = proj();
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: p });
  fs.writeFileSync(path.join(p, '.gitignore'), '.claude/*\n!.claude/settings.json\n!.claude/clockwork.json\n!.claude/hooks/\n!.claude/tools/\n!.claude/rules/\n!.claude/skills/\n!.claude/.clockwork-manifest.json\n');
  const r = run(t, [p, '--stack', 'wordpress', '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /gitignored by .*"!/, 'a negation line is never named as the ignoring rule');
  const r2 = run(t, [p, '--stack', 'wordpress', '--apply']);
  assert.equal(r2.code, 0, r2.out); assert.doesNotMatch(r2.out, /kit path\(s\) are gitignored/);
});

test('the kit .worktreeinclude carries the kit files (not the registries) into worktrees of a project that ignores .claude/', () => {
  const lines = read(path.resolve(path.dirname(INSTALL), 'templates', 'worktreeinclude')).split('\n').filter((l) => l && !l.startsWith('#'));
  for (const l of ['.claude/settings.json', '.claude/clockwork.json', '.claude/hooks/**', '.claude/tools/**', '.claude/rules/**']) assert.ok(lines.includes(l), l);
  assert.ok(!lines.some((l) => /TASKS|CLIENT|\.state|worktrees/.test(l)), 'registries, state and worktrees are never copied');
});

// ── --global-skill: /clockwork-onboard for every project on this Mac (D16) ──────────────────────────────────
test('--global-skill copies the onboarding skill into ~/.claude/skills with the kit path and a version stamp, backing up a changed copy', () => {
  const REAL = path.dirname(INSTALL);
  const k = path.join(TMP, `global kit ${++n}`);
  fs.mkdirSync(k, { recursive: true });
  fs.copyFileSync(INSTALL, path.join(k, 'install.mjs'));
  fs.copyFileSync(path.join(REAL, 'VERSION'), path.join(k, 'VERSION'));
  fs.cpSync(path.join(REAL, 'onboard'), path.join(k, 'onboard'), { recursive: true });
  const home = path.join(TMP, `home ${n}`); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home }; delete env.CLOCKWORK_KIT;
  const run = (...a) => { const r = spawnSync(process.execPath, [path.join(k, 'install.mjs'), ...a], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  const dest = path.join(home, '.claude', 'skills', 'clockwork-onboard');
  // dry run writes nothing
  let r = run('--global-skill');
  assert.equal(r.code, 0, r.out); assert.match(r.out, /OK dry run/); assert.ok(!fs.existsSync(dest));
  // a project folder or another flag is refused
  assert.equal(run('--global-skill', home).code, 1);
  assert.equal(run('--global-skill', '--adopt').code, 1);
  r = run('--global-skill', '--apply');
  assert.equal(r.code, 0, r.out); assert.match(r.out, /OK installed \/clockwork-onboard/);
  for (const f of ['SKILL.md', 'mapping.md', 'plan-template.md', 'workflows/onboard.js', 'clockwork-kit.json']) assert.ok(fs.existsSync(path.join(dest, f)), f);
  assert.equal(read(path.join(dest, 'mapping.md')), read(path.join(k, 'onboard', 'mapping.md')));
  const skill = read(path.join(dest, 'SKILL.md'));
  assert.ok(skill.includes(`KIT="\${CLOCKWORK_KIT:-${k}}"`), 'the copy records this kit as its default');
  assert.ok(!skill.includes('/path/to/clockwork}'), 'the source default is replaced everywhere');
  const stamp = JSON.parse(read(path.join(dest, 'clockwork-kit.json')));
  assert.equal(stamp.clockworkVersion, read(path.join(REAL, 'VERSION')).trim()); assert.equal(stamp.kit, k);
  // the skill's own shell line finds the kit: the recorded path, or $CLOCKWORK_KIT when set
  const line = skill.split('\n').find((l) => l.startsWith('KIT="${CLOCKWORK_KIT:-'));
  const sh = (extra) => spawnSync('bash', ['-c', `${line}; printf %s "$KIT"`], { env: { ...env, ...extra }, encoding: 'utf8' }).stdout;
  assert.equal(sh({}), k); assert.equal(sh({ CLOCKWORK_KIT: '/elsewhere/kit' }), '/elsewhere/kit');
  assert.ok(fs.existsSync(path.join(sh({}), 'onboard', 'onboard.mjs')));
  // re-run: nothing to do, no backup
  r = run('--global-skill', '--apply');
  assert.match(r.out, /already current/); assert.ok(!fs.existsSync(path.join(home, '.claude', 'clockwork-backups')));
  // a hand-edited copy is backed up OUTSIDE ~/.claude/skills, then replaced; no stray file survives
  fs.writeFileSync(path.join(dest, 'SKILL.md'), 'hand edit\n'); fs.writeFileSync(path.join(dest, 'old-note.md'), 'x\n');
  r = run('--global-skill', '--apply');
  assert.equal(r.code, 0, r.out);
  const backups = fs.readdirSync(path.join(home, '.claude', 'clockwork-backups'));
  assert.equal(backups.length, 1); assert.match(backups[0], /^clockwork-onboard-/);
  assert.equal(read(path.join(home, '.claude', 'clockwork-backups', backups[0], 'SKILL.md')), 'hand edit\n');
  assert.equal(read(path.join(dest, 'SKILL.md')), skill); assert.ok(!fs.existsSync(path.join(dest, 'old-note.md')));
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude', 'skills')), ['clockwork-onboard'], 'no second skill folder');
});

// ── 2026-10-01: one version, and nothing from the kit's own .claude/ ever reaches a project ──────────────────────
test('the version lives in VERSION: the doctor constant, the clockwork.json template and the CHANGELOG head agree; README names no number', () => {
  const KITDIR = path.dirname(INSTALL);
  const v = read(path.join(KITDIR, 'VERSION')).trim();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(/const VERSION = '([^']+)'/.exec(read(path.join(KITDIR, 'templates', 'claude', 'hooks', 'clockwork-doctor.mjs')))?.[1], v, 'clockwork-doctor.mjs VERSION');
  assert.equal(JSON.parse(read(path.join(KITDIR, 'templates', 'clockwork.json'))).clockworkVersion, v, 'templates/clockwork.json clockworkVersion');
  assert.equal(/^## (\d+\.\d+\.\d+) /m.exec(read(path.join(KITDIR, 'CHANGELOG.md')))?.[1], v, 'newest CHANGELOG entry');
  assert.doesNotMatch(read(path.join(KITDIR, 'README.md')).split('\n')[0], /\d/, 'README title carries no version to go stale');
});

test('install copies only templates/: a .claude/ folder at the kit root (a live session\'s lock file) never reaches a project', () => {
  const t = kit(); const k = path.dirname(t);
  put(path.join(k, '.claude', 'scheduled_tasks.lock'), '{"sessionId":"live"}');
  put(path.join(k, '.claude', 'settings.local.json'), '{"permissions":{}}');
  const p = proj();
  const r = run(t, [p, '--apply', '--stack', 'nextjs', '--project', 'Lock Test']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /scheduled_tasks|settings\.local/);
  assert.ok(!fs.existsSync(path.join(p, '.claude', 'scheduled_tasks.lock')));
  assert.ok(!fs.existsSync(path.join(p, '.claude', 'settings.local.json')));
  assert.ok(!Object.keys(manifest(p).files).some((f) => /scheduled_tasks|settings\.local/.test(f)));
  // the real kit (templates/ next to this kit's install.mjs), dry run: its plan never names a kit-root .claude/ file
  const real = run(path.join(path.dirname(INSTALL), 'templates'), [proj('Real Kit Dry'), '--stack', 'nextjs']);
  assert.equal(real.code, 0, real.out);
  assert.doesNotMatch(real.out, /scheduled_tasks/);
});
