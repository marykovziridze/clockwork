#!/usr/bin/env node
// Clockwork onboarding CLI (build contract §3, kept with the kit history). Deterministic: no model calls, no network.
// Brings an existing project under Clockwork 2.0 without losing anything, whatever it has today:
//   A = Clockwork v1 · B = other documentation · C = no documentation.
// Usage:
//   node onboard.mjs discover <project> [--json]                        read-only inventory + case/stack guess
//   node onboard.mjs stage <project> [--to <dir>] [--json]              copy to a staging folder off iCloud + manifest
//   node onboard.mjs census <dir> [--out f.json] [--json]               IDs + a hash of every doc line
//   node onboard.mjs migrate <staging> [--dry-run] [--reports-dir <rel>] [--json]   mechanical fixes only
//   node onboard.mjs compare <before.json> <after.json> [--plan <ONBOARDING-PLAN.md>] [--json]
//   node onboard.mjs sources <staging> [--json]                         every Source citation resolves to a real line
//   node onboard.mjs rebase <staging> <project> [--taken <file,file>] [--json]   take in what changed in the project since stage
//   node onboard.mjs coverage <staging> [--json]                        every line of the old design file has a destination
//   node onboard.mjs apply <staging> <project> [--yes] [--allow-live] [--resume] [--json]
// Exit 0 ok · 1 refused (compare: something LOST) · 2 crash. Last stdout line: "OK …" or "ERR …".
// Env: CLOCKWORK_ONBOARD_HOME  staging root (default ~/dev/.clockwork-onboard)
//      CLOCKWORK_CLAUDE_BIN    the `claude` binary used for `claude agents --json --cwd <project>` (tests use a stub)
//      CLOCKWORK_SYNCED_ROOTS  synced roots, path.delimiter-separated (same meaning as in install.mjs)
//      CLOCKWORK_ONBOARD_NOW   fixed ISO time (tests only)
// `claude agents --json --cwd <path>` prints active sessions (interactive and background) started under <path>
// as a JSON array: https://code.claude.com/docs/en/cli-reference.md (checked 2026-09-30, CLI 2.1.285).
// Our own session is excluded via CLAUDE_CODE_SESSION_ID / CLAUDE_PID: https://code.claude.com/docs/en/env-vars.md
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class Refusal extends Error {}
const refuse = (m) => { throw new Refusal(m); };

// ── shared formats ───────────────────────────────────────────────────────────
// Imported from the kit's registry.mjs (it runs nothing on import), so onboarding reads rows and counters exactly as
// the kit tools will: one row rule (registry.mjs rowIdOf/countsAsRow; the doctor uses the same rule).
import { ROW_RE, COUNTER_RE, rowIdOf, rowIdsOf, countsAsRow, offloadState, offloadNote } from '../templates/claude/tools/registry.mjs';
export { ROW_RE, COUNTER_RE };
// Any ID mention; same boundaries as clockwork-doctor.mjs idRe().
const ID_RE = /(?<![A-Za-z0-9])([A-Z]+)-(\d+)(?!\d)/g;
const REG_BASE = ['TASKS', 'CLIENT', 'CLIENT-REQUESTS', 'FACTS', 'MEETING-LOG', 'OPEN-ASKS', 'APPROVAL-QUEUE', 'DOC-MAP', 'ROUTING'];
const OWNER_SECTIONS = { TASKS: ['Open'], CLIENT: ['Client asks', 'Confirmed Decisions', 'Standing Obligations'], 'OPEN-ASKS': ['Open'], 'APPROVAL-QUEUE': ['Queue'] };
const DEFAULT_PREFIXES = { T: 'TASKS.md', C: 'CLIENT.md', CD: 'CLIENT.md', A: 'OPEN-ASKS.md', Q: 'APPROVAL-QUEUE.md' };
const STUB_RE = /→\s*archived|archived\s*→|→\s*`?[A-Z-]*ARCHIVE\.md/i; // same as the doctor's stub test
const VOID_DUP = '✖ VOID — duplicate of';

const HEAVY = new Set(['node_modules', '.next', 'dist', 'build', 'vendor', '.cache', '.turbo', '.parcel-cache', 'coverage',
  '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.svelte-kit', '.nuxt', '.output', '.vercel', '.expo', 'Pods', '.gradle', '.DS_Store']);
const BIG = 5 * 1024 * 1024;
const GIT_CAP = 500 * 1024 * 1024;
const DOC_TEXT = new Set(['.md', '.mdx', '.markdown', '.mdc', '.rst', '.txt']);
const DOC_BIN = new Set(['.docx', '.doc', '.pdf', '.vtt', '.srt', '.pptx', '.xlsx', '.eml', '.msg', '.rtf', '.pages']);
const WORKDIR = '.clockwork-onboard'; // census/compare/migrate logs inside a staging copy; never applied
const PRISTINE = `${WORKDIR}/pristine`; // clone of every staged file as it was at stage time (read-only "before")
const PLAN = 'ONBOARDING-PLAN.md';
const MANIFEST = 'staging-manifest.json';
const APPLYING = 'APPLYING.json'; // in the apply backup folder while writes are in progress
const NO_PUSH = 'no-push://clockwork-onboard-staging-copy';
// Gitignored Clockwork files a worktree needs (CONTRACT-ONBOARD §1.5). Registries are NOT copied: tools read the
// main copy. https://code.claude.com/docs/en/worktrees.md "Copy gitignored files into worktrees" (read 2026-09-30):
// .gitignore syntax; a file is copied only if it matches AND is gitignored; name the ignored directory in the pattern.
const WTI_LINES = ['.claude/clockwork.json', '.claude/settings.json', '.claude/hooks/**', '.claude/tools/**', '.claude/rules/**', '.claude/agents/**', '.claude/skills/**', '.claude/workflows/**'];

// ── small helpers ────────────────────────────────────────────────────────────
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
// realpathSync.native returns the on-disk case on macOS, so two spellings of one folder compare equal.
const real = (p) => { try { return fs.realpathSync.native(p); } catch { try { return fs.realpathSync(p); } catch { return path.resolve(p); } } };
// A path that may not exist yet: the real path of its deepest existing folder + the missing tail.
function resolveDeep(p) {
  let cur = path.resolve(p); const tail = [];
  for (;;) {
    try { const r = fs.realpathSync.native(cur); return tail.length ? path.join(r, ...tail.reverse()) : r; } catch { /* not there yet */ }
    const up = path.dirname(cur); if (up === cur) return path.resolve(p);
    tail.push(path.basename(cur)); cur = up;
  }
}
// macOS folders are case- and Unicode-normalisation-insensitive: compare folded.
const fold = (x) => (process.platform === 'darwin' ? x.normalize('NFC').toLowerCase() : x);
const pad2 = (n) => String(n).padStart(2, '0');
const now = () => (process.env.CLOCKWORK_ONBOARD_NOW ? new Date(process.env.CLOCKWORK_ONBOARD_NOW) : new Date());
const stamp = (d = now()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
const isoDate = (d = now()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const slugOf = (p) => path.basename(p).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
const cut = (s, n = 140) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const within = (child, parent) => { const r = path.relative(fold(parent), fold(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
// iCloud offloads files on a synced Desktop; reading an offloaded one can wait forever (registry.mjs offloadState, the
// kit's one check). Every project read goes through these two: an offloaded file is refused, never read.
const mustBeLocal = (p) => { if (offloadState(p) === 'offloaded') refuse(offloadNote(p)); return p; };
const readText = (p) => fs.readFileSync(mustBeLocal(p), 'utf8');
const readBuf = (p) => fs.readFileSync(mustBeLocal(p));
function writeAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.onboard-tmp-${process.pid}`);
  try { fs.writeFileSync(tmp, data); if (mode) fs.chmodSync(tmp, mode); fs.renameSync(tmp, file); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ } throw e; }
  if (sha(fs.readFileSync(file)) !== sha(typeof data === 'string' ? Buffer.from(data) : data)) throw new Error(`${file} did not verify after writing`);
}
const gitEnv = () => { const e = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete e[k]; return e; };
// GIT_OPTIONAL_LOCKS=0: `git status` must not refresh (write) the index of a real project.
function git(cwd, args, timeout = 15000) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, code: null, out: '', err: r.error.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000} s` : r.error.message };
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const redact = (url) => url.replace(/\/\/[^@/\s]+@/, '//***@');

function parseArgs(argv, bools = []) {
  const out = { _: [] }; const b = new Set(['json', ...bools]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (b.has(k)) out[k] = true;
    else { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) refuse(`--${k} needs a value`); out[k] = argv[++i]; }
  }
  return out;
}

// ── walking ──────────────────────────────────────────────────────────────────
// mode: 'discover' | 'census' | 'stage' | 'apply'. Returns the reason a folder is skipped, or null.
function dirSkip(rel, name, mode) {
  if (HEAVY.has(name)) return 'dependencies / build output';
  if (name === WORKDIR) return 'onboarding work folder';
  if (/(^|\/)\.claude\/worktrees$/.test(rel)) return 'Claude Code worktrees (separate checkouts)';
  if (/(^|\/)\.claude\/\.state$/.test(rel)) return 'Clockwork session state';
  if (/(^|\/)\.claude\/\.clockwork-backups$/.test(rel) && (mode === 'discover' || mode === 'stage')) return 'Clockwork backups';
  if (name === '.worktrees') return 'git worktrees (separate checkouts)';
  if (/(^|\/)wp-content\/uploads$/.test(rel) && mode !== 'apply') return 'WordPress media uploads';
  if (mode === 'discover' || mode === 'census') {
    if (/(^|\/)(wp-admin|wp-includes|wp-content\/plugins|wp-content\/languages)$/.test(rel)) return 'WordPress core / third-party plugins';
  }
  return null;
}
function walk(root, mode, maxFiles = 250000) {
  const files = [], skipped = [], gitEntries = [];
  let truncated = false;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let ents;
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { skipped.push({ rel: rel || '.', why: `unreadable (${e.code || e.message})` }); continue; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === '.git') { gitEntries.push({ rel: r, dir: e.isDirectory() }); continue; }
      if (e.isDirectory()) {
        const why = dirSkip(r, e.name, mode) || linkedWorktree(path.join(root, r));
        if (why) skipped.push({ rel: r, why }); else stack.push(r);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (e.name === '.DS_Store') continue;
        if (files.length >= maxFiles) { truncated = true; continue; }
        let st; try { st = fs.lstatSync(path.join(root, r)); } catch { continue; }
        files.push({ rel: r, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777, link: st.isSymbolicLink(), offloaded: offloadState(path.join(root, r), st) === 'offloaded' });
      }
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped, gitEntries, truncated };
}
// A sub-folder whose .git is a file pointing into …/worktrees/… is another checkout of a repo, not project content.
function linkedWorktree(abs) {
  try { const t = readText(path.join(abs, '.git')); return /^gitdir:.*[\\/]worktrees[\\/]/m.test(t) ? 'git worktree (separate checkout)' : null; } catch { return null; }
}
function dirBytes(abs, offloaded = null) {
  let n = 0; const stack = [abs];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name); if (e.isDirectory()) { stack.push(p); continue; }
      try { const st = fs.lstatSync(p); n += st.size; if (offloaded && offloadState(p, st) === 'offloaded') offloaded.push(p); } catch { /* vanished */ }
    }
  }
  return n;
}
// One NOT CHECKED line per offloaded file (a long list is cut, with the full list in the JSON).
const offloadLines = (root, rels, max = 10) => [...rels.slice(0, max).map((r) => offloadNote(path.join(root, r))),
  ...(rels.length > max ? [`not checked: ${rels.length - max} more offloaded file(s) (all of them: "offloaded" in --json)`] : [])];

// ── classification ───────────────────────────────────────────────────────────
// "TASKS 2.md" next to "TASKS.md" = an iCloud conflict copy (same rule as install.mjs dupOf()).
const dupOf = (name) => { const m = /^(.+) \d+(\.[^.]+)?$/.exec(name); return m ? m[1] + (m[2] || '') : null; };
export function registryInfo(base) {
  let b = base, conflict = false;
  const d = dupOf(b); if (d && /\.md$/i.test(d)) { b = d; conflict = true; }
  const m = /^([A-Z][A-Z-]*?)(-ARCHIVE)?\.md$/.exec(b);
  if (!m || !REG_BASE.includes(m[1])) return null;
  return { name: m[1], archive: !!m[2], conflict };
}
function docKind(rel) {
  const base = path.posix.basename(rel), ext = path.posix.extname(base).toLowerCase(), segs = rel.split('/'), lower = rel.toLowerCase();
  const text = DOC_TEXT.has(ext), bin = DOC_BIN.has(ext);
  if (base === 'CLAUDE.local.md') return 'personal';
  if (['.cursorrules', '.windsurfrules', '.clinerules'].includes(base)) return 'instructions';
  if (lower.startsWith('.cursor/rules/') && (text || ext === '')) return 'instructions';
  if (lower === '.github/copilot-instructions.md' || lower.startsWith('.github/instructions/')) return 'instructions';
  if (!text && !bin) return null;
  if (BACKUP_DIR.test(rel)) return 'backup';
  if (registryInfo(base)) return 'registry';
  if (['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'].includes(base)) return 'instructions';
  if (segs.includes('.claude')) return text ? 'claude-doc' : null;
  if (segs.some((s) => /^(meetings?|transcripts?|minutes|notulen)$/i.test(s))) return 'meeting';
  if (segs[0] === 'PM' || segs.includes('PM')) return 'pm';
  // A .docx/.pdf/… anywhere else is a document too (counted, read through its converted text, and a removal is LOST);
  // site assets (public/, static/, assets/, uploads/) are not project documents.
  if (!text) return /(^|\/)(public|static|assets|uploads|media)\//i.test(rel) ? null : /^docs?$/i.test(segs[0]) ? 'docs' : 'other-doc';
  if (/^docs?$/i.test(segs[0])) return 'docs';
  if (/^readme/i.test(base)) return 'readme';
  if (/todo|notes|tasks|backlog|roadmap|changelog|decisions|handover|findings|design|brief|spec/i.test(base)) return 'notes';
  if (ext === '.txt') return null; // robots.txt, LICENSE.txt, … are not documentation
  return 'other-doc';
}
const isTextDoc = (rel) => DOC_TEXT.has(path.posix.extname(rel).toLowerCase()) || /(^|\/)\.(cursorrules|windsurfrules|clinerules)$/.test(rel);
const BACKUP_DIR = /(^|\/)[^/]*backups?\//i; // .clockwork-backups/, registry-backups/, backups/, backup/
// Old design DOCUMENTS that onboarding condenses into .claude/rules/design-system.md: mapping.md case A "Long
// append-only DESIGN-SYSTEM.md" and case B "DESIGN-GUIDE / style guide doc". ONE rule for discover's design inventory
// and the design-coverage gate, so a file discover lists as a design source is never skipped by the gate.
// By name: design.md, brand.md, branding.md (and -v2); DESIGN-SYSTEM / design-guide(lines) / -rules / -standards /
// -tokens / -spec / -language / -principles, style-guide(s), styleguide, style-guidelines, brand-guide(lines) / -book /
// -identity / -system, ui- or visual-guide(lines) / -system / -language, each with any suffix (DESIGN-SYSTEM-v2.md,
// style-guide 2.md). By folder: any of these under design-system/, "Design System"/, brand/, branding/, style-guide/.
// Not a bare design/ folder: "design docs" there are as often technical designs.
const DESIGN_DOC_NAME = new RegExp('^(?:(?:design|brand(?:ing)?)(?:[-_ ]?v\\d+)?'
  + '|(?:design[-_ ]?(?:system|guide|guidelines|rules|standards|tokens?|specs?|language|principles)'
  + '|style[-_ ]?(?:guides?|guidelines)|brand[-_ ]?(?:guide|guidelines|book|identity|system|standards)'
  + '|(?:ui|visual)[-_ ]?(?:guide|guidelines|system|language|identity|standards))(?:[-_ .][^/]*)?)\\.(?:md|mdx|markdown)$', 'i');
const DESIGN_DOC_DIR = /(^|\/)(design[-_ ]?system|brand(ing)?|style[-_ ]?guides?)(\/|$)/i;
export const isDesignDoc = (rel) => /\.(md|mdx|markdown)$/i.test(rel) && (DESIGN_DOC_NAME.test(path.posix.basename(rel)) || DESIGN_DOC_DIR.test(path.posix.dirname(rel)));
const fileClass = (rel) => (/(^|\/)\.clockwork-backups\/conflict-copies\//.test(rel) ? 'conflict-copy'
  : BACKUP_DIR.test(rel) ? 'backup' : /(^|\/)reports\/onboarding-[^/]+\//.test(rel) ? 'onboarding-report' : 'live');
// Never staged. `.env.example` / `.sample` / `.template` are documentation, not secrets.
export const SECRET = (rel) => {
  const b = path.posix.basename(rel), lower = b.toLowerCase(), segs = rel.split('/');
  if (/^\.env/i.test(b)) return /\.(example|sample|template)$/i.test(b) ? null : 'env file';
  if (/\.env$/i.test(b)) return 'env file';
  if (/\.(pem|key|p12|pfx|keystore|jks|ppk|p8)$/i.test(b) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(b)) return 'key file (a Keynote .key deck lands here too: copy it by hand if needed)';
  if (['.npmrc', '.netrc', '_netrc', '.pypirc', 'auth.json', '.dev.vars', 'wp-config.php', '.git-credentials', '.pgpass', '.htpasswd', 'kubeconfig', '.boto', '.s3cfg'].includes(lower)) return 'may hold credentials';
  if (/^credentials(\..+)?$/i.test(b) || /credentials?[^/]*\.(json|ya?ml|toml|ini|xml)$/i.test(b)) return 'may hold credentials';
  if (/^(service[-_]?account|secrets?|client[-_]secret)[^/]*\.(json|ya?ml|toml)$/i.test(b) || /service[-_]?account[^/]*\.json$/i.test(b) || /-adminsdk-[^/]*\.json$/i.test(b)) return 'may hold credentials';
  if (/^deploy[-_]?key/i.test(b)) return 'key file';
  if (/\.tfvars(\.json)?$/i.test(b) || /\.tfstate/i.test(b)) return 'Terraform variables or state (credentials)';
  if (segs.slice(0, -1).some((s) => ['.aws', '.ssh', '.gnupg'].includes(s)) || /(^|\/)\.docker\/config\.json$/.test(rel)) return 'credential folder';
  if (/(^|\/)app\/etc\/env\.php$/.test(rel)) return 'Magento env.php (credentials)';
  if (lower === '.mcp.json' || lower === 'settings.local.json') return 'MCP or local Claude settings (their env blocks often hold keys)';
  if (/^(?:[\w.-]*[-_.])?token(?:[-_.][\w.-]*)?\.(?:json|pickle)$/i.test(b) || /\.pickle$/i.test(b)) return 'saved login token';
  if (/[-_.]key\.json$/i.test(b) || (/api[-_]?keys?/i.test(b) && !/\.mdx?$/i.test(b))) return 'key file';
  if (['rclone.conf', 'parameters.yml', 'parameters.yaml', 'local-config.php'].includes(lower) || /^appsettings(\.[\w-]+)?\.json$/i.test(b)
    || (/^wp-config[-_.].*\.php$/i.test(b) && !/sample/i.test(b)) || /^env\.(local|production|prod|development|dev|staging|test)$/i.test(b)) return 'may hold credentials';
  return null;
};
// user:token@ in a remote URL is a credential; `git@` (ssh user) is not.
const scrubUserinfo = (s) => s.replace(/(\/\/)([^@/\s"]+)@/g, (m, sl, u) => (u === 'git' ? m : sl));

// ── markdown table + registry parsing ───────────────────────────────────────
// Same cell rules as registry.mjs pipesOf()/cellsOf(): split on unescaped pipes, positions in the right-trimmed line.
function cellsOf(line) {
  const t = line.replace(/\s+$/, ''); const at = [];
  for (let i = 0; i < t.length; i++) if (t[i] === '|' && t[i - 1] !== '\\') at.push(i);
  const cells = [];
  for (let i = 0; i < at.length - 1; i++) cells.push({ s: at[i] + 1, e: at[i + 1], text: t.slice(at[i] + 1, at[i + 1]) });
  if (at.length && at[at.length - 1] < t.length - 1) cells.push({ s: at[at.length - 1] + 1, e: t.length, text: t.slice(at[at.length - 1] + 1) });
  return { t, cells };
}
const keyOf = (p, n) => `${p}-${Number(n)}`;

// A counter line starts (after "> " and optional bold) with "next free" / "ID counter — next free".
// Formats seen in the live projects (2026-09-30): > **ID counter — next free: `T-210`** · > **ID counter — next free: C-52**
// · > **Next free: T-242** · > **Next free T-##: T-462.** · > **Next free C-##: C-147** · > **Next free IDs:** C-147
// · > **Next free: C-36** · **Next free: D-21** · > Next free: **C-37** · **CD-21**. · > Next free: **T-258**.
const CTR_HEAD = /^(\*\*)?\s*(?:ID counter\s*[—–-]+\s*)?next[ -]?free(?:\s+IDs?)?(?:\s+[A-Z]+-#+)?\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*:?\s*/i;
const CTR_SEP = /^\s*(?:·|,|\/|&|\+|\band\b)\s*(?:\*\*)?\s*(?:(?:ID counter\s*[—–-]+\s*)?next[ -]?free(?:\s+IDs?)?(?:\s+[A-Z]+-#+)?\s*:?\s*(?:\*\*)?\s*:?\s*)?/i;
export function parseCounterLine(line) {
  const q = /^\s*(?:>\s*)*/.exec(line)[0];
  const rest = line.slice(q.length);
  const h = CTR_HEAD.exec(rest);
  if (!h) return null;
  let pos = h[0].length; const ids = [];
  const tok = (at) => { const m = /^(?:\*\*)?\s*`?([A-Z]+)-(\d+)`?(?![\d#])\s*(?:\*\*)?/.exec(rest.slice(at)); return m; };
  let m = tok(pos);
  if (!m) return null;
  ids.push({ prefix: m[1], num: Number(m[2]), digits: m[2] }); pos += m[0].length;
  for (;;) {
    const s = CTR_SEP.exec(rest.slice(pos));
    if (!s) break;
    const n = tok(pos + s[0].length);
    if (!n) break;
    ids.push({ prefix: n[1], num: Number(n[2]), digits: n[2] }); pos += s[0].length + n[0].length;
  }
  const tail = /^\.?(?:\*\*)?\.?/.exec(rest.slice(pos)); pos += tail[0].length;
  const span = rest.slice(0, pos);
  const note = rest.slice(pos).replace(/^\s*(?:[·—–:;,.-]\s*)*/, '').trim();
  const v2 = ids.length === 1 && new RegExp(COUNTER_RE.source).test(span);
  const shape = span.replace(/`?([A-Z]+)-(\d+)`?/g, (x) => (x.startsWith('`') ? '`X-n`' : 'X-n')).replace(/[A-Z]+-#+/g, 'X-##').replace(/\s+/g, ' ').trim();
  return { quote: q, span, ids, note: /[\p{L}\p{N}]/u.test(note) ? note : '', v2, shape: `${q.includes('>') ? '> ' : ''}${shape}` };
}

