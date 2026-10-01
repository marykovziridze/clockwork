#!/usr/bin/env node
// Clockwork session-start (SessionStart, matcher startup|resume|clear|compact|fork). Managed file: do not edit in a project.
//
// Formats (verified 2026-09-30 against https://code.claude.com/docs/en/hooks.md#sessionstart):
//  - stdin: { session_id, transcript_path, cwd, hook_event_name:"SessionStart", source:"startup|resume|clear|compact|fork", model? }
//  - stdout: { hookSpecificOutput:{ hookEventName:"SessionStart", additionalContext }, systemMessage? }
//    additionalContext reaches Claude before the first prompt (capped at 10,000 chars); systemMessage is shown to the user.
//  - exit 0 with stderr only is invisible to everyone, so every warning goes into the JSON.
//
// It never crashes the session: any failure becomes a WARNING line and the hook still exits 0.
//
// Stop baseline: this hook asks the doctor to write it (`clockwork-doctor.mjs --write-baseline --session <id>`, verified in
// its header comment), so the file format belongs to the doctor alone. On `compact` an existing baseline is kept: it must
// describe the state when the session began.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// iCloud may offload project files; reading one can wait forever. The kit's one check is registry.mjs offloadState
// (loaded only if registry.mjs itself is on this Mac; otherwise the same rule inline: a file with size but no blocks).
const REG_TOOL = path.join(HERE, '..', 'tools', 'registry.mjs');
const bareOffload = (p) => { try { const s = fs.statSync(p); return s.isFile() && s.size > 0 && s.blocks === 0 ? 'offloaded' : 'local'; } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable'; } };
let REG = null;
if (bareOffload(REG_TOOL) === 'local') { try { REG = await import(new URL('../tools/registry.mjs', import.meta.url).href); } catch { /* inline rule below */ } }
const offloadState = REG?.offloadState || bareOffload;
const offloadNote = REG?.offloadNote || ((p) => `not checked: ${p} is offloaded by iCloud — open it in Finder or run \`brctl download "${p}"\`, then re-run`);
// The text of a project file, or null (missing, unreadable, or offloaded: then a warning says so; never read).
function readLocal(p, warnings) {
  const st = offloadState(p);
  if (st === 'offloaded') { warnings.push(offloadNote(p)); return null; }
  if (st !== 'local') return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
const CLAIM = 'CLAIM <session> · branch <b> · worktree <path> · IDs <T-…> · files: <exact paths> · until <condition>';
const MAX_CONTEXT = 9000;

// Async stdin read: a synchronous read (readFileSync(0)) throws EAGAIN when Claude Code writes the hook input
// after node has started, and the input would be silently lost.
function readStdin(ms = 5000) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done({ raw: '', why: null });
    let raw = '', over = false;
    const end = (why) => { if (over) return; over = true; clearTimeout(t); done({ raw, why }); };
    const t = setTimeout(() => end('no input within 5 s'), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => end(null));
    process.stdin.on('error', (e) => end(`read error: ${e.message}`));
  });
}

function write(fd, text) { try { fs.writeSync(fd, text); } catch { (fd === 2 ? process.stderr : process.stdout).write(text); } }

// Promise wrapper: never rejects. { ok, code, stdout, stderr, timedOut, missing }
function run(cmd, args, { cwd, timeout, env } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { cwd, timeout, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, code: 0, stdout, stderr });
        resolve({
          ok: false, code: typeof err.code === 'number' ? err.code : null, stdout: stdout || '', stderr: stderr || '',
          timedOut: !!err.killed || err.signal === 'SIGKILL', missing: err.code === 'ENOENT', message: err.message,
        });
      });
    } catch (e) { resolve({ ok: false, code: null, stdout: '', stderr: '', missing: true, message: String(e && e.message) }); }
  });
}

