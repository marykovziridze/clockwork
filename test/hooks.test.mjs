// Tests for templates/claude/hooks/{guard-bash,session-start,prompt-intake}.mjs and the two settings templates.
// Offline. Fixtures live under os.tmpdir() and are removed at the end. Run: node --test test/hooks.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPrivate, PRIVATE_FILE } from './private.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_DIR = path.join(KIT, 'templates', 'claude');
const HOOKS = path.join(CLAUDE_DIR, 'hooks');
const GUARD = path.join(HOOKS, 'guard-bash.mjs');
const START = path.join(HOOKS, 'session-start.mjs');
const INTAKE = path.join(HOOKS, 'prompt-intake.mjs');
const { evaluate, parseShell } = await import(pathToFileURL(GUARD).href);
const { looksLikeSourceMaterial } = await import(pathToFileURL(INTAKE).href);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clockwork-hooks-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------- fixtures
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let counter = 0;
const mk = (name) => { const d = path.join(TMP, `${name}-${++counter}`); fs.mkdirSync(d, { recursive: true }); return fs.realpathSync(d); };

function repo(name = 'repo', branch = 'main') {
  const d = mk(name);
  g(d, 'init', '-q', '-b', branch);
  fs.writeFileSync(path.join(d, 'a.txt'), 'a');
  g(d, 'add', 'a.txt'); g(d, 'commit', '-qm', 'init');
  return d;
}

const ctxFor = (cwd, overnight = false, patterns) => ({
  cwd, overnight,
  productionPatterns: () => patterns || ['vercel --prod', 'vercel deploy --prod', 'gh pr merge', 'git push [^ ]+ [^ ]*:main'],
});
const verdict = (command, ctx) => {
  const { findings } = evaluate(command, ctx);
  const d = findings.find((f) => f.deny); if (d) return { kind: 'deny', reason: d.deny };
  const a = findings.find((f) => f.ask); if (a) return { kind: 'ask', reason: a.ask };
  return { kind: 'allow', reason: '' };
};

function runHook(file, input, { env = {}, cwd, rawInput } = {}) {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, [file], { input: rawInput !== undefined ? rawInput : JSON.stringify(input), encoding: 'utf8', cwd, env: e, timeout: 60000 });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* not json */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const CLEAN_ENV = { OVERNIGHT: undefined, CLOCKWORK_ROOT: undefined, CLAUDE_PROJECT_DIR: undefined };
const bash = (command, cwd, env = {}) => runHook(GUARD, { session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, { env: { ...CLEAN_ENV, ...env }, cwd });

// ================================================================ guard-bash: protocol
describe('guard-bash protocol', () => {
  test('deny: exit 2, stderr reason, and the documented JSON shape', () => {
    const r = bash('git add -A', TMP);
    assert.equal(r.code, 2);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /git add <file>/);
    assert.match(r.stderr, /Blocked: "git add -A"/);
  });
  test('allow: exit 0 and completely silent', () => {
    const r = bash('git status && git diff --stat', TMP);
    assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  });
  test('ask: exit 0 with permissionDecision ask (main checkout while other worktrees exist)', () => {
    const main = repo('ask'); const wt = path.join(mk('wt-parent'), 'wt');
    g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const r = bash('git checkout feat-x', main);
    assert.equal(r.code, 0);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /claude -w <task>/);
  });
  test('ask becomes deny when OVERNIGHT=1 (nobody is there to answer, and ask would stall the run)', () => {
    const main = repo('ask-night'); const wt = path.join(mk('wt-parent'), 'wt');
    g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    const r = bash('git switch feat', main, { OVERNIGHT: '1' });
    assert.equal(r.code, 2);
  });
  test('non-Bash tool, empty command, missing tool_input: silent exit 0', () => {
    for (const input of [{ tool_name: 'Edit', tool_input: { file_path: '/x' } }, { tool_name: 'Bash', tool_input: { command: '   ' } }, { tool_name: 'Bash' }, {}]) {
      const r = runHook(GUARD, input, { env: CLEAN_ENV });
      assert.equal(r.code, 0); assert.equal(r.stdout, '');
    }
  });
  test('JSON null / array / number on stdin is treated as empty input: silent exit 0 (no crash)', () => {
    for (const raw of ['null', '[]', '42', '"x"']) {
      const r = runHook(GUARD, null, { env: CLEAN_ENV, rawInput: raw });
      assert.equal(r.code, 0, raw); assert.equal(r.stdout, '', raw);
    }
  });
  test('unreadable stdin fails OPEN with a visible warning (systemMessage), never a crash', () => {
    const r = runHook(GUARD, null, { env: CLEAN_ENV, rawInput: '{not json' });
    assert.equal(r.code, 0);
    assert.match(r.json.systemMessage, /NOT checked/);
  });
  test('OVERNIGHT reads productionPatterns from clockwork.json (project root via CLAUDE_PROJECT_DIR)', () => {
    const root = mk('proj');
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), JSON.stringify({ productionPatterns: ['pnpm deploy:prod'] }));
    const denied = bash('pnpm deploy:prod', root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root });
    assert.equal(denied.code, 2);
    assert.match(denied.json.hookSpecificOutput.permissionDecisionReason, /overnight/);
    assert.equal(bash('pnpm deploy:prod', root, { CLAUDE_PROJECT_DIR: root }).code, 0, 'not overnight: allowed');
    assert.equal(bash('pnpm build', root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 0);
  });
  test('broken clockwork.json falls back to the default production patterns', () => {
    const root = mk('proj-bad');
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), '{oops');
    assert.equal(bash('vercel --prod', root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 2);
  });
  test('an invalid regex in productionPatterns is matched as plain text and reported, not thrown', () => {
    const v = evaluate('my-deploy "(prod"', ctxFor(TMP, true, ['my-deploy (prod']));
    assert.ok(v.findings.some((f) => f.deny), 'plain-text match denies');
    assert.ok(v.warnings.some((w) => /not a valid regex/.test(w)));
  });
});

// ================================================================ guard-bash: deny cases
const DENY = [
  // git add sweeps
  ['git add -A', /git add -A/], ['git add --all', /git add/], ['git add .', /git add \./], ['git add ./', /stages every file/],
  ['git add -Av', /stages every file/], ['git add -vA', /stages every file/], ['git add -u', /stages every file/], ['git add --update', /stages every file/],
  ['git add -A .', /stages every file/], ['git add -A -- .', /stages every file/], ['git add -- .', /stages every file/], ['git add "."', /stages every file/],
  ["git add '-A'", /stages every file/], ['git add $\'-A\'', /stages every file/], ['git add *', /stages every file/], ['git add :/', /stages every file/],
  ['git add -A :!node_modules', /stages every file/], ['git add ..', /stages every file/], ['git add -f .', /stages every file/], ['git add -p .', /stages every file/],
  ['git   add   -A', /stages every file/], ['git\tadd\t-A', /stages every file/], ['git "add" .', /stages every file/], ['"git" add -A', /stages every file/], ['\\git add -A', /stages every file/],
  ['/usr/bin/git add -A', /stages every file/], ['./git add -A', /stages every file/],
  ['git -C /some/dir add -A', /stages every file/], ['git -C a -C b add .', /stages every file/], ['git --no-pager add -A', /stages every file/], ['git -c core.quotepath=off add -A', /stages every file/],
  ['git --git-dir=/x/.git --work-tree=/x add -A', /stages every file/],
  // wrappers and prefixes
  ['FOO="a b" git add -A', /stages every file/], ["FOO='a b' git stash", /git stash/], ['FOO=a\\ b git add -A', /stages every file/], ['FOO=x"y z" git add -A', /stages every file/], ['A=$(pwd) git add -A', /stages every file/],
  ['FOO=1 git add -A', /stages every file/], ['A=1 B=2 git add .', /stages every file/], ['env git add -A', /stages every file/], ['env -i FOO=1 git add -A', /stages every file/],
  ['command git add -A', /stages every file/], ['builtin command git add .', /stages every file/], ['exec git add -A', /stages every file/], ['nohup git add -A', /stages every file/],
  ['time git add -A', /stages every file/], ['sudo git add -A', /stages every file/], ['sudo -u bob git add -A', /stages every file/], ['nice -n 5 git add -A', /stages every file/],
  ['timeout 5 git add -A', /stages every file/], ['timeout -s KILL 5 git add -A', /stages every file/], ['xargs git add -A', /stages every file/], ['xargs -n1 git add -A', /stages every file/],
  ['! git add -A', /stages every file/], ['time (git add -A)', /stages every file/], ['! (git stash)', /git stash/], ['if (git stash); then echo x; fi', /git stash/], ['(git add -A) &', /stages every file/], ['coproc git add -A', /stages every file/],
  ['f() { git add -A; }; f', /stages every file/], ['cat <<\'EOF\' > f\nx\nEOF\ngit add -A', /stages every file/], ['cat <<A <<B\none\nA\ntwo\nB\ngit stash', /git stash/], ['git commit -m "Fix $(git stash)"', /git stash/], ['git add -A\r\ngit status', /stages every file/], ['stdbuf -oL git add -A', /stages every file/],
  // chaining, grouping, control flow
  ['echo x; git add -A', /stages every file/], ['echo x && git add -A', /stages every file/], ['false || git add -A', /stages every file/], ['echo x | git add -A', /stages every file/],
  ['echo x\ngit add -A', /stages every file/], ['echo x &\ngit add -A', /stages every file/], ['git status && git add . && git commit -m x', /stages every file/],
  ['cd /tmp && git add .', /stages every file/], ['(git add -A)', /stages every file/], ['( cd x && git add -A )', /stages every file/], ['{ git add -A; }', /stages every file/],
  ['if true; then git add -A; fi', /stages every file/], ['for f in a b; do git add -A; done', /stages every file/], ['while true; do git add -A; done', /stages every file/],
  ['git add -A # trailing comment does not hide it', /stages every file/], ['git add -A\\\n', /stages every file/], ['git \\\n  add \\\n  -A', /stages every file/],
  // nested shells, eval, substitution, heredocs fed to a shell
  ['bash -c "git add -A"', /stages every file/], ["sh -c 'git add .'", /stages every file/], ['zsh -c "git add -A"', /stages every file/], ["bash -lc 'git add -A'", /stages every file/],
  ['bash -ec "git add -A"', /stages every file/], ['bash -c \'bash -c "git add -A"\'', /stages every file/], ['sh -c "cd x && git add -A"', /stages every file/],
  ['bash -o pipefail -c "git add -A"', /stages every file/], ['eval "git add -A"', /stages every file/], ['eval git add -A', /stages every file/], ["eval 'echo x; git add -A'", /stages every file/],
  ['echo $(git add -A)', /stages every file/], ['echo "$(git add -A)"', /stages every file/], ['echo `git add -A`', /stages every file/], ['echo "`git add -A`"', /stages every file/],
  ['X=$(git add -A)', /stages every file/], ['cat <(git add -A)', /stages every file/], ['echo "$(echo "$(git add -A)")"', /stages every file/],
  ['bash <<EOF\ngit add -A\nEOF', /stages every file/], ["sh <<'EOF'\ngit add -A\nEOF", /stages every file/], ['bash <<< "git add -A"', /stages every file/], ['bash -s <<EOF\ngit add .\nEOF', /stages every file/],
  ['cat <<EOF\n$(git add -A)\nEOF', /stages every file/], ['cat <<EOF\n`git add -A`\nEOF', /stages every file/],
  ['git commit -m "$(git add -A; echo msg)"', /stages every file/],
  // commit -a
  ['git commit -a', /commit -a/], ['git commit -am "x"', /commit -a/], ['git commit -a -m x', /commit -a/], ['git commit -m x -a', /commit -a/], ['git commit --all -m x', /commit -a/],
  ['git commit -qam x', /commit -a/], ['git commit -m "x" --all', /commit -a/], ['git commit --amend -a --no-edit', /commit -a/], ['git -C x commit -am y', /commit -a/],
  ['git add src/a.ts && git commit -am "x"', /commit -a/], ['bash -c "git commit -am x"', /commit -a/], ['git commit -F msg.txt -a', /commit -a/], ['git commit -m "a" -m "b" -a', /commit -a/],
  // --no-verify and the ways around it
  ['git commit -m x --no-verify', /hooks must not be skipped/], ['git commit --no-verify -m x', /hooks must not be skipped/], ['git commit -n -m x', /hooks must not be skipped/],
  ['git commit -nm x', /hooks must not be skipped/], ['git commit -m x --no-verif', /hooks must not be skipped/], ['git push --no-verify', /hooks must not be skipped/],
  ['git push origin feat --no-verify', /hooks must not be skipped/], ['git merge --no-verify x', /hooks must not be skipped/], ['git rebase --no-verify main', /hooks must not be skipped/],
  ['git cherry-pick --no-verify abc', /hooks must not be skipped/], ['git -c core.hooksPath=/dev/null commit -m x', /hooks must not be skipped/],
  ['git -c core.hooksPath=/dev/null push', /hooks must not be skipped/], ['git -c core.hookspath= commit -m x', /hooks must not be skipped/],
  ['HUSKY=0 git commit -m x', /hooks must not be skipped/], ['env HUSKY=0 git push', /hooks must not be skipped/], ['bash -c "git commit -m x --no-verify"', /hooks must not be skipped/],
  ['git add a && git commit -m x --no-verify', /hooks must not be skipped/],
  ['git config core.hooksPath /dev/null', /hooks must not be skipped/], ['git config --local core.hookspath .nohooks', /hooks must not be skipped/], ['git config --unset core.hooksPath', /hooks must not be skipped/],
  ['git -C x config --global core.hooksPath /dev/null', /hooks must not be skipped/], ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x', /hooks must not be skipped/],
  // stash
  ['git stash', /git stash/], ['git stash push -m wip', /git stash/], ['git stash -u', /git stash/], ['git stash --include-untracked', /git stash/], ['git stash pop', /git stash/],
  ['git stash apply', /git stash/], ['git stash drop', /git stash/], ['git stash clear', /git stash/], ['git stash save wip', /git stash/], ['git stash branch x', /git stash/],
  ['git -C x stash', /git stash/], ['git stash -- file.txt', /git stash/], ['sh -c "git stash"', /git stash/], ['git pull && git stash pop', /git stash/],
  ['echo x; git stash pop', /git stash/], ['X=$(git stash)', /git stash/], ['eval "git stash"', /git stash/], ['true && git stash || true', /git stash/],
  // force push to main
  ['git push --force origin main', /rewrites/], ['git push -f origin main', /rewrites/], ['git push origin main -f', /rewrites/], ['git push origin main --force', /rewrites/],
  ['git push --force-with-lease origin main', /rewrites/], ['git push --force-with-lease=main:abc123 origin main', /rewrites/], ['git push origin +main', /rewrites/],
  ['git push origin +HEAD:main', /rewrites/], ['git push -f origin HEAD:refs/heads/main', /rewrites/], ['git push --force origin master', /rewrites/], ['git push -fu origin main', /rewrites/],
  ['git push origin --force main', /rewrites/], ['git push origin feat:main -f', /rewrites/], ['git push --mirror', /rewrites/], ['git push --mirror origin', /rewrites/],
  ['git push --force --all', /rewrites/], ['git push origin :main', /rewrites/], ['git push --delete origin main', /rewrites/], ['git push origin --delete master', /rewrites/],
  ['git -C repo push -f origin main', /rewrites/], ['bash -c "git push -f origin main"', /rewrites/], ['git push origin +refs/heads/main', /rewrites/], ['git push -f origin "+main"', /rewrites/],
  ['git push -f origin refs/heads/*:refs/heads/*', /rewrites/],
  // deploy / merge chained with ; (or newline, ||, &) instead of &&
  ['git fetch; git merge origin/main', /runs after/], ['git merge x ; vercel --prod', /runs after/], ['cd /x; git merge feature', /runs after/], ['cd /x\ngit merge feature', /runs after/],
  ['pnpm build; vercel --prod', /runs after/], ['pnpm build; vercel deploy --prod', /runs after/], ['pnpm build;vercel --prod', /runs after/], ['pnpm build\nvercel --prod', /runs after/],
  ['pnpm build || vercel --prod', /runs after/], ['pnpm build & vercel --prod', /runs after/], ['pnpm test; gh pr merge 5 --squash', /runs after/],
  ['git merge a; git merge b', /runs after/], ['bash -c "pnpm build; vercel --prod"', /runs after/], ['pnpm build; bash -c "vercel --prod"', /runs after/], ['pnpm build; npx vercel --prod', /runs after/],
  ['pnpm build; pnpm vercel --prod', /runs after/], ['pnpm build; vercel --production', /runs after/], ['pnpm build; vercel promote dpl_1', /runs after/], ['pnpm build; gh -R o/r pr merge 3', /runs after/],
  ['cd x; git merge y', /runs after/], ['echo hi; cd x; git merge y', /runs after/], ['git log; pnpm build; vercel --prod', /runs after/], ['true; pnpm build; vercel --prod', /runs after/],
  ['set +e; cd x; vercel --prod', /runs after/], ['git switch main\ngit merge x', /runs after/], ['git pull --ff-only; git merge x', /runs after/], ['git checkout main; git pull; git merge --no-ff y', /runs after/],
  ['vercel --scope team --prod; echo x; vercel . --prod', /runs after/], ['cd x; vercel . --prod', /runs after/], ['cd x; vercel deploy --target production', /runs after/], ['cd x; vercel --target=production', /runs after/],
  ['cd x; vercel rollback', /runs after/], ['cd x; vercel --token $T --prod --yes', /runs after/],
  ['(cd x; vercel --prod)', /runs after/], ['if cd x; then vercel --prod; fi', /runs after/], ['pnpm build; git -C dir merge origin/main', /runs after/],
];
describe('guard-bash: every deny case', () => {
  const ctx = ctxFor(TMP);
  for (const [cmd, re] of DENY) {
    test(`deny ${JSON.stringify(cmd)}`, () => {
      const v = verdict(cmd, ctx);
      assert.equal(v.kind, 'deny', `expected deny, got ${v.kind}`);
      assert.match(v.reason, re);
    });
  }
  test('every deny reason names a safe alternative', () => {
    for (const [cmd] of DENY) {
      const { reason } = verdict(cmd, ctx);
      assert.match(reason, /instead|Commit on your own|Push your own|Join the steps|Fix what|Stage exact paths|then commit again|<file>/i, cmd);
    }
  });
});

