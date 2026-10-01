#!/usr/bin/env node
// Clockwork installer — seeds or upgrades a project from templates/ (CONTRACT §1, §3, §4).
// Usage: node install.mjs <projectDir> [--stack nextjs|wordpress|python|other] [--project "Name"]
//        [--registry-dir <rel>] [--site-dir <rel>] [--apply] [--adopt] [--allow-synced] [--force-managed]
//        node install.mjs --global-skill [--apply]   (installs /clockwork-onboard for every project on this Mac)
// Default is a DRY RUN: prints the plan, writes nothing. Exit 0 ok · 1 refused / conflicts left · 2 crashed.
// Env (tests): CLOCKWORK_TEMPLATES = templates dir; CLOCKWORK_SYNCED_ROOTS = synced roots (path.delimiter-separated; replaces the defaults).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STACKS = ['nextjs', 'wordpress', 'python', 'other'];
const GITIGNORE = ['.claude/.state/', '.claude/worktrees/', '.claude/.clockwork-backups/', 'PM/.scratch/'];
const MANIFEST = '.claude/.clockwork-manifest.json';
const USAGE = 'Usage: node install.mjs <projectDir> [--stack nextjs|wordpress|python|other] [--project "Name"] [--registry-dir <rel>] [--site-dir <rel>] [--apply] [--adopt] [--allow-synced] [--force-managed]  ·  node install.mjs --global-skill [--apply]';
const REG_NAMES = ['TASKS.md', 'CLIENT.md', 'MEETING-LOG.md'];
const RECORD_FILE = /^(tasks|client|client-requests|facts|meeting-log|open-asks|approval-queue|decisions)\.md$/i;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const fail = (msg, code = 1) => { console.log(`ERR ${msg}`); process.exit(code); };