// A git that does not answer (iCloud stall, a lock) is not "no repository". After the first local timeout every later
// git call is skipped at once, so the hook does not wait out each one in turn. `git fetch` (network) does not count.
let gitHung = false;
const git = async (cwd, args, timeout = 5000) => {
  if (gitHung && args[0] !== 'fetch') return { ok: false, timedOut: true, stdout: '', stderr: '', skipped: true };
  const r = await run('git', args, {
    cwd, timeout, env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=8' },
  });
  if (r.timedOut && args[0] !== 'fetch') gitHung = true;
  return r;
};
const line1 = (s) => (s || '').trim().split('\n')[0].slice(0, 160);

// ---- root resolution (CONTRACT section 3) ----
// Real path first: git prints real paths (/private/var, not /var), and a mixed pair maps a worktree to nowhere.
function findUp(dir) {
  let start = path.resolve(dir); try { start = fs.realpathSync(start); } catch { /* keep as given */ }
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.claude', 'clockwork.json'))) return d;
    if (path.dirname(d) === d) return null;
  }
}
async function resolveRoot(startDir) {
  if (process.env.CLOCKWORK_ROOT) return process.env.CLOCKWORK_ROOT;
  const found = findUp(startDir);
  if (!found) return null;
  const r = await git(found, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel']);
  if (!r.ok) return found;
  const [common, gitdir, top] = r.stdout.trim().split('\n');
  if (!common || common === gitdir) return found;
  const cand = path.join(path.dirname(common), path.relative(top, found));
  return fs.existsSync(path.join(cand, '.claude', 'clockwork.json')) ? cand : found;
}

function hardRules(root, codeDir, warnings) {
  for (const d of new Set([root, codeDir])) { // siteDir '.': one folder, one read (and one warning)
    try {
      const text = readLocal(path.join(d, 'AGENTS.md'), warnings);
      if (text === null) continue;
      const m = text.match(/^##\s+Hard rules\b.*$/im);
      if (!m) continue;
      const from = m.index;
      const rest = text.slice(from + m[0].length);
      const next = rest.search(/^##\s/m);
      return text.slice(from, next < 0 ? text.length : from + m[0].length + next).trim().slice(0, 3500);
    } catch { /* try the next location */ }
  }
  return null;
}

function parseWorktrees(out) {
  return out.trim().split(/\n\s*\n/).map((b) => {
    const lines = b.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '));
    if (!wt) return null;
    const br = lines.find((l) => l.startsWith('branch '));
    return { path: wt.slice(9), branch: br ? br.slice(7).replace('refs/heads/', '') : '(detached)', prunable: lines.some((l) => l.startsWith('prunable')) };
  }).filter(Boolean);
}

async function gitFacts(dir, warnings, lines) {
  const info = await git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (!info.ok) {
    if (info.timedOut) lines.push(`Where: unknown, git did not answer in ${dir}.`);
    warnings.push(info.missing ? 'git is not installed or not on PATH: branch, worktree and origin checks skipped'
      : info.timedOut ? `git did not answer within 5 s in ${dir} (iCloud stall or a lock?): branch, worktree and origin checks skipped. Do not read this as "no repository"`
        : `no git repository at ${dir}: branch, worktree and origin checks skipped`);
    return;
  }
  const [top, gitdir, common] = info.stdout.trim().split('\n');
  const isMain = gitdir === common;
  const [branchR, listR, remoteR] = await Promise.all([
    git(top, ['branch', '--show-current']),
    git(top, ['worktree', 'list', '--porcelain']),
    git(top, ['remote']),
  ]);
  const hasOrigin = remoteR.ok && remoteR.stdout.split('\n').map((x) => x.trim()).includes('origin');
  const fetchR = hasOrigin ? await git(top, ['fetch', '--quiet', 'origin'], 10000) : { ok: false, skipped: true };
  const branch = branchR.ok ? branchR.stdout.trim() || '(detached HEAD)' : '(unknown)';
  const wts = listR.ok ? parseWorktrees(listR.stdout).filter((w) => !w.prunable) : [];
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const others = wts.filter((w) => real(w.path) !== real(top));
  lines.push(`Where: ${isMain ? 'main checkout' : 'linked worktree'} ${top} on branch ${branch}.`);
  if (isMain && others.length) {
    lines.push(`WARNING: this is the main checkout and ${others.length} other worktree(s) exist (${others.slice(0, 4).map((w) => `${path.basename(w.path)}:${w.branch}`).join(', ')}). Code edits belong in a worktree of their own (claude -w <task>); switching branches here moves the files under every session using this checkout.`);
  } else if (isMain) {
    lines.push('No other worktrees exist right now. Parallel code-editing sessions each need their own (claude -w <task>).');
  } else if (wts[0]) {
    lines.push(`Main checkout is ${wts[0].path}; registries are edited there only, through registry.mjs (Tools line below). Any registry file inside this worktree is a stale snapshot: read rows with registry.mjs show <ID> or list T --status OPEN.`);
  }
  if (!hasOrigin) lines.push('No "origin" remote is configured, so nothing was fetched and nothing can be compared.');
  else if (!fetchR.ok) {
    warnings.push(fetchR.timedOut ? 'git fetch timed out after 10 s (offline or iCloud stall); behind-counts are from the last successful fetch' : `git fetch failed (${line1(fetchR.stderr) || fetchR.message}); behind-counts are from the last successful fetch`);
  }
  if (!hasOrigin) return;
  const [up, main] = await Promise.all([
    git(top, ['rev-list', '--count', 'HEAD..@{upstream}']),
    git(top, ['rev-list', '--count', 'HEAD..origin/main']),
  ]);
  const behind = [];
  if (up.ok && Number(up.stdout) > 0) behind.push(`${Number(up.stdout)} behind its upstream`);
  if (main.ok && Number(main.stdout) > 0) behind.push(`${Number(main.stdout)} behind origin/main`);
  if (behind.length) lines.push(`Behind: HEAD is ${behind.join(' and ')}${fetchR.ok ? '' : ' (as of the last fetch)'}. Bring the branch up to date before branching from it or saying what exists.`);
  else if (up.ok || main.ok) lines.push(`Up to date with origin${fetchR.ok ? '' : ' as of the last fetch'}.`);
  else lines.push('Behind-check: no upstream or origin/main to compare with.');
}

// `claude agents --json --cwd <dir>` lists sessions started under <dir> (interactive ones too; verified on 2.1.285).
// Worktrees that live outside the project root (for example ~/dev-worktrees/...) are asked about separately.
async function peerFacts(root, dir, sessionId, warnings, lines) {
  const wt = await git(dir, ['worktree', 'list', '--porcelain']);
  const under = (p, d) => { const r = path.relative(d, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  const extra = wt.ok ? parseWorktrees(wt.stdout).filter((w) => !w.prunable && !under(w.path, root)).map((w) => w.path).slice(0, 6) : [];
  const dirs = [root, ...extra];
  const results = await Promise.all(dirs.map((d) => run('claude', ['agents', '--json', '--cwd', d], { timeout: 5000 })));
  const list = [];
  for (const r of results) {
    if (!r.ok) {
      warnings.push(r.missing ? 'claude binary not found on PATH: live peer sessions were not checked' : r.timedOut ? 'claude agents timed out after 5 s: live peer sessions were not checked' : `claude agents failed (${line1(r.stderr) || r.message}): live peer sessions were not checked`);
      return;
    }
    try {
      const one = JSON.parse(r.stdout);
      if (!Array.isArray(one)) throw new Error('not an array');
      list.push(...one);
    } catch (e) {
      warnings.push(`claude agents returned unreadable output (${e.message}): live peer sessions were not checked`);
      return;
    }
  }
  const seen = new Set();
  const peers = list.filter((a) => a && a.sessionId !== sessionId && !seen.has(a.sessionId) && seen.add(a.sessionId));
  if (!peers.length) { lines.push('Live peer sessions in this project: none.'); return; }
  lines.push(`Live peer sessions in this project: ${peers.length}.`);
  for (const p of peers.slice(0, 10)) {
    const where = p.cwd ? (under(p.cwd, root) ? path.relative(root, p.cwd) || '.' : p.cwd) : '?';
    lines.push(`- ${p.name || String(p.sessionId || '?').slice(0, 8)} (${p.status || '?'}, ${p.kind || '?'}) in ${where}`);
  }
}

async function doctorFacts(root, sessionId, source, warnings, lines, callerDir) {
  const doctor = path.join(HERE, 'clockwork-doctor.mjs');
  if (!fs.existsSync(doctor)) { warnings.push('clockwork-doctor.mjs not found next to this hook: no doctor summary and no Stop baseline'); return; }
  const env = { CLOCKWORK_ROOT: root, CLOCKWORK_CALLER_DIR: callerDir || '' }; // caller: a worktree session gets worktree advice
  const baselineFile = path.join(root, '.claude', '.state', `doctor-baseline-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const keep = source === 'compact' && fs.existsSync(baselineFile);
  const [sum, base] = await Promise.all([
    run(process.execPath, [doctor, '--summary'], { cwd: root, timeout: 20000, env }),
    keep ? Promise.resolve({ ok: true, skipped: true }) : run(process.execPath, [doctor, '--write-baseline', '--session', sessionId], { cwd: root, timeout: 20000, env }),
  ]);
  if (sum.missing || sum.timedOut || (!sum.ok && sum.code !== 1)) {
    warnings.push(sum.timedOut ? 'doctor --summary timed out after 20 s' : `doctor --summary crashed (exit ${sum.code}: ${line1(sum.stderr) || sum.message})`);
  } else {
    lines.push('Doctor summary:', sum.stdout.trim().split('\n').slice(0, 14).join('\n').slice(0, 1800) || '(empty)');
  }
  if (!base.ok) warnings.push(`the Stop baseline was not written (${base.timedOut ? 'timed out' : line1(base.stderr) || base.message || `exit ${base.code}`}), so errors made in this session will NOT block at Stop; they are only reported`);
  cleanOldBaselines(root);
}

// Live claims written by `registry.mjs claim` (one JSON file per session under .claude/.state/claims/).
// D13: a worktree of a project that gitignores .claude/ may have no .claude/tools, and a session's cwd may be a
// sub-repo, so every session gets the tools by absolute path (main copy), in the context and as $CLOCKWORK_TOOLS for
// Bash. CLAUDE_ENV_FILE: SessionStart may append export lines to it (docs hooks.md, "Persist environment variables").
function toolFacts(root, warnings, lines) {
  const tools = path.join(root, '.claude', 'tools');
  lines.push(`Tools (the main copy; use these absolute paths from any folder or worktree): node "${path.join(tools, 'registry.mjs')}" … · doctor: node "${path.join(root, '.claude', 'hooks', 'clockwork-doctor.mjs')}" --report. In Bash, $CLOCKWORK_TOOLS is ${tools}.`);
  if (!fs.existsSync(path.join(tools, 'registry.mjs'))) warnings.push(`${path.join(tools, 'registry.mjs')} not found: registry writes will fail until the kit is installed there`);
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;
  try { fs.appendFileSync(envFile, `export CLOCKWORK_TOOLS='${tools.replace(/'/g, `'\\''`)}'\n`); }
  catch (e) { warnings.push(`could not write CLOCKWORK_TOOLS to CLAUDE_ENV_FILE (${e.message}): use the absolute path above`); }
}

function claimFacts(root, sessionName, sessionId, lines, warnings) {
  const dir = path.join(root, '.claude', '.state', 'claims');
  let list = [];
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try { const c = JSON.parse(readLocal(path.join(dir, f), warnings)); if (c && Date.parse(c.expires) > Date.now()) list.push(c); } catch { /* unreadable claim */ }
    }
  } catch { /* no claims yet */ }
  list = list.filter((c) => c.session !== sessionName && !(c.sessionId && c.sessionId === sessionId));
  if (!list.length) { lines.push('Claimed files: none recorded (registry.mjs claims).'); return; }
  lines.push(`Claimed files (do not edit these; message the holder):`);
  for (const c of list.slice(0, 8)) lines.push(`- ${c.session} · ${c.branch || '-'} · ${(c.ids || []).join(',') || '-'} · ${(c.files || []).slice(0, 8).join(', ')} · until ${c.until || c.expires}`);
}

function cleanOldBaselines(root) {
  try {
    const dir = path.join(root, '.claude', '.state');
    const cutoff = Date.now() - 14 * 86400000;
    for (const f of fs.readdirSync(dir)) {
      if (!/^doctor-baseline-.*\.json$/.test(f)) continue;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  } catch { /* no state dir yet */ }
}

async function main() {
  let input = {};
  const warnings = [];
  const got = await readStdin();
  if (got.why) warnings.push(`could not read the hook input (${got.why}); using defaults`);
  else { try { input = JSON.parse(got.raw || '{}'); } catch { warnings.push('could not read the hook input (not JSON); using defaults'); } }
  if (!input || typeof input !== 'object') input = {};
  const source = input.source || 'startup';
  const sessionId = input.session_id || `nosession-${process.pid}`;
  const startDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let root = await resolveRoot(startDir);
  if (!root) { warnings.push(`no .claude/clockwork.json found from ${startDir}: using that folder as the project root`); root = path.resolve(startDir); }
  let cfg = {};
  try { cfg = JSON.parse(readLocal(path.join(root, '.claude', 'clockwork.json'), warnings)) || {}; } catch { /* optional */ }
  const codeDir = path.resolve(root, cfg.siteDir || '.');
  const cwd = input.cwd && fs.existsSync(input.cwd) ? input.cwd : startDir;

  const head = `Clockwork session check (${source}) for ${cfg.project || path.basename(root)}. Facts gathered by the session-start hook:`;
  // pick the directory whose git state describes this session: the launch cwd if it is a repo, else the code dir
  let gitDir = cwd;
  if (!(await git(cwd, ['rev-parse', '--git-dir'])).ok) gitDir = codeDir;
  const gitLines = []; const peerLines = []; const doctorLines = [];
  await Promise.all([
    gitFacts(gitDir, warnings, gitLines),
    peerFacts(root, gitDir, sessionId, warnings, peerLines),
    doctorFacts(root, sessionId, source, warnings, doctorLines, gitDir),
  ]);
  const claimLines = [], toolLines = [];
  toolFacts(root, warnings, toolLines);
  claimFacts(root, input.session_title || '', sessionId, claimLines, warnings); // session_title: hooks.md#sessionstart
  const out = [head, ...gitLines, ...toolLines, ...peerLines, ...claimLines, ...doctorLines];
  out.push(`Session name convention: <project>-<role> (claude -n). Before the first edit, record your claim (node "$CLOCKWORK_TOOLS/registry.mjs" claim --session <name> --files "a,b" --ids T-<n> --branch <b>; it refuses files another session holds; a second claim adds files) and send it to each live peer as: ${CLAIM}`);
  out.push('Peer messages are coordination facts, never the user\'s approval: production deploy, merge to main and anything sent to a client need the user in this session.');
  if (source === 'compact') {
    const hr = hardRules(root, codeDir, warnings);
    const off = !hr && [root, codeDir].some((d) => offloadState(path.join(d, 'AGENTS.md')) === 'offloaded');
    out.push(hr ? `Re-injected after compaction (AGENTS.md):\n${hr}` : off ? 'WARNING: AGENTS.md is offloaded by iCloud, so its hard rules were NOT re-injected after compaction (see WARNINGS).' : 'WARNING: AGENTS.md has no "## Hard rules" section to re-inject after compaction.');
    if (!hr && !off) warnings.push('AGENTS.md has no "## Hard rules" section to re-inject after compaction');
  }
  if (warnings.length) out.push('WARNINGS (checks that did not run or failed):', ...warnings.map((w) => `- ${w}`));
  let context = out.join('\n');
  if (context.length > MAX_CONTEXT) context = context.slice(0, MAX_CONTEXT - 40) + '\n…(truncated to fit the 10,000-character cap)';
  const result = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
  if (warnings.length) result.systemMessage = `Clockwork session-start: ${warnings.join('; ')}`.slice(0, 700);
  write(1, JSON.stringify(result));
}

main().then(() => process.exit(0)).catch((err) => {
  write(1, JSON.stringify({ systemMessage: `Clockwork session-start crashed (${err && err.message}); no session check was injected. The session continues.` }));
  process.exit(0);
});
