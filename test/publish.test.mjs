// Tests for publish.mjs: the kit reaches a remote only when no published file names a private term or the home
// folder path. Offline; throwaway kits and bare remotes in os.tmpdir().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'publish.mjs');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw publish test ')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const HOME = path.join(TMP, 'home'); // os.homedir() of the publish run
fs.mkdirSync(HOME);
const ENV = { ...process.env, HOME, CLOCKWORK_PRIVATE: path.join(TMP, 'private.json'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
const PRIV = { privateTerms: ['Acme Rocket'], privateWords: ['Kim'], publishExclude: ['private-notes.md'] };

const put = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); if (mode) fs.chmodSync(p, mode); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
const priv = (o) => (o ? fs.writeFileSync(ENV.CLOCKWORK_PRIVATE, JSON.stringify(o)) : fs.rmSync(ENV.CLOCKWORK_PRIVATE, { force: true }));
const run = (k, ...args) => { const r = spawnSync(process.execPath, [path.join(k, 'publish.mjs'), ...args], { env: ENV, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

let n = 0;
// A committed kit; `sub` puts it in a folder of a bigger repo, as the author's copy is.
function kit({ sub = '', files = {} } = {}) {
  const root = path.join(TMP, `repo ${++n}`);
  const k = sub ? path.join(root, sub) : root;
  put(path.join(k, 'publish.mjs'), fs.readFileSync(REAL));
  put(path.join(k, 'VERSION'), '9.9.9\n');
  put(path.join(k, 'README.md'), '# Kit\n');
  put(path.join(k, 'tools', 'run.sh'), '#!/bin/sh\necho hi\n', 0o755);
  put(path.join(k, '_archive', 'notes.md'), 'Call with Acme Rocket\n');
  put(path.join(k, 'private-notes.md'), 'Acme Rocket call\n');
  for (const [f, s] of Object.entries(files)) put(path.join(k, f), s);
  if (sub) put(path.join(root, 'other', 'x.md'), 'Acme Rocket, outside the kit\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  return k;
}
const bare = () => { const r = path.join(TMP, `remote ${++n}.git`); git(TMP, 'init', '-q', '--bare', '-b', 'main', r); return r; };
const remoteFiles = (r) => git(TMP, '--git-dir', r, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean).sort();
const commits = (r) => git(TMP, '--git-dir', r, 'log', '--format=%s', 'main').split('\n').filter(Boolean);

test('dry run: checks and prints, pushes nothing; _archive/ and publishExclude are left out', () => {
  priv(PRIV);
  const k = kit(), r = bare();
  const res = run(k, r);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /4 file\(s\); left out: _archive, private-notes\.md/);
  assert.match(res.out, /checked against 1 private term\(s\), 1 private word\(s\) and .*: clean/);
  assert.match(res.out, /OK dry run; nothing published/);
  assert.equal(git(TMP, 'ls-remote', r), '');
});

test('a private term in a published file refuses, naming file and line, whatever its case', () => {
  priv(PRIV);
  const k = kit({ files: { 'docs/guide.md': 'line one\nmet with ACME rocket today\n' } }), r = bare();
  const res = run(k, r, '--apply');
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /PRIVATE docs\/guide\.md:2: "Acme Rocket"/);
  assert.match(res.out, /ERR 1 private reference\(s\) in files that would be published; nothing published/);
  assert.equal(git(TMP, 'ls-remote', r), '');
});

test('the home folder path and a term in a file name refuse too', () => {
  priv(PRIV);
  let res = run(kit({ files: { 'a.md': `see ${HOME}/notes\n` } }), bare());
  assert.equal(res.code, 1, res.out); assert.match(res.out, /PRIVATE a\.md:1: /);
  res = run(kit({ files: { 'acme-rocket/acme rocket.md': 'x\n' } }), bare());
  assert.equal(res.code, 1, res.out); assert.match(res.out, /PRIVATE acme-rocket\/acme rocket\.md: path holds "Acme Rocket"/);
});

test('a private word refuses only as a whole word: "Kim" or "kim\'s" yes, "Kimono" or "kimchi" no', () => {
  priv(PRIV);
  let res = run(kit({ files: { 'a.md': 'a Kimono and kimchi\n' } }), bare());
  assert.equal(res.code, 0, res.out);
  res = run(kit({ files: { 'b.md': 'ok\nask kim\'s team first\n' } }), bare());
  assert.equal(res.code, 1, res.out); assert.match(res.out, /PRIVATE b\.md:2: "Kim"/);
});

test('publishAllow: an exact allowed string passes (a LICENSE name, the repo URL); the same term anywhere else on the line still refuses', () => {
  priv({ ...PRIV, publishAllow: ['Kim Larsen', 'github.com/kim/kit'] });
  let res = run(kit({ files: { LICENSE: 'Copyright (c) 2026 Kim Larsen\n', 'a.md': 'git clone https://github.com/kim/kit\n' } }), bare());
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /with 2 allowed string\(s\): clean/);
  res = run(kit({ files: { 'b.md': 'Kim Larsen wrote this; ask Kim first\n' } }), bare());
  assert.equal(res.code, 1, res.out); assert.match(res.out, /PRIVATE b\.md:1: "Kim"/);
  res = run(kit({ files: { 'c.md': 'kim larsen\n' } }), bare());
  assert.equal(res.code, 1, 'case-sensitive: only the exact string is allowed');
});

test('no private file, or one without terms, refuses: there would be nothing to check against', () => {
  const k = kit(), r = bare();
  priv(null);
  let res = run(k, r);
  assert.equal(res.code, 1); assert.match(res.out, /clockwork-private\.json not found|private\.json not found/);
  priv({ privateTerms: [] });
  res = run(k, r);
  assert.equal(res.code, 1); assert.match(res.out, /has no privateTerms/);
});

test('uncommitted changes to kit files refuse; untracked files do not (they are never published)', () => {
  priv(PRIV);
  const k = kit(), r = bare();
  put(path.join(k, 'scratch.txt'), 'Acme Rocket\n');
  assert.equal(run(k, r).code, 0, 'an untracked file is not published, so not checked');
  fs.appendFileSync(path.join(k, 'README.md'), 'more\n');
  const res = run(k, r);
  assert.equal(res.code, 1); assert.match(res.out, /uncommitted changes/);
});

test('--apply --fresh from a kit folder inside a bigger repo: one commit, only the kit, executable bits kept', () => {
  priv(PRIV);
  const k = kit({ sub: 'clockwork' }), r = bare();
  const res = run(k, r, '--apply', '--fresh');
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /folder clockwork\//);
  assert.deepEqual(remoteFiles(r), ['README.md', 'VERSION', 'publish.mjs', 'tools/run.sh']);
  assert.deepEqual(commits(r), ['Clockwork 9.9.9']);
  assert.match(git(TMP, '--git-dir', r, 'ls-tree', 'main', 'tools/run.sh'), /^100755 /);
});

test('later publishes add one commit and drop deleted files; the same kit twice publishes nothing; --fresh resets history', () => {
  priv(PRIV);
  const k = kit(), r = bare();
  assert.equal(run(k, r, '--apply').code, 0, 'an empty remote needs no --fresh');
  fs.rmSync(path.join(k, 'tools'), { recursive: true });
  put(path.join(k, 'README.md'), '# Kit, second\n');
  git(k, 'add', '-u'); git(k, 'commit', '-qm', 'second');
  let res = run(k, r, '--apply');
  assert.equal(res.code, 0, res.out);
  assert.deepEqual(remoteFiles(r), ['README.md', 'VERSION', 'publish.mjs']);
  assert.equal(commits(r).length, 2);
  res = run(k, r, '--apply');
  assert.equal(res.code, 0); assert.match(res.out, /already holds this kit; nothing published/);
  assert.equal(commits(r).length, 2);
  res = run(k, r, '--apply', '--fresh');
  assert.equal(res.code, 0, res.out); assert.match(res.out, /replacing main at [0-9a-f]{7}: its old history is no longer reachable/);
  assert.equal(commits(r).length, 1);
});
