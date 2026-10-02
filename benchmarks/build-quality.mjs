// Build quality per dollar: the same three client tasks, run by Claude Code in three set-ups.
//   bare      the site, a client-info note, a one-line CLAUDE.md pointing to it
//   rules     the same, plus Clockwork's rule text (engineering, design system, hard rules, facts) pasted into CLAUDE.md
//   clockwork the same site and note, with Clockwork installed: rules, hooks, registries with the facts and decisions
// Each run is graded three ways: automatic checks on the result, `next build`, and a blind reviewer that sees only the
// task, the client facts and the code diff (never which set-up made it).
//   node benchmarks/build-quality.mjs setup <kitDir>
//   node benchmarks/build-quality.mjs run <outDir> <runsPerCase>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const ROOT = path.join(os.homedir(), 'dev', 'clockwork-quality');
const DEPS = path.join(ROOT, '_deps');
const MODEL = 'claude-sonnet-5-5';
const TOOLS = ['Agent', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(git *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(mkdir *)', 'Bash(npm run *)', 'Bash(npx next *)', 'Bash(npx tsc *)'];
const NO_MCP = ['--strict-mcp-config', '--disallowedTools', 'mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Drive', 'mcp__claude_ai_Google_Calendar', 'mcp__claude_ai_Claude_Docs'];
const ARMS = ['bare', 'rules', 'clockwork'];

const FACTS = `# Harbor Ceramics: client information

## Opening hours
- Shop: Thursday to Sunday, 10:00 to 17:00.

## Classes (prices per person per session)
- Wheel basics: Tuesday, 19:00 to 21:00, €45.
- Glazing workshop: Wednesday, 19:00 to 21:00, €40.
- Family clay: Sunday, 10:00 to 12:00, €30 per child, one adult free.

## Contact
- Havenkade 12, Harbor Town
- hello@harbor-ceramics.example

## Decisions
- 2026-09-20: newsletter signup approved and quoted. Email address only. Approved consent text: "We send one email a month. Unsubscribe anytime."
- Signups post to the existing endpoint /api/newsletter.
`;

const SITE = {
  'package.json': '{\n  "name": "harbor-ceramics",\n  "private": true,\n  "scripts": { "dev": "next dev", "build": "next build" },\n  "dependencies": { "next": "15.5.4", "react": "19.1.1", "react-dom": "19.1.1" },\n  "devDependencies": { "typescript": "5.9.2", "@types/react": "19.1.12", "@types/node": "22.18.6" }\n}\n',
  'tsconfig.json': '{\n  "compilerOptions": {\n    "target": "ES2017", "lib": ["dom", "dom.iterable", "esnext"], "allowJs": false, "skipLibCheck": true, "strict": true, "noEmit": true,\n    "esModuleInterop": true, "module": "esnext", "moduleResolution": "bundler", "resolveJsonModule": true, "isolatedModules": true,\n    "jsx": "preserve", "incremental": true, "plugins": [{ "name": "next" }]\n  },\n  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],\n  "exclude": ["node_modules"]\n}\n',
  'next-env.d.ts': '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
  'app/globals.css': `:root {
  --color-ink: #2b2622;
  --color-muted: #6b625a;
  --color-paper: #f6f1ea;
  --color-clay: #b4532a;
  --color-line: #d9cfc3;
  --space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px; --space-5: 40px; --space-6: 64px;
  --text-sm: 0.875rem; --text-base: 1rem; --text-lg: 1.25rem; --text-xl: 2rem; --text-2xl: 3rem;
  --radius: 6px;
  --font-serif: Georgia, 'Times New Roman', serif;
}
body { margin: 0; font-family: var(--font-serif); color: var(--color-ink); background: var(--color-paper); font-size: var(--text-base); }
.site-header, .site-footer { display: flex; justify-content: space-between; padding: var(--space-4) var(--space-5); }
.site-footer { border-top: 1px solid var(--color-line); color: var(--color-muted); font-size: var(--text-sm); }
.hero { max-width: 40rem; padding: var(--space-6) var(--space-5); }
.hero h1 { font-size: var(--text-2xl); font-weight: 400; line-height: 1.1; }
.page { max-width: 48rem; padding: var(--space-6) var(--space-5); }
.page h1 { font-size: var(--text-xl); font-weight: 400; }
a { color: var(--color-clay); }
`,
  'app/layout.tsx': "import './globals.css';\nimport Header from '../components/Header';\nimport Footer from '../components/Footer';\n\nexport const metadata = { title: 'Harbor Ceramics', description: 'Wheel-thrown stoneware and pottery classes by the harbour. Open Thursday to Sunday.' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>\n        <Header />\n        {children}\n        <Footer />\n      </body>\n    </html>\n  );\n}\n",
  'app/page.tsx': 'export default function Home() {\n  return (\n    <main className="hero">\n      <h1>Wheel-thrown stoneware, made by the harbour.</h1>\n      <p>Classes on weekday evenings. The shop is open Thursday to Sunday.</p>\n      <a href="/classes">See the class schedule</a>\n    </main>\n  );\n}\n',
  'app/visit/page.tsx': 'export const metadata = { title: \'Visit · Harbor Ceramics\' };\n\nexport default function Visit() {\n  return (\n    <main className="page">\n      <h1>Visit the studio</h1>\n      <p>Havenkade 12, Harbor Town</p>\n      <p>Open Thursday to Sunday, 10:00 to 17:00.</p>\n    </main>\n  );\n}\n',
  'app/api/newsletter/route.ts': "export async function POST(req: Request) {\n  const { email } = await req.json().catch(() => ({ email: '' }));\n  if (typeof email !== 'string' || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) return Response.json({ ok: false, error: 'invalid email' }, { status: 400 });\n  return Response.json({ ok: true });\n}\n",
  'components/Header.tsx': 'export default function Header() {\n  return (\n    <header className="site-header">\n      <a href="/">Harbor Ceramics</a>\n      <nav>\n        <a href="/classes">Classes</a> <a href="/visit">Visit</a>\n      </nav>\n    </header>\n  );\n}\n',
  'components/Footer.tsx': 'export default function Footer() {\n  return (\n    <footer className="site-footer">\n      <span>Harbor Ceramics · Havenkade 12</span>\n      <span>Thursday to Sunday, 10:00 to 17:00</span>\n    </footer>\n  );\n}\n',
  'notes/client-info.md': FACTS,
  '.gitignore': 'node_modules/\n.next/\n*.tsbuildinfo\n',
};
const POINTER = '# Harbor Ceramics\n\nClient website (Next.js). Client information and decisions: notes/client-info.md.\n';

const TASKS = {
  classes: 'Build the class schedule page at /classes: every class with its day, time and price.',
  newsletter: 'Add the newsletter signup to the bottom of the homepage. It should post to the existing /api/newsletter endpoint.',
  hours: 'The client changed the opening hours: from 1 November the shop is open Wednesday to Sunday, 10:00 to 17:00. Update the site.',
};

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return ''; } };
const cleanEnv = () => { const e = { ...process.env }; for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OVERNIGHT']) delete e[k]; return e; };

function rulesClaudeMd(kit) {
  // The "it is only a prompt" set-up: Clockwork's rule text in one CLAUDE.md, without hooks, tools or registries.
  const strip = (s) => s.replace(/^---[\s\S]*?\n---\n/, '').trim();
  const eng = strip(fs.readFileSync(path.join(kit, 'templates/claude/rules/engineering.md'), 'utf8'));
  const ds = strip(fs.readFileSync(path.join(kit, 'templates/claude/rules/design-system.md'), 'utf8')).replace(/\{\{token file\}\}/g, 'app/globals.css');
  const hard = ['Never invent client content: no made-up people, quotes, numbers, logos or facts. Placeholders are flagged in the data so they cannot publish, or left empty.',
    'Check a fact at its source (notes/client-info.md) before stating it or building with it.',
    'Commit by explicit path. Never git add -A, git commit -a, --no-verify, git stash, or force-push to main.',
    'Run build, lint and test. Never claim a check ran when it did not. Say what you did not check.',
    "Production deploy, merge to main and anything sent to the client need the user's go."];
  return `${POINTER}\n## Hard rules\n${hard.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\n${eng}\n\n${ds}\n`;
}

function makeBase(arm, kit) {
  const dir = path.join(ROOT, `base-${arm}`);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [f, body] of Object.entries(SITE)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  if (arm !== 'clockwork') fs.writeFileSync(path.join(dir, 'CLAUDE.md'), arm === 'rules' ? rulesClaudeMd(kit) : POINTER);
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'Demo'); git(dir, 'config', 'user.email', 'demo@example.com');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'Harbor Ceramics site');
  if (arm === 'clockwork') {
    execFileSync(process.execPath, [path.join(kit, 'install.mjs'), dir, '--stack', 'nextjs', '--project', 'Harbor Ceramics', '--apply'], { stdio: 'ignore' });
    const cfgPath = path.join(dir, '.claude/clockwork.json'), cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.commands.build = 'npm run build'; fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    const dsPath = path.join(dir, '.claude/rules/design-system.md'); fs.writeFileSync(dsPath, fs.readFileSync(dsPath, 'utf8').replace(/\{\{token file\}\}/g, 'app/globals.css'));
    // the facts and decisions as a Clockwork project holds them, written through the kit's own tool
    const reg = (...a) => execFileSync(process.execPath, [path.join(dir, '.claude/tools/registry.mjs'), ...a], { cwd: dir, encoding: 'utf8', env: { ...cleanEnv(), CLOCKWORK_ROOT: dir } });
    const src = 'notes/client-info.md';
    for (const [k, v] of [['Opening hours', 'Thursday to Sunday, 10:00 to 17:00'], ['Class: Wheel basics', 'Tuesday, 19:00 to 21:00, €45 per person'], ['Class: Glazing workshop', 'Wednesday, 19:00 to 21:00, €40 per person'],
      ['Class: Family clay', 'Sunday, 10:00 to 12:00, €30 per child, one adult free'], ['Address', 'Havenkade 12, Harbor Town'], ['Email', 'hello@harbor-ceramics.example']])
      reg('line', 'FACTS.md', '--section', '## Facts', '--text', `| ${k} | ${v} | 2026-09-20 | ${src} |`);
    reg('mint', 'CD', '--title', 'Newsletter signup approved and quoted: email address only, posts to /api/newsletter', '--cells', `2026-09-20 · client|${src}`, '--status', '✅ VERIFIED');
    reg('mint', 'CD', '--title', 'Newsletter consent text approved: "We send one email a month. Unsubscribe anytime."', '--cells', `2026-09-20 · client|${src}`, '--status', '✅ VERIFIED');
    git(dir, 'add', '--', 'AGENTS.md', 'CLAUDE.md', '.claude', '.worktreeinclude', '.gitignore'); git(dir, 'commit', '-q', '-m', 'Install Clockwork, facts and decisions');
  }
  const origin = `${dir}.origin.git`; fs.rmSync(origin, { recursive: true, force: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]); git(dir, 'remote', 'add', 'origin', origin); git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

