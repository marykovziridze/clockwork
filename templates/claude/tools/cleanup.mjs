#!/usr/bin/env node
// Clockwork cleanup: finds task worktrees that are finished and removes them, with the dev servers running in them.
// Managed file: do not edit in a project.
//
// Usage (from the main checkout; a session inside the folder it wants gone is told to cd out first):
//   node cleanup.mjs                      report every linked worktree: removable or kept, why, and its size
//   node cleanup.mjs --apply              remove the removable ones (dev servers in them are stopped first)
//   node cleanup.mjs --path <dir> [--apply]   only that worktree (a session cleaning up its own task folder)
//   node cleanup.mjs --summary            one line, no sizes (session-start uses this)
//   Options: --idle-minutes <n> (default 60)
//
// A worktree is removable only when ALL of these hold (each one protects another session's work):
//   1. no uncommitted or untracked files (git status --porcelain)
//   2. every ignored file is either build output (REBUILDABLE below) or a byte-identical copy of the main checkout's file
//      (.env, .vercel/project.json, a gitignored .claude/ kit: .worktreeinclude copies). `git worktree remove` deletes
//      ignored files without asking, so a worktree-only .env, note or nested repository keeps the folder
//   3. its HEAD is already on the default branch (origin's, or the local one), so no commit is lost; the branch itself
//      is kept, so `git worktree add <dir> <branch>` brings the folder back
//   4. nothing in it changed for --idle-minutes: git's HEAD, index and reflog, and every file outside node_modules down
//      to 4 levels (a session that only builds or serves, and runs no git, still touches .next or its files)
//   5. no unexpired claim (registry.mjs claim) names it
//   6. no process works inside it, except dev servers (node, next-server, vite, bun, deno, php, python, ruby that listen
//      on a port) and the npm/pnpm/yarn/npx wrappers that started them. Any other process (a shell, an agent, an editor,
//      a database) keeps it. If lsof fails, nothing is removed.
//   7. not locked (git worktree lock), not prunable (its folder is gone: reported, never pruned), not the main checkout
// A squash-merged branch fails rule 3 (its commits are not on main) and is kept; the report says how many commits.
// --apply judges each worktree again right before removing it. Removal is `git worktree remove` without --force, so git
// refuses a folder that gained changes in between. Servers get SIGTERM only if the same PID still listens in that folder.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = has('--apply'), SUMMARY = has('--summary');
const IDLE_MIN = Number(opt('--idle-minutes') ?? 60);
const fail = (msg) => { process.stderr.write(`cleanup: ${msg}\n`); process.exit(2); };
if (!Number.isFinite(IDLE_MIN) || IDLE_MIN < 0) fail('--idle-minutes needs a number of minutes');

// Ignored paths that a build or an install recreates. Matched against each path segment, or as a path prefix.
export const REBUILDABLE = ['node_modules', '.next', 'dist', 'build', 'out', '.turbo', '.cache', '.parcel-cache', 'coverage',
  '.vercel/output', '.svelte-kit', '.nuxt', '.output', '.astro', '__pycache__', '.pytest_cache', '.venv', 'venv', '.DS_Store'];
const REBUILDABLE_FILE = /(^|\/)(next-env\.d\.ts|[^/]*\.tsbuildinfo|\.eslintcache)$/;
const SERVER_CMD = /^(node|next-server|vite|bun|deno|php|python\d*(\.\d+)?|ruby)$/;
// A package-manager run (npm sets its process title to "npm run dev"; also node <path>/npm-cli.js run dev). A shell counts
// only when a package manager started it (npm runs scripts through sh -c). An agent, an editor or a terminal never does.
const PM_ARGS = /^(?:(?:\S*\/)?(?:npm|npx|pnpm|yarn|bun)(?:\s|$)|node\s+\S*\/(?:npm|npx|pnpm|yarn)(?:-cli\.js|\.js|\.cjs)?(?:\s|$))/;

