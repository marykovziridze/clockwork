#!/usr/bin/env node
// clockwork-doctor 2.0 — managed by Clockwork. Per-project settings live in .claude/clockwork.json, never here.
// ERROR = a fact that is wrong (kept ~zero false positives, so the Stop hook never becomes noise).
// WARN  = worth a look. Anything that could not be checked is printed under NOT CHECKED, never skipped silently.
//
// Modes
//   --report          every finding + files read + row counts. Exit 0 clean · 1 ERROR found · 2 crashed.
//   --summary         at most 12 lines, for the session-start hook. Same exit codes.
//   --json            with --report: machine-readable findings (for tools and tests).
//   --write-baseline  [--session <id>] store this session's starting findings for Stop to compare against.
//   (no flag)         Stop hook, JSON on stdin. Blocks only on ERRORs that are new this session (decision D4).
// Options: --root <dir>. Env: CLAUDE_PROJECT_DIR, CLOCKWORK_ROOT, CLOCKWORK_CALLER_DIR (the folder the session works in,
// set by session-start so a worktree session gets worktree advice), CLOCKWORK_TODAY=YYYY-MM-DD and
// CLOCKWORK_GIT_TIMEOUT_MS (tests only; default 8000).
//
// Hook format verified in https://code.claude.com/docs/en/hooks.md (read 2026-09-30, CLI 2.1.285):
//   Stop stdin has session_id, cwd, stop_hook_active. Stdout {"decision":"block","reason":…} keeps Claude
//   working; {"systemMessage":…} shows the user a warning. JSON is read on exit 0; exit 1 never blocks.
//   CLAUDE_PROJECT_DIR stays at the launch dir when Claude enters a worktree; stdin "cwd" follows Claude.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, basename, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// THE row rule lives in registry.mjs (next to this hook, in .claude/tools/): one parser, so check, mint, dedupe and
// the doctor always agree on which lines are rows (combined keys, emphasis, escaped pipes). So does the kit's one
// "is this file offloaded by iCloud" check (offloadState): an offloaded file is never read, since that read can wait
// forever. registry.mjs itself is loaded only if it is on this Mac; if not, the same rule (size but no blocks) inline.
let ROWS = null, ROWS_ERR = '';
const REG_TOOL = new URL('../tools/registry.mjs', import.meta.url);
const bareOffload = (p) => { try { const s = statSync(p); return s.isFile() && s.size > 0 && s.blocks === 0 ? 'offloaded' : 'local'; } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable'; } };
if (bareOffload(fileURLToPath(REG_TOOL)) === 'offloaded') ROWS_ERR = `${fileURLToPath(REG_TOOL)} is offloaded by iCloud (open it in Finder or run \`brctl download "${fileURLToPath(REG_TOOL)}"\`)`;
else try { ROWS = await import(REG_TOOL.href); } catch (e) { ROWS_ERR = e && e.message; }
const offloadState = ROWS?.offloadState || bareOffload;
const offloadNote = ROWS?.offloadNote || ((p) => `not checked: ${p} is offloaded by iCloud — open it in Finder or run \`brctl download "${p}"\`, then re-run`);

const VERSION = '2.3.2'; // = the kit's VERSION file (test/installer.test.mjs keeps them equal)
// Documented defaults (CONTRACT §4). clockwork.json overrides any top-level key; agingDays merges per key.
const DEFAULTS = {
  registryDir: '.claude', siteDir: '.',
  idPrefixes: { T: 'TASKS.md', C: 'CLIENT.md', CD: 'CLIENT.md', A: 'OPEN-ASKS.md', Q: 'APPROVAL-QUEUE.md' },
  sizeBudgets: {
    'AGENTS.md': { warn: 7000, error: 8192 }, 'CLAUDE.md': { warn: 1800, error: 2048 },
    '.claude/rules/design-system.md': { warn: 20480, error: 28672 },
    'TASKS.md': { warn: 160000, error: 400000 }, 'CLIENT.md': { warn: 120000, error: 300000 },
    'FACTS.md': { warn: 20000, error: 40000 }, 'DOC-MAP.md': { warn: 6000, error: 8192 },
    'MEETING-LOG.md': { warn: 120000, error: 300000 },
  },
  rowBudget: 1500, headerBudget: 1500, mustRead: ['AGENTS.md', 'CLAUDE.md'], mustReadBudget: 10240,
  agingDays: { openClientAsk: 14, touchpoint: 14, builtUnverified: 7, warnAge: 7 },
  backupDir: 'PM/archive/registry-backups',
  lineCeiling: 20000, // one line longer than this cannot be read in pieces by any tool (v1 hard ceiling)
};
const LINE_BUDGETS = { 'AGENTS.md': 120, 'CLAUDE.md': 30 }; // CONTRACT §2; a sizeBudgets "lines" key wins
const REGISTRY_NAMES = new Set(['TASKS.md', 'CLIENT.md', 'FACTS.md', 'MEETING-LOG.md', 'OPEN-ASKS.md',
  'APPROVAL-QUEUE.md', 'DOC-MAP.md', 'ROUTING.md', 'CLIENT-REQUESTS.md']);
const SECTIONS = { 'TASKS.md': ['Open'], 'CLIENT.md': ['Client asks', 'Confirmed Decisions', 'Standing Obligations'],
  'OPEN-ASKS.md': ['Open'], 'APPROVAL-QUEUE.md': ['Queue'] }; // the sections registry.mjs writes into (§5)
const MARKERS = [['⬜', 'OPEN'], ['🔎', 'VERIFYING'], ['🔧', 'BUILT'], ['✅', 'VERIFIED'],
  ['🚀', 'LIVE-UNVERIFIED'], ['⏸', 'PARKED'], ['✖', 'VOID']];
const CLOSED = new Set(['VERIFIED', 'VOID', 'PARKED', 'LIVE-UNVERIFIED']);
const DATE = /\b(20\d\d-[01]\d-[0-3]\d)\b/g;

// ── arguments, mode, clock ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
let MODE = argv.includes('--report') ? 'report' : argv.includes('--summary') ? 'summary'
  : argv.includes('--write-baseline') ? 'baseline' : 'stop';
const TODAY = /^\d{4}-\d\d-\d\d$/.test(process.env.CLOCKWORK_TODAY || '') ? process.env.CLOCKWORK_TODAY
  : new Date().toLocaleDateString('en-CA');
const age = (d) => Math.floor((Date.parse(TODAY) - Date.parse(d)) / 864e5);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Read stdin only when it is a pipe (run by hand in a terminal it would wait for input), and read it
// asynchronously: a synchronous read throws EAGAIN when Claude Code writes after node has started.
function readStdin(ms = 5000) {
  return new Promise((done) => {
    let raw = '', over = false;
    const end = (why) => { if (over) return; over = true; clearTimeout(t); done({ raw, why }); };
    const t = setTimeout(() => end(raw ? 'timeout' : 'nothing'), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => end(null));
    process.stdin.on('error', (e) => end(`read error: ${e.message}`));
  });
}
let payload = null;
if (MODE === 'stop' || (MODE === 'baseline' && !opt('--session'))) {
  let raw = '';
  if (!process.stdin.isTTY) {
    const r = await readStdin();
    raw = r.raw;
    if (r.why && r.why !== 'nothing' && MODE === 'stop') { say({ systemMessage: `clockwork-doctor: the Stop input could not be read (${r.why}), so the check did not run.` }); process.exit(0); }
  }
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch {
      if (MODE === 'stop') { say({ systemMessage: 'clockwork-doctor: Stop input was not JSON, so the check did not run.' }); process.exit(0); }
    }
  } else if (MODE === 'stop') MODE = 'report'; // no hook payload: someone ran it by hand
}
function say(obj) { process.stdout.write(JSON.stringify(obj)); }

// ── findings ─────────────────────────────────────────────────────────────────
const F = [];            // { level, code, key, text, item }
const notChecked = [];    // checks that could not run, with the reason
const ran = [];          // coverage: what each check actually measured
const crashed = [];      // checks that threw (report exits 2)
const filesRead = new Map(); // rel → { bytes, rows }
const add = (level) => (code, key, text, item) => F.push({ level, code, key: `${code}:${key}`, text, item });
const err = add('ERROR'), warn = add('WARN');
if (!ROWS) {
  const off = bareOffload(fileURLToPath(REG_TOOL)) === 'offloaded';
  notChecked.push(`Registry rows: .claude/tools/registry.mjs could not be loaded (${ROWS_ERR}); IDs, duplicates and ages were not checked. ${off ? 'Download it, then re-run.' : 'Re-run the installer.'}`);
  if (off) warn('NOTREAD', '.claude/tools/registry.mjs', offloadNote(fileURLToPath(REG_TOOL)));
}

