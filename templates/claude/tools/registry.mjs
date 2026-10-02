#!/usr/bin/env node
// Clockwork registry tool: the ONLY way sessions write registry rows (kit CONTRACT §3, §5, §6).
// Why: IDs collided when sessions inferred them or announced them in chat; whole-file rewrites
// destroyed peers' notes; unguarded rotations lost rows. Every write here: lock, re-read, assert,
// temp file + rename, re-read to verify, release.
// Usage (run from anywhere inside the project, including a worktree):
//   node "$CLOCKWORK_TOOLS/registry.mjs" mint T --title "…" [--cells "a|b"] [--status "⬜ OPEN"]
//        [--section "## Open"] [--file TASKS.md] [--opened today|YYYY-MM-DD|none] [--claim-branch <b>]
//   … next T · append T-12 --text "…" (or append T-12 "…") · status T-12 "✅ VERIFIED …" · backup --reason <slug>
//   … rotate TASKS.md [--dry-run] [--keep-recent 20] · check
//   … show T-12 · list [T] [--status BUILT]            read-only, always the main copy (a worktree copy is stale)
//   … line FACTS.md --section "## Facts" --text "…" [--replace "<exact old line>"]   files without IDs
//   … report HANDOVER-2026-09-30-x.md --from <file>     copy a report into <registryDir>/reports/ (never overwrites)
//   … claim --session <name> --files "a,b" [--ids T-3] [--branch b] [--until "…"] [--hours 12] [--replace-claim]
//        (a second claim adds to the first; --replace-claim drops the earlier files) · release --session <name> · claims
//   Imported as a module (onboard.mjs, guard-edit, tests) it runs nothing: parse, cellsOf, statusOf, classify, rowIdOf, rowIdsOf,
//   isPointer, isVoidDuplicate, countsAsRow, ROW_RE, COUNTER_RE, offloadState/offloadNote and the claim helpers are exported.
//   … dedupe T-12 [--keep <line>]     one row per ID: drops identical copies; with --keep, renumbers the others
// Exit 0 ok · 1 refused/invalid · 2 crash. Last stdout line: "OK <ID>" or "ERR <reason>".
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

class Refusal extends Error {}
class Conflict extends Error {}
const refuse = (m) => { throw new Refusal(m); };
const say = (m) => console.log(m);