// ================================================================ guard-bash: overnight
const OVERNIGHT_DENY = [
  'vercel --prod', 'vercel deploy --prod', 'vercel deploy --prebuilt --prod', 'vercel --production', 'vercel promote dpl_1', 'npx vercel --prod', 'pnpm vercel --prod', 'pnpm dlx vercel --prod',
  'bunx vercel --prod', 'pnpm exec vercel --prod', 'vercel --scope team --prod', 'vercel . --prod', 'vercel deploy --target production', 'vercel --target=production', 'vercel rollback', 'VERCEL_ORG_ID=x vercel --prod', 'pnpm build && vercel --prod', 'bash -c "vercel --prod"', 'eval "vercel --prod"', 'echo x; vercel --prod',
  'gh pr merge 3', 'gh pr merge 3 --squash --delete-branch', 'gh -R o/r pr merge 3', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main', 'git push origin main', 'git push origin master',
  'git push -u origin main', 'git push origin feat:main', 'git push --all', 'git push --mirror', 'git -C repo push origin main', 'echo x && git push origin main',
];
const OVERNIGHT_ALLOW = [
  'vercel', 'vercel deploy', 'vercel deploy --prebuilt', 'vercel ls', 'vercel ls --prod', 'vercel logs --prod', 'vercel inspect x --prod', 'vercel env pull --prod', 'echo "vercel --prod"', "printf 'gh pr merge 3'", 'git push origin feature', 'git push -u origin feat/login', 'git push origin HEAD:feat/x',
  'git commit -m "vercel --prod"', 'git commit -m "gh pr merge"', 'cat <<\'EOF\'\nvercel --prod\nEOF', 'gh pr view 3', 'gh pr create --title "x" --body "run vercel --prod later"', 'git merge origin/main',
  'pnpm build && pnpm test', 'git push --force-with-lease origin feature',
];
describe('guard-bash: OVERNIGHT=1', () => {
  for (const cmd of OVERNIGHT_DENY) test(`night deny ${JSON.stringify(cmd)}`, () => {
    const v = verdict(cmd, ctxFor(TMP, true));
    assert.equal(v.kind, 'deny');
    assert.match(v.reason, /overnight|rewrites|runs after/);
  });
  for (const cmd of OVERNIGHT_ALLOW) test(`night allow ${JSON.stringify(cmd)}`, () => {
    assert.equal(verdict(cmd, ctxFor(TMP, true)).kind, 'allow');
  });
  test('the overnight reason says how to queue the approval', () => {
    assert.match(verdict('vercel --prod', ctxFor(TMP, true)).reason, /node "\$CLOCKWORK_TOOLS\/registry\.mjs" mint A/);
    assert.match(verdict('git push origin main', ctxFor(TMP, true)).reason, /push your own branch by name \(git push -u origin <branch>\)/);
  });
  test('without OVERNIGHT the same production commands are allowed when chained with && or alone', () => {
    for (const cmd of ['vercel --prod', 'gh pr merge 3', 'git push origin main', 'pnpm build && vercel --prod']) assert.equal(verdict(cmd, ctxFor(TMP, false)).kind, 'allow', cmd);
  });
  test('git push with no refspec from main is denied overnight, allowed on a feature branch', () => {
    const onMain = repo('push-main'); const onFeat = repo('push-feat', 'feat');
    assert.equal(verdict('git push', ctxFor(onMain, true)).kind, 'deny');
    assert.equal(verdict('git push', ctxFor(onFeat, true)).kind, 'allow');
  });
});

// ================================================================ guard-bash: git state
describe('guard-bash: rules that read git state', () => {
  test('force push with no refspec: deny on main, allow on a feature branch', () => {
    const onMain = repo('fp-main'); const onFeat = repo('fp-feat', 'feat');
    for (const c of ['git push --force', 'git push -f origin', 'git push --force-with-lease', 'git push -f origin HEAD', 'git push -f origin HEAD:main']) assert.equal(verdict(c, ctxFor(onMain)).kind, 'deny', c);
    for (const c of ['git push --force', 'git push -f origin HEAD', 'git push --force-with-lease origin feat']) assert.equal(verdict(c, ctxFor(onFeat)).kind, 'allow', c);
    assert.equal(verdict('git push origin HEAD', ctxFor(onMain)).kind, 'allow', 'plain push of main is not a force push');
  });
  test('git -C and cd change which repository is judged', () => {
    const onMain = repo('fp-c-main'); const onFeat = repo('fp-c-feat', 'feat');
    assert.equal(verdict(`git -C "${onMain}" push -f`, ctxFor(onFeat)).kind, 'deny');
    assert.equal(verdict(`cd "${onMain}" && git push -f`, ctxFor(onFeat)).kind, 'deny');
    assert.equal(verdict(`git -C "${onFeat}" push -f`, ctxFor(onMain)).kind, 'allow');
  });
  test('checkout/switch in the main checkout with other worktrees: ask; everywhere else: allow', () => {
    const main = repo('co'); const wt = path.join(mk('co-wt'), 'wt'); g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    for (const c of ['git checkout feat', 'git checkout -b new', 'git switch feat', 'git switch -c new', 'git checkout -- a.txt', 'git -C . checkout feat', 'echo x && git checkout main']) {
      assert.equal(verdict(c, ctxFor(main)).kind, 'ask', c);
    }
    assert.equal(verdict(`cd "${main}" && git checkout feat`, ctxFor(TMP)).kind, 'ask', 'cd is followed');
    assert.equal(verdict(`git -C "${main}" checkout feat`, ctxFor(TMP)).kind, 'ask', '-C is followed');
    assert.equal(verdict('git checkout feat', ctxFor(wt)).kind, 'allow', 'inside the linked worktree');
    assert.equal(verdict(`git -C "${wt}" switch feat`, ctxFor(main)).kind, 'allow', '-C into the linked worktree');
    assert.equal(verdict('git checkout feat', ctxFor(TMP)).kind, 'allow', 'not a repository: fail open');
    assert.equal(verdict('echo "git checkout feat"', ctxFor(main)).kind, 'allow', 'text is not a command');
    assert.equal(verdict('git checkout feat', ctxFor(main, true)).kind, 'deny', 'overnight: ask becomes deny');
  });
  test('checkout in a main checkout with NO other worktrees is allowed', () => {
    const main = repo('co-alone');
    assert.equal(verdict('git checkout -b new', ctxFor(main)).kind, 'allow');
    assert.equal(verdict('git switch -c other', ctxFor(main, true)).kind, 'allow');
  });
  test('a pruned (deleted) worktree does not count as an other worktree', () => {
    const main = repo('co-prune'); const wt = path.join(mk('co-prune-wt'), 'wt'); g(main, 'worktree', 'add', '-q', '-b', 'gone', wt);
    fs.rmSync(wt, { recursive: true, force: true });
    assert.equal(verdict('git checkout gone', ctxFor(main)).kind, 'allow');
  });
});