function copyBase(arm, dir) {
  const base = path.join(ROOT, `base-${arm}`);
  for (const p of [dir, `${dir}.origin.git`]) fs.rmSync(p, { recursive: true, force: true });
  execFileSync('cp', ['-R', base, dir]); execFileSync('cp', ['-R', `${base}.origin.git`, `${dir}.origin.git`]);
  git(dir, 'remote', 'set-url', 'origin', `${dir}.origin.git`);
  return git(dir, 'rev-parse', 'HEAD');
}

function claude(dir, prompt, logFile, extra = []) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w');
    const p = spawn('claude', ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-turns', '80', ...NO_MCP, '--allowedTools', ...TOOLS, ...extra], { cwd: dir, env: cleanEnv(), stdio: ['ignore', out, 'ignore'] });
    p.on('close', (code) => { fs.closeSync(out); resolve(code); });
  });
}
function readLog(logFile) {
  const msgs = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  let final = '', cost = null, turns = 0, tools = 0;
  for (const m of msgs) {
    if (m.type === 'result') { final = m.result || ''; cost = m.total_cost_usd ?? null; turns = m.num_turns ?? 0; }
    for (const b of Array.isArray(m.message?.content) ? m.message.content : []) if (b.type === 'tool_use') tools++;
  }
  return { final, cost, turns, tools };
}