const DEFAULTS = {
  registryDir: '.claude', siteDir: '.', rowBudget: 1500, headerBudget: 1500,
  backupDir: 'PM/archive/registry-backups',
  idPrefixes: { T: 'TASKS.md', C: 'CLIENT.md', CD: 'CLIENT.md', A: 'OPEN-ASKS.md', Q: 'APPROVAL-QUEUE.md' },
};
const REGISTRIES = ['TASKS.md', 'CLIENT.md', 'FACTS.md', 'MEETING-LOG.md', 'OPEN-ASKS.md', 'APPROVAL-QUEUE.md', 'DOC-MAP.md', 'ROUTING.md'];
const FILE_SECTION = { 'TASKS.md': '## Open', 'CLIENT.md': '## Client asks', 'OPEN-ASKS.md': '## Open', 'APPROVAL-QUEUE.md': '## Queue' };
const PREFIX_SECTION = { CD: '## Confirmed Decisions' };
const MARKERS = ['⬜ OPEN', '🔎 VERIFYING', '🔧 BUILT', '✅ VERIFIED', '🚀 LIVE-UNVERIFIED', '⏸ PARKED', '✖ VOID'];
const EMOJI_CLASS = { '⬜': 'OPEN', '🔎': 'VERIFYING', '🔧': 'BUILT', '✅': 'VERIFIED', '🚀': 'LIVE-UNVERIFIED', '⏸': 'PARKED', '✖': 'VOID' };
const LEAD_RE = /^(\p{Extended_Pictographic})️?(?: (?:LIVE-UNVERIFIED|VERIFYING|VERIFIED|OPEN|BUILT|PARKED|VOID)(?![\w-]))?/u;
// A ✅ that still carries open work stays live (lesson L116: an owed look or open sub-item is open).
// A person's look is open work too: "the user's look", or a name ("Sam's look") in rows written before 2.2.0.
const LIVE_SIGNAL = /\b(owed|pending|blocked|not merged|awaiting|depends on|still open|not yet)\b|⏳|the user's look/i;
const NAMED_LOOK = /\b\p{Lu}\p{Ll}+['’]s look\b/u;
// Rows are written as `| T-12 |`; a legacy bold ID `| **T-12** |` is still read, so it counts as taken.
export const ROW_RE = /^\|\s*(?:\*\*)?([A-Z]+)-(\d+)(?:\*\*)?\s*\|/;
export const COUNTER_RE = /next free: `([A-Z]+)-(\d+)`/g;
// THE row rule, shared with clockwork-doctor.mjs (test/registry.test.mjs runs both on one fixture):
// 1. A line is a row of ID X when its first cell (cells split on unescaped `|`), with every * ~ _ removed, is exactly X:
//    `| T-12 |`, `| **T-12** |`, `| *T-12* |`, `| ~~T-12~~ |`. A first cell of IDs only, joined by / · , & + (a
//    combined key, `| ~~T-7 / T-8~~ |`, `| T-61 · T-89 · T-133 |`) keeps every one of them taken, but it is not a full
//    row of any (never a duplicate, never edited). `| T-12a |` and `| T-5 · update 2026-08-25 |` are NOT rows of
//    T-12 / T-5 (sub-items and notes). The doctor imports rowIdsOf, so both read rows the same way.
// 2. A pointer row (≤ 2 cells, or a cell saying "→ archived" / "archived →" / "→ X-ARCHIVE.md") keeps its ID taken,
//    but it is not a second row, and it is never the row append/status edit.
// 3. A row whose status opens with "✖ VOID — duplicate of …" (what onboarding writes, CONTRACT-ONBOARD §3) is the
//    same: taken, not a second row, not edited.
const ID_TOKEN_RE = /(?<![A-Za-z0-9])([A-Z]+)-(\d+)(?!\d)/g;
const POINTER_RE = /→\s*archived|archived\s*→|→\s*`?[A-Z-]*ARCHIVE\.md/i;
const VOID_DUP_RE = /^✖️?\s*VOID\s*[—–-]+\s*duplicate of\b/i;
// Old counter lines onboarding has not converted yet ("> **Next free: T-31**", "Next free IDs: C-9 · CD-3",
// "> Next free: **C-9**"). next and check read them; mint refuses until the line is in the format above.
const LEGACY_HEAD_RE = /next[ -]?free(?:\s+IDs?)?(?:\s+[A-Z]+-#+)?[\s*:`]*/gi;
const LEGACY_TOKEN_RE = /^`?([A-Z]+)-(\d+)`?(?![\w#-])[\s*`]*/;
const LEGACY_SEP_RE = /^(?:·|,|\/|&|\+|\band\b)[\s*`]*(?:next[ -]?free(?:\s+IDs?)?(?:\s+[A-Z]+-#+)?[\s*:`]*)?/i;
const LOCK_STALE_MS = 60_000;
// ✅ VERIFIED on a task needs a fresh verifier's evidence: a report path, a commit sha or a URL (AGENTS.md hard rule 8).
const EVIDENCE_RE = /https?:\/\/\S+|\b[0-9a-f]{7,40}\b|[\w.-]+\/[\w./-]+\.(?:md|json|png|jpe?g|txt|log|html)\b/i;

// ---------- small helpers ----------
const exists = (p) => fs.existsSync(p);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pad2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const stampNow = () => { const d = new Date(); return `${today()}-${pad2(d.getHours())}${pad2(d.getMinutes())}`; };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const keyOf = (prefix, num) => `${prefix}-${Number(num)}`;
const cellText = (s) => String(s).replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|').trim();
const chars = (s) => [...s].length;
const gitEnv = () => { const e = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete e[k]; return e; };
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, env: gitEnv() }).trim();
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// ---------- iCloud "Optimize Mac Storage" (seen 2026-09-30) ----------
// An offloaded ("dataless") file keeps its size but has no blocks on disk. Reading it waits for iCloud to download it,
// and that wait can last forever at 0% CPU; no timeout interrupts a synchronous read. So every kit tool asks this
// before it reads a project file, and never reads an offloaded one. Folders report 0 blocks too: only files count.
// 'local' = safe to read · 'offloaded' · 'missing' · 'unreadable' (the file's details could not be looked up).
// Pass `st` when the caller already has the fs.Stats (a symlink's lstat is 'local': it is never read through).
// CLOCKWORK_FAKE_OFFLOADED (the kit's tests only): paths, separated by ":", treated as offloaded.
export function offloadState(p, st = null) {
  if (!st) { try { st = fs.statSync(p); } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable'; } }
  if (!st.isFile()) return 'local';
  if (st.size > 0 && st.blocks === 0) return 'offloaded';
  const fake = process.env.CLOCKWORK_FAKE_OFFLOADED;
  if (fake && fake.split(path.delimiter).some((f) => f && real(f) === real(p))) return 'offloaded';
  return 'local';
}
export const offloadNote = (p) => `not checked: ${p} is offloaded by iCloud — open it in Finder or run \`brctl download "${p}"\`, then re-run`;
const mustBeLocal = (p) => { if (offloadState(p) === 'offloaded') refuse(offloadNote(p)); return p; };

function parseArgs(argv) {
  const out = { _: [] }; const bools = new Set(['dry-run', 'replace-claim']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (bools.has(k)) out[k] = true;
    else { if (i + 1 >= argv.length) refuse(`--${k} needs a value`); out[k] = argv[++i]; }
  }
  return out;
}

// ---------- root + config (CONTRACT §3) ----------
export function resolveRoot(start = process.cwd(), { quiet = false } = {}) {
  const env = process.env.CLOCKWORK_ROOT;
  if (env) {
    const r = path.resolve(env);
    if (!exists(path.join(r, '.claude', 'clockwork.json'))) refuse(`CLOCKWORK_ROOT=${r} has no .claude/clockwork.json`);
    return r;
  }
  let d = real(start);
  while (!exists(path.join(d, '.claude', 'clockwork.json'))) {
    const up = path.dirname(d);
    if (up === d) refuse('no .claude/clockwork.json in this folder or any parent; run from inside a Clockwork project or set CLOCKWORK_ROOT');
    d = up;
  }
  let common, gitDir, top;
  try { [common, gitDir, top] = git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel']).split('\n').map(real); }
  catch { return d; } // not a git checkout: the folder itself is the only copy
  if (common === gitDir) return d;
  const main = /^worktree (.+)$/m.exec(git(d, ['worktree', 'list', '--porcelain']))?.[1];
  if (!main) refuse(`inside a git worktree but could not find the main worktree for ${d}`);
  const mapped = path.join(real(main), path.relative(top, d));
  if (!exists(path.join(mapped, '.claude', 'clockwork.json'))) refuse(`inside worktree ${top}; main copy ${mapped} has no .claude/clockwork.json`);
  if (!quiet) say(`NOTICE: running inside worktree ${top}; registry writes go to the main copy ${mapped}`);
  return mapped;
}

export function loadConfig(root) {
  let raw;
  const file = mustBeLocal(path.join(root, '.claude', 'clockwork.json'));
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { refuse(`.claude/clockwork.json is not readable JSON: ${e.message}`); }
  const cfg = { ...DEFAULTS, ...raw };
  if (!raw.idPrefixes || typeof raw.idPrefixes !== 'object') cfg.idPrefixes = DEFAULTS.idPrefixes;
  for (const k of ['rowBudget', 'headerBudget']) if (!Number.isFinite(cfg[k])) cfg[k] = DEFAULTS[k];
  return cfg;
}

const regPath = (ctx, f) => (f.includes('/') ? path.join(ctx.root, f) : path.join(ctx.root, ctx.cfg.registryDir, f));
const archiveOf = (f) => f.replace(/\.md$/i, '') + '-ARCHIVE.md';

// ---------- parsing (CONTRACT §5) ----------
function pipesOf(line) {
  const t = line.replace(/\s+$/, ''); const at = [];
  for (let i = 0; i < t.length; i++) if (t[i] === '|' && t[i - 1] !== '\\') at.push(i);
  return { t, at };
}
export function cellsOf(line) {
  const { t, at } = pipesOf(line); const cells = [];
  for (let i = 0; i < at.length - 1; i++) cells.push({ s: at[i] + 1, e: at[i + 1], text: t.slice(at[i] + 1, at[i + 1]) });
  if (at.length && at[at.length - 1] < t.length - 1) cells.push({ s: at[at.length - 1] + 1, e: t.length, text: t.slice(at[at.length - 1] + 1) });
  return cells;
}
export const statusOf = (line) => { const c = cellsOf(line); return c.length ? c[c.length - 1] : null; };
export function classify(status) {
  const m = LEAD_RE.exec(status.trim().replace(/^[*_\s]+/, ''));
  return m ? (EMOJI_CLASS[m[1]] || 'other') : 'none';
}
// The row rule (see above). rowIdsOf: every ID a line is a row of (several for a combined key), or null.
// rowIdOf: the ID of a single-ID row, or null.
export function rowIdsOf(line) {
  if (!String(line).startsWith('|')) return null;
  const first = cellsOf(line)[0];
  if (!first) return null;
  const cell = first.text.replace(/[*~_]/g, '').trim();
  const all = [...cell.matchAll(ID_TOKEN_RE)];
  if (!all.length || all[0].index !== 0 || cell.replace(ID_TOKEN_RE, '').replace(/[\s/·,&+]/g, '') !== '') return null;
  return all.map((m) => ({ id: `${m[1]}-${m[2]}`, prefix: m[1], num: Number(m[2]), key: keyOf(m[1], m[2]) }));
}
export function rowIdOf(line) { const ids = rowIdsOf(line); return ids && ids.length === 1 ? ids[0] : null; }
export const isPointer = (line) => { const c = cellsOf(line); return c.length <= 2 || c.slice(1).some((x) => POINTER_RE.test(x.text)); };
export const isVoidDuplicate = (line) => VOID_DUP_RE.test((statusOf(line)?.text || '').trim().replace(/^[*_~\s]+/, ''));
// A full row: counts toward duplicates, and is the one row append/status/dedupe act on.
export const countsAsRow = (line) => !isPointer(line) && !isVoidDuplicate(line);
const isStub = isPointer;

function legacyCounters(line, i) {
  const out = [];
  for (const h of line.matchAll(LEGACY_HEAD_RE)) {
    let pos = h.index + h[0].length, m = LEGACY_TOKEN_RE.exec(line.slice(pos));
    while (m) {
      const at = pos + m[0].indexOf(`${m[1]}-${m[2]}`);
      out.push({ prefix: m[1], num: Number(m[2]), digits: m[2], line: i, at, raw: `${m[1]}-${m[2]}`, legacy: true });
      pos += m[0].length;
      const s = LEGACY_SEP_RE.exec(line.slice(pos));
      if (!s) break;
      pos += s[0].length; m = LEGACY_TOKEN_RE.exec(line.slice(pos));
    }
  }
  return out;
}

export function parse(text) {
  const lines = text.split('\n');
  const p = { lines, headerEnd: lines.length, counters: [], rows: [], sections: [] };
  let fence = false, tableStart = -1; const legacy = [];
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; tableStart = -1; return; }
    if (fence) return;
    if (line.startsWith('## ')) {
      if (p.headerEnd === lines.length) p.headerEnd = i;
      if (p.sections.length) p.sections[p.sections.length - 1].end = i;
      p.sections.push({ heading: line.trim(), start: i, end: lines.length });
    }
    if (i < p.headerEnd) {
      let v2 = false;
      for (const m of line.matchAll(COUNTER_RE)) { v2 = true; p.counters.push({ prefix: m[1], num: Number(m[2]), digits: m[2], line: i, at: m.index, raw: m[0] }); }
      if (!v2) legacy.push(...legacyCounters(line, i));
    }
    if (line.startsWith('|')) { if (tableStart < 0) tableStart = i; } else tableStart = -1;
    const ids = fence ? null : rowIdsOf(line);
    // One entry per line; `keys` holds every ID of a combined key (all taken), and only a single-ID row is full.
    if (ids) p.rows.push({ ...ids[0], keys: ids.map((x) => x.key), combined: ids.length > 1, line: i, table: tableStart, text: line, full: ids.length === 1 && countsAsRow(line) });
  });
  // An old-format counter counts only for a prefix with no current-format counter (a kept note stays a note);
  // for one prefix only its first mention (a later "T-11 was voided" in the same note is not a second counter).
  const have = new Set(p.counters.map((c) => c.prefix)), seen = new Set();
  for (const c of legacy) if (!have.has(c.prefix) && !seen.has(`${c.prefix}:${c.line}`)) { seen.add(`${c.prefix}:${c.line}`); p.counters.push(c); }
  return p;
}