// ================================================================ guard-bash: false positives
const ALLOW = [
  // text inside echo / printf / heredoc / commit messages is data
  'echo "git add -A"', "echo 'git add .'", 'echo git add -A', 'printf "git stash\\n"', "printf '%s' 'git add -A'", 'echo "run git commit -am later"', 'echo "push --force origin main"',
  'echo "a; vercel --prod"', 'echo "x; git merge origin/main"', 'echo hi # git add -A', '# git add -A\nls', 'echo "--no-verify"', 'echo $HOME "git stash"',
  'git commit -m "never run git add -A"', 'git commit -m "fix: git stash bug" -m "second paragraph --no-verify"', 'git commit -m "use git commit -a carefully"', "git commit -m 'git stash pop; git add -A'",
  'git commit -m "x" -m "--no-verify"', 'git commit -m --no-verify', 'git commit -ma "x"', 'git commit --message="do not --no-verify" --allow-empty', 'git commit -F msg.txt',
  'git commit -m "$(cat <<\'EOF\'\nfix thing\n\nDo not run git add -A; git stash; git push --force origin main; --no-verify\nEOF\n)"',
  'git commit -m "$(cat <<\'EOF\'\nfix\n\nCo-Authored-By: X <x@y.z>\nEOF\n)" && git status',
  'git commit -m "$(cat <<EOF\nplain heredoc with git add -A inside\nEOF\n)"',
  'git tag -a v1 -m "git add -A; git stash"', 'gh pr create --title "x" --body "git stash; git add -A; vercel --prod"', 'gh pr comment 3 --body "--no-verify"',
  'cat <<\'EOF\'\ngit add -A\ngit stash\nvercel --prod\nEOF', 'cat <<EOF\ngit stash\nEOF', 'cat > notes.md <<\'EOF\'\ngit push --force origin main\nEOF', 'cat <<-\'EOF\'\n\tgit add -A\n\tEOF',
  'cat <<EOF > f.txt\ngit add -A\nEOF', 'tee f.txt <<\'EOF\'\ngit add .\nEOF', 'python3 - <<\'PY\'\nprint("git add -A")\nPY', 'node -e "console.log(\'git add -A\')"', 'python3 -c "print(\'git stash\')"',
  'grep -r "git add -A" .', 'grep -- "--no-verify" file', 'rg "git stash" docs', 'sed -n "1,5p" README.md', 'man git-stash', 'echo "$(date) git add -A"', 'echo "\\$(git add -A)"', "echo '$(git add -A)'",
  'cat <<\'EOF\'\n$(git add -A)\nEOF', 'echo "$(cat <<\'EOF\'\n) git add -A\nEOF\n)"', 'a=(1 2 3); echo ${a[1]}', 'f() { echo hi; }; f', 'cat <<EOF\n\\$(git add -A)\nEOF', 'bash script.sh', 'bash -c "echo git add -A"', "sh -c 'echo x'", 'eval "echo git stash"',
  // legitimate git
  'git add src/a.ts src/b.ts', 'git add a.txt', 'git add .gitignore', 'git add .env.example', 'git add -- file.txt', 'git add -p file.txt', 'git add -A src/', 'git add -A -- src/a.ts', 'git add -u src/',
  'git add "foo bar.txt"', 'git add foo\\ bar.txt', 'git add ./src/a.ts', 'git add -N src/new.ts', 'git add -f build/out.js', 'git add --intent-to-add a.txt',
  'git commit -m "x"', 'git commit --amend --no-edit', 'git commit --allow-empty -m x', 'git commit -S -m x', 'git commit -m x --signoff', 'git commit -m x -- src/a.ts', 'git commit -i a.txt -m x',
  'git commit --dry-run', 'git status', 'git diff --stat', 'git log --all --oneline', 'git log -n 5', 'git diff --all', 'git branch -a', 'git branch --no-merged', 'git reset a.txt',
  'git stash list', 'git stash show -p', 'git stash show stash@{0}', 'git -C x stash list', 'git merge-base HEAD origin/main', 'git mergetool --tool-help', 'git merge --abort', 'false; git merge --abort',
  'git fetch && git merge origin/main', 'git fetch origin && git merge --ff-only origin/main', 'cd /tmp && git merge x', 'git merge x && git push origin feat', 'git merge x || git merge --abort',
  'git push origin feature', 'git push -u origin HEAD:feature', 'git push origin HEAD:refs/heads/feat', 'git push --force-with-lease origin feature', 'git push -f origin feat/login', 'git push -n origin main',
  'git push --dry-run origin main', 'git push origin main', 'git push origin +feature', 'git push origin --delete old-branch', 'git push origin :old-branch', 'git push --tags', 'git push origin v1.2.0',
  'git push origin HEAD:main-menu-fix', 'git push origin main-menu',
  'git config core.hooksPath', 'git config --get core.hooksPath', 'git config user.name "x"', 'git config --list', 'git config --global core.editor vim',
  'git checkout', 'git restore a.txt', 'git rebase -i HEAD~3', 'git cherry-pick abc', 'git rebase --continue',
  // chaining done right
  'pnpm build && vercel --prod', 'pnpm build && vercel deploy --prod', 'pnpm build && pnpm test && gh pr merge 5 --squash', 'vercel --prod; echo done', 'vercel --prod\necho done',
  'pnpm build; vercel deploy', 'pnpm build; vercel', 'pnpm build; vercel ls', 'git merge x | tail -3', 'echo x | vercel --prod', 'cd x && git merge origin/main && git push origin feat',
  'vercel --prod', 'git merge origin/main', 'gh pr merge 5',
  // nothing that can fail ran before the merge/deploy, or the script uses set -e
  'echo start; git merge x', 'git log --oneline -1\ngit merge --no-ff x', 'echo "--- merging"; git merge --no-ff t1 -m x', 'git status; git merge y', 'pwd; vercel --prod', 'set -e\ncd x\ngit merge y',
  'set -euo pipefail\ncd x; vercel --prod', 'set -o errexit; cd x; git merge y', 'for b in a b; do echo $b; git merge $b; done', 'if [ -f x ]; then git merge y; fi', 'git rev-parse HEAD; git merge y',
  'git worktree list; git merge y', 'echo a\necho b\ngit merge --no-ff c -m "x"',
  // vercel reads are not deploys
  'cd x; vercel ls --prod', 'echo a; cd x; vercel ls contoso-website --prod', 'cd x; vercel logs --prod', 'cd x; vercel inspect dpl_1 --prod', 'cd x; vercel env ls --prod', 'cd x; vercel --scope team ls --prod', 'cd x; vercel pull --prod',
  // ordinary commands
  'ls -la', 'ls | head', 'cat a.txt | wc -l', 'rm -rf node_modules', 'pnpm install && pnpm build', 'pnpm build 2>&1 | tail -20', 'node script.mjs > out.txt 2>&1', 'cp a b && mv b c', 'curl -s https://example.com | jq .',
  'FOO=bar pnpm test', 'echo $((1+2))', 'echo ${HOME:-x}', 'x=$(pwd); echo "$x"', 'for f in *.txt; do echo "$f"; done', 'if [ -f a ]; then echo yes; fi', 'case $x in a) echo a;; *) echo b;; esac',
  'find . -name "*.ts" -not -path "./node_modules/*"', 'xargs -0 rm < list.txt', 'sleep 5 &', 'true && false || echo x', '(cd x && ls)', '{ echo a; echo b; }', 'echo a >&2', 'ls 2>/dev/null', 'cmd &> out.log',
  'awk \'{ print $1 }\' file', "sed -i 's/a/b/' file", 'echo "unterminated', "echo 'unterminated", 'echo $(', 'echo `', 'cat <<EOF\nnever closed', '\\', '&&', ';', '( ( (', ')', '}', '<<', '>',
];
describe('guard-bash: false positives and legitimate commands stay silent', () => {
  const ctx = ctxFor(TMP);
  for (const cmd of ALLOW) {
    test(`allow ${JSON.stringify(cmd)}`, () => {
      const v = verdict(cmd, ctx);
      assert.equal(v.kind, 'allow', v.reason);
    });
  }
});

