#!/usr/bin/env node
// Clockwork guard-edit (PreToolUse, matcher "Edit|Write"; the matcher is a regex tested anywhere in the tool
// name, so it also covers NotebookEdit). Managed file: do not edit in a project.
//
// Formats (verified 2026-09-30 against https://code.claude.com/docs/en/hooks.md, PreToolUse input "Write"/"Edit"):
//  - stdin: { session_id, cwd, hook_event_name:"PreToolUse", tool_name, tool_input:{ file_path, ... } }
//    (NotebookEdit's path field is read as notebook_path or file_path; unsure which, both are accepted.)
//  - stdout: { hookSpecificOutput:{ hookEventName:"PreToolUse", permissionDecision:"ask"|"deny", permissionDecisionReason } }
//
// What it does (AGENTS.md hard rule 5): a code edit in the MAIN checkout while other worktrees exist is asked
// about (denied overnight, when nobody can answer). Registry and project files under .claude/, PM/ and reports/
// are edited in the main copy on purpose and pass. A session isolated in a worktree is already blocked from
// the main checkout by Claude Code itself (docs: worktrees.md, "How Claude Code enforces isolation").
// Claims: an edit of a file another session holds (`registry.mjs claim`, any worktree, any spelling) is asked about
// (denied overnight). "Another session" = a different session_id (registry.mjs records CLAUDE_CODE_SESSION_ID,
// which docs env-vars.md say equals the hook's session_id), or a different worktree for a claim made by hand.
// D13 worktree copies: an Edit/Write of a gitignored kit file inside a linked worktree is asked about (denied overnight):
// the edit would be lost with the worktree; it belongs in the main copy.
// Registries (hard rule 3): an Edit/Write of a registry file of THIS project (main copy or a worktree copy) is asked
// about (denied overnight): rows go through registry.mjs under its lock. Another project's files (an onboarding staging
// copy) are not judged here.
// Path-scoped rules load only when Claude READS a matching file (docs memory.md), so a Write that creates a new file
// gets additionalContext naming the rule files that apply (PreToolUse additionalContext: docs hooks.md).
// It never crashes the session: an internal error is a visible warning and the edit goes ahead.
// iCloud offload: this hook reads .claude/clockwork.json and the .claude/rules/*.md frontmatter on every Edit/Write.
// An offloaded ("dataless") file is never read, since that read can wait forever and freeze every edit. Instead it
// fails OPEN with a one-line warning: clockwork.json → the default registry folder (.claude) and default claims
// settings, every check still runs; an offloaded rule file → left out of the path-rules list, named in the warning.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The kit's one offload check is registry.mjs offloadState (loaded only if registry.mjs itself is local; otherwise
// the same rule inline: a file with size but no blocks).
const REG_TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'registry.mjs');
const bareOffload = (p) => { try { const s = fs.statSync(p); return s.isFile() && s.size > 0 && s.blocks === 0 ? 'offloaded' : 'local'; } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable'; } };
let REG = null;
if (bareOffload(REG_TOOL) === 'local') { try { REG = await import(pathToFileURL(REG_TOOL).href); } catch { /* inline rule below */ } }
const offloadState = REG?.offloadState || bareOffload;
const offloadNote = REG?.offloadNote || ((p) => `not checked: ${p} is offloaded by iCloud — open it in Finder or run \`brctl download "${p}"\`, then re-run`);
const notes = []; // one-line offload warnings, added to whatever this hook prints
const note = (msg) => { if (!notes.includes(msg)) notes.push(msg); };
const cfgNote = (f) => `${offloadNote(f)} (this edit was checked with the default settings: registry folder .claude)`;

const EXEMPT_TOP = new Set(['.claude', 'PM', 'reports']);
const REGISTRY_FILE = /^(TASKS|CLIENT|CLIENT-REQUESTS|FACTS|MEETING-LOG|OPEN-ASKS|APPROVAL-QUEUE|DOC-MAP|ROUTING)(-ARCHIVE)?\.md$/;

function readStdin(ms = 5000) {
  return new Promise((done) => {
    let raw = '', over = false;
    const end = (why) => { if (over) return; over = true; clearTimeout(t); done({ raw, why }); };
    const t = setTimeout(() => end('no input within 5 s'), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => end(null));
    process.stdin.on('error', (e) => end(`read error: ${e.message}`));
  });
}
const out = (obj) => {
  if (notes.length && !obj.systemMessage) obj.systemMessage = `clockwork guard-edit: ${notes.join('; ')}`;
  fs.writeSync(1, JSON.stringify(obj)); process.exit(0);
};
const warn = (msg) => out({ systemMessage: `clockwork guard-edit: ${msg}. This edit was NOT checked.` });
function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return r.status === 0 ? r.stdout.trim() : null;
}
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// Returns null (allow) or { others: [..] } when the file is inside a main checkout that has other worktrees.
export function mainCheckoutEdit(file, registryDir = '.claude') {
  let dir = path.dirname(path.resolve(file));
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const info = git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (!info) return null; // not in a repository
  const [top, gitdir, common] = info.split('\n');
  if (gitdir !== common) return null; // a linked worktree: this is the right place for code
  const rel = path.relative(real(top), path.join(real(dir), path.basename(file)));
  if (rel.startsWith('..')) return null;
  const first = rel.split(path.sep)[0];
  if (EXEMPT_TOP.has(first) || rel.startsWith(registryDir.replace(/\/+$/, '') + path.sep)) return null;
  const list = git(top, ['worktree', 'list', '--porcelain']) || '';
  const others = list.split(/\n\s*\n/).filter((b) => b.startsWith('worktree ') && !/^prunable/m.test(b))
    .map((b) => b.split('\n')[0].slice(9)).filter((p) => real(p) !== real(top));
  return others.length ? { others, rel } : null;
}