function headerEnd(lines) {
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    else if (!fence && lines[i].startsWith('## ')) return i;
  }
  return lines.length;
}
// One registry file → rows (doctor-compatible: the first cell STARTS with an ID), counters, mentions, sections.
export function parseRegistry(text) {
  const lines = text.split('\n'); const hEnd = headerEnd(lines);
  const rows = [], counters = [], sections = [], mentions = new Map();
  let fence = false;
  const mention = (s) => { for (const m of s.matchAll(ID_RE)) { const k = keyOf(m[1], m[2]); mentions.set(k, (mentions.get(k) || 0) + 1); } };
  lines.forEach((ln, i) => {
    // A counter names an UNUSED id, so it is not a mention (as in the doctor); its note part is.
    const c = !fence && i < hEnd ? parseCounterLine(ln) : null;
    if (c) { counters.push({ ...c, line: i }); mention(c.note); return; }
    mention(ln);
    if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; return; }
    if (fence) return;
    if (ln.startsWith('## ')) { sections.push({ heading: ln.trim(), line: i }); return; }
    if (!ln.startsWith('|')) return;
    const { cells } = cellsOf(ln);
    if (!cells.length) return;
    const first = cells[0].text, bare = first.replace(/[*~]/g, '').trim();
    const all = [...bare.matchAll(ID_RE)];
    if (!all.length || all[0].index !== 0) return;
    const onlyIds = bare.replace(ID_RE, '').replace(/[\s/·,&+]/g, '') === '';
    const ids = (onlyIds ? all : all.slice(0, 1)).map((x) => keyOf(x[1], x[2]));
    const strict = /^\s*(?:~~\s*)?(?:\*\*)?\s*[A-Z]+-\d+\s*(?:\*\*)?(?:\s*~~)?\s*$/.test(first) && ids.length === 1;
    rows.push({
      line: i, ids, strict, first, text: ln, cells: cells.map((c) => c.text),
      kitRow: rowIdOf(ln), // the ID this line is the row of under the kit's row rule, or null (`| T-12a |`, `| T-3 (again) |`)
      full: countsAsRow(ln), // not a pointer row, not a "✖ VOID — duplicate of" row
      bold: /^\s*(?:~~\s*)?\*\*\s*[A-Z]+-\d+\s*\*\*(?:\s*~~)?\s*$/.test(first),
      struck: /^\s*\**~~/.test(first),
      stub: cells.length <= 2 || cells.slice(1).some((c) => STUB_RE.test(c.text)),
      status: cells[cells.length - 1].text.trim(),
    });
  });
  return { lines, hEnd, rows, counters, sections, mentions };
}