describe('guard-bash: parser robustness', () => {
  test('junk and pathological input never throws and finishes quickly', () => {
    const junk = ['$(', '$((', '${', '`', '"', "'", '<<EOF', '<<-', '<<<', '<(', '&>', '>&', '|&', ';;;', '\\\n\\\n', '$(((((', 'bash -c', 'bash -c "', 'eval', 'eval "eval \\"eval x\\""',
      'cat <<EOF\n$(', 'echo "$(cat <<EOF\nx', '$\'\\', 'git', 'git -C', 'git -c', 'git push --force', 'git add', 'env', 'sudo', 'xargs', 'timeout', 'nice -n', 'command -v git', '  \n  \n'];
    const t0 = Date.now();
    for (const j of junk) assert.doesNotThrow(() => verdict(j, ctxFor(TMP)), j);
    let deep = 'git add -A';
    for (let i = 0; i < 12; i++) deep = `bash -c ${JSON.stringify(deep)}`;
    assert.doesNotThrow(() => verdict(deep, ctxFor(TMP)));
    const big = `echo ${'x'.repeat(300000)} && ls`;
    assert.doesNotThrow(() => verdict(big, ctxFor(TMP)));
    assert.ok(Date.now() - t0 < 10000, 'parser is linear');
  });
  test('nesting up to a sane depth is followed', () => {
    let deep = 'git add -A';
    for (let i = 0; i < 4; i++) deep = `bash -c ${JSON.stringify(deep)}`;
    assert.equal(verdict(deep, ctxFor(TMP)).kind, 'deny');
  });
  test('parseShell splits on the documented separators and records the operator before each command', () => {
    const c = parseShell('a && b || c; d | e\nf & g');
    assert.deepEqual(c.map((x) => x.words[0].s), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    assert.deepEqual(c.map((x) => x.sep), [null, '&&', '||', ';', '|', '\n', '&']);
  });
  test('quotes keep one argument together and strip leading env assignments', () => {
    const [c] = parseShell('FOO=1 BAR="x y" git commit -m "a && b; c"');
    assert.deepEqual(c.assigns, ['FOO=1', 'BAR=x y']);
    assert.deepEqual(c.words.map((w) => w.s), ['git', 'commit', '-m', 'a && b; c']);
  });
});

// ================================================================ session-start
const GIT_BIN = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
function pathWith(...dirs) { return dirs.join(path.delimiter); }
function gitOnlyBin() { const d = mk('bin-git'); fs.symlinkSync(GIT_BIN, path.join(d, 'git')); return d; }
function fakeClaudeBin(script) {
  const d = mk('bin-claude');
  fs.writeFileSync(path.join(d, 'claude'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return d;
}
const STUB_DOCTOR = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2);
if (a.includes('--summary')) { console.log('clockwork-doctor: 0 error(s), 1 warning(s), 0 not checked.\\n⚠ stub warning'); process.exit(0); }
if (a.includes('--write-baseline')) {
  const sid = a[a.indexOf('--session') + 1];
  const dir = path.join(process.env.CLOCKWORK_ROOT, '.claude', '.state'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'doctor-baseline-' + sid + '.json'), JSON.stringify({ stub: true, errors: [] })); console.log('OK baseline'); process.exit(0);
}
process.exit(2);
`;

// project = git repo (with a bare origin) that has .claude/clockwork.json, AGENTS.md and the hook files
function project({ origin = true, hooks = true, doctor = STUB_DOCTOR } = {}) {
  const root = repo('proj');
  fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), JSON.stringify({ clockworkVersion: '2.0.0', project: 'Acme', siteDir: '.' }));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Acme\n\n## Hard rules\n- Rule one: explicit paths only.\n- Rule two: no production without the user.\n\n## Other section\nnot injected\n');
  if (hooks) {
    fs.mkdirSync(path.join(root, '.claude', 'tools'), { recursive: true }); fs.writeFileSync(path.join(root, '.claude', 'tools', 'registry.mjs'), '// stub\n');
    fs.copyFileSync(START, path.join(root, '.claude', 'hooks', 'session-start.mjs'));
    if (doctor) fs.writeFileSync(path.join(root, '.claude', 'hooks', 'clockwork-doctor.mjs'), doctor);
  }
  g(root, 'add', '.claude/clockwork.json', 'AGENTS.md'); g(root, 'commit', '-qm', 'project');
  let remote = null;
  if (origin) {
    remote = path.join(mk('origin'), 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: GIT_ENV });
    g(root, 'remote', 'add', 'origin', remote); g(root, 'push', '-q', '-u', 'origin', 'main');
  }
  return { root, remote, hook: path.join(root, '.claude', 'hooks', 'session-start.mjs') };
}
const AGENTS_NONE = 'echo "[]"';
const start = (p, { source = 'startup', sid = 'sess-A', cwd, env = {}, input } = {}) =>
  runHook(p.hook, input || { session_id: sid, cwd: cwd || p.root, hook_event_name: 'SessionStart', source }, {
    cwd: cwd || p.root,
    env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: p.root, PATH: pathWith(fakeClaudeBin(AGENTS_NONE), path.dirname(GIT_BIN)), ...env },
  });
const ctxText = (r) => r.json.hookSpecificOutput.additionalContext;

describe('session-start', () => {
  test('happy path: documented JSON shape, where-you-are, peers, claim template, doctor summary, baseline', () => {
    const p = project();
    const claude = fakeClaudeBin(`echo '[{"pid":1,"cwd":"${p.root}","kind":"interactive","sessionId":"sess-A","name":"acme-me","status":"busy"},{"pid":2,"cwd":"${p.root}/.claude/worktrees/t9","kind":"interactive","sessionId":"sess-B","name":"acme-peer","status":"idle"}]'`);
    const r = start(p, { env: { PATH: pathWith(claude, path.dirname(GIT_BIN)) } });
    assert.equal(r.code, 0);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
    const t = ctxText(r);
    assert.match(t, /Clockwork session check \(startup\) for Acme/);
    assert.match(t, /Where: main checkout .* on branch main/);
    assert.match(t, /No other worktrees exist/);
    assert.match(t, /Up to date with origin/);
    assert.match(t, /Live peer sessions in this project: 1/);
    assert.match(t, /acme-peer \(idle, interactive\) in \.claude\/worktrees\/t9/);
    assert.doesNotMatch(t, /acme-me/, 'own session is not listed as a peer');
    assert.match(t, /CLAIM <session> · branch <b> · worktree <path> · IDs <T-…> · files: <exact paths> · until <condition>/);
    assert.match(t, /never the user's approval/);
    assert.match(t, /Doctor summary:\nclockwork-doctor: 0 error\(s\)/);
    assert.doesNotMatch(t, /WARNINGS/);
    assert.equal(r.json.systemMessage, undefined);
    assert.ok(fs.existsSync(path.join(p.root, '.claude', '.state', 'doctor-baseline-sess-A.json')), 'baseline written by the doctor');
    assert.ok(t.length < 10000);
  });
  test('peers running in a worktree outside the project root are found too (separate --cwd query, de-duplicated)', () => {
    const p = project();
    const wt = path.join(mk('outside'), 'wt-out'); g(p.root, 'worktree', 'add', '-q', '-b', 'outside', wt);
    const claude = fakeClaudeBin(`case "$*" in *"${wt}"*) echo '[{"sessionId":"sess-X","name":"acme-outside","status":"busy","kind":"interactive","cwd":"${wt}"},{"sessionId":"sess-Y","name":"acme-in","status":"idle","kind":"interactive","cwd":"${p.root}"}]';; *) echo '[{"sessionId":"sess-Y","name":"acme-in","status":"idle","kind":"interactive","cwd":"${p.root}"}]';; esac`);
    const r = start(p, { env: { PATH: pathWith(claude, path.dirname(GIT_BIN)) } });
    assert.match(ctxText(r), /Live peer sessions in this project: 2\./);
    assert.match(ctxText(r), /acme-outside \(busy, interactive\) in .*wt-out/);
    assert.equal((ctxText(r).match(/acme-in /g) || []).length, 1, 'listed once');
  });
  test('no peers: says so, no warning', () => {
    const p = project();
    const r = start(p);
    assert.match(ctxText(r), /Live peer sessions in this project: none/);
    assert.doesNotMatch(ctxText(r), /WARNINGS/);
  });
  test('no claude binary: exit 0 with a warning in both additionalContext and systemMessage', () => {
    const p = project();
    const r = start(p, { env: { PATH: gitOnlyBin() } });
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /WARNINGS[\s\S]*claude binary not found on PATH: live peer sessions were not checked/);
    assert.match(r.json.systemMessage, /claude binary not found/);
    assert.match(ctxText(r), /Where: main checkout/, 'the rest still ran');
  });
  test('claude agents fails or prints garbage: warning, exit 0', () => {
    const p = project();
    let r = start(p, { env: { PATH: pathWith(fakeClaudeBin('echo boom >&2; exit 3'), path.dirname(GIT_BIN)) } });
    assert.equal(r.code, 0); assert.match(ctxText(r), /claude agents failed \(boom\)/);
    r = start(p, { env: { PATH: pathWith(fakeClaudeBin('echo "not json"'), path.dirname(GIT_BIN)) } });
    assert.equal(r.code, 0); assert.match(ctxText(r), /unreadable output/);
    r = start(p, { env: { PATH: pathWith(fakeClaudeBin('echo "{}"'), path.dirname(GIT_BIN)) } });
    assert.equal(r.code, 0); assert.match(ctxText(r), /unreadable output/);
  });
  test('no git repository: exit 0 with a warning, other checks still run', () => {
    const root = mk('nogit');
    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), JSON.stringify({ project: 'Plain' }));
    fs.copyFileSync(START, path.join(root, '.claude', 'hooks', 'session-start.mjs'));
    const p = { root, hook: path.join(root, '.claude', 'hooks', 'session-start.mjs') };
    const r = start(p);
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /no git repository at .*branch, worktree and origin checks skipped/);
    assert.match(ctxText(r), /Live peer sessions in this project: none/);
    assert.match(ctxText(r), /clockwork-doctor\.mjs not found next to this hook/);
    assert.match(r.json.systemMessage, /no git repository/);
  });
  test('git missing from PATH entirely: exit 0 with a warning', () => {
    const p = project();
    const r = start(p, { env: { PATH: fakeClaudeBin(AGENTS_NONE) } });
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /git is not installed or not on PATH/);
  });
  test('no clockwork.json anywhere: exit 0, says it used the folder as root', () => {
    const d = mk('bare-dir');
    fs.mkdirSync(path.join(d, 'h')); fs.copyFileSync(START, path.join(d, 'h', 'session-start.mjs'));
    const r = runHook(path.join(d, 'h', 'session-start.mjs'), { session_id: 'x', cwd: d, source: 'startup' }, { cwd: d, env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: d, PATH: pathWith(fakeClaudeBin(AGENTS_NONE), path.dirname(GIT_BIN)) } });
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /no \.claude\/clockwork\.json found/);
  });
  test('JSON null on stdin: exit 0 and context is still injected', () => {
    const p = project();
    const r = runHook(p.hook, null, { rawInput: 'null', cwd: p.root, env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: p.root, PATH: pathWith(fakeClaudeBin(AGENTS_NONE), path.dirname(GIT_BIN)) } });
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /Clockwork session check \(startup\)/);
  });
  test('unreadable stdin still exits 0 and injects context with a warning', () => {
    const p = project();
    const r = start(p, { input: null });
    const r2 = runHook(p.hook, null, { rawInput: '{broken', cwd: p.root, env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: p.root, PATH: pathWith(fakeClaudeBin(AGENTS_NONE), path.dirname(GIT_BIN)) } });
    assert.equal(r2.code, 0);
    assert.match(ctxText(r2), /could not read the hook input/);
    assert.equal(r.code, 0);
  });
  test('origin unreachable: warning, exit 0, no hang', () => {
    const p = project();
    g(p.root, 'remote', 'set-url', 'origin', path.join(TMP, 'does-not-exist.git'));
    const t0 = Date.now();
    const r = start(p);
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /git fetch failed/);
    assert.ok(Date.now() - t0 < 15000);
  });
  test('no origin remote: no scary warning, says nothing could be compared', () => {
    const p = project({ origin: false });
    const r = start(p);
    assert.match(ctxText(r), /No "origin" remote is configured/);
    assert.doesNotMatch(ctxText(r), /git fetch failed/);
  });
  test('behind origin/main after a fetch: says how far behind', () => {
    const p = project();
    const other = path.join(mk('other'), 'clone');
    execFileSync('git', ['clone', '-q', p.remote, other], { env: GIT_ENV });
    fs.writeFileSync(path.join(other, 'new.txt'), 'n'); g(other, 'add', 'new.txt'); g(other, 'commit', '-qm', 'one'); fs.writeFileSync(path.join(other, 'new2.txt'), 'n'); g(other, 'add', 'new2.txt'); g(other, 'commit', '-qm', 'two'); g(other, 'push', '-q');
    const r = start(p);
    assert.match(ctxText(r), /Behind: HEAD is 2 behind its upstream and 2 behind origin\/main/);
  });
  test('main checkout with other worktrees: loud warning naming them; linked worktree: says so', () => {
    const p = project();
    const wt = path.join(mk('sess-wt'), 'task-1'); g(p.root, 'worktree', 'add', '-q', '-b', 'task-1', wt);
    let r = start(p);
    assert.match(ctxText(r), /WARNING: this is the main checkout and 1 other worktree\(s\) exist \(task-1:task-1\)/);
    assert.match(ctxText(r), /claude -w <task>/);
    r = start(p, { cwd: wt, sid: 'sess-wt' });
    assert.match(ctxText(r), /Where: linked worktree .*task-1 on branch task-1/);
    assert.match(ctxText(r), /Main checkout is .*registries are edited there only/);
    assert.doesNotMatch(ctxText(r), /WARNING: this is the main checkout/);
  });
  test('D13: tools by absolute path (main copy) in the context and as $CLOCKWORK_TOOLS, also from a worktree with no .claude/tools', () => {
    const p = project();
    const wt = path.join(mk('sess-tools'), 'task-2'); g(p.root, 'worktree', 'add', '-q', '-b', 'task-2', wt);
    assert.equal(fs.existsSync(path.join(wt, '.claude', 'tools')), false, 'the worktree has no tools (they are not committed)');
    const envFile = path.join(mk('envfile'), 'env.sh'); fs.writeFileSync(envFile, 'export OTHER=1\n');
    const r = start(p, { cwd: wt, sid: 'sess-tools', env: { CLAUDE_PROJECT_DIR: wt, CLAUDE_ENV_FILE: envFile } });
    const tools = path.join(p.root, '.claude', 'tools');
    assert.ok(ctxText(r).includes(`node "${path.join(tools, 'registry.mjs')}"`), ctxText(r));
    assert.equal(fs.readFileSync(envFile, 'utf8'), `export OTHER=1\nexport CLOCKWORK_TOOLS='${tools}'\n`, 'appended, never overwritten');
    const sh = execFileSync('bash', ['-c', `source "${envFile}" && printf %s "$CLOCKWORK_TOOLS"`], { encoding: 'utf8' });
    assert.equal(sh, tools, 'a path with spaces survives the shell');
  });
  test('compact: re-injects the Hard rules section only, and keeps the existing baseline', () => {
    const p = project();
    start(p, { sid: 'sess-C' });
    const file = path.join(p.root, '.claude', '.state', 'doctor-baseline-sess-C.json');
    fs.writeFileSync(file, JSON.stringify({ stub: true, errors: ['kept'] }));
    const r = start(p, { sid: 'sess-C', source: 'compact' });
    const t = ctxText(r);
    assert.match(t, /Re-injected after compaction \(AGENTS\.md\):\n## Hard rules\n- Rule one: explicit paths only\.\n- Rule two: no production without the user\./);
    assert.doesNotMatch(t, /not injected/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).errors, ['kept'], 'baseline describes session start, not compaction time');
  });
  test('compact without a Hard rules section: warns instead of failing', () => {
    const p = project();
    fs.writeFileSync(path.join(p.root, 'AGENTS.md'), '# Acme\n\n## Something else\n');
    const r = start(p, { source: 'compact' });
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /no "## Hard rules" section/);
  });
  // iCloud offload, faked (CLOCKWORK_FAKE_OFFLOADED, honoured by the real registry.mjs offloadState): never read, said.
  const offMsg = (p) => `not checked: ${p} is offloaded by iCloud — open it in Finder or run \`brctl download "${p}"\`, then re-run`;
  const withRealRegistry = (p) => { fs.copyFileSync(path.join(HOOKS, '..', 'tools', 'registry.mjs'), path.join(p.root, '.claude', 'tools', 'registry.mjs')); return p; };
  test('compact with AGENTS.md offloaded by iCloud (faked): says the hard rules were not re-injected and how to get the file', () => {
    const p = withRealRegistry(project());
    const agents = path.join(fs.realpathSync(p.root), 'AGENTS.md');
    const r = start(p, { source: 'compact', env: { CLOCKWORK_FAKE_OFFLOADED: agents } });
    assert.equal(r.code, 0);
    const t = ctxText(r);
    assert.match(t, /WARNING: AGENTS\.md is offloaded by iCloud, so its hard rules were NOT re-injected/);
    assert.equal(t.split(`- ${offMsg(agents)}`).length - 1, 1, `said once:\n${t}`);
    assert.doesNotMatch(t, /no "## Hard rules" section/, 'offloaded is not "no section"');
    assert.match(start(p, { source: 'compact' }).json.hookSpecificOutput.additionalContext, /Re-injected after compaction/, 'control: local file is injected');
  });
  test('clockwork.json offloaded by iCloud (faked): a warning with the download message; the rest still runs', () => {
    const p = withRealRegistry(project());
    const cfg = path.join(fs.realpathSync(p.root), '.claude', 'clockwork.json');
    const r = start(p, { env: { CLOCKWORK_FAKE_OFFLOADED: cfg } });
    assert.equal(r.code, 0);
    assert.ok(ctxText(r).includes(`- ${offMsg(cfg)}`), ctxText(r));
    assert.match(ctxText(r), /Where: main checkout/);
  });
  test('startup/clear/resume/fork overwrite an old baseline (they start a new measuring point)', () => {
    const p = project();
    const file = path.join(p.root, '.claude', '.state', 'doctor-baseline-sess-D.json');
    start(p, { sid: 'sess-D' });
    fs.writeFileSync(file, JSON.stringify({ stub: true, errors: ['old'] }));
    start(p, { sid: 'sess-D', source: 'resume' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).errors, []);
  });
  test('a crashing doctor is reported, not swallowed, and the session still gets context', () => {
    const p = project({ doctor: '#!/usr/bin/env node\nconsole.error("kaboom"); process.exit(2);\n' });
    const r = start(p);
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /doctor --summary crashed \(exit 2: kaboom\)/);
    assert.match(ctxText(r), /Stop baseline was not written/);
    assert.match(ctxText(r), /Where: main checkout/);
  });
  test('an oversized doctor summary is capped so additionalContext stays under the 10,000-character limit', () => {
    const p = project({ doctor: `#!/usr/bin/env node\nconsole.log(("x".repeat(400)+"\\n").repeat(100));\n` });
    const r = start(p);
    assert.ok(ctxText(r).length < 10000);
  });
  test('old baselines (> 14 days) are removed, recent ones kept', () => {
    const p = project();
    const dir = path.join(p.root, '.claude', '.state'); fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'doctor-baseline-old.json'); const fresh = path.join(dir, 'doctor-baseline-fresh.json');
    fs.writeFileSync(old, '{}'); fs.writeFileSync(fresh, '{}');
    const past = new Date(Date.now() - 20 * 86400000); fs.utimesSync(old, past, past);
    start(p);
    assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(fresh));
  });
  test('works with the real clockwork-doctor.mjs when it is present in the kit', { skip: !fs.existsSync(path.join(HOOKS, 'clockwork-doctor.mjs')) }, () => {
    const p = project({ doctor: null });
    fs.copyFileSync(path.join(HOOKS, 'clockwork-doctor.mjs'), path.join(p.root, '.claude', 'hooks', 'clockwork-doctor.mjs'));
    const r = start(p, { sid: 'sess-real' });
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /Doctor summary:\nclockwork-doctor:/);
    assert.ok(fs.existsSync(path.join(p.root, '.claude', '.state', 'doctor-baseline-sess-real.json')));
  });
  test('project path with spaces works', () => {
    const p = project();
    const spaced = path.join(mk('sp'), 'Casa Lumen'); fs.renameSync(p.root, spaced);
    const q = { root: spaced, hook: path.join(spaced, '.claude', 'hooks', 'session-start.mjs') };
    const r = start(q);
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /Casa Lumen/);
  });
});