// ── git ──────────────────────────────────────────────────────────────────────
// A git that does not answer (iCloud stall) is not "no repository": after the first timeout every later git
// call is skipped and each git-based check says so under NOT CHECKED.
const GIT_MS = Number(process.env.CLOCKWORK_GIT_TIMEOUT_MS) || 8000;
let gitHung = false;
const HUNG = `git did not answer within ${GIT_MS / 1000} s (iCloud stall or a lock?)`;
function git(dir, args) {
  if (gitHung) return null;
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: GIT_MS });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) { gitHung = true; return null; }
  return r.status === 0 ? r.stdout.trim() : null;
}
const inGit = (dir) => existsSync(dir) && git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
const noGit = (dir) => (gitHung ? HUNG : `${rel(dir)} is not a git repository`);

// ── root (§3): CLAUDE_PROJECT_DIR → CLOCKWORK_ROOT → cwd, walk up to .claude/clockwork.json, then main worktree ─
function findRoot() {
  const start = resolve(opt('--root') || process.env.CLAUDE_PROJECT_DIR || process.env.CLOCKWORK_ROOT || process.cwd());
  if (!existsSync(start)) throw new Error(`start folder ${start} does not exist`);
  let d = realpathSync(start); // git reports real paths; /var vs /private/var would break the worktree mapping
  while (!existsSync(join(d, '.claude', 'clockwork.json'))) {
    const up = dirname(d);
    if (up === d) throw new Error(`no .claude/clockwork.json found in ${start} or any folder above it`);
    d = up;
  }
  if (inGit(d)) {
    const gd = git(d, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const cd = git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (gd && cd && gd !== cd) { // a linked worktree: registries live in the main checkout
      START_IN_WORKTREE = true;
      const top = git(d, ['rev-parse', '--show-toplevel']);
      const main = (git(d, ['worktree', 'list', '--porcelain']) || '').match(/^worktree (.+)$/m)?.[1];
      const mapped = top && main ? join(main, relative(top, d)) : null;
      if (mapped && existsSync(join(mapped, '.claude', 'clockwork.json'))) return mapped;
    }
  }
  return d;
}

let ROOT, REG, SITE, cfg, START_IN_WORKTREE = false;
const rel = (p) => relative(ROOT, p) || '.';
// Tools by absolute path in the main copy: a worktree of a project that gitignores .claude/ has no .claude/tools (D13).
const REGTOOL = () => `node "${join(ROOT, '.claude', 'tools', 'registry.mjs')}"`;

function loadConfig() {
  const path = join(ROOT, '.claude', 'clockwork.json');
  if (offloadState(path) === 'offloaded') throw new Error(`${offloadNote(path)}; nothing else was checked`);
  let c;
  try { c = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`.claude/clockwork.json is not valid JSON (${e.message})`); }
  const out = { ...DEFAULTS, ...c, agingDays: { ...DEFAULTS.agingDays, ...(c.agingDays || {}) } };
  for (const k of ['rowBudget', 'headerBudget', 'mustReadBudget', 'lineCeiling']) {
    if (typeof out[k] !== 'number') { warn('CONFIG', k, `clockwork.json settings with the wrong type — defaults used instead`, k); out[k] = DEFAULTS[k]; }
  }
  for (const k of ['idPrefixes', 'sizeBudgets', 'agingDays']) {
    if (!out[k] || typeof out[k] !== 'object') { warn('CONFIG', k, `clockwork.json settings with the wrong type — defaults used instead`, k); out[k] = DEFAULTS[k]; }
  }
  if (!Array.isArray(out.mustRead)) { warn('CONFIG', 'mustRead', `clockwork.json settings with the wrong type — defaults used instead`, 'mustRead'); out.mustRead = DEFAULTS.mustRead; }
  return out;
}

// ── files ────────────────────────────────────────────────────────────────────
const cache = new Map();
// Files that exist but were NOT read (offloaded by iCloud, or their details could not be looked up). load() returns
// null for them too, so every check asks notRead() before calling a null "missing" or drawing a conclusion from it.
const skippedFiles = new Map(); // abs → why
const notRead = (...abs) => abs.some((a) => a && skippedFiles.has(a));
function skipFile(abs, state) {
  if (skippedFiles.has(abs)) return;
  const text = state === 'offloaded' ? offloadNote(abs) : `not checked: ${abs} could not be read (its details could not be looked up)`;
  skippedFiles.set(abs, text);
  warn('NOTREAD', rel(abs), text);
  notChecked.push(`${rel(abs)}: not read (see its WARN); every check that needs it is incomplete.`);
}
function load(abs) { // null when the file does not exist, or exists but was not read (notRead() tells which)
  if (!abs) return null;
  if (cache.has(abs)) return cache.get(abs);
  const state = offloadState(abs);
  if (state === 'missing') { cache.set(abs, null); return null; }
  if (state !== 'local') { skipFile(abs, state); cache.set(abs, null); return null; }
  const text = readFileSync(abs, 'utf8');
  const f = { abs, rel: rel(abs), text, bytes: Buffer.byteLength(text), lines: text.split('\n') };
  cache.set(abs, f);
  filesRead.set(f.rel, filesRead.get(f.rel) || { bytes: f.bytes, rows: {} });
  return f;
}
// Keys with "/" are relative to root. Registry names resolve in registryDir first (then .claude/, then root);
// other bare names (AGENTS.md, CLAUDE.md) resolve at root first.
function locate(key, registry = REGISTRY_NAMES.has(key) || /-ARCHIVE\.md$/.test(key)) {
  const c = key.includes('/') ? [join(ROOT, key)]
    : registry ? [join(REG, key), join(ROOT, '.claude', key), join(ROOT, key)]
      : [join(ROOT, key), join(REG, key), join(ROOT, '.claude', key)];
  return c.find((p) => existsSync(p)) || null;
}
const archiveOf = (name) => name.replace(/\.md$/, '-ARCHIVE.md');
// A registry that exists but is not read (offloaded or unreadable): stats only, never reads; reported once by skipFile.
function unreadReg(name) {
  const a = name && locate(name, true);
  if (!a) return false;
  if (skippedFiles.has(a)) return true;
  const st = offloadState(a);
  if (st === 'offloaded' || st === 'unreadable') { skipFile(a, st); return true; }
  return false;
}
// The files one prefix's ID checks read. If one of them was not read, those checks would judge half the rows
// (a false "no row" ERROR could even block Stop), so they are skipped and listed under NOT CHECKED instead.
const idFilesUnread = (p) => [cfg.idPrefixes[p], archiveOf(cfg.idPrefixes[p]), ...(p === 'C' ? ['CLIENT-REQUESTS.md'] : [])].filter(unreadReg);

// ── registry parsing (§5) ────────────────────────────────────────────────────
const regs = new Map();
function reg(name) {
  if (!name) return null;
  if (regs.has(name)) return regs.get(name);
  const f = load(locate(name, true));
  const base = name.replace(/-ARCHIVE\.md$/, '.md');
  const prefixes = Object.entries(cfg.idPrefixes).filter(([, v]) => v === base).map(([k]) => k);
  if (base === 'CLIENT-REQUESTS.md' && !prefixes.includes('C')) prefixes.push('C'); // legacy C-## mirror
  const r = f ? parse(f, prefixes) : null;
  regs.set(name, r);
  return r;
}
function idRe(prefixes) {
  const alt = [...prefixes].sort((a, b) => b.length - a.length).map(esc).join('|');
  return new RegExp(`(?<![A-Za-z0-9])(${alt})-(\\d+)(?!\\d)`, 'g');
}
function nums(text, p) { return text ? [...text.matchAll(idRe([p]))].map((m) => Number(m[2])) : []; }
function parse(f, prefixes) {
  const lines = f.lines;
  let h = lines.findIndex((l) => l.startsWith('## '));
  if (h < 0) h = lines.length;
  let header = lines.slice(0, h).join('\n');
  let body = lines.slice(h).join('\n');
  const counters = {};
  for (const p of prefixes) {
    const v2 = new RegExp('next free: `(' + esc(p) + ')-(\\d+)`', 'i');
    const legacy = new RegExp('next free[^\\n]*?(?<![A-Za-z0-9])(' + esc(p) + ')-(\\d+)(?!\\d)', 'i');
    const inHeader = header.match(v2) || header.match(legacy);
    const m = inHeader || body.match(legacy);
    if (!m) continue;
    counters[p] = Number(m[2]);
    if (inHeader) header = header.replace(m[0], ' '); else body = body.replace(m[0], ' '); // the counter names an UNUSED id
  }
  const rows = [], sections = [];
  const re = prefixes.length ? idRe(prefixes) : null;
  let section = '';
  lines.forEach((ln, i) => {
    if (ln.startsWith('## ')) { section = ln.slice(3).replace(/^[^A-Za-z]+/, '').trim(); sections.push(section); return; }
    if (!re || !ln.startsWith('|') || !ROWS) return;
    // The row rule: registry.mjs rowIdsOf (a combined key `| ~~T-7 / T-8~~ |` names several IDs, all taken, none a
    // full row). `| T-12a |` and `| T-5 · update 2026-08-25 |` are not rows; an ID named in prose is a mention.
    const all = ROWS.rowIdsOf(ln);
    if (!all) return;
    const ids = all.filter((x) => prefixes.includes(x.prefix)).map((x) => ({ p: x.prefix, n: x.num, raw: x.id }));
    if (!ids.length) return;
    const cells = ROWS.cellsOf(ln).map((c) => c.text);
    const last = cells[cells.length - 1].trim().replace(/^[*~\s]+/, '');
    const status = MARKERS.find(([mk]) => last.startsWith(mk))?.[1] || 'UNKNOWN';
    const struck = /^\s*\**~~/.test(cells[0]);
    rows.push({ ids, ln, lineNo: i + 1, cells, status, last, section, combined: all.length > 1,
      stub: ROWS.isPointer(ln),
      voidDup: ROWS.isVoidDuplicate(ln), // onboarding's marker: the ID stays taken, not a second row
      closed: struck || CLOSED.has(status) || /^(❌|⛔|📦)/.test(last) });
  });
  const info = filesRead.get(f.rel);
  for (const p of prefixes) info.rows[p] = rows.filter((r) => r.ids.some((x) => x.p === p)).length;
  return { f, header, headerBytes: Buffer.byteLength(lines.slice(0, h).join('\n')), body, counters, rows, sections };
}
const rowsOf = (r, p) => (r ? r.rows.filter((x) => x.ids.some((i) => i.p === p)) : []);
function rowIds(p) {
  const file = cfg.idPrefixes[p];
  const s = new Set();
  const extra = p === 'C' ? rowsOf(reg('CLIENT-REQUESTS.md'), p) : []; // legacy v1 mirror rows count as rows
  for (const r of [...rowsOf(reg(file), p), ...rowsOf(reg(archiveOf(file)), p), ...extra]) for (const i of r.ids) if (i.p === p) s.add(i.n);
  return s;
}
const liveRegistries = () => [...new Set(Object.values(cfg.idPrefixes))].map((n) => [n, reg(n)]).filter(([, r]) => r);

