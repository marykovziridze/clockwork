#!/usr/bin/env node
// Clockwork guard-bash (PreToolUse, matcher "Bash|Monitor"). Managed file: do not edit in a project.
//
// Formats (verified 2026-09-30 against https://code.claude.com/docs/en/hooks.md):
//  - stdin: { session_id, cwd, hook_event_name:"PreToolUse", tool_name:"Bash"|"Monitor", tool_input:{command,...} }
//    Monitor runs a shell command too (tools-reference.md "Monitor tool": same permission rules as Bash), so it is judged
//    the same way; a Monitor call with a WebSocket (`ws`) and no command is not a shell command and passes.
//  - deny: exit 2 + reason on stderr blocks the call; we also print the JSON form
//    { hookSpecificOutput:{ hookEventName:"PreToolUse", permissionDecision:"deny"|"ask", permissionDecisionReason } }
//  - exit 0 with stderr only is invisible to Claude, so a fail-open warning goes out as JSON "systemMessage".
//  - "ask" forces a prompt even in auto mode, so with OVERNIGHT=1 (nobody there to answer) ask becomes deny.
//
// What it does: parses the command like a shell (quotes, heredocs, $(...), backticks, bash -c, eval,
// env/sudo/nohup wrappers, `git -C dir`, && || ; | newline) and judges only real commands.
// Text inside echo/printf/heredoc bodies/commit messages is data and is never judged.
//
// Overnight (OVERNIGHT=1) production commands = clockwork.json productionPatterns + each command in
// commands.productionDeploy + any script whose name contains "deploy" (python/node/bash/php … <script>, ./deploy-x.sh,
// npm|pnpm|yarn|bun run <deploy|release|publish script>) unless it is the project's commands.previewDeploy,
// + any interpreter-run script whose content uploads (FTP, SFTP/SCP/rsync, curl -T, WordPress REST writes) or runs a
// deploy-named script, + direct uploads typed as commands: curl -T/--upload-file, curl writes to wp-json/xmlrpc,
// scp/sftp/lftp/ftp, rsync to a remote host, wp --ssh or wp @alias, make/just targets named deploy|release|publish,
// ssh to a non-local host, curl form/data/method writes and wget/HTTPie writes to a remote host, inline -c/-e code
// that uploads or POSTs to a remote URL, and scripts that run a remote command over ssh.
// In a main checkout that other worktrees use, commands that throw away uncommitted work (reset --hard, restore of a
// folder (checked on disk), a registry or PM file, clean -f) are asked about like checkout/switch (denied overnight).
// Any session: a shell write onto a registry file (redirect, sed -i, perl -i, tee, cp/mv/rm) is asked (denied
// overnight): registries are written by registry.mjs only (AGENTS.md hard rule 3).
//
// Not covered (a seatbelt, not a boundary; the permission system and auto mode are the other layers):
// `$VAR add -A` (program unknown), git inside `bash script.sh`, `curl ... | sh`, `node -e 'execSync("git ...")'`,
// git aliases, shell functions, and what a script run by name does (`./up.sh` is not read; `bash up.sh` is: WHY.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// iCloud may offload project files ("dataless": size but no blocks). Reading one waits for a download that can last
// forever, and this hook runs before EVERY Bash and Monitor call, so one offloaded file would freeze them all. The kit's
// one check is registry.mjs offloadState (loaded only if registry.mjs itself is local; otherwise the same rule inline).
// This hook reads two kinds of project file: .claude/clockwork.json (loadConfig) and, overnight, the script an
// interpreter runs (uploadingScript). Neither is ever read while offloaded; what happens instead is written there.
const REG_TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'registry.mjs');
const bareOffload = (p) => { try { const s = fs.statSync(p); return s.isFile() && s.size > 0 && s.blocks === 0 ? 'offloaded' : 'local'; } catch (e) { return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable'; } };
let REG = null;
if (bareOffload(REG_TOOL) === 'local') { try { REG = await import(pathToFileURL(REG_TOOL).href); } catch { /* inline rule below */ } }
const offloadState = REG?.offloadState || bareOffload;
const offloadNote = REG?.offloadNote || ((p) => `not checked: ${p} is offloaded by iCloud — open it in Finder or run \`brctl download "${p}"\`, then re-run`);

const MAIN_BRANCHES = new Set(['main', 'master']);
const HOOKED_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert']);
const DEFAULT_PRODUCTION_PATTERNS = ['vercel --prod', 'vercel deploy --prod', 'gh pr merge', 'git push [^ ]+ [^ ]*:main'];
const MAX_DEPTH = 6;

// ---------------------------------------------------------------- shell parser
// parseShell(src) -> flat list of simple commands in execution order:
//   { words:[{s,dyn,quoted}], assigns:[string], redirs:[{op,target,body,quoted}], sep }
// sep = the operator that came before the command (null | '&&' | '||' | ';' | '\n' | '|' | '&').
export function parseShell(src, initSep = null, depth = 0) {
  const out = [];
  if (depth > MAX_DEPTH) return out;
  parseInto(src, 0, null, out, initSep, depth);
  return out;
}

function parseInto(src, start, closer, out, initSep, depth) {
  const n = src.length;
  let i = start;
  let cmd = { words: [], assigns: [], redirs: [], sep: null };
  let sepForCmd = initSep;
  let w = null;
  let pendingRedir = null;
  const pendingHeredocs = [];

  const ensureWord = () => { if (!w) w = { s: '', dyn: false, quoted: false, assign: false }; };
  // a quote or escape after "NAME=" keeps the word an env assignment (FOO="x y" git ...)
  const markQuoted = () => { if (!w.quoted && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.s)) w.assign = true; w.quoted = true; };
  const endWord = () => {
    if (!w) return;
    const word = w; w = null;
    if (pendingRedir) {
      pendingRedir.target = word.s;
      pendingRedir.quoted = word.quoted;
      cmd.redirs.push(pendingRedir);
      if (pendingRedir.op === '<<' || pendingRedir.op === '<<-') pendingHeredocs.push(pendingRedir);
      pendingRedir = null;
      return;
    }
    if (cmd.words.length === 0 && (!word.quoted || word.assign) && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.s)) cmd.assigns.push(word.s);
    else cmd.words.push(word);
  };
  const finishCmd = (term) => {
    endWord();
    pendingRedir = null;
    if (cmd.words.length || cmd.assigns.length || cmd.redirs.length) {
      cmd.sep = sepForCmd;
      out.push(cmd);
      sepForCmd = term;
      cmd = { words: [], assigns: [], redirs: [], sep: null };
    }
  };
  const readHeredocs = () => {
    while (pendingHeredocs.length) {
      const h = pendingHeredocs.shift();
      const lines = [];
      let pos = i;
      while (pos < n) {
        let e = src.indexOf('\n', pos);
        const line = src.slice(pos, e < 0 ? n : e);
        pos = e < 0 ? n : e + 1;
        const cmp = h.op === '<<-' ? line.replace(/^\t+/, '') : line;
        if (cmp === h.target) break;
        lines.push(line);
      }
      i = pos;
      h.body = lines.join('\n');
      // An unquoted delimiter means the body is expanded: $(...) and backticks inside it DO run.
      if (!h.quoted) scanExpansions(h.body, out, sepForCmd, depth + 1);
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < n) { ensureWord(); markQuoted(); w.s += src[i + 1]; i += 2; continue; }
      i++; continue;
    }
    if (c === "'") {
      ensureWord(); markQuoted();
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      w.s += src.slice(i + 1, end);
      i = end + 1; continue;
    }
    if (c === '"') {
      ensureWord(); markQuoted();
      i = readDouble(src, i + 1, w, out, sepForCmd, depth);
      continue;
    }
    if (c === '$') {
      const d = src[i + 1];
      if (d === "'") { // ANSI-C quoting $'...'
        ensureWord(); markQuoted();
        i += 2;
        while (i < n && src[i] !== "'") {
          if (src[i] === '\\' && i + 1 < n) {
            const e = src[i + 1];
            w.s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
            i += 2;
          } else { w.s += src[i]; i++; }
        }
        i++; continue;
      }
      if (d === '"') { i++; continue; }
      if (d === '(') {
        ensureWord(); w.dyn = true;
        if (src[i + 2] === '(') { w.s += '$((…))'; i = skipArith(src, i + 3); continue; }
        w.s += '$(…)';
        i = parseInto(src, i + 2, ')', out, sepForCmd, depth + 1);
        continue;
      }
      if (d === '{') {
        ensureWord(); w.dyn = true; w.s += '${…}';
        i = skipBraces(src, i + 2); continue;
      }
      if (d !== undefined && /[A-Za-z_0-9@*#?!$-]/.test(d)) {
        ensureWord(); w.dyn = true;
        let j = i + 1;
        if (/[A-Za-z_]/.test(d)) { while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++; } else j++;
        w.s += src.slice(i, j); i = j; continue;
      }
      ensureWord(); w.s += '$'; i++; continue;
    }
    if (c === '`') {
      const { text, end } = readBacktick(src, i + 1);
      ensureWord(); w.dyn = true; w.s += '`…`';
      parseInto(text, 0, null, out, sepForCmd, depth + 1);
      i = end + 1; continue;
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      ensureWord(); w.dyn = true; w.s += c + '(…)';
      i = parseInto(src, i + 2, ')', out, sepForCmd, depth + 1);
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      if (w && /^\d+$/.test(w.s) && !w.quoted) w = null; else endWord();
      let op = c; i++;
      if (c === '&') { op = '&>'; i++; if (src[i] === '>') { op += '>'; i++; } }
      else if (c === '>') {
        if (src[i] === '>') { op += '>'; i++; } else if (src[i] === '|') { op += '|'; i++; } else if (src[i] === '&') { op += '&'; i++; }
      } else if (src[i] === '<') {
        op += '<'; i++;
        if (src[i] === '<') { op += '<'; i++; } else if (src[i] === '-') { op += '-'; i++; }
      } else if (src[i] === '&') { op += '&'; i++; } else if (src[i] === '>') { op += '>'; i++; }
      pendingRedir = { op, target: '', body: null, quoted: false };
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '\n') {
      endWord(); finishCmd('\n'); i++;
      readHeredocs();
      continue;
    }
    if (c === ';') {
      endWord(); finishCmd(';'); i++;
      while (src[i] === ';' || src[i] === '&') i++;
      continue;
    }
    if (c === '&') {
      endWord();
      if (src[i + 1] === '&') { finishCmd('&&'); i += 2; } else { finishCmd('&'); i++; }
      continue;
    }
    if (c === '|') {
      endWord();
      if (src[i + 1] === '|') { finishCmd('||'); i += 2; } else if (src[i + 1] === '&') { finishCmd('|'); i += 2; } else { finishCmd('|'); i++; }
      continue;
    }
    if (c === '(') { // a "(" that starts a word is a subshell opener ("time (cmd)", "! (cmd)", "(cmd)"); inside a word it is literal ("f(", "a=(1 2)")
      if (!w) { i++; continue; }
      w.s += c; i++; continue;
    }
    if (c === ')') {
      endWord();
      if (closer === ')') { finishCmd(null); return i + 1; }
      if (!w && cmd.words.length === 0) { i++; continue; }
      finishCmd(null); i++; continue;
    }
    if (c === '#' && !w) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    ensureWord(); w.s += c; i++;
  }
  finishCmd(null);
  return n;
}