// ================================================================ prompt-intake
const teamsTranscript = () => {
  const names = ['Sam de Wit', 'Tom van Dijk', 'Lisa Bakker'];
  const out = ['Meeting with Sam de Wit-20260826_105834-Meeting Transcript', 'August 26, 2026, 8:58AM', '37m 24s', '  started transcription'];
  for (let i = 0; i < 14; i++) out.push(` ${names[i % 3]}   ${Math.floor(i / 2)}:${String(10 + i * 3).padStart(2, '0')} So I think we should move the launch date and check the plugins first.`);
  return out.join('\n');
};
const POSITIVE = {
  'pasted_content marker (any length)': '<pasted_content id="1">\nhi\n</pasted_content id="1">',
  'Teams transcript with speaker + timestamp lines': `Process this please\n${teamsTranscript()}`,
  'Zoom chat export with [time] Name: lines': `${Array.from({ length: 30 }, (_, i) => `[10:${String(10 + i).padStart(2, '0')}:05] Jane Doe: message number ${i} about the homepage copy and the footer`).join('\n')}`,
  'Outlook email headers (English)': 'From: Anna de Vries <anna@client.example>\nSent: Tuesday, 29 September 2026 09:14\nTo: Sam de Wit\nSubject: RE: homepage feedback\n\nHi Sam, please find the feedback below. Can we move the hero image and change the CTA colour before Friday?',
  'Outlook email headers (Dutch)': 'Van: Anna de Vries <anna@client.example>\nVerzonden: dinsdag 29 september 2026 09:14\nAan: Sam de Wit\nOnderwerp: RE: feedback homepage\n\nHoi Sam, hierbij de feedback op de homepage. Kunnen we de hero afbeelding verplaatsen en de CTA kleur aanpassen?',
  'quoted email (> From:)': '> From: Anna <anna@client.example>\n> Subject: Feedback\n> Date: 29 Sep 2026\n> Hi Sam, here is our feedback on the new pages and what we would like to change next week.',
  'Subject + Sent only': 'Subject: Launch date\nSent: Monday 28 September 2026 10:00\n\nHi, can we talk about the launch date and whether mid-October is realistic for everything we agreed on?',
  'Teams recap marker': `Meeting Summary with AI Companion\nQuick recap: the team agreed on the seasonal switcher and Dutch-first content.\n${'Next steps were discussed in detail. '.repeat(30)}`,
  'Gemini notes marker': `# Meeting site — Gemini notes\n${'Decision: align on the audience landing pages and the chatbot before launch. '.repeat(15)}`,
  'started transcription marker': `Meeting Transcript\n started transcription\n${'Sam said something and John answered at length about the plugins. '.repeat(15)}`,
};
const NEGATIVE = {
  'short ordinary prompt': 'Fix the padding on the homepage hero please.',
  'empty': '',
  'long code paste': `import x from 'y';\n${'const value = compute(a, b);\nif (value > 3) { console.log(value); }\n'.repeat(60)}`,
  'long prose without speakers': `${'The client wants a calmer homepage with more whitespace and a clearer call to action. '.repeat(25)}`,
  'log lines with timestamps': Array.from({ length: 40 }, (_, i) => `2026-09-30 10:23:${String(i).padStart(2, '0')} INFO server started on port 3000 request ${i}`).join('\n'),
  'stack trace paste': `Error: boom\n${Array.from({ length: 40 }, (_, i) => `    at fn${i} (/app/src/file${i}.ts:${i + 10}:${i + 3})`).join('\n')}`,
  'single From: mention': 'Please look at the From: header handling in our mailer class, it drops the display name when the address contains a plus sign and that breaks the reply-to logic we rely on.',
  'From: and nothing else': 'From: the design, I want the buttons to look softer than they do now and the spacing between the cards to match the Figma frame we agreed on last week.',
  'the words meeting notes in a short prompt': 'Write meeting notes for the standup and keep them short.',
  'long spec doc with a Meeting notes heading': `# Spec\n## Meeting notes\n${'We will build the registry tool first and the hooks second, in that order. '.repeat(20)}`,
  'three speaker lines but short': 'Sam   0:05 hello there\nJohn   0:09 hi\nEric   0:12 hey',
  'markdown table with times': `| Time | Owner |\n|---|---|\n${Array.from({ length: 50 }, (_, i) => `| 10:${String(i).padStart(2, '0')} | Sam |`).join('\n')}`,
  'not a string': null,
};
describe('prompt-intake', () => {
  for (const [name, prompt] of Object.entries(POSITIVE)) test(`positive: ${name}`, () => assert.equal(looksLikeSourceMaterial(prompt), true));
  for (const [name, prompt] of Object.entries(NEGATIVE)) test(`negative: ${name}`, () => assert.equal(looksLikeSourceMaterial(prompt), false));
  test('positive: exact message and the documented JSON shape, exit 0', () => {
    const r = runHook(INTAKE, { session_id: 's', cwd: TMP, hook_event_name: 'UserPromptSubmit', prompt: POSITIVE['Teams transcript with speaker + timestamp lines'] });
    assert.equal(r.code, 0);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(r.json.hookSpecificOutput.additionalContext, 'This looks like client source material (a pasted transcript, email or feedback document). Run the `intake` skill before anything else, unless the user said what to do with it.');
    assert.equal(r.json.decision, undefined, 'never blocks');
  });
  test('negative: silent exit 0', () => {
    const r = runHook(INTAKE, { prompt: NEGATIVE['short ordinary prompt'] });
    assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  });
  test('empty or non-object stdin: silent exit 0; garbage: a visible warning, exit 0, never blocks', () => {
    for (const raw of ['', '{}', '[]', 'null']) {
      const r = runHook(INTAKE, null, { rawInput: raw });
      assert.equal(r.code, 0, raw); assert.equal(r.stdout, '', raw);
    }
    const g = runHook(INTAKE, null, { rawInput: '{nope' });
    assert.equal(g.code, 0); assert.match(g.json.systemMessage, /could not read the prompt/);
  });
});

// ================================================================ settings templates
describe('settings templates', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, f), 'utf8'));
  const settings = read('settings.json');
  const night = read('overnight-settings.json');
  const commands = () => Object.values(settings.hooks).flat().flatMap((m) => m.hooks.map((h) => h.command));

  test('settings.json wires five hooks, quoted, with timeouts and the right matchers', () => {
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.equal(settings.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact|fork', 'fork starts a new session that needs its own Stop baseline');
    assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash|Monitor', 'Monitor runs shell commands with the Bash permission rules (tools-reference.md)');
    assert.equal(settings.hooks.PreToolUse[1].matcher, 'Edit|Write', 'a regex tested anywhere in the tool name: also NotebookEdit (hooks.md)');
    assert.equal(settings.hooks.UserPromptSubmit[0].matcher, undefined, 'UserPromptSubmit has no matcher support');
    assert.equal(settings.hooks.Stop[0].matcher, undefined, 'Stop has no matcher support');
    const files = ['session-start.mjs', 'guard-bash.mjs', 'guard-edit.mjs', 'prompt-intake.mjs', 'clockwork-doctor.mjs'];
    assert.deepEqual(commands().map((c) => c.match(/hooks\/([\w-]+\.mjs)$/)[1]).sort(), files.slice().sort());
    for (const c of commands()) assert.match(c, /^node "\$CLAUDE_PROJECT_DIR"\/\.claude\/hooks\/[\w-]+\.mjs$/);
    for (const h of Object.values(settings.hooks).flat().flatMap((m) => m.hooks)) {
      assert.equal(h.type, 'command'); assert.ok(h.timeout > 0 && h.timeout <= 60);
    }
  });
  test('every hook file the settings name exists in the kit (the doctor is built by another builder and may be absent only there)', () => {
    for (const c of commands()) {
      const f = c.match(/hooks\/([\w-]+\.mjs)$/)[1];
      if (f === 'clockwork-doctor.mjs') continue;
      assert.ok(fs.existsSync(path.join(HOOKS, f)), f);
    }
  });
  test('all three hook files start with a node shebang and parse', () => {
    for (const f of ['session-start.mjs', 'guard-bash.mjs', 'prompt-intake.mjs']) {
      assert.match(fs.readFileSync(path.join(HOOKS, f), 'utf8'), /^#!\/usr\/bin\/env node\n/);
      execFileSync(process.execPath, ['--check', path.join(HOOKS, f)]);
    }
  });
  test('settings.json does not set autoContinueAtUsageLimit or crossSessionInbound (CONTRACT section 8)', () => {
    const s = JSON.stringify(settings);
    assert.doesNotMatch(s, /autoContinueAtUsageLimit/); assert.doesNotMatch(s, /crossSessionInbound/);
  });
  test('overnight-settings: env.OVERNIGHT "1", crossSessionInbound "accept", Remote Control off, deny list + saved-workflow allows only', () => {
    assert.deepEqual(night.env, { OVERNIGHT: '1' });
    assert.equal(night.crossSessionInbound, 'accept');
    assert.ok(['accept', 'hold', 'refuse'].includes(night.crossSessionInbound));
    assert.deepEqual(Object.keys(night).sort(), ['crossSessionInbound', 'env', 'permissions', 'remoteControlAtStartup']);
    // A Remote Control session never starts the usage-limit wait on its own (interactive-mode.md); false is honoured from any file.
    assert.equal(night.remoteControlAtStartup, false);
    assert.deepEqual(Object.keys(night.permissions).sort(), ['allow', 'deny']);
    assert.deepEqual(night.permissions.allow, ['Workflow(verify-change)', 'Workflow(build-slices)'], 'Workflow(<name>) approves one saved workflow (workflows.md)');
    assert.doesNotMatch(JSON.stringify(night), /autoContinueAtUsageLimit|bypassPermissions|defaultMode/);
  });
  test('overnight deny list: valid rule shapes, no duplicates, no MCP rule with parentheses (Claude Code skips those)', () => {
    const deny = night.permissions.deny;
    assert.equal(new Set(deny).size, deny.length);
    for (const r of deny) {
      if (r.startsWith('mcp__')) assert.match(r, /^mcp__[A-Za-z0-9_.-]+(__[A-Za-z0-9_.-]+)?$/, r);
      else assert.match(r, /^Bash\([^()]+\)$/, r);
    }
  });
  test('overnight deny list covers every outward/irreversible tool the user named', () => {
    const must = [
      'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward',
      'mcp__claude_ai_Microsoft_365__outlook_send_mail', 'mcp__claude_ai_Microsoft_365__outlook_send_draft', 'mcp__claude_ai_Microsoft_365__outlook_forward_mail',
      'mcp__claude_ai_Microsoft_365__teams_send_chat_message', 'mcp__claude_ai_Microsoft_365__teams_send_channel_message', 'mcp__claude_ai_Microsoft_365__teams_reply_channel_message',
      'mcp__claude_ai_Microsoft_365__sharepoint_delete_item', 'mcp__claude_ai_Google_Tag_Manager__gtm_publish', 'mcp__claude_ai_Google_Tag_Manager__gtm_remove',
      'mcp__claude_ai_Google_Drive__share_file', 'mcp__claude_ai_Google_Drive__trash_file', 'mcp__claude_ai_Magento__catalog_update_product_attribute',
      'mcp__claude_ai_Higgsfield', 'mcp__plugin_supabase_supabase', 'mcp__claude_ai_Atlassian_Rovo', 'mcp__claude_ai_Intuit_Mailchimp',
      'mcp__claude_ai_Google_Drive__create_file', 'mcp__claude_ai_Google_Drive__update_file', 'mcp__claude_ai_Figma__use_figma',
      'mcp__claude_ai_Microsoft_365__outlook_create_event', 'mcp__claude_ai_Microsoft_365__outlook_update_event',
      'mcp__claude_ai_Microsoft_365__outlook_respond_to_event', 'mcp__claude_ai_Microsoft_365__outlook_set_vacation', 'mcp__claude_ai_Microsoft_365__teams_create_chat',
      'mcp__claude_ai_Microsoft_365__sharepoint_upload_file', 'mcp__claude_ai_Microsoft_365__sharepoint_update_file', 'mcp__claude_ai_Microsoft_365__sharepoint_move_item',
    ];
    for (const m of must) assert.ok(night.permissions.deny.includes(m), m);
  });
  // The names to look for are the machine's privateTerms (test/private.mjs), so the kit itself names no client.
  const privateTerms = loadPrivate()?.privateTerms || [];
  test('overnight-settings.json names no client or agency: it is committed into every client repository', { skip: !privateTerms.length && `no privateTerms in ${PRIVATE_FILE}` }, () => {
    const text = JSON.stringify(night).toLowerCase();
    for (const name of privateTerms) assert.ok(!text.includes(name.toLowerCase()), `names ${name}`);
  });
  test('overnight Bash deny rules agree with the hook (the same commands are blocked by both layers)', () => {
    const bashRules = night.permissions.deny.filter((r) => r.startsWith('Bash('));
    assert.ok(bashRules.length >= 5);
    const toRe = (r) => new RegExp('^' + r.slice(5, -1).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const samples = ['vercel --prod', 'vercel deploy --prod', 'vercel promote dpl_1', 'gh pr merge 3', 'git push origin main', 'git push origin HEAD:main',
      'scp theme.zip user@host:/var/www/', 'curl -T theme.zip ftp://ftp.example.com/', 'wp post update 12 --ssh=prod',
      "ssh user@casalumen.example 'cd /var/www && git pull'", 'wget --post-file=x.json https://casalumen.example/wp-json/wp/v2/pages/12', 'http POST https://casalumen.example/wp-json/wp/v2/pages/12 content=x'];
    for (const s of samples) {
      assert.ok(bashRules.some((r) => toRe(r).test(s)), `settings rule covers: ${s}`);
      assert.equal(verdict(s, ctxFor(TMP, true)).kind, 'deny', `hook covers: ${s}`);
    }
    for (const ok of ['vercel deploy', 'git push origin feature', 'gh pr view 3']) assert.ok(!bashRules.some((r) => toRe(r).test(ok)), `settings rules leave ${ok} alone`);
  });
  // Opt-in (needs the claude binary and network): CLOCKWORK_LIVE=1 node --test test/hooks.test.mjs
  // `claude doctor` reads the project's settings files and lists any rule or hook entry it had to skip under "Invalid settings".
  test('claude doctor reports no invalid settings for either template', { skip: process.env.CLOCKWORK_LIVE !== '1' }, () => {
    for (const f of ['settings.json', 'overnight-settings.json']) {
      const d = mk('doctor-check'); fs.mkdirSync(path.join(d, '.claude'));
      fs.copyFileSync(path.join(CLAUDE_DIR, f), path.join(d, '.claude', f === 'settings.json' ? 'settings.json' : 'settings.local.json'));
      const r = spawnSync('claude', ['doctor'], { cwd: d, encoding: 'utf8', timeout: 60000, input: '' });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /Invalid settings/, `${f}:\n${r.stdout}`);
    }
  });
});

