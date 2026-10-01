#!/usr/bin/env node
// Clockwork publisher — pushes the kit's committed files to a git remote others can clone, as one commit.
// Usage: node publish.mjs <remote> [--branch main] [--fresh] [--apply]
//   --fresh   the remote branch gets a new one-commit history (force push), so no older commit stays reachable
// Default is a DRY RUN: checks and prints, writes nothing. Exit 0 ok · 1 refused · 2 crashed.
// Refuses unless every published file is free of the private terms and words and of this machine's home folder path.
// Private data: $CLOCKWORK_PRIVATE, else ~/.claude/clockwork-private.json — { "privateTerms": [...], "privateWords": [...],
// "publishAllow": [...], "publishExclude": [...], "live": {...} }. A term matches anywhere ("Acme" in "acme-site"); a word
// only whole ("Sam", not "same"). publishAllow lists exact strings that may appear although they hold a term or word, such
// as the author's name on the LICENSE or the repo's own URL: each is blanked out of a line (case-sensitive) before the
// check, so the rest of that line is still checked. "live" is what the CLOCKWORK_LIVE=1 tests read (test/private.mjs).
// Only committed files go out (git archive of HEAD); _archive/ and publishExclude paths never do.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'Usage: node publish.mjs <remote> [--branch main] [--fresh] [--apply]';
const ALWAYS_EXCLUDED = ['_archive'];
const PRIVATE_FILE = process.env.CLOCKWORK_PRIVATE || path.join(os.homedir(), '.claude', 'clockwork-private.json');

const fail = (msg, code = 1) => { console.log(`ERR ${msg}`); process.exit(code); };
function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: opts.encoding === null ? null : 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
  if (r.error) fail(`git ${args[0]}: ${r.error.message}`, 2);
  if (r.status !== 0 && !opts.allowFail) fail(`git ${args.join(' ')} failed: ${String(r.stderr || '').trim()}`);
  return r;
}

function parseArgs(argv) {
  const o = { remote: null, branch: 'main', fresh: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--branch') { o.branch = argv[++i]; if (!o.branch) fail(`--branch needs a name. ${USAGE}`); }
    else if (a.startsWith('--')) fail(`unknown flag ${a}. ${USAGE}`);
    else if (o.remote) fail(`one remote only. ${USAGE}`);
    else o.remote = a;
  }
  if (!o.remote) fail(`no remote given. ${USAGE}`);
  return o;
}

function loadPrivate() {
  let j;
  try { j = JSON.parse(fs.readFileSync(PRIVATE_FILE, 'utf8')); } catch (e) {
    fail(e.code === 'ENOENT' ? `${PRIVATE_FILE} not found: without your private terms there is nothing to check the kit against; nothing published` : `${PRIVATE_FILE}: ${e.message}`);
  }
  const terms = (j.privateTerms || []).map(String).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) fail(`${PRIVATE_FILE} has no privateTerms; nothing published`);
  const words = (j.privateWords || []).map(String).map((w) => w.trim()).filter(Boolean);
  const allow = (j.publishAllow || []).map(String).filter((a) => a.trim());
  return { terms, words, allow, exclude: (j.publishExclude || []).map((p) => String(p).replace(/^\.\/|\/+$/g, '')).filter(Boolean) };
}

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r)); else out.push(r);
  }
  return out;
}