function readDouble(src, i, w, out, sep, depth) {
  const n = src.length;
  while (i < n && src[i] !== '"') {
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') { i += 2; continue; }
      if (d === '$' || d === '`' || d === '"' || d === '\\') { w.s += d; i += 2; continue; }
      w.s += c; i++; continue;
    }
    if (c === '$') {
      const d = src[i + 1];
      if (d === '(') {
        w.dyn = true;
        if (src[i + 2] === '(') { w.s += '$((…))'; i = skipArith(src, i + 3); continue; }
        w.s += '$(…)';
        i = parseInto(src, i + 2, ')', out, sep, depth + 1);
        continue;
      }
      if (d === '{') { w.dyn = true; w.s += '${…}'; i = skipBraces(src, i + 2); continue; }
      if (d !== undefined && /[A-Za-z_]/.test(d)) {
        w.dyn = true;
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        w.s += src.slice(i, j); i = j; continue;
      }
      w.s += c; i++; continue;
    }
    if (c === '`') {
      const { text, end } = readBacktick(src, i + 1);
      w.dyn = true; w.s += '`…`';
      parseInto(text, 0, null, out, sep, depth + 1);
      i = end + 1; continue;
    }
    w.s += c; i++;
  }
  return i + 1;
}

function readBacktick(src, i) {
  let j = i; let text = '';
  while (j < src.length && src[j] !== '`') {
    if (src[j] === '\\' && (src[j + 1] === '`' || src[j + 1] === '\\' || src[j + 1] === '$')) { text += src[j + 1]; j += 2; continue; }
    text += src[j]; j++;
  }
  return { text, end: j };
}

function skipArith(src, i) { // after "$((" ; returns index after the closing "))"
  let depth = 2;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++; else if (src[i] === ')') depth--;
    i++;
  }
  return i;
}

function skipBraces(src, i) { // after "${" ; returns index after the matching "}"
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++; else if (src[i] === '}') depth--;
    i++;
  }
  return i;
}

function scanExpansions(body, out, sep, depth) {
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === '\\') { k++; continue; }
    if (c === '$' && body[k + 1] === '(' && body[k + 2] !== '(') { k = parseInto(body, k + 2, ')', out, sep, depth) - 1; continue; }
    if (c === '`') { const { text, end } = readBacktick(body, k + 1); parseInto(text, 0, null, out, sep, depth); k = end; }
  }
}

// ---------------------------------------------------------------- normalising commands
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const base = (s) => s.replace(/\/+$/, '').split('/').pop();

function skipFlags(words, argFlags = new Set()) {
  let i = 0;
  while (i < words.length && words[i].s.startsWith('-') && words[i].s.length > 1) {
    const f = words[i].s; i++;
    if (f === '--') break;
    if (argFlags.has(f)) i++;
  }
  return words.slice(i);
}