// ================================================================ round-1 fixes: late stdin, overnight deploy scripts
describe('hooks read stdin that arrives after node started (no EAGAIN fail-open)', () => {
  const late = (file, input, env = {}, cwd = TMP) => {
    const r = spawnSync('/bin/sh', ['-c', `(sleep 0.6; cat "$IN") | "${process.execPath}" "${file}"`], {
      encoding: 'utf8', cwd, timeout: 30000, env: { ...process.env, OVERNIGHT: '', CLOCKWORK_ROOT: '', IN: writeTmp(JSON.stringify(input)), ...env } });
    let json = null; try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* not json */ }
    return { code: r.status, stdout: r.stdout, json };
  };
  const writeTmp = (t) => { const f = path.join(TMP, `late-${++counter}.json`); fs.writeFileSync(f, t); return f; };
  test('guard-bash still denies git add -A when the input is written late', () => {
    for (let i = 0; i < 3; i++) {
      const r = late(GUARD, { tool_name: 'Bash', cwd: TMP, tool_input: { command: 'git add -A' } });
      assert.equal(r.code, 2, r.stdout);
    }
  });
  test('prompt-intake still nudges when the prompt arrives late', () => {
    const r = late(INTAKE, { prompt: 'From: Jan <jan@client.example>\nSent: Monday\nSubject: logo\n\n' + 'Hoi, kun je het logo sturen. '.repeat(20) });
    assert.match(r.json.hookSpecificOutput.additionalContext, /intake/);
  });
  test('guard-bash: an empty pipe is a visible fail-open, not a silent allow', () => {
    const r = runHook(GUARD, null, { env: CLEAN_ENV, rawInput: '' });
    assert.equal(r.code, 0); assert.match(r.json.systemMessage, /NOT checked/);
  });
});

describe('overnight: production deploys beyond Vercel (WordPress FTP scripts, productionDeploy, npm scripts)', () => {
  const proj = (commands = {}) => {
    const root = mk('wp');
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), JSON.stringify({ stack: 'wordpress', productionPatterns: ['vercel --prod', 'gh pr merge'], commands }));
    return root;
  };
  test('deploy scripts by name are denied overnight, allowed in the day', () => {
    const root = proj();
    for (const c of ['python3 .claude/scripts/deploy-theme-ftp.py', 'python3 -u .claude/scripts/deploy_rooms_guarded.py --live', './deploy.sh', 'bash scripts/deploy-prod.sh',
      'npm run deploy:prod', 'pnpm run release', 'cd site && php deploy.php']) {
      assert.equal(bash(c, root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 2, c);
      assert.equal(bash(c, root, { CLAUDE_PROJECT_DIR: root }).code, 0, `${c} (daytime)`);
    }
    for (const c of ['python3 .claude/scripts/measure-contrast.py', 'npm run build', 'npm run deploy:preview', 'vercel deploy']) assert.equal(bash(c, root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 0, c);
  });
  test('commands.productionDeploy is a production pattern; commands.previewDeploy stays allowed', () => {
    const root = proj({ productionDeploy: 'cd site && ./push-live.sh --all', previewDeploy: 'python3 scripts/deploy-staging.py' });
    assert.equal(bash('./push-live.sh --all', root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 2);
    assert.equal(bash('python3 scripts/deploy-staging.py', root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 0, 'the named preview deploy is allowed');
    assert.equal(bash('python3 scripts/deploy-staging.py --prod', root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 2, 'the preview command with extra arguments is not the preview command');
  });
  test('a script not named for deploying is denied overnight when its content uploads (FTP, REST write, curl -T)', () => {
    const root = proj();
    const s = path.join(root, '.claude', 'scripts'); fs.mkdirSync(s, { recursive: true });
    fs.writeFileSync(path.join(s, 't162-shared-patch.py'), 'import ftplib\nftp.storbinary(f"STOR {REMOTE}/{rel}", buf)\n');
    fs.writeFileSync(path.join(s, 'push-page.py'), 'import requests\nrequests.post(f"{SITE}/wp-json/wp/v2/pages/12", json=body)\n');
    fs.writeFileSync(path.join(s, 'send.sh'), 'curl -s -T theme.zip ftp://example.test/\n');
    fs.writeFileSync(path.join(s, 'read-page.py'), 'import requests\nrequests.get(f"{SITE}/wp-json/wp/v2/pages/12")\n');
    for (const c of ['python3 .claude/scripts/t162-shared-patch.py', 'python3 .claude/scripts/push-page.py', 'bash .claude/scripts/send.sh', 'cd .claude/scripts && python3 t162-shared-patch.py']) {
      const r = bash(c, root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root });
      assert.equal(r.code, 2, c); assert.match(r.stderr, /contains|REST/, c);
      assert.equal(bash(c, root, { CLAUDE_PROJECT_DIR: root }).code, 0, `${c} (daytime)`);
    }
    assert.equal(bash('python3 .claude/scripts/read-page.py', root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 0, 'a read-only REST script is allowed');
    assert.equal(bash('python3 .claude/scripts/missing.py', root, { OVERNIGHT: '1', CLAUDE_PROJECT_DIR: root }).code, 0, 'a script that does not exist is not guessed at');
  });
});

describe('guard-edit: code edits in the main checkout while other worktrees exist', () => {
  const EDIT = path.join(HOOKS, 'guard-edit.mjs');
  const repo = () => {
    const root = mk('ge');
    for (const [f, c] of [['src/a.css', 'a{}\n'], ['.claude/TASKS.md', '# T\n'], ['.gitignore', '.claude/worktrees/\n']]) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: root });
    return root;
  };
  const edit = (file, cwd, env = {}) => runHook(EDIT, { tool_name: 'Edit', cwd, tool_input: { file_path: file, old_string: 'a', new_string: 'b' } }, { env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: cwd, ...env }, cwd });
  test('no other worktree: allowed silently', () => {
    const root = repo();
    const r = edit(path.join(root, 'src/a.css'), root);
    assert.equal(r.code, 0); assert.equal(r.stdout, '');
  });
  test('another worktree exists: ask in the day, deny overnight; non-registry .claude files and the worktree itself pass', () => {
    const root = repo();
    execFileSync('git', ['worktree', 'add', '-q', '-b', 't1-x', path.join(root, '.claude', 'worktrees', 't1-x')], { cwd: root });
    const day = edit(path.join(root, 'src/a.css'), root);
    assert.equal(day.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(day.json.hookSpecificOutput.permissionDecisionReason, /MAIN checkout.*claude -w/);
    assert.equal(edit(path.join(root, 'src/a.css'), root, { OVERNIGHT: '1' }).json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(edit(path.join(root, '.claude/reports/HANDOVER-x.md'), root).stdout, '', 'report files are written in the main copy');
    assert.equal(edit(path.join(root, 'src/new-file.css'), root).json.hookSpecificOutput.permissionDecision, 'ask', 'a new file too');
    const wt = path.join(root, '.claude', 'worktrees', 't1-x');
    assert.equal(edit(path.join(wt, 'src/a.css'), wt).stdout, '', 'editing inside your own worktree passes');
  });
  test('hard rule 3: an Edit/Write of this project\'s registry file (main or a worktree copy) is asked by day, denied overnight; another project\'s is not judged', () => {
    const root = repo();
    for (const f of ['.claude/TASKS.md', '.claude/CLIENT-ARCHIVE.md', '.claude/FACTS.md']) {
      const d = edit(path.join(root, f), root);
      assert.equal(d.json.hookSpecificOutput.permissionDecision, 'ask', f);
      assert.match(d.json.hookSpecificOutput.permissionDecisionReason, /registry\.mjs.*hard rule 3/);
      assert.equal(edit(path.join(root, f), root, { OVERNIGHT: '1' }).json.hookSpecificOutput.permissionDecision, 'deny', `${f} overnight`);
    }
    assert.equal(edit(path.join(root, 'docs/TASKS.md'), root).stdout, '', 'a file that only shares the name is not a registry');
    const wt = path.join(root, '.claude', 'worktrees', 't2-y'); execFileSync('git', ['worktree', 'add', '-q', '-b', 't2-y', wt], { cwd: root });
    assert.equal(edit(path.join(wt, '.claude/TASKS.md'), wt).json.hookSpecificOutput.permissionDecision, 'ask', 'a worktree copy too');
    const staging = mk('staging-copy'); fs.mkdirSync(path.join(staging, '.claude'), { recursive: true });
    assert.equal(edit(path.join(staging, '.claude/TASKS.md'), root).stdout, '', 'another project (an onboarding staging copy) is not judged');
  });
  test('D13: an edit of a gitignored kit copy inside a worktree (design-system.md) is asked by day, denied overnight, and names the main copy (final BLOCK)', () => {
    const root = mk('ge-d13');
    for (const [f, c] of [['src/a.css', 'a{}\n'], ['.gitignore', '.claude/\n'], ['.claude/rules/design-system.md', '| SP-1 | 8px |\n']]) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: root });
    const wt = path.join(root, '..', `ge-d13-wt-${Date.now()}`); execFileSync('git', ['worktree', 'add', '-q', '-b', 't1', wt], { cwd: root });
    fs.mkdirSync(path.join(wt, '.claude', 'rules'), { recursive: true }); fs.copyFileSync(path.join(root, '.claude/rules/design-system.md'), path.join(wt, '.claude/rules/design-system.md'));
    const d = edit(path.join(wt, '.claude/rules/design-system.md'), wt);
    assert.equal(d.json.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(d.json.hookSpecificOutput.permissionDecisionReason, /gitignored copy.*deletes it/);
    assert.ok(d.json.hookSpecificOutput.permissionDecisionReason.includes(path.join(fs.realpathSync(root), '.claude/rules/design-system.md')), 'names the main copy');
    assert.equal(edit(path.join(wt, '.claude/rules/design-system.md'), wt, { OVERNIGHT: '1' }).json.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(edit(path.join(wt, 'src/a.css'), wt).stdout, '', 'code in the worktree passes');
    assert.equal(edit(path.join(root, '.claude/rules/design-system.md'), root).stdout, '', 'the main copy passes');
    const tracked = repo(); fs.mkdirSync(path.join(tracked, '.claude', 'rules'), { recursive: true }); fs.writeFileSync(path.join(tracked, '.claude/rules/design-system.md'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: tracked }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'r'], { cwd: tracked });
    const twt = path.join(tracked, '.claude', 'worktrees', 't9'); execFileSync('git', ['worktree', 'add', '-q', '-b', 't9', twt], { cwd: tracked });
    assert.equal(edit(path.join(twt, '.claude/rules/design-system.md'), twt).stdout, '', 'a committed .claude/ is merged like code: passes');
  });
  test('a Write that creates a file gets the path-scoped rules that apply (they load only on a read); an Edit of an existing file does not', () => {
    const root = repo(); fs.mkdirSync(path.join(root, '.claude', 'rules'), { recursive: true });
    fs.copyFileSync(path.join(HOOKS, '..', 'rules', 'design-system.md'), path.join(root, '.claude', 'rules', 'design-system.md'));
    fs.copyFileSync(path.join(HOOKS, '..', 'rules', 'engineering.md'), path.join(root, '.claude', 'rules', 'engineering.md'));
    const write = (file) => runHook(EDIT, { tool_name: 'Write', cwd: root, tool_input: { file_path: file, content: 'x' } }, { env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: root }, cwd: root });
    const ctx = write(path.join(root, 'src/components/new.tsx')).json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /design-system\.md/); assert.match(ctx, /engineering\.md/); assert.match(ctx, /read them now/);
    assert.equal(write(path.join(root, 'README.txt')).stdout, '', 'no rule matches: silent');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.writeFileSync(path.join(root, 'src', 'old.tsx'), 'x');
    assert.equal(edit(path.join(root, 'src/old.tsx'), root).stdout, '', 'an Edit needs a read first, which loads the rules');
  });
  test('outside any repository and garbage input: allowed, garbage is a visible warning', () => {
    assert.equal(edit(path.join(mk('nogit'), 'x.txt'), TMP).stdout, '');
    assert.match(runHook(EDIT, null, { env: CLEAN_ENV, rawInput: '{x' }).json.systemMessage, /NOT checked/);
  });
});

