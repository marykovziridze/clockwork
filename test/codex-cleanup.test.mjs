// Tests for templates/claude/tools/cleanup.mjs and the Codex wiring (templates/codex/hooks.json, CLOCKWORK_HOST=codex
// in guard-bash and guard-edit, install.mjs --codex). Offline. Fixtures under os.tmpdir(), removed at the end.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(KIT, 'templates', 'claude', 'hooks');
const CLEANUP = path.join(KIT, 'templates', 'claude', 'tools', 'cleanup.mjs');
const CODEX_HOOKS = path.join(KIT, 'templates', 'codex', 'hooks.json');
const { patchFiles } = await import(pathToFileURL(path.join(HOOKS, 'guard-edit.mjs')).href);
const { parseWorktrees, parseLsof, classifyProcesses } = await import(pathToFileURL(CLEANUP).href);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-codex-cleanup-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let n = 0;
const mk = (name) => { const d = path.join(TMP, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return fs.realpathSync(d); };
function repo() {
  const d = mk('main');
  g(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a');
  g(d, 'add', 'a.txt'); g(d, 'commit', '-qm', 'init');
  return d;
}
const worktree = (main, name) => { const w = path.join(path.dirname(main), `${path.basename(main)}-${name}`); g(main, 'worktree', 'add', '-q', w, '-b', name); return fs.realpathSync(w); };
const cleanup = (cwd, ...args) => spawnSync(process.execPath, [CLEANUP, ...args], { cwd, encoding: 'utf8', env: GIT_ENV, timeout: 120000 });
const line = (out, dir) => out.split('\n').find((l) => l.includes(` ${dir} `)) || '';
const hasLsof = spawnSync('lsof', ['-v']).error?.code !== 'ENOENT';

describe('cleanup.mjs: parsing', () => {
  test('parseWorktrees reads branch, detached, locked and prunable entries', () => {
    const w = parseWorktrees('worktree /m\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w1\nHEAD bbb\ndetached\n\nworktree /w2\nHEAD ccc\nbranch refs/heads/t2\nlocked busy\n\nworktree /w3\nHEAD ddd\nprunable gitdir file points to non-existent location\n');
    assert.deepEqual(w.map((x) => x.path), ['/m', '/w1', '/w2', '/w3']);
    assert.equal(w[0].branch, 'main');
    assert.equal(w[1].detached, true);
    assert.equal(w[2].locked, 'busy');
    assert.equal(w[3].prunable, true);
  });
  test('parseLsof keeps the first name per process', () => {
    const p = parseLsof('p12\ncnode\nn/a/b\np13\ncnext-server\nn*:3000\nn[::1]:3000\n');
    assert.deepEqual(p, [{ pid: 12, cmd: 'node', name: '/a/b' }, { pid: 13, cmd: 'next-server', name: '*:3000' }]);
  });
});

describe('cleanup.mjs: which task folders may go', () => {
  test('merged + clean is removable; uncommitted files and unmerged commits are kept; dry run removes nothing', () => {
    const main = repo();
    const done = worktree(main, 't1-done');
    const dirty = worktree(main, 't2-dirty');
    fs.writeFileSync(path.join(dirty, 'new.txt'), 'wip');
    const ahead = worktree(main, 't3-ahead');
    fs.writeFileSync(path.join(ahead, 'b.txt'), 'b'); g(ahead, 'add', 'b.txt'); g(ahead, 'commit', '-qm', 'b');
    const r = cleanup(main, '--idle-minutes', '0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(line(r.stdout, done), /^REMOVE .*merged and idle/);
    assert.match(line(r.stdout, dirty), /^KEEP .*1 uncommitted or untracked file/);
    assert.match(line(r.stdout, ahead), /^KEEP .*1 commit\(s\) not on main/);
    assert.match(r.stdout, /Dry run: 1 removable/);
    assert.ok(fs.existsSync(done), 'a dry run deletes nothing');
  });
  test('--apply removes only the removable folder and keeps its branch', () => {
    const main = repo();
    const done = worktree(main, 't1-done');
    const dirty = worktree(main, 't2-dirty');
    fs.writeFileSync(path.join(dirty, 'new.txt'), 'wip');
    const r = cleanup(main, '--idle-minutes', '0', '--apply');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK removed .*\(branch t1-done kept\)/);
    assert.ok(!fs.existsSync(done));
    assert.ok(fs.existsSync(path.join(dirty, 'new.txt')), 'the dirty worktree and its file are untouched');
    assert.equal(g(main, 'branch', '--list', 't1-done'), 't1-done');
  });
  test('a worktree used in the last hour waits; --path limits the run to one folder', () => {
    const main = repo();
    const fresh = worktree(main, 't1-fresh');
    const other = worktree(main, 't2-other');
    const r = cleanup(main, '--path', fresh);
    assert.match(line(r.stdout, fresh), /^KEEP .*(git used it \d+ min ago \(waits 60 min\)|changed in the last 60 min)/);
    assert.equal(line(r.stdout, other), '', '--path reports only the named folder');
    assert.equal(cleanup(main, '--path', path.join(TMP, 'nope')).status, 2);
  });
  test('a shell inside the folder keeps it; a session run from inside is told to cd out', () => {
    const main = repo();
    const done = worktree(main, 't1-done');
    assert.match(line(cleanup(done, '--idle-minutes', '0').stdout, done), /^KEEP .*this shell is inside it/);
  });
  test('ignored files: build output and identical copies of main may go; a worktree-only .env or a nested repository keeps the folder', () => {
    const main = repo();
    fs.writeFileSync(path.join(main, '.gitignore'), '.env\nnode_modules/\nnotes/\nnest/\n');
    g(main, 'add', '.gitignore'); g(main, 'commit', '-qm', 'ignore');
    fs.writeFileSync(path.join(main, '.env'), 'KEY=main');
    const copy = worktree(main, 't1-copy');
    fs.writeFileSync(path.join(copy, '.env'), 'KEY=main');
    fs.mkdirSync(path.join(copy, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'node_modules', 'x', 'i.js'), '1');
    const own = worktree(main, 't2-own');
    fs.writeFileSync(path.join(own, '.env'), 'KEY=secret-only-here');
    const notes = worktree(main, 't3-notes');
    fs.mkdirSync(path.join(notes, 'notes')); fs.writeFileSync(path.join(notes, 'notes', 'handover.md'), 'x');
    const nest = worktree(main, 't4-nest');
    fs.mkdirSync(path.join(nest, 'nest')); g(path.join(nest, 'nest'), 'init', '-q');
    const r = cleanup(main, '--idle-minutes', '0');
    assert.match(line(r.stdout, copy), /^REMOVE /);
    assert.match(line(r.stdout, own), /^KEEP .*ignored file not in the main checkout: \.env/);
    assert.match(line(r.stdout, notes), /^KEEP .*notes\/handover\.md/);
    assert.match(line(r.stdout, nest), /^KEEP .*nest\/ \(a nested repository\)/);
  });
  test('ignored files with non-ASCII names, or under a nested out/ folder, keep the worktree', () => {
    const main = repo();
    fs.writeFileSync(path.join(main, '.gitignore'), 'secret-*\nsrc/out/\n');
    g(main, 'add', '.gitignore'); g(main, 'commit', '-qm', 'ignore');
    const a = worktree(main, 't1-accent');
    fs.writeFileSync(path.join(a, 'secret-café.txt'), 'only here');
    const b = worktree(main, 't2-out');
    fs.mkdirSync(path.join(b, 'src', 'out'), { recursive: true }); fs.writeFileSync(path.join(b, 'src', 'out', 'important.txt'), 'x');
    const r = cleanup(main, '--idle-minutes', '0');
    assert.match(line(r.stdout, a), /^KEEP .*secret-café\.txt/);
    assert.match(line(r.stdout, b), /^KEEP .*src\/out\/important\.txt/);
  });
  test('a file changed inside the folder in the last hour keeps it, even with no git activity', () => {
    const main = repo();
    fs.writeFileSync(path.join(main, '.gitignore'), '.next/\n');
    g(main, 'add', '.gitignore'); g(main, 'commit', '-qm', 'ignore');
    const wt = worktree(main, 't1');
    const gd = g(wt, 'rev-parse', '--absolute-git-dir');
    const old = new Date(Date.now() - 3 * 3600000);
    for (const f of ['HEAD', 'index', 'logs/HEAD']) { try { fs.utimesSync(path.join(gd, f), old, old); } catch { /* absent */ } }
    for (const f of fs.readdirSync(wt)) if (f !== '.git') fs.utimesSync(path.join(wt, f), old, old);
    fs.utimesSync(wt, old, old);
    assert.match(line(cleanup(main).stdout, wt), /^(REMOVE|KEEP .*in use)/, 'with every mtime 3 h old the folder counts as idle');
    fs.writeFileSync(path.join(main, 'x'), ''); // unrelated
    fs.mkdirSync(path.join(wt, '.next'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.next', 'trace'), 'dev server output');
    assert.match(line(cleanup(main).stdout, wt), /^KEEP .*\.next.* changed in the last 60 min/);
  });
  test('an unexpired claim on the folder keeps it; a worktree whose folder is gone is reported, never pruned', () => {
    const main = repo();
    const wt = worktree(main, 't1');
    const dir = path.join(main, '.claude', '.state', 'claims');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ session: 'acme-builder', worktree: wt, expires: new Date(Date.now() + 3600000).toISOString() }));
    assert.match(line(cleanup(main, '--idle-minutes', '0').stdout, wt), /^KEEP .*claimed by acme-builder/);
    const gone = worktree(main, 't2-gone');
    fs.rmSync(gone, { recursive: true, force: true });
    const r = cleanup(main, '--idle-minutes', '0', '--apply');
    assert.match(line(r.stdout, gone), /^KEEP .*its folder is gone/);
    assert.match(g(main, 'worktree', 'list', '--porcelain'), /t2-gone/, 'git still lists it: nothing was pruned');
  });
  test('classifyProcesses: dev servers and their npm/sh wrappers may be stopped; shells, agents and other listeners keep the folder', () => {
    const procs = [
      { pid: 10, ppid: 1, cmd: 'node', args: 'npm run dev', ports: null },
      { pid: 11, ppid: 10, cmd: 'sh', args: 'sh -c next dev', ports: null },
      { pid: 12, ppid: 11, cmd: 'next-server', args: 'next-server (v16)', ports: ['3000'] },
      { pid: 20, ppid: 1, cmd: 'zsh', args: '-zsh', ports: null },
      { pid: 30, ppid: 1, cmd: 'postgres', args: 'postgres -D data', ports: ['5432'] },
    ];
    const c = classifyProcesses(procs);
    assert.deepEqual(c.servers.map((p) => p.pid), [12]);
    assert.deepEqual(c.wrappers.map((p) => p.pid).sort(), [10, 11]);
    assert.deepEqual(c.busy.map((p) => p.pid), [20, 30]);
    const shellParent = classifyProcesses([{ pid: 1, ppid: 0, cmd: 'zsh', args: '-zsh', ports: null }, { pid: 2, ppid: 1, cmd: 'node', args: 'node server.js', ports: ['5173'] }]);
    assert.deepEqual(shellParent.busy.map((p) => p.pid), [1], 'a terminal shell that started the server is a person working there');
    // An agent that runs as node (Codex, an editor helper) and started a dev server is never a "wrapper".
    const agent = classifyProcesses([{ pid: 1, ppid: 0, cmd: 'node', args: 'node /usr/local/bin/codex', ports: null },
      { pid: 2, ppid: 1, cmd: 'sh', args: 'sh -c npm run dev', ports: null }, { pid: 3, ppid: 2, cmd: 'node', args: 'npm run dev', ports: null },
      { pid: 4, ppid: 3, cmd: 'node', args: 'node vite', ports: ['5173'] }]);
    assert.deepEqual(agent.busy.map((p) => p.pid).sort(), [1, 2], 'the agent and the shell it started stay; only npm and the server may stop');
    assert.deepEqual(agent.wrappers.map((p) => p.pid), [3]);
  });
  test('--summary prints one line without sizes', () => {
    const main = repo();
    worktree(main, 't1-done');
    const r = cleanup(main, '--summary', '--idle-minutes', '0');
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.match(r.stdout, /1 of 1 worktree\(s\) are merged, clean and idle/);
  });
  test('a non-server process inside keeps the folder; a listening server is stopped by --apply', { skip: !hasLsof && 'lsof not available' }, async () => {
    const main = repo();
    const busy = worktree(main, 't1-busy');
    const served = worktree(main, 't2-served');
    const sleeper = spawn('sleep', ['60'], { cwd: busy, stdio: 'ignore' });
    const server = spawn(process.execPath, ['-e', 'require("http").createServer().listen(0, "127.0.0.1")'], { cwd: served, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 800));
      const r = cleanup(main, '--idle-minutes', '0', '--apply');
      assert.match(line(r.stdout, busy), /^KEEP .*in use by sleep/);
      assert.match(line(r.stdout, served), /^REMOVE .*stops node :\d+/);
      assert.match(r.stdout, new RegExp(`stopped node \\(${server.pid}\\)`));
      assert.ok(!fs.existsSync(served));
      assert.ok(fs.existsSync(busy));
    } finally { sleeper.kill(); server.kill(); }
  });
});