// ── checks ───────────────────────────────────────────────────────────────────
function checkSizes() {
  const remedy = (k) => (/^(TASKS|CLIENT|MEETING-LOG)\.md$/.test(basename(k))
    ? 'rotate settled rows (registry.mjs rotate) or move long rows to reports/' : 'trim it: one line per item, history to the log, detail to a rule, skill or report');
  const size = (f) => `${kb(f.bytes)} (${f.bytes.toLocaleString('en-US')} bytes)`;
  let n = 0;
  for (const [key, lim] of Object.entries(cfg.sizeBudgets)) {
    const abs = locate(key), f = load(abs);
    if (!f) { if (!notRead(abs)) warn('MISSING', key, `files listed in clockwork.json sizeBudgets that do not exist`, key); continue; }
    n++;
    if (lim?.error && f.bytes > lim.error) err('SIZE', key, `${f.rel} is ${size(f)}, over its limit of ${lim.error.toLocaleString('en-US')} bytes — ${remedy(key)}.`);
    else if (lim?.warn && f.bytes > lim.warn) warn('SIZE', key, `${f.rel} is ${size(f)}, over its warning level of ${lim.warn.toLocaleString('en-US')} bytes — ${remedy(key)}.`);
    const maxLines = lim?.lines ?? LINE_BUDGETS[basename(key)];
    if (maxLines && f.lines.length > maxLines) warn('LINES', key, `${f.rel} has ${f.lines.length} lines (budget ${maxLines}).`);
  }
  ran.push(`sizes: ${n} of ${Object.keys(cfg.sizeBudgets).length} budgeted files measured`);
  let total = 0; const found = [];
  const unread = agentsImport() === 'missing' ? 'AGENTS.md' : null;
  const unmeasured = [];
  for (const key of cfg.mustRead) {
    const abs = locate(key), f = load(abs);
    if (!f && notRead(abs)) { unmeasured.push(key); continue; }
    if (!f) { warn('MISSING', `mustRead:${key}`, `files listed in clockwork.json mustRead that do not exist`, key); continue; }
    if (unread && basename(key) === unread) continue; // not loaded at all (see IMPORT), so no session pays for it
    total += f.bytes; found.push(`${f.rel} ${kb(f.bytes)}`);
  }
  if (total > cfg.mustReadBudget) warn('MUSTREAD', 'total', `Files every session must read add up to ${kb(total)}, over the ${kb(cfg.mustReadBudget)} budget (${found.join(', ')}). Every parallel session pays this.`);
  ran.push(`must-read total: ${kb(total)} across ${found.length} files${unmeasured.length ? ` (not counted, not read: ${unmeasured.join(', ')})` : ''}`);
}

// D12: Claude Code reads AGENTS.md only through an @AGENTS.md import when a CLAUDE.md exists (docs: memory.md, "AGENTS.md").
// 'none' = nothing to check · 'first' = line 1 imports it · 'later' = imported further down · 'missing' = never imported.
function agentsImport() {
  const c = load(join(ROOT, 'CLAUDE.md')), a = load(join(ROOT, 'AGENTS.md'));
  if (notRead(join(ROOT, 'CLAUDE.md'), join(ROOT, 'AGENTS.md'))) return 'unread';
  if (!c || !a) return 'none';
  const lines = c.lines.map((l) => l.trim()).filter(Boolean);
  if (lines[0] === '@AGENTS.md') return 'first';
  return lines.some((l) => /^@(\.\/)?AGENTS\.md$/.test(l)) ? 'later' : 'missing';
}
function checkImport() {
  const s = agentsImport();
  if (s === 'missing') err('IMPORT', 'claude-md', `CLAUDE.md does not import AGENTS.md, so with Claude Code's default "Project instructions" setting no session loads the hard rules (once a CLAUDE.md exists, AGENTS.md is read only through that import: docs memory.md). Make line 1 of CLAUDE.md exactly: @AGENTS.md`);
  else if (s === 'later') warn('IMPORT', 'claude-md', `CLAUDE.md imports AGENTS.md below line 1; the kit expects line 1 to be exactly @AGENTS.md (decision D12).`);
  if (s === 'unread') { notChecked.push('AGENTS.md import: CLAUDE.md or AGENTS.md was not read.'); return; }
  ran.push(`AGENTS.md import: ${s === 'none' ? 'no CLAUDE.md or AGENTS.md' : s === 'first' ? 'line 1 of CLAUDE.md' : s === 'later' ? 'below line 1' : 'MISSING'}`);
}

function checkShape() {
  for (const [name, r] of liveRegistries()) {
    const long = r.f.lines.reduce((a, l, i) => (l.length > a.len ? { len: l.length, at: i + 1 } : a), { len: 0, at: 0 });
    if (long.len > cfg.lineCeiling) err('LINE', name, `${r.f.rel}:${long.at} is one ${long.len.toLocaleString('en-US')}-char line (limit ${cfg.lineCeiling.toLocaleString('en-US')}); no tool can read it in parts. Split it into rows or a report.`);
    if (r.headerBytes > cfg.headerBudget) warn('HEADER', name, `${r.f.rel} header (above the first "## ") is ${r.headerBytes.toLocaleString('en-US')} bytes, over the ${cfg.headerBudget} budget. The header holds title, purpose, Last updated and counters only; notes go in rows.`);
    for (const row of r.rows) {
      if (!row.closed && row.ln.length > cfg.rowBudget) warn('ROW', `${name}:${row.ids[0].raw}`, `open rows in ${r.f.rel} over the ${cfg.rowBudget}-char row budget — move detail to reports/<ID>-<slug>.md and link it`, `${row.ids[0].raw} (${row.ln.length})`);
      if (name === cfg.idPrefixes.T && /^✅\s*VERIFIED/.test(row.last) && !row.stub
        && row.last.replace(/^✅\s*VERIFIED/, '').replace(/\bopened:?\s*20\d\d-[01]\d-[0-3]\d/g, '').replace(/[\s·:—*_-]/g, '') === '')
        err('NOEVIDENCE', row.ids[0].raw, `✅ VERIFIED task rows with no evidence (the fresh verifier's report path, sha or URL) — set them back to 🔧 BUILT or add the evidence with registry.mjs append`, row.ids[0].raw);
      if (row.status === 'LIVE-UNVERIFIED' && row.last.replace(/^🚀\s*LIVE-UNVERIFIED/i, '').replace(/[\s·:—-]/g, '').length < 8)
        warn('LIVEREASON', row.ids[0].raw, `rows marked 🚀 LIVE-UNVERIFIED without the reason the user gave`, row.ids[0].raw);
    }
    for (const s of SECTIONS[name] || []) if (!r.sections.some((x) => x.toLowerCase() === s.toLowerCase()))
      warn('SECTION', `${name}:${s}`, `${r.f.rel} has no "## ${s}" section; registry.mjs writes there, so it needs --section until the heading exists.`);
  }
}