// D13: in a linked worktree of a project that gitignores .claude/, the kit files there are a .worktreeinclude copy.
// An edit to that copy (a design-system.md row, routing.md) is invisible to git and deleted with the worktree.
// Returns null, or { rel, main } with the main copy's absolute path.
const KIT_COPY = /(^|\/)\.claude\/(settings\.json|clockwork\.json|(hooks|tools|rules|skills|agents|workflows)\/.+)$/;
export function worktreeKitCopy(file) {
  let dir = path.dirname(path.resolve(file));
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const info = git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (!info) return null;
  const [top, gitdir, common] = info.split('\n');
  if (gitdir === common) return null; // the main checkout
  const rel = path.relative(real(top), path.join(real(dir), path.relative(dir, path.resolve(file)))).split(path.sep).join('/');
  if (rel.startsWith('..') || !KIT_COPY.test(rel)) return null;
  if (spawnSync('git', ['-C', top, 'check-ignore', '-q', '--', rel], { timeout: 3000 }).status !== 0) return null; // committed: merged like code
  const first = (git(top, ['worktree', 'list', '--porcelain']) || '').split('\n').find((l) => l.startsWith('worktree '));
  return first ? { rel, main: path.join(first.slice(9), rel) } : null;
}

// Claims of other sessions covering this file. The helpers live in registry.mjs next to this hook's folder.
async function heldByOthers(file, sessionId) {
  const R = REG;
  if (!R) { if (bareOffload(REG_TOOL) === 'offloaded') note(`${offloadNote(REG_TOOL)} (claims were not checked)`); return []; }
  let dir = path.dirname(path.resolve(file));
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  let root;
  try { root = R.resolveRoot(dir, { quiet: true }); } catch { return []; } // not in a Clockwork project
  const worktree = git(dir, ['rev-parse', '--show-toplevel']) || '';
  // registry.mjs loadConfig refuses an offloaded clockwork.json; the claims then use its defaults (siteDir '.').
  const cfgFile = path.join(root, '.claude', 'clockwork.json');
  const off = offloadState(cfgFile) === 'offloaded';
  if (off) note(cfgNote(cfgFile));
  return R.claimsHolding(root, off ? {} : R.loadConfig(root), file, { sessionId, worktree });
}

// This project's registry file? (the session's own project, resolved to the main copy, or a worktree copy of it)
export function registryOfProject(file, projectDir, registryDir = '.claude') {
  if (!REGISTRY_FILE.test(path.basename(file))) return false;
  const d = real(path.dirname(path.resolve(file)));
  const want = registryDir.replace(/\/+$/, '');
  const roots = new Set([real(projectDir)]);
  const list = git(projectDir, ['worktree', 'list', '--porcelain']) || '';
  for (const l of list.split('\n')) if (l.startsWith('worktree ')) roots.add(real(l.slice(9)));
  const top = git(projectDir, ['rev-parse', '--show-toplevel']);
  const sub = top ? path.relative(real(top), real(projectDir)) : '';
  return [...roots].some((r) => d === real(path.join(r, want)) || d === real(path.join(r, sub, want)));
}

// Rule files whose `paths:` globs match this file (frontmatter list of quoted globs, {a,b} braces, ** and *).
function globRe(g) {
  const alts = (x) => { const m = /\{([^{}]*)\}/.exec(x); return m ? m[1].split(',').flatMap((o) => alts(x.slice(0, m.index) + o + x.slice(m.index + m[0].length))) : [x]; };
  return alts(g).map((a) => new RegExp(`^${a.split(/(\*\*\/|\*\*|\*|\?)/).map((t) => (t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`));
}
// An offloaded rule file is never read: its path goes into `skipped` and it is not listed.
export function rulesFor(rel, rulesDir, skipped = []) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(rulesDir).filter((n) => n.endsWith('.md')); } catch { return out; }
  for (const n of names) {
    if (offloadState(path.join(rulesDir, n)) === 'offloaded') { skipped.push(path.join(rulesDir, n)); continue; }
    let text; try { text = fs.readFileSync(path.join(rulesDir, n), 'utf8'); } catch { continue; }
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!fm) continue;
    const globs = [...fm[1].matchAll(/^\s*-\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((m) => m[1]);
    if (globs.some((g) => globRe(g).some((re) => re.test(rel)))) out.push(n);
  }
  return out;
}