// Returns the words after the wrapper, or null when the command does not run anything (e.g. `command -v`).
function unwrap(prog, words, assigns) {
  switch (prog) {
    case 'command': case 'builtin':
      if (words[0] && (words[0].s === '-v' || words[0].s === '-V')) return null;
      return skipFlags(words);
    case 'exec': case 'nohup': case 'setsid': case 'time': case 'caffeinate': case 'unbuffer': case 'coproc':
      return skipFlags(words);
    case 'sudo': case 'doas':
      return skipFlags(words, new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t']));
    case 'nice': return skipFlags(words, new Set(['-n']));
    case 'ionice': return skipFlags(words, new Set(['-c', '-n', '-p']));
    case 'stdbuf': return skipFlags(words, new Set(['-i', '-o', '-e']));
    case 'watch': return skipFlags(words, new Set(['-n', '-d']));
    case 'xargs': return skipFlags(words, new Set(['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a']));
    case 'timeout': { const r = skipFlags(words, new Set(['-s', '-k'])); return r.slice(1); }
    case 'env': {
      let rest = skipFlags(words, new Set(['-u', '-C', '-S', '--unset', '--chdir']));
      while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].s)) { assigns.push(rest[0].s); rest = rest.slice(1); }
      return rest;
    }
    case 'npx': case 'bunx': case 'pnpx': return skipFlags(words, new Set(['-p', '--package']));
    case 'pnpm': case 'npm': case 'yarn': case 'bun':
      if (words[0] && ['exec', 'dlx', 'x'].includes(words[0].s)) return skipFlags(words.slice(1));
      if (words[0] && words[0].s === 'vercel') return words;
      return undefined; // not a wrapper
    default: return undefined;
  }
}

function findDashC(args) {
  for (let k = 0; k < args.length; k++) {
    const s = args[k].s;
    if (s === '--') return undefined;
    if (/^-[A-Za-z]+$/.test(s) && s.includes('c')) return args[k + 1] ? args[k + 1].s : undefined;
    if (s === '-o' || s === '+o' || s === '-O' || s === '+O') { k++; continue; }
    if (!s.startsWith('-') && !s.startsWith('+')) return undefined;
  }
  return undefined;
}

// Flattens parsed commands (recursing into bash -c / eval / shell heredocs) into
// entries { prog, args:[string], argw, sep, assigns, vdir }.
function flatten(cmds, ctx, res, state, depth) {
  for (const c of cmds) {
    let words = c.words.slice();
    const assigns = c.assigns.slice();
    while (words.length && !words[0].quoted && RESERVED.has(words[0].s)) words.shift();
    let ok = true;
    for (let guard = 0; guard < 12 && words.length; guard++) {
      if (words[0].dyn) break;
      const p = base(words[0].s);
      const rest = unwrap(p, words.slice(1), assigns);
      if (rest === undefined) break;
      if (rest === null) { ok = false; break; }
      words = rest;
      while (words.length && !words[0].quoted && RESERVED.has(words[0].s)) words.shift();
    }
    if (!ok || !words.length || words[0].dyn) continue;
    const prog = base(words[0].s);
    const args = words.slice(1);
    if (SHELLS.has(prog)) {
      const script = findDashC(args);
      if (script !== undefined) { flatten(parseShell(script, c.sep, depth + 1), ctx, res, state, depth + 1); continue; }
      for (const r of c.redirs) {
        if ((r.op === '<<' || r.op === '<<-') && r.body != null) flatten(parseShell(r.body, c.sep, depth + 1), ctx, res, state, depth + 1);
        else if (r.op === '<<<') flatten(parseShell(r.target, c.sep, depth + 1), ctx, res, state, depth + 1);
      }
      // `bash deploy.sh`: the script is not read, but its name is judged (overnight deploy scripts)
      if (args.some((a) => !a.s.startsWith('-'))) res.push({ prog, args: args.map((a) => a.s), argw: args, sep: c.sep, assigns, vdir: state.vdir, redirs: c.redirs });
      continue;
    }
    if (prog === 'eval') {
      flatten(parseShell(args.map((a) => a.s).join(' '), c.sep, depth + 1), ctx, res, state, depth + 1);
      continue;
    }
    res.push({ prog, args: args.map((a) => a.s), argw: args, sep: c.sep, assigns, vdir: state.vdir, redirs: c.redirs });
    if (prog === 'cd' || prog === 'pushd') {
      const t = args.find((a) => !a.s.startsWith('-'));
      if (!t || t.dyn || t.s === '-') state.vdir = null;
      else state.vdir = path.resolve(state.vdir || ctx.cwd, t.s.startsWith('~') ? path.join(os.homedir(), t.s.slice(1)) : t.s);
    }
  }
}

// ---------------------------------------------------------------- git helpers
function parseGit(args) {
  const g = { dirs: [], cfgs: [], sub: null, rest: [] };
  let i = 0;
  const longArg = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
  while (i < args.length) {
    const s = args[i];
    if (s === '-C') { g.dirs.push(args[i + 1] || ''); i += 2; continue; }
    if (s === '-c') { g.cfgs.push(args[i + 1] || ''); i += 2; continue; }
    if (s.startsWith('-c') && s.includes('=') && !s.startsWith('--')) { g.cfgs.push(s.slice(2)); i++; continue; }
    if (longArg.has(s)) { i += 2; continue; }
    if (s.startsWith('-')) { i++; continue; }
    break;
  }
  g.sub = args[i] === undefined ? null : args[i];
  g.rest = args.slice(i + 1);
  return g;
}

function scanOpts(rest, { shortArg = '', shortOptional = '', longArg = new Set() } = {}) {
  const flags = []; const pos = [];
  let dd = false;
  for (let i = 0; i < rest.length; i++) {
    const s = rest[i];
    if (dd) { pos.push(s); continue; }
    if (s === '--') { dd = true; continue; }
    if (s.startsWith('--')) {
      const eq = s.indexOf('=');
      const name = eq < 0 ? s : s.slice(0, eq);
      flags.push(name);
      if (eq < 0 && longArg.has(name)) i++;
      continue;
    }
    if (s.length > 1 && s[0] === '-' && !/^-\d/.test(s)) {
      for (let k = 1; k < s.length; k++) {
        const ch = s[k];
        flags.push('-' + ch);
        if (shortArg.includes(ch)) { if (k === s.length - 1) i++; break; }
        if (shortOptional.includes(ch)) break;
      }
      continue;
    }
    pos.push(s);
  }
  return { flags, pos };
}