function readReg(ctx, f, { mustExist = true } = {}) {
  const file = regPath(ctx, f);
  if (!exists(file)) { if (mustExist) refuse(`${f} not found at ${file}`); return { file, name: f, text: null, stat: null, p: parse('') }; }
  mustBeLocal(file);
  const st = fs.statSync(file), text = fs.readFileSync(file, 'utf8'), st2 = fs.statSync(file);
  if (st.mtimeMs !== st2.mtimeMs || st.size !== st2.size) throw new Conflict(`${f} changed while it was being read`);
  return { file, name: f, text, stat: st2, p: parse(text) };
}

// ---------- lock (CONTRACT §3) ----------
function lockOwner(lock) { try { return JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch { return null; } }
function staleReason(lock) {
  const o = lockOwner(lock);
  if (o && o.host === os.hostname() && Number.isInteger(o.pid)) {
    try { process.kill(o.pid, 0); } catch (e) { if (e.code === 'ESRCH') return { why: `holder PID ${o.pid} is not running`, token: o.token }; }
  }
  let mt = 0;
  for (const p of [lock, path.join(lock, 'owner.json')]) { try { mt = Math.max(mt, fs.statSync(p).mtimeMs); } catch {} }
  if (mt && Date.now() - mt > LOCK_STALE_MS) return { why: `older than ${LOCK_STALE_MS / 1000} s`, token: o?.token };
  return null;
}
function acquireLock(ctx) {
  const dir = path.join(ctx.root, '.claude', '.state', 'locks'); fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'registry.lock');
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const timeout = Number(process.env.CLOCKWORK_LOCK_TIMEOUT_MS) || 30_000;
  const t0 = Date.now(); let delay = 5;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), token, cmd: process.argv.slice(2).join(' '), since: new Date().toISOString() }));
      ctx.lock = { lock, token };
      return;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stale = staleReason(lock);
    if (stale) {
      const moved = `${lock}.stale-${token}`;
      try { fs.renameSync(lock, moved); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (lockOwner(moved)?.token !== stale.token && !exists(lock)) { try { fs.renameSync(moved, lock); } catch {} continue; }
      fs.rmSync(moved, { recursive: true, force: true });
      say(`NOTICE: broke stale registry lock ${lock} (${stale.why})`);
      continue;
    }
    if (Date.now() - t0 > timeout) {
      const o = lockOwner(lock);
      refuse(`registry lock busy for ${Math.round(timeout / 1000)} s: ${lock} held by ${o ? `PID ${o.pid} (${o.cmd}) since ${o.since}` : 'unknown holder'}`);
    }
    sleep(delay + Math.random() * delay); delay = Math.min(delay * 2, 100);
  }
}
function heartbeat(ctx) { if (ctx.lock) { const t = new Date(); try { fs.utimesSync(path.join(ctx.lock.lock, 'owner.json'), t, t); fs.utimesSync(ctx.lock.lock, t, t); } catch {} } }
function releaseLock(ctx) {
  if (!ctx.lock) return;
  if (lockOwner(ctx.lock.lock)?.token === ctx.lock.token) fs.rmSync(ctx.lock.lock, { recursive: true, force: true });
  ctx.lock = null;
}
function locked(ctx, fn) {
  acquireLock(ctx);
  try {
    for (let attempt = 1; ; attempt++) {
      try { return fn(); } catch (e) { if (!(e instanceof Conflict) || attempt >= 3) throw e; say(`NOTICE: ${e.message}; re-reading (attempt ${attempt + 1})`); }
    }
  } finally { releaseLock(ctx); }
}

// ---------- guarded write ----------
function writeChecked(reg, content) {
  const now = exists(reg.file) ? fs.statSync(reg.file) : null;
  if ((reg.stat === null) !== (now === null) || (now && (now.mtimeMs !== reg.stat.mtimeMs || now.size !== reg.stat.size)))
    throw new Conflict(`${reg.name} changed on disk since it was read (someone wrote it without the lock)`);
  const tmp = path.join(path.dirname(reg.file), `.${path.basename(reg.file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, content);
  if (now) fs.chmodSync(tmp, now.mode & 0o777);
  fs.renameSync(tmp, reg.file);
  if (fs.readFileSync(reg.file, 'utf8') !== content) throw new Error(`${reg.name}: re-read after write does not match what was written`);
  reg.text = content; reg.stat = fs.statSync(reg.file); reg.p = parse(content);
}

// ---------- shared pieces ----------
function normStatus(s) {
  const v = String(s).replace(/️/g, '').trim();
  const m = MARKERS.find((k) => v === k || v.startsWith(k + ' '));
  if (!m) refuse(`status must open with one of: ${MARKERS.join(' · ')}`);
  if (m === '🚀 LIVE-UNVERIFIED' && v.slice(m.length).replace(/[\s—–:·-]/g, '').length < 3) refuse('🚀 LIVE-UNVERIFIED needs the user\'s reason after the marker');
  return cellText(v);
}
function parseId(id) { const m = /^([A-Z]+)-(\d+)$/.exec(id || ''); if (!m) refuse(`not an ID: "${id ?? ''}" (expected like T-12)`); return { prefix: m[1], num: Number(m[2]), key: keyOf(m[1], m[2]) }; }
function fileFor(ctx, prefix, override) {
  const f = override || ctx.cfg.idPrefixes[prefix];
  if (!f) refuse(`unknown prefix ${prefix}; clockwork.json idPrefixes has: ${Object.keys(ctx.cfg.idPrefixes).join(', ')}`);
  return f;
}
function bumpLastUpdated(lines, headerEnd) {
  for (let i = 0; i < headerEnd; i++) {
    if (/\*\*Last updated:\*\*\s*\d{4}-\d{2}-\d{2}/.test(lines[i])) { lines[i] = lines[i].replace(/(\*\*Last updated:\*\*\s*)\d{4}-\d{2}-\d{2}/, `$1${today()}`); return; }
  }
}
function budgetCheck(ctx, id, before, after) {
  const b = ctx.cfg.rowBudget, n = chars(after);
  if (n <= b) return;
  if (before !== null && chars(before) > b) { say(`WARN: ${id} row is ${n} chars (rowBudget ${b}); move detail to reports/${id}-<slug>.md and link it`); return; }
  refuse(`${id} row would be ${n} chars (rowBudget ${b}); put the detail in reports/${id}-<slug>.md and link it`);
}

function branchCheck(ctx, prefix, num, id, claim) {
  const site = path.resolve(ctx.root, ctx.cfg.siteDir || '.');
  let refs, wts;
  try {
    git(site, ['rev-parse', '--is-inside-work-tree']);
    refs = git(site, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']).split('\n');
    wts = git(site, ['worktree', 'list', '--porcelain']).split('\n');
  } catch { say(`NOTICE: git not available in ${site}; branch/worktree name check skipped`); return; }
  const names = new Set();
  for (const r of refs) { const m = /^refs\/(?:heads|remotes\/[^/]+)\/(.+)$/.exec(r); if (m) names.add(m[1]); }
  for (const l of wts) { if (l.startsWith('worktree ')) names.add(path.basename(l.slice(9))); if (l.startsWith('branch refs/heads/')) names.add(l.slice(18)); }
  // `claude -w <name>` makes branch worktree-<name> under .claude/worktrees/<name> (docs: code.claude.com/docs/en/worktrees)
  const re = new RegExp(`^(?:worktree-)?${prefix.toLowerCase()}0*${num}-`, 'i');
  const hits = [...names].filter((n) => re.test(n) && n !== claim && n !== `worktree-${claim}`);
  if (hits.length) refuse(`${id}: branch/worktree ${hits.join(', ')} already exists with no row. Its owner registers it, or re-run with --claim-branch <that name> to write its row`);
}

function insertRow(reg, sectionName, cells, id) {
  const { lines, sections } = reg.p;
  const sec = sections.find((s) => s.heading === sectionName.trim());
  if (!sec) refuse(`section "${sectionName}" not found in ${reg.name}; it has: ${sections.map((s) => s.heading).join(' / ') || 'no ## sections'}. Pass --section`);
  let tStart = -1, tEnd = -1;
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (lines[i].startsWith('|')) { if (i === 0 || !lines[i - 1].startsWith('|')) tStart = i; tEnd = i; }
  }
  let at, out;
  if (tStart >= 0) {
    const width = cellsOf(lines[tStart]).length;
    if (cells.length > width) refuse(`${id} row has ${cells.length} cells but the table in "${sectionName}" has ${width}; fewer --cells`);
    while (cells.length < width) cells.splice(cells.length - 1, 0, '');
    at = tEnd + 1; out = [`| ${cells.join(' | ')} |`];
  } else {
    const head = ['ID', 'Title', ...cells.slice(2, -1).map((_, i) => `Detail ${i + 1}`), 'Status'];
    at = sec.end; while (at > sec.start + 1 && lines[at - 1].trim() === '') at--;
    out = ['', `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, `| ${cells.join(' | ')} |`];
    if (at < lines.length) out.push('');
  }
  lines.splice(at, 0, ...out);
}

