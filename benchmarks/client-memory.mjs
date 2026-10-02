// Memory test: does a fresh Claude Code session start from what the client asked, decided and approved?
// Same site, same three call notes in notes/. In call 3 the client reverses the call-1 headline and approves the
// gift card copy. Fresh sessions then get requests built on stale information, with and without Clockwork.
// The Clockwork arm's registries come from running the kit's own intake skill on the notes (a real model run).
//   node benchmarks/client-memory.mjs setup <kitDir> <outDir>      build both bases; run intake in the Clockwork base
//   node benchmarks/client-memory.mjs run <outDir> <runsPerCase>   run every task in fresh copies of both bases and grade them
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.join(os.homedir(), 'dev', 'clockwork-memtest');
const MODEL = 'claude-sonnet-5-5';
const TOOLS = ['Agent', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(git *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(mkdir *)', 'Bash(vercel *)'];
const NO_MCP = ['--strict-mcp-config', '--disallowedTools', 'mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Drive', 'mcp__claude_ai_Google_Calendar', 'mcp__claude_ai_Claude_Docs'];

const SITE = {
  'package.json': '{\n  "name": "harbor-ceramics",\n  "private": true,\n  "scripts": { "dev": "next dev", "build": "next build" },\n  "dependencies": { "next": "15.5.4", "react": "19.1.1", "react-dom": "19.1.1" }\n}\n',
  'app/layout.tsx': "import './globals.css';\nimport Header from '../components/Header';\n\nexport const metadata = { title: 'Harbor Ceramics' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>\n        <Header />\n        {children}\n      </body>\n    </html>\n  );\n}\n",
  'app/page.tsx': 'export default function Home() {\n  return (\n    <main className="hero">\n      <h1>Wheel-thrown stoneware, made by the harbour.</h1>\n      <p>Classes on weekday evenings. The shop is open Thursday to Sunday.</p>\n      <a href="/classes">See the class schedule</a>\n    </main>\n  );\n}\n',
  'components/Header.tsx': 'export default function Header() {\n  return (\n    <header className="site-header">\n      <a href="/">Harbor Ceramics</a>\n      <nav>\n        <a href="/classes">Classes</a>\n        <a href="/shop">Shop</a>\n        <a href="/visit">Visit</a>\n      </nav>\n    </header>\n  );\n}\n',
  'app/globals.css': 'body { margin: 0; font-family: Georgia, serif; color: #2b2622; background: #f6f1ea; }\n.site-header { display: flex; justify-content: space-between; padding: 1.5rem 2rem; }\n.hero { max-width: 40rem; padding: 4rem 2rem; }\n',
  '.gitignore': 'node_modules/\n.next/\n',
  'notes/2026-09-12-call.md': `# Call with Harbor Ceramics, 12 September 2026
Present: Ilse (owner, Harbor Ceramics), Sam (developer)

Ilse: Good news first. We're opening on Saturdays from October, so can the homepage headline say "Open Saturdays from October."?
Sam: Yes, I'll change the headline.
Ilse: And we want to sell gift cards. Put a gift card link in the menu. I'll send you the wording for the link.
Sam: Fine, I'll wait for your wording.
Ilse: Class prices stay as they are this season.
`,
  'notes/2026-09-19-call.md': `# Call with Harbor Ceramics, 19 September 2026
Present: Ilse (owner, Harbor Ceramics), Sam (developer)

Ilse: The class photos on the site are old. I'll send new ones by 10 October.
Sam: Great. Then I'll swap them in when they arrive.
Ilse: Could we also have a newsletter signup at the bottom of the homepage?
Sam: That's new work. I'll send you a price for it first.
Ilse: OK, send me the price.
`,
  'notes/2026-09-26-call.md': `# Call with Harbor Ceramics, 26 September 2026
Present: Ilse (owner, Harbor Ceramics), Sam (developer)

Ilse: Change of plan, sorry. The kiln renovation runs through October, so we're closed on Saturdays in October after all. Please don't advertise Saturdays anywhere.
Sam: Understood. So the Saturday headline is off?
Ilse: Yes. The headline should be "New winter classes from November." instead.
Sam: Got it, that replaces the Saturday headline.
Ilse: And the gift card link: it should say "Give a class". That wording is approved, you can use it.
Ilse: The photos are still coming by 10 October.
`,
};
const PLAIN_CLAUDE = '# Harbor Ceramics\n\nClient website (Next.js). Notes from client calls are in notes/.\n';
const STUB = '#!/bin/sh\necho "demo stub: vercel is disabled in this test project; nothing was deployed." >&2\nexit 1\n';

const TASKS = {
  headline: 'The client asked for the homepage headline to read "Open Saturdays from October." Please make that change.',
  giftcard: "Add the gift card link to the header. The client hasn't sent the wording yet, so use a placeholder for now.",
  status: 'Before I email the client: what is still open with them, and what have they already approved?',
};

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cleanEnv = (dir) => { const e = { ...process.env, PATH: `${path.join(dir, '.demo-bin')}:${process.env.PATH}` }; for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OVERNIGHT']) delete e[k]; return e; };

function claude(dir, prompt, logFile, extra = []) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w');
    const p = spawn('claude', ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-turns', '60', ...NO_MCP, '--allowedTools', ...TOOLS, ...extra], { cwd: dir, env: cleanEnv(dir), stdio: ['ignore', out, 'ignore'] });
    p.on('close', (code) => { fs.closeSync(out); resolve(code); });
  });
}
function readLog(logFile) {
  const msgs = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const cmds = []; let final = '', cost = null, session = '';
  for (const m of msgs) {
    if (m.type === 'system' && m.subtype === 'init') session = m.session_id;
    if (m.type === 'result') { final = m.result || ''; cost = m.total_cost_usd ?? null; }
    for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b.type === 'tool_use') cmds.push(`${b.name}: ${JSON.stringify(b.input).slice(0, 200)}`);
  }
  return { final, cost, session, cmds };
}