function checkIds() {
  for (const [p, file] of Object.entries(cfg.idPrefixes)) {
    const live = reg(file), arch = reg(archiveOf(file));
    const unread = idFilesUnread(p);
    if (unread.length) { notChecked.push(`${p}- ID checks (counter, duplicates, IDs with no row): ${unread.join(', ')} not read.`); continue; }
    if (!live) { warn('MISSING', `id:${file}`, `registry files named in clockwork.json idPrefixes that do not exist`, `${file} (${p}-)`); notChecked.push(`${p}- ID checks: ${file} not found.`); continue; }
    const ids = rowIds(p);
    const counter = live.counters[p];
    if (counter === undefined) {
      if (ids.size) warn('NOCOUNTER', p, `${live.f.rel} has ${p}- rows but no "next free: \`${p}-…\`" counter line.`);
      notChecked.push(`${p}- counter, counter-only and duplicate checks: no ${p}- counter in ${live.f.rel}.`);
      continue;
    }
    let max = 0;
    for (const t of [live.header, live.body, arch?.f.text]) for (const n of nums(t, p)) if (n > max) max = n;
    if (max >= counter) err('COUNTER', p, `${live.f.rel}: ${p}-${max} is already used, but the counter says the next free ID is ${p}-${counter}. Raise the counter to ${p}-${max + 1} before anyone mints another ${p}- ID.`);
    for (const n of new Set(nums(live.header, p))) if (n < counter && !ids.has(n))
      err('CTRONLY', `${p}-${n}`, `IDs mentioned in the ${live.f.rel} header with no row in it or its archive — add the real row, or a ✖ VOID row for a gap`, `${p}-${n}`);
    // Two full rows in one file = a reused ID (ERROR). A full row in both live and archive = a rotation
    // that left no stub (WARN): same ID, one task, wrong shape.
    const tally = (r) => { const m = new Map(); for (const x of rowsOf(r, p)) { const own = x.ids.filter((i) => i.p === p); if (!x.stub && !x.voidDup && !x.combined && own.length === 1) m.set(own[0].n, (m.get(own[0].n) || 0) + 1); } return m; };
    const tl = tally(live), ta = tally(arch);
    // Live-file duplicates are ERROR: registry.mjs needs each ID's row to match exactly once. In the
    // append-only archive they are history, so WARN.
    for (const [name, t, f] of [[live.f.rel, tl, err], [arch?.f.rel, ta, warn]]) for (const [n, c] of t) if (c > 1)
      f(f === err ? 'DUP' : 'DUP_IN_ARCH', `${p}-${n}`, f === err ? `IDs with more than one full row in ${name} — fix each with ${REGTOOL()} dedupe <ID> (drops identical copies; if the rows differ it asks for --keep <line> and renumbers the others)` : `IDs with more than one full row in ${name} — history, left as is`, `${p}-${n} ×${c}`);
    for (const [n] of tl) if (ta.has(n) && tl.get(n) === 1 && ta.get(n) === 1)
      warn('DUP_ARCH', `${p}-${n}`, `IDs with a full row in both ${live.f.rel} and its archive — leave only a stub ("| ${p}-n | → archived … |") in the live file`, `${p}-${n}`);
    ran.push(`${p}- IDs: counter ${p}-${counter}, highest used ${p}-${max}, ${ids.size} IDs with rows`);
  }
}