// ---------- subcommands ----------
function cmdMint(ctx, a) {
  const prefix = a._[1];
  if (!/^[A-Z]+$/.test(prefix || '')) refuse('usage: mint <PREFIX> --title "…"');
  if (!a.title || !a.title.trim()) refuse('--title is required');
  const name = fileFor(ctx, prefix, a.file);
  const status = normStatus(a.status || '⬜ OPEN');
  const opened = a.opened === 'none' ? null : !a.opened || a.opened === 'today' ? today() : /^\d{4}-\d{2}-\d{2}$/.test(a.opened) ? a.opened : refuse('--opened takes today, YYYY-MM-DD or none');
  const section = a.section || PREFIX_SECTION[prefix] || FILE_SECTION[path.basename(name)] || refuse(`no default section for ${name}; pass --section "## …"`);
  const extra = a.cells ? a.cells.split(/(?<!\\)\|/).map(cellText) : [];
  if (prefix === 'T' && status.startsWith('✅')) refuse('a task is minted open and closed later by a fresh verifier (status … "✅ VERIFIED <evidence>")');
  if (prefix === 'T' && (!extra[0] || !/^(preview|ship)\b/i.test(extra[1] || ''))) say('WARN: a T row needs --cells "closes when …|preview or ship|source" (closure criterion and deploy class); this one lacks them');
  return locked(ctx, () => {
    const live = readReg(ctx, name), arch = readReg(ctx, archiveOf(name), { mustExist: false });
    const ctrs = live.p.counters.filter((c) => c.prefix === prefix);
    if (!ctrs.length) refuse(`${name} header has no counter line for ${prefix} (format: > **ID counter — next free: \`${prefix}-1\`**)`);
    if (ctrs.length > 1) refuse(`${name} header has ${ctrs.length} counter lines for ${prefix}; keep exactly one`);
    if (ctrs[0].legacy) refuse(`${name} line ${ctrs[0].line + 1} holds the ${prefix} counter in the old format ("${live.p.lines[ctrs[0].line].trim().slice(0, 80)}"); mint writes only the current format. Onboarding converts it (/clockwork-onboard); by hand, make that line: > **ID counter — next free: \`${prefix}-${ctrs[0].digits}\`**`);
    const c = ctrs[0], id = `${prefix}-${c.digits}`, key = keyOf(prefix, c.num);
    const taken = [live, arch].filter((r) => r.p.rows.some((row) => row.keys.includes(key))).map((r) => r.name);
    if (taken.length) refuse(`${id} already has a row in ${taken.join(' + ')}; the counter is behind. Run check`);
    branchCheck(ctx, prefix, c.num, id, a['claim-branch']);
    const st = opened ? `${status} · opened ${opened}` : status;
    const cells = [id, cellText(a.title), ...extra, st];
    budgetCheck(ctx, id, null, `| ${cells.join(' | ')} |`);
    const lines = live.p.lines;
    const next = String(c.num + 1).padStart(c.digits.length, '0');
    lines[c.line] = lines[c.line].slice(0, c.at) + `next free: \`${prefix}-${next}\`` + lines[c.line].slice(c.at + c.raw.length);
    bumpLastUpdated(lines, live.p.headerEnd);
    insertRow(live, section, cells, id);
    writeChecked(live, lines.join('\n'));
    const rows = live.p.rows.filter((r) => r.key === key);
    const cc = live.p.counters.filter((x) => x.prefix === prefix);
    if (rows.length !== 1 || cc.length !== 1 || cc[0].num !== c.num + 1) throw new Error(`${name}: verify after write failed (rows for ${id}: ${rows.length})`);
    return id;
  });
}

function cmdNext(ctx, a) {
  const prefix = a._[1];
  if (!/^[A-Z]+$/.test(prefix || '')) refuse('usage: next <PREFIX>');
  const live = readReg(ctx, fileFor(ctx, prefix, a.file));
  const ctrs = live.p.counters.filter((c) => c.prefix === prefix);
  if (ctrs.length !== 1) refuse(`${live.name} header has ${ctrs.length} counter lines for ${prefix}; expected 1`);
  if (ctrs[0].legacy) say(`NOTICE: ${live.name} line ${ctrs[0].line + 1} holds this counter in the old format; mint refuses until it reads > **ID counter — next free: \`${prefix}-${ctrs[0].digits}\`**`);
  return `${prefix}-${ctrs[0].digits}`;
}

function findRow(ctx, a) {
  const id = parseId(a._[1]);
  const name = fileFor(ctx, id.prefix, a.file);
  const live = readReg(ctx, name);
  const any = live.p.rows.filter((r) => r.keys.includes(id.key)), rows = any.filter((r) => r.full);
  if (rows.length > 1) refuse(`${a._[1]} matches ${rows.length} rows in ${name} (lines ${rows.map((r) => r.line + 1).join(', ')}); fix the duplicate first: node "${path.join(ctx.root, '.claude', 'tools', 'registry.mjs')}" dedupe ${a._[1]}`);
  if (!rows.length) {
    if (any.length) refuse(`${a._[1]} in ${name} has only a pointer, archive stub, combined-key or "✖ VOID — duplicate of" row (line ${any[0].line + 1}); those are not edited`);
    const arch = readReg(ctx, archiveOf(name), { mustExist: false });
    refuse(arch.p.rows.some((r) => r.keys.includes(id.key)) ? `${a._[1]} is archived in ${arch.name}; archived rows are not edited` : `${a._[1]} has no row in ${name}`);
  }
  return { live, row: rows[0], id: rows[0].id };
}