// Line normalisation for the census: formatting-only edits (bold, quote, heading level, list marker, spacing, case)
// keep the same hash, so `| **T-1** |` → `| T-1 |` or `## X (note)` → `### X (note)` is not a loss.
export function normLine(s) {
  let t = s.replace(/\r$/, '').trim();
  t = t.replace(/^(?:>\s*)+/, '').replace(/^#{1,6}\s+/, '').replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
  t = t.replace(/\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return /[\p{L}\p{N}]/u.test(t) ? t : null;
}
const lineHash = (n) => sha(n).slice(0, 16);

// ── live sessions + sync ─────────────────────────────────────────────────────
export function liveSessions(project) {
  const bin = process.env.CLOCKWORK_CLAUDE_BIN || 'claude';
  const r = spawnSync(bin, ['agents', '--json', '--cwd', project], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return { checked: false, sessions: [], error: r.error ? (r.error.code === 'ETIMEDOUT' ? 'timed out after 15 s' : r.error.message) : `exit ${r.status}: ${cut(r.stderr || r.stdout, 200)}` };
  let list;
  try { list = JSON.parse(r.stdout); } catch { return { checked: false, sessions: [], error: `not JSON: ${cut(r.stdout, 120)}` }; }
  if (!Array.isArray(list)) return { checked: false, sessions: [], error: 'not a JSON array' };
  const self = process.env.CLAUDE_CODE_SESSION_ID, selfPid = process.env.CLAUDE_PID;
  const sessions = list.filter((s) => !(self && s.sessionId === self) && !(selfPid && String(s.pid) === String(selfPid)))
    .map((s) => ({ name: s.name || '', sessionId: s.sessionId || '', pid: s.pid, cwd: s.cwd || '', kind: s.kind || '', status: s.status || '' }));
  return { checked: true, sessions, error: null };
}
function syncedRootOf(p) { // same roots as install.mjs syncedRoots()
  const env = process.env.CLOCKWORK_SYNCED_ROOTS;
  let roots;
  if (env !== undefined) roots = env.split(path.delimiter).filter(Boolean);
  else {
    const h = os.homedir(), docs = path.join(h, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    roots = [path.join(h, 'Library', 'Mobile Documents'), path.join(h, 'Library', 'CloudStorage')];
    if (exists(path.join(docs, 'Desktop')) || exists(path.join(docs, 'Documents'))) roots.push(path.join(h, 'Desktop'), path.join(h, 'Documents'));
  }
  const norm = (x) => (process.platform === 'darwin' ? x.toLowerCase() : x);
  for (const r of roots) { const rr = real(r); if (norm(p) === norm(rr) || norm(p).startsWith(norm(rr + path.sep))) return r; }
  return null;
}

// ── discover ─────────────────────────────────────────────────────────────────
function stackOf(dir) {
  const has = (f) => exists(path.join(dir, f));
  const why = [];
  let pkg = null; try { pkg = JSON.parse(readText(path.join(dir, 'package.json'))); } catch { /* none or unreadable */ }
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  if (deps.next) return { stack: 'nextjs', detail: `next ${deps.next}`, why: 'package.json lists next' };
  const themeHeader = () => { try { return /Theme Name:/i.test(readText(path.join(dir, 'style.css')).slice(0, 2000)); } catch { return false; } };
  if (has('wp-config.php') || has('wp-content') || (has('style.css') && themeHeader()) || (has('theme.json') && has('functions.php')))
    return { stack: 'wordpress', detail: has('wp-content') || has('wp-config.php') ? 'WordPress install' : 'WordPress theme', why: 'wp-config.php / wp-content / theme style.css header / theme.json + functions.php' };
  if (has('app/etc/env.php') || has('bin/magento')) return { stack: 'other', detail: 'magento', why: 'app/etc/env.php or bin/magento' };
  if (has('composer.json')) why.push('composer.json');
  if (['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].some(has)) return { stack: 'python', detail: 'python', why: 'python project file' };
  for (const [d, label] of [['astro', 'astro'], ['@sveltejs/kit', 'sveltekit'], ['nuxt', 'nuxt'], ['vite', 'vite'], ['react', 'react'], ['express', 'express']]) if (deps[d]) return { stack: 'other', detail: label, why: `package.json lists ${d}` };
  if (pkg) return { stack: 'other', detail: 'node', why: 'package.json without a known framework' };
  if (why.length) return { stack: 'other', detail: 'php', why: why.join(', ') };
  return null;
}
function gitFacts(abs, rel) {
  const f = { dir: rel || '.', notChecked: [] };
  const top = git(abs, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']);
  if (!top.ok) { f.isRepo = false; f.notChecked.push(`git in ${rel || '.'}: ${top.err || 'not a repository'}`); return f; }
  const [gitDir, common, toplevel] = top.out.split('\n');
  f.isRepo = true; f.linkedWorktree = real(gitDir) !== real(common); if (f.linkedWorktree) f.mainGitDir = common;
  f.toplevel = toplevel;
  const run = (label, args, fn) => { const r = git(abs, args); if (r.ok) fn(r.out); else f.notChecked.push(`${label}: ${r.err || `exit ${r.code}`}`); };
  run('remotes', ['remote', '-v'], (o) => { const m = new Map(); for (const l of o.split('\n').filter(Boolean)) { const [n, u] = l.split(/\s+/); m.set(n, redact(u)); } f.remotes = [...m].map(([name, url]) => ({ name, url })); });
  run('current branch', ['branch', '--show-current'], (o) => { f.branch = o || '(detached HEAD)'; });
  run('branches', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], (o) => { const b = o.split('\n').filter(Boolean); f.branchCount = b.length; f.otherBranches = b.filter((x) => x !== f.branch).slice(0, 40); });
  run('worktrees', ['worktree', 'list', '--porcelain'], (o) => { const w = []; let cur = null; for (const l of o.split('\n')) { if (l.startsWith('worktree ')) { cur = { path: l.slice(9) }; w.push(cur); } else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, ''); } f.worktrees = w; });
  run('uncommitted files', ['status', '--porcelain'], (o) => { const d = o.split('\n').filter(Boolean); f.dirtyCount = d.length; f.dirty = d.slice(0, 25); });
  run('commit count', ['rev-list', '--count', 'HEAD'], (o) => { f.commits = Number(o); });
  run('last commit', ['log', '-1', '--format=%cI %h %s'], (o) => { f.lastCommit = cut(o, 120); });
  const ig = git(abs, ['check-ignore', '-q', '--no-index', '.claude/clockwork-probe']);
  if (ig.code === 0) f.claudeIgnored = true; else if (ig.code === 1) f.claudeIgnored = false; else f.notChecked.push(`.claude/ ignore check: ${ig.err || 'failed'}`);
  if (f.claudeIgnored) f.claudeIgnoredNote = '.claude/ is ignored by git here — keep it that way (CONTRACT-ONBOARD §1.5); worktrees then need .worktreeinclude to carry .claude/rules/** and the registry path printed at session start';
  return f;
}
function gitRefCopies(absGitDir) {
  const out = [], isCopy = (n) => / \d+(\.[^.]+)?$/.test(n);
  try { for (const n of fs.readdirSync(absGitDir)) if (isCopy(n)) out.push(n); } catch { /* unreadable */ }
  const stack = [path.join(absGitDir, 'refs')];
  while (stack.length) {
    const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) { if (e.isDirectory()) stack.push(path.join(d, e.name)); if (isCopy(e.name)) out.push(path.relative(absGitDir, path.join(d, e.name))); }
  }
  return out;
}

export function discover(projectArg) {
  const root = real(path.resolve(projectArg));
  if (!exists(root) || !fs.statSync(root).isDirectory()) refuse(`project folder does not exist: ${root}`);
  const notChecked = [];
  const w = walk(root, 'discover');
  if (w.truncated) notChecked.push(`stopped listing after ${w.files.length} files; the rest were not inventoried`);
  for (const s of w.skipped) if (/unreadable/.test(s.why)) notChecked.push(`${s.rel}: ${s.why}`);
  const byRel = new Set(w.files.map((f) => f.rel));
  const offloaded = w.files.filter((f) => f.offloaded).map((f) => f.rel);
  notChecked.push(...offloadLines(root, offloaded));
  const off = new Set(offloaded);
  // documentation
  const docs = [];
  for (const f of w.files) { const k = docKind(f.rel); if (k) docs.push({ path: f.rel, bytes: f.size, kind: k, ...(f.offloaded ? { offloaded: true } : {}) }); }
  // registries
  const registries = [];
  const regFiles = docs.filter((d) => d.kind === 'registry');
  for (const d of regFiles) {
    const info = registryInfo(path.posix.basename(d.path));
    if (off.has(d.path)) continue; // offloaded: listed under NOT CHECKED, never read
    let p; try { p = parseRegistry(readText(path.join(root, d.path))); } catch (e) { notChecked.push(`${d.path}: could not read (${e.code || e.message})`); continue; }
    const prefixes = {};
    for (const r of p.rows) for (const k of r.ids) { const pre = k.split('-')[0]; (prefixes[pre] ??= { rows: 0, max: 0 }).rows++; }
    for (const [k] of p.mentions) { const [pre, n] = k.split('-'); if (prefixes[pre]) prefixes[pre].max = Math.max(prefixes[pre].max, Number(n)); }
    const dups = info.archive || info.conflict ? [] : duplicatesOf(p);
    const counters = p.counters.map((c) => ({ line: c.line + 1, ids: c.ids.map((x) => `${x.prefix}-${x.digits}`), format: c.shape, canonical: c.v2, note: c.note ? cut(c.note, 80) : '' }));
    const v2Matches = {}; for (const ln of p.lines.slice(0, p.hEnd)) for (const m of ln.matchAll(COUNTER_RE)) v2Matches[m[1]] = (v2Matches[m[1]] || 0) + 1;
    const maxAll = {}; for (const [k] of p.mentions) { const [pre, n] = k.split('-'); maxAll[pre] = Math.max(maxAll[pre] || 0, Number(n)); }
    const counterOnly = [];
    const rowKeys = new Set(p.rows.flatMap((r) => r.ids));
    const idOwner = ['TASKS', 'CLIENT', 'CLIENT-REQUESTS', 'OPEN-ASKS', 'APPROVAL-QUEUE'].includes(info.name) && !info.archive;
    if (idOwner) for (const c of p.counters) for (const m of c.note.matchAll(ID_RE)) counterOnly.push(keyOf(m[1], m[2]));
    if (idOwner) for (const ln of p.lines.slice(0, p.hEnd)) { if (parseCounterLine(ln)) continue; for (const m of ln.matchAll(ID_RE)) counterOnly.push(keyOf(m[1], m[2])); }
    for (let i = counterOnly.length - 1; i >= 0; i--) if (rowKeys.has(counterOnly[i])) counterOnly.splice(i, 1);
    registries.push({
      path: d.path, bytes: d.bytes, registry: info.name, archive: info.archive, conflictCopy: info.conflict,
      rows: p.rows.length, prefixes, counters, registryToolSees: v2Matches, counterBehind: [], _max: maxAll, _ctr: p.counters, _rows: rowKeys,
      headerBytes: Buffer.byteLength(p.lines.slice(0, p.hEnd).join('\n')), headerIdsWithoutRow: counterOnly,
      boldIds: p.rows.filter((r) => r.bold).length, struckRows: p.rows.filter((r) => r.struck).length,
      duplicates: dups.map((x) => ({ id: x.id, lines: x.lines })), sections: p.sections.map((s) => s.heading),
    });
  }
  // Counter behind = the counter's number is already used in the file or its archive (the doctor's COUNTER error).
  for (const r of registries) {
    const arch = registries.find((x) => x.archive && path.posix.dirname(x.path) === path.posix.dirname(r.path) && x.registry === r.registry && !x.conflictCopy);
    if (!r.archive && !r.conflictCopy) for (const c of r._ctr) for (const id of c.ids) {
      const mx = Math.max(r._max[id.prefix] || 0, arch?._max[id.prefix] || 0);
      if (mx >= id.num) r.counterBehind.push(`${id.prefix}: counter says next free ${id.prefix}-${id.digits}, but ${id.prefix}-${mx} is already used${arch && (arch._max[id.prefix] || 0) === mx ? ` (in ${arch.path})` : ''}`);
    }
  }
  const regPrefixes = new Set(registries.flatMap((r) => [...Object.keys(r.prefixes), ...r._ctr.flatMap((c) => c.ids.map((x) => x.prefix))]));
  for (const r of registries) {
    const arch = registries.find((x) => x.archive && path.posix.dirname(x.path) === path.posix.dirname(r.path) && x.registry === r.registry && !x.conflictCopy);
    r.headerIdsWithoutRow = [...new Set(r.headerIdsWithoutRow)].filter((k) => regPrefixes.has(k.split('-')[0]) && !(arch?._rows || new Set()).has(k)).slice(0, 40);
  }
  for (const r of registries) { delete r._max; delete r._ctr; delete r._rows; }
  const counterFormats = {};
  for (const r of registries) for (const c of r.counters) (counterFormats[c.format] ??= []).push(`${r.path}:${c.line}`);
  // conflict copies anywhere + in git refs
  const conflictCopies = w.files.filter((f) => { const b = dupOf(path.posix.basename(f.rel)); return b && byRel.has(path.posix.join(path.posix.dirname(f.rel), b)); })
    .map((f) => ({ path: f.rel, copyOf: path.posix.join(path.posix.dirname(f.rel), dupOf(path.posix.basename(f.rel))), bytes: f.size }));
  // git
  const repoDirs = [...new Set(w.gitEntries.map((g) => path.posix.dirname(g.rel)).map((d) => (d === '.' ? '' : d)))].sort();
  const gitInfo = [];
  for (const d of repoDirs) {
    const abs = path.join(root, d);
    const f = gitFacts(abs, d);
    const ge = w.gitEntries.find((g) => path.posix.dirname(g.rel) === (d || '.'));
    if (ge?.dir) { const rc = gitRefCopies(path.join(abs, '.git')); if (rc.length) f.refConflictCopies = rc; }
    gitInfo.push(f); notChecked.push(...f.notChecked); delete f.notChecked;
  }
  if (!repoDirs.includes('')) { const up = git(root, ['rev-parse', '--show-toplevel']); if (up.ok && real(up.out) !== root) gitInfo.unshift({ dir: '.', isRepo: true, insideRepoAbove: up.out }); }
  if (!gitInfo.length) notChecked.push('git: no repository found in the project or its sub-folders');
  // stacks: root and first-level folders
  const stacks = [];
  const s0 = stackOf(root); if (s0) stacks.push({ dir: '.', ...s0 });
  try { for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && !HEAVY.has(e.name)) { const s = stackOf(path.join(root, e.name)); if (s) stacks.push({ dir: e.name, ...s }); } } catch { /* unreadable root handled above */ }
  const main = stacks.find((s) => s.dir === '.') || stacks[0] || { dir: '.', stack: 'other', detail: 'none detected', why: 'no package.json / composer.json / WordPress / python markers' };
  // design sources + Figma links
  const design = w.files.filter((f) => !BACKUP_DIR.test(f.rel)).filter((f) => isDesignDoc(f.rel) || /(^|\/)(tailwind\.config\.[cm]?[jt]s|theme\.json|[^/]*tokens?[^/]*\.(json|css|scss|ts|js)|globals\.css|variables\.s?css|_variables\.scss)$/i.test(f.rel) || /(^|\/)(design[ -]?system|brand(ing)?|style-?guide)(\/|$)/i.test(path.posix.dirname(f.rel)))
    .map((f) => ({ path: f.rel, bytes: f.size }));
  const figma = new Map();
  for (const d of docs) {
    if (!isTextDoc(d.path) || d.bytes > 2 * BIG || d.offloaded) continue;
    let t; try { t = readText(path.join(root, d.path)); } catch { continue; }
    for (const m of t.matchAll(/https?:\/\/(?:www\.)?figma\.com\/(?:file|design|proto|board|make|slides)\/[A-Za-z0-9]+[^\s)>\]"'`|]*/g)) { const u = m[0].slice(0, 200); if (!figma.has(u)) figma.set(u, d.path); }
  }
  // code TODO/FIXME (case C seeding needs sources)
  const todos = []; let scanned = 0;
  for (const f of w.files) {
    if (!/\.(m?[jt]sx?|php|py|css|scss|vue|svelte|twig|html|rb|go)$/i.test(f.rel) || f.size > 1024 * 1024 || f.link || f.offloaded) continue;
    if (++scanned > 8000) { notChecked.push('TODO/FIXME scan stopped after 8000 code files'); break; }
    let t; try { t = readText(path.join(root, f.rel)); } catch { continue; }
    t.split('\n').forEach((l, i) => { if (/\b(TODO|FIXME|HACK|XXX)\b[:( ]/.test(l)) todos.push(`${f.rel}:${i + 1}: ${cut(l, 100)}`); });
  }
  // case
  const has = (k) => docs.some((d) => d.kind === k);
  const v2 = exists(path.join(root, '.claude', 'clockwork.json'));
  const doctors = w.files.filter((f) => /(^|\/)\.claude\/hooks\/clockwork-doctor\.mjs$/.test(f.rel)).map((f) => f.rel);
  const withCounters = registries.filter((r) => r.counters.length && !r.conflictCopy).map((r) => r.path);
  const names = new Set(registries.map((r) => r.registry));
  const reasons = []; let kase;
  // Already on Clockwork 2 (D16): onboarding still runs, in sweep mode — documents swept into the registries it has;
  // no install, no condense. Case A's rules (registries exist; sweep only what DOC-MAP does not register) apply.
  if (v2) { kase = 'A'; reasons.push('.claude/clockwork.json exists: Clockwork 2 is already installed — sweep mode (documents into the existing registries; no install, no condense)'); }
  if (doctors.length) reasons.push(`${v2 ? 'Clockwork doctor' : 'Clockwork v1 doctor'}: ${doctors.join(', ')}`);
  if (withCounters.length) reasons.push(`registries with ID counter lines: ${withCounters.slice(0, 6).join(', ')}${withCounters.length > 6 ? ' …' : ''}`);
  if (names.has('ROUTING') && names.has('DOC-MAP')) reasons.push('ROUTING.md + DOC-MAP.md (v1 reference layer)');
  if (!kase && reasons.length) kase = 'A';
  const readme = docs.filter((d) => d.kind === 'readme');
  const boiler = (d) => { try { const t = readText(path.join(root, d.path)); return d.bytes < 300 || /bootstrapped with \[?`?create-next-app|This is a \[Next\.js\]\(https:\/\/nextjs\.org\) project/i.test(t); } catch { return true; } };
  const realReadme = readme.filter((d) => !boiler(d));
  const other = ['instructions', 'personal', 'claude-doc', 'docs', 'notes', 'pm', 'meeting', 'registry'].filter(has);
  if (!kase) {
    if (other.length || realReadme.length || docs.some((d) => d.kind === 'other-doc' && d.bytes > 500)) {
      kase = 'B';
      reasons.push(`documentation found: ${[...other, ...(realReadme.length ? ['readme'] : []), ...(has('other-doc') ? ['other-doc'] : [])].join(', ')}`);
    } else {
      kase = 'C';
      reasons.push(readme.length ? 'only a boilerplate or tiny README' : 'no documentation files');
      const g = gitInfo.find((x) => x.isRepo && x.commits !== undefined);
      reasons.push(g ? `sources for seeding: ${g.commits} commits in ${g.dir}, ${todos.length} TODO/FIXME comments` : `no git history; ${todos.length} TODO/FIXME comments`);
    }
  }
  const synced = syncedRootOf(root);
  const live = liveSessions(root);
  if (!live.checked) notChecked.push(`live sessions: ${live.error}`);
  // A project that changes while onboarding runs forces a rebase (or a redo) before apply.
  const hourAgo = now().getTime() - 3600e3;
  const recent = w.files.filter((f) => f.mtimeMs > hourAgo).sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Registries in more than one folder: registry.mjs reaches only <registryDir>, so the others need a decision.
  const regDirs = {};
  for (const r of registries) if (!r.archive && !r.conflictCopy) (regDirs[path.posix.dirname(r.path)] ??= []).push(path.posix.basename(r.path));
  const registryFolders = Object.entries(regDirs).map(([dir, names]) => ({ dir, files: names.sort() }));
  const rootRepo = gitInfo.find((g) => g.dir === '.' || g.dir === '');
  const subRepos = gitInfo.filter((g) => g.isRepo && g.dir && g.dir !== '.').map((g) => g.dir);
  const warnings = [];
  if (offloaded.length) warnings.push(`${offloaded.length} file(s) are offloaded by iCloud and were not read; stage will not copy them (listed under NOT CHECKED). If they matter, download them first (Finder, or brctl download "<path>"), then run discover again`);
  if (live.checked && live.sessions.length) warnings.push(`${live.sessions.length} other Claude session(s) are live in the project: files will keep changing while onboarding runs (then: rebase before apply)`);
  if (recent.length) warnings.push(`${recent.length} file(s) changed in the last hour (newest: ${recent.slice(0, 3).map((f) => f.rel).join(', ')})`);
  if (registryFolders.length > 1) warnings.push(`registries sit in ${registryFolders.length} folders (${registryFolders.map((x) => `${x.dir}: ${x.files.join(', ')}`).join(' · ')}); registry.mjs reaches only one — the plan must ask which`);
  if (gitInfo[0]?.linkedWorktree) warnings.push(`this folder is a LINKED git worktree of ${gitInfo[0].mainGitDir}: onboard the main checkout instead (apply refuses here; registry.mjs would not run)`);
  if ((!rootRepo || !rootRepo.isRepo) && subRepos.length) warnings.push(`the project root is not a git repository; code is in ${subRepos.join(', ')}. Worktrees are made from that repo, so a root .worktreeinclude is never read — the plan must ask`);
  return {
    project: root, slug: slugOf(root), case: kase, mode: v2 ? 'sweep' : 'full', caseReasons: reasons,
    clockwork: { v2, v1Doctors: doctors },
    stack: { guess: main.stack, detail: main.detail, why: main.why, from: main.dir, all: stacks },
    git: gitInfo,
    docs: docs.sort((a, b) => b.bytes - a.bytes), docsTotalBytes: docs.reduce((n, d) => n + d.bytes, 0),
    registries, counterFormats, conflictCopies,
    backups: { files: docs.filter((d) => d.kind === 'backup').length, bytes: docs.filter((d) => d.kind === 'backup').reduce((n, d) => n + d.bytes, 0), folders: [...new Set(docs.filter((d) => d.kind === 'backup').map((d) => d.path.replace(/^((?:.*\/)?[^/]*backups?)\/.*$/i, '$1')))] },
    design: { files: design, figma: [...figma].map(([url, file]) => ({ url, file })) },
    codeTodos: { count: todos.length, first: todos.slice(0, 30) },
    synced: { synced: !!synced, root: synced },
    liveSessions: live,
    recentChanges: { lastHour: recent.length, newest: recent.slice(0, 10).map((f) => ({ path: f.rel, modified: new Date(f.mtimeMs).toISOString() })) },
    registryFolders, rootNotGit: (!rootRepo || !rootRepo.isRepo) && subRepos.length ? { subRepos } : null,
    warnings, offloaded,
    skippedFolders: w.skipped.filter((s) => !/unreadable/.test(s.why)).slice(0, 60),
    notChecked,
  };
}
// Duplicates by the kit's one row rule (registry.mjs check and the doctor agree): two or more FULL rows whose first
// cell is exactly the same ID (bold or struck allowed). Pointer rows, VOID-duplicate rows, `| T-12a |` and
// `| T-5 · update |` keep an ID taken but are not second rows, so onboarding never marks them.
export function duplicatesOf(p) {
  const by = new Map();
  for (const r of p.rows) {
    if (!r.kitRow || !r.full) continue;
    const { key: k } = r.kitRow;
    (by.get(k) || by.set(k, []).get(k)).push(r);
  }
  return [...by].filter(([, rs]) => rs.length > 1)
    .map(([id, rs]) => ({ id, rows: rs, lines: rs.map((r) => r.line + 1), rule: 'registry.mjs check + doctor' }));
}
function printDiscover(d) {
  const L = [];
  L.push(`Project: ${d.project}`);
  L.push(d.mode === 'sweep' ? 'Clockwork 2 already installed — SWEEP MODE: documents only, swept into the existing registries' : `Case ${d.case} — ${{ A: 'Clockwork v1', B: 'has other documentation', C: 'no documentation' }[d.case]}`);
  for (const r of d.caseReasons) L.push(`  · ${r}`);
  L.push(`Stack: ${d.stack.guess} (${d.stack.detail}; ${d.stack.why}${d.stack.from !== '.' ? `; in ${d.stack.from}/` : ''})`);
  for (const s of d.stack.all.filter((x) => x.dir !== d.stack.from)) L.push(`  also: ${s.dir}/ → ${s.stack} (${s.detail})`);
  L.push(`Synced folder: ${d.synced.synced ? `YES (${d.synced.root}) — stage it to ~/dev/ before any change` : 'no'}`);
  L.push(`Live sessions: ${d.liveSessions.checked ? (d.liveSessions.sessions.length ? d.liveSessions.sessions.map((s) => `${s.name || s.sessionId} (${s.kind}, ${s.cwd})`).join('; ') : 'none') : `NOT CHECKED (${d.liveSessions.error})`}`);
  for (const x of d.warnings) L.push(`! ${x}`);
  L.push('', 'Git:');
  for (const g of d.git) {
    if (!g.isRepo) { L.push(`  ${g.dir}: not a repository`); continue; }
    if (g.insideRepoAbove) { L.push(`  ${g.dir}: inside a repository above the project (${g.insideRepoAbove})`); continue; }
    L.push(`  ${g.dir}: branch ${g.branch} · ${g.branchCount ?? '?'} branches · ${g.worktrees?.length ?? '?'} worktrees · ${g.dirtyCount ?? '?'} uncommitted · ${g.commits ?? '?'} commits${g.linkedWorktree ? ` · LINKED WORKTREE of ${g.mainGitDir}` : ''}`);
    if (g.remotes?.length) L.push(`    remotes: ${g.remotes.map((r) => `${r.name} ${r.url}`).join(' · ')}`);
    if (g.claudeIgnored !== undefined) L.push(`    .claude/ ignored by git: ${g.claudeIgnored ? 'yes — keep it; see note' : 'no'}`);
    if (g.refConflictCopies) L.push(`    git ref conflict copies: ${g.refConflictCopies.join(', ')}`);
  }
  L.push('', `Documentation (${d.docs.length} files, ${kb(d.docsTotalBytes)}):`);
  const byKind = {}; for (const x of d.docs) (byKind[x.kind] ??= []).push(x);
  for (const [k, xs] of Object.entries(byKind)) L.push(`  ${k} (${xs.length}): ${xs.slice(0, 8).map((x) => `${x.path} ${kb(x.bytes)}`).join(' · ')}${xs.length > 8 ? ` · … ${xs.length - 8} more` : ''}`);
  L.push('', `Registries (${d.registries.length}):`);
  for (const r of d.registries) {
    const pre = Object.entries(r.prefixes).map(([k, v]) => `${k} ${v.rows} rows (max ${k}-${v.max})`).join(', ');
    L.push(`  ${r.path}${r.archive ? ' [archive]' : ''}${r.conflictCopy ? ' [CONFLICT COPY]' : ''}: ${r.rows} rows${pre ? ` — ${pre}` : ''}${r.boldIds ? ` · ${r.boldIds} bold IDs` : ''}${r.struckRows ? ` · ${r.struckRows} struck` : ''} · header ${r.headerBytes} B`);
    for (const c of r.counters) L.push(`    counter line ${c.line}: ${c.ids.join(' + ')} — format "${c.format}"${c.canonical ? ' (already Clockwork 2)' : ''}`);
    for (const b of r.counterBehind) L.push(`    ! ${b}`);
    for (const x of r.duplicates) L.push(`    ! duplicate ${x.id} on lines ${x.lines.join(', ')}`);
    if (r.headerIdsWithoutRow.length) L.push(`    header mentions IDs with no row here: ${r.headerIdsWithoutRow.slice(0, 12).join(', ')}${r.headerIdsWithoutRow.length > 12 ? ' …' : ''}`);
  }
  if (d.backups.files) L.push(`  (+ ${d.backups.files} files, ${kb(d.backups.bytes)} of registry backups in ${d.backups.folders.join(', ')} — kept as they are, not treated as live registries)`);
  if (Object.keys(d.counterFormats).length) { L.push('', 'Counter-line formats in use:'); for (const [f, at] of Object.entries(d.counterFormats)) L.push(`  "${f}" — ${at.join(', ')}`); }
  if (d.conflictCopies.length) {
    const docC = d.conflictCopies.filter((c) => isTextDoc(c.path)), rest = d.conflictCopies.filter((c) => !isTextDoc(c.path));
    L.push('', `iCloud conflict copies (${d.conflictCopies.length}; documents are moved aside by migrate, other files are only listed):`);
    for (const c of docC) L.push(`  ${c.path} (copy of ${c.copyOf}, ${kb(c.bytes)})`);
    const byDir = {}; for (const c of rest) (byDir[path.posix.dirname(c.path).split('/').slice(0, 2).join('/')] ??= []).push(c);
    for (const [dir, cs] of Object.entries(byDir)) L.push(`  ${cs.length} other file(s) under ${dir}/ (e.g. ${cs[0].path})`);
  }
  L.push('', `Design sources: ${d.design.files.length} files${d.design.files.length ? `: ${d.design.files.slice(0, 10).map((x) => x.path).join(' · ')}${d.design.files.length > 10 ? ' …' : ''}` : ''}`);
  if (d.design.figma.length) L.push(`  Figma links: ${d.design.figma.length} (first: ${d.design.figma[0].url} in ${d.design.figma[0].file})`);
  L.push(`Code TODO/FIXME comments: ${d.codeTodos.count}`);
  if (d.notChecked.length) { L.push('', `NOT CHECKED (${d.notChecked.length}):`); for (const n of d.notChecked.slice(0, 30)) L.push(`  – ${n}`); }
  return L.join('\n');
}

// ── stage ────────────────────────────────────────────────────────────────────
export function stage(projectArg, toArg) {
  const root = real(path.resolve(projectArg));
  if (!exists(root) || !fs.statSync(root).isDirectory()) refuse(`project folder does not exist: ${root}`);
  const base = process.env.CLOCKWORK_ONBOARD_HOME || path.join(os.homedir(), 'dev', '.clockwork-onboard');
  // Resolved through the deepest folder that exists, so a missing parent, a symlinked parent (/var → /private/var)
  // or another spelling of the project's name (case, Unicode form) cannot put staging inside the real project.
  let destReal = resolveDeep(toArg || path.join(base, `${slugOf(root)}-${stamp()}`));
  // A re-stage in the same minute (after an apply refusal) gets -2, -3 … instead of a refusal.
  if (!toArg) for (let i = 2, b0 = destReal; exists(destReal) && fs.readdirSync(destReal).length; i++) destReal = `${b0}-${i}`;
  if (within(destReal, root) || within(root, destReal)) refuse(`staging folder ${destReal} must be outside the project (and not contain it)`);
  if (exists(destReal) && fs.readdirSync(destReal).length) refuse(`staging folder ${destReal} already exists and is not empty; pick a new --to`);
  const synced = syncedRootOf(destReal);
  if (synced) refuse(`staging folder ${destReal} is inside a synced folder (${synced}); stage to a local folder such as ~/dev/`);
  const created = !exists(destReal);
  fs.mkdirSync(destReal, { recursive: true });
  try { return stageInto(root, destReal); } catch (e) {
    // Only a folder this call created (or found empty) is removed: nothing half-made is left looking usable.
    if (created || !fs.readdirSync(destReal).includes(MANIFEST)) try { fs.rmSync(destReal, { recursive: true, force: true }); } catch { /* leave it */ }
    throw e;
  }
}
// Refuses before copying anything when the target disk cannot hold the copy (a full disk otherwise shows up as a raw
// ENOSPC crash half-way through). Counts the files and .git folders stage would copy, plus a margin.
export function spaceCheck(w, root, destReal) {
  let need = 0;
  for (const f of w.files) if (!f.link && !f.offloaded && !SECRET(f.rel) && f.size <= BIG) need += f.size;
  for (const g of w.gitEntries) if (g.dir) { const b = dirBytes(path.join(root, g.rel)); if (b <= GIT_CAP) need += b; }
  let free = Number(process.env.CLOCKWORK_TEST_FREE_BYTES || NaN);
  if (!Number.isFinite(free)) { try { const st = fs.statfsSync(destReal); free = st.bavail * st.bsize; } catch { return { need, free: null }; } }
  const margin = Math.max(256 * 1024 * 1024, need * 0.1);
  if (free < need + margin) {
    const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
    const base = process.env.CLOCKWORK_ONBOARD_HOME || path.join(os.homedir(), 'dev', '.clockwork-onboard');
    let old = []; try { old = fs.readdirSync(base).filter((n) => !n.startsWith('.') && path.join(base, n) !== destReal); } catch { /* none */ }
    refuse(`not enough disk space: staging needs about ${gb(need + margin)} (${gb(need)} of files and .git plus a margin), ${gb(free)} free on the disk holding ${path.dirname(destReal)}. Free space, or pass --to "<a folder on another disk>". Nothing was copied.`
      + (old.length ? ` Older staging copies in ${base} (delete the ones you no longer need, by hand): ${old.slice(0, 8).join(', ')}${old.length > 8 ? ' …' : ''}.` : ''));
  }
  return { need, free };
}
function stageInto(root, destReal) {
  const w = walk(root, 'stage');
  spaceCheck(w, root, destReal);
  const files = {}, excluded = { folders: w.skipped, big: [], secrets: [], symlinks: [], offloaded: [] }, gits = [], symlinks = [];
  let bytes = 0;
  for (const f of w.files) {
    const src = path.join(root, f.rel), dst = path.join(destReal, f.rel);
    const secret = SECRET(f.rel);
    if (secret) { excluded.secrets.push({ path: f.rel, why: secret }); continue; }
    if (f.link) {
      // A link copied as-is would still point into the real project (absolute) or outside staging: an edit through
      // it would change real files. Inside the project → the same place inside staging; outside → not staged.
      const target = fs.readlinkSync(src);
      const lexical = path.resolve(path.dirname(src), target), resolved = resolveDeep(lexical);
      const inside = within(resolved, root) ? resolved : within(lexical, root) && !exists(lexical) ? lexical : null;
      if (!inside) { excluded.symlinks.push({ path: f.rel, target, why: `points outside the project (${resolved})` }); continue; }
      const relIn = path.relative(fold(root), fold(inside)) === '' ? '' : inside.slice(root.length + 1);
      const stagedAs = path.isAbsolute(target) ? (path.relative(path.dirname(dst), path.join(destReal, relIn)) || '.') : target;
      fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.symlinkSync(stagedAs, dst);
      files[f.rel] = { symlink: target, stagedAs, sha256: sha(`symlink:${target}`) }; symlinks.push({ path: f.rel, target, stagedAs });
      continue;
    }
    if (f.size > BIG) { excluded.big.push({ path: f.rel, bytes: f.size }); continue; }
    // Offloaded by iCloud: never read (it could wait forever), so not copied; the plan lists it as not copied.
    if (f.offloaded) { excluded.offloaded.push({ path: f.rel, bytes: f.size, why: offloadNote(src) }); continue; }
    const buf = readBuf(src);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf); fs.chmodSync(dst, f.mode);
    files[f.rel] = { sha256: sha(buf), bytes: buf.length };
    bytes += buf.length;
  }
  for (const g of w.gitEntries) {
    const src = path.join(root, g.rel), dst = path.join(destReal, g.rel), repo = path.posix.dirname(g.rel);
    const head = git(path.dirname(src), ['rev-parse', 'HEAD']), br = git(path.dirname(src), ['branch', '--show-current']);
    const entry = { repo: repo === '.' ? '.' : repo, head: head.ok ? head.out : null, branch: br.ok ? br.out : null };
    if (!g.dir) {
      const txt = readText(src); const target = (/^gitdir:\s*(.+)$/m.exec(txt) || [])[1]?.trim() || '';
      const abs = path.resolve(path.dirname(src), target), resolved = resolveDeep(abs);
      if (!within(resolved, root)) { entry.copied = false; entry.why = `linked worktree of ${abs}: .git not copied (git in the staging copy would write to the real repository)`; gits.push(entry); continue; }
      // A submodule pointer written as an absolute path would send git in staging into the REAL module repo.
      const out = path.isAbsolute(target) ? txt.replace(/^gitdir:\s*.+$/m, `gitdir: ${path.relative(path.dirname(dst), path.join(destReal, resolved.slice(root.length + 1)))}`) : txt;
      fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, out); entry.copied = true; if (out !== txt) entry.repointed = true; gits.push(entry); continue;
    }
    const offGit = [];
    const size = dirBytes(src, offGit);
    entry.bytes = size;
    if (offGit.length) { entry.copied = false; entry.why = `${offGit.length} file(s) in .git are offloaded by iCloud (first: ${offGit[0]}): .git not copied, since copying would read them — branch checks in staging will not work. Download them (Finder, or brctl download "<path>"), then re-stage`; gits.push(entry); continue; }
    if (size > GIT_CAP) { entry.copied = false; entry.why = `.git is ${kb(size)} (over ${kb(GIT_CAP)}): not copied — branch checks in staging will not work; run them in the real project read-only`; gits.push(entry); continue; }
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
    entry.copied = true;
    Object.assign(entry, sealGitCopy(dst, root, destReal));
    gits.push(entry);
  }
  // A read-only clone of every staged file: the "before" that repair, the verifier, sources and rebase read, so they
  // never depend on the real project standing still. APFS clones cost almost no disk (COPYFILE_FICLONE).
  const pristine = path.join(destReal, PRISTINE);
  for (const [rel, e] of Object.entries(files)) {
    if (e.symlink !== undefined) continue;
    const to = path.join(pristine, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(destReal, rel), to, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(to, 0o444);
  }
  const manifest = { version: 1, tool: 'clockwork onboard.mjs stage', project: root, staging: destReal, createdAt: now().toISOString(), fileCount: Object.keys(files).length, bytes, pristine: PRISTINE, files, symlinks, git: gits, excluded };
  writeAtomic(path.join(destReal, MANIFEST), JSON.stringify(manifest, null, 1) + '\n');
  return manifest;
}
// Every git dir inside a copied .git: the repo's own, plus one per submodule (.git/modules/<name…>/, which has its
// own config, remotes and credentials; a submodule in staging pushes with THAT config).
function gitDirsIn(gitDir) {
  const out = [gitDir]; const stack = [path.join(gitDir, 'modules')];
  while (stack.length) {
    const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (exists(path.join(p, 'config')) && exists(path.join(p, 'HEAD'))) { out.push(p); stack.push(path.join(p, 'modules')); } else stack.push(p);
    }
  }
  return out;
}
// --work-tree: a submodule's core.worktree may not exist in staging (nothing staged there yet); config and remote
// commands need none, and git would otherwise refuse to start.
const gitAt = (gd, args) => git(path.dirname(gd), ['--git-dir', gd, '--work-tree', gd, ...args]);
// The copied .git (and every submodule's) must never push, never carry a credential, never run the project's hooks,
// and never point at the real project's worktrees or working tree.
function sealGitCopy(gitDir, root, destReal) {
  const out = { credentialFilesScrubbed: 0, worktreeMetadataDropped: [], submodulesSealed: 0 };
  const bad = [];
  for (const gd of gitDirsIn(gitDir)) {
    if (gd !== gitDir) out.submodulesSealed++;
    // 1. Linked-worktree metadata: `git worktree repair/prune/remove` in staging would act on the REAL worktrees.
    const wtDir = path.join(gd, 'worktrees');
    if (exists(wtDir)) { out.worktreeMetadataDropped.push(...fs.readdirSync(wtDir)); fs.rmSync(wtDir, { recursive: true, force: true }); }
    // 2. Credentials: user:token@ in remote URLs (also in reflog text) and http extraheader lines.
    const cfgPath = path.join(gd, 'config');
    if (exists(cfgPath)) {
      const t = readText(cfgPath);
      const n = scrubUserinfo(t).split('\n').filter((l) => !/^\s*extraheader\s*=/i.test(l)).join('\n');
      if (n !== t) { fs.writeFileSync(cfgPath, n); out.credentialFilesScrubbed++; }
    }
    const stack = [path.join(gd, 'logs')]; const extra = [path.join(gd, 'FETCH_HEAD')];
    while (stack.length) { const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; } for (const e of ents) (e.isDirectory() ? stack : extra).push(path.join(d, e.name)); }
    for (const f of extra) { let t; try { t = readText(f); } catch { continue; } const n = scrubUserinfo(t); if (n !== t) { fs.writeFileSync(f, n); out.credentialFilesScrubbed++; } }
    // 3. A submodule's absolute core.worktree would make git in staging work on the REAL checkout: re-point it.
    const wt = gitAt(gd, ['config', '--get', 'core.worktree']);
    if (wt.ok && path.isAbsolute(wt.out)) {
      const r = resolveDeep(wt.out);
      if (within(r, root) && fold(r) !== fold(root)) gitAt(gd, ['config', 'core.worktree', path.relative(gd, path.join(destReal, r.slice(root.length + 1)))]);
      else if (within(r, root)) gitAt(gd, ['config', 'core.worktree', path.relative(gd, destReal)]);
      else bad.push(`${path.relative(destReal, gd)}: core.worktree points outside the project (${wt.out})`);
    }
    // 4. Hooks: a commit an agent makes in staging must not run the project's hooks (they may deploy or notify).
    gitAt(gd, ['config', 'core.hooksPath', '/dev/null']);
    // 5. Pushing: every push URL of every remote → nowhere (--replace-all: a remote may have several pushurls), and
    // any explicit URL push is rewritten to nowhere too. Proven by reading the push URLs back, never assumed.
    const rem = gitAt(gd, ['remote']);
    if (!rem.ok) { bad.push(`${path.relative(destReal, gd)}: could not list remotes (${rem.err})`); continue; }
    for (const r of rem.out.split('\n').filter(Boolean)) {
      const set = gitAt(gd, ['config', '--replace-all', `remote.${r}.pushurl`, NO_PUSH]);
      const got = gitAt(gd, ['remote', 'get-url', '--push', '--all', r]);
      const urls = got.ok ? got.out.split('\n').filter(Boolean) : [];
      if (!set.ok || !got.ok || !urls.length || urls.some((u) => u !== NO_PUSH)) bad.push(`${path.relative(destReal, gd)} ${r}: ${set.ok ? '' : set.err} ${got.ok ? urls.join(', ') : got.err}`.trim());
    }
    for (const pre of ['https://', 'http://', 'ssh://', 'git://', 'git@', 'file://', '/', '.']) gitAt(gd, ['config', '--add', `url.${NO_PUSH}/.pushInsteadOf`, pre]);
  }
  if (bad.length) refuse(`could not seal the git copy in staging (${bad.join('; ')}); staging removed, nothing staged`);
  out.pushDisabled = true; out.hooksDisabled = true;
  return out;
}

// ── census ───────────────────────────────────────────────────────────────────
export function census(dirArg) {
  const root = real(path.resolve(dirArg));
  if (!exists(root) || !fs.statSync(root).isDirectory()) refuse(`folder does not exist: ${root}`);
  const w = walk(root, 'census');
  const files = {}, ids = {}, counters = [], notChecked = [];
  if (w.truncated) notChecked.push(`stopped after ${w.files.length} files`);
  const docMentions = new Set();
  for (const f of w.files) {
    if (f.link || f.rel === MANIFEST || (f.rel === PLAN)) continue;
    const kind = docKind(f.rel);
    if (!kind) continue;
    const cls = fileClass(f.rel);
    // Offloaded by iCloud: recorded (so compare knows it exists and never counts it as lost), never read.
    if (f.offloaded) { files[f.rel] = { kind, class: cls, bytes: f.size, offloaded: true, lines: [] }; notChecked.push(offloadNote(path.join(root, f.rel))); continue; }
    if (!isTextDoc(f.rel)) { files[f.rel] = { kind, class: cls, bytes: f.size, binary: true, lines: [] }; continue; }
    let text; try { text = readText(path.join(root, f.rel)); } catch (e) { notChecked.push(`${f.rel}: unreadable (${e.code || e.message})`); continue; }
    const lines = [];
    text.split('\n').forEach((l, i) => { const n = normLine(l); if (n) lines.push([i + 1, lineHash(n), cut(l, 90)]); });
    files[f.rel] = { kind, class: cls, bytes: f.size, sha256: sha(text), lines };
    if (cls === 'live' || cls === 'onboarding-report') for (const m of text.matchAll(ID_RE)) docMentions.add(keyOf(m[1], m[2]));
    const info = registryInfo(path.posix.basename(f.rel));
    if (!info) continue;
    files[f.rel].registry = { name: info.name, archive: info.archive, conflict: info.conflict };
    const p = parseRegistry(text);
    for (const r of p.rows) for (const k of r.ids) {
      const e = (ids[k] ??= { rows: [], mentions: {}, counter: false });
      e.rows.push({ file: f.rel, line: r.line + 1, struck: r.struck, bold: r.bold, stub: r.stub, class: cls });
    }
    for (const [k, n] of p.mentions) { const e = (ids[k] ??= { rows: [], mentions: {}, counter: false }); e.mentions[f.rel] = n; }
    for (const c of p.counters) for (const x of c.ids) {
      counters.push({ file: f.rel, line: c.line + 1, prefix: x.prefix, next: x.num, format: c.shape, class: cls, archive: info.archive });
      (ids[keyOf(x.prefix, x.num)] ??= { rows: [], mentions: {}, counter: false }).counter = true;
    }
  }
  const registryPrefixes = [...new Set([...Object.entries(ids).filter(([, e]) => e.rows.length).map(([k]) => k.split('-')[0]), ...counters.map((c) => c.prefix)])].sort();
  for (const [k, e] of Object.entries(ids)) {
    e.prefix = k.split('-')[0];
    e.struck = e.rows.some((r) => r.struck);
    e.counterOnly = !e.rows.length; // mentioned (header note, counter, prose) but no row anywhere
  }
  const summary = { files: Object.keys(files).length, lines: Object.values(files).reduce((n, f) => n + f.lines.length, 0), registries: Object.values(files).filter((f) => f.registry).length, prefixes: {} };
  for (const p of registryPrefixes) {
    const es = Object.entries(ids).filter(([k]) => k.split('-')[0] === p).map(([, e]) => e);
    summary.prefixes[p] = { withRows: es.filter((e) => e.rows.length).length, struck: es.filter((e) => e.struck).length, counterOrMentionOnly: es.filter((e) => e.counterOnly).length, counter: Math.max(0, ...counters.filter((c) => c.prefix === p && !c.archive && c.class === 'live').map((c) => c.next)) || null };
  }
  return { version: 1, tool: 'clockwork onboard.mjs census', root, createdAt: now().toISOString(), summary, registryPrefixes, files, ids, counters, docMentions: [...docMentions].filter((k) => registryPrefixes.includes(k.split('-')[0])).sort(), notChecked };
}

// ── compare ──────────────────────────────────────────────────────────────────
function planAccounted(planText) {
  // Items in the plan's "Archived verbatim" section: `path` (whole file) or `path:12` / `path:12-40` (those lines),
  // or an ID in backticks (`T-12`: its row may live only in the archive).
  const out = [], ids = new Set();
  if (!planText) return { ranges: out, ids };
  // HTML comments (the template's instructions, even across lines) name nothing.
  const lines = planText.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, '')).split('\n'); let inSec = false, level = 0, fence = false;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    const h = fence ? null : /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { if (inSec && h[1].length <= level) inSec = false; if (/archived verbatim/i.test(h[2])) { inSec = true; level = h[1].length; } continue; }
    if (!inSec) continue;
    for (const m of l.matchAll(/`([^`]+?)(?::(\d+)(?:-(\d+))?)?`/g)) {
      if (/^[A-Z]+-\d+$/.test(m[1])) { ids.add(keyOf(...m[1].split('-'))); continue; }
      out.push({ file: m[1], from: m[2] ? Number(m[2]) : 1, to: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : Infinity });
    }
  }
  return { ranges: out, ids };
}
// "TASKS 2.md" next to "TASKS.md" in the same census = an iCloud conflict copy (moved aside by migrate, never merged).
const isCopyIn = (c, f) => { const d = dupOf(path.posix.basename(f)); return !!d && !!c.files[path.posix.join(path.posix.dirname(f), d)]; };
export function compare(before, after, planText = null) {
  for (const [n, c] of [['before', before], ['after', after]]) if (!c || c.version !== 1 || !c.files || !c.ids) refuse(`${n} is not an onboard.mjs census JSON`);
  const lost = [], backupOnly = [], reportOnly = [], planned = [], moved = [], migrated = [], notChecked = [];
  const { ranges: acc, ids: planIds } = planAccounted(planText);
  // A file offloaded by iCloud in either census was never read: nothing in it is compared, and nothing in it counts
  // as lost. Every such file is named under NOT CHECKED instead.
  const offB = Object.keys(before.files).filter((f) => before.files[f].offloaded), offA = Object.keys(after.files).filter((f) => after.files[f].offloaded);
  const skip = new Set([...offB, ...offA]);
  for (const f of offB) notChecked.push(`${f}: offloaded by iCloud in the before census, never read — its lines and IDs were not counted`);
  for (const f of offA.filter((x) => !offB.includes(x))) notChecked.push(`${f}: offloaded by iCloud in the after census, not read — its lines and IDs were not compared`);
  if (offA.length) notChecked.push(`${offA.length} file(s) were not read in the after census: a line or ID listed as LOST may sit in one of them`);
  const inPlan = (f, ln) => acc.some((a) => a.file === f && ln >= a.from && ln <= a.to);
  // A file made during onboarding that only keeps a copy of an original is not live: no agent reads it. That is an
  // *-ARCHIVE.md that is not a registry archive (DESIGN-SYSTEM-ARCHIVE.md), anything under a legacy/ archive/ old/
  // originals/ folder, or a new file (not one agents load) that is mostly the lines of one original that lost lines.
  // A line that survives only there is archive-only: LOST unless the plan names it under "Archived verbatim".
  const LOADED = /(^|\/)(AGENTS|CLAUDE)\.md$|(^|\/)\.claude\/(rules|skills|agents)\//;
  const lost0 = (g) => { const now = new Map(); for (const [, h] of after.files[g]?.lines || []) now.set(h, (now.get(h) || 0) + 1);
    const was = new Map(); for (const [, h] of before.files[g].lines) was.set(h, (was.get(h) || 0) + 1);
    return [...was].some(([h, n]) => (now.get(h) || 0) < n); };
  const rewrittenSets = Object.keys(before.files).filter((g) => !skip.has(g) && before.files[g].class === 'live' && before.files[g].lines.length && lost0(g))
    .map((g) => new Set(before.files[g].lines.map((l) => l[1])));
  const madeCopies = new Set(Object.entries(after.files).filter(([f, x]) => !before.files[f] && x.class === 'live' && !registryInfo(path.posix.basename(f)) && (
    /-ARCHIVE\.md$/i.test(f) || /(^|\/)(_?archives?|legacy|old|originals?)\//i.test(f)
    || (!LOADED.test(f) && x.lines.length >= 3 && rewrittenSets.some((set) => x.lines.filter((l) => set.has(l[1])).length >= 0.8 * x.lines.length)))).map(([f]) => f));
  const liveFile = (c, f) => c.files[f]?.class === 'live' && !isCopyIn(c, f) && !(c === after && madeCopies.has(f)) && !skip.has(f);
  // IDs. A row before → a row after in a LIVE file (live registry or its archive). A row that survives only inside
  // reports/onboarding-*/ or a backup made during onboarding is NOT LIVE ANY MORE: agents never read it there.
  const afterMentions = new Set(after.docMentions);
  for (const [k, b] of Object.entries(before.ids)) {
    const a = after.ids[k];
    // Its rows (or, with no rows, its mentions) sat only in files that were not read after: not checked, not lost.
    const where0 = b.rows.length ? b.rows.map((r) => r.file) : Object.keys(b.mentions);
    if (where0.length && where0.every((f) => skip.has(f))) { notChecked.push(`${k}: only in ${[...new Set(where0)].join(', ')}, which was not read after`); continue; }
    if (b.rows.length) {
      const aRows = a?.rows || [];
      if (aRows.some((r) => r.class === 'live')) continue;
      const bLive = b.rows.filter((r) => r.class === 'live' && !isCopyIn(before, r.file));
      const newCopies = aRows.filter((r) => !before.files[r.file]);
      const where = `${b.rows[0].file}:${b.rows[0].line}`;
      if (bLive.length) {
        if (planIds.has(k)) planned.push({ type: 'id-row', id: k, where, text: `${k}: its only row after is in ${aRows[0]?.file || 'nothing'} (the plan names it under Archived verbatim)` });
        else if (newCopies.length || aRows.length) lost.push({ type: 'id-not-live', id: k, where, to: `${aRows[0].file}:${aRows[0].line}`, text: `${k} had a live row (${where}); after, its only row is in ${aRows[0].file}:${aRows[0].line}, which no agent reads — NOT LIVE ANY MORE` });
        else lost.push({ type: 'id-row', id: k, where, text: `${k} had a row before (${where}); no row after` });
      } else if (!aRows.length) lost.push({ type: 'id-row', id: k, where, text: `${k} had a row before (${where}); no row after` });
      else backupOnly.push({ type: 'id-row', id: k, where: `${aRows[0].file}:${aRows[0].line}`, text: `${k}: before it had rows only in backups or conflict copies; after, its only row is in ${aRows[0].file}` });
    } else if (Object.keys(b.mentions).length && before.registryPrefixes.includes(b.prefix) && !afterMentions.has(k) && !Object.keys(a?.mentions || {}).some((f) => !before.files[f] || after.files[f]?.class === 'live')) {
      lost.push({ type: 'id-mention', id: k, where: Object.keys(b.mentions)[0], text: `${k} was mentioned before (${Object.keys(b.mentions).join(', ')}); mentioned nowhere after` });
    }
  }
  // Counters never go backwards (IDs are never reused).
  const maxCtr = (c, p) => Math.max(0, ...c.counters.filter((x) => x.prefix === p && !x.archive && x.class === 'live').map((x) => x.next));
  for (const p of new Set(before.counters.filter((x) => !x.archive && x.class === 'live').map((x) => x.prefix))) {
    const b = maxCtr(before, p), a = maxCtr(after, p);
    if (!a && before.counters.some((x) => x.prefix === p && skip.has(x.file))) { notChecked.push(`${p}: counter file not read after (offloaded)`); continue; }
    if (!a) lost.push({ type: 'counter', id: p, where: '', text: `${p}: counter (next free ${p}-${b}) is gone` });
    else if (a < b) lost.push({ type: 'counter', id: p, where: '', text: `${p}: counter went backwards (${p}-${b} → ${p}-${a}); IDs would be reused` });
  }
  // Lines, counted as a multiset. A line is "moved" only if the number of LIVE copies of it did not drop: a rule
  // cut from CLAUDE.md is not hidden by the same sentence in a meeting note. What is not live any more must sit
  // verbatim in a copy made during onboarding AND be named in the plan's "Archived verbatim"; old backups prove
  // nothing (a dropped line would still be in last week's registry backup).
  const counts = (c) => { const per = new Map(), tot = new Map(); for (const [f, x] of Object.entries(c.files)) { if (!liveFile(c, f)) continue; const m = new Map(); for (const [, h] of x.lines) { m.set(h, (m.get(h) || 0) + 1); tot.set(h, (tot.get(h) || 0) + 1); } per.set(f, m); } return { per, tot }; };
  const B = counts(before), A = counts(after);
  const liveAt = new Map(), copies = new Map(), anyAfter = new Set(); // hash → first live place / every copy made during onboarding
  for (const [f, x] of Object.entries(after.files)) {
    for (const [, h] of x.lines) anyAfter.add(h);
    const live = liveFile(after, f);
    if (!live && before.files[f]) continue; // pre-existing backup or report
    for (const [ln, h] of x.lines) {
      if (live) { if (!liveAt.has(h)) liveAt.set(h, { f, ln }); } else (copies.get(h) || copies.set(h, []).get(h)).push({ f, ln, cls: x.class });
    }
  }
  // Prefer the copy of the same file (originals/<path>, conflict-copies/<path>) over any other copy.
  const copyOf = (f, h) => { const c = copies.get(h); return c ? c.find((y) => y.f.endsWith(`/${f}`)) || c.find((y) => /(^|\/)migrate-originals\.md$/.test(y.f)) || c[0] : null; };
  const unmoved = new Map(); for (const [h, n] of B.tot) { const d = n - (A.tot.get(h) || 0); if (d > 0) unmoved.set(h, d); }
  const archived = (f, ln, h, prev) => {
    const hit = copyOf(f, h);
    if (hit && /(^|\/)migrate-originals\.md$/.test(hit.f)) { migrated.push({ type: 'line', where: `${f}:${ln}`, to: `${hit.f}:${hit.ln}`, text: prev }); return; }
    if (inPlan(f, ln)) { (hit ? reportOnly : planned).push({ type: 'line', where: `${f}:${ln}`, ...(hit ? { to: `${hit.f}:${hit.ln}` } : {}), text: prev }); return; }
    if (hit) { lost.push({ type: 'line-archive-only', where: `${f}:${ln}`, to: `${hit.f}:${hit.ln}`, text: prev }); return; }
    lost.push({ type: 'line', where: `${f}:${ln}`, text: prev });
  };
  // In a registry, the counter line, the "Last updated" date and a row whose ID still has a live row are not lost
  // lines: mint and append rewrite them (sweep mode, D16). The ID and counter checks above judge those.
  const covered = (x, prev) => {
    if (!x.registry) return false;
    if ((/next[ -]?free/i.test(prev) && /\b[A-Z]+-\d+/.test(prev)) || /^[*_\s]*last updated\b/i.test(prev)) return true;
    const ids = rowIdsOf(prev);
    return !!ids && ids.every((k) => (after.ids[keyOf(k.prefix, k.num)]?.rows || []).some((r) => r.class === 'live'));
  };
  for (const [f, x] of Object.entries(before.files).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) {
    if (skip.has(f)) continue; // offloaded before or after: listed under NOT CHECKED
    if (liveFile(before, f)) {
      const af = A.per.get(f) || new Map(), seen = new Map();
      for (const [ln, h, prev] of x.lines) {
        const i = (seen.get(h) || 0) + 1; seen.set(h, i);
        if (i <= (af.get(h) || 0)) continue; // still in place
        if (covered(x, prev)) continue;
        const u = unmoved.get(h) || 0;
        if (!u) { const to = liveAt.get(h); moved.push({ from: `${f}:${ln}`, to: to ? `${to.f}:${to.ln}` : '?' }); continue; }
        unmoved.set(h, u - 1);
        archived(f, ln, h, prev);
      }
    } else {
      // A conflict copy or a backup/report that existed before: its lines must still exist somewhere after.
      const own = new Set((after.files[f]?.lines || []).map((l) => l[1]));
      for (const [ln, h, prev] of x.lines) {
        if (own.has(h) || A.tot.has(h)) continue;
        const hit = copyOf(f, h);
        if (hit) { backupOnly.push({ type: 'line', where: `${f}:${ln}`, to: `${hit.f}:${hit.ln}`, text: prev }); continue; }
        if (!isCopyIn(before, f) && anyAfter.has(h)) continue; // an old backup or report still has it
        if (inPlan(f, ln)) { planned.push({ type: 'line', where: `${f}:${ln}`, text: prev }); continue; }
        lost.push({ type: 'line', where: `${f}:${ln}`, text: prev });
      }
    }
    if (x.binary && !after.files[f]) {
      const same = Object.entries(after.files).some(([g, y]) => y.binary && y.bytes === x.bytes && path.posix.basename(g) === path.posix.basename(f));
      if (!same && !acc.some((a) => a.file === f)) lost.push({ type: 'file', where: f, text: `document ${f} (${kb(x.bytes)}) is gone` });
    }
  }
  const archiveOnlyLines = reportOnly.length + lost.filter((x) => x.type === 'line-archive-only').length;
  return {
    lost, backupOnly, reportOnly, planned, notChecked, migrated: migrated.length, migratedSample: migrated.slice(0, 10), moved: moved.length, movedSample: moved.slice(0, 20),
    counts: { beforeFiles: Object.keys(before.files).length, afterFiles: Object.keys(after.files).length, beforeIds: Object.keys(before.ids).length, afterIds: Object.keys(after.ids).length,
      archiveOnlyLines, archiveOnlyNamedByPlan: reportOnly.length, notLiveIds: lost.filter((x) => x.type === 'id-not-live').length },
  };
}

// ── migrate ──────────────────────────────────────────────────────────────────
const canonCounter = (id) => `> **ID counter — next free: \`${id.prefix}-${id.digits}\`**`;
const headingCore = (h) => h.replace(/^##\s+/, '').replace(/^[^\p{L}]+/u, '').replace(/\s*\(.*\)\s*$/, '').replace(/\s+[—–:-]\s+.*$/, '').trim().toLowerCase();
// Where registry.mjs mints each default prefix (its FILE_SECTION / PREFIX_SECTION).
const MINT_SECTION = { T: 'Open', C: 'Client asks', CD: 'Confirmed Decisions', A: 'Open', Q: 'Queue' };
// Columns of the kit's CLIENT.md "## Confirmed Decisions" table (templates/registries/CLIENT.md).
const CD_TABLE = ['| ID | Decision | Date · who | Source | Status |', '|---|---|---|---|---|'];
const COLLISION = '⚠ ID collision';
const titleKey = (r) => (r.cells[1] || '').replace(/[*~_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const statusKey = (r) => (r.cells.length > 2 ? r.status : '').replace(/[*~_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
function loadConfig(root) {
  const p = path.join(root, '.claude', 'clockwork.json');
  if (!exists(p)) return { path: p, cfg: null };
  try { return { path: p, cfg: JSON.parse(readText(p)) }; } catch (e) { refuse(`${p} is not valid JSON (${e.message})`); }
}
// One live registry file → its migrated text. Pure (no fs): migrate and rebase both use it.
// ctx: { idPrefixes, allMax, archiveRows (Map key → archive line, same folder) }; results are pushed into sink.
export function transformRegistry(rel, text, ctx, sink = { changes: [], questions: [], originals: [], addPrefixes: {}, sectionDefaults: [], collisions: [] }) {
  const info = registryInfo(path.posix.basename(rel));
  const p = parseRegistry(text);
  const out = p.lines.map((l) => [l]); // each original line → replacement lines
  const note = (i, kind, why) => { const after = out[i]; sink.changes.push({ file: rel, line: i + 1, kind, why, before: p.lines[i], after: [...after] }); const bn = normLine(p.lines[i]); if (bn && !after.some((x) => normLine(x) === bn)) sink.originals.push({ file: rel, line: i + 1, kind, text: p.lines[i] }); };
  const owner = !info.archive && OWNER_SECTIONS[info.name];
  const { idPrefixes, allMax } = ctx;
  const mapped = Object.entries(idPrefixes).filter(([, v]) => path.posix.basename(v) === `${info.name}.md`).map(([k]) => k);
  const hasSection = (name) => p.sections.some((s) => s.heading === `## ${name}` || headingCore(s.heading) === name.toLowerCase());
  if (!info.archive) {
    // counters
    const seen = {};
    for (const c of p.counters) {
      for (const id of c.ids) (seen[id.prefix] ??= []).push({ line: c.line + 1, num: id.num });
      if (c.v2) continue;
      out[c.line] = [...c.ids.map(canonCounter), ...(c.note ? [`> ${c.note}`] : [])];
      note(c.line, 'counter', `legacy counter "${c.shape}" → Clockwork 2 format${c.ids.length > 1 ? ' (one line per prefix)' : ''}${c.note ? '; the rest of the line kept as a note below it' : ''}`);
    }
    for (const [pre, at] of Object.entries(seen)) if (new Set(at.map((x) => x.num)).size > 1)
      sink.questions.push(`${rel}: ${at.length} counter lines for ${pre} disagree (${at.map((x) => `line ${x.line}: ${pre}-${x.num}`).join(', ')}). Which is right? Default: the highest, so no ID is reused.`);
    else if (at.length > 1) sink.questions.push(`${rel}: ${at.length} counter lines for ${pre} (lines ${at.map((x) => x.line).join(', ')}); registry.mjs needs exactly one. Default: keep the first, archive the rest verbatim.`);
    // A missing counter for a prefix this file owns: added when the file already has its rows, or has the
    // section registry.mjs mints it into (a v1 CLIENT.md with "Confirmed Decisions" but no CD rows yet).
    if (owner) {
      const rowPre = new Set(p.rows.flatMap((r) => r.ids.map((k) => k.split('-')[0])));
      const missing = mapped.filter((pre) => !seen[pre] && (rowPre.has(pre) || (MINT_SECTION[pre] && OWNER_SECTIONS[info.name].includes(MINT_SECTION[pre]) && hasSection(MINT_SECTION[pre]))));
      if (missing.length) {
        const lastCtr = p.counters.length ? Math.max(...p.counters.map((c) => c.line)) : -1;
        const lu = p.lines.slice(0, p.hEnd).findIndex((l) => /Last updated/i.test(l));
        let at = lastCtr >= 0 ? lastCtr : lu >= 0 ? lu : p.hEnd - 1;
        while (at > 0 && !p.lines[at].trim()) at--; // after the last header text, not after trailing blank lines
        const add = missing.map((pre) => canonCounter({ prefix: pre, digits: String((allMax[pre] || 0) + 1) }));
        if (at < 0) out[0] = [...add, '', ...out[0]]; else out[at] = [...out[at], ...add];
        sink.changes.push({ file: rel, line: Math.max(at, 0) + 1, kind: 'counter-added', why: `no counter for ${missing.join(', ')} (${missing.map((pre) => (rowPre.has(pre) ? `${pre} rows exist` : `the "## ${MINT_SECTION[pre]}" section registry.mjs mints ${pre} into exists`)).join('; ')}); next free = highest number mentioned anywhere in the registries (counters included) + 1, so nothing is reused`, before: '', after: add });
      }
      for (const pre of Object.keys(seen)) if (!Object.keys(idPrefixes).includes(pre)) sink.addPrefixes[pre] = `${info.name}.md`;
      for (const pre of rowPre) if (!Object.keys(idPrefixes).includes(pre) && !seen[pre] && p.rows.filter((r) => r.ids[0].startsWith(`${pre}-`)).length >= 3)
        sink.questions.push(`${rel}: ${pre}- rows have no counter and ${pre} is not in clockwork.json idPrefixes. Register ${pre} → ${info.name}.md with next free ${pre}-${(allMax[pre] || 0) + 1}? Default: yes.`);
    }
  }
  // bold IDs → plain (archives and mirrors too)
  for (const r of p.rows) {
    if (!r.bold) continue;
    const { t, cells } = cellsOf(out[r.line][0]);
    const c = cells[0];
    const plain = c.text.replace(/\*\*\s*([A-Z]+-\d+)\s*\*\*/, '$1');
    out[r.line] = [t.slice(0, c.s) + plain + t.slice(c.e), ...out[r.line].slice(1)];
    note(r.line, 'bold-id', 'bold row ID → plain (registry.mjs writes plain IDs)');
  }
  // sections
  if (owner) {
    for (const name of owner) {
      if (p.sections.some((s) => s.heading === `## ${name}`)) continue;
      const cands = p.sections.filter((s) => headingCore(s.heading) === name.toLowerCase());
      if (cands.length === 1) {
        const s = cands[0], textH = s.heading.replace(/^##\s+/, '');
        const onlyDecor = textH.replace(/^[^\p{L}]+/u, '').trim().toLowerCase() === name.toLowerCase();
        out[s.line] = [`## ${name}`, ...(onlyDecor ? [] : [`### ${textH}`]), ...out[s.line].slice(1)];
        note(s.line, 'section', `section renamed to the Clockwork 2 name "## ${name}"${onlyDecor ? '' : '; the old heading kept as a sub-heading'}`);
      } else {
        // Rows for this section still need a home: default = the first heading that starts with the same word.
        const near = cands.length ? cands : p.sections.filter((s) => headingCore(s.heading).startsWith(name.toLowerCase().split(' ')[0]));
        const use = near[0]?.heading || null;
        sink.sectionDefaults.push({ file: rel, want: `## ${name}`, use });
        sink.questions.push(`${rel}: ${cands.length ? `${cands.length} sections could be "## ${name}" (${cands.map((s) => `line ${s.line + 1} "${s.heading}"`).join(', ')})` : `no section maps to "## ${name}" (sections: ${p.sections.map((s) => s.heading.replace(/^##\s+/, '')).slice(0, 8).join(' / ') || 'none'})`}. Default: ${use ? `rows meant for "## ${name}" go to --section "${use}"` : `rows meant for "## ${name}" are NOT written; they wait for your answer`} until you pick.`);
      }
    }
    // A v1 "Confirmed Decisions" table without an ID column cannot take CD-n rows: a kit-shaped table is added
    // below it (last table in the section = where registry.mjs mints); the old table stays verbatim.
    if (mapped.includes('CD')) {
      const sec = p.sections.find((s) => s.heading === '## Confirmed Decisions' || headingCore(s.heading) === 'confirmed decisions');
      if (sec) {
        const end = (p.sections.find((s) => s.line > sec.line) || { line: p.lines.length }).line;
        const body = p.lines.slice(sec.line + 1, end);
        const heads = body.filter((l, i) => l.startsWith('|') && !(body[i - 1] || '').startsWith('|'));
        const idTable = heads.some((h) => /^(id|#|no\.?|ref)$/i.test((cellsOf(h).cells[0]?.text || '').replace(/[*_`]/g, '').trim()));
        const cdRows = p.rows.some((r) => r.line > sec.line && r.line < end);
        if (heads.length && !idTable && !cdRows) {
          let at = end - 1; while (at > sec.line && !p.lines[at].trim()) at--;
          out[at] = [...out[at], '', 'Decisions with IDs (Clockwork 2; minted with registry.mjs). The table above is kept as it was.', '', ...CD_TABLE];
          sink.changes.push({ file: rel, line: at + 1, kind: 'table-added', why: 'the Confirmed Decisions table has no ID column, so CD-n rows cannot go into it; a kit-shaped table added below it (the old table untouched)', before: '', after: CD_TABLE });
          sink.questions.push(`${rel}: "Confirmed Decisions" had no ID column; new CD rows now go into a new table under the old one. Default: keep both tables (old rows are not renumbered).`);
        }
      }
    }
  }
  // duplicates in a live registry: never renumbered, never hidden
  if (!info.archive) {
    for (const d of duplicatesOf(p)) {
      const full = d.rows.filter((r) => !r.stub);
      const firstRow = full.find((r) => !r.struck) || full[0] || d.rows[0];
      const rawId = firstRow.first.replace(/[*~\s]/g, '').replace(/[^A-Z0-9-].*$/, '');
      const keptAt = out.slice(0, firstRow.line).reduce((k, x) => k + x.length, 0) + 1; // its line number after this migrate
      const at = `${path.posix.basename(rel)}:${keptAt}`;
      const said = [];
      for (const r of d.rows.filter((x) => x !== firstRow)) {
        const cur = out[r.line][0];
        if (cur.includes(VOID_DUP) || cur.includes(COLLISION)) continue;
        const { t, cells } = cellsOf(cur);
        if (titleKey(r) && titleKey(r) === titleKey(firstRow) && statusKey(r) === statusKey(firstRow)) {
          // Same item written twice (same title AND status): the copy is voided, its old status kept after the marker.
          // A same-title row with another status may be a reopened item: that is a collision, never voided.
          const c = cells[cells.length - 1], lead = c.text.match(/^\s*/)[0];
          const newCell = `${lead || ' '}${VOID_DUP} ${rawId}, see ${at} · ${c.text.trim()}${c.e < t.length ? ' ' : ''}`;
          out[r.line] = [t.slice(0, c.s) + newCell + t.slice(c.e), ...out[r.line].slice(1)];
          note(r.line, 'duplicate', `${rawId} is written twice with the same title; this copy is marked VOID (line ${keptAt} kept), not renumbered`);
          said.push(`line ${r.line + 1} has the same title and is marked "${VOID_DUP}"`);
        } else {
          // Two DIFFERENT items share an ID: both stay open with their status; the later one needs a new ID.
          const c = cells[1] || cells[cells.length - 1];
          const newCell = `${c.text.replace(/\s+$/, '')} ${COLLISION} with ${at}: needs a new ID (plan question) `;
          out[r.line] = [t.slice(0, c.s) + newCell + t.slice(c.e), ...out[r.line].slice(1)];
          note(r.line, 'collision', `${rawId} is also a different item at line ${keptAt}; marked ${COLLISION}, status kept, not voided or renumbered`);
          sink.collisions.push({ file: rel, id: rawId, keptLine: firstRow.line + 1, line: r.line + 1, title: cut(r.cells[1] || '', 80) });
          said.push(`line ${r.line + 1} is ${titleKey(r) && titleKey(r) === titleKey(firstRow) ? `the same title with another status ("${cut(r.status, 30)}", maybe reopened)` : `a different item ("${cut(r.cells[1] || '', 50)}")`} and is marked "${COLLISION}", status kept`);
        }
      }
      if (said.length) sink.questions.push(`${rel}: ${rawId} has ${d.rows.length} rows (lines ${d.lines.join(', ')}; counted by ${d.rule}). Kept line ${firstRow.line + 1}; ${said.join('; ')}. Default: nothing is renumbered or dropped; a different item keeps its status until you say "give it a new ID" (then: registry.mjs mint + a pointer in the old row); a pointer row stays until you remove it by hand.`);
    }
    // A full row in the live file AND in its archive (the doctor warns): listed, never changed.
    for (const r of p.rows) if (!r.stub && r.ids.length === 1 && ctx.archiveRows?.has(r.ids[0]))
      sink.questions.push(`${rel}: ${r.ids[0]} has a full row here (line ${r.line + 1}) and in the archive (${ctx.archiveRows.get(r.ids[0])}). Default: both left as they are; if it is one item, the live row should become a stub "→ archived".`);
  }
  return { text: out.flat().join('\n'), sink };
}
// The folder's archive rows, for the live-vs-archive check.
function archiveRowsFor(root, rel) {
  const info = registryInfo(path.posix.basename(rel));
  const a = path.posix.join(path.posix.dirname(rel), `${info.name}-ARCHIVE.md`);
  const m = new Map();
  if (!exists(path.join(root, a))) return m;
  for (const r of parseRegistry(readText(path.join(root, a))).rows) if (!r.stub && r.ids.length === 1 && !m.has(r.ids[0])) m.set(r.ids[0], `${a}:${r.line + 1}`);
  return m;
}
// .claude/ ignored by git on purpose (Casa Lumen): worktrees then get the Clockwork files only via .worktreeinclude.
function claudeIgnored(root) {
  if (exists(path.join(root, '.git'))) { const r = git(root, ['check-ignore', '-q', '--no-index', '.claude/clockwork-probe']); if (r.code === 0) return true; if (r.code === 1) return false; }
  try { return readText(path.join(root, '.gitignore')).split('\n').some((l) => /^\/?\.claude(\/(\*\*?)?)?\s*$/.test(l.trim())); } catch { return false; }
}
export function migrate(stagingArg, { dryRun = false, reportsDir = null } = {}) {
  const root = real(path.resolve(stagingArg));
  if (!exists(path.join(root, MANIFEST))) refuse(`${root} has no ${MANIFEST}: migrate only runs on a staging copy made by "onboard.mjs stage"`);
  const man = JSON.parse(readText(path.join(root, MANIFEST)));
  if (man.project && real(man.project) === root) refuse('this folder is the real project, not a staging copy');
  const date = isoDate(), ts = stamp();
  const sink = { changes: [], questions: [], originals: [], addPrefixes: {}, sectionDefaults: [], collisions: [] };
  const { changes, questions, originals } = sink;
  const moves = [], written = new Set();
  const w = walk(root, 'census');
  const { path: cfgPath, cfg } = loadConfig(root);
  const idPrefixes = cfg?.idPrefixes && typeof cfg.idPrefixes === 'object' ? cfg.idPrefixes : DEFAULT_PREFIXES;
  const regDirCfg = cfg?.registryDir || null;
  const live = (f) => fileClass(f.rel) === 'live';

  // 1. iCloud conflict copies of documents → .claude/.clockwork-backups/conflict-copies/ (never merged).
  const relSet = new Set(w.files.map((f) => f.rel));
  const copies = w.files.filter((f) => live(f) && isTextDoc(f.rel) && dupOf(path.posix.basename(f.rel)) && relSet.has(path.posix.join(path.posix.dirname(f.rel), dupOf(path.posix.basename(f.rel)))));
  for (const f of copies) {
    const to = `.claude/.clockwork-backups/conflict-copies/${f.rel}`;
    const baseRel = path.posix.join(path.posix.dirname(f.rel), dupOf(path.posix.basename(f.rel)));
    const bst = fs.statSync(path.join(root, baseRel));
    moves.push({ from: f.rel, to, copyOf: baseRel, bytes: f.size, sha256: sha(fs.readFileSync(path.join(root, f.rel))), copyModified: new Date(f.mtimeMs).toISOString(), baseModified: new Date(bst.mtimeMs).toISOString() });
  }
  const moving = new Set(moves.map((m) => m.from));

  // 2. registries: counters, bold IDs, sections, duplicates.
  const regs = w.files.filter((f) => live(f) && !moving.has(f.rel) && registryInfo(path.posix.basename(f.rel)) && !registryInfo(path.posix.basename(f.rel)).conflict);
  const allMax = {}; // prefix → highest number mentioned in any registry (live, archive, copy) — the floor for a new counter
  for (const f of w.files.filter((x) => registryInfo(path.posix.basename(x.rel)))) {
    for (const m of readText(path.join(root, f.rel)).matchAll(ID_RE)) allMax[m[1]] = Math.max(allMax[m[1]] || 0, Number(m[2]));
  }
  const newText = new Map();
  for (const f of regs) {
    const text = readText(path.join(root, f.rel));
    const { text: next } = transformRegistry(f.rel, text, { idPrefixes, allMax, archiveRows: registryInfo(path.posix.basename(f.rel)).archive ? null : archiveRowsFor(root, f.rel) }, sink);
    if (next !== text) newText.set(f.rel, next);
  }
  const addPrefixes = sink.addPrefixes;
  if (Object.keys(addPrefixes).length) {
    if (cfg) changes.push({ file: path.relative(root, cfgPath), line: 0, kind: 'id-prefixes', why: `prefixes with a counter but not in idPrefixes: ${Object.entries(addPrefixes).map(([k, v]) => `${k} → ${v}`).join(', ')}`, before: '', after: [] });
    else questions.push(`No .claude/clockwork.json yet: after install, add to idPrefixes: ${JSON.stringify(addPrefixes)}.`);
  }
  // 3. worktrees: .claude/ gitignored on purpose → the Clockwork files reach a worktree only through .worktreeinclude.
  let wti = null;
  const rootRepo = exists(path.join(root, '.git'));
  if (claudeIgnored(root)) {
    const cur = exists(path.join(root, '.worktreeinclude')) ? readText(path.join(root, '.worktreeinclude')) : '';
    const have = new Set(cur.split('\n').map((l) => l.trim()));
    const miss = WTI_LINES.filter((l) => !have.has(l));
    if (miss.length) {
      const add = ['# Clockwork: .claude/ is gitignored here on purpose, so worktrees get these copied (registries stay in the main copy).', ...miss];
      wti = cur + (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n';
      changes.push({ file: '.worktreeinclude', line: cur ? cur.split('\n').length : 1, kind: 'worktreeinclude', why: '.claude/ is gitignored (kept, CONTRACT-ONBOARD §1.5): without these lines a worktree has no Clockwork hooks, rules, tools or settings', before: '', after: add });
    }
    if (!rootRepo) questions.push('.claude/ is listed in .gitignore but the project root has no .git in staging (not a repository, or .git was too big to stage): check that worktrees are made from this folder. Default: .worktreeinclude lines added anyway.');
  } else if (!rootRepo) {
    const repos = [...new Set(fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && exists(path.join(root, e.name, '.git'))).map((e) => e.name))];
    if (repos.length) questions.push(`The project root is not a git repository; the code repo is ${repos.join(', ')}. Worktrees are made from that repo, so the root .worktreeinclude and .gitignore are never read by git. Default: nothing changed; worktrees of ${repos[0]} find Clockwork by walking up to the root.`);
  }
  // where the verbatim originals go
  let regDir = reportsDir ? null : regDirCfg;
  if (!reportsDir && !regDir) {
    const tasks = regs.filter((f) => registryInfo(path.posix.basename(f.rel)).name === 'TASKS' && !registryInfo(path.posix.basename(f.rel)).archive);
    regDir = tasks.length === 1 ? path.posix.dirname(tasks[0].rel) : '.claude';
  }
  const repDir = reportsDir || path.posix.join(regDir, 'reports', `onboarding-${date}`);
  const origRel = path.posix.join(repDir, 'migrate-originals.md');
  const result = { dryRun, changes, moves, questions, sectionDefaults: sink.sectionDefaults, collisions: sink.collisions, originals: originals.length ? origRel : null, written: [] };
  if (dryRun) return result;
  // write: originals first (so nothing is ever only in memory), then files, then moves.
  if (originals.length) {
    const abs = path.join(root, origRel);
    const head = exists(abs) ? readText(abs).replace(/\n*$/, '\n') : `# Migrate originals — ${date}\nEvery line \`onboard.mjs migrate\` rewrote, verbatim, so nothing is lost. The live files hold the new form.\n`;
    const body = originals.map((o) => `\n## ${o.file}:${o.line} (${o.kind}) — ${ts}\n\`\`\`text\n${o.text}\n\`\`\`\n`).join('');
    writeAtomic(abs, head + body); written.add(origRel);
  }
  for (const [rel, t] of newText) { const abs = path.join(root, rel); writeAtomic(abs, t, fs.statSync(abs).mode & 0o777); written.add(rel); }
  if (cfg && Object.keys(addPrefixes).length) { cfg.idPrefixes = { ...idPrefixes, ...addPrefixes }; writeAtomic(cfgPath, JSON.stringify(cfg, null, 2) + '\n'); written.add(path.relative(root, cfgPath)); }
  if (wti !== null) { writeAtomic(path.join(root, '.worktreeinclude'), wti); written.add('.worktreeinclude'); }
  if (moves.length) {
    const noteRel = '.claude/.clockwork-backups/conflict-copies/NOTE.md';
    const noteAbs = path.join(root, noteRel);
    let nt = exists(noteAbs) ? readText(noteAbs).replace(/\n*$/, '\n') : '# iCloud conflict copies\nMoved here by `onboard.mjs migrate`, never merged. Compare each with the file it copies and merge by hand if it holds anything the original lacks. To undo, move it back.\n\n| Copy (original path) | Copy of | Bytes | SHA-256 | Copy modified | Original modified |\n|---|---|---|---|---|---|\n';
    for (const m of moves) {
      const dst = path.join(root, m.to);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (exists(dst)) refuse(`${m.to} already exists; not overwriting a kept copy`);
      fs.renameSync(path.join(root, m.from), dst);
      if (sha(fs.readFileSync(dst)) !== m.sha256) throw new Error(`${m.to} does not match the copy it was moved from`);
      nt += `| \`${m.from}\` | \`${m.copyOf}\` | ${m.bytes} | ${m.sha256.slice(0, 16)}… | ${m.copyModified} | ${m.baseModified} |\n`;
      written.add(m.to);
    }
    writeAtomic(noteAbs, nt); written.add(noteRel);
  }
  result.written = [...written];
  const log = path.join(root, WORKDIR, `migrate-${ts}.json`);
  writeAtomic(log, JSON.stringify(result, null, 1) + '\n');
  // A stable name for the workflow: which heading takes rows meant for a Clockwork section, and the collisions.
  writeAtomic(path.join(root, WORKDIR, 'migrate-latest.json'), JSON.stringify(result, null, 1) + '\n');
  result.log = path.relative(root, log);
  return result;
}

// ── apply ────────────────────────────────────────────────────────────────────
function approved(planText) {
  if (!planText) return false;
  // Frontmatter decides when it has an approved: key (so an example line in the body can never approve a plan).
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(planText);
  const key = fm && /^approved:\s*(\S+)\s*$/m.exec(fm[1]);
  if (key) return key[1] === 'true';
  return /^\s*\**approved:?\**\s*:?\s*true\s*$/im.test(planText);
}
const applySkip = (rel) => rel === MANIFEST || rel === PLAN || rel.split('/')[0] === WORKDIR;
const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
// Undo by hand: the exact Terminal commands, written before the first write so a crash cannot lose them.
function restoreText(proj, bdirRel, writes) {
  const L = ['# Undo this apply by hand: paste these lines into Terminal.', `cd ${q(proj)}`];
  for (const x of writes) L.push(x.isNew ? `rm -f ${q(x.rel)}   # apply created it` : `cp -p ${q(path.posix.join(bdirRel, x.rel))} ${q(x.rel)}`);
  L.push(`shasum -a 256 -c ${q(path.posix.join(bdirRel, 'SHA256SUMS'))}   # every restored file must say OK`);
  return L.join('\n') + '\n';
}
function isLinkedWorktree(dir) {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  if (!r.ok) return null;
  const [g, c] = r.out.split('\n');
  return real(g) !== real(c) ? path.dirname(c) : null;
}
export function apply(stagingArg, projectArg, { yes = false, allowLive = false, resume = false } = {}) {
  const st = real(path.resolve(stagingArg)), proj = real(path.resolve(projectArg));
  const say = [];
  if (!exists(path.join(st, MANIFEST))) refuse(`${st} has no ${MANIFEST}; not a staging copy made by "onboard.mjs stage"`);
  const man = JSON.parse(readText(path.join(st, MANIFEST)));
  if (real(man.project) !== proj) refuse(`this staging copy was made from ${man.project}, not ${proj}`);
  if (within(proj, st) || within(st, proj)) refuse('staging and project folders overlap');
  // registry.mjs refuses inside a worktree whose main copy has no Clockwork, so an apply here would leave a project
  // no tool can write to.
  const mainOf = isLinkedWorktree(proj);
  if (mainOf) refuse(`${proj} is a linked git worktree of ${mainOf}; registry.mjs would refuse to run here. Onboard the main checkout (${mainOf}) instead. Nothing written.`);
  const planPath = path.join(st, PLAN);
  const planText = exists(planPath) ? readText(planPath) : null;
  if (!yes && !approved(planText)) refuse(`${planText === null ? `no ${PLAN} in the staging folder` : `${PLAN} does not say "approved: true"`}; the user approves the plan first (or pass --yes when they say so in this session). Nothing written.`);
  // Every line of the old design file needs a destination before anything is written (no side-by-side for the user).
  const cov = designCoverage(st);
  if (cov.cannotRun) refuse(`design coverage could not run: ${cov.cannotRun}. Nothing written.`);
  if (cov.required && (cov.unmapped.length || cov.problems.length)) refuse(`design coverage: ${cov.unmapped.length} line(s) of the old design file have no destination and ${cov.problems.length} destination(s) do not check out${[...cov.problems, ...cov.unmapped].slice(0, 5).map((x) => `; ${x}`).join('')}${cov.unmapped.length + cov.problems.length > 5 ? ' …' : ''}. Run: onboard.mjs coverage ${q(st)}. Nothing written.`);
  say.push(cov.required ? `design coverage: all ${cov.mapped} line(s) of ${cov.oldFiles.map((f) => f.path).join(', ')} have a checked destination` : `design coverage: not required (${cov.why})`);
  for (const x of cov.required ? [] : cov.problems) say.push(`design coverage, NOT CHECKED: ${x}`);
  // --resume: an earlier apply of THIS staging copy stopped half-way (its APPLYING.json is still there).
  const bbase = path.join(proj, '.claude', '.clockwork-backups');
  let prior = null;
  const cands = exists(bbase) ? fs.readdirSync(bbase).filter((n) => /-onboard(-\d+)?$/.test(n) && exists(path.join(bbase, n, APPLYING))).sort() : [];
  const mine = cands.map((n) => { try { return { dir: path.join(bbase, n), j: JSON.parse(readText(path.join(bbase, n, APPLYING))) }; } catch { return null; } }).filter((x) => x && real(x.j.staging) === st);
  // A second, separate backup would split the undo in two: a half-way apply is finished with --resume only.
  if (!resume && mine.length) refuse(`an earlier apply of this staging copy stopped half-way (backup ${path.relative(proj, mine[mine.length - 1].dir)}/). Finish it: the same command with --resume. Or undo it: the commands in ${path.relative(proj, mine[mine.length - 1].dir)}/RESTORE.txt. Nothing written.`);
  if (resume) {
    if (!mine.length) refuse(`--resume: no unfinished apply of this staging copy (no ${APPLYING} in ${path.relative(proj, bbase)}/*-onboard). Nothing written.`);
    prior = mine[mine.length - 1];
    say.push(`resuming the apply that stopped half-way (backup ${path.relative(proj, prior.dir)})`);
  }
  // 1. the real project must not have changed since stage (on --resume a file may also already hold the staged version)
  const stagedHash = (rel) => { const s = path.join(st, rel); try { const l = fs.lstatSync(s); return l.isFile() ? sha(fs.readFileSync(s)) : null; } catch { return null; } };
  // Offloaded by iCloud: never read. One that staging would overwrite can be neither compared nor backed up (refused);
  // one that staging left as it was is simply not written, and listed (notCheckedOffloaded).
  const changed = [], offloaded = [], offloadedKept = [];
  for (const [rel, e] of Object.entries(man.files)) {
    const abs = path.join(proj, rel);
    if (!exists(abs)) { changed.push(`${rel} (deleted)`); continue; }
    const lst = fs.lstatSync(abs);
    if (offloadState(abs, lst) === 'offloaded') { (e.symlink === undefined && stagedHash(rel) === e.sha256 ? offloadedKept : offloaded).push(abs); continue; }
    const h = e.symlink !== undefined ? (lst.isSymbolicLink() ? sha(`symlink:${fs.readlinkSync(abs)}`) : 'x') : lst.isSymbolicLink() ? 'x' : sha(fs.readFileSync(abs));
    // Already holding the staged version (an earlier apply, finished or half-way) is not a change.
    if (h !== e.sha256 && h !== stagedHash(rel)) changed.push(`${rel} (changed)`);
  }
  // 2. what staging would write
  const w = walk(st, 'apply');
  const writes = [], same = [], symlinks = [];
  for (const f of w.files) {
    if (applySkip(f.rel)) continue;
    const src = path.join(st, f.rel), dst = path.join(proj, f.rel);
    if (f.link) {
      const t = fs.readlinkSync(src), e = man.files[f.rel];
      // A link stage re-pointed inside staging (stagedAs) and left alone since then is not a change.
      if (e?.stagedAs === t && exists(dst) && fs.lstatSync(dst).isSymbolicLink() && fs.readlinkSync(dst) === e.symlink) continue;
      if (!(exists(dst) && fs.lstatSync(dst).isSymbolicLink() && fs.readlinkSync(dst) === t)) symlinks.push(f.rel);
      continue;
    }
    const buf = fs.readFileSync(src);
    if (exists(dst)) {
      if (fs.lstatSync(dst).isSymbolicLink() || !fs.lstatSync(dst).isFile()) { symlinks.push(f.rel); continue; }
      if (offloadState(dst) === 'offloaded') { if (!offloaded.includes(dst) && !offloadedKept.includes(dst)) offloaded.push(dst); continue; }
      if (sha(fs.readFileSync(dst)) === sha(buf)) { same.push(f.rel); continue; }
      writes.push({ rel: f.rel, buf, mode: f.mode, isNew: false });
    } else writes.push({ rel: f.rel, buf, mode: f.mode, isNew: true });
  }
  // A path staging would overwrite that did not exist (or was not staged) at stage time was created by someone since.
  const offAtStage = new Set((man.excluded?.offloaded || []).map((x) => x.path));
  for (const x of writes) if (!x.isNew && !man.files[x.rel] && !/(^|\/)\.clockwork-backups\//.test(x.rel)) changed.push(`${x.rel} (${offAtStage.has(x.rel) ? 'offloaded by iCloud when staged, so staging never saw it' : 'created in the project after staging'})`);
  if (offloaded.length) refuse(`${offloaded.length} project file(s) are offloaded by iCloud, so apply cannot compare them with staging or back them up: ${offloaded.slice(0, 5).map(offloadNote).join('; ')}${offloaded.length > 5 ? ` … (${offloaded.length - 5} more)` : ''}. Nothing written.`);
  if (changed.length) refuse(`the real project changed since staging (${changed.length} file(s): ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ' …' : ''}). Take the changes in with: onboard.mjs rebase ${q(st)} ${q(proj)} (then re-run the checks), or re-stage. Nothing written.`);
  // 3. nobody else working in it
  const live = liveSessions(proj);
  if (!live.checked) {
    if (!allowLive) refuse(`could not check for live Claude sessions in the project (${live.error}); nothing written. --allow-live overrides only if the user says so.`);
    say.push(`!!! --allow-live: live sessions were NOT checked (${live.error}).`);
  } else if (live.sessions.length) {
    const who = live.sessions.map((s) => `${s.name || s.sessionId} (${s.kind}, ${s.cwd})`).join('; ');
    if (!allowLive) refuse(`${live.sessions.length} other Claude session(s) are live in the project: ${who}. Close them or have the user override with --allow-live. Nothing written.`);
    say.push(`!!! --allow-live: writing while ${live.sessions.length} other session(s) are live: ${who}`);
  }
  const removed = Object.keys(man.files).filter((rel) => !applySkip(rel) && !exists(path.join(st, rel)));
  const result = { project: proj, staging: st, writes: writes.map((x) => ({ path: x.rel, new: x.isNew })), unchanged: same.length, notRemoved: removed, symlinksNotApplied: symlinks, backup: null, doctor: null, notices: say,
    notCopiedOffloaded: (man.excluded?.offloaded || []).map((x) => x.path), notCheckedOffloaded: offloadedKept.map((x) => path.relative(proj, x)) };
  if (!writes.length && !prior) return result;
  // 4. backup every file that will be overwritten (+ list of new files), verified; then the marker; then write
  let bdir;
  if (prior) bdir = prior.dir;
  else { const b0 = path.join(bbase, `${stamp()}-onboard`); bdir = b0; for (let i = 2; exists(bdir); i++) bdir = `${b0}-${i}`; fs.mkdirSync(bdir, { recursive: true }); }
  const bRel = path.relative(proj, bdir);
  const sumsPath = path.join(bdir, 'SHA256SUMS');
  const sums = prior && exists(sumsPath) ? readText(sumsPath).split('\n').filter(Boolean) : [];
  for (const x of writes.filter((y) => !y.isNew)) {
    const b = path.join(bdir, x.rel);
    if (prior && exists(b)) continue; // backed up by the first run, before its first write
    const buf = fs.readFileSync(path.join(proj, x.rel));
    fs.mkdirSync(path.dirname(b), { recursive: true }); fs.writeFileSync(b, buf);
    const h = sha(buf); if (sha(fs.readFileSync(b)) !== h) throw new Error(`backup of ${x.rel} did not verify; nothing written`);
    sums.push(`${h}  ${x.rel}`);
  }
  fs.writeFileSync(sumsPath, sums.join('\n') + (sums.length ? '\n' : ''));
  const allWrites = prior ? [...prior.j.writes.map((y) => ({ rel: y.path, isNew: y.new })), ...writes.filter((x) => !prior.j.writes.some((y) => y.path === x.rel))] : writes;
  fs.writeFileSync(path.join(bdir, 'CREATED.txt'), `# Files apply created (delete them to undo, then copy the backups back)\n${allWrites.filter((y) => y.isNew).map((y) => y.rel).join('\n')}\n`);
  fs.writeFileSync(path.join(bdir, 'RESTORE.txt'), restoreText(proj, bRel, allWrites));
  if (planText !== null) fs.writeFileSync(path.join(bdir, PLAN), planText);
  fs.writeFileSync(path.join(bdir, APPLYING), JSON.stringify({ staging: st, project: proj, startedAt: prior?.j.startedAt || now().toISOString(), writes: allWrites.map((x) => ({ path: x.rel, new: x.isNew })) }, null, 1) + '\n');
  result.backup = bRel;
  let done = 0;
  try { for (const x of writes) { writeAtomic(path.join(proj, x.rel), x.buf, x.mode); done++; } }
  catch (e) {
    const err = new Error(`apply stopped after writing ${done} of ${writes.length} file(s): ${e.message}. The project is HALF-APPLIED. Backup: ${bRel}/. To finish: fix the cause, then run onboard.mjs apply ${q(st)} ${q(proj)} --yes --resume. To undo instead: run the commands in ${bRel}/RESTORE.txt.`);
    err.halfApplied = true; throw err;
  }
  fs.rmSync(path.join(bdir, APPLYING), { force: true });
  // 5. re-run the doctor in the real project; its full report is kept next to the backup
  const doc = path.join(proj, '.claude', 'hooks', 'clockwork-doctor.mjs');
  if (exists(doc)) {
    const env = Object.assign({}, process.env); delete env.CLAUDE_PROJECT_DIR; delete env.CLOCKWORK_ROOT;
    const r = spawnSync(process.execPath, [doc, '--report', '--root', proj], { encoding: 'utf8', timeout: 120000, env });
    const full = `${r.stdout || ''}${r.stderr || ''}`.trim();
    fs.writeFileSync(path.join(bdir, 'doctor-after-apply.txt'), full + '\n');
    const lines = full.split('\n');
    // Every ERROR / CRASHED line, however many warnings follow (a fixed tail cut them off).
    const errors = [];
    for (let i = 0; i < lines.length; i++) if (/^(ERRORS|CRASHED) \(/.test(lines[i])) { for (; i < lines.length && lines[i].trim(); i++) errors.push(lines[i]); }
    result.doctor = { ran: true, exit: r.status, errors, tail: lines.slice(-8).join('\n'), full: path.posix.join(bRel, 'doctor-after-apply.txt') };
  } else result.doctor = { ran: false, why: '.claude/hooks/clockwork-doctor.mjs not in the project after apply' };
  return result;
}

// ── design coverage ──────────────────────────────────────────────────────────
// When onboarding condenses an old design file into .claude/rules/design-system.md, EVERY content line of the old
// file must say where it went, in <registryDir>/reports/onboarding-<date>/design-coverage.md:
//   | Old line | Goes to | Proof |
//   | DESIGN-SYSTEM.md:12 | SP-2 | |                                 a design-system.md row whose Source cites that line
//   | DESIGN-SYSTEM.md:14 | retired | CD-4 |                          a later CD row, a row marked "reversed", or file:line
//   | DESIGN-SYSTEM.md:20-24 | kept DESIGN-SYSTEM-ARCHIVE.md:20 | |  verbatim there (same text, line for line), still binding
//   | DESIGN-SYSTEM.md:3 | not a rule | intro sentence |              the reason is required
// Mechanical only: it proves every line has a destination that exists. That a row SAYS what its lines said is the
// workflow's fresh semantic check (onboard/workflows/onboard.js). Apply refuses while a line is unmapped.
// Old design files = isDesignDoc (the same rule discover uses), plus the project's OWN .claude/rules/design-system.md
// when onboarding rewrites it (its lines that survive verbatim in the new file are covered by staying there; a
// byte-identical copy of the kit template holds no project rules and is skipped). It never skips silently: no
// before-copy = cannotRun (apply refuses), and an old design file iCloud kept out of staging is a problem.
const COVERAGE = 'design-coverage.md';
export function contentLines(text) {
  const L = text.split('\n'), out = [];
  let fence = false, i = 0;
  if (L[0] === '---') { const e = L.indexOf('---', 1); if (e > 0) i = e + 1; }
  for (; i < L.length; i++) {
    const ln = L[i], t = ln.trim();
    if (/^(```|~~~)/.test(t)) { fence = !fence; continue; }
    if (!t) continue;
    if (!fence) {
      if (/^#{1,6}\s/.test(t) || /^([-*_])(\s*\1){2,}$/.test(t) || /^<!--.*-->$/.test(t)) continue;
      if (t.startsWith('|') && /^\|?[\s:|-]+\|?$/.test(t) && t.includes('-')) continue; // table separator
      if (t.startsWith('|') && /^\|?[\s:|-]+\|?$/.test((L[i + 1] || '').trim()) && (L[i + 1] || '').includes('-')) continue; // table header
    }
    out.push({ n: i + 1, text: ln });
  }
  return out;
}
export function designCoverage(stagingArg) {
  const root = real(path.resolve(stagingArg));
  const reg = loadConfig(root).cfg?.registryDir || '.claude';
  const pr = path.join(root, PRISTINE);
  const res = { required: false, why: '', cannotRun: null, coverageFiles: [], oldFiles: [], unmapped: [], problems: [], mapped: 0, keptInPlace: 0 };
  if (!exists(pr)) { res.cannotRun = res.why = `no before-copy (${PRISTINE}) in this staging folder, so the old design lines cannot be checked (staged by an older onboard.mjs?): re-stage`; return res; }
  const txt = (abs) => { try { return fs.statSync(abs).isFile() && offloadState(abs) !== 'offloaded' ? readText(abs) : null; } catch { return null; } };
  const DS = '.claude/rules/design-system.md';
  const dsNow = txt(path.join(root, DS)), dsBefore = txt(path.join(pr, DS));
  const skipOld = (rel) => (rel !== DS && /(^|\/)\.claude\/rules\//.test(rel)) || /-ARCHIVE\.(md|mdx|markdown)$/i.test(rel) || BACKUP_DIR.test(rel) || /(^|\/)reports\//.test(rel) || rel.startsWith(`${WORKDIR}/`);
  const olds = new Set(walk(pr, 'census').files.map((f) => f.rel).filter((r) => isDesignDoc(r) && !skipOld(r)));
  const kitDs = txt(KIT_TEMPLATES[DS]);
  if (dsBefore === null || dsBefore === dsNow || dsBefore === kitDs) olds.delete(DS); // no project rules to lose there
  // An old design file iCloud had offloaded at stage time was never copied, so none of its lines can be checked.
  let man = null; try { man = JSON.parse(readText(path.join(root, MANIFEST))); } catch { /* no manifest: nothing known */ }
  const notStaged = (man?.excluded?.offloaded || []).map((x) => x.path).filter((r) => isDesignDoc(r) && !skipOld(r) && r !== DS);
  for (const r of notStaged) res.problems.push(`${r}: offloaded by iCloud when staged, so it is not in the before-copy and none of its lines can be checked. Download it in the project (${offloadNote(path.join(man.project || '', r)).replace(/^not checked: /, '')}) and re-stage`);
  // the coverage file(s) written by the condense job
  const rows = [];
  for (const d of reportsDirs(root, reg)) {
    const f = path.posix.join(d, COVERAGE), t = txt(path.join(root, f));
    if (t === null) continue;
    res.coverageFiles.push(f);
    t.split('\n').forEach((ln, i) => {
      if (!ln.startsWith('|')) return;
      const c = cellsOf(ln).cells.map((x) => x.text.trim().replace(/^`|`$/g, ''));
      const m = /^(.+?):(\d+)(?:[-–](\d+))?$/.exec(c[0] || '');
      if (!m) return; // header, separator, or not a line reference
      const at = `${f}:${i + 1}`;
      rows.push({ at, file: m[1].replace(/^\.\//, ''), from: Number(m[2]), to: Number(m[3] || m[2]), dest: c[1] || '', proof: c[2] || '' });
    });
  }
  for (const r of rows) if (!skipOld(r.file) && exists(path.join(pr, r.file)) && (r.file !== DS || olds.has(DS))) olds.add(r.file);
  const anyOld = olds.size > 0 || notStaged.length > 0;
  res.required = anyOld && dsNow !== null && dsNow !== dsBefore;
  res.why = !anyOld ? 'no old design file in the before-copy' : dsNow === null ? `${DS} is missing in staging` : dsNow === dsBefore ? `${DS} was not rewritten by onboarding` : `onboarding rewrote ${DS} from ${[...olds, ...notStaged].join(', ')}`;
  if (!olds.size || dsNow === null) return res;
  const dsLines = dsNow.split('\n');
  const rowOf = (text, id) => text.split('\n').find((l) => l.startsWith(`| ${id} `) || l.startsWith(`|${id}|`) || l.startsWith(`| ${id}|`));
  const client = txt(path.join(root, reg, 'CLIENT.md')) || '';
  const lineAt = (rel, n) => { for (const base of [root, pr]) { const t = txt(path.join(base, rel)); if (t !== null) { const L = t.split('\n'); return n >= 1 && n <= L.length ? L[n - 1] : null; } } return null; };
  const covered = new Map(); // "file:n" → true
  for (const r of rows) {
    const oldText = txt(path.join(pr, r.file));
    if (oldText === null) { res.problems.push(`${r.at}: ${r.file} is not in the before-copy`); continue; }
    const OL = oldText.split('\n');
    if (r.from < 1 || r.to < r.from || r.to > OL.length) { res.problems.push(`${r.at}: ${r.file}:${r.from}${r.to !== r.from ? `-${r.to}` : ''} is outside the file (${OL.length} lines)`); continue; }
    const d = r.dest, base = path.posix.basename(r.file);
    let ok = true;
    if (/^[A-Z]+-\d+(\s*,\s*[A-Z]+-\d+)*$/.test(d)) {
      for (const id of d.split(/\s*,\s*/)) {
        const row = rowOf(dsNow, id);
        if (!row) { res.problems.push(`${r.at}: row ${id} is not in ${DS}`); ok = false; continue; }
        const cites = [...row.matchAll(CITE_RE)].filter((m) => path.posix.basename(m[1]) === base).map((m) => [Number(m[2]), Number(m[3] || m[2])]);
        if (!cites.some(([a, b]) => a <= r.from && r.to <= b)) { res.problems.push(`${r.at}: row ${id}'s Source does not cite ${base}:${r.from}${r.to !== r.from ? `-${r.to}` : ''}`); ok = false; }
      }
    } else if (/^retired$/i.test(d)) {
      const p = r.proof, id = /^([A-Z]+-\d+)\b/.exec(p)?.[1], cite = [...p.matchAll(CITE_RE)][0];
      if (id ? (id.startsWith('CD-') ? !rowOf(client, id) : !/reversed/i.test(rowOf(dsNow, id) || '')) : cite ? !(lineAt(cite[1].replace(/^\.\//, ''), Number(cite[2])) || '').trim() : true) {
        res.problems.push(`${r.at}: retired needs a proof that exists: a CD row in ${reg}/CLIENT.md, a ${DS} row whose Source says "reversed", or file:line of the later decision (got "${cut(p, 60) || 'nothing'}")`); ok = false;
      }
    } else if (/^kept\s+/i.test(d)) {
      const m = /^kept\s+`?(.+?):(\d+)`?$/i.exec(d);
      if (!m) { res.problems.push(`${r.at}: "kept" needs <file>:<line> of the verbatim copy`); ok = false; }
      else {
        const k = m[1].replace(/^\.\//, ''), kt = txt(path.join(root, k));
        if (kt === null) { res.problems.push(`${r.at}: ${k} is not in staging`); ok = false; }
        else {
          const KL = kt.split('\n');
          for (let n = r.from; n <= r.to; n++) if ((KL[Number(m[2]) + n - r.from - 1] ?? null) === null || KL[Number(m[2]) + n - r.from - 1].trimEnd() !== OL[n - 1].trimEnd()) { res.problems.push(`${r.at}: ${k}:${Number(m[2]) + n - r.from} is not the verbatim text of ${r.file}:${n}`); ok = false; break; }
          const kb = path.posix.basename(k);
          if (!dsLines.some((l) => l.includes(kb) && /binding/i.test(l))) { res.problems.push(`${r.at}: ${DS} has no line pointing at ${kb} as still binding, so no agent would read the kept rules`); ok = false; }
        }
      }
    } else if (/^not a rule$/i.test(d)) {
      if (!r.proof) { res.problems.push(`${r.at}: "not a rule" needs its reason in the Proof cell`); ok = false; }
    } else { res.problems.push(`${r.at}: unknown destination "${cut(d, 40)}" (a row ID, retired, kept <file>:<line>, or not a rule)`); ok = false; }
    if (ok) for (let n = r.from; n <= r.to; n++) covered.set(`${r.file}:${n}`, true);
  }
  // The project's own design-system.md, rewritten in place: a line still there word for word has not gone anywhere.
  if (olds.has(DS)) {
    const now = new Set(dsLines.map((l) => l.trimEnd()));
    for (const x of contentLines(dsBefore)) if (!covered.has(`${DS}:${x.n}`) && now.has(x.text.trimEnd())) { covered.set(`${DS}:${x.n}`, true); res.keptInPlace++; }
  }
  for (const f of [...olds].sort()) {
    const t = txt(path.join(pr, f));
    if (t === null) { res.problems.push(`${f}: not readable in the before-copy (offloaded?)`); continue; }
    const cl = contentLines(t), miss = cl.filter((x) => !covered.has(`${f}:${x.n}`));
    res.oldFiles.push({ path: f, contentLines: cl.length, mapped: cl.length - miss.length });
    res.mapped += cl.length - miss.length;
    for (const x of miss) res.unmapped.push(`${f}:${x.n}: ${cut(x.text, 100)}`);
  }
  if (res.required && !res.coverageFiles.length) res.problems.unshift(`no ${COVERAGE} under ${reg}/reports/onboarding-*/: the design condense must write one`);
  return res;
}

// ── sources ──────────────────────────────────────────────────────────────────
// Every Source citation onboarding wrote must point at a line that exists in the "before" copy, so a reviewer can
// check a row against its source instead of hunting for it. Mechanical: it proves the line exists, not that it
// says the same thing — sources-pairs.md puts each row next to its cited line for the verifier and the user.
const CITE_RE = /([^\s|`'"()[\]<>,;]+\.[A-Za-z0-9]{1,8}):(\d+)(?:[-–](\d+))?/g;
// The kit's own copy of each file onboarding fills (this file sits in <kit>/onboard/).
const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT_TEMPLATES = { 'AGENTS.md': path.join(KIT_DIR, 'templates', 'AGENTS.md'), 'CLAUDE.md': path.join(KIT_DIR, 'templates', 'CLAUDE.md'), '.claude/rules/design-system.md': path.join(KIT_DIR, 'templates', 'claude', 'rules', 'design-system.md') };
const CODE_EXT = /\.(m?[jt]sx?|php|py|css|scss|vue|svelte|twig|html|rb|go|json|ya?ml|toml)$/i;
const reportsDirs = (root, reg) => {
  const out = [];
  for (const base of [...new Set([reg, '.claude'])]) {
    const d = path.join(root, base, 'reports');
    try { for (const n of fs.readdirSync(d)) if (/^onboarding-/.test(n)) out.push(path.posix.join(base, 'reports', n)); } catch { /* none */ }
  }
  return out;
};
export function sources(stagingArg) {
  const root = real(path.resolve(stagingArg));
  if (!exists(path.join(root, MANIFEST))) refuse(`${root} has no ${MANIFEST}: sources runs on a staging copy made by "onboard.mjs stage"`);
  const reg = loadConfig(root).cfg?.registryDir || '.claude';
  const pr = path.join(root, PRISTINE), hasPristine = exists(pr);
  const reps = reportsDirs(root, reg);
  const byBase = new Map(); // basename → rel paths in the before copy (for a citation that names only the file)
  for (const f of walk(hasPristine ? pr : root, 'census').files) (byBase.get(path.posix.basename(f.rel)) || byBase.set(path.posix.basename(f.rel), []).get(path.posix.basename(f.rel))).push(f.rel);
  const cache = new Map();
  const load = (abs) => { if (!cache.has(abs)) { let t = null; try { if (fs.statSync(abs).isFile()) t = readText(abs).split('\n'); } catch { /* missing */ } cache.set(abs, t); } return cache.get(abs); };
  // A .docx/.pdf/… is cited by the lines of its converted text (<WORKDIR>/converted/<path>.txt), never read raw.
  const CONVERTED = /\.(docx?|pages|rtf|pdf|xlsx?|pptx?|odt|numbers|key)$/i;
  const conv = (rel) => path.join(root, WORKDIR, 'converted', `${rel}.txt`);
  const locate = (p) => {
    const rel = p.replace(/^\.\//, '');
    const cands = CONVERTED.test(rel) ? [conv(rel), conv(path.posix.join(reg, rel))] : [
      ...(hasPristine ? [path.join(pr, rel), path.join(pr, reg, rel)] : []),
      ...reps.map((d) => path.join(root, d, 'originals', rel)),
      conv(rel),
      path.join(root, rel), path.join(root, reg, rel),
    ];
    for (const c of cands) if (load(c)) return { abs: c, shown: path.relative(root, c) };
    const hits = byBase.get(path.posix.basename(rel)) || [];
    if (hits.length === 1 && !rel.includes('/')) { const c = CONVERTED.test(rel) ? conv(hits[0]) : path.join(hasPristine ? pr : root, hits[0]); if (load(c)) return { abs: c, shown: path.relative(root, c) }; }
    return hits.length > 1 && !rel.includes('/') ? { ambiguous: hits.slice(0, 5) } : null;
  };
  const failures = [], pairs = [], noCite = [], unfilled = [];
  let checked = 0;
  // Lines onboarding did not write are not checked: the kit template's own rows (their Source is a kit lesson, not a
  // project line) and lines the file already had before onboarding (a project already on Clockwork 2).
  const notOurs = (rel) => {
    const s = new Set();
    for (const f of [KIT_TEMPLATES[rel], hasPristine ? path.join(pr, rel) : null]) { if (!f) continue; try { for (const l of readText(f).split('\n')) s.add(l.trimEnd()); } catch { /* none */ } }
    return s;
  };
  const cite = (file, n, line, m, rowText = line) => {
    const tries = [m[1]]; let rest = line.slice(0, m.index);
    for (let k = 0; k < 4; k++) { const mm = /([^\s|`'"()[\]<>]+)(\s+)$/.exec(rest); if (!mm) break; tries.push(mm[1] + mm[2] + tries[tries.length - 1]); rest = rest.slice(0, mm.index); }
    let loc = null; for (const t of tries) { loc = locate(t); if (loc && !loc.ambiguous) break; }
    const from = Number(m[2]), to = m[3] ? Number(m[3]) : from;
    checked++;
    const at = `${file}:${n}`;
    if (!loc) { failures.push(`${at}: cites ${m[0]}, but that file is not in the before copy, the archived originals or staging`); return false; }
    if (loc.ambiguous) { failures.push(`${at}: cites ${m[0]}, but ${loc.ambiguous.length} files have that name (${loc.ambiguous.join(', ')}); give the path`); return false; }
    const L = load(loc.abs), count = L.length - (L[L.length - 1] === '' ? 1 : 0);
    if (from < 1 || to < from || to > count) { failures.push(`${at}: cites ${m[0]}, but ${loc.shown} has ${count} lines`); return false; }
    const got = L.slice(from - 1, to);
    if (!got.some((x) => x.trim())) { failures.push(`${at}: cites ${m[0]}, but ${got.length > 1 ? 'those lines are' : 'that line is'} empty in ${loc.shown}`); return false; }
    pairs.push({ at, row: cut(rowText, 300), cited: `${loc.shown}:${from}${to !== from ? `-${to}` : ''}`, text: got.slice(0, 6).map((x) => cut(x, 200)) });
    return { L, loc };
  };
  const checkFile = (rel, { manifest = false } = {}) => {
    const abs = path.join(root, rel); if (!exists(abs)) return;
    const lines = readText(abs).split('\n');
    const skip = manifest ? new Set() : notOurs(rel);
    let srcCol = -1, valCol = -1, fence = false;
    lines.forEach((ln, i) => {
      if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; return; }
      if (fence) return;
      const n = i + 1;
      if (ln.startsWith('|')) {
        const cells = cellsOf(ln).cells.map((c) => c.text.trim());
        if (!(lines[i - 1] || '').startsWith('|')) { const bare = cells.map((c) => c.replace(/[*_`]/g, '')); srcCol = bare.findIndex((c) => /^source$/i.test(c)); valCol = bare.findIndex((c) => /^value\b/i.test(c)); return; } // header row
        if (/^\|[\s:|-]+\|?$/.test(ln)) return; // separator
        // An unfilled design row (a {{…}} value, or an empty one left for the user: "decide per project") is not a rule
        // yet: listed, never counted as a missing source.
        const v = valCol >= 0 ? cells[valCol] ?? '' : null;
        if (srcCol >= 0 && (v === null ? ln.includes('{{') : v === '' || v.includes('{{') || /decide per project/i.test(v))) { unfilled.push(`${rel}:${n}: ${cut(cells[0] || ln, 80)}`); return; }
        if (skip.has(ln.trimEnd())) return;
        if (srcCol >= 0) {
          const cell = cells[srcCol] || '';
          const ms = [...cell.matchAll(CITE_RE)];
          if (!ms.length) { noCite.push(`${rel}:${n}: Source "${cut(cell, 60) || '(empty)'}" names no file:line — "${cut(ln, 90)}"`); return; }
          for (const m of ms) cite(rel, n, cell, m, ln);
          return;
        }
      } else srcCol = -1;
      if (skip.has(ln.trimEnd())) return;
      const ms = [...ln.matchAll(CITE_RE)].filter((m) => !/^https?:/.test(m[1]));
      if (manifest && / · .* · /.test(ln) && !ms.length && !/^#/.test(ln)) { noCite.push(`${rel}:${n}: manifest entry with no file:line source — "${cut(ln, 90)}"`); return; }
      for (const m of ms) {
        const ok = cite(rel, n, ln, m);
        // A manifest quote must appear verbatim (spacing and quote marks aside) in the file it cites.
        if (manifest && ok) {
          const qm = /[“"]([^”"]{12,})[”"]\s*$/.exec(ln);
          // A quote of a table row is written with escaped pipes (\|) in the manifest; the source has plain ones.
          const norm = (s) => s.replace(/\\\|/g, '|').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
          if (qm && !norm(ok.L.join('\n')).includes(norm(qm[1]))) failures.push(`${rel}:${n}: quote "${cut(qm[1], 60)}" is not in ${ok.loc.shown}`);
        }
      }
    });
  };
  const targets = ['AGENTS.md', 'CLAUDE.md', '.claude/rules/design-system.md'];
  try { for (const n of fs.readdirSync(path.join(root, '.claude', 'rules'))) if (/^project-.*\.md$/.test(n)) targets.push(`.claude/rules/${n}`); } catch { /* no rules yet */ }
  for (const t of targets) checkFile(t);
  const manifests = reps.map((d) => path.posix.join(d, 'sweep-manifest.md')).filter((m) => exists(path.join(root, m)));
  for (const m of manifests) checkFile(m, { manifest: true });
  // Paths AGENTS.md / CLAUDE.md tell agents to open must exist (split registries left pointers to missing copies).
  const missingPaths = [];
  for (const t of ['AGENTS.md', 'CLAUDE.md']) {
    if (!exists(path.join(root, t))) continue;
    readText(path.join(root, t)).split('\n').forEach((ln, i) => {
      for (const m of ln.matchAll(/`([^`\s{}<>*]+\/[^`{}<>*]*\.(?:md|json|mjs|js|sh))`/g)) {
        const p = m[1].replace(/^\.\//, '');
        if (/^(https?:|~|\/)/.test(p) || /(^|\/)reports\//.test(p) || /^\s*if shipped\b/.test(ln.slice(m.index + m[0].length))) continue;
        if (!exists(path.join(root, p))) missingPaths.push(`${t}:${i + 1} points at \`${p}\`, which does not exist in staging`);
      }
    });
  }
  // Old documents that point at a file onboarding rewrote (e.g. "see CLAUDE.md → Branch Rules"): the section may
  // have moved. Listed for the verifier and the plan; not a failure by itself.
  const rewritten = new Set();
  for (const d of reps) {
    const od = path.join(root, d, 'originals'); if (!exists(od)) continue;
    for (const f of walk(od, 'census').files) { const now2 = path.join(root, f.rel); if (!exists(now2) || sha(fs.readFileSync(now2)) !== sha(fs.readFileSync(path.join(od, f.rel)))) rewritten.add(f.rel); }
  }
  const pointers = [];
  if (rewritten.size && hasPristine) {
    const names = [...new Set([...rewritten].map((r) => path.posix.basename(r)))];
    const re = new RegExp(`(?<![\\w.-])(${names.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`);
    for (const f of walk(root, 'census').files) {
      if (rewritten.has(f.rel) || fileClass(f.rel) !== 'live' || f.size > 1024 * 1024 || f.link || (!isTextDoc(f.rel) && !CODE_EXT.test(f.rel))) continue;
      const before = path.join(pr, f.rel);
      if (!exists(before)) continue; // written by onboarding: the verifier reads those
      const buf = fs.readFileSync(path.join(root, f.rel)); if (sha(buf) !== sha(fs.readFileSync(before))) continue;
      buf.toString('utf8').split('\n').forEach((ln, i) => { if (re.test(ln)) pointers.push(`${f.rel}:${i + 1} mentions ${re.exec(ln)[1]} — "${cut(ln, 110)}"`); });
    }
  }
  const all = [...failures, ...noCite, ...missingPaths];
  const pairsRel = path.posix.join(WORKDIR, 'sources-pairs.md');
  const body = ['# Source citations next to the lines they cite', `Made by \`onboard.mjs sources\`. ${checked} citation(s), ${all.length} problem(s). Read each pair: does the cited line say what the row says?`, '',
    ...(all.length ? ['## Problems', ...all.map((x) => `- ${x}`), ''] : []),
    ...(unfilled.length ? ['## Unfilled rows (held to their Baseline row if one backs them; otherwise not measurable until filled from a project source)', ...unfilled.map((x) => `- ${x}`), ''] : []),
    ...(pointers.length ? ['## Old documents pointing at a file onboarding rewrote (check the pointer still holds)', ...pointers.slice(0, 300).map((x) => `- ${x}`), ''] : []),
    '## Pairs', ...pairs.flatMap((p) => [`### ${p.at} → ${p.cited}`, '```text', p.row, '```', '```text', ...p.text, '```', ''])];
  writeAtomic(path.join(root, pairsRel), body.join('\n') + '\n');
  return { checked, failures, noCite, missingPaths, unfilled, pointers, rewritten: [...rewritten], pairs: pairs.length, pairsFile: pairsRel, beforeCopy: hasPristine ? PRISTINE : null, files: [...targets.filter((t) => exists(path.join(root, t))), ...manifests] };
}

// ── rebase ───────────────────────────────────────────────────────────────────
// The real project moved on while onboarding ran (a live session minted C-147). Instead of a full redo: files
// staging never touched are re-copied; files both sides changed are 3-way merged (git merge-file; registries also
// through migrate, so a v1 counter line does not clash with its migrated form). Any conflict → nothing written.
// --taken: files that clashed and that the session merged by hand in staging (the project's change moved to where
// onboarding put that content). Their project version becomes the new "before"; staging keeps its hand merge, and
// census/compare then prove every new line landed somewhere.
export function rebase(stagingArg, projectArg, { taken = [] } = {}) {
  const st = real(path.resolve(stagingArg)), proj = real(path.resolve(projectArg));
  if (!exists(path.join(st, MANIFEST))) refuse(`${st} has no ${MANIFEST}; not a staging copy made by "onboard.mjs stage"`);
  const man = JSON.parse(readText(path.join(st, MANIFEST)));
  if (real(man.project) !== proj) refuse(`this staging copy was made from ${man.project}, not ${proj}`);
  if (within(proj, st) || within(st, proj)) refuse('staging and project folders overlap');
  const pr = path.join(st, PRISTINE);
  if (!exists(pr)) refuse(`${st} has no ${PRISTINE} (staged by an older onboard.mjs), so there is no common base to merge from; re-stage instead`);
  const readOr = (p) => { try { return fs.lstatSync(p).isFile() ? fs.readFileSync(p) : null; } catch { return null; } };
  const binary = (b) => b.includes(0);
  const { cfg } = loadConfig(st);
  const idPrefixes = cfg?.idPrefixes && typeof cfg.idPrefixes === 'object' ? cfg.idPrefixes : DEFAULT_PREFIXES;
  const allMax = {};
  for (const f of walk(st, 'census').files) if (registryInfo(path.posix.basename(f.rel))) for (const m of readText(path.join(st, f.rel)).matchAll(ID_RE)) allMax[m[1]] = Math.max(allMax[m[1]] || 0, Number(m[2]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rebase-'));
  const merge3 = (ours, base, theirs) => {
    const [o, b, t] = ['ours', 'base', 'theirs'].map((n) => path.join(tmp, n));
    fs.writeFileSync(o, ours); fs.writeFileSync(b, base); fs.writeFileSync(t, theirs);
    const r = spawnSync('git', ['merge-file', '-p', '-L', 'staging', '-L', 'at stage time', '-L', 'project now', o, b, t], { encoding: 'buffer', env: gitEnv(), maxBuffer: 256 * 1024 * 1024 });
    return r.error || r.status < 0 || r.status === null ? { err: r.error?.message || `git merge-file exit ${r.status}` } : { conflicts: r.status, out: r.stdout };
  };
  const plan = [], conflicts = [], notChecked = [];
  const tk = new Set(taken.map((x) => x.replace(/^\.\//, '')));
  const unknownTaken = [...tk].filter((x) => !man.files[x]);
  if (unknownTaken.length) refuse(`--taken names file(s) that were not staged: ${unknownTaken.join(', ')}`);
  const clash = (rel, why, theirs) => { if (tk.has(rel) && theirs) plan.push({ rel, kind: 'taken', buf: theirs }); else conflicts.push(`${rel}: ${why}`); };
  try {
    for (const [rel, e] of Object.entries(man.files)) {
      const abs = path.join(proj, rel);
      if (e.symlink !== undefined) { let ok = false; try { ok = fs.lstatSync(abs).isSymbolicLink() && sha(`symlink:${fs.readlinkSync(abs)}`) === e.sha256; } catch { /* gone */ } if (!ok) conflicts.push(`${rel}: a symlink that changed in the project (fix by hand)`); continue; }
      if (offloadState(abs) === 'offloaded') { conflicts.push(`${rel}: ${offloadNote(abs)} (rebase cannot tell whether it changed)`); continue; }
      const theirs = readOr(abs), ours = readOr(path.join(st, rel));
      if (!theirs) { if (ours && sha(ours) === e.sha256) plan.push({ rel, kind: 'removed' }); else conflicts.push(`${rel}: deleted in the project, changed in staging`); continue; }
      const th = sha(theirs); if (th === e.sha256) continue;
      const oh = ours ? sha(ours) : null;
      if (oh === e.sha256) { plan.push({ rel, kind: 'recopied', buf: theirs }); continue; }
      if (oh === th) { plan.push({ rel, kind: 'same', buf: theirs }); continue; }
      const base = readOr(path.join(pr, rel));
      if (!ours || !base || binary(ours) || binary(base) || binary(theirs)) { clash(rel, `changed in the project and ${ours ? 'in staging' : 'removed in staging'}${ours && base ? ' (binary)' : ''}; merge by hand`, theirs); continue; }
      let m = merge3(ours, base, theirs);
      if (!m.err && m.conflicts && registryInfo(path.posix.basename(rel)) && !registryInfo(path.posix.basename(rel)).conflict) {
        // Staging holds the MIGRATED file: merge the project's change in its migrated form too.
        const ctx = { idPrefixes, allMax, archiveRows: null };
        const b2 = transformRegistry(rel, base.toString('utf8'), ctx).text, t2 = transformRegistry(rel, theirs.toString('utf8'), ctx).text;
        const m2 = merge3(ours, Buffer.from(b2), Buffer.from(t2));
        if (!m2.err && m2.conflicts < m.conflicts) m = m2;
      }
      if (m.err) conflicts.push(`${rel}: ${m.err}`);
      else if (m.conflicts) clash(rel, `changed in the project AND in staging; ${m.conflicts} part(s) clash (e.g. both minted the same ID); merge the project's change into staging by hand, then rebase again with --taken`, theirs);
      else plan.push({ rel, kind: 'merged', buf: theirs, merged: m.out });
    }
    // New files in the project since stage
    for (const f of walk(proj, 'stage').files) {
      if (man.files[f.rel] || f.link || SECRET(f.rel) || f.size > BIG) continue;
      if (f.offloaded) { notChecked.push(offloadNote(path.join(proj, f.rel))); continue; } // never read; not taken in
      const buf = fs.readFileSync(path.join(proj, f.rel)), ours = readOr(path.join(st, f.rel));
      if (ours && sha(ours) !== sha(buf)) { conflicts.push(`${f.rel}: created in the project AND in staging with different content`); continue; }
      plan.push({ rel: f.rel, kind: ours ? 'same' : 'added', buf, mode: f.mode });
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const count = (k) => plan.filter((x) => x.kind === k).length;
  const result = { recopied: count('recopied'), merged: count('merged'), added: count('added'), removed: count('removed'), same: count('same'), taken: count('taken'), files: plan.map((x) => `${x.kind} ${x.rel}`), conflicts, notChecked, censusBefore: null };
  if (conflicts.length) return result;
  if (!plan.length) return result;
  const putPristine = (rel, buf) => { const p = path.join(pr, rel); if (exists(p)) fs.chmodSync(p, 0o644); writeAtomic(p, buf, 0o444); };
  for (const x of plan) {
    const s = path.join(st, x.rel);
    if (x.kind === 'removed') { fs.rmSync(s, { force: true }); const p = path.join(pr, x.rel); if (exists(p)) fs.rmSync(p, { force: true }); delete man.files[x.rel]; continue; }
    if (x.kind === 'recopied' || x.kind === 'added') writeAtomic(s, x.buf, exists(s) ? fs.statSync(s).mode & 0o777 : x.mode || 0o644);
    if (x.kind === 'merged') writeAtomic(s, x.merged, fs.statSync(s).mode & 0o777);
    // 'taken': staging keeps the hand merge; only the "before" (pristine + manifest hash) moves to the project's version.
    putPristine(x.rel, x.buf);
    man.files[x.rel] = { sha256: sha(x.buf), bytes: x.buf.length };
  }
  man.rebased = [...(man.rebased || []), { at: now().toISOString(), recopied: result.recopied, merged: result.merged, added: result.added, removed: result.removed, taken: plan.filter((x) => x.kind === 'taken').map((x) => x.rel) }];
  man.fileCount = Object.keys(man.files).length;
  writeAtomic(path.join(st, MANIFEST), JSON.stringify(man, null, 1) + '\n');
  // The "before" census moves with the project: rebuilt from the updated before-copy (the old one is kept).
  const cb = path.join(st, WORKDIR, 'census-before.json');
  if (exists(cb)) fs.renameSync(cb, path.join(st, WORKDIR, `census-before-${stamp()}-pre-rebase.json`));
  writeAtomic(cb, JSON.stringify(census(pr)) + '\n');
  result.censusBefore = path.relative(st, cb);
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const out = (s) => console.log(s);
function printCompare(r) {
  const c = r.counts;
  out(`compare: ${c.beforeFiles} doc files / ${c.beforeIds} IDs before · ${c.afterFiles} / ${c.afterIds} after · ${r.moved} lines moved to another live file · ${r.migrated} rewritten by migrate (originals in migrate-originals.md)`);
  out(`ONLY IN THE ONBOARDING ARCHIVE: ${c.archiveOnlyLines} line(s) no agent will read any more — ${c.archiveOnlyNamedByPlan} named in the plan's "Archived verbatim", ${c.archiveOnlyLines - c.archiveOnlyNamedByPlan} NOT named (counted as LOST)`);
  const show = (label, xs, n = 60) => { if (!xs.length) return; out(`${label} (${xs.length}):`); for (const x of xs.slice(0, n)) out(`  ${/^line/.test(x.type) ? `${x.where}${x.to ? ` → ${x.to}` : ''}  "${x.text}"` : x.text}`); if (xs.length > n) out(`  … ${xs.length - n} more (use --json)`); };
  const T = (...t) => r.lost.filter((x) => t.includes(x.type));
  show('LOST', T('line', 'id-row', 'id-mention', 'counter', 'file'), 200);
  show('NOT LIVE ANY MORE (counted as LOST: the only row left is in an onboarding archive or backup; restore it, or name the ID in "Archived verbatim")', T('id-not-live'), 200);
  show('ONLY IN THE ARCHIVE, NOT NAMED BY THE PLAN (counted as LOST: restore it to its live file, or name the range in "Archived verbatim")', T('line-archive-only'), 200);
  show('ONLY IN BACKUPS / CONFLICT COPIES (kept verbatim, not live — check these)', r.backupOnly);
  show('ONLY IN THE ARCHIVE, named by the plan (kept verbatim — check these)', r.reportOnly);
  show('ACCOUNTED FOR BY THE PLAN ("Archived verbatim")', r.planned, 30);
  if (r.notChecked?.length) { out(`NOT CHECKED (${r.notChecked.length}; offloaded by iCloud, never read — download each, run census again, then compare):`); for (const x of r.notChecked.slice(0, 60)) out(`  – ${x}`); }
}
function main(argv) {
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1), ['dry-run', 'yes', 'allow-live', 'resume']);
  const json = (o) => out(JSON.stringify(o, null, 1));
  switch (cmd) {
    case 'discover': {
      if (!a._[0]) refuse('usage: discover <project> [--json]');
      const d = discover(a._[0]);
      if (a.json) json(d); else out(printDiscover(d));
      return `discover case ${d.case}${d.mode === 'sweep' ? ' (sweep mode: Clockwork 2 already installed)' : ''} · stack ${d.stack.guess} · ${d.docs.length} docs · ${d.registries.length} registries · ${d.notChecked.length} not checked`;
    }
    case 'stage': {
      if (!a._[0]) refuse('usage: stage <project> [--to <dir>] [--json]');
      const m = stage(a._[0], a.to);
      if (a.json) json({ ...m, files: undefined });
      else {
        out(`Staged ${m.fileCount} files (${kb(m.bytes)}) → ${m.staging}`);
        for (const g of m.git) out(`  git ${g.repo}: ${g.copied ? `copied${g.pushDisabled ? ', pushing and hooks disabled in the copy (checked)' : ''}${g.submodulesSealed ? ` (and in ${g.submodulesSealed} submodule(s))` : ''}${g.credentialFilesScrubbed ? `, credentials removed from ${g.credentialFilesScrubbed} git file(s)` : ''}${g.worktreeMetadataDropped?.length ? `, links to ${g.worktreeMetadataDropped.length} real worktree(s) dropped` : ''}${g.repointed ? ', absolute submodule pointer re-pointed inside staging' : ''}` : `NOT copied — ${g.why}`}`);
        if (m.excluded.symlinks.length) out(`  not copied (symlinks pointing outside the project): ${m.excluded.symlinks.map((x) => `${x.path} → ${x.target}`).join(', ')}`);
        if (m.symlinks.some((x) => x.stagedAs !== x.target)) out(`  symlinks re-pointed inside staging: ${m.symlinks.filter((x) => x.stagedAs !== x.target).map((x) => x.path).join(', ')}`);
        out(`  before-copy (read-only): ${path.join(m.staging, m.pristine)}`);
        if (m.excluded.secrets.length) out(`  not copied (secrets): ${m.excluded.secrets.map((s) => s.path).join(', ')}`);
        if (m.excluded.big.length) out(`  not copied (over 5 MB): ${m.excluded.big.map((s) => `${s.path} ${kb(s.bytes)}`).join(', ')}`);
        if (m.excluded.offloaded.length) out(`  not copied (offloaded by iCloud, so never read — download each, then re-stage if it matters): ${m.excluded.offloaded.map((s) => s.path).join(', ')}`);
        if (m.excluded.folders.length) out(`  folders skipped: ${m.excluded.folders.slice(0, 20).map((s) => s.rel).join(', ')}${m.excluded.folders.length > 20 ? ' …' : ''}`);
        out(`  manifest: ${path.join(m.staging, MANIFEST)}`);
      }
      return `staged ${m.staging}`;
    }
    case 'census': {
      if (!a._[0]) refuse('usage: census <dir> [--out f.json] [--json]');
      const c = census(a._[0]);
      if (a.out) writeAtomic(path.resolve(a.out), JSON.stringify(c) + '\n');
      if (a.json) json(c);
      else {
        out(`census ${c.root}: ${c.summary.files} doc files, ${c.summary.lines} lines, ${c.summary.registries} registry files`);
        for (const [p, s] of Object.entries(c.summary.prefixes)) out(`  ${p}: ${s.withRows} IDs with rows (${s.struck} struck), ${s.counterOrMentionOnly} mentioned only (counter / notes), counter next free ${s.counter ? `${p}-${s.counter}` : 'none'}`);
        for (const n of c.notChecked) out(`  NOT CHECKED: ${n}`);
      }
      return `census ${c.summary.files} files${a.out ? ` → ${path.resolve(a.out)}` : ''}`;
    }
    case 'migrate': {
      if (!a._[0]) refuse('usage: migrate <staging> [--dry-run] [--json]');
      const r = migrate(a._[0], { dryRun: !!a['dry-run'], reportsDir: a['reports-dir'] || null });
      if (a.json) json(r);
      else {
        const tail = (x) => { const t = x.replace(/\s+/g, ' ').trim(); return t.length > 200 ? `…${t.slice(-199)}` : t; };
        for (const c of r.changes) {
          out(`CHANGE ${c.file}:${c.line} ${c.kind} — ${c.why}`);
          const show = c.kind === 'duplicate' ? tail : (x) => cut(x, 200); // the VOID marker sits in the last cell
          if (c.before) out(`  - ${show(c.before)}`); for (const x of c.after) out(`  + ${show(x)}`);
        }
        for (const m of r.moves) out(`MOVE ${m.from} → ${m.to} (conflict copy of ${m.copyOf}; not merged)`);
        for (const d of r.sectionDefaults) out(`SECTION ${d.file}: rows meant for "${d.want}" → ${d.use ? `--section "${d.use}"` : 'no section yet (wait for the user)'}`);
        for (const q of r.questions) out(`QUESTION ${q}`);
        if (r.originals) out(`originals of every rewritten line ${r.dryRun ? 'would go' : 'went'} to ${r.originals}`);
      }
      return `migrate ${r.changes.length} change(s), ${r.moves.length} move(s), ${r.questions.length} question(s)${r.dryRun ? ' — dry run, nothing written' : ''}`;
    }
    case 'compare': {
      if (a._.length < 2) refuse('usage: compare <before.json> <after.json> [--plan <ONBOARDING-PLAN.md>] [--json]');
      const load = (p) => { try { return JSON.parse(readText(path.resolve(p))); } catch (e) { refuse(`${p}: not readable JSON (${e.message})`); } };
      if (a.plan && !exists(path.resolve(a.plan))) refuse(`plan not found: ${path.resolve(a.plan)} (write ONBOARDING-PLAN.md first, or run compare without --plan)`);
      const r = compare(load(a._[0]), load(a._[1]), a.plan ? readText(path.resolve(a.plan)) : null);
      if (a.json) json(r); else printCompare(r);
      if (r.lost.length) { process.exitCode = 1; return { err: `${r.lost.length} item(s) LOST` }; }
      return `nothing lost (${r.counts.archiveOnlyLines} line(s) only in the onboarding archive, all named by the plan · ${r.backupOnly.length} only in backups · ${r.planned.length} by the plan)`;
    }
    case 'sources': {
      if (!a._[0]) refuse('usage: sources <staging> [--json]');
      const r = sources(a._[0]);
      if (a.json) json(r);
      else {
        out(`sources: ${r.checked} citation(s) in ${r.files.join(', ') || 'no onboarding files yet'}${r.beforeCopy ? '' : ' — NO before-copy in this staging folder: checked against staging and the archived originals only'}`);
        for (const x of [...r.failures, ...r.noCite, ...r.missingPaths]) out(`  ✗ ${x}`);
        if (r.unfilled.length) out(`${r.unfilled.length} design row(s) still unfilled — held to their Baseline row where one backs them, otherwise not measurable (the plan asks the user): ${r.unfilled.slice(0, 12).map((x) => x.split(': ')[0]).join(', ')}${r.unfilled.length > 12 ? ' …' : ''}`);
        if (r.pointers.length) { out(`${r.pointers.length} line(s) in old documents point at a file onboarding rewrote (${r.rewritten.join(', ')}); check each pointer still holds:`); for (const x of r.pointers.slice(0, 40)) out(`  → ${x}`); if (r.pointers.length > 40) out(`  … ${r.pointers.length - 40} more in ${r.pairsFile}`); }
        out(`every row next to its cited line: ${r.pairsFile}`);
      }
      const bad = r.failures.length + r.noCite.length + r.missingPaths.length;
      if (bad) { process.exitCode = 1; return { err: `${bad} source problem(s): citations that do not resolve, rows with no file:line, or paths that do not exist` }; }
      return `sources: ${r.checked} citation(s) resolve · ${r.unfilled.length} unfilled row(s) · ${r.pointers.length} pointer(s) to rewritten files listed`;
    }
    case 'coverage': {
      if (!a._[0]) refuse('usage: coverage <staging> [--json]');
      const r = designCoverage(a._[0]);
      if (a.json) json(r);
      else {
        out(`design coverage: ${r.why}${r.required ? '' : ' — not required'}`);
        for (const f of r.oldFiles) out(`  ${f.path}: ${f.mapped} of ${f.contentLines} line(s) mapped`);
        for (const x of r.problems) out(`  ✗ ${x}`);
        for (const x of r.unmapped.slice(0, 60)) out(`  UNMAPPED ${x}`);
        if (r.unmapped.length > 60) out(`  … ${r.unmapped.length - 60} more`);
      }
      const bad = r.unmapped.length + r.problems.length;
      if (r.cannotRun) { process.exitCode = 1; return { err: `design coverage could not run: ${r.cannotRun}; apply refuses until it can` }; }
      if (r.required && bad) { process.exitCode = 1; return { err: `design coverage: ${r.unmapped.length} unmapped line(s), ${r.problems.length} problem(s); apply refuses until both are 0` }; }
      return r.required ? `design coverage: all ${r.mapped} line(s) of ${r.oldFiles.map((f) => f.path).join(', ')} have a checked destination` : `design coverage: not required (${r.why})`;
    }
    case 'rebase': {
      if (a._.length < 2) refuse('usage: rebase <staging> <project> [--taken <file,file>] [--json]');
      const r = rebase(a._[0], a._[1], { taken: a.taken ? String(a.taken).split(',').map((x) => x.trim()).filter(Boolean) : [] });
      if (a.json) json(r);
      else { for (const x of r.files) out(`  ${x}`); for (const c of r.conflicts) out(`CONFLICT ${c}`); for (const n of r.notChecked) out(`NOT CHECKED ${n}`); }
      if (r.conflicts.length) { process.exitCode = 1; return { err: `rebase: ${r.conflicts.length} file(s) changed on both sides and could not be merged; nothing written. Merge each into staging by hand (the project's change goes where onboarding put that content), then run rebase again with --taken "<file>,<file>"; or re-stage` }; }
      if (!r.files.length) return 'rebase: the project has not changed since stage — nothing to do';
      return `rebase: ${r.recopied} re-copied, ${r.merged} merged, ${r.added} added, ${r.removed} removed${r.taken ? `, ${r.taken} taken in by hand` : ''} · census-before rebuilt (${r.censusBefore}) · re-run census after + compare + sources before apply`;
    }
    case 'apply': {
      if (a._.length < 2) refuse('usage: apply <staging> <project> [--yes] [--allow-live] [--resume] [--json]');
      const r = apply(a._[0], a._[1], { yes: !!a.yes, allowLive: !!a['allow-live'], resume: !!a.resume });
      if (a.json) json(r);
      else {
        for (const n of r.notices) out(n);
        for (const x of r.writes) out(`WRITE ${x.path}${x.new ? ' (new)' : ''}`);
        out(`${r.unchanged} file(s) already identical — not touched`);
        for (const x of r.notRemoved) out(`NOT REMOVED ${x} — gone from staging, but apply never deletes; remove it by hand after checking`);
        for (const x of r.symlinksNotApplied) out(`NOT APPLIED ${x} — symlink or non-file; do it by hand`);
        for (const x of r.notCopiedOffloaded) out(`NOT COPIED ${x} — offloaded by iCloud at stage time, never read; left as it is in the project`);
        for (const x of r.notCheckedOffloaded) out(`NOT CHECKED ${x} — offloaded by iCloud now; staging did not change it, so it was not written`);
        if (r.backup) out(`backup: ${r.backup}/ (SHA256SUMS, CREATED.txt${exists(path.join(r.project, r.backup, PLAN)) ? `, ${PLAN}` : ''})`);
        if (r.doctor?.ran) out(`doctor (exit ${r.doctor.exit}; full report: ${r.doctor.full}):\n${r.doctor.errors.length ? `${r.doctor.errors.join('\n')}\n…\n` : ''}${r.doctor.tail}`); else if (r.doctor) out(`doctor NOT RUN: ${r.doctor.why}`);
      }
      if (!r.writes.length) return 'apply: nothing differs — nothing written';
      return `applied ${r.writes.length} file(s) · backup ${r.backup} · doctor ${r.doctor.ran ? `exit ${r.doctor.exit}` : 'not run'}`;
    }
    default:
      refuse('usage: onboard.mjs discover|stage|census|migrate|compare|sources|coverage|rebase|apply … (see the top of this file)');
  }
}

const isMain = (() => { try { return process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  try {
    const r = main(process.argv.slice(2));
    if (r && typeof r === 'object' && r.err) out(`ERR ${r.err}`);
    else { out(`OK ${r}`); process.exitCode = 0; }
  } catch (e) {
    if (e instanceof Refusal) { out(`ERR ${e.message}`); process.exitCode = 1; }
    else if (e?.halfApplied) { out(`ERR ${e.message}`); process.exitCode = 2; }
    else { console.error(e?.stack || e); out(`ERR crash: ${e?.message || e}`); process.exitCode = 2; }
  }
}