function parseArgs(argv) {
  const o = { apply: false, adopt: false, allowSynced: false, forceManaged: false, globalSkill: false, dir: null, stack: null, project: null, registryDir: null, siteDir: null };
  const flags = { '--apply': 'apply', '--adopt': 'adopt', '--allow-synced': 'allowSynced', '--force-managed': 'forceManaged', '--global-skill': 'globalSkill' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) o[flags[a]] = true;
    else if (a === '--stack' || a === '--project' || a === '--registry-dir' || a === '--site-dir') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value. ${USAGE}`);
      o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    } else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('-')) fail(`unknown option ${a}. ${USAGE}`);
    else if (o.dir) fail(`only one project directory allowed. ${USAGE}`);
    else o.dir = a;
  }
  if (o.globalSkill) {
    const extra = o.dir ? `a project directory (${o.dir})` : ['adopt', 'allowSynced', 'forceManaged', 'stack', 'project', 'registryDir', 'siteDir'].filter((k) => o[k]).map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ');
    if (extra) fail(`--global-skill takes only --apply, not ${extra}. ${USAGE}`);
    return o;
  }
  if (!o.dir) fail(`no project directory given. ${USAGE}`);
  if (o.stack && !STACKS.includes(o.stack)) fail(`--stack must be one of ${STACKS.join('|')}`);
  return o;
}

// Synced folders: iCloud Drive, CloudStorage (OneDrive, Dropbox, Google Drive), and Desktop/Documents when
// iCloud "Desktop & Documents" sync is on (its Desktop/Documents folders exist under com~apple~CloudDocs).
function syncedRoots() {
  const env = process.env.CLOCKWORK_SYNCED_ROOTS;
  if (env !== undefined) return env.split(path.delimiter).filter(Boolean);
  const h = os.homedir();
  const docs = path.join(h, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const roots = [path.join(h, 'Library', 'Mobile Documents'), path.join(h, 'Library', 'CloudStorage')];
  if (exists(path.join(docs, 'Desktop')) || exists(path.join(docs, 'Documents'))) roots.push(path.join(h, 'Desktop'), path.join(h, 'Documents'));
  return roots;
}
function syncedRootOf(real) {
  const norm = (p) => (process.platform === 'darwin' ? p.toLowerCase() : p);
  for (const r of syncedRoots()) {
    let rr = path.resolve(r);
    try { rr = fs.realpathSync(rr); } catch { /* root missing: compare as written */ }
    if (norm(real) === norm(rr) || norm(real).startsWith(norm(rr + path.sep))) return r;
  }
  return null;
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}
// "TASKS 2.md" next to "TASKS.md" = an iCloud conflict copy.
const dupOf = (name) => { const m = /^(.+) \d+(\.[^.]+)?$/.exec(name); return m ? m[1] + (m[2] || '') : null; };

function detectStack(dir) {
  try {
    const pkg = readJson(path.join(dir, 'package.json'));
    if ({ ...pkg.dependencies, ...pkg.devDependencies }.next) return ['nextjs', 'package.json lists next'];
  } catch { /* no package.json */ }
  if (exists(path.join(dir, 'wp-config.php')) || exists(path.join(dir, 'wp-content'))) return ['wordpress', 'wp-config.php / wp-content found'];
  if (['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => exists(path.join(dir, f)))) return ['python', 'python project file found'];
  return ['other', 'nothing detected — pass --stack to choose'];
}

// Classify one template path (relative to templates/) per CONTRACT §1. Returns null for unmapped files.
function classify(rel, stack, registryDir) {
  if (rel === 'AGENTS.md' || rel === 'CLAUDE.md') return { kind: 'owned', dest: rel };
  if (rel === 'clockwork.json') return { kind: 'config', dest: '.claude/clockwork.json' };
  if (rel === 'worktreeinclude') return { kind: 'lines', dest: '.worktreeinclude' };
  if (rel.startsWith('registries/')) return { kind: 'owned', dest: path.posix.join(registryDir, rel.slice('registries/'.length)) };
  if (!rel.startsWith('claude/')) return null;
  const sub = rel.slice('claude/'.length);
  const dest = `.claude/${sub}`;
  if (sub === 'settings.json') return { kind: 'settings', dest };
  if (sub === 'rules/design-system.md' || sub === 'skills/intake/routing.md') return { kind: 'owned', dest };
  const m = /^rules\/stack-([^/]+)\.md$/.exec(sub);
  if (m && m[1] !== stack) return { kind: 'skip', dest, note: `stack profile for ${m[1]}, project is ${stack}` };
  return { kind: 'managed', dest };
}

// settings.json merge: add hook handlers whose command is missing; never remove or reorder.
// Hook shape (https://code.claude.com/docs/en/hooks#configuration): hooks.<Event>[] = { matcher?, hooks: [{ type, command, timeout? }] }.
// A handler that runs the same .claude/hooks/<file> with a different command string counts as present (no double run).
const script = (cmd) => (/\.claude\/hooks\/([\w.-]+)/.exec(cmd || '') || [])[1] || null;
function mergeSettings(cur, tpl) {
  const out = structuredClone(cur);
  const added = []; const differs = [];
  for (const [k, v] of Object.entries(tpl)) {
    if (k === 'hooks') continue;
    if (!(k in out)) { out[k] = structuredClone(v); added.push(`setting ${k}`); continue; }
    if (k === 'permissions' && v && typeof v === 'object') {
      for (const [pk, pv] of Object.entries(v)) {
        if (!Array.isArray(pv)) continue;
        if (!Array.isArray(out.permissions[pk])) { if (!(pk in out.permissions)) { out.permissions[pk] = [...pv]; added.push(`permissions.${pk}`); } continue; }
        for (const rule of pv) if (!out.permissions[pk].includes(rule)) { out.permissions[pk].push(rule); added.push(`permissions.${pk} ${rule}`); }
      }
    }
  }
  for (const [ev, groups] of Object.entries(tpl.hooks || {})) {
    for (const g of groups) {
      let target = null;
      for (const h of g.hooks || []) {
        const have = (out.hooks?.[ev] || []).flatMap((x) => x.hooks || []);
        if (have.some((x) => x.command === h.command)) continue;
        const same = have.find((x) => script(x.command) && script(x.command) === script(h.command));
        if (same) { differs.push(`${ev} runs ${script(h.command)} with your own command — kept yours; kit uses: ${h.command}`); continue; }
        out.hooks ??= {};
        out.hooks[ev] ??= [];
        target ??= out.hooks[ev].find((x) => (x.matcher ?? '') === (g.matcher ?? ''));
        if (!target) { target = { ...structuredClone(g), hooks: [] }; out.hooks[ev].push(target); }
        target.hooks.push(structuredClone(h));
        added.push(`${ev} ${script(h.command) || h.command}`);
      }
    }
  }
  return { out, added, differs };
}

function linesMerge(curText, tplLines) {
  const norm = (l) => l.trim().replace(/^\//, '').replace(/\/$/, '');
  const have = new Set(curText.split(/\r?\n/).map(norm));
  return tplLines.filter((l) => l.trim() && !l.trim().startsWith('#') && !have.has(norm(l)));
}

// --global-skill: installs the onboarding skill for every project on this Mac (decision D16). Personal skills live at
// ~/.claude/skills/<name>/SKILL.md (https://code.claude.com/docs/en/skills.md, read 2026-09-30). The copied SKILL.md
// records this kit's absolute path as its default KIT ($CLOCKWORK_KIT still wins); clockwork-kit.json is the version
// stamp. A changed copy is backed up to ~/.claude/clockwork-backups/ first: a backup inside ~/.claude/skills/ would
// load as a second skill with the same frontmatter name.
const SKILL_FILES = ['SKILL.md', 'mapping.md', 'plan-template.md', 'workflows'];
function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r)); else if (e.isFile()) out.push(r);
  }
  return out;
}
function globalSkill(apply) {
  const KIT = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.join(KIT, 'onboard');
  const dest = path.join(os.homedir(), '.claude', 'skills', 'clockwork-onboard');
  let version = 'unknown';
  try { version = fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim() || version; } catch { /* stays unknown */ }
  for (const f of SKILL_FILES) if (!exists(path.join(SRC, f))) fail(`${path.join(SRC, f)} is missing; nothing written`);
  if (/["}$`\\\n]/.test(KIT)) fail(`the kit path ${KIT} holds a character the skill's shell lines cannot carry; move the kit`);
  // What the skill folder must hold: every source file, SKILL.md with this kit as its default KIT.
  const want = new Map();
  for (const f of SKILL_FILES) {
    const rels = fs.statSync(path.join(SRC, f)).isDirectory() ? listFiles(SRC, f) : [f];
    for (const r of rels) want.set(r, fs.readFileSync(path.join(SRC, r)));
  }
  const skill = want.get('SKILL.md').toString('utf8');
  const recorded = /KIT="\$\{CLOCKWORK_KIT:-([^}"]+)\}"/.exec(skill)?.[1];
  if (!recorded) fail(`onboard/SKILL.md has no KIT="\${CLOCKWORK_KIT:-…}" line, so the copy could not find the kit; nothing written`);
  want.set('SKILL.md', Buffer.from(skill.split(recorded).join(KIT)));
  const stamp = { skill: 'clockwork-onboard', clockworkVersion: version, kit: KIT, installedAt: new Date().toISOString(), files: Object.fromEntries([...want].map(([r, b]) => [r, sha(b)])) };
  // Up to date = same files, same bytes, same kit and version (the date does not count).
  let current = false, had = [];
  if (exists(dest)) {
    had = listFiles(dest);
    let old = null; try { old = readJson(path.join(dest, 'clockwork-kit.json')); } catch { /* no stamp: treat as changed */ }
    current = old?.kit === KIT && old?.clockworkVersion === version && had.filter((r) => r !== 'clockwork-kit.json').sort().join('\n') === [...want.keys()].sort().join('\n')
      && [...want].every(([r, b]) => sha(fs.readFileSync(path.join(dest, r))) === sha(b));
  }
  console.log(`Global skill: /clockwork-onboard ${version} → ${dest}`);
  console.log(`  kit recorded in SKILL.md: ${KIT} (a set $CLOCKWORK_KIT still wins)`);
  if (current) { console.log('OK global skill already current; nothing to do'); return 0; }
  const backup = had.length ? path.join(os.homedir(), '.claude', 'clockwork-backups', `clockwork-onboard-${new Date().toISOString().replace(/[:.]/g, '-')}`) : '';
  if (backup) console.log(`  existing copy (${had.length} file(s)) → backup ${backup}, then replaced`);
  for (const r of want.keys()) console.log(`  write ${r}`);
  console.log('  write clockwork-kit.json (version stamp)');
  if (!apply) { console.log('OK dry run: nothing written; add --apply'); return 0; }
  if (backup) { fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.cpSync(dest, backup, { recursive: true, errorOnExist: true, force: false }); }
  // Write the new copy beside the old one, then swap, so a crash never leaves half a skill.
  const tmp = `${dest}.installing-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [r, b] of want) { fs.mkdirSync(path.dirname(path.join(tmp, r)), { recursive: true }); fs.writeFileSync(path.join(tmp, r), b); }
  fs.writeFileSync(path.join(tmp, 'clockwork-kit.json'), `${JSON.stringify(stamp, null, 2)}\n`);
  if (exists(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  console.log(`OK installed /clockwork-onboard ${version}${backup ? `; old copy in ${backup}` : ''}`);
  return 0;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.globalSkill) return globalSkill(o.apply);
  const KIT = path.dirname(fileURLToPath(import.meta.url));
  const TPL = path.resolve(process.env.CLOCKWORK_TEMPLATES || path.join(KIT, 'templates'));
  if (!fs.existsSync(TPL)) fail(`templates folder not found: ${TPL}`);
  const dir = path.resolve(o.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`project directory does not exist: ${dir}`);
  const real = fs.realpathSync(dir);
  const P = (rel) => path.join(dir, rel);
  const notices = []; const fixes = [];

  let cfg = null;
  if (exists(P('.claude/clockwork.json'))) {
    try { cfg = readJson(P('.claude/clockwork.json')); } catch (e) { notices.push(`.claude/clockwork.json is not valid JSON (${e.message}) — using defaults; fix it by hand`); }
  }
  let stack = o.stack || cfg?.stack; let stackWhy = o.stack ? '--stack' : 'clockwork.json';
  if (!stack) [stack, stackWhy] = detectStack(dir);
  if (!STACKS.includes(stack)) fail(`stack "${stack}" in clockwork.json is not one of ${STACKS.join('|')}; pass --stack`);
  const project = o.project || cfg?.project || path.basename(dir);
  for (const k of ['registryDir', 'siteDir']) if (o[k] && (path.isAbsolute(o[k]) || o[k].split(/[\\/]/).includes('..'))) fail(`--${k === 'siteDir' ? 'site' : 'registry'}-dir must be a path inside the project`);
  if (cfg && (o.registryDir || o.siteDir)) notices.push('--registry-dir/--site-dir ignored: .claude/clockwork.json exists and is project-owned — edit it by hand');
  const registryDir = (cfg?.registryDir || o.registryDir || '.claude').replace(/\/+$/, '');
  // Registries that already live somewhere else (e.g. a sub-repo's .claude/): creating empty skeletons at
  // registryDir would make a second, empty copy that sessions then mint into (CONTRACT §3: one copy).
  const elsewhere = [];
  if (!cfg && !o.registryDir && !REG_NAMES.some((f) => exists(path.join(dir, registryDir, f)))) {
    let subs = [];
    try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { /* unreadable */ }
    for (const s of subs) if (REG_NAMES.some((f) => exists(path.join(dir, s, '.claude', f)))) elsewhere.push(`${s}/.claude`);
  }
  if (o.stack && cfg?.stack && o.stack !== cfg.stack) notices.push(`--stack ${o.stack} differs from clockwork.json (${cfg.stack}); clockwork.json is project-owned and is not changed — edit "stack" there by hand`);

  let manifest = null;
  if (exists(P(MANIFEST))) {
    try { manifest = readJson(P(MANIFEST)); if (!manifest.files) throw new Error('no "files" key'); } catch (e) { fail(`${MANIFEST} is unreadable (${e.message}); fix it or delete it and re-run with --adopt`); }
  }
  const isV1 = !manifest && exists(P('.claude/hooks/clockwork-doctor.mjs'));
  let version = '';
  try { version = fs.readFileSync(path.join(path.dirname(TPL), 'VERSION'), 'utf8').trim(); } catch { /* fall back below */ }
  if (!version) { try { version = readJson(path.join(TPL, 'clockwork.json')).clockworkVersion || ''; } catch { /* none */ } }
  version ||= 'unknown';

  // The config this install uses: the project's own clockwork.json, else the template filled in below.
  const fillCfg = (j) => {
    j.clockworkVersion = version === 'unknown' ? j.clockworkVersion : version;
    j.project = project; j.stack = stack;
    if (o.registryDir) j.registryDir = registryDir;
    if (o.siteDir) j.siteDir = o.siteDir.replace(/\/+$/, '') || '.';
    if (j.overnight) j.overnight.sessionName = `${project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'}-overnight`;
    return j;
  };
  let effCfg = cfg;
  if (!effCfg) { try { effCfg = fillCfg(readJson(path.join(TPL, 'clockwork.json'))); } catch { effCfg = {}; } }
  // New project-owned .md files: fill {{a.b}} placeholders from that config. Empty or missing values stay as
  // placeholders (AGENTS.md line 3 tells agents to read clockwork.json), so nothing is guessed.
  // AGENTS.md names the stack profile "if shipped": for a stack with no profile (other, python) the pointer is dropped,
  // so no file names a path that does not exist.
  const stackShips = fs.existsSync(path.join(TPL, 'claude', 'rules', `stack-${stack}.md`));
  const fillText = (text) => text.replace(/\{\{([\w.]+)\}\}/g, (m, k) => {
    const v = k.split('.').reduce((o, x) => (o && typeof o === 'object' ? o[x] : undefined), effCfg);
    return (typeof v === 'string' && v.trim()) || typeof v === 'number' ? String(v) : m;
  }).replace(/ · `\.claude\/rules\/stack-([\w-]+)\.md` if shipped/g, (m, s) => (stackShips && s === stack ? ` · \`.claude/rules/stack-${s}.md\`` : ''));

  // Other folders a live registry may sit in (root .claude, siteDir/.claude, <sub>/.claude).
  const regDirsElsewhere = [...new Set(['.claude', path.posix.join((effCfg.siteDir || '.'), '.claude'),
    ...(() => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => `${e.name}/.claude`); } catch { return []; } })()])]
    .map((d) => path.posix.normalize(d)).filter((d) => d !== path.posix.normalize(registryDir));

  // Build the plan.
  const plan = []; // { action, dest, note, write?: Buffer, mode?, backup?, hash? }
  const newFiles = {};
  const seen = new Set();
  for (const rel of walk(TPL)) {
    const base = path.posix.basename(rel);
    if (base === '.DS_Store') continue;
    const dupBase = dupOf(base);
    if (dupBase && exists(path.join(TPL, path.dirname(rel), dupBase))) { plan.push({ action: 'skip', dest: rel, note: 'looks like an iCloud conflict copy in the kit — not installed' }); continue; }
    const c = classify(rel, stack, registryDir);
    if (!c) { plan.push({ action: 'skip', dest: `templates/${rel}`, note: 'not mapped by CONTRACT §1' }); continue; }
    if (c.kind === 'skip') { plan.push({ action: 'skip', dest: c.dest, note: c.note }); continue; }
    const src = path.join(TPL, rel);
    const mode = fs.statSync(src).mode & 0o111 ? 0o755 : null;
    let buf = fs.readFileSync(src);
    const d = P(c.dest);
    const present = exists(d);
    seen.add(c.dest);

    if (c.kind === 'owned' || c.kind === 'config') {
      if (present) { plan.push({ action: 'keep', dest: c.dest, note: 'project-owned, never overwritten', registry: rel.startsWith('registries/') }); continue; }
      if (rel.startsWith('registries/')) { // one copy only: never seed a skeleton next to a live registry elsewhere
        const other = regDirsElsewhere.find((rd) => exists(path.join(dir, rd, base)));
        if (other) { plan.push({ action: 'skip', dest: c.dest, note: `${other}/${base} exists — one copy only: move it into ${registryDir}/ by hand` }); continue; }
      }
      if (c.kind === 'config') buf = Buffer.from(JSON.stringify(fillCfg(JSON.parse(buf.toString('utf8'))), null, 2) + '\n');
      else if (rel.endsWith('.md')) buf = Buffer.from(fillText(buf.toString('utf8')));
      plan.push({ action: 'create', dest: c.dest, note: 'project-owned', write: buf, mode, registry: rel.startsWith('registries/') });
    } else if (c.kind === 'settings') {
      if (!present) { plan.push({ action: 'create', dest: c.dest, write: buf }); continue; }
      let cur;
      try { cur = readJson(d); } catch (e) { plan.push({ action: 'conflict', dest: c.dest, note: `not valid JSON (${e.message}) — fix by hand, then re-run` }); continue; }
      const { out, added, differs } = mergeSettings(cur, JSON.parse(buf.toString('utf8')));
      notices.push(...differs.map((x) => `settings.json: ${x}`));
      if (added.length) plan.push({ action: 'merge', dest: c.dest, note: `adds ${added.join(', ')}`, write: Buffer.from(JSON.stringify(out, null, 2) + '\n') });
      else plan.push({ action: 'keep', dest: c.dest, note: 'all kit hooks already wired' });
    } else if (c.kind === 'lines') {
      if (!present) { plan.push({ action: 'create', dest: c.dest, write: buf }); continue; }
      const cur = fs.readFileSync(d, 'utf8');
      const miss = linesMerge(cur, buf.toString('utf8').split(/\r?\n/));
      if (!miss.length) { plan.push({ action: 'keep', dest: c.dest, note: 'has every kit line' }); continue; }
      plan.push({ action: 'merge', dest: c.dest, note: `appends ${miss.join(' ')}`, write: Buffer.from(cur + (cur.endsWith('\n') || !cur ? '' : '\n') + miss.join('\n') + '\n') });
    } else { // managed
      const h = sha(buf);
      const cur = present ? sha(fs.readFileSync(d)) : null;
      const rec = manifest?.files?.[c.dest];
      const entry = { dest: c.dest, write: buf, mode, hash: h };
      if (cur === null) { plan.push({ ...entry, action: 'create', note: rec ? 'was deleted locally — restoring' : '' }); newFiles[c.dest] = h; }
      else if (cur === h) { plan.push({ action: 'keep', dest: c.dest, note: 'up to date' }); newFiles[c.dest] = h; }
      else if (manifest && rec && cur === rec) { plan.push({ ...entry, action: 'replace', note: 'kit update, no local edits' }); newFiles[c.dest] = h; }
      else if ((!manifest && o.adopt) || o.forceManaged) { plan.push({ ...entry, action: 'replace', backup: true, note: `${o.forceManaged ? '--force-managed' : '--adopt'}: current copy backed up first` }); newFiles[c.dest] = h; }
      else {
        const why = rec ? 'edited locally since install — kept; --force-managed backs it up and replaces it'
          : isV1 ? 'v1 file — re-run with --adopt' : 'exists but was not installed by the kit — kept; --adopt (no manifest) or --force-managed replaces it';
        plan.push({ action: 'conflict', dest: c.dest, note: why });
        if (rec) newFiles[c.dest] = rec;
      }
    }
  }
  // .gitignore (CONTRACT §3): state, worktrees, installer backups.
  {
    const d = P('.gitignore');
    if (!exists(d)) plan.push({ action: 'create', dest: '.gitignore', write: Buffer.from(`# Clockwork\n${GITIGNORE.join('\n')}\n`) });
    else {
      const cur = fs.readFileSync(d, 'utf8');
      const miss = linesMerge(cur, GITIGNORE);
      if (miss.length) plan.push({ action: 'merge', dest: '.gitignore', note: `appends ${miss.join(' ')}`, write: Buffer.from(cur + (cur.endsWith('\n') || !cur ? '' : '\n') + `# Clockwork\n${miss.join('\n')}\n`) });
      else plan.push({ action: 'keep', dest: '.gitignore', note: 'has every kit line' });
    }
  }
  for (const f of Object.keys(manifest?.files || {})) if (!seen.has(f)) notices.push(`${f} is no longer shipped by the kit — left in place; delete it by hand if nothing uses it`);

  // Checks that print a fix but edit nothing.
  if (exists(P('CLAUDE.md'))) {
    const first = fs.readFileSync(P('CLAUDE.md'), 'utf8').split(/\r?\n/)[0].trim();
    if (first !== '@AGENTS.md') fixes.push('CLAUDE.md: make line 1 exactly "@AGENTS.md" — Claude Code ignores AGENTS.md when a CLAUDE.md exists without that import (https://code.claude.com/docs/en/memory#agents-md). Not edited.');
  }
  for (const d of [...new Set(['.', '.claude', registryDir])]) {
    let names = [];
    try { names = fs.readdirSync(P(d)); } catch { continue; }
    for (const n of names) { const b = dupOf(n); if (b && names.includes(b)) notices.push(`${path.posix.join(d, n)} looks like an iCloud conflict copy of ${b} — compare and delete by hand`); }
  }
  // A v1 design file stays where it is, unread by verifiers and by path-scoped loading (D8: the table is the only home).
  for (const old of [...new Set(['.claude/DESIGN-SYSTEM.md', 'DESIGN-SYSTEM.md', path.posix.join(effCfg.siteDir || '.', '.claude/DESIGN-SYSTEM.md')])]) {
    if (!exists(P(old))) continue;
    fixes.push(`${old} (v1 design file, ${(fs.statSync(P(old)).size / 1024).toFixed(1)} KB) is not read by verifiers or rule loading: convert its current rules into .claude/rules/design-system.md (one row each, with how to measure), then move it to an archive folder. Not edited.`);
    break;
  }
  if (!fs.existsSync(path.join(TPL, 'claude', 'rules', `stack-${stack}.md`))) notices.push(`no stack profile ships for "${stack}" (only ${fs.readdirSync(path.join(TPL, 'claude', 'rules')).map((f) => /^stack-(.+)\.md$/.exec(f)?.[1]).filter(Boolean).join(' and ')}): write this project's stack traps into AGENTS.md or its own .claude/rules/ file`);
  try { if (fs.statSync(P('.git')).isFile()) notices.push('this folder is a linked git worktree, not the main checkout — registries must live in the main checkout (CONTRACT §3)'); } catch { /* not git */ }
  const synced = syncedRootOf(real);
  // D15: a live project with its own records moves to Clockwork only through onboarding (/clockwork-onboard), which
  // stages a copy, installs there, and applies after the user's review. Its staging copy carries .clockwork-onboard/.
  const staging = exists(P('.clockwork-onboard')) || exists(P('staging-manifest.json'));
  // Own records = registries in registryDir, or a task list / client log / decision log of the project's own at the
  // root or in docs/ (installing next to it would start a second, empty one). An AGENTS.md or CLAUDE.md alone does not
  // count: create-next-app writes AGENTS.md into every new Next.js project.
  const ownRecords = manifest || cfg ? [] : [...REG_NAMES.map((f) => path.posix.join(registryDir, f)).filter((f) => exists(P(f))),
    ...['.', 'docs', 'doc'].flatMap((d) => { try { return fs.readdirSync(P(d)).filter((n) => RECORD_FILE.test(n)).map((n) => path.posix.join(d, n)); } catch { return []; } })];
  const hasRecords = !manifest && !cfg && (isV1 || ownRecords.length > 0);
  const liveAdopt = (o.adopt || hasRecords) && !staging;
  // A kit path that .gitignore ignores is not committed, so a worktree does not get it from git. A project may ignore
  // .claude/ on purpose (decision D13): .worktreeinclude (merged below) then copies the kit into every worktree
  // Claude Code makes, and the tools always write the main copy. Tracked files are not subject to ignore rules.
  // Registries are left out: the main copy is the only one (CONTRACT §3), so an ignored registry is fine as it is.
  const kitPaths = () => [...new Set([...plan.filter((x) => ['create', 'replace', 'merge', 'keep', 'conflict'].includes(x.action) && !x.registry).map((x) => x.dest), MANIFEST])]
    .filter((d) => d !== '.gitignore' && !d.startsWith('templates/'));
  const ignoredKit = (paths = kitPaths()) => {
    const r = spawnSync('git', ['-C', dir, 'check-ignore', '-v', '--stdin'], { input: paths.join('\n') + '\n', encoding: 'utf8', timeout: 5000 });
    if (r.error || (r.status !== 0 && r.status !== 1)) return null; // not a repository, or git failed: nothing to say
    // -v also prints the "!pattern" line that RE-INCLUDES a path; such a path is not ignored (git add works).
    return r.stdout.split('\n').filter(Boolean).map((l) => { const m = /^(.*?):(\d+):(.*?)\t(.*)$/.exec(l); return m && !m[3].startsWith('!') && { rule: `${m[1]}:${m[2]} "${m[3]}"`, path: m[4] }; }).filter(Boolean);
  };
  const ignoredText = (ig) => `${ig.length} kit path(s) are gitignored by ${[...new Set(ig.map((x) => x.rule))].join(', ')} (${ig.slice(0, 6).map((x) => x.path).join(', ')}${ig.length > 6 ? ' …' : ''}). `
    + 'Keeping them ignored is fine (decision D13): .worktreeinclude copies them into every worktree Claude Code makes (claude -w, subagent worktrees), and the tools always write the main copy. They are left out of the commit command. A worktree made by hand with git worktree add gets none of them: make worktrees with claude -w';
  const preIgnored = ignoredKit();

  // Report.
  const count = (a) => plan.filter((x) => x.action === a).length;
  console.log(`Clockwork ${version} → ${dir}`);
  console.log(`project "${project}" · stack ${stack} (${stackWhy}) · registries in ${registryDir}/ · ${o.apply ? 'APPLY' : 'DRY RUN (nothing is written)'}`);
  if (synced) {
    console.log(`\n!!! WARNING: this project is inside a synced folder (${synced}).`);
    console.log('!!! git can hang indefinitely on files iCloud/OneDrive has offloaded, and the sync creates');
    console.log(`!!! 'name 2.md' duplicate copies of registries and git refs. Move the project to a folder that is not synced (e.g. ~/dev/).`);
    console.log(o.allowSynced ? '!!! --allow-synced given: continuing anyway.\n' : '!!! --apply refuses this path unless you add --allow-synced.\n');
  }
  if (elsewhere.length) console.log(`!!! Registries found in ${elsewhere.join(', ')} but not in ${registryDir}/. --apply refuses until you pass --registry-dir "${elsewhere[0]}", so no second, empty copy is created.`);
  if (preIgnored?.length) console.log(`NOTE  ${ignoredText(preIgnored)}.`);
  if (liveAdopt) console.log(`!!! This folder already holds a project's own records (${isV1 ? 'Clockwork v1' : [...new Set(ownRecords)].slice(0, 4).join(', ')}). Existing projects move to Clockwork 2 only through onboarding (decision D15): run /clockwork-onboard in a Claude Code session there. It stages a copy, installs and migrates in the copy, and changes the real folder only after you approve. --apply refuses here.`);
  if (isV1) console.log(`v1 project detected (.claude/hooks/clockwork-doctor.mjs, no manifest). ${o.adopt ? '--adopt: replaced files are backed up to .claude/.clockwork-backups/ first.' : '--apply needs --adopt.'}`);
  const w = Math.max(4, ...plan.map((x) => x.dest.length));
  console.log(`\n${'ACTION'.padEnd(9)}${'PATH'.padEnd(w + 2)}NOTE`);
  for (const x of plan) console.log(`${x.action.padEnd(9)}${x.dest.padEnd(w + 2)}${x.note || ''}`.trimEnd());
  for (const n of notices) console.log(`NOTE  ${n}`);
  for (const f of fixes) console.log(`FIX   ${f}`);
  const totals = ['create', 'replace', 'merge', 'keep', 'conflict', 'skip'].map((a) => `${count(a)} ${a}`).join(' · ');
  console.log(`\n${totals}`);

  if (!o.apply) { console.log('OK dry run — nothing written. Re-run with --apply to do this.'); return 0; }
  if (synced && !o.allowSynced) fail('refused: synced folder (see warning above). Nothing written.');
  if (liveAdopt) fail('refused: existing project — onboard it with /clockwork-onboard (decision D15); install --adopt runs only on its staging copy. Nothing written.');
  if (isV1 && !o.adopt) fail('refused: v1 project needs --adopt (backs up the v1 files, then replaces them). Nothing written.');
  if (elsewhere.length) fail(`refused: registries already exist in ${elsewhere.join(', ')}, not in ${registryDir}/. Re-run with --registry-dir "${elsewhere[0]}" (and --site-dir if the code lives there too). Nothing written.`);

  // Apply: backups first, then atomic writes (temp file + rename), then verify by re-reading.
  let backupDir = null;
  const todo = plan.filter((x) => x.write);
  for (const x of todo.filter((t) => t.backup)) {
    if (!backupDir) {
      const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      backupDir = P(`.claude/.clockwork-backups/${ts}`);
      for (let i = 2; exists(backupDir); i++) backupDir = P(`.claude/.clockwork-backups/${ts}-${i}`);
    }
    const b = path.join(backupDir, x.dest);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(P(x.dest), b);
    if (sha(fs.readFileSync(b)) !== sha(fs.readFileSync(P(x.dest)))) fail(`backup of ${x.dest} did not verify; stopped before replacing anything else`, 2);
  }
  const writeAtomic = (dest, buf, mode) => {
    const d = P(dest);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    const tmp = `${d}.clockwork-tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    if (mode) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, d);
    if (sha(fs.readFileSync(d)) !== sha(buf)) fail(`${dest} did not verify after writing`, 2);
  };
  for (const x of todo) writeAtomic(x.dest, x.write, x.mode);
  const sorted = Object.fromEntries(Object.keys(newFiles).sort().map((k) => [k, newFiles[k]]));
  const next = JSON.stringify({ version, files: sorted }, null, 2) + '\n';
  const prev = exists(P(MANIFEST)) ? fs.readFileSync(P(MANIFEST), 'utf8') : null;
  if (next !== prev) writeAtomic(MANIFEST, Buffer.from(next));
  if (backupDir) console.log(`backups: ${path.relative(dir, backupDir)}/`);
  const conflicts = count('conflict');
  if (conflicts) { console.log(`ERR applied ${todo.length} change(s), but ${conflicts} conflict(s) left untouched — see table`); return 1; }
  // Worktrees hold only committed files, and `claude -w` branches from origin's default branch
  // (docs: worktrees.md, worktree.baseRef "fresh"): an uncommitted or unpushed install is missing from every worktree.
  const ignored = ignoredKit() || [];
  const allWritten = [...new Set([...todo.map((x) => x.dest), ...(next !== prev ? [MANIFEST] : [])])];
  const ignoredSet = new Set((ignoredKit(allWritten) || []).map((x) => x.path)); // registries too: git add refuses any ignored path
  const written = allWritten.filter((f) => !ignoredSet.has(f));
  if (written.length) {
    const q = (a) => `"${a}"`;
    const gitOut = (args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout.trim() : null; };
    const isRepo = gitOut(['rev-parse', '--is-inside-work-tree']) === 'true';
    const remote = isRepo && (gitOut(['remote']) || '').split('\n').includes('origin');
    console.log('NEXT  commit the install before starting any worktree session: a worktree has only committed files' + (remote ? ', and `claude -w` starts from origin\'s default branch, so push too' : '') + '.');
    console.log(`NEXT  ${isRepo ? '' : `git -C ${q(dir)} init && `}git -C ${q(dir)} add -- ${written.map(q).join(' ')} && git -C ${q(dir)} commit -m "Install Clockwork ${version}"${remote ? ` && git -C ${q(dir)} push` : ''}`);
  }
  if (ignored.length) console.log(`NOTE  ${ignoredText(ignored)}.`);
  console.log(`OK applied ${todo.length} change(s)${next !== prev ? ', manifest updated' : ''}`);
  return 0;
}

try { process.exitCode = main(); } catch (e) { console.log(`ERR crash: ${e.stack || e.message}`); process.exitCode = 2; }