describe('guard-bash: round-3 fixes (remote writes overnight, folder restores, registry writes)', () => {
  test('overnight: ssh, curl form/data, wget posts, HTTPie writes and inline uploading code are denied; read-only and local forms pass', () => {
    const deny = ["ssh user@casalumen.example 'cd /var/www && git pull'", 'ssh prod wp plugin update --all', 'ssh -p 2222 -i key.pem deploy@1.2.3.4 ls', 'ssh prod',
      'curl -F file=@theme.zip https://casalumen.example/upload.php', 'curl --data a=1 https://api.example.com/x', 'curl --json \'{"a":1}\' https://api.example.com/x',
      'wget --post-file=x.json https://casalumen.example/wp-json/wp/v2/pages/12', 'wget --method=PUT https://api.example.com/x',
      'http POST https://casalumen.example/wp-json/wp/v2/pages/12 content=x', 'http https://api.example.com/items name=x', 'xh PATCH api.example.com/x a=1',
      "python3 -c 'import ftplib; f=ftplib.FTP(\"h\"); f.storbinary(\"STOR x\", open(\"x\",\"rb\"))'",
      'node -e \'fetch("https://casalumen.example/wp-json/wp/v2/pages/1",{method:"POST"})\''];
    for (const c of deny) { const v = verdict(c, ctxFor(TMP, true)); assert.equal(v.kind, 'deny', c); assert.match(v.reason, /overnight/, c); }
    const allow = ['ssh localhost ls', 'ssh -T git@github.com', 'curl https://api.example.com/x', 'curl -X POST http://localhost:3000/api -d a=1', 'wget https://example.com/file.zip',
      'http GET https://api.example.com/x', 'http :3000/api a=1', 'node -e \'fetch("https://api.example.com/x").then(r=>r.text())\'', 'python3 -c "print(1)"'];
    for (const c of allow) assert.equal(verdict(c, ctxFor(TMP, true)).kind, 'allow', c);
    for (const c of deny) assert.equal(verdict(c, ctxFor(TMP, false)).kind, 'allow', `${c} (daytime)`);
  });
  test('overnight: a script that only runs a remote command over ssh is denied', () => {
    const root = mk('sshscript'); fs.mkdirSync(path.join(root, '.claude', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'scripts', 'push.sh'), '#!/bin/bash\nset -e\nssh prod "cd /var/www && git pull"\n');
    const v = verdict('bash .claude/scripts/push.sh', ctxFor(root, true));
    assert.equal(v.kind, 'deny'); assert.match(v.reason, /ssh remote command/);
  });
  test('main checkout with other worktrees: a restore of a folder named without a slash, or of a registry or PM file, is asked (denied overnight)', () => {
    const main = repo('restore3'); const wt = path.join(mk('restore3-wt'), 'wt'); g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    fs.mkdirSync(path.join(main, 'src'), { recursive: true }); fs.mkdirSync(path.join(main, '.claude'), { recursive: true });
    for (const c of ['git restore src', 'git restore .claude', 'git restore -- .claude/TASKS.md', 'git restore PM', 'git restore -- PM/meetings/x/source.md', 'git restore "src/*.ts"']) {
      assert.equal(verdict(c, ctxFor(main)).kind, 'ask', c);
      assert.equal(verdict(c, ctxFor(main, true)).kind, 'deny', `${c} overnight`);
    }
    assert.equal(verdict('git restore src/a.ts', ctxFor(main)).kind, 'allow', 'one exact code file stays allowed');
  });
  test('a shell write onto a registry file (redirect, sed -i, tee, cp, rm) is asked by day and denied overnight; reads pass', () => {
    const root = mk('regwrite');
    const writes = ["sed -i '' 's/OPEN/BUILT/' .claude/TASKS.md", "echo '| T-99 | x |' >> .claude/TASKS.md", 'printf x > .claude/FACTS.md', 'tee -a .claude/CLIENT.md < x',
      'cp /tmp/old.md .claude/TASKS.md', 'rm .claude/OPEN-ASKS.md', "perl -pi -e 's/a/b/' .claude/TASKS-ARCHIVE.md", 'cd .claude && echo x >> TASKS.md'];
    for (const c of writes) {
      const d = verdict(c, ctxFor(root)); assert.equal(d.kind, 'ask', c); assert.match(d.reason, /registry\.mjs/, c);
      assert.equal(verdict(c, ctxFor(root, true)).kind, 'deny', `${c} overnight`);
    }
    for (const c of ['cat .claude/TASKS.md', 'grep OPEN .claude/TASKS.md', 'cp .claude/TASKS.md /tmp/TASKS-copy.md', 'sed -n 1,5p .claude/TASKS.md', 'echo x > notes/TASKS.md', 'node .claude/tools/registry.mjs check'])
      assert.equal(verdict(c, ctxFor(root)).kind, 'allow', c);
  });
});

describe('guard-bash: final round — every way a typed command replaces a registry (hard rule 3)', () => {
  test('mv from or onto, rsync/dd/awk -i inplace onto, inline python/node writes: ask by day, deny overnight; reads pass', () => {
    const root = mk('regwrite2');
    const writes = ['mv .claude/TASKS.md .claude/old-tasks.md', 'mv /tmp/x.md .claude/TASKS.md', 'rsync -a /tmp/x.md .claude/TASKS.md', 'dd if=/dev/null of=.claude/TASKS.md',
      "awk -i inplace '{print}' .claude/TASKS.md", `python3 -c "open('.claude/TASKS.md','w').write('')"`, `node -e "require('fs').writeFileSync('.claude/CLIENT.md','')"`,
      `python3 -c "import pathlib; pathlib.Path('.claude/FACTS.md').write_text('x')"`];
    for (const c of writes) {
      const d = verdict(c, ctxFor(root)); assert.equal(d.kind, 'ask', c); assert.match(d.reason, /registry\.mjs/, c);
      assert.equal(verdict(c, ctxFor(root, true)).kind, 'deny', `${c} overnight`);
    }
    for (const c of [`python3 -c "print(open('.claude/TASKS.md').read())"`, 'rsync -a .claude/TASKS.md /tmp/copy.md', 'dd if=.claude/TASKS.md of=/tmp/x', "awk '{print}' .claude/TASKS.md", 'mv notes.md old-notes.md'])
      assert.equal(verdict(c, ctxFor(root)).kind, 'allow', c);
  });
  test('git restore / checkout -- of a committed registry in the main checkout asks with NO other worktree (PM sessions share main); a worktree copy and code files pass', () => {
    const main = repo('regrestore'); fs.mkdirSync(path.join(main, '.claude'), { recursive: true }); fs.writeFileSync(path.join(main, '.claude', 'TASKS.md'), '# T\n');
    g(main, 'add', '.claude/TASKS.md'); g(main, 'commit', '-qm', 'reg');
    for (const c of ['git restore .claude/TASKS.md', 'git checkout -- .claude/TASKS.md', 'git checkout HEAD -- .claude', 'git restore .', 'git checkout .claude/TASKS.md']) {
      const d = verdict(c, ctxFor(main)); assert.equal(d.kind, 'ask', c); assert.match(d.reason, /registry/, c);
      assert.equal(verdict(c, ctxFor(main, true)).kind, 'deny', `${c} overnight`);
    }
    for (const c of ['git restore a.txt', 'git checkout -- a.txt', 'git restore --staged .claude/TASKS.md', 'git checkout -b t1-x', 'git checkout main']) assert.equal(verdict(c, ctxFor(main)).kind, 'allow', c);
    const wt = path.join(mk('regrestore-wt'), 'wt'); g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    assert.equal(verdict('git restore .claude/TASKS.md', ctxFor(wt)).kind, 'allow', 'a worktree copy is not the live registry');
    const ign = repo('regrestore-ign'); fs.writeFileSync(path.join(ign, '.gitignore'), '.claude/\n'); fs.mkdirSync(path.join(ign, '.claude'), { recursive: true }); fs.writeFileSync(path.join(ign, '.claude', 'TASKS.md'), '# T\n');
    assert.equal(verdict('git restore .', ctxFor(ign)).kind, 'allow', 'D13: git does not touch a gitignored registry');
  });
});

describe('guard-bash: round-2 fixes (Monitor, discarding work in a shared checkout, direct uploads overnight)', () => {
  test('a Monitor call is judged like Bash; a WebSocket Monitor with no command passes', () => {
    const r = runHook(GUARD, { session_id: 's1', cwd: TMP, hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: { command: 'git add -A', timeout_ms: 1000, description: 'x' } }, { env: CLEAN_ENV, cwd: TMP });
    assert.equal(r.code, 2); assert.match(r.stderr, /git add -A/);
    const ws = runHook(GUARD, { session_id: 's1', cwd: TMP, hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: { ws: { url: 'wss://x.test' } } }, { env: CLEAN_ENV, cwd: TMP });
    assert.equal(ws.code, 0);
    const other = runHook(GUARD, { session_id: 's1', cwd: TMP, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { command: 'git add -A' } }, { env: CLEAN_ENV, cwd: TMP });
    assert.equal(other.code, 0, 'other tools are not judged');
  });
  test('main checkout with other worktrees: reset --hard, restore of a folder, clean -f ask by day and deny overnight; exact-file restore and --staged pass', () => {
    const main = repo('discard'); const wt = path.join(mk('discard-wt'), 'wt'); g(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    for (const c of ['git reset --hard', 'git reset --hard HEAD~1', 'git restore .', 'git restore -- .', 'git restore src/', 'git clean -fd', 'git clean -fdx', 'git clean --force', 'git -C . reset --hard']) {
      assert.equal(verdict(c, ctxFor(main)).kind, 'ask', c);
      assert.equal(verdict(c, ctxFor(main, true)).kind, 'deny', `${c} overnight`);
    }
    assert.match(verdict('git reset --hard', ctxFor(main)).reason, /git restore -- <exact path>/);
    for (const c of ['git restore a.txt', 'git restore --staged .', 'git reset', 'git reset HEAD a.txt', 'git clean -n', 'git clean -fdn']) assert.equal(verdict(c, ctxFor(main)).kind, 'allow', c);
    for (const c of ['git reset --hard', 'git restore .', 'git clean -fd']) {
      assert.equal(verdict(c, ctxFor(wt)).kind, 'allow', `${c} inside your own worktree`);
      assert.equal(verdict(c, ctxFor(repo('alone'))).kind, 'allow', `${c} with no other worktree`);
    }
  });
  test('overnight: direct upload commands are denied; local and read-only forms pass', () => {
    const deny = ['curl -T theme.zip ftp://ftp.casalumen.example/', 'curl --upload-file x.zip https://files.example.com/x', 'curl -X POST https://casalumen.example/wp-json/wp/v2/pages/12 -d @x.json',
      'curl -d @x.json https://site.example/wp-json/wp/v2/posts', 'curl --request=PUT https://site.example/wp-json/x', 'curl -F file=@a.zip https://site.example/xmlrpc.php',
      'rsync -avz casa-lumen-theme/ user@casalumen.example:/var/www/wp-content/themes/x/', 'rsync -a dist/ host.example:/srv/', 'scp theme.zip user@host:/var/www/', 'sftp user@host', 'lftp -e "mirror -R" ftp.host',
      'make deploy', 'make -C site release', 'wp post update 12 --post_content="x" --ssh=prod', 'wp @production plugin update --all'];
    for (const c of deny) { const v = verdict(c, ctxFor(TMP, true)); assert.equal(v.kind, 'deny', c); assert.match(v.reason, /overnight/, c); }
    const allow = ['curl https://casalumen.example/wp-json/wp/v2/pages/12', 'curl -X POST http://localhost:3000/api/x -d a=1', 'curl -T x.zip http://127.0.0.1:8080/', 'curl -sI https://example.com',
      'rsync -a src/ dist/', 'rsync -a ./a/ /tmp/b/', 'make build', 'make test', 'make deploy-preview', 'wp post list', 'wp --url=site.local post list'];
    for (const c of allow) assert.equal(verdict(c, ctxFor(TMP, true)).kind, 'allow', c);
    for (const c of deny) assert.equal(verdict(c, ctxFor(TMP, false)).kind, 'allow', `${c} (daytime)`);
  });
  test('overnight: a helper script that runs a deploy script is denied', () => {
    const root = mk('helper'); fs.mkdirSync(path.join(root, '.claude', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'scripts', 'helper.py'), 'import subprocess\nsubprocess.run(["python3", ".claude/scripts/deploy-theme-ftp.py"])\n');
    const v = verdict('python3 .claude/scripts/helper.py', ctxFor(root, true));
    assert.equal(v.kind, 'deny'); assert.match(v.reason, /deploy script/);
  });
});

describe('guard-edit: claims held by other sessions', () => {
  const EDIT = path.join(HOOKS, 'guard-edit.mjs');
  const REG = path.join(CLAUDE_DIR, 'tools', 'registry.mjs');
  test('an edit of a file another session claimed (any spelling, from its worktree) is asked about; your own claim passes', () => {
    const root = mk('claims');
    fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true }); fs.mkdirSync(path.join(root, '.claude', 'tools'), { recursive: true });
    fs.copyFileSync(EDIT, path.join(root, '.claude', 'hooks', 'guard-edit.mjs')); fs.copyFileSync(REG, path.join(root, '.claude', 'tools', 'registry.mjs'));
    fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), JSON.stringify({ project: 'x', registryDir: '.claude', siteDir: '.' }));
    fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'hero.css'), 'a{}');
    fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\n.claude/.state/\n');
    g(root, 'init', '-q', '-b', 'main'); g(root, 'add', '.'); g(root, 'commit', '-qm', 'i');
    const wt = path.join(root, '.claude', 'worktrees', 'w2'); g(root, 'worktree', 'add', '-q', '-b', 'worktree-w2', wt);
    const claim = spawnSync(process.execPath, [REG, 'claim', '--session', 'acme-hero', '--files', 'src/hero.css'], { cwd: root, env: { ...GIT_ENV, CLOCKWORK_ROOT: '', CLAUDE_CODE_SESSION_ID: 'sid-hero' }, encoding: 'utf8' });
    assert.equal(claim.status, 0, claim.stdout);
    const hook = path.join(root, '.claude', 'hooks', 'guard-edit.mjs');
    const edit = (file, sid, env = {}) => runHook(hook, { session_id: sid, tool_name: 'Edit', cwd: wt, tool_input: { file_path: file, old_string: 'a', new_string: 'b' } }, { env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: wt, ...env }, cwd: wt });
    const other = edit(path.join(wt, 'src', 'hero.css'), 'sid-nav');
    assert.equal(other.json?.hookSpecificOutput?.permissionDecision, 'ask', other.stdout);
    assert.match(other.json.hookSpecificOutput.permissionDecisionReason, /claimed by session acme-hero/);
    assert.equal(edit(path.join(wt, 'src', 'hero.css'), 'sid-nav', { OVERNIGHT: '1' }).json?.hookSpecificOutput?.permissionDecision, 'deny');
    const mine = edit(path.join(wt, 'src', 'hero.css'), 'sid-hero');
    assert.equal(mine.code, 0); assert.equal(mine.stdout, '', 'the holder edits its own claimed file');
    assert.equal(edit(path.join(wt, 'src', 'other.css'), 'sid-nav').stdout, '', 'an unclaimed file passes');
  });
});