const isLong = (f, full, min) => f.length >= min && full.startsWith(f);
const isNoVerify = (f) => isLong(f, '--no-verify', 7);
const SWEEP = /^(\.{1,2}\/*|\*|:\/|:\(top\))$/;
const EXCLUDE_ONLY = /^:(\(exclude\)|!|\^)/;

function git(dir, args, timeout = 3000) {
  try {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim();
  } catch { return null; }
}

function realp(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

function mainCheckoutWithPeers(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  const list = git(dir, ['worktree', 'list', '--porcelain']);
  if (!top || !list) return null;
  const entries = list.split(/\n\s*\n/).map((b) => {
    const lines = b.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '));
    return wt ? { path: wt.slice(9), prunable: lines.some((l) => l.startsWith('prunable')) } : null;
  }).filter(Boolean);
  if (!entries.length) return null;
  const others = entries.slice(1).filter((e) => !e.prunable).length;
  if (others < 1) return null;
  return realp(top) === realp(entries[0].path) ? { others } : null;
}

function effectiveDir(e, g, ctx) {
  let d = e.vdir || ctx.cwd;
  for (const x of g.dirs) d = path.resolve(d, x);
  return d;
}

// ---------------------------------------------------------------- rules
const REGTOOL = 'node "$CLOCKWORK_TOOLS/registry.mjs"';
const R = {
  addSweep: (what) => `Blocked: "git add ${what}" stages every file in the checkout, including other sessions' unfinished work. Stage exact paths instead: git add <file> <file> && git commit -m "…".`,
  commitAll: 'Blocked: "git commit -a" stages every tracked change, including other sessions\' work. Stage exact paths first: git add <file> <file> && git commit -m "…".',
  noVerify: 'Blocked: git hooks must not be skipped (--no-verify, -n, core.hooksPath, HUSKY=0). Fix what the hook reports, then commit again. If the gate itself is broken, tell the user; do not bypass it.',
  stash: 'Blocked: "git stash" is shared by every worktree and has swallowed other sessions\' files. Commit on your own branch (git add <file> && git commit) or work in your own worktree (claude -w <task>).',
  forceMain: 'Blocked: this push rewrites, overwrites or deletes main, which every session builds on. Push your own branch (git push -u origin <branch>) and open a pull request. If main really needs a rewrite, the user runs it themselves.',
  checkout: (n) => `You are in the main checkout and ${n} other worktree(s) exist. Switching branches here changes the files under every session using this checkout. Work in your own worktree instead: claude -w <task> (or git worktree add .claude/worktrees/<task> -b <branch>).`,
  discard: (t, n) => `"${t}" throws away uncommitted changes in the main checkout, which ${n} other worktree session(s) share, and they cannot be got back. Undo only your own file: git restore -- <exact path>. Work in your own worktree (claude -w <task>).`,
  chain: (t) => `Blocked: "${t}" runs after ";", a newline, "||" or "&", so it still runs when the step before it failed. Join the steps with &&, e.g. <previous step> && ${t}.`,
  offloadedScript: (t, p) => `Blocked during an overnight run: "${t}" runs ${p}, which iCloud has offloaded, so it could not be checked for uploads to a live server (reading it here could wait forever). Download it first: brctl download "${p}" (or open it in Finder), then run the command again.`,
  overnight: (t) => `Blocked during an overnight run: "${t}" changes production or main, and the user is not here to approve it. Queue it instead: ${REGTOOL} mint A --title "<exact one-line change, and why it waits for the user>" (OPEN-ASKS, as the overnight skill says), then carry on with other work. A preview is allowed: push your own branch by name (git push -u origin <branch>), or run exactly clockwork.json commands.previewDeploy.`,
  registry: (f) => `"${f}" is a registry file; registries are written only with registry.mjs, under its lock, so parallel sessions never overwrite each other's rows (AGENTS.md hard rule 3). Use it instead: rows ${REGTOOL} mint/append/status, other lines ${REGTOOL} line <FILE> --section "## …" --text "…" [--replace "<old line>"], a duplicate ${REGTOOL} dedupe <ID>. Approve only a hand edit the user asked for.`,
};

const VERCEL_VALUE_FLAGS = new Set(['--scope', '-S', '--token', '-t', '--cwd', '-A', '--local-config', '-Q', '--global-config', '--team']);
const VERCEL_SUBS = new Set(['list', 'ls', 'inspect', 'logs', 'env', 'pull', 'link', 'login', 'logout', 'whoami', 'dns', 'domains', 'certs', 'alias', 'secrets', 'bisect', 'build', 'dev',
  'project', 'projects', 'teams', 'switch', 'rm', 'remove', 'help', 'curl', 'open', 'install', 'integration', 'init', 'git', 'redeploy']);
// A production deploy: `vercel [path] --prod`, `vercel deploy --prod|--target production`, `vercel promote|rollback`.
// `vercel ls --prod` and other sub-commands only read, so they are not deploys.
function isVercelProd(e) {
  if (e.prog !== 'vercel') return false;
  const pos = []; let prod = false;
  for (let k = 0; k < e.args.length; k++) {
    const a = e.args[k];
    if (a === '--prod' || a === '--production' || a.startsWith('--prod=') || a === '--target=production') prod = true;
    else if (a === '--target') { if (e.args[k + 1] === 'production') prod = true; k++; }
    else if (VERCEL_VALUE_FLAGS.has(a)) k++;
    else if (!a.startsWith('-')) pos.push(a);
  }
  const sub = pos[0];
  if (sub === 'promote' || sub === 'rollback') return true;
  return prod && (sub === undefined || sub === 'deploy' || !VERCEL_SUBS.has(sub));
}
const isGhMerge = (e) => {
  if (e.prog !== 'gh') return false;
  const a = [];
  for (let k = 0; k < e.args.length; k++) { if (e.args[k] === '-R' || e.args[k] === '--repo') { k++; continue; } a.push(e.args[k]); }
  return a[0] === 'pr' && a[1] === 'merge';
};

const INTERP = new Set(['python', 'node', 'bash', 'sh', 'zsh', 'php', 'ruby', 'perl', 'deno', 'bun', 'tsx', 'ts-node']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// A script named for deploying (deploy-theme-ftp.py, deploy_rooms_guarded.py, ./deploy.sh, npm run deploy:prod).
export function isDeployScript(e) {
  const bn = (w) => path.basename(String(w || ''));
  const words = [e.prog];
  if (INTERP.has(bn(e.prog).replace(/[\d.]+$/, ''))) words.push(e.args.find((a) => !a.startsWith('-')));
  if (words.some((w) => w && /deploy/i.test(bn(w)))) return true;
  if (RUNNERS.has(e.prog)) {
    const a = e.args.filter((x) => !x.startsWith('-'));
    const name = a[0] === 'run' || a[0] === 'run-script' ? a[1] : e.prog !== 'npm' ? a[0] : null;
    if (name && /deploy|release|publish/i.test(name) && !/preview|staging|dev\b/i.test(name)) return true;
  }
  return false;
}
// Overnight only: a script not named for deploying can still upload to a live server (an FTP patch script, a REST
// push). The script file is read (first 512 KB) and judged by what it does. Returns the reason, or null.
const UPLOAD_SIGNS = [
  [/\bstorbinary\s*\(|\bFTP_TLS\b|\bftplib\b/, 'an FTP upload'],
  [/\bparamiko\b|\bpysftp\b|^\s*(?:lftp|sftp|scp)\s|\brsync\b[^\n]*\s[\w.-]+@[\w.-]+:/m, 'an SFTP/SCP/rsync upload'],
  [/\bcurl\b[^\n]*(?:\s-T\s|--upload-file)/, 'a curl upload'],
  [/['"\s/]deploy[\w.-]*\.(?:py|sh|js|mjs|php|rb)\b/i, 'a call to a deploy script'],
  [/^\s*(?:\w+=\S*\s+)*ssh\s+(?:-\S+\s+(?:\S+\s+)?)*[\w.-]*@?[\w.-]+\s+\S/m, 'an ssh remote command'],
];
const REST_WRITE = /\brequests\.(?:post|put|patch|delete)\s*\(|method\s*[=:]\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\s-X\s*(?:POST|PUT|PATCH|DELETE)\b/;
// The script file an interpreter runs (python3 x.py, bash up.sh …), resolved; null when no interpreter is named in
// front of it (./up.sh run by name is not read: a limit WHY.md states).
function scriptOf(e, cwd) {
  if (!INTERP.has(path.basename(String(e.prog || '')).replace(/[\d.]+$/, ''))) return null;
  const arg = e.args.find((a) => !a.startsWith('-'));
  return arg ? path.resolve(e.vdir || cwd || process.cwd(), arg) : null;
}
// Overnight: that script, when iCloud has offloaded it (never read: evaluate() denies the command, see R.offloadedScript).
export function offloadedScript(e, cwd) {
  const p = scriptOf(e, cwd);
  return p && offloadState(p) === 'offloaded' ? p : null;
}
export function uploadingScript(e, cwd) {
  const p = scriptOf(e, cwd);
  if (!p || offloadState(p) === 'offloaded') return null;
  const arg = e.args.find((a) => !a.startsWith('-'));
  let text;
  try {
    const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    text = buf.toString('utf8', 0, n);
  } catch { return null; }
  for (const [re, what] of UPLOAD_SIGNS) if (re.test(text)) return `${path.basename(arg)} contains ${what}`;
  if (/wp-json/.test(text) && REST_WRITE.test(text)) return `${path.basename(arg)} writes through the WordPress REST API`;
  return null;
}
// Overnight only: an upload typed as a command, not inside a script. Returns what it is, or null.
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|[\w.-]+\.(?:local|test|localhost))$/i;
const hostOf = (u) => { const m = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^/:?#]+)/i.exec(u); return m ? m[1] : null; };
const REMOTE_TARGET = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)/; // user@host:path or host:path (rsync, scp)
export function directUpload(e) {
  const a = e.args, bn = path.basename(String(e.prog || ''));
  if (bn === 'curl') {
    const urls = a.filter((x) => /^[a-z][\w+.-]*:\/\//i.test(x)), remote = urls.some((u) => { const h = hostOf(u); return h && !LOCAL_HOST.test(h); });
    if (!remote) return null;
    if (a.some((x) => x === '-T' || x === '--upload-file' || /^-T./.test(x) || x.startsWith('--upload-file='))) return 'a curl upload';
    if (/^(?:s?ftp|scp|sftp):/i.test(urls[0] || '')) return 'an FTP upload';
    const method = a.some((x, k) => (x === '-X' || x === '--request') && /^(POST|PUT|PATCH|DELETE)$/i.test(a[k + 1] || '')) || a.some((x) => /^-X(POST|PUT|PATCH|DELETE)$/i.test(x) || /^--request=(POST|PUT|PATCH|DELETE)$/i.test(x));
    const data = a.some((x) => /^(-d|-F|--data(-raw|-binary|-urlencode)?|--form|--json)(=|$)/.test(x) || /^-[dF]./.test(x));
    if ((method || data) && urls.some((u) => /\/wp-json\/|xmlrpc\.php/i.test(u))) return 'a WordPress REST/XML-RPC write';
    return remoteWrite(e);
  }
  if (['scp', 'sftp', 'lftp', 'ftp', 'ncftpput'].includes(bn)) return `${bn} (a file transfer to another machine)`;
  if (bn === 'rsync' && a.some((x) => !x.startsWith('-') && (REMOTE_TARGET.test(x) || /^rsync:\/\//.test(x)))) return 'rsync to a remote host';
  if (bn === 'wp' && a.some((x) => /^--ssh(=|$)/.test(x) || /^--http(=|$)/.test(x) || /^@[\w.-]+$/.test(x))) return 'WP-CLI on a remote site (--ssh, --http or @alias)';
  if ((bn === 'make' || bn === 'just') && a.some((x) => !x.startsWith('-') && !x.includes('=') && /deploy|release|publish/i.test(x) && !/preview|staging|dev\b/i.test(x))) return `a ${bn} target named for deploying`;
  return remoteWrite(e);
}
// Round 3: typed commands that change another machine without an upload word: a remote command over ssh (a WordPress
// deploy by `git pull` on the server), curl form/data/method writes, wget --post-*, HTTPie writes, and inline code
// (python -c, node -e, php -r …) that uploads or sends a POST/PUT/PATCH/DELETE to a remote URL.
const SSH_ARG = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B', '-P']);
const WRITE_METHOD = /^(POST|PUT|PATCH|DELETE)$/i;
const remoteUrl = (x) => { const h = /^[a-z][\w+.-]*:\/\//i.test(x) ? hostOf(x) : null; return !!h && !LOCAL_HOST.test(h); };
const INLINE_FLAG = { python: ['-c'], node: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval'], deno: ['eval'], php: ['-r'], ruby: ['-e'], perl: ['-e', '-E'], bash: ['-c'], sh: ['-c'], zsh: ['-c'] };
function remoteWrite(e) {
  const a = e.args, bn = path.basename(String(e.prog || ''));
  if (bn === 'ssh' || bn === 'mosh') {
    let k = 0; while (k < a.length && a[k].startsWith('-')) { if (SSH_ARG.has(a[k])) k++; k++; }
    const host = (a[k] || '').replace(/^[^@]*@/, '');
    if (host && !LOCAL_HOST.test(host) && !/^(github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com)$/i.test(host)) return `${bn} to ${host}${a.length > k + 1 ? ' running a remote command' : ''} (it can change the live server)`;
    return null;
  }
  if (bn === 'curl' && a.some(remoteUrl)) {
    const method = a.some((x, k) => (x === '-X' || x === '--request') && WRITE_METHOD.test(a[k + 1] || '')) || a.some((x) => /^-X(POST|PUT|PATCH|DELETE)$/i.test(x) || /^--request=(POST|PUT|PATCH|DELETE)$/i.test(x));
    const data = a.some((x) => /^(-d|-F|--data(-raw|-binary|-urlencode|-ascii)?|--form(-string)?|--json)(=|$)/.test(x) || /^-[dF]./.test(x));
    if (method || data) return 'a curl write (form, data or a POST/PUT/PATCH/DELETE) to a remote host';
  }
  if (bn === 'wget' && a.some(remoteUrl) && a.some((x) => /^--post-(data|file)(=|$)/.test(x) || /^--method=(POST|PUT|PATCH|DELETE)$/i.test(x) || /^--body-(data|file)(=|$)/.test(x))) return 'a wget write to a remote host';
  if (['http', 'https', 'xh', 'xhs'].includes(bn)) {
    const pos = a.filter((x) => !x.startsWith('-'));
    const url = pos.find((x) => /^[a-z][\w+.-]*:\/\//i.test(x) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(x) || /^:\d/.test(x)) || '';
    const host = hostOf(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    const writes = WRITE_METHOD.test(pos[0] || '') || pos.some((x) => x !== url && /^[^=:\s]+(:=|=|@)/.test(x));
    if (host && !LOCAL_HOST.test(host) && !/^:\d/.test(url) && writes) return `an HTTPie write to ${host}`;
  }
  const lang = path.basename(String(e.prog || '')).replace(/[\d.]+$/, '');
  const flags = INLINE_FLAG[lang];
  if (flags) {
    const i = a.findIndex((x) => flags.includes(x));
    const code = i >= 0 ? a[i + 1] || '' : '';
    if (code) {
      for (const [re, what] of UPLOAD_SIGNS) if (re.test(code)) return `inline ${lang} code with ${what}`;
      const urls = code.match(/https?:\/\/[^\s'"`)]+/g) || [];
      if (urls.some(remoteUrl) && (REST_WRITE.test(code) || /\b(?:urlopen|Request)\s*\([^)]*data\s*=/.test(code))) return `inline ${lang} code that writes to a remote URL`;
    }
  }
  return null;
}

// Hard rule 3: registry files are written only by registry.mjs (under its lock). A shell write onto one (redirect,
// sed -i, perl -i, awk -i inplace, tee, cp/rsync/dd onto it, mv from or onto it, rm, inline python/node code that
// writes it) is asked about by day and denied overnight. Returns the file, or null.
const WRITERS = { tee: 'all', cp: 'last', mv: 'all', install: 'last', rsync: 'last', ditto: 'last', rm: 'all', unlink: 'all', truncate: 'all',
  sed: 'inplace', gsed: 'inplace', perl: 'inplace', awk: 'awk', gawk: 'awk', dd: 'of' };
const REG_NAME_IN_CODE = /[\w./~-]*\b(?:TASKS|CLIENT|CLIENT-REQUESTS|FACTS|MEETING-LOG|OPEN-ASKS|APPROVAL-QUEUE|DOC-MAP|ROUTING)(?:-ARCHIVE)?\.md\b/;
const CODE_WRITES = /open\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]|\.write_text\s*\(|\.write_bytes\s*\(|\bwrite(?:File|FileSync)?\s*\(|\bappendFile(?:Sync)?\s*\(|\b(?:unlink|rename|remove|truncate|rmSync|move|copy(?:file|2)?|copyFileSync)\s*\(|\bFile\.write|\bBun\.write/;
export function registryWrite(e, cwd, regDirName = '.claude') {
  const isReg = (p) => {
    if (!p || /[$`]/.test(p)) return null;
    const abs = path.resolve(e.vdir || cwd || process.cwd(), p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
    const d = path.basename(path.dirname(abs));
    return REGISTRY_FILE.test(path.basename(abs)) && (d === '.claude' || d === path.basename(regDirName)) ? p : null;
  };
  for (const r of e.redirs || []) if (/^(>|>>|>\||&>|&>>|\d>|\d>>)$/.test(r.op) && isReg(r.target)) return r.target;
  const bn = path.basename(String(e.prog || '')), how = WRITERS[bn];
  const flags = INLINE_FLAG[bn.replace(/[\d.]+$/, '')];
  if (flags) { // python3 -c "open('.claude/TASKS.md','w')…", node -e "fs.writeFileSync('.claude/TASKS.md', …)"
    const i = e.args.findIndex((x) => flags.includes(x)), code = i >= 0 ? e.args[i + 1] || '' : '';
    const m = REG_NAME_IN_CODE.exec(code);
    if (m && CODE_WRITES.test(code)) return m[0];
  }
  if (!how) return null;
  const files = e.args.filter((x) => !x.startsWith('-'));
  if (how === 'of') return e.args.map((x) => (x.startsWith('of=') ? isReg(x.slice(3)) : null)).find(Boolean) || null;
  if (how === 'awk') return e.args.some((x, k) => (x === '-i' && e.args[k + 1] === 'inplace') || x === '-iinplace' || x === '--include=inplace') ? files.map(isReg).find(Boolean) || null : null;
  if (how === 'inplace') return e.args.some((x) => /^-[a-zA-Z]*i/.test(x) || x.startsWith('--in-place')) ? files.map(isReg).find(Boolean) || null : null;
  if (how === 'last') return isReg(files[files.length - 1]);
  return files.map(isReg).find(Boolean) || null;
}
// The simple commands inside a configured command line ("cd site && python3 deploy.py" -> ["python3 deploy.py"]).
export function commandTexts(line) {
  const res = [];
  flatten(parseShell(String(line || '')), { cwd: process.cwd() }, res, { vdir: null }, 0);
  return res.filter((e) => e.prog !== 'cd' && e.prog !== 'pushd').map((e) => cmdText(e, e.prog === 'git' ? parseGit(e.args) : null));
}

function cmdText(e, g) {
  const clip = (a) => (/\s/.test(a) ? '"…"' : a);
  if (g) return ['git', g.sub, ...g.rest.map(clip)].filter((x) => x != null).join(' ');
  return [e.prog, ...e.args.map(clip)].join(' ');
}

function compilePatterns(list, warnings) {
  const out = [];
  for (const p of list) {
    try { out.push(new RegExp('^(?:' + p + ')')); } catch {
      warnings.push(`productionPatterns entry is not a valid regex and was matched as plain text: ${p}`);
      out.push(new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
  return out;
}

function pushInfo(g, dir, overnight) {
  const { flags, pos } = scanOpts(g.rest, { shortArg: 'o', longArg: new Set(['--push-option', '--repo', '--receive-pack', '--exec']) });
  const force = flags.some((f) => f === '-f' || f === '--force' || f.startsWith('--force-with-lease') || f === '--force-if-includes');
  const mirror = flags.includes('--mirror');
  const all = flags.includes('--all') || flags.includes('--branches');
  const del = flags.includes('-d') || flags.includes('--delete');
  const refspecs = pos.slice(1);
  let curBranch; // lazy
  const current = () => { if (curBranch === undefined) curBranch = git(dir, ['branch', '--show-current']) || ''; return curBranch; };
  let targetsMain = false; let rewritesMain = false;
  if (mirror) { targetsMain = true; rewritesMain = true; }
  if (all) { targetsMain = true; if (force) rewritesMain = true; }
  if (!refspecs.length && !all && !mirror && (force || overnight)) {
    if (MAIN_BRANCHES.has(current())) { targetsMain = true; if (force) rewritesMain = true; }
  }
  for (const r of refspecs) {
    const plus = r.startsWith('+');
    const r2 = plus ? r.slice(1) : r;
    const colon = r2.indexOf(':');
    let dst = colon < 0 ? r2 : r2.slice(colon + 1);
    const deletion = colon === 0 || (del && colon < 0);
    dst = dst.replace(/^refs\/heads\//, '');
    if (dst === 'HEAD') dst = current();
    const hitsMain = MAIN_BRANCHES.has(dst) || dst.includes('*');
    if (!hitsMain) continue;
    targetsMain = true;
    if (force || plus || deletion) rewritesMain = true;
  }
  return { force, targetsMain, rewritesMain };
}

function checkGit(e, g, ctx) {
  const found = [];
  const sub = g.sub;
  if (!sub) return found;
  const hooksBypass = (HOOKED_SUBS.has(sub)) && (
    g.cfgs.some((c) => /^core\.hookspath\s*=/i.test(c))
    || e.assigns.some((a) => /^HUSKY=0$/.test(a) || /^GIT_CONFIG_(KEY|VALUE)_\d+=.*core\.hookspath/i.test(a)));
  if (hooksBypass) found.push({ deny: R.noVerify });
  if (sub === 'config') { // pointing core.hooksPath elsewhere switches every hook off for the repository
    const { flags, pos } = scanOpts(g.rest, {});
    const writes = pos.length >= 2 || flags.some((f) => /^--(unset|unset-all|replace-all|add)$/.test(f));
    if (writes && pos.some((x) => /^core\.hookspath$/i.test(x))) found.push({ deny: R.noVerify });
  }
  if (sub === 'add') {
    const { flags, pos } = scanOpts(g.rest, { longArg: new Set(['--pathspec-from-file', '--chmod']) });
    const all = flags.includes('-A') || flags.some((f) => isLong(f, '--all', 4));
    const upd = flags.includes('-u') || flags.some((f) => isLong(f, '--update', 4));
    const sweepPath = pos.some((p) => SWEEP.test(p));
    const scoped = pos.length > 0 && !pos.every((p) => EXCLUDE_ONLY.test(p));
    if (sweepPath) found.push({ deny: R.addSweep(pos.find((p) => SWEEP.test(p))) });
    else if ((all || upd) && !scoped) found.push({ deny: R.addSweep(flags.find((f) => f === '-A' || f === '-u' || f.startsWith('--')) || '-A') });
  } else if (sub === 'commit') {
    const { flags } = scanOpts(g.rest, {
      shortArg: 'mFCct', shortOptional: 'uS',
      longArg: new Set(['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer', '--pathspec-from-file']),
    });
    if (flags.includes('-a') || flags.some((f) => isLong(f, '--all', 4))) found.push({ deny: R.commitAll });
    if (flags.includes('-n') || flags.some(isNoVerify)) found.push({ deny: R.noVerify });
  } else if (HOOKED_SUBS.has(sub)) {
    // push/merge/rebase/am/cherry-pick/revert: --no-verify anywhere in the option list
    const { flags } = scanOpts(g.rest, { shortArg: 'o', longArg: new Set(['--push-option', '--repo', '--receive-pack', '--exec', '--message', '--strategy', '--strategy-option']) });
    if (flags.some(isNoVerify) && !found.some((f) => f.deny === R.noVerify)) found.push({ deny: R.noVerify });
  }
  if (sub === 'stash') {
    const first = g.rest.find((w) => !w.startsWith('-'));
    if (!(first === 'list' || first === 'show')) found.push({ deny: R.stash });
  }
  if (sub === 'push') {
    const p = pushInfo(g, effectiveDir(e, g, ctx), ctx.overnight);
    if (p.rewritesMain) found.push({ deny: R.forceMain });
    if (ctx.overnight && p.targetsMain) found.push({ deny: R.overnight(cmdText(e, g)) });
  }
  if (sub === 'checkout' || sub === 'switch') {
    const info = mainCheckoutWithPeers(effectiveDir(e, g, ctx));
    if (info) found.push(ctx.overnight ? { deny: R.checkout(info.others) } : { ask: R.checkout(info.others) });
  }
  let discarded = false;
  if (discardsWork(g, effectiveDir(e, g, ctx))) {
    const info = mainCheckoutWithPeers(effectiveDir(e, g, ctx));
    if (info) { discarded = true; const why = R.discard(cmdText(e, g), info.others); found.push(ctx.overnight ? { deny: why } : { ask: why }); }
  }
  // Hard rule 3 also covers git: restoring a registry from a commit wipes the rows every session minted since, with or
  // without other worktrees (PM and intake sessions share the main checkout).
  const reg = !discarded && restoresRegistry(g, effectiveDir(e, g, ctx), ctx.registryDir ? ctx.registryDir() : '.claude');
  if (reg) found.push(ctx.overnight ? { deny: R.registry(reg) } : { ask: R.registry(reg) });
  return found;
}

// Commands that throw away uncommitted work of everyone sharing a checkout. `git restore <exact file>` (your own file)
// and `git restore --staged` (only unstages) are not; a restore of `.`/`*`/`:/`, of any folder (checked on disk, with
// or without a trailing slash), or of a registry or PM file (every session's minted rows live there) is.
const REGISTRY_FILE = /^(TASKS|CLIENT|CLIENT-REQUESTS|FACTS|MEETING-LOG|OPEN-ASKS|APPROVAL-QUEUE|DOC-MAP|ROUTING)(-ARCHIVE)?\.md$/;
function sharedPath(p, dir) {
  if (SWEEP.test(p) || p.endsWith('/') || /[*?[]/.test(p)) return true;
  const abs = path.resolve(dir || process.cwd(), p.replace(/^:\(top\)|^:\//, ''));
  if (REGISTRY_FILE.test(path.basename(abs)) || /(^|\/)PM(\/|$)/.test(p)) return true;
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}
// `git restore [-W] <paths>`, `git checkout [<tree>] -- <paths>` or `git checkout <path>` run in the MAIN checkout:
// the pathspec that overwrites a committed registry file (a registry, its folder, `.`), or null. A worktree's own
// copy is not the live one (the tools write main), and a gitignored registry (D13) is not touched by git.
function restoresRegistry(g, dir, regDirName) {
  let paths;
  if (g.sub === 'restore') {
    const { flags, pos } = scanOpts(g.rest, { shortArg: 's', longArg: new Set(['--source', '--pathspec-from-file']) });
    if ((flags.includes('-S') || flags.includes('--staged')) && !(flags.includes('-W') || flags.includes('--worktree'))) return null;
    paths = pos;
  } else if (g.sub === 'checkout') {
    const dd = g.rest.indexOf('--');
    paths = dd >= 0 ? g.rest.slice(dd + 1) : g.rest.filter((w) => !w.startsWith('-'));
  } else return null;
  paths = paths.filter((p) => p && !/[$`]/.test(p));
  if (!paths.length) return null;
  const info = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  if (!info || info.split('\n')[0] !== info.split('\n')[1]) return null; // not a repository, or a linked worktree
  const regName = path.basename(String(regDirName || '.claude').replace(/\/+$/, '')) || '.claude';
  for (const p of paths) {
    const files = (git(dir, ['ls-files', '--', p]) || '').split('\n').filter(Boolean);
    if (files.some((f) => REGISTRY_FILE.test(path.posix.basename(f)) && [regName, '.claude'].includes(path.posix.basename(path.posix.dirname(f))))) return p;
  }
  return null;
}
function discardsWork(g, dir) {
  const { flags, pos } = scanOpts(g.rest, { shortArg: 's', longArg: new Set(['--source', '--pathspec-from-file']) });
  if (g.sub === 'reset') return flags.includes('--hard') || flags.includes('--merge') || flags.includes('--keep');
  if (g.sub === 'clean') return (flags.includes('-f') || flags.includes('--force')) && !flags.includes('-n') && !flags.includes('--dry-run');
  if (g.sub === 'restore') {
    const staged = flags.includes('-S') || flags.includes('--staged'), worktree = flags.includes('-W') || flags.includes('--worktree');
    return (!staged || worktree) && pos.some((p) => sharedPath(p, dir));
  }
  return false;
}

// Commands that only print or read: when one of them is all that runs before a deploy/merge, a ";" costs nothing.
const PURE_PROGS = new Set(['echo', 'printf', 'true', ':', 'pwd', 'date', 'ls', 'cat', 'head', 'tail', 'wc', 'test', '[', '[[', 'export', 'unset', 'set',
  'for', 'while', 'until', 'case', 'select', 'in']);
const PURE_GIT = new Set(['log', 'status', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-remote', 'merge-base', 'cat-file', 'describe', 'shortlog', 'blame', 'grep', 'diff-tree', 'show-ref']);
function isPure(e) {
  if (PURE_PROGS.has(e.prog)) return true;
  if (e.prog !== 'git') return false;
  const g = parseGit(e.args);
  return PURE_GIT.has(g.sub) || (g.sub === 'worktree' && g.rest[0] === 'list') || (g.sub === 'stash' && g.rest[0] === 'list');
}
const isErrexit = (e) => e.prog === 'set' && (e.args.some((a) => /^-[A-Za-z]*e[A-Za-z]*$/.test(a)) || e.args.some((a, k) => a === '-o' && e.args[k + 1] === 'errexit'));

export function evaluate(command, ctx) {
  const res = [];
  flatten(parseShell(command), ctx, res, { vdir: null }, 0);
  const warnings = [];
  let patterns = null;
  const findings = [];
  let errexit = false;
  res.forEach((e, k) => {
    const g = e.prog === 'git' ? parseGit(e.args) : null;
    if (g) findings.push(...checkGit(e, g, ctx));
    const text = cmdText(e, g);
    const preview = ctx.overnight && (ctx.previewTexts ? ctx.previewTexts() : []).includes(text);
    const prod = isVercelProd(e) || isGhMerge(e) || (ctx.overnight && !preview && isDeployScript(e));
    const merge = !!g && g.sub === 'merge' && !g.rest.some((w) => ['--abort', '--quit', '--continue'].includes(w));
    const chained = !!e.sep && e.sep !== '&&' && e.sep !== '|';
    let patHit = false;
    if (ctx.overnight || chained) { // the config is only read when a pattern can change the answer
      patterns = patterns || compilePatterns(ctx.productionPatterns(), warnings);
      patHit = patterns.some((re) => re.test(text));
    }
    if (ctx.overnight && (prod || (patHit && !preview))) findings.push({ deny: R.overnight(text) });
    else if (ctx.overnight && !preview) {
      // Overnight a script that cannot be read cannot be cleared, and nobody is there to ask: denied (fail closed), with
      // the one command that fixes it. In the day this check does not run at all.
      const off = offloadedScript(e, ctx.cwd);
      const why = off ? null : directUpload(e) || uploadingScript(e, ctx.cwd);
      if (off) findings.push({ deny: R.offloadedScript(text, off) });
      else if (why) findings.push({ deny: R.overnight(`${text} [${why}]`) });
    }
    const reg = registryWrite(e, ctx.cwd, ctx.registryDir ? ctx.registryDir() : '.claude');
    if (reg) findings.push(ctx.overnight ? { deny: R.registry(reg) } : { ask: R.registry(reg) });
    // A deploy/merge must be chained with && (never ; newline || &), unless nothing that can fail ran before it
    // or the script started with `set -e`.
    if (chained && (prod || merge || patHit) && !errexit && !res.slice(0, k).every(isPure)) findings.push({ deny: R.chain(text) });
    if (isErrexit(e)) errexit = true;
  });
  return { findings, warnings };
}

// ---------------------------------------------------------------- root + config (contract section 3)
// Real path first: git prints real paths (/private/var, not /var), and a mixed pair maps a worktree to nowhere.
function findUp(dir) {
  let start = path.resolve(dir); try { start = fs.realpathSync(start); } catch { /* keep as given */ }
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.claude', 'clockwork.json'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