function checkBranches() {
  if (!inGit(SITE)) { notChecked.push(`Branch and worktree names vs rows: ${noGit(SITE)}.`); return; }
  const names = new Set((git(SITE, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']) || '').split('\n').filter((b) => b && !b.endsWith('/HEAD')));
  for (const ln of (git(SITE, ['worktree', 'list', '--porcelain']) || '').split('\n')) {
    if (ln.startsWith('worktree ')) names.add(basename(ln.slice(9)));
    if (ln.startsWith('branch ')) names.add(ln.slice(7).replace(/^refs\/heads\//, ''));
  }
  for (const p of Object.keys(cfg.idPrefixes)) {
    const re = new RegExp(`(?:^|/|worktree-)${esc(p.toLowerCase())}(\\d+)-`);
    const unread = idFilesUnread(p);
    if (unread.length) { notChecked.push(`Branch and worktree names vs ${p}- rows: ${unread.join(', ')} not read.`); continue; }
    const ids = rowIds(p);
    for (const name of names) {
      const m = name.match(re);
      if (!m || ids.has(Number(m[1]))) continue;
      (p === 'T' ? err : warn)('BRANCH', `${p}-${Number(m[1])}`, `branches or worktrees named for an ID that has no row — mint the row first (registry.mjs mint), then name the branch`, `${p}-${Number(m[1])} (${name})`);
    }
  }
  ran.push(`branches/worktrees: ${names.size} names checked in ${rel(SITE)}`);
}

function checkSync() {
  const dirs = new Set([ROOT, join(ROOT, '.claude'), REG, SITE, join(SITE, '.claude'),
    ...['hooks', 'tools', 'rules', 'agents', 'skills'].map((d) => join(ROOT, '.claude', d))]);
  let gd = inGit(SITE) ? git(SITE, ['rev-parse', '--path-format=absolute', '--git-common-dir']) : null;
  if (!gd && gitHung) { // the refs walk needs no git: find the .git folder by hand
    for (let d = SITE; ; d = dirname(d)) {
      try { if (statSync(join(d, '.git')).isDirectory()) { gd = join(d, '.git'); break; } } catch { /* keep walking */ }
      if (dirname(d) === d) break;
    }
    if (!gd) notChecked.push(`Duplicate git refs made by iCloud: ${HUNG}, and no .git folder was found above ${rel(SITE)}.`);
  }
  if (gd) dirs.add(gd);
  let n = 0;
  for (const d of dirs) {
    let ents; try { ents = readdirSync(d); } catch { continue; }
    n += ents.length;
    for (const name of ents) {
      const m = name.match(/^(.+?) (\d+)(\.[A-Za-z0-9]+)?$/);
      const orig = m ? m[1] + (m[3] || '') : null;
      if (orig && (existsSync(join(d, orig)) || REGISTRY_NAMES.has(orig)))
        err('CONFLICT', rel(join(d, name)), `iCloud conflict copies — a session can read the wrong one. Compare each with its original, move anything missing into the original, then delete the copy`, `"${rel(join(d, name))}"`);
      const off = name.match(/^\.(.+)\.icloud$/);
      // An offloaded file is a WARN, never an ERROR: it is not a wrong fact, and a Stop block could not fix it.
      if (off) warn('OFFLOADED', rel(join(d, off[1])), offloadNote(join(d, off[1])));
    }
  }
  if (gd) {
    const walk = (d, depth) => {
      let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (/ \d+$/.test(e.name)) err('GITREF', e.name, `duplicate git refs made by iCloud — they break git fetch ("bad object"). Move the repo off iCloud`, `"${relative(gd, join(d, e.name))}"`);
        else if (e.isDirectory() && depth < 6) walk(join(d, e.name), depth + 1);
      }
    };
    walk(join(gd, 'refs'), 0);
  }
  for (const [, r] of liveRegistries()) if (r.f.bytes === 0) warn('EMPTY', r.f.rel, `${r.f.rel} is empty. If it should have content, iCloud may have offloaded it.`);
  ran.push(`sync hazards: ${n} entries scanned in ${dirs.size} folders${gd ? ' + git refs' : ''}`);
}

function checkCopies() {
  const names = [...new Set(Object.values(cfg.idPrefixes))];
  const canon = new Set(names.map((x) => locate(x, true)).filter(Boolean));
  const bases = new Set([ROOT, join(ROOT, '.claude'), SITE, join(SITE, '.claude'), REG]);
  try {
    for (const e of readdirSync(ROOT, { withFileTypes: true }))
      if (e.isDirectory() && !['.git', 'node_modules', '.claude'].includes(e.name)) bases.add(join(ROOT, e.name, '.claude'));
  } catch { /* root unreadable is caught elsewhere */ }
  const backup = join(ROOT, cfg.backupDir || DEFAULTS.backupDir);
  for (const b of bases) for (const n of names) {
    const p = join(b, n);
    if (canon.has(p) || !existsSync(p) || p.startsWith(backup) || p.includes(`${sep}.claude${sep}worktrees${sep}`)) continue;
    warn('COPY', rel(p), `second copies of registry files outside ${rel(REG)} — only one copy is real, and a session reading the other works from stale data`, rel(p));
  }
}

function checkAging() {
  const d = cfg.agingDays;
  const client = cfg.idPrefixes.C ? reg(cfg.idPrefixes.C) : null;
  if (client) {
    let undated = 0, open = 0;
    for (const row of rowsOf(client, 'C')) {
      if (row.closed || row.stub) continue;
      open++;
      const o = row.ln.match(/\bopened:?\s*(20\d\d-[01]\d-[0-3]\d)/i)?.[1];
      if (!o) { undated++; continue; }
      if (age(o) > d.openClientAsk) warn('AGE_C', row.ids[0].raw, `open client asks older than ${d.openClientAsk} days — chase, park or close each`, `${row.ids[0].raw} (${age(o)} d)`);
    }
    if (undated) notChecked.push(`Age of ${undated} of ${open} open C- rows: no "opened YYYY-MM-DD" date in the row.`);
    ran.push(`client-ask aging: ${open - undated} of ${open} open C- rows dated`);
  } else notChecked.push(!cfg.idPrefixes.C ? 'Client-ask aging: no C- prefix configured.' : `Client-ask aging: ${cfg.idPrefixes.C} ${unreadReg(cfg.idPrefixes.C) ? 'not read' : 'not found'}.`);

  const mlog = reg('MEETING-LOG.md');
  const dates = mlog ? [...mlog.body.matchAll(DATE)].map((m) => m[1]).filter((x) => x <= TODAY).sort() : [];
  if (!mlog) notChecked.push(`Days since last client touchpoint: MEETING-LOG.md ${unreadReg('MEETING-LOG.md') ? 'not read' : 'not found'}.`);
  else if (!dates.length) notChecked.push(`Days since last client touchpoint: no dated entries in ${mlog.f.rel}.`);
  else {
    const last = dates[dates.length - 1];
    if (age(last) > d.touchpoint) warn('TOUCH', 'meeting-log', `Newest client touchpoint in ${mlog.f.rel} is ${last}, ${age(last)} days ago (limit ${d.touchpoint}). Log recent contact, or plan it.`);
    ran.push(`touchpoint: newest ${mlog.f.rel} date ${last}`);
  }

  let dated = 0;
  for (const [, r] of liveRegistries()) for (const row of r.rows) {
    if (row.closed || row.stub) continue;
    const due = row.ln.match(/\bdue:?\s*(20\d\d-[01]\d-[0-3]\d)\b/i)?.[1];
    if (!due) continue;
    dated++;
    if (due < TODAY) warn('DUE', row.ids[0].raw, `open rows past their due date — deliver, renegotiate with the client, or close`, `${row.ids[0].raw} (due ${due})`);
  }
  ran.push(`due dates: ${dated} open rows carry "due YYYY-MM-DD"`);

  let built = 0, undatedBuilt = 0;
  for (const [, r] of liveRegistries()) for (const row of r.rows) {
    if (row.status !== 'BUILT' || row.stub) continue;
    built++;
    const when = [...row.last.matchAll(DATE)].map((m) => m[1]).sort().pop() || row.ln.match(/\bopened:?\s*(20\d\d-[01]\d-[0-3]\d)/i)?.[1];
    if (!when) { undatedBuilt++; continue; }
    if (age(when) > d.builtUnverified) warn('AGE_BUILT', row.ids[0].raw, `🔧 BUILT rows waiting more than ${d.builtUnverified} days for a fresh verifier`, `${row.ids[0].raw} (${age(when)} d)`);
  }
  if (undatedBuilt) notChecked.push(`Age of ${undatedBuilt} of ${built} BUILT rows: no date in the status cell or an "opened" date.`);
  ran.push(`built-unverified aging: ${built - undatedBuilt} of ${built} BUILT rows dated`);
}

// Is the session that asked in a linked worktree? (Claude Code blocks git in the main checkout from there: worktrees.md.)
function callerInWorktree() {
  const d = process.env.CLOCKWORK_CALLER_DIR || (MODE === 'stop' ? payload?.cwd : null);
  if (!d || !existsSync(d)) return START_IN_WORKTREE;
  const gd = git(d, ['rev-parse', '--path-format=absolute', '--git-dir']), cd = git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return !!(gd && cd && gd !== cd);
}
function checkUncommitted() {
  const dir = MODE === 'stop' && payload?.cwd && inGit(payload.cwd) ? payload.cwd : SITE;
  if (!inGit(dir)) { notChecked.push(`Uncommitted changes: ${noGit(dir)}.`); return; }
  const out = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (out === null) { notChecked.push(`Uncommitted changes: ${gitHung ? HUNG : `git status failed in ${rel(dir)}`}.`); return; }
  const all = out.split('\n').filter(Boolean).map((l) => l.replace(/^[ MTADRCU]{1,2} /, '')); // git() trims, so line 1 may have lost its leading space
  // Registry files change in the main copy all day (tools write them); they are committed separately (rules/registries.md).
  // The tools also create files git does not track yet: archives, reports, meeting sources, backups. They belong in the same commit.
  const isReg = (f) => REGISTRY_NAMES.has(basename(f)) || /-ARCHIVE\.md$/.test(f);
  const regs = all.filter(isReg), files = all.filter((f) => !isReg(f));
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  const family = top ? [...new Set([REG, join(REG, 'reports'), join(ROOT, 'PM')].map((p) => relative(top, p)).filter((p) => p && !p.startsWith('..')))] : [];
  const unt = family.length ? git(dir, ['status', '--porcelain', '--untracked-files=all', '--', ...family]) : '';
  // Only what the tools create goes in the commit command: registries and archives, reports/ (handovers, row detail),
  // PM/meetings/ (intake sources) and registry backups. Any other new file under .claude/ may be scratch or private.
  const regRel = relative(top || ROOT, REG), pmRel = relative(top || ROOT, join(ROOT, 'PM')), bkRel = relative(top || ROOT, join(ROOT, cfg.backupDir || DEFAULTS.backupDir));
  const under = (f, d) => d && !d.startsWith('..') && f.startsWith(`${d}/`);
  const isFamily = (f) => isReg(f) || under(f, `${regRel}/reports`) || under(f, `${pmRel}/meetings`) || under(f, bkRel);
  const untracked = (unt || '').split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).replace(/^"|"$/g, ''));
  const newFiles = untracked.filter(isFamily);
  const stray = untracked.filter((f) => !isFamily(f) && under(f, regRel));
  const toCommit = [...regs, ...newFiles];
  if (toCommit.length) {
    const cmd = `git add -- ${toCommit.slice(0, 40).map((f) => `"${f}"`).join(' ')}${toCommit.length > 40 ? ' …' : ''} && git commit -m "registries: <what changed>"`;
    const who = callerInWorktree()
      ? `You are in a worktree, which cannot run git in the main checkout: do not commit these yourself. Tell the user or the session working in the main checkout; they run: ${cmd}`
      : `Commit them from the main checkout, by path (the tools' new files too): ${cmd}`;
    warn('REGDIRTY', rel(dir), `${regs.length} registry file(s) changed and ${newFiles.length} new registry, report or PM file(s) not committed in ${rel(dir)}. ${who}`);
  }
  if (stray.length) warn('STRAY', rel(dir), `${stray.length} new file(s) under ${regRel}/ that no Clockwork tool made are not committed (${stray.slice(0, 6).join(', ')}${stray.length > 6 ? ' …' : ''}). They are left out of the registry commit on purpose: look at each; commit it by path, ignore it, or delete it.`);
  if (files.length) warn('DIRTY', rel(dir), `${files.length} tracked file(s) changed but not committed in ${rel(dir)}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ' …' : ''}. Commit the moment a change verifies (in a shared checkout, some may be another session's).`);
  ran.push(`uncommitted: git status in ${rel(dir)}`);
}

function checkClientAsks() {
  const cName = cfg.idPrefixes.C;
  if (!cName) { notChecked.push('Client-ask ownership: no C- prefix configured.'); return; }
  const client = reg(cName), carch = reg(archiveOf(cName)), creq = reg('CLIENT-REQUESTS.md');
  const unread = [cName, archiveOf(cName), 'CLIENT-REQUESTS.md', 'MEETING-LOG.md', 'MEETING-LOG-ARCHIVE.md'].filter(unreadReg);
  if (unread.length) { notChecked.push(`Client-ask ownership: ${unread.join(', ')} not read.`); return; } // half the record would mean false orphans
  if (!client) { notChecked.push(`Client-ask ownership: ${cName} not found.`); return; } // clientPresent guard: never ERROR on a missing log
  const key = (n) => `C-${n}`;
  const clientRows = new Set([...rowsOf(client, 'C'), ...rowsOf(carch, 'C')].flatMap((r) => r.ids.filter((i) => i.p === 'C').map((i) => i.n)));
  const creqRows = new Set(rowsOf(creq, 'C').flatMap((r) => r.ids.filter((i) => i.p === 'C').map((i) => i.n)));
  if (creq) { // legacy v1 mirror: every C- in it needs a home in the client record
    const record = [client.f.text, carch?.f.text, reg('MEETING-LOG.md')?.f.text, reg('MEETING-LOG-ARCHIVE.md')?.f.text].join('\n');
    const inRecord = new Set(nums(record, 'C'));
    for (const n of new Set(nums(creq.header + creq.body, 'C'))) if (!inRecord.has(n))
      err('ORPHAN', key(n), `C- IDs in ${creq.f.rel} that appear nowhere in the client record (${cName}, its archive, MEETING-LOG)`, key(n));
    for (const r of rowsOf(creq, 'C')) for (const i of r.ids) if (i.p === 'C' && !clientRows.has(i.n) && !r.closed && !/closed|resolved|superseded/i.test(r.ln))
      warn('UNMIRRORED', key(i.n), `C- rows in ${creq.f.rel} with no owner row in ${cName} (both need one)`, i.raw);
    const cc = creq.counters.C;
    if (cc !== undefined) {
      let max = 0; for (const n of nums(creq.header + creq.body, 'C')) if (n > max) max = n;
      if (max >= cc) err('COUNTER', 'CLIENT-REQUESTS', `${creq.f.rel}: C-${max} is already used, but its counter says next free is C-${cc}.`);
      if (client.counters.C !== undefined && client.counters.C !== cc) warn('COUNTERS', 'C', `${cName} and ${creq.f.rel} disagree on the next free C- ID (C-${client.counters.C} vs C-${cc}).`);
    }
  }
  // "Mentioned" is not "owned": a C- in the body of the client files needs a row someone is accountable for.
  const nextFree = client.counters.C;
  const mentioned = new Set([...nums(client.body, 'C'), ...(creq ? nums(creq.body, 'C') : [])]);
  let homeless = 0;
  for (const n of mentioned) if (n !== nextFree && !clientRows.has(n) && !creqRows.has(n)) { homeless++; warn('NOOWNER', key(n), `C- IDs mentioned in the client files but with no row in any owner table`, key(n)); }
  ran.push(`client asks: ${clientRows.size} C- rows, ${mentioned.size} C- IDs mentioned, ${homeless} without a row${creq ? `, legacy ${creq.f.rel} checked` : ''}`);
}

// Rule 13 (ported from a v1 project doctor): a settled decision must not come back as an open question.
const SELF_OPEN = ['still open', 'remains open', 'still to be decided', 'not yet decided', 'to be decided', 'still undecided', 'open question', 'tbd'];
const STOP = new Set('the and for not but with from this that only never also both into over than then they been was are its his her who what when which because stated decided settled closed reversal decision original wording update updated corrected'.split(' '));
const flat = (s) => s.toLowerCase().replace(/[`~*_]/g, '').replace(/[^a-z0-9/\- ]/g, ' ').replace(/\s+/g, ' ');
function checkDecisions() {
  const own = new Set(flat(String(cfg.project || '')).split(' ').filter(Boolean)); // the project's own name is in every row
  const cName = cfg.idPrefixes.C || cfg.idPrefixes.CD;
  const client = cName ? reg(cName) : null;
  if (!client) { notChecked.push(cName && unreadReg(cName) ? `Settled-decision checks: ${cName} not read.` : 'Settled-decision checks: no client registry.'); return; }
  const i = client.f.lines.findIndex((l) => l.startsWith('## ') && /^confirmed decisions/i.test(l.slice(3).replace(/^[^A-Za-z]+/, '')));
  if (i < 0) { notChecked.push(`Settled-decision checks: no "## Confirmed Decisions" section in ${client.f.rel}.`); return; }
  const end = client.f.lines.findIndex((l, j) => j > i && l.startsWith('## '));
  const block = client.f.lines.slice(i + 1, end < 0 ? undefined : end).filter((l) => l.startsWith('|') && !/^\|\s*:?-+/.test(l));
  for (const ln of block) { // struck text is the cure for an append-only table, so it never counts
    const low = ln.toLowerCase().replace(/~~[^~]*~~/g, ' ');
    const hit = SELF_OPEN.find((p) => new RegExp(`\\b${p}\\b`).test(low));
    if (hit && !/should never have existed|reconciliation/.test(low))
      warn('SELFOPEN', flat(ln).slice(0, 60), `Confirmed Decision rows that call their own subject unresolved — add a row that closes it explicitly, or strike the phrase`, `"${hit}" in ${ln.slice(2, 70).replace(/\s+/g, ' ')}…`);
  }
  const phrases = new Set();
  for (const m of block.join('\n').matchAll(/\*\*(.+?)\*\*/g)) {
    const w = flat(m[1]).trim().split(' ').filter((x) => x.length > 2 && !STOP.has(x) && !own.has(x) && !/^\d/.test(x));
    if (w.length >= 2 && w.length <= 7 && w.join(' ').length >= 14) phrases.add(w.join(' '));
  }
  let open = 0;
  for (const r of rowsOf(client, 'C')) {
    if (r.stub || /^\s*~~/.test(r.cells[0])) continue;
    const low = r.ln.toLowerCase(); // an explicit open marker wins over a ✅ elsewhere in a half-closed row
    const looksOpen = r.status === 'OPEN' || /🔴|🟠|🔵/.test(r.ln) || /\bstill open\b|\bremainder\b|\bhalf-?closed\b/.test(low);
    if (!looksOpen && (r.closed || /✅|❌|⏸/.test(r.ln) || /\bclosed\b|\bvoid\b|\bparked\b/.test(low))) continue;
    open++;
    const hay = flat(r.ln);
    const hit = [...phrases].find((p) => hay.includes(p));
    if (hit) warn('REOPENED', r.ids[0].raw, `open C- rows that restate a phrase the Confirmed Decisions table already settled — check the table before asking the user again`, `${r.ids[0].raw} "${hit}"`);
  }
  ran.push(`settled decisions: ${block.filter((l) => /^\|\s*(?:\*\*)?[A-Z]+-\d+/.test(l)).length} decision rows, ${phrases.size} bolded phrases, ${open} open C- rows compared`);
}

function checkDeadRefs() {
  const files = [locate('DOC-MAP.md', true), ...cfg.mustRead.map((k) => locate(k))].filter(Boolean);
  const bases = [...new Set([ROOT, SITE, REG])];
  let checked = 0;
  for (const abs of new Set(files)) {
    const f = load(abs);
    if (!f) continue; // not read: listed under NOT CHECKED
    for (const line of f.lines) {
      // a line that documents a path as gone names the old path on purpose
      if (line.includes('~~') || /→|->/.test(line) || /\b(moved|retired|removed|deleted|renamed|superseded)\b/i.test(line)) continue;
      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        const t = m[1].trim().replace(/#.*$/, '').replace(/:\d+(-\d+)?$/, '');
        if (/^\s*if shipped\b/.test(line.slice(m.index + m[0].length))) continue; // the kit's optional stack profile
        if (!t.includes('/') || /[<>*{}|$]|:\/\/|^[~/]/.test(t)) continue;
        if (!t.endsWith('/') && !/\.[A-Za-z0-9]{1,5}$/.test(t)) continue;
        const first = t.split('/')[0];
        if (!bases.some((b) => existsSync(join(b, first)))) continue; // only paths anchored at a real top-level folder
        checked++;
        if (!bases.some((b) => existsSync(join(b, t)))) warn('DEADREF', `${f.rel}:${t}`, `paths in ${f.rel} that do not exist on disk — fix or strike each`, `"${t}"`);
      }
    }
  }
  ran.push(`dead references: ${checked} anchored paths checked in ${files.length} files (paths with spaces included)`);
}

// A worktree is made from commits: kit files that were never committed are missing from every worktree
// (no hooks, no tools, no AGENTS.md there). A project may gitignore .claude/ ON PURPOSE (decision D13): then
// .worktreeinclude must list the kit files so Claude Code copies them into each worktree it makes (docs worktrees.md,
// "Copy gitignored files into worktrees"). The doctor never advises un-ignoring.
const KIT_PATHS = ['.claude/clockwork.json', '.claude/settings.json', 'AGENTS.md', 'CLAUDE.md', '.claude/hooks/clockwork-doctor.mjs', '.claude/tools/registry.mjs'];
const KIT_COPIED = ['.claude/settings.json', '.claude/clockwork.json', '.claude/hooks', '.claude/tools', '.claude/rules', '.claude/skills', '.claude/agents', '.claude/workflows'];
// `git check-ignore -v` also prints the "!pattern" that RE-INCLUDES a path; such a path is not ignored.
function ignoredPaths(dir, paths) {
  if (!paths.length) return [];
  const r = spawnSync('git', ['-C', dir, 'check-ignore', '-v', '--stdin'], { input: paths.join('\n') + '\n', encoding: 'utf8', timeout: GIT_MS });
  return (r.stdout || '').split('\n').filter(Boolean).map((l) => { const m = /^(.*?):(\d+):(.*?)\t(.*)$/.exec(l); return m && !m[3].startsWith('!') ? { src: `${m[1]}:${m[2]}`, pat: m[3], path: m[4] } : null; }).filter(Boolean);
}
// The .worktreeinclude line that copies one path (gitignore syntax, the forms the kit writes).
const includeLine = (f) => KIT_COPIED.find((d) => f.startsWith(`${d}/`)) ? `${KIT_COPIED.find((d) => f.startsWith(`${d}/`))}/**` : f;
function included(lines, f) {
  return lines.some((l) => l === f || (l.endsWith('/**') && f.startsWith(l.slice(0, -2))) || (l.endsWith('/') && f.startsWith(l)) || f.startsWith(`${l}/`));
}
function checkTracked() {
  if (!inGit(ROOT)) { notChecked.push(`Kit files committed: ${noGit(ROOT)}.`); return; }
  const want = KIT_PATHS.filter((f) => existsSync(join(ROOT, f)));
  const out = git(ROOT, ['ls-files', '--', ...want]);
  if (out === null) { notChecked.push(`Kit files committed: ${gitHung ? HUNG : 'git ls-files failed'}.`); return; }
  const have = new Set(out.split('\n').filter(Boolean));
  const miss = want.filter((f) => !have.has(f));
  const ignored = ignoredPaths(ROOT, miss);
  const ignoredSet = new Set(ignored.map((x) => x.path));
  const incFile = ignored.length ? load(join(ROOT, '.worktreeinclude')) : null;
  if (ignored.length && notRead(join(ROOT, '.worktreeinclude'))) notChecked.push('Gitignored kit files vs .worktreeinclude: .worktreeinclude was not read.');
  else if (ignored.length) {
    const inc = (incFile?.lines || []).map((l) => l.trim().replace(/^\//, '')).filter((l) => l && !l.startsWith('#'));
    const lacking = [...ignoredSet].filter((f) => !included(inc, f));
    if (lacking.length) {
      const wts = ((git(ROOT, ['worktree', 'list', '--porcelain']) || '').match(/^worktree /gm) || []).length - 1;
      const rules = [...new Set(ignored.map((x) => `${x.src} "${x.pat}"`))].join(', ');
      (wts > 0 ? err : warn)('IGNORED', 'kit', `Clockwork files are gitignored here (${rules}; fine, decision D13) but .worktreeinclude does not list ${lacking.join(', ')}, so ${wts > 0 ? `the ${wts} worktree session(s) here run` : 'a worktree session runs'} without hooks, tools or rules. Add these lines to .worktreeinclude: ${[...new Set(lacking.map(includeLine))].join(' · ')} (existing worktrees: copy the files in from the main checkout).`);
    } else ran.push(`kit files gitignored on purpose (D13): ${ignoredSet.size}, all listed in .worktreeinclude`);
  }
  const commit = miss.filter((f) => !ignoredSet.has(f));
  if (commit.length) warn('UNTRACKED', 'kit', `Clockwork files not committed (${commit.join(', ')}): a worktree made now has no hooks, tools or rules. Commit them by path: git -C "${ROOT}" add -- ${commit.map((f) => `"${f}"`).join(' ')} && git -C "${ROOT}" commit -m "Install Clockwork"`);
  ran.push(`kit files committed: ${want.length - miss.length} of ${want.length}${ignored.length ? `, ${ignoredSet.size} gitignored` : ''}`);
}

// D13: a worktree's copy of gitignored kit files (made by .worktreeinclude when the worktree was created) never
// updates. Path-scoped rules and hooks there go stale while main moves on, so say which differ.
function listFiles(abs, relBase, out = []) {
  let ents; try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = join(abs, e.name), r = `${relBase}/${e.name}`; if (e.isDirectory()) listFiles(p, r, out); else if (e.isFile()) out.push(r); }
  return out;
}
function checkWorktreeCopies() {
  if (!inGit(ROOT)) { notChecked.push(`Worktree copies of kit files: ${noGit(ROOT)}.`); return; }
  const top = git(ROOT, ['rev-parse', '--show-toplevel']);
  const list = git(ROOT, ['worktree', 'list', '--porcelain']);
  if (!top || list === null) { notChecked.push(`Worktree copies of kit files: ${gitHung ? HUNG : 'git worktree list failed'}.`); return; }
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const others = list.split(/\n\s*\n/).filter((b) => b.startsWith('worktree ') && !/^prunable/m.test(b)).map((b) => b.split('\n')[0].slice(9)).filter((w) => real(w) !== real(top));
  if (!others.length) { ran.push('worktree kit copies: no other worktrees'); return; }
  const files = KIT_COPIED.flatMap((k) => (existsSync(join(ROOT, k)) && statSync(join(ROOT, k)).isDirectory() ? listFiles(join(ROOT, k), k) : existsSync(join(ROOT, k)) ? [k] : []));
  const copied = new Set(ignoredPaths(ROOT, files).map((x) => x.path)); // committed files differ by branch on purpose
  const sub = relative(real(top), real(ROOT));
  let compared = 0;
  const offloaded = [];
  for (const w of others) {
    const differ = [], edited = [];
    // A copy newer than main's, or changed well after the worktree was made (its admin folder's commondir is written
    // once, then), was edited IN the worktree. It is gitignored: git never sees it and removing the worktree deletes it.
    const admin = git(w, ['rev-parse', '--path-format=absolute', '--git-dir']);
    let born = Infinity; try { born = statSync(join(admin, 'commondir')).mtimeMs; } catch { /* unknown: judge by main's time only */ }
    for (const f of copied) {
      const wf = join(w, sub, f);
      if (!existsSync(wf)) continue; // a hand-made worktree has no copies at all: IGNORED/.worktreeinclude covers that
      const off = [wf, join(ROOT, f)].filter((x) => offloadState(x) === 'offloaded');
      if (off.length) { offloaded.push(...off); continue; } // never read: not compared, listed below
      compared++;
      let same = false; try { same = readFileSync(wf).equals(readFileSync(join(ROOT, f))); } catch { /* unreadable = differs */ }
      if (same) continue;
      let wt = 0, main = 0; try { wt = statSync(wf).mtimeMs; main = statSync(join(ROOT, f)).mtimeMs; } catch { /* treat as stale */ }
      (wt > main || wt > born + 60000 ? edited : differ).push(f);
    }
    if (edited.length) warn('WTEDIT', basename(w), `Kit files were edited inside worktree ${w}: ${edited.slice(0, 8).join(', ')}${edited.length > 8 ? ' …' : ''}. That copy is gitignored (D13): git does not see the edit and removing the worktree deletes it. Do not refresh these from main. Compare, then copy the change into the main copy (a session in the main checkout, or the user): ${edited.slice(0, 3).map((f) => `diff "${join(ROOT, f)}" "${join(w, sub, f)}"`).join(' ; ')}`);
    if (!differ.length) continue;
    const dirs = [...new Set(differ.map((f) => KIT_COPIED.find((d) => f.startsWith(`${d}/`)) || f))];
    const keep = (d) => edited.filter((f) => f.startsWith(`${d}/`)).map((f) => ` --exclude "${f.slice(d.length + 1)}"`).join('');
    warn('WTCOPY', basename(w), `Kit files in worktree ${w} are older than the main copy (a .worktreeinclude copy is made once, when the worktree is created): ${differ.slice(0, 8).join(', ')}${differ.length > 8 ? ' …' : ''}. Refresh them from main (-u never overwrites a newer file): ${dirs.map((d) => (KIT_COPIED.slice(0, 2).includes(d) ? `cp "${join(ROOT, d)}" "${join(w, sub, d)}"` : `rsync -a -u${keep(d)} "${join(ROOT, d)}/" "${join(w, sub, d)}/"`)).join(' && ')}`);
  }
  if (offloaded.length) notChecked.push(`Worktree kit copies: ${offloaded.length} file(s) not compared. ${offloaded.slice(0, 3).map(offloadNote).join(' · ')}${offloaded.length > 3 ? ' …' : ''}`);
  ran.push(`worktree kit copies: ${compared} gitignored kit file copies compared across ${others.length} worktree(s)`);
}

function checkDesign() {
  const f = load(join(ROOT, '.claude', 'rules', 'design-system.md'));
  if (!f) { notChecked.push(`Design rules: .claude/rules/design-system.md ${notRead(join(ROOT, '.claude', 'rules', 'design-system.md')) ? 'not read' : 'not found'}.`); return; }
  const holes = (f.text.match(/\{\{[^}]*\}\}/g) || []).length;
  if (holes) warn('DSHOLES', 'design-system', `.claude/rules/design-system.md still has ${holes} unfilled {{…}} value(s); until filled, a verifier holds each to the Baseline row that backs it and lists the rest as not measurable. Fill them from the project's design source.`);
  for (const old of ['.claude/DESIGN-SYSTEM.md', 'DESIGN-SYSTEM.md', join(cfg.siteDir || '.', '.claude', 'DESIGN-SYSTEM.md')]) {
    const v1 = load(join(ROOT, old));
    if (v1) { warn('DSV1', old, `${v1.rel} (v1 design file, ${kb(v1.bytes)}) still exists; verifiers read only .claude/rules/design-system.md. Convert its current rules into that table, then move the old file to an archive.`); break; }
  }
  ran.push(`design rules: ${holes} unfilled values`);
}