function sh(cmd, argv, { cwd, timeout = 10000, raw = false } = {}) {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return { ok: r.status === 0, out: raw ? (r.stdout || '') : (r.stdout || '').trim(), err: (r.stderr || '').trim(), missing: r.error?.code === 'ENOENT', timedOut: r.error?.code === 'ETIMEDOUT' };
}
const git = (cwd, argv, timeout) => sh('git', ['-C', cwd, ...argv], { timeout });
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const human = (kb) => (kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`);

export function parseWorktrees(text) {
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const w = {};
    for (const l of block.split('\n')) {
      const [k, ...v] = l.split(' ');
      if (k === 'worktree') w.path = v.join(' ');
      else if (k === 'HEAD') w.head = v[0];
      else if (k === 'branch') w.branch = v.join(' ').replace(/^refs\/heads\//, '');
      else if (k === 'detached') w.detached = true;
      else if (k === 'locked') w.locked = v.join(' ') || true;
      else if (k === 'prunable') w.prunable = true;
      else if (k === 'bare') w.bare = true;
    }
    if (w.path) out.push(w);
  }
  return out;
}

// lsof -F output: p<pid>, c<command>, n<name>.
export function parseLsof(text) {
  const out = []; let cur = null;
  for (const l of text.split('\n')) {
    if (l[0] === 'p') { cur = { pid: Number(l.slice(1)), cmd: '', name: '' }; out.push(cur); }
    else if (cur && l[0] === 'c') cur.cmd = l.slice(1);
    else if (cur && l[0] === 'n' && !cur.name) cur.name = l.slice(1);
  }
  return out;
}
// Every process's working folder, its parent, and the ports it listens on. null when this cannot be known for sure:
// lsof missing, timed out, or a list without this very process in it (then it did not see everything).
export function processes() {
  const cwds = sh('lsof', ['-nP', '-a', '-d', 'cwd', '-Fpcn'], { timeout: 20000 });
  if (cwds.missing || cwds.timedOut) return null;
  const list = parseLsof(cwds.out).filter((p) => p.name);
  if (!list.some((p) => p.pid === process.pid)) return null;
  const listen = sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 20000 });
  if (listen.missing || listen.timedOut) return null;
  const ports = new Map();
  for (const p of parseLsof(listen.out)) ports.set(p.pid, [...(ports.get(p.pid) || []), (p.name.match(/:(\d+)$/) || [])[1]].filter(Boolean));
  const ps = sh('ps', ['-A', '-o', 'pid=,ppid=,args=']);
  const info = new Map();
  for (const l of ps.out.split('\n')) { const m = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(l); if (m) info.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] }); }
  return list.map((p) => ({ ...p, cwd: real(p.name), ports: ports.get(p.pid) || null, ppid: info.get(p.pid)?.ppid || 0, args: info.get(p.pid)?.args || '' }));
}
// This process and its parents (the shell and the agent that ran us) never count as "in use".
function ancestors() {
  const set = new Set(); let pid = process.pid;
  for (let i = 0; i < 12 && pid > 1; i++) { set.add(pid); const r = sh('ps', ['-o', 'ppid=', '-p', String(pid)]); pid = Number(r.out); if (!r.ok) break; }
  return set;
}

// Splits the processes working inside one folder into dev servers (stoppable), their wrappers, and the rest (busy).
export function classifyProcesses(there) {
  const servers = there.filter((p) => p.ports && SERVER_CMD.test(p.cmd));
  const byPid = new Map(there.map((p) => [p.pid, p]));
  const wrappers = new Set();
  const pm = (q) => q && !q.ports && PM_ARGS.test(q.args || '');
  const shellOfPm = (q) => q && !q.ports && q.cmd === 'sh' && pm(byPid.get(q.ppid));
  for (const s of servers) {
    for (let q = byPid.get(s.ppid), i = 0; q && i < 6 && (pm(q) || shellOfPm(q)); q = byPid.get(q.ppid), i++) wrappers.add(q.pid);
  }
  const busy = there.filter((p) => !servers.includes(p) && !wrappers.has(p.pid));
  return { servers, wrappers: there.filter((p) => wrappers.has(p.pid)), busy };
}

function baseRefs(main) {
  const refs = [];
  const head = git(main, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const name = head.ok ? head.out.replace(/^origin\//, '') : ['main', 'master'].find((b) => git(main, ['rev-parse', '--verify', '--quiet', b]).ok);
  if (head.ok) refs.push(head.out);
  else if (name && git(main, ['rev-parse', '--verify', '--quiet', `origin/${name}`]).ok) refs.push(`origin/${name}`);
  if (name && git(main, ['rev-parse', '--verify', '--quiet', name]).ok) refs.push(name);
  return refs;
}

// Build output only at the top level (or a known prefix such as .vercel/output); node_modules, __pycache__ and .DS_Store
// anywhere. An "out/" or "build/" deeper down may be someone's files.
const ANYWHERE = new Set(['node_modules', '__pycache__', '.DS_Store']);
const rebuildable = (rel) => REBUILDABLE_FILE.test(rel) || REBUILDABLE.includes(rel.split('/')[0]) || rel.split('/').some((x) => ANYWHERE.has(x))
  || REBUILDABLE.some((r) => r.includes('/') && (rel === r || rel.startsWith(`${r}/`)));
const sameFile = (a, b) => { try { const x = fs.statSync(a), y = fs.statSync(b); return x.isFile() && y.isFile() && x.size === y.size && fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };
// The first ignored file that would be lost (not build output, not identical in the main checkout), or null.
// `porcelain` is `git status --porcelain -z --ignored` output: NUL-separated, paths unquoted (non-ASCII names intact).
export function statusEntries(porcelain) {
  const out = []; const parts = porcelain.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]; if (!e) continue;
    out.push({ xy: e.slice(0, 2), path: e.slice(3) });
    if (e[0] === 'R' || e[0] === 'C') i++; // a rename or copy carries its source path as the next entry
  }
  return out;
}
export function lostIgnored(wt, main, entries) {
  const walk = (rel, depth = 0) => {
    const abs = path.join(wt, rel);
    if (rebuildable(rel)) return fs.existsSync(path.join(abs, '.git')) ? `${rel}/ (a nested repository)` : null;
    let st; try { st = fs.lstatSync(abs); } catch { return `${rel} (could not be read)`; }
    if (st.isSymbolicLink()) return null;
    if (!st.isDirectory()) return sameFile(abs, path.join(main, rel)) ? null : rel;
    if (fs.existsSync(path.join(abs, '.git'))) return `${rel}/ (a nested repository)`;
    if (depth > 12) return `${rel}/ (too deep to check)`;
    for (const e of fs.readdirSync(abs)) { const hit = walk(`${rel}/${e}`, depth + 1); if (hit) return hit; }
    return null;
  };
  for (const e of entries) {
    if (e.xy !== '!!') continue;
    const hit = walk(e.path.replace(/\/$/, ''));
    if (hit) return hit;
  }
  return null;
}

// Newest change in the worktree: git's own files, and anything outside node_modules/.git down to 4 levels.
function changedSince(wt, minutes) {
  if (minutes === 0) return { recent: false }; // --idle-minutes 0: the caller waived the wait
  const gd = git(wt, ['rev-parse', '--absolute-git-dir']);
  let t = 0;
  if (gd.ok) for (const f of ['HEAD', 'index', 'logs/HEAD']) { try { t = Math.max(t, fs.statSync(path.join(gd.out, f)).mtimeMs); } catch { /* absent */ } }
  if (Date.now() - t < minutes * 60000) return { recent: true, ago: (Date.now() - t) / 60000 };
  // -mmin, not -newermt: -newermt reads its date in local time, which silently widened the window by the UTC offset.
  const r = sh('find', [wt, '-maxdepth', '4', '(', '-name', 'node_modules', '-o', '-name', '.git', ')', '-prune', '-o', '-mmin', `-${Math.ceil(minutes)}`, '-print'], { timeout: 30000 });
  if (r.timedOut || r.missing) return { recent: true, unknown: true };
  const hit = r.out.split('\n').find((l) => l && l !== wt);
  return hit ? { recent: true, file: path.relative(wt, hit) } : { recent: false };
}

function claimsOn(main, wt) {
  const dir = path.join(main, '.claude', '.state', 'claims');
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (c?.worktree && Date.parse(c.expires) > Date.now() && real(c.worktree) === real(wt)) out.push(c.session || f); } catch { /* unreadable claim */ }
  }
  return out;
}

export function judge(w, { main, refs, procs, mine, here, idleMin = IDLE_MIN }) {
  if (w.prunable) return { why: 'its folder is gone; git still lists it (run `git worktree prune` yourself once you know why)' };
  if (w.locked) return { why: `locked${w.locked === true ? '' : ` (${w.locked})`}` };
  const wt = real(w.path);
  if (here && inside(here, wt)) return { why: 'this shell is inside it: run from the main checkout' };
  // HEAD read now, not from the worktree list: a commit made since that list (detached HEAD) must count.
  const head = git(wt, ['rev-parse', 'HEAD']);
  if (!head.ok) return { why: 'could not read its HEAD' };
  if (w.head && head.out !== w.head) return { why: 'its HEAD moved while cleanup ran: run it again' };
  const st = sh('git', ['-C', wt, 'status', '--porcelain', '-z', '--ignored', '--untracked-files=normal'], { timeout: 30000, raw: true }); // raw: an entry starts with a space
  if (!st.ok) return { why: `git status failed (${st.err.split('\n')[0] || 'no output'})` };
  const entries = statusEntries(st.out);
  const changed = entries.filter((e) => e.xy !== '!!');
  if (changed.length) return { why: `${changed.length} uncommitted or untracked file(s)` };
  const lost = lostIgnored(wt, real(main), entries);
  if (lost) return { why: `ignored file not in the main checkout: ${lost}` };
  if (!refs.length) return { why: 'no default branch found to compare with' };
  if (!refs.some((r) => git(main, ['merge-base', '--is-ancestor', head.out, r]).ok)) {
    const n = git(main, ['rev-list', '--count', `${refs[0]}..${head.out}`]).out || '?';
    return { why: `${n} commit(s) not on ${refs[0]}${w.branch ? ` (branch ${w.branch}; squash-merged? delete it by hand once you are sure)` : ''}` };
  }
  const ch = changedSince(wt, idleMin);
  if (ch.recent) return { why: ch.unknown ? 'could not tell when it last changed' : ch.file ? `${ch.file} changed in the last ${idleMin} min` : `git used it ${Math.round(ch.ago)} min ago (waits ${idleMin} min)` };
  const claims = claimsOn(main, wt);
  if (claims.length) return { why: `claimed by ${claims.join(', ')}` };
  if (!procs) return { why: 'lsof did not give a full process list: cannot tell whether a session works in it' };
  const { servers, wrappers, busy } = classifyProcesses(procs.filter((p) => !mine.has(p.pid) && inside(p.cwd, wt)));
  if (busy.length) return { why: `in use by ${busy.slice(0, 3).map((p) => `${p.cmd} (${p.pid})`).join(', ')}` };
  return { remove: true, servers, wrappers, why: servers.length ? `merged and idle; stops ${servers.map((p) => `${p.cmd} :${p.ports.join(',')}`).join(', ')}` : 'merged and idle' };
}

// Returns { ok, msg }. A process that exited but was not yet reaped by its parent (ps state Z) counts as stopped.
function stop(p, dir, needPort) {
  const again = processes()?.find((q) => q.pid === p.pid);
  if (!again || !inside(again.cwd, real(dir)) || again.cmd !== p.cmd || (needPort && !again.ports)) return { ok: true, msg: `${p.cmd} (${p.pid}) already stopped or changed; left alone` };
  try { process.kill(p.pid, 'SIGTERM'); } catch (e) { return { ok: e.code === 'ESRCH', msg: `could not stop ${p.cmd} (${p.pid}): ${e.code}` }; }
  const gone = () => { const r = sh('ps', ['-o', 'stat=', '-p', String(p.pid)]); return !r.ok || !r.out || r.out.startsWith('Z'); };
  for (let i = 0; i < 25; i++) { if (gone()) return { ok: true, msg: `stopped ${p.cmd} (${p.pid})` }; spawnSync('sleep', ['0.2']); }
  return { ok: false, msg: `${p.cmd} (${p.pid}) did not stop after SIGTERM; left running` };
}

function main() {
  const here = real(process.cwd());
  const list = git(here, ['worktree', 'list', '--porcelain']);
  if (!list.ok) fail(`not inside a git repository (${here})`);
  const all = parseWorktrees(list.out);
  const main = all[0]?.path;
  if (!main || all[0].bare) fail('could not find the main checkout');
  let linked = all.slice(1);
  if (opt('--path')) {
    const want = real(path.resolve(opt('--path')));
    linked = linked.filter((w) => real(w.path) === want);
    if (!linked.length) fail(`${want} is not a linked worktree of ${main}`);
  }
  const mine = ancestors();
  const ctx = { main, refs: baseRefs(main), procs: processes(), mine, here };
  const rows = linked.map((w) => ({ w, ...judge(w, ctx) }));
  const ok = rows.filter((r) => r.remove);

  if (SUMMARY) {
    console.log(ok.length ? `Task folders: ${ok.length} of ${rows.length} worktree(s) are merged, clean and idle; node "<tools>/cleanup.mjs" lists them with sizes, --apply removes them.`
      : `Task folders: ${rows.length} worktree(s), none ready to remove.`);
    return 0;
  }
  const size = (p) => { const r = sh('du', ['-sk', p], { timeout: 120000 }); return r.ok ? Number(r.out.split(/\s/)[0]) : null; };
  let free = 0;
  console.log(`Main checkout: ${main} · compared with ${ctx.refs.join(' and ') || '(nothing)'} · idle after ${IDLE_MIN} min`);
  for (const r of rows) {
    const kb = r.w.prunable ? 0 : size(r.w.path);
    r.kb = kb || 0;
    if (r.remove) free += r.kb;
    console.log(`${r.remove ? 'REMOVE' : 'KEEP  '} ${r.w.path} · ${r.w.branch || 'detached'} · ${kb == null ? '? ' : human(kb)} · ${r.why}`);
  }
  if (!rows.length) console.log('No linked worktrees.');
  if (!ok.length) return 0;
  if (!APPLY) { console.log(`Dry run: ${ok.length} removable, ${human(free)}. Add --apply to remove them.`); return 0; }
  let failed = 0, freed = 0;
  for (const r of ok) {
    // Judged again now: the first pass and the sizes may be minutes old.
    const now = judge(r.w, { ...ctx, procs: processes() });
    if (!now.remove) { failed++; console.log(`SKIPPED ${r.w.path}: ${now.why}`); continue; }
    const stops = [...now.servers.map((p) => stop(p, r.w.path, true)), ...now.wrappers.map((p) => stop(p, r.w.path, false))];
    for (const x of stops) console.log(`  ${x.msg}`);
    if (stops.some((x) => !x.ok)) { failed++; console.log(`FAILED ${r.w.path}: a server in it is still running, so the folder was kept`); continue; }
    const res = git(main, ['worktree', 'remove', r.w.path], 60000);
    if (res.ok) { freed += r.kb; console.log(`OK removed ${r.w.path}${r.w.branch ? ` (branch ${r.w.branch} kept)` : ''}`); }
    else { failed++; console.log(`FAILED ${r.w.path}: ${res.err.split('\n')[0]}`); }
  }
  console.log(`Freed about ${human(freed)}${failed ? `; ${failed} folder(s) not removed (see SKIPPED/FAILED)` : ''}.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) process.exit(main());