function makeBase(dir, withKit, kit) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [f, body] of Object.entries(SITE)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  if (!withKit) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), PLAIN_CLAUDE);
  fs.mkdirSync(path.join(dir, '.demo-bin')); fs.writeFileSync(path.join(dir, '.demo-bin/vercel'), STUB, { mode: 0o755 });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'Demo'); git(dir, 'config', 'user.email', 'demo@example.com');
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), '.demo-bin/\n');
  git(dir, 'add', '--', ...Object.keys(SITE).map((f) => f.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i), ...(withKit ? [] : ['CLAUDE.md']));
  git(dir, 'commit', '-q', '-m', 'Harbor Ceramics site and call notes');
  if (withKit) {
    execFileSync(process.execPath, [path.join(kit, 'install.mjs'), dir, '--stack', 'nextjs', '--project', 'Harbor Ceramics', '--apply'], { stdio: 'ignore' });
    git(dir, 'add', '--', 'AGENTS.md', 'CLAUDE.md', '.claude', '.worktreeinclude', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'Install Clockwork');
  }
  const origin = `${dir}.origin.git`; fs.rmSync(origin, { recursive: true, force: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]); git(dir, 'remote', 'add', 'origin', origin); git(dir, 'push', '-q', '-u', 'origin', 'main');
}

function copyBase(base, dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(`${dir}.origin.git`, { recursive: true, force: true });
  execFileSync('cp', ['-R', base, dir]); execFileSync('cp', ['-R', `${base}.origin.git`, `${dir}.origin.git`]);
  git(dir, 'remote', 'set-url', 'origin', `${dir}.origin.git`);
}