function resolveRoot(startDir) {
  if (process.env.CLOCKWORK_ROOT) return process.env.CLOCKWORK_ROOT;
  const found = findUp(startDir);
  if (!found) return null;
  const out = git(found, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel']);
  if (!out) return found;
  const [common, gitdir, top] = out.split('\n');
  if (!common || common === gitdir) return found;
  const cand = path.join(path.dirname(common), path.relative(top, found));
  return fs.existsSync(path.join(cand, '.claude', 'clockwork.json')) ? cand : found;
}

// clockwork.json, or {} (the built-in defaults) when it is missing or broken. An offloaded one is never read: the
// result is { [OFFLOADED]: <its path> } and main() says so in a one-line warning on every call until it is downloaded.
// What the defaults mean then (choose the safe side for each):
//  - In the day: fail OPEN. The config only adds project patterns to the ";"-chain check and names registryDir, so
//    every other check still runs; the command goes ahead with the warning.
//  - Overnight (OVERNIGHT=1): production matching fails CLOSED as far as it can decide without the file. The built-in
//    DEFAULT_PRODUCTION_PATTERNS, vercel --prod, gh pr merge, deploy-named scripts and every upload check still deny.
//    commands.previewDeploy is unknown, so no command counts as the preview: a preview deploy whose name says deploy
//    is denied too. Only the project's own productionPatterns / commands.productionDeploy cannot be matched; the
//    warning says so. Denying every command instead would stop the whole night over one file.
// registryDir falls back to '.claude' either way.
const OFFLOADED = Symbol('clockwork.json offloaded');
function loadConfig(startDir) {
  try {
    const root = resolveRoot(startDir);
    if (!root) return {};
    const file = path.join(root, '.claude', 'clockwork.json');
    if (offloadState(file) === 'offloaded') return { [OFFLOADED]: file };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* defaults */ }
  return {};
}
export const configOffloaded = (cfg) => (cfg && cfg[OFFLOADED]) || null;
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function productionPatternsOf(cfg) {
  const list = Array.isArray(cfg.productionPatterns) && cfg.productionPatterns.every((x) => typeof x === 'string') ? [...cfg.productionPatterns] : [...DEFAULT_PRODUCTION_PATTERNS];
  const prodCmd = cfg.commands && typeof cfg.commands.productionDeploy === 'string' ? cfg.commands.productionDeploy : '';
  for (const t of commandTexts(prodCmd)) list.push(escRe(t) + '(?: |$)');
  return list;
}
export function previewTextsOf(cfg) {
  return commandTexts(cfg.commands && typeof cfg.commands.previewDeploy === 'string' ? cfg.commands.previewDeploy : '');
}

// ---------------------------------------------------------------- main
function write(fd, text) { try { fs.writeSync(fd, text); } catch { (fd === 2 ? process.stderr : process.stdout).write(text); } }

function emit(kind, reason, warnings = []) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: kind, permissionDecisionReason: reason } };
  if (warnings.length) out.systemMessage = `clockwork guard-bash: ${warnings.join('; ')}`;
  write(1, JSON.stringify(out));
  if (kind === 'deny') { write(2, reason + '\n'); process.exit(2); }
  process.exit(0);
}