// The result is wherever the session left its work: the main checkout or one of its worktrees, committed or not.
const APP = ['app', 'components'];
function resultTree(dir, baseSha) {
  const trees = tryGit(dir, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  let best = dir, most = -1;
  for (const w of trees.length ? trees : [dir]) {
    const n = tryGit(w, 'diff', '--name-only', baseSha, '--', ...APP).split('\n').filter(Boolean).length + tryGit(w, 'ls-files', '--others', '--exclude-standard', '--', ...APP).split('\n').filter(Boolean).length;
    if (n > most) { most = n; best = w; }
  }
  return best;
}
function appDiff(tree, baseSha) {
  tryGit(tree, 'add', '-N', '--', ...APP); // show new files in the diff without staging content
  return tryGit(tree, 'diff', baseSha, '--', ...APP);
}
const read = (tree, rel) => { try { return fs.readFileSync(path.join(tree, rel), 'utf8'); } catch { return ''; } };
const appText = (tree) => {
  const out = []; const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8')); } };
  for (const a of APP) walk(path.join(tree, a)); return out.join('\n');
};

function build(tree) {
  const r = spawnSync(path.join(DEPS, 'node_modules/.bin/next'), ['build'], { cwd: tree, encoding: 'utf8', env: { ...cleanEnv(), NEXT_TELEMETRY_DISABLED: '1' }, timeout: 300000 });
  return { ok: r.status === 0, tail: `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(-12).join('\n') };
}

function checks(task, tree, diff) {
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
  const rawValues = (added.match(/#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?px\b/g) || []).length; // raw colours and px outside the tokens
  const tokenUses = (added.match(/var\(--[\w-]+\)/g) || []).length;
  const c = { rawValues, tokenUses };
  if (task === 'classes') {
    const page = ['app/classes/page.tsx', 'app/classes/page.jsx'].map((f) => read(tree, f)).join('\n') + appText(tree);
    const cls = [['Wheel basics', 'Tuesday', '45'], ['Glazing', 'Wednesday', '40'], ['Family clay', 'Sunday', '30']];
    c.classesRight = cls.filter((k) => k.every((w) => page.includes(w))).length;
    c.timesRight = ['19:00', '21:00', '10:00', '12:00'].filter((w) => page.includes(w)).length;
    c.inventedPrices = [...new Set((page.match(/€\s?\d+/g) || []).map((p) => p.replace(/\D/g, '')))].filter((p) => !['45', '40', '30'].includes(p)).length;
    c.pageExists = /export default/.test(read(tree, 'app/classes/page.tsx') + read(tree, 'app/classes/page.jsx'));
  }
  if (task === 'newsletter') {
    const t = appText(tree);
    c.postsToEndpoint = /\/api\/newsletter/.test(added);
    c.emailInput = /type=["']email["']/.test(added);
    c.required = /\brequired\b/.test(added);
    c.labelled = /<label|aria-label/.test(added);
    c.approvedConsent = t.includes('We send one email a month. Unsubscribe anytime.');
    c.handlesFailure = /catch\s*\(|!res\.ok|res\.ok|response\.ok|status/.test(added);
    c.onHomepage = /Newsletter|newsletter/.test(read(tree, 'app/page.tsx'));
  }
  if (task === 'hours') {
    const places = { homepage: read(tree, 'app/page.tsx'), visit: read(tree, 'app/visit/page.tsx'), footer: read(tree, 'components/Footer.tsx'), metadata: read(tree, 'app/layout.tsx') };
    c.updated = Object.entries(places).filter(([, s]) => /Wednesday/.test(s)).map(([k]) => k);
    c.staleOnly = Object.entries(places).filter(([, s]) => /Thursday to Sunday/.test(s) && !/Wednesday/.test(s)).map(([k]) => k);
    c.keepsOldUntilNov = Object.values(places).some((s) => /1 November|November 1|from November|until 31 October/i.test(s));
  }
  return c;
}

async function judge(task, diff, out) {
  const prompt = `You are reviewing one change to a small client website (Next.js). You do not know who made it.

Task given to the developer:
${TASKS[task]}

Client information they had (notes/client-info.md):
${FACTS}
The site's design tokens are CSS variables in app/globals.css (--color-*, --space-*, --text-*, --radius, --font-serif).

The change (git diff of app/ and components/):
${diff.slice(0, 24000) || '(no change)'}

Score it as a demanding senior reviewer would before it goes to the client. Reply with only a JSON object:
{"score": <1-10 overall>, "correct": <1-10 does it do the task with the client's real facts>, "invented": [<anything stated that is not in the client information>], "accessibility": <1-10>, "design_consistency": <1-10 uses the tokens and existing styles>, "code_quality": <1-10>, "ship_ready": <true|false>, "notes": "<two sentences>"}`;
  const r = spawnSync('claude', ['-p', prompt, '--model', MODEL, '--output-format', 'json', '--max-turns', '1', ...NO_MCP, '--tools', ''], { encoding: 'utf8', env: cleanEnv(), timeout: 300000, cwd: os.tmpdir() });
  fs.writeFileSync(out, r.stdout || r.stderr || '');
  try { const j = JSON.parse(r.stdout); const m = /\{[\s\S]*\}/.exec(j.result); return { ...JSON.parse(m[0]), judgeCost: j.total_cost_usd }; } catch (e) { return { error: `judge output not parsed: ${String(e.message).slice(0, 80)}` }; }
}

const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === 'setup') {
  const kit = a1;
  fs.mkdirSync(DEPS, { recursive: true });
  if (!fs.existsSync(path.join(DEPS, 'node_modules/.bin/next'))) {
    fs.writeFileSync(path.join(DEPS, 'package.json'), SITE['package.json']);
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: DEPS, stdio: 'inherit' });
  }
  // one shared node_modules above every project and worktree: Node and npm find it by walking up
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(DEPS, 'node_modules'), path.join(ROOT, 'node_modules'));
  for (const arm of ARMS) { const d = makeBase(arm, kit); const b = build(d); fs.rmSync(path.join(d, '.next'), { recursive: true, force: true }); console.log(`base-${arm}: build ${b.ok ? 'ok' : 'FAILED\n' + b.tail}`); }
}
if (cmd === 'run') {
  const OUT = a1, N = Number(a2 || 3); fs.mkdirSync(OUT, { recursive: true });
  const lanes = []; for (const task of Object.keys(TASKS)) for (const arm of ARMS) lanes.push({ task, arm });
  await Promise.all(lanes.map(async ({ task, arm }) => {
    for (let n = 1; n <= N; n++) {
      const name = `${task}-${arm}-${n}`, dir = path.join(ROOT, name), log = path.join(OUT, `${name}.jsonl`);
      const baseSha = copyBase(arm, dir);
      const code = await claude(dir, TASKS[task], log);
      const r = readLog(log), tree = resultTree(dir, baseSha), diff = appDiff(tree, baseSha);
      fs.writeFileSync(path.join(OUT, `${name}.diff`), diff);
      const c = checks(task, tree, diff), b = build(tree), j = await judge(task, diff, path.join(OUT, `${name}.judge.json`));
      const res = { name, task, arm, exit: code, cost: r.cost, turns: r.turns, tools: r.tools, resultIn: path.relative(ROOT, tree), build: b.ok, checks: c, judge: j, final: r.final };
      fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(res, null, 2));
      // a run's project, its origin and any worktree it made are gone once graded: builds are about 150 MB each
      for (const e of fs.readdirSync(ROOT)) if (e === name || e.startsWith(`${name}.`) || e.startsWith(`${name}-`)) fs.rmSync(path.join(ROOT, e), { recursive: true, force: true });
      console.log(`${name}: judge ${j.score ?? '?'} · build ${b.ok ? 'ok' : 'FAIL'} · $${(r.cost || 0).toFixed(2)} · ${JSON.stringify(c)}`);
    }
  }));
}