// Every place a term, a word or the home path appears, in a file's path or its text (case-insensitive).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchers(terms, words) {
  return [
    ...terms.map((n) => ({ label: n, re: new RegExp(escapeRe(n), 'iu') })),
    ...words.map((w) => ({ label: w, re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, 'iu') })),
  ];
}
function scan(dir, files, ms, allow = []) {
  const hits = [];
  const unallowed = (l) => allow.reduce((t, a) => t.split(a).join(' '.repeat(a.length)), l);
  for (const f of files) {
    for (const m of ms) if (m.re.test(f)) hits.push(`${f}: path holds "${m.label}"`);
    const st = fs.lstatSync(path.join(dir, f));
    const text = st.isSymbolicLink() ? fs.readlinkSync(path.join(dir, f)) : fs.readFileSync(path.join(dir, f), 'utf8');
    text.split('\n').forEach((l, j) => { const c = unallowed(l); for (const m of ms) if (m.re.test(c)) hits.push(`${f}:${j + 1}: "${m.label}"`); });
  }
  return hits;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const priv = loadPrivate();
  const home = os.homedir();
  const ms = matchers([...new Set([...priv.terms, home])], priv.words);

  const top = git(['rev-parse', '--show-toplevel'], { cwd: KIT }).stdout.trim();
  const prefix = path.relative(fs.realpathSync(top), fs.realpathSync(KIT)).split(path.sep).join('/');
  const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', '.'], { cwd: KIT }).stdout.trim();
  if (dirty) fail(`the kit has uncommitted changes; commit them first, so what is published is a commit you have:\n${dirty}`);
  const head = git(['rev-parse', '--short', 'HEAD'], { cwd: KIT }).stdout.trim();
  let version = 'unknown';
  try { version = fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim() || version; } catch { /* stays unknown */ }

  // The kit as committed, without the excluded paths.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-publish-'));
  const tree = path.join(work, 'tree');
  fs.mkdirSync(tree);
  const tar = git(['archive', '--format=tar', prefix ? `HEAD:${prefix}` : 'HEAD'], { cwd: top, encoding: null });
  const x = spawnSync('tar', ['-x', '-C', tree], { input: tar.stdout });
  if (x.status !== 0) fail(`tar could not unpack the kit: ${String(x.stderr).trim()}`, 2);
  const excluded = [...ALWAYS_EXCLUDED, ...priv.exclude];
  const removed = [];
  for (const ex of excluded) { const p = path.join(tree, ex); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(ex); } }
  const files = walk(tree);

  console.log(`Publish: Clockwork ${version} (kit commit ${head}${prefix ? `, folder ${prefix}/` : ''}) → ${o.remote} ${o.branch}${o.fresh ? ' (fresh history, force push)' : ''}`);
  console.log(`  ${files.length} file(s); left out: ${removed.length ? removed.join(', ') : 'nothing'}`);
  const hits = scan(tree, files, ms, priv.allow);
  if (hits.length) {
    for (const h of hits.slice(0, 60)) console.log(`  PRIVATE ${h}`);
    if (hits.length > 60) console.log(`  … ${hits.length - 60} more`);
    fs.rmSync(work, { recursive: true, force: true });
    fail(`${hits.length} private reference(s) in files that would be published; nothing published`);
  }
  console.log(`  checked against ${priv.terms.length} private term(s), ${priv.words.length} private word(s) and ${home}${priv.allow.length ? `, with ${priv.allow.length} allowed string(s)` : ''}: clean`);
  if (!o.apply) { fs.rmSync(work, { recursive: true, force: true }); console.log('OK dry run; nothing published (add --apply)'); return 0; }

  const repo = path.join(work, 'repo');
  const remoteHead = git(['ls-remote', o.remote, `refs/heads/${o.branch}`], { allowFail: true });
  if (remoteHead.status !== 0) fail(`cannot reach ${o.remote}: ${String(remoteHead.stderr).trim()}`);
  const before = remoteHead.stdout.split(/\s/)[0] || '';
  if (o.fresh || !before) git(['init', '-q', '-b', o.branch, repo]);
  else {
    git(['clone', '-q', '--branch', o.branch, '--single-branch', o.remote, repo]);
    git(['rm', '-r', '-q', '--ignore-unmatch', '--', '.'], { cwd: repo });
  }
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.cpSync(path.join(tree, f), path.join(repo, f), { verbatimSymlinks: true });
  }
  git(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: repo, input: files.join('\0') });
  if (!git(['status', '--porcelain'], { cwd: repo }).stdout.trim()) {
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`OK ${o.remote} ${o.branch} already holds this kit; nothing published`);
    return 0;
  }
  git(['commit', '-q', '-m', `Clockwork ${version}`], { cwd: repo });
  const sha = git(['rev-parse', '--short', 'HEAD'], { cwd: repo }).stdout.trim();
  if (before && o.fresh) console.log(`  replacing ${o.branch} at ${before.slice(0, 7)}: its old history is no longer reachable from ${o.remote}`);
  git(['push', '-q', ...(o.fresh ? ['--force'] : []), o.remote, `HEAD:refs/heads/${o.branch}`], { cwd: repo });
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`OK published ${files.length} file(s) as ${sha} "Clockwork ${version}" to ${o.remote} ${o.branch}`);
  return 0;
}

try { process.exitCode = main(); } catch (e) { console.log(`ERR crash: ${e.stack || e.message}`); process.exitCode = 2; }