function failOpen(msg) {
  write(1, JSON.stringify({ systemMessage: `clockwork guard-bash: ${msg}. This command was NOT checked.` }));
  process.exit(0);
}

// Async stdin read: readFileSync(0) throws EAGAIN when Claude Code writes the input after node started, and the
// command would pass unchecked. An input that never arrives is a loud fail-open, never a silent allow.
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

async function main() {
  let raw = '';
  if (!process.stdin.isTTY) {
    const got = await readStdin();
    if (got.why) return failOpen(`could not read the hook input (${got.why})`);
    raw = got.raw;
    if (!raw.trim()) return failOpen('the hook input was empty');
  }
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return failOpen('could not read the hook input'); }
  if (!input || typeof input !== 'object') input = {};
  if (input.tool_name && input.tool_name !== 'Bash' && input.tool_name !== 'Monitor') process.exit(0);
  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string' || !command.trim()) process.exit(0);
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ctx = {
    cwd,
    overnight: process.env.OVERNIGHT === '1',
  };
  let cfg = null;
  const conf = () => (cfg ??= loadConfig(process.env.CLAUDE_PROJECT_DIR || cwd));
  ctx.productionPatterns = () => productionPatternsOf(conf());
  ctx.previewTexts = () => previewTextsOf(conf());
  ctx.registryDir = () => (typeof conf().registryDir === 'string' ? conf().registryDir : '.claude');
  let result;
  try { result = evaluate(command, ctx); } catch (err) { return failOpen(`internal error (${err && err.message})`); }
  const off = configOffloaded(cfg);
  if (off) result.warnings.unshift(`${offloadNote(off)} (checked with the built-in defaults${ctx.overnight ? '; this project\'s own productionPatterns and commands.productionDeploy were NOT matched' : ''})`);
  const deny = result.findings.find((f) => f.deny);
  if (deny) emit('deny', deny.deny, result.warnings);
  const ask = result.findings.find((f) => f.ask);
  if (ask) emit('ask', ask.ask, result.warnings);
  if (result.warnings.length) {
    const msg = `clockwork guard-bash: ${result.warnings.join('; ')}`;
    // systemMessage reaches the user; additionalContext reaches Claude, who can run the download (overnight nobody else can).
    write(1, JSON.stringify(off ? { systemMessage: msg, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } } : { systemMessage: msg }));
  }
  process.exit(0);
}

if (process.argv[1] && realp(process.argv[1]) === realp(fileURLToPath(import.meta.url))) main();