function editStatus(ctx, a, change) {
  return locked(ctx, () => {
    const { live, row, id } = findRow(ctx, a);
    const cell = statusOf(row.text);
    if (!cell || cellsOf(row.text).length < 2) refuse(`${id} row has no status cell`);
    const lead = cell.text.match(/^\s*/)[0], trail = cell.text.match(/\s*$/)[0];
    const next = change(cell.text.trim());
    const line = row.text.replace(/\s+$/, '');
    const newLine = line.slice(0, cell.s) + lead + next + (trail || (cell.e < line.length ? ' ' : '')) + line.slice(cell.e);
    budgetCheck(ctx, id, row.text, newLine);
    live.p.lines[row.line] = newLine;
    writeChecked(live, live.p.lines.join('\n'));
    const after = live.p.rows.filter((r) => r.key === row.key && r.full);
    if (after.length !== 1 || after[0].text !== newLine) throw new Error(`${live.name}: verify after write failed for ${id}`);
    return id;
  });
}
function cmdAppend(ctx, a) {
  // `append T-3 "…"` without --text: sessions write it that way often enough that refusing only costs a retry.
  const text = a.text ?? a._.slice(2).join(' ');
  if (!text || !text.trim()) refuse('usage: append <ID> --text "…"');
  return editStatus(ctx, a, (s) => `${s} · ${cellText(text)}`);
}
// ✅ VERIFIED evidence must exist, not only look right: a report file on disk (under the project root or registryDir),
// a commit git resolves, or a URL (not checkable offline). Outside a git repository a sha is taken as written.
// Who produced the evidence cannot be told from here: "the builder never closes its own task" is hard rule 8.
function evidenceFound(ctx, text) {
  if (/https?:\/\/\S+/.test(text)) return { ok: true };
  const paths = [...text.matchAll(/[\w.-]+\/[\w./-]+\.(?:md|json|png|jpe?g|txt|log|html)\b/gi)].map((m) => m[0]);
  const shas = [...paths.reduce((t, p) => t.split(p).join(' '), text).matchAll(/\b[0-9a-f]{7,40}\b/gi)].map((m) => m[0]);
  const bases = [ctx.root, path.join(ctx.root, ctx.cfg.registryDir), process.cwd()];
  if (paths.some((p) => bases.some((b) => exists(path.resolve(b, p))))) return { ok: true };
  let repo = true; try { git(ctx.root, ['rev-parse', '--git-dir']); } catch { repo = false; }
  if (shas.length && !repo) return { ok: true };
  for (const x of shas) { try { git(ctx.root, ['cat-file', '-e', `${x}^{commit}`]); return { ok: true }; } catch { /* not a commit here */ } }
  return { ok: false, tried: [...paths, ...shas] };
}
function cmdStatus(ctx, a) {
  const next = normStatus(a._[2] || '');
  const id = parseId(a._[1]);
  const gated = next.startsWith('✅') && !!ctx.cfg.idPrefixes.T && (a.file || ctx.cfg.idPrefixes[id.prefix]) === ctx.cfg.idPrefixes.T;
  // The evidence is judged in THIS call's text, not the row: every BUILT row already carries the builder's own sha.
  if (gated && !EVIDENCE_RE.test(next.slice('✅ VERIFIED'.length))) refuse(`✅ VERIFIED needs the fresh verifier's evidence after the marker: a report path, commit sha or URL. Closing visual work after the user's look: repeat the verifier's report, e.g. status ${a._[1]} "✅ VERIFIED the user's look ${today()} · verifier PASS reports/${a._[1]}-verify-<sha7>.md"`);
  return editStatus(ctx, a, (s) => {
    const cls = classify(s);
    if (gated && !['BUILT', 'VERIFYING', 'VERIFIED'].includes(cls)) refuse(`${a._[1]} is ${cls}, not 🔧 BUILT or 🔎 VERIFYING: the builder sets BUILT, then a fresh verifier closes it`);
    const ev = gated ? evidenceFound(ctx, next.slice('✅ VERIFIED'.length)) : { ok: true };
    if (!ev.ok) refuse(`✅ VERIFIED evidence not found: ${ev.tried.join(', ')} (no such file under ${ctx.root} or ${ctx.cfg.registryDir}/, and no commit with that sha). Give the verifier's real report (registry.mjs report copies it into ${ctx.cfg.registryDir}/reports/) or the verified commit sha. This checks that the evidence exists, not who made it: the builder never closes its own task (hard rule 8).`);
    const m = LEAD_RE.exec(s); return m ? next + s.slice(m[0].length) : `${next} · ${s}`;
  });
}

// One row per ID. Identical copies are dropped. Rows that differ are one ID used twice: --keep <line> keeps that
// row and gives each other one the next free ID in the same write (a note in its status says so), so no text is lost.
// Safe for several blocked sessions at once: under the lock, the second run finds one row and does nothing.
function cmdDedupe(ctx, a) {
  const id = parseId(a._[1]);
  const name = fileFor(ctx, id.prefix, a.file);
  return locked(ctx, () => {
    const live = readReg(ctx, name), arch = readReg(ctx, archiveOf(name), { mustExist: false });
    const rows = live.p.rows.filter((r) => r.key === id.key && r.full); // pointer and VOID-duplicate rows are not copies
    if (rows.length < 2) return `dedupe ${a._[1]}: ${rows.length} row in ${name}, nothing to fix`;
    const at = rows.map((r) => r.line + 1).join(', ');
    const same = rows.every((r) => r.text.trim() === rows[0].text.trim());
    let keep = rows[0];
    if (a.keep !== undefined) keep = rows.find((r) => r.line + 1 === Number(a.keep)) || refuse(`--keep ${a.keep} is not one of the ${a._[1]} rows (lines ${at})`);
    else if (!same) refuse(`${a._[1]} has ${rows.length} different rows in ${name} (lines ${at}). Keep the real one: dedupe ${a._[1]} --keep <line>; the others get new IDs`);
    const lines = live.p.lines, drop = [], moved = [];
    const ctrs = live.p.counters.filter((c) => c.prefix === id.prefix);
    const taken = new Set([...live.p.rows, ...arch.p.rows].flatMap((r) => r.keys));
    let next = ctrs.length === 1 ? ctrs[0].num : null;
    for (const r of rows.filter((x) => x !== keep)) {
      if (r.text.trim() === keep.text.trim()) { drop.push(r.line); continue; }
      if (next === null) refuse(`${name} needs exactly one counter line for ${id.prefix} to renumber a duplicate`);
      while (taken.has(keyOf(id.prefix, next))) next++;
      const newId = `${id.prefix}-${String(next).padStart(ctrs[0].digits.length, '0')}`; taken.add(keyOf(id.prefix, next)); next++;
      let t = r.text.replace(/\s+$/, '').replace(/^(\|\s*[*~_]*)[A-Z]+-\d+/, `$1${newId}`);
      const cell = statusOf(t);
      t = t.slice(0, cell.e).replace(/\s+$/, '') + ` · renumbered from ${r.id} (duplicate ID) ${today()} ` + t.slice(cell.e);
      budgetCheck(ctx, newId, r.text, t);
      lines[r.line] = t; moved.push(`${r.id} line ${r.line + 1} → ${newId}`);
    }
    if (moved.length && ctrs[0].legacy) refuse(`${name} holds the ${id.prefix} counter in the old format (line ${ctrs[0].line + 1}); convert it to > **ID counter — next free: \`${id.prefix}-${ctrs[0].digits}\`** first`);
    if (moved.length) { const c = ctrs[0]; lines[c.line] = lines[c.line].slice(0, c.at) + `next free: \`${id.prefix}-${String(next).padStart(c.digits.length, '0')}\`` + lines[c.line].slice(c.at + c.raw.length); }
    for (const i of drop.sort((x, y) => y - x)) lines.splice(i, 1);
    bumpLastUpdated(lines, live.p.headerEnd);
    writeChecked(live, lines.join('\n'));
    if (live.p.rows.filter((r) => r.key === id.key && r.full).length !== 1) throw new Error(`${name}: verify after dedupe failed for ${a._[1]}`);
    if (moved.length) say(`renumbered: ${moved.join('; ')}`);
    return `dedupe ${a._[1]}: kept line ${keep.line + 1}, dropped ${drop.length} identical, renumbered ${moved.length}`;
  });
}

function registryFiles(ctx) {
  const names = [...new Set([...REGISTRIES, ...Object.values(ctx.cfg.idPrefixes)])];
  return [...new Set(names.flatMap((n) => [n, archiveOf(n)]))].filter((n) => exists(regPath(ctx, n)));
}
function doBackup(ctx, slug, { suffix = false } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(slug || '')) refuse('--reason takes a slug: lowercase letters, digits, dashes');
  const off = registryFiles(ctx).map((f) => regPath(ctx, f)).filter((p) => offloadState(p) === 'offloaded');
  if (off.length) refuse(`no backup made: ${off.map(offloadNote).join('; ')}`);
  const base = path.join(ctx.root, ctx.cfg.backupDir);
  fs.mkdirSync(base, { recursive: true });
  let dir = path.join(base, `${stampNow()}-${slug}`);
  for (let i = 2; ; i++) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!suffix || i > 20) refuse(`backup folder ${dir} already exists; backups never reuse a folder. Use another --reason or wait a minute`);
      dir = path.join(base, `${stampNow()}-${slug}-${i}`);
    }
  }
  const files = registryFiles(ctx), sums = [];
  for (const f of files) {
    const buf = fs.readFileSync(regPath(ctx, f)), dest = path.join(dir, path.basename(f));
    fs.writeFileSync(dest, buf);
    const h = sha(buf);
    if (sha(fs.readFileSync(dest)) !== h) throw new Error(`backup copy of ${f} does not match the original`);
    sums.push(`${h}  ${path.basename(f)}`);
  }
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.join('\n') + '\n');
  say(`backup: ${files.length} files → ${dir}`);
  return dir;
}
function cmdBackup(ctx, a) { return locked(ctx, () => path.relative(ctx.root, doBackup(ctx, a.reason))); }