async function main() {
  if (process.stdin.isTTY) process.exit(0);
  const got = await readStdin();
  if (got.why) return warn(`could not read the hook input (${got.why})`);
  let input;
  try { input = JSON.parse(got.raw || '{}'); } catch { return warn('the hook input was not JSON'); }
  const file = input?.tool_input?.file_path || input?.tool_input?.notebook_path;
  if (typeof file !== 'string' || !file) process.exit(0);
  let hit = null, held = [], regFile = false, rules = [], wtCopy = null;
  const abs = path.isAbsolute(file) ? file : path.join(input.cwd || process.cwd(), file);
  const overnight = process.env.OVERNIGHT === '1';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  try {
    let registryDir = '.claude';
    const cfgFile = path.join(projectDir, '.claude', 'clockwork.json');
    if (offloadState(cfgFile) === 'offloaded') note(cfgNote(cfgFile));
    else try { registryDir = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).registryDir || '.claude'; } catch { /* default */ }
    held = await heldByOthers(abs, input.session_id || '');
    hit = mainCheckoutEdit(abs, registryDir);
    regFile = registryOfProject(abs, projectDir, registryDir);
    if (!regFile) wtCopy = worktreeKitCopy(abs);
    if (input.tool_name === 'Write' && !fs.existsSync(abs)) {
      let dir = path.dirname(abs); while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
      const top = git(dir, ['rev-parse', '--show-toplevel']) || projectDir;
      const rulesDir = [path.join(top, '.claude', 'rules'), path.join(projectDir, '.claude', 'rules')].find((d) => fs.existsSync(d));
      const skipped = [];
      if (rulesDir) rules = rulesFor(path.relative(real(top), path.join(real(dir), path.relative(dir, abs))).split(path.sep).join('/'), rulesDir, skipped).map((n) => path.join(rulesDir, n));
      for (const p of skipped) note(`${offloadNote(p)} (its path rules were not checked for this new file)`);
    }
  } catch (e) { return warn(`internal error (${e && e.message})`); }
  if (regFile) {
    const reason = `${path.basename(abs)} is a registry file: registries are written only with registry.mjs, under its lock, so parallel sessions never overwrite each other's rows (AGENTS.md hard rule 3). `
      + 'Use node "$CLOCKWORK_TOOLS/registry.mjs" mint/append/status for rows, line <FILE> --section "## …" --text "…" [--replace "<old line>"] for other lines, dedupe <ID> for a duplicate. Approve only a hand edit the user asked for.';
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: overnight ? 'deny' : 'ask', permissionDecisionReason: reason } });
  }
  if (held.length) {
    const c = held[0];
    const reason = `${path.basename(abs)} is claimed by session ${c.session} (${c.hit.join(', ')}; branch ${c.branch || '-'}; until ${c.until || c.expires}). `
      + 'Never edit a file another session holds: send that session the change you need (SendMessage), or ask the user. See the holders: node "$CLOCKWORK_TOOLS/registry.mjs" claims';
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: overnight ? 'deny' : 'ask', permissionDecisionReason: reason } });
  }
  if (wtCopy) {
    const reason = `${wtCopy.rel} here is this worktree's gitignored copy (.claude/ is gitignored on purpose, D13): git never sees an edit to it and removing the worktree deletes it. `
      + `Make the change in the main copy, ${wtCopy.main}, from a session in the main checkout (Claude Code blocks edits to the main checkout from a worktree), or ask the user. Approve only a throwaway change.`;
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: overnight ? 'deny' : 'ask', permissionDecisionReason: reason } });
  }
  if (!hit) {
    if (rules.length) out({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `Path-scoped rules apply to ${path.basename(abs)} and load only when a matching file is READ, so a new file does not load them: ${rules.join(', ')}. If you have not read them in this session, read them now and check this file against them before you go on.` } });
    if (notes.length) out({}); // fail open, but never silently
    process.exit(0);
  }
  const reason = `${hit.rel} is in the MAIN checkout while ${hit.others.length} other worktree(s) exist (${hit.others.slice(0, 3).map((p) => path.basename(p)).join(', ')}). `
    + 'Code is edited only in your own worktree (AGENTS.md hard rule 5): start one with `claude -w <task>` or use EnterWorktree, then edit there. '
    + 'Registry lines go through node "$CLOCKWORK_TOOLS/registry.mjs".';
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: overnight ? 'deny' : 'ask', permissionDecisionReason: reason } });
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