const CHECKS = [checkImport, checkSizes, checkShape, checkIds, checkTracked, checkWorktreeCopies, checkDesign, checkBranches, checkSync, checkCopies, checkAging,
  checkUncommitted, checkClientAsks, checkDecisions, checkDeadRefs];

// ── warning age (agingDays.warnAge): remember when each WARN was first seen ───
function stateDir() { const d = join(ROOT, '.claude', '.state'); mkdirSync(d, { recursive: true }); return d; }
function saveJSON(path, obj) { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 1)); renameSync(tmp, path); }
function readJSON(path) { if (offloadState(path) !== 'local') return null; try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function ageWarnings() {
  try {
    const path = join(stateDir(), 'doctor-warn-seen.json');
    const seen = readJSON(path) || {};
    const next = {};
    for (const w of F.filter((x) => x.level === 'WARN')) {
      next[w.key] = seen[w.key] || TODAY;
      const a = age(next[w.key]);
      if (a > cfg.agingDays.warnAge) w.stale = a;
    }
    saveJSON(path, next);
  } catch { notChecked.push('Warning age: could not read or write .claude/.state/doctor-warn-seen.json.'); }
}

// ── output ───────────────────────────────────────────────────────────────────
function lines(level) {
  const out = [], groups = new Map();
  for (const f of F.filter((x) => x.level === level)) {
    if (f.item === undefined) { out.push(f.text + (f.stale ? ` [open ${f.stale} days]` : '')); continue; }
    const g = groups.get(f.text) || { items: [], stale: 0 };
    g.items.push(f.item); g.stale = Math.max(g.stale, f.stale || 0);
    groups.set(f.text, g);
  }
  for (const [text, g] of groups) out.push(`${g.items.length} ${text}: ${g.items.slice(0, 12).join(', ')}${g.items.length > 12 ? ` … +${g.items.length - 12}` : ''}${g.stale ? ` [open ${g.stale} days]` : ''}`);
  return out;
}
const count = (lv) => F.filter((x) => x.level === lv).length;
const HOW = 'node .claude/hooks/clockwork-doctor.mjs --report';

function report() {
  const E = lines('ERROR'), W = lines('WARN');
  const out = [`clockwork-doctor ${VERSION} — ${ROOT}`, `Config: .claude/clockwork.json · registries: ${rel(REG)} · code: ${rel(SITE)} · today ${TODAY}`, '', `Files read (${filesRead.size}):`];
  for (const [p, i] of [...filesRead].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rows = Object.entries(i.rows).map(([k, v]) => `${v} ${k}- rows`).join(', ');
    out.push(`  ${p} — ${kb(i.bytes)}${rows ? `, ${rows}` : ''}`);
  }
  out.push('', 'Checked:', ...ran.map((r) => `  ${r}`), '');
  if (crashed.length) out.push(`CRASHED (${crashed.length}) — these checks did not finish, so their findings are missing:`, ...crashed.map((c) => `  ! ${c}`), '');
  if (E.length) out.push(`ERRORS (${count('ERROR')}) — must be fixed; new ones block the Stop hook:`, ...E.map((e) => `  ✗ ${e}`), '');
  if (W.length) out.push(`WARNINGS (${count('WARN')}) — advisory:`, ...W.map((w) => `  ⚠ ${w}`), '');
  if (notChecked.length) out.push(`NOT CHECKED (${notChecked.length}):`, ...notChecked.map((n) => `  – ${n}`), '');
  out.push(crashed.length ? 'Result: CRASHED — do not read this as clean.' : count('ERROR') ? `Result: ${count('ERROR')} error(s).` : `Result: no errors${count('WARN') ? `, ${count('WARN')} warning(s)` : ''}${notChecked.length ? `; ${notChecked.length} check(s) did not run (listed above)` : ''}.`);
  return out.join('\n');
}
function summary() {
  const cut = (s) => (s.length > 220 ? `${s.slice(0, 217)}…` : s);
  const E = lines('ERROR'), W = lines('WARN');
  const out = [`clockwork-doctor: ${count('ERROR')} error(s), ${count('WARN')} warning(s), ${notChecked.length} not checked${crashed.length ? `, ${crashed.length} CRASHED check(s)` : ''}.`];
  out.push(...E.slice(0, 5).map((e) => `✗ ${cut(e)}`), ...W.slice(0, 4).map((w) => `⚠ ${cut(w)}`));
  if (E.length > 5 || W.length > 4 || notChecked.length || crashed.length) out.push(`Full list: ${HOW}`);
  return out.slice(0, 12).join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────
function runAll() {
  ROOT = findRoot();
  cfg = loadConfig();
  REG = resolve(ROOT, cfg.registryDir || '.claude');
  SITE = resolve(ROOT, cfg.siteDir || '.');
  if (!existsSync(REG)) throw new Error(`registryDir "${cfg.registryDir}" does not exist under ${ROOT}`);
  for (const c of CHECKS) {
    try { c(); } catch (e) { crashed.push(`${c.name}: ${e.message}`); }
  }
  ageWarnings();
}

function baselinePath(sid) { return join(stateDir(), `doctor-baseline-${String(sid).replace(/[^A-Za-z0-9_-]/g, '_')}.json`); }

try {
  runAll();
} catch (e) {
  if (MODE === 'stop') { say({ systemMessage: `clockwork-doctor could not run (${e.message}); the Stop check did not happen.` }); process.exit(0); }
  process.stderr.write(`clockwork-doctor CRASHED: ${e.message}\nNothing was checked. Do not read this as clean.\n`);
  process.exit(2);
}

if (MODE === 'report' || MODE === 'summary') {
  if (argv.includes('--json')) {
    const pick = (lv) => F.filter((x) => x.level === lv).map(({ code, key, text, item, stale }) => ({ code, key, text, item, stale }));
    console.log(JSON.stringify({ version: VERSION, root: ROOT, errors: pick('ERROR'), warns: pick('WARN'), notChecked, crashed, ran, filesRead: Object.fromEntries(filesRead) }, null, 1));
  } else console.log(MODE === 'report' ? report() : summary());
  if (crashed.length) process.stderr.write(`clockwork-doctor: ${crashed.length} check(s) crashed — see CRASHED above.\n`);
  process.exit(crashed.length ? 2 : count('ERROR') ? 1 : 0);
}

const keys = (lv) => F.filter((x) => x.level === lv).map((x) => x.key);
if (MODE === 'baseline') {
  const sid = opt('--session') || payload?.session_id;
  if (!sid) { process.stderr.write('clockwork-doctor: --write-baseline needs --session <id> or a session_id on stdin.\n'); process.exit(2); }
  try {
    const p = baselinePath(sid);
    saveJSON(p, { version: 1, created: new Date().toISOString(), errors: keys('ERROR'), warns: keys('WARN'), reported: [], blocked: [] });
    console.log(`OK baseline ${rel(p)} (${count('ERROR')} errors, ${count('WARN')} warnings)`);
    process.exit(0);
  } catch (e) { process.stderr.write(`clockwork-doctor CRASHED writing the baseline: ${e.message}\n`); process.exit(2); }
}

// Stop mode. Block at most once per new ERROR per session, and never twice in a row: when this Stop follows
// our own block (stop_hook_active + lastBlock), report instead. stop_hook_active alone is not enough to skip:
// /goal is itself a Stop hook, so under /goal (overnight) every later Stop has it set (docs: hooks.md, goal.md).
// Nothing here can tell who made an ERROR (every session commits as the same user), so the block says so.
try {
  const p = baselinePath(payload?.session_id || 'unknown');
  let base = readJSON(p);
  const note = [];
  if (!base || !Array.isArray(base.errors)) { // missing, or not in the --write-baseline format
    base = { version: 1, created: new Date().toISOString(), errors: keys('ERROR'), warns: keys('WARN'), reported: [], blocked: [] };
    note.push('No start-of-session baseline was found, so current findings count as pre-existing and nothing blocks.');
  }
  const fresh = F.filter((x) => x.level === 'ERROR' && !base.errors.includes(x.key) && !(base.blocked || []).includes(x.key));
  const afterOwnBlock = !!payload?.stop_hook_active && !!base.lastBlock;
  if (fresh.length && !afterOwnBlock) {
    base.blocked = [...new Set([...(base.blocked || []), ...fresh.map((x) => x.key)])];
    base.lastBlock = true;
    saveJSON(p, base);
    const text = fresh.map((x) => `  ✗ ${x.item !== undefined ? `${x.text}: ${x.item}` : x.text}`);
    const pre = count('ERROR') - fresh.length;
    say({ decision: 'block', reason: ['clockwork-doctor: these errors appeared while this session was running. They may be a peer session\'s, not yours.',
      ...text,
      `If you caused one, fix it now. A duplicate ID: run ${REGTOOL()} dedupe <ID> (safe if a peer runs it too: the second run finds nothing to fix). If a peer holds that file (its CLAIM message, or registry.mjs claims), send it this finding instead of editing. This blocks once per error.`,
      pre || count('WARN') ? `(Also ${pre} older error(s) and ${count('WARN')} warning(s), not blocking. Full list: ${HOW})` : ''].filter(Boolean).join('\n') });
    process.exit(0);
  }
  base.lastBlock = false;
  const unseen = F.filter((x) => !(base.reported || []).includes(x.key));
  base.reported = [...new Set([...(base.reported || []), ...unseen.map((x) => x.key)])];
  saveJSON(p, base);
  if (unseen.length || note.length || crashed.length) {
    const e = unseen.filter((x) => x.level === 'ERROR').length, w = unseen.length - e;
    say({ systemMessage: [`clockwork-doctor: ${e} error(s) and ${w} warning(s) — not blocking (present when the session started, already blocked once this session, or this Stop follows the doctor's own block).`,
      ...note, ...unseen.filter((x) => x.code === 'NOTREAD' || x.code === 'OFFLOADED').slice(0, 2).map((x) => `${x.text}.`), // offloaded: say which file and how to get it back
      crashed.length ? `${crashed.length} check(s) crashed.` : '', `Full list: ${HOW}`].filter(Boolean).join(' ') });
  }
  process.exit(0);
} catch (e) {
  say({ systemMessage: `clockwork-doctor Stop check failed (${e.message}); nothing was blocked.` });
  process.exit(0);
}