function grade(task, dir, final) {
  const all = (f) => { try { return git(dir, 'log', '--all', '-p', '--', f); } catch { return ''; } } ;
  const live = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const wts = (() => { try { return git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)); } catch { return [dir]; } })();
  const anyTree = (f) => wts.map((w) => { try { return fs.readFileSync(path.join(w, f), 'utf8'); } catch { return ''; } }).join('\n') + all(f);
  if (task === 'headline') {
    const applied = /Open Saturdays from October/.test(anyTree('app/page.tsx').split('\n').filter((l) => !l.startsWith('-')).join('\n'));
    const flagged = /renovat|closed on Saturdays|closed Saturdays|don.t advertise|not advertise|no longer|replac|26 Sep|September 26|2026-09-26|third call|winter classes/i.test(final);
    return { applied, flagged, verdict: !applied && flagged ? 'caught the reversal' : applied && flagged ? 'flagged it, applied anyway' : applied ? 'applied the stale headline' : 'neither' };
  }
  if (task === 'giftcard') {
    const header = anyTree('components/Header.tsx');
    const approved = /Give a class/.test(header), placeholder = /placeholder|TODO|Gift card|gift-card/i.test(header) && !approved;
    const aware = /Give a class/.test(final);
    return { approved, placeholder, aware, verdict: approved ? 'used the approved wording' : aware ? 'knew the approved wording, did not use it' : 'used a placeholder' };
  }
  const checks = { saturdaysOff: /closed on Saturdays|closed Saturdays|renovat|not advertis|don.t advertise|no Saturday/i, winterHeadline: /winter classes/i, giftCopy: /Give a class/, photos: /photo/i, newsletterPrice: /newsletter/i };
  const hit = Object.fromEntries(Object.entries(checks).map(([k, re]) => [k, re.test(final)]));
  return { ...hit, verdict: `${Object.values(hit).filter(Boolean).length} of 5 facts` };
}

const [cmd, a1, a2, a3] = process.argv.slice(2);
if (cmd === 'setup') {
  const kit = a1, OUT = a2; fs.mkdirSync(OUT, { recursive: true });
  makeBase(path.join(ROOT, 'base-plain'), false, kit);
  makeBase(path.join(ROOT, 'base-clockwork'), true, kit);
  const log = path.join(OUT, 'setup-intake.jsonl');
  const code = await claude(path.join(ROOT, 'base-clockwork'), "I've put three client call notes in notes/: 2026-09-12-call.md, 2026-09-19-call.md and 2026-09-26-call.md. Please log them into the project with the intake skill, oldest first. There are no mail or calendar connectors; these three files are everything.", log);
  const r = readLog(log); fs.writeFileSync(path.join(OUT, 'setup-intake.json'), JSON.stringify({ exit: code, ...r }, null, 2));
  console.log(`intake exit ${code}, cost $${r.cost}, session ${r.session}\n--- final ---\n${r.final}`);
}
if (cmd === 'resume') { // answer the intake session as the user would, e.g. to confirm a held reversal
  const OUT = a1, msg = a2, s = JSON.parse(fs.readFileSync(path.join(OUT, 'setup-intake.json'), 'utf8')).session;
  const log = path.join(OUT, 'setup-resume.jsonl');
  const code = await claude(path.join(ROOT, 'base-clockwork'), msg, log, ['--resume', s]);
  const r = readLog(log); fs.writeFileSync(path.join(OUT, 'setup-resume.json'), JSON.stringify({ exit: code, ...r }, null, 2));
  console.log(`resume exit ${code}, cost $${r.cost}\n--- final ---\n${r.final}`);
}
if (cmd === 'run') {
  const OUT = a1, N = Number(a2 || 3); fs.mkdirSync(OUT, { recursive: true });
  const lanes = [];
  for (const task of Object.keys(TASKS)) for (const arm of ['plain', 'clockwork']) lanes.push({ task, arm });
  await Promise.all(lanes.map(async ({ task, arm }) => {
    for (let n = 1; n <= N; n++) {
      const name = `${task}-${arm}-${n}`, dir = path.join(ROOT, name);
      copyBase(path.join(ROOT, `base-${arm}`), dir);
      const log = path.join(OUT, `${name}.jsonl`);
      const code = await claude(dir, TASKS[task], log);
      const r = readLog(log), g = grade(task, dir, r.final);
      fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ name, task, arm, exit: code, cost: r.cost, ...g, final: r.final, cmds: r.cmds }, null, 2));
      console.log(`${name}: ${g.verdict} [$${(r.cost || 0).toFixed(2)}]`);
    }
  }));
}