// Every ID present before (as a row or any mention, e.g. counter lines) must be present after.
function census(texts) {
  const rows = new Set(), refs = new Set();
  for (const t of texts) {
    if (!t) continue;
    for (const r of parse(t).rows) for (const k of r.keys) rows.add(k);
    for (const m of t.matchAll(/\b([A-Z]+)-(\d+)\b/g)) refs.add(m[0]);
  }
  return { rows, refs };
}
function gate(before, after, moved, liveAfter, archAfter) {
  const b = census(before), x = census(after), bad = [];
  const lostRows = [...b.rows].filter((k) => !x.rows.has(k)), lostRefs = [...b.refs].filter((k) => !x.refs.has(k));
  if (lostRows.length) bad.push(`rows lost: ${lostRows.slice(0, 20).join(', ')}`);
  if (lostRefs.length) bad.push(`ID mentions lost: ${lostRefs.slice(0, 20).join(', ')}`);
  const archLines = new Set((archAfter || '').split('\n')), liveLines = new Set((liveAfter || '').split('\n'));
  for (const m of moved) {
    if (!archLines.has(m.text)) bad.push(`${m.id} row not found verbatim in the archive`);
    if (!liveLines.has(m.stub)) bad.push(`${m.id} stub missing from the live file`);
  }
  if (parse(before[0]).rows.length !== parse(liveAfter || '').rows.length) bad.push('live row count changed');
  return bad;
}

function cmdRotate(ctx, a) {
  const name = a._[1];
  if (!name) refuse('usage: rotate <FILE> [--dry-run] [--keep-recent 20]');
  const keep = a['keep-recent'] === undefined ? 20 : Number(a['keep-recent']);
  if (!Number.isInteger(keep) || keep < 0) refuse('--keep-recent takes a whole number');
  // CLOCKWORK_REGISTRY_FAULT is for the kit's own tests only: it plants a lossy write to prove the gate + restore.
  const archName = archiveOf(name), fault = process.env.CLOCKWORK_REGISTRY_FAULT || '';
  return locked(ctx, () => {
    const live = readReg(ctx, name), arch = readReg(ctx, archName, { mustExist: false });
    const archKeys = new Set(arch.p.rows.map((r) => r.key));
    const recent = new Set();
    for (const pre of new Set(live.p.rows.map((r) => r.prefix))) {
      [...new Set(live.p.rows.filter((r) => r.prefix === pre).map((r) => r.num))].sort((x, y) => y - x).slice(0, keep).forEach((n) => recent.add(keyOf(pre, n)));
    }
    const moved = [], held = [];
    for (const r of live.p.rows) {
      const st = statusOf(r.text)?.text || '', cls = classify(st);
      if (cls !== 'VERIFIED' && cls !== 'VOID') continue;
      if (r.combined || recent.has(r.key) || archKeys.has(r.key) || isStub(r.text) || cellsOf(r.text).length < 3) continue;
      if (LIVE_SIGNAL.test(st) || NAMED_LOOK.test(st)) { held.push(r.id); continue; }
      moved.push({ ...r, stub: `| ${r.id} | → archived ${today()} (${path.basename(archName)}) | ${cls === 'VOID' ? '✖ VOID' : '✅ VERIFIED'} |` });
    }
    if (held.length) say(`held back (✅ but status still names open work): ${held.join(', ')}`);
    say(`${name}: ${live.p.rows.length} rows · ${moved.length} to archive · newest ${keep} per prefix kept`);
    if (!moved.length) return 'rotate 0 rows';
    say(`to archive: ${moved.map((m) => m.id).join(', ')}`);
    const newLiveLines = [...live.p.lines];
    for (const m of moved) newLiveLines[m.line] = m.stub;
    const byTable = new Map();
    for (const m of moved) {
      const hdr = m.table >= 0 && m.table + 1 < m.line ? [live.p.lines[m.table], live.p.lines[m.table + 1]] : ['| ID | Row | Status |', '|---|---|---|'];
      const k = hdr.join('\n'); if (!byTable.has(k)) byTable.set(k, []); byTable.get(k).push(m.text);
    }
    let block = `\n## Rotated ${today()} from ${path.basename(name)}\n`;
    for (const [hdr, rows] of byTable) block += `\n${hdr}\n${rows.join('\n')}\n`;
    const archBase = arch.text ?? `# ${path.basename(archName, '.md')}\n\nRows moved out of ${path.basename(name)} by registry.mjs rotate, verbatim. Append-only.\n`;
    let newArch = archBase.replace(/\n*$/, '\n') + block;
    let newLive = newLiveLines.join('\n');
    if (fault === 'rotate-pre-gate') newArch = newArch.replace(moved[0].text + '\n', '');
    const pre = gate([live.text, arch.text], [newLive, newArch], moved, newLive, newArch);
    if (pre.length) refuse(`integrity gate failed; nothing written: ${pre.join('; ')}`);
    if (a['dry-run']) return `rotate dry-run ${moved.length} rows`;
    const backup = doBackup(ctx, `rotate-${path.basename(name, '.md').toLowerCase()}`, { suffix: true });
    heartbeat(ctx);
    const orig = { live: live.text, arch: arch.text };
    writeChecked(arch, newArch);
    writeChecked(live, newLive);
    if (fault === 'rotate-post-write') fs.writeFileSync(arch.file, newArch.replace(moved[0].text + '\n', ''));
    const reLive = fs.readFileSync(live.file, 'utf8'), reArch = fs.readFileSync(arch.file, 'utf8');
    const post = gate([orig.live, orig.arch], [reLive, reArch], moved, reLive, reArch);
    if (reLive !== newLive || reArch !== newArch) post.push('re-read differs from what was written');
    if (post.length) {
      fs.writeFileSync(live.file, orig.live);
      if (orig.arch === null) fs.rmSync(arch.file, { force: true }); else fs.writeFileSync(arch.file, orig.arch);
      const ok = sha(fs.readFileSync(live.file)) === sha(orig.live) && (orig.arch === null ? !exists(arch.file) : sha(fs.readFileSync(arch.file)) === sha(orig.arch));
      if (!ok) throw new Error(`restore after failed rotation did not match the originals; copy them back from ${backup}`);
      say(`RESTORED ${name} and ${archName} byte-identical to before (backup also at ${backup})`);
      refuse(`integrity gate failed after writing; originals restored: ${post.join('; ')}`);
    }
    return `rotate ${moved.length} rows`;
  });
}