describe('Codex: hook wiring and guard behaviour', () => {
  test('templates/codex/hooks.json wires the five kit hooks, each to a file that exists, with CLOCKWORK_HOST=codex', () => {
    const cfg = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8'));
    const cmds = Object.values(cfg.hooks).flat().flatMap((grp) => grp.hooks.map((h) => h.command));
    const files = cmds.map((c) => /\.claude\/hooks\/([\w.-]+)"/.exec(c)?.[1]);
    assert.deepEqual(files.sort(), ['clockwork-doctor.mjs', 'guard-bash.mjs', 'guard-edit.mjs', 'prompt-intake.mjs', 'session-start.mjs']);
    for (const f of files) assert.ok(fs.existsSync(path.join(HOOKS, f)), f);
    for (const c of cmds) assert.match(c, /CLOCKWORK_HOST=codex/);
    assert.deepEqual(cfg.hooks.PreToolUse.map((x) => x.matcher), ['^Bash$', '^apply_patch$']);
  });
  test('patchFiles names every file an apply_patch touches', () => {
    const p = '*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-a\n+b\n*** Delete File: old.ts\n*** End Patch';
    assert.deepEqual(patchFiles(p), [{ file: 'src/new.ts', added: true }, { file: 'src/a.ts', added: false }, { file: 'src/b.ts', added: true }, { file: 'old.ts', added: false }]);
    assert.deepEqual(patchFiles(''), []);
  });
  const hook = (file, input, env = {}) => spawnSync(process.execPath, [path.join(HOOKS, file)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...GIT_ENV, ...env }, timeout: 30000 });
  const patchOf = (f) => `*** Begin Patch\n*** Update File: ${f}\n@@\n-a\n+b\n*** End Patch`;
  test('guard-edit: an apply_patch in the main checkout is denied under Codex (no "ask" there), asked about in Claude Code', () => {
    const main = repo();
    const wt = worktree(main, 't1');
    const input = { session_id: 's', cwd: main, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patchOf('a.txt') } };
    const codex = JSON.parse(hook('guard-edit.mjs', input, { CLOCKWORK_HOST: 'codex', CLAUDE_PROJECT_DIR: main }).stdout);
    assert.equal(codex.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(codex.hookSpecificOutput.permissionDecisionReason, /^Codex cannot pause for the user's OK.*MAIN checkout.*git worktree add/);
    const claude = JSON.parse(hook('guard-edit.mjs', { ...input, tool_name: 'Edit', tool_input: { file_path: path.join(main, 'a.txt') } }, { CLAUDE_PROJECT_DIR: main }).stdout);
    assert.equal(claude.hookSpecificOutput.permissionDecision, 'ask');
    const inWt = hook('guard-edit.mjs', { ...input, cwd: wt }, { CLOCKWORK_HOST: 'codex', CLAUDE_PROJECT_DIR: main });
    assert.equal(inWt.status, 0);
    assert.equal(inWt.stdout.trim(), '', 'an edit in your own worktree passes silently');
  });
  test('guard-edit: an apply_patch with no file header is a visible warning, not a silent pass', () => {
    const main = repo();
    const r = hook('guard-edit.mjs', { session_id: 's', cwd: main, tool_name: 'apply_patch', tool_input: { command: 'garbage' } }, { CLOCKWORK_HOST: 'codex' });
    assert.match(JSON.parse(r.stdout).systemMessage, /apply_patch named no file.*NOT checked/);
  });
  test('guard-bash: an "ask" becomes a deny with exit 2 under Codex; a deny stays a deny', () => {
    const main = repo();
    worktree(main, 't1');
    g(main, 'branch', 'other');
    const input = { session_id: 's', cwd: main, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git checkout other' } };
    const claude = hook('guard-bash.mjs', input);
    assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, 'ask');
    const codex = hook('guard-bash.mjs', input, { CLOCKWORK_HOST: 'codex' });
    assert.equal(codex.status, 2);
    const out = JSON.parse(codex.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /^Codex cannot pause/);
    const addAll = hook('guard-bash.mjs', { ...input, tool_input: { command: 'git add -A' } }, { CLOCKWORK_HOST: 'codex' });
    assert.equal(addAll.status, 2);
    assert.match(JSON.parse(addAll.stdout).hookSpecificOutput.permissionDecisionReason, /^Blocked: "git add -A"/);
  });
});

describe('install.mjs --codex', () => {
  const install = (...a) => spawnSync(process.execPath, [path.join(KIT, 'install.mjs'), ...a], { encoding: 'utf8', env: GIT_ENV, timeout: 60000 });
  test('without --codex the Codex file is skipped; with it, written; once present it is kept current without the flag', () => {
    const p = repo();
    assert.match(install(p, '--stack', 'nextjs').stdout, /skip\s+\.codex\/hooks\.json\s+Codex hooks: add --codex/);
    assert.equal(install(p, '--stack', 'nextjs', '--codex', '--apply').status, 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(p, '.codex', 'hooks.json'), 'utf8'));
    assert.deepEqual(cfg, JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf8')));
    assert.ok(fs.existsSync(path.join(p, '.claude', 'tools', 'cleanup.mjs')));
    assert.match(install(p, '--stack', 'nextjs').stdout, /keep\s+\.codex\/hooks\.json\s+all kit hooks already wired/);
  });
});