describe('session-start: round-2 fixes (claims from a worktree, a git that hangs)', () => {
  test('a worktree session sees the claims kept in the main copy, even through a /var vs /private/var path', () => {
    const p = project();
    fs.writeFileSync(path.join(p.root, '.gitignore'), '.claude/.state/\n');
    const wt = path.join(TMP, `wt-claims-${++counter}`); // TMP is not a real path on macOS (/var → /private/var)
    g(p.root, 'worktree', 'add', '-q', '-b', 'wt-claims', wt);
    fs.mkdirSync(path.join(wt, '.claude', 'hooks'), { recursive: true }); fs.copyFileSync(START, path.join(wt, '.claude', 'hooks', 'session-start.mjs'));
    fs.writeFileSync(path.join(wt, '.claude', 'hooks', 'clockwork-doctor.mjs'), STUB_DOCTOR);
    const dir = path.join(p.root, '.claude', '.state', 'claims'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'acme-dev.json'), JSON.stringify({ session: 'acme-dev', sessionId: 'sess-dev', files: ['app/hello/page.tsx'], ids: ['T-3'], branch: 't3-hello', expires: new Date(Date.now() + 3600e3).toISOString() }));
    const hook = path.join(wt, '.claude', 'hooks', 'session-start.mjs');
    const r = runHook(hook, { session_id: 'sess-other', cwd: wt, hook_event_name: 'SessionStart', source: 'startup' },
      { cwd: wt, env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: wt, PATH: pathWith(fakeClaudeBin(AGENTS_NONE), path.dirname(GIT_BIN)) } });
    assert.match(ctxText(r), /Claimed files \(do not edit these; message the holder\):\n- acme-dev · t3-hello · T-3 · app\/hello\/page\.tsx/);
    assert.ok(!fs.existsSync(path.join(wt, '.claude', '.state', 'doctor-baseline-sess-other.json')), 'state lands in the main copy, not the worktree');
    const own = runHook(hook, { session_id: 'sess-dev', cwd: wt, hook_event_name: 'SessionStart', source: 'startup' },
      { cwd: wt, env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: wt, PATH: pathWith(fakeClaudeBin(AGENTS_NONE), path.dirname(GIT_BIN)) } });
    assert.match(ctxText(own), /Claimed files: none recorded/, 'your own claim is not listed as a peer\'s');
  });
  test('a git that does not answer is reported as a stall, not as "no repository", and later git calls are skipped', () => {
    const p = project();
    const bin = mk('hang-git'); fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n/bin/sleep 30\n', { mode: 0o755 });
    const t0 = Date.now();
    const r = start(p, { env: { PATH: pathWith(fakeClaudeBin(AGENTS_NONE), bin) } });
    assert.equal(r.code, 0);
    assert.match(ctxText(r), /git did not answer within 5 s .*Do not read this as "no repository"/);
    assert.doesNotMatch(ctxText(r), /no git repository/);
    assert.match(ctxText(r), /Where: unknown, git did not answer/);
    assert.ok(Date.now() - t0 < 16000, `took ${Date.now() - t0} ms`);
  });
});

// ================================================================ iCloud offload in the guard hooks (2026-10-01)
// CLOCKWORK_FAKE_OFFLOADED (honoured by the real registry.mjs offloadState, which both hooks load) marks a file as
// offloaded. A real offloaded file would make a read wait forever; these prove the hooks never read one, and say so.
describe('iCloud offload (faked): guard-bash and guard-edit never read an offloaded file, and say so in one line', () => {
  const EDIT = path.join(HOOKS, 'guard-edit.mjs');
  const offProject = () => {
    const root = mk('off');
    const files = {
      '.claude/clockwork.json': JSON.stringify({ project: 'x', registryDir: '.claude', siteDir: '.', productionPatterns: ['pnpm ship'], commands: { previewDeploy: 'node scripts/deploy-preview.mjs' } }),
      '.claude/TASKS.md': '# T\n', 'src/a.css': 'a{}\n', 'scripts/patch.py': 'print("local fix")\n',
      '.claude/rules/design-system.md': fs.readFileSync(path.join(CLAUDE_DIR, 'rules', 'design-system.md')),
      '.claude/rules/engineering.md': fs.readFileSync(path.join(CLAUDE_DIR, 'rules', 'engineering.md')),
    };
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
    g(root, 'init', '-q', '-b', 'main'); g(root, 'add', '.'); g(root, 'commit', '-qm', 'i');
    return { root, cfg: path.join(root, '.claude', 'clockwork.json') };
  };
  test('guard-bash, clockwork.json offloaded: in the day it fails open with a one-line warning (to the user and to Claude)', () => {
    const { root, cfg } = offProject();
    const r = bash('ls', root, { CLAUDE_PROJECT_DIR: root, CLOCKWORK_FAKE_OFFLOADED: cfg });
    assert.equal(r.code, 0);
    assert.match(r.json.systemMessage, /^clockwork guard-bash: not checked: .*clockwork\.json is offloaded by iCloud .*brctl download .*built-in defaults/);
    assert.ok(!r.json.systemMessage.includes('\n'), 'one line');
    assert.equal(r.json.hookSpecificOutput.additionalContext, r.json.systemMessage, 'Claude sees it too, so it can download the file');
    assert.equal(bash('ls', root, { CLAUDE_PROJECT_DIR: root }).stdout, '', 'control: a local clockwork.json is silent');
    const deny = bash('git add -A', root, { CLAUDE_PROJECT_DIR: root, CLOCKWORK_FAKE_OFFLOADED: cfg });
    assert.equal(deny.code, 2, 'the checks that need no config still run');
    assert.match(deny.json.systemMessage, /offloaded by iCloud/, 'and the warning rides along with the decision');
  });
  test('guard-bash overnight, clockwork.json offloaded: production checks fail closed on the built-in defaults; the project patterns it could not read are named', () => {
    const { root, cfg } = offProject();
    const night = { CLAUDE_PROJECT_DIR: root, OVERNIGHT: '1' }, off = { ...night, CLOCKWORK_FAKE_OFFLOADED: cfg };
    assert.equal(bash('vercel --prod', root, off).code, 2, 'a built-in default pattern still denies');
    assert.equal(bash('node scripts/deploy-preview.mjs', root, night).code, 0, 'control: the configured preview deploy is allowed');
    assert.equal(bash('node scripts/deploy-preview.mjs', root, off).code, 2, 'unread config: no command counts as the preview, so a deploy-named one is denied');
    assert.equal(bash('pnpm ship', root, night).code, 2, 'control: the project pattern denies when the file is read');
    const ship = bash('pnpm ship', root, off);
    assert.equal(ship.code, 0, 'the file was not read, so its own pattern cannot match');
    assert.match(ship.json.systemMessage, /productionPatterns and commands\.productionDeploy were NOT matched/);
  });
  test('guard-bash overnight: a script iCloud has offloaded is denied with the download command, never read; in the day it is not read at all', () => {
    const { root } = offProject();
    const sc = path.join(root, 'scripts', 'patch.py');
    const r = bash('python3 scripts/patch.py', root, { CLAUDE_PROJECT_DIR: root, OVERNIGHT: '1', CLOCKWORK_FAKE_OFFLOADED: sc });
    assert.equal(r.code, 2);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /patch\.py, which iCloud has offloaded, so it could not be checked .*brctl download/);
    assert.equal(bash('python3 scripts/patch.py', root, { CLAUDE_PROJECT_DIR: root, OVERNIGHT: '1' }).code, 0, 'control: the same script, local and harmless, passes');
    assert.equal(bash('python3 scripts/patch.py', root, { CLAUDE_PROJECT_DIR: root, CLOCKWORK_FAKE_OFFLOADED: sc }).code, 0, 'day: scripts are not inspected');
  });
  test('guard-edit, clockwork.json offloaded: every check still runs with the defaults, plus a one-line warning; never silent', () => {
    const { root, cfg } = offProject();
    const edit = (file, env = {}) => runHook(EDIT, { session_id: 's', tool_name: 'Edit', cwd: root, tool_input: { file_path: path.join(root, file), old_string: 'a', new_string: 'b' } }, { env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: root, ...env }, cwd: root });
    const plain = edit('src/a.css', { CLOCKWORK_FAKE_OFFLOADED: cfg });
    assert.equal(plain.code, 0);
    assert.match(plain.json.systemMessage, /^clockwork guard-edit: not checked: .*clockwork\.json is offloaded by iCloud .*brctl download .*default settings/);
    assert.ok(!plain.json.systemMessage.includes('\n'), 'one line');
    assert.equal(plain.json.hookSpecificOutput, undefined, 'fails open: no decision');
    assert.equal(edit('src/a.css').stdout, '', 'control: silent when the file is local');
    const reg = edit('.claude/TASKS.md', { CLOCKWORK_FAKE_OFFLOADED: cfg });
    assert.equal(reg.json.hookSpecificOutput.permissionDecision, 'ask', 'the registry check still runs (default folder .claude)');
    assert.match(reg.json.systemMessage, /offloaded by iCloud/);
  });
  test('guard-edit, a rule file offloaded: left out of the path-rules list for a new file and named in the warning', () => {
    const { root } = offProject();
    const ds = path.join(root, '.claude', 'rules', 'design-system.md');
    const write = (env = {}) => runHook(EDIT, { tool_name: 'Write', cwd: root, tool_input: { file_path: path.join(root, 'src/components/new.tsx'), content: 'x' } }, { env: { ...CLEAN_ENV, CLAUDE_PROJECT_DIR: root, ...env }, cwd: root });
    assert.match(write().json.hookSpecificOutput.additionalContext, /design-system\.md/, 'control: listed when local');
    const r = write({ CLOCKWORK_FAKE_OFFLOADED: ds });
    assert.doesNotMatch(r.json.hookSpecificOutput.additionalContext, /design-system\.md/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /engineering\.md/);
    assert.match(r.json.systemMessage, /design-system\.md is offloaded by iCloud .*path rules were not checked/);
  });
});

// WHY.md names guard-bash's limits; this keeps the text and the behaviour in step (a verifier found the caveat dropped).
test('WHY.md states that a script run by name is not read (only `bash up.sh` is), stays within 12,288 bytes, and the hook behaves that way', () => {
  const why = fs.readFileSync(path.join(KIT, 'WHY.md'), 'utf8');
  assert.ok(Buffer.byteLength(why) <= 12288, `WHY.md is ${Buffer.byteLength(why)} bytes`);
  assert.match(why, /reads a script only if an interpreter runs it \(`bash up\.sh`, not `\.\/up\.sh`\)/);
  const root = mk('up'); fs.writeFileSync(path.join(root, 'up.sh'), '#!/bin/sh\ncurl -T theme.zip ftp://example.com/www/\n', { mode: 0o755 });
  assert.match(verdict('bash up.sh', ctxFor(root, true)).reason, /up\.sh contains a curl upload/);
  assert.equal(verdict('./up.sh', ctxFor(root, true)).kind, 'allow', 'run by name: not read (the documented limit)');
});