function cmdCheck(ctx) {
  return locked(ctx, () => {
    const errors = [], warns = [], parsed = new Map();
    const skipped = registryFiles(ctx).filter((f) => offloadState(regPath(ctx, f)) === 'offloaded');
    const files = registryFiles(ctx).filter((f) => !skipped.includes(f));
    for (const f of files) parsed.set(f, readReg(ctx, f));
    const maxOf = new Map();
    for (const r of [...parsed.values()].flatMap((x) => x.p.rows)) for (const k of r.keys) { const [pre, n] = k.split('-'); maxOf.set(pre, Math.max(maxOf.get(pre) ?? 0, Number(n))); }
    for (const [f, reg] of parsed) {
      const rows = reg.p.rows, byKey = new Map(), cls = {};
      // The row rule: pointer/stub and "✖ VOID — duplicate of" rows keep an ID taken but are not second rows.
      for (const r of rows) { if (r.full) byKey.set(r.key, [...(byKey.get(r.key) || []), r.line + 1]); const c = isPointer(r.text) ? 'pointer' : isVoidDuplicate(r.text) ? 'void-duplicate' : classify(statusOf(r.text)?.text || ''); cls[c] = (cls[c] || 0) + 1; }
      const dup = [...byKey].filter(([, at]) => at.length > 1);
      // A live duplicate breaks append/status (anchor must match once): ERROR. An archive duplicate is history: WARN.
      if (/-ARCHIVE\.md$/i.test(f)) { if (dup.length) warns.push(`${f}: ${dup.length} IDs have more than one archived row: ${dup.slice(0, 10).map(([k]) => k).join(', ')}${dup.length > 10 ? ' …' : ''}`); }
      else for (const [k, at] of dup) errors.push(`${f}: ${k} has ${at.length} rows (lines ${at.join(', ')}); IDs are never reused`);
      const header = Buffer.byteLength(reg.p.lines.slice(0, reg.p.headerEnd).join('\n'));
      if (header > ctx.cfg.headerBudget) warns.push(`${f}: header is ${header} bytes (headerBudget ${ctx.cfg.headerBudget}); notes belong in rows or reports`);
      const big = rows.filter((r) => chars(r.text) > ctx.cfg.rowBudget);
      if (big.length) warns.push(`${f}: ${big.length} rows over rowBudget ${ctx.cfg.rowBudget} chars: ${big.slice(0, 10).map((r) => r.id).join(', ')}${big.length > 10 ? ' …' : ''}`);
      say(`${f}: ${rows.length} rows${rows.length ? ` (${Object.entries(cls).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
      if (/-ARCHIVE\.md$/i.test(f)) continue;
      for (const [pre, pf] of Object.entries(ctx.cfg.idPrefixes)) {
        if (pf !== f) continue;
        const c = reg.p.counters.filter((x) => x.prefix === pre), max = maxOf.get(pre);
        if (c.length > 1) errors.push(`${f}: ${c.length} counter lines for ${pre}; keep one`);
        else if (!c.length) { if (max !== undefined) errors.push(`${f}: ${pre} rows exist but the header has no "next free" counter for ${pre}`); }
        else {
          say(`  counter ${pre}: next free ${pre}-${c[0].digits}${c[0].legacy ? ' (old format)' : ''} · highest row ${max === undefined ? 'none' : `${pre}-${max}`}`);
          if (c[0].legacy) warns.push(`${f}: line ${c[0].line + 1} holds the ${pre} counter in the old format; mint refuses until it reads > **ID counter — next free: \`${pre}-${c[0].digits}\`**`);
          if (max !== undefined && c[0].num <= max) errors.push(`${f}: counter says next free ${pre}-${c[0].digits} but ${pre}-${max} already has a row`);
        }
      }
    }
    const dir = path.join(ctx.root, ctx.cfg.registryDir);
    if (exists(dir)) for (const n of fs.readdirSync(dir)) if (/ \d+\.md$/.test(n) && REGISTRIES.includes(n.replace(/ \d+\.md$/, '.md'))) warns.push(`${ctx.cfg.registryDir}/${n} looks like an iCloud conflict copy; compare and remove it by hand`);
    for (const w of warns) say(`WARN: ${w}`);
    for (const e of errors) say(`ERROR: ${e}`);
    for (const f of skipped) say(offloadNote(regPath(ctx, f)));
    say(`files read: ${files.join(', ') || 'none'} · not checked here: branches without rows, aging, cross-registry links (the doctor does those)`);
    if (errors.length) refuse(`check found ${errors.length} error(s)${skipped.length ? `; ${skipped.length} offloaded file(s) not checked` : ''}`);
    if (skipped.length) refuse(`check incomplete: ${skipped.length} offloaded file(s) not checked (${skipped.join(', ')}); no errors in the rest`);
    return `check ${files.length} files`;
  });
}

// ---------- read-only views (a worktree's registry copy is a stale snapshot; these read the main copy) ----------
function cmdShow(ctx, a) {
  const id = parseId(a._[1]);
  const name = fileFor(ctx, id.prefix, a.file);
  for (const f of [name, archiveOf(name)]) {
    const r = readReg(ctx, f, { mustExist: f === name });
    const rows = r.p.rows.filter((x) => x.keys.includes(id.key));
    if (rows.length) { for (const x of rows) say(`${f}:${x.line + 1} ${x.text}`); return rows[0].id; }
  }
  refuse(`${a._[1]} has no row in ${name} or its archive`);
}
function cmdList(ctx, a) {
  const prefixes = a._[1] ? [a._[1]] : Object.keys(ctx.cfg.idPrefixes);
  const want = a.status ? String(a.status).toUpperCase() : null;
  let n = 0;
  for (const prefix of prefixes) {
    const r = readReg(ctx, fileFor(ctx, prefix, a.file));
    for (const x of r.p.rows) {
      if (x.prefix !== prefix || isStub(x.text)) continue;
      if (want && classify(statusOf(x.text)?.text || '') !== want) continue;
      say(x.text); n++;
    }
  }
  return `list ${n}`;
}

// ---------- lines in files without IDs (FACTS, MEETING-LOG, DOC-MAP, Standing Obligations) ----------
function cmdLine(ctx, a) {
  const name = a._[1];
  if (!name || !a.section || !a.text) refuse('usage: line <FILE> --section "## …" --text "…" [--replace "<exact old line>"]');
  const text = String(a.text).replace(/\r/g, '');
  if (text.split('\n').some((l) => (rowIdsOf(l) || []).some((x) => ctx.cfg.idPrefixes[x.prefix]))) refuse('rows with IDs are written with mint/append/status, not line');
  return locked(ctx, () => {
    const reg = readReg(ctx, name);
    const lines = reg.p.lines;
    const sec = reg.p.sections.find((x) => x.heading === a.section.trim());
    if (!sec) refuse(`section "${a.section}" not found in ${name}; it has: ${reg.p.sections.map((x) => x.heading).join(' / ') || 'none'}`);
    if (a.replace !== undefined) {
      const at = lines.map((l, i) => (l === a.replace && i > sec.start && i < sec.end ? i : -1)).filter((i) => i >= 0);
      if (at.length !== 1) refuse(`--replace text matches ${at.length} lines in ${a.section} of ${name}; it must match exactly one, copied exactly`);
      lines.splice(at[0], 1, ...text.split('\n'));
    } else {
      // A section that holds a table (FACTS, Standing Obligations) takes table rows only, added at the end of
      // its last table, so a later row never lands outside the table after a stray bullet.
      let tEnd = -1;
      for (let i = sec.start + 1; i < sec.end; i++) if (lines[i].startsWith('|')) tEnd = i;
      const rowText = text.split('\n').every((l) => l.startsWith('|'));
      if (tEnd >= 0 && !rowText) refuse(`"${a.section}" in ${name} is a table: write a table row "| … |" (fill a blank row with --replace "<that exact row>")`);
      let at = sec.end; while (at > sec.start + 1 && lines[at - 1].trim() === '') at--;
      lines.splice(tEnd >= 0 ? tEnd + 1 : at, 0, ...text.split('\n'));
    }
    bumpLastUpdated(lines, reg.p.headerEnd);
    writeChecked(reg, lines.join('\n'));
    if (!reg.text.includes(text)) throw new Error(`${name}: verify after write failed`);
    return `line ${name}`;
  });
}

// ---------- reports (handovers, long row detail) land next to the registries in the main copy ----------
function cmdReport(ctx, a) {
  const name = a._[1];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name || '') || !a.from) refuse('usage: report <NAME.md> --from <file>');
  const src = path.resolve(a.from);
  if (!exists(src)) refuse(`${a.from} not found`);
  const dir = path.join(ctx.root, ctx.cfg.registryDir, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  const buf = fs.readFileSync(mustBeLocal(src));
  try { fs.writeFileSync(dest, buf, { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') refuse(`${path.relative(ctx.root, dest)} already exists; reports are never overwritten, pick another name`); throw e; }
  if (sha(fs.readFileSync(dest)) !== sha(buf)) throw new Error(`${dest} does not match ${src} after copying`);
  return path.relative(ctx.root, dest);
}

// ---------- claims: which session holds which files (read by session-start and guard-edit) ----------
// Every claimed path is stored relative to the worktree it is in, so "src/a.ts", "./src/a.ts", "<main>/src/a.ts"
// and "<main>/.claude/worktrees/w2/src/a.ts" are one file. macOS folders ignore case, so keys compare lowercased
// there. A folder or a glob (* ?) covers everything under or matching it.
export const claimDir = (root) => path.join(root, '.claude', '.state', 'claims');
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
const GLOB = /[*?]/;
export function liveClaims(dir, now = Date.now()) {
  const out = [];
  for (const f of exists(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    if (offloadState(path.join(dir, f)) === 'offloaded') continue; // never read (it could wait forever): like an unreadable claim
    try { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (Date.parse(c.expires) > now && Array.isArray(c.files)) out.push(c); } catch { /* unreadable claim: ignored */ }
  }
  return out;
}
// Real path of the nearest part that exists, plus the rest (a new file has no real path yet).
function realish(p) {
  let head = path.resolve(p); const rest = [];
  while (!exists(head) && path.dirname(head) !== head) { rest.unshift(path.basename(head)); head = path.dirname(head); }
  return path.join(real(head), ...rest);
}
export function worktreeRoots(root, cfg = {}) {
  const roots = new Set([real(root)]);
  for (const d of new Set([root, path.resolve(root, cfg.siteDir || '.')])) {
    try { for (const l of git(d, ['worktree', 'list', '--porcelain']).split('\n')) if (l.startsWith('worktree ')) roots.add(real(l.slice(9))); } catch { /* not git */ }
  }
  return [...roots].sort((x, y) => y.length - x.length); // longest first: .claude/worktrees/w2 before its main checkout
}
// Returns the stored form (worktree-relative, forward slashes) or null when the path is outside the project.
export function claimPath(p, roots, cwd = process.cwd()) {
  const abs = realish(path.resolve(cwd, String(p).trim()));
  const top = roots.find((r) => abs === r || abs.startsWith(r + path.sep));
  if (!top) return null;
  return path.relative(top, abs).split(path.sep).join('/').replace(/\/+$/, '') || '.';
}
const keyOfPath = (p) => (process.platform === 'darwin' ? p.toLowerCase() : p);
const globRe = (g) => new RegExp(`^${g.split(/(\*\*\/?|\*|\?)/).map((t) => (t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
export function overlaps(x, y) {
  const a = keyOfPath(x), b = keyOfPath(y);
  if (a === b || a === '.' || b === '.' || a.startsWith(b + '/') || b.startsWith(a + '/')) return true;
  const ga = GLOB.test(a), gb = GLOB.test(b);
  if (!ga && !gb) return false;
  const fixed = (g) => g.slice(0, g.search(GLOB));
  if (ga && gb) { const fa = fixed(a), fb = fixed(b); return fa.startsWith(fb) || fb.startsWith(fa); } // two globs: same fixed stem may overlap
  const [g, pl] = ga ? [a, b] : [b, a];
  return globRe(g).test(pl) || fixed(g).startsWith(pl + '/') || (g.includes('**') && (pl + '/').startsWith(fixed(g)));
}
// Live claims of OTHER sessions that cover this file. "Other" = a different session id, or (for a claim written
// without one) a different worktree.
export function claimsHolding(root, cfg, file, { sessionId = '', worktree = '' } = {}) {
  const roots = worktreeRoots(root, cfg);
  const key = claimPath(file, roots);
  if (!key) return [];
  const mine = (c) => (c.sessionId ? c.sessionId === sessionId : !!c.worktree && !!worktree && real(c.worktree) === real(worktree));
  return liveClaims(claimDir(root)).filter((c) => !mine(c)).map((c) => ({ ...c, hit: c.files.filter((f) => overlaps(f, key)) })).filter((c) => c.hit.length);
}
function cmdClaim(ctx, a) {
  if (!a.session || !a.files) refuse('usage: claim --session <name> --files "path,path" [--ids T-3] [--branch b] [--until "…"] [--hours 12]');
  const roots = worktreeRoots(ctx.root, ctx.cfg);
  const raw = a.files.split(',').map((x) => x.trim()).filter(Boolean);
  const files = [...new Set(raw.map((f) => claimPath(f, roots) ?? refuse(`${f} is outside this project (${roots.join(', ')})`)))];
  const hours = a.hours === undefined ? 12 : Number(a.hours);
  if (!(hours > 0 && hours <= 72)) refuse('--hours takes a number above 0, at most 72');
  let worktree = '';
  try { worktree = real(git(process.cwd(), ['rev-parse', '--show-toplevel'])); } catch { /* not git */ }
  return locked(ctx, () => {
    const dir = claimDir(ctx.root); fs.mkdirSync(dir, { recursive: true });
    const clash = liveClaims(dir).filter((c) => c.session !== a.session)
      .flatMap((c) => c.files.flatMap((held) => files.filter((f) => overlaps(f, held)).map((f) => `${f} (held by ${c.session}${held === f ? '' : ` as ${held}`})`)));
    if (clash.length) refuse(`already claimed: ${clash.join(', ')}. Message that session; never edit a file another session holds`);
    // A second claim by the same session ADDS to its first one (AGENTS.md: re-send when anything changes); dropping
    // files silently would let a peer take them. --replace-claim drops the earlier files and names them.
    const file = path.join(dir, `${safeName(a.session)}.json`);
    const prev = liveClaims(dir).find((x) => x.session === a.session);
    const ids = a.ids ? a.ids.split(',').map((x) => x.trim()).filter(Boolean) : [];
    const keepOld = prev && !a['replace-claim'];
    const all = keepOld ? [...new Set([...prev.files, ...files])] : files;
    const released = prev && a['replace-claim'] ? prev.files.filter((f) => !files.includes(f)) : [];
    const c = { session: a.session, sessionId: process.env.CLAUDE_CODE_SESSION_ID || prev?.sessionId || '', worktree, files: all,
      ids: keepOld ? [...new Set([...(prev.ids || []), ...ids])] : ids, branch: a.branch || (keepOld ? prev.branch : '') || '', until: a.until || (keepOld ? prev.until : '') || '',
      since: keepOld ? prev.since : new Date().toISOString(), expires: new Date(Date.now() + hours * 3600e3).toISOString() };
    fs.writeFileSync(file, JSON.stringify(c, null, 1));
    if (keepOld) say(`kept from your earlier claim: ${prev.files.filter((f) => !files.includes(f)).join(', ') || 'nothing else'}`);
    if (released.length) say(`RELEASED (no longer claimed by ${a.session}): ${released.join(', ')}`);
    say(`CLAIM ${c.session} · branch ${c.branch || '-'} · IDs ${c.ids.join(',') || '-'} · files: ${all.join(', ')} · until ${c.until || c.expires}`);
    return `claim ${all.length} file(s)`;
  });
}
function cmdRelease(ctx, a) {
  if (!a.session) refuse('usage: release --session <name>');
  const p = path.join(claimDir(ctx.root), `${safeName(a.session)}.json`);
  if (!exists(p)) refuse(`no claim for ${a.session}`);
  fs.rmSync(p);
  return `release ${a.session}`;
}
function cmdClaims(ctx) {
  const all = liveClaims(claimDir(ctx.root));
  for (const c of all) say(`${c.session} · ${c.branch || '-'} · IDs ${c.ids.join(',') || '-'} · files: ${c.files.join(', ')} · until ${c.until || c.expires}`);
  return `claims ${all.length}`;
}

// ---------- main ----------
const COMMANDS = { mint: cmdMint, next: cmdNext, append: cmdAppend, status: cmdStatus, backup: cmdBackup, rotate: cmdRotate, check: cmdCheck,
  show: cmdShow, list: cmdList, line: cmdLine, report: cmdReport, claim: cmdClaim, release: cmdRelease, claims: cmdClaims, dedupe: cmdDedupe };
function main() {
  const ctx = { lock: null };
  process.on('exit', () => { try { releaseLock(ctx); } catch {} });
  try {
    const a = parseArgs(process.argv.slice(2));
    const fn = COMMANDS[a._[0]];
    if (!fn) refuse(`usage: registry.mjs ${Object.keys(COMMANDS).join('|')} … (see the top of this file)`);
    ctx.root = resolveRoot(); ctx.cfg = loadConfig(ctx.root);
    say(`OK ${fn(ctx, a)}`);
    process.exitCode = 0;
  } catch (e) {
    if (e instanceof Refusal || e instanceof Conflict) { say(`ERR ${e.message}`); process.exitCode = 1; }
    else { console.error(e?.stack || e); say(`ERR crash: ${e?.message || e}`); process.exitCode = 2; }
  }
}
// Run only as a command; guard-edit imports the claim helpers above without running anything.
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
