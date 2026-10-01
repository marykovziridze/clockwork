// Tests for templates/claude/workflows/build-slices.js: runs the script body offline with a mocked agent().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '..', 'templates', 'claude', 'workflows', 'build-slices.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const body = SRC.replace(/^export const meta = /, 'const meta = ');
const metaText = SRC.slice(SRC.indexOf('{'), SRC.indexOf('\n}\n') + 2);

async function run(args, { result = (s) => ({ id: s, branch: `${s.toLowerCase()}-x`, sha: 'abcdef1234', files_changed: [], checks: [{ command: 'npm run build', passed: true, output_tail: 'ok' }], not_checked: [], blocked: '' }), budget } = {}) {
  const calls = []; let live = 0, maxLive = 0; const logs = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts }); live++; maxLive = Math.max(maxLive, live);
    await new Promise((r) => setTimeout(r, 2)); live--;
    return result(opts.label.replace('build-', ''), prompt);
  };
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', body);
  const out = await fn(agent, async (t) => Promise.all(t.map((x) => x())), null, () => {}, (m) => logs.push(m), args, budget);
  return { out, calls, maxLive, logs };
}
const slices = (n) => Array.from({ length: n }, (_, i) => ({ id: `T-${i + 1}`, goal: `page ${i + 1}`, files: [`app/p${i + 1}/page.tsx`] }));

test('meta is a pure literal; no forbidden APIs', () => {
  assert.match(SRC, /^export const meta = \{/);
  assert.doesNotMatch(metaText, /\$\{|\.\.\.|\w\(/);
  assert.doesNotMatch(body, /Date\.now|Math\.random|new Date\(\s*\)|\brequire\s*\(|\bfs\./);
});

test('overlapping write-lists are refused before any agent runs', async () => {
  const s = slices(2); s[1].files.push(s[0].files[0]);
  await assert.rejects(() => run({ base: 'abc', slices: s }), /write-lists overlap/);
});

test('one worktree builder per slice, at most 4 at once, each told its write-list', async () => {
  const { out, calls, maxLive } = await run({ base: 'abc1234', slices: slices(6) }, { result: (id) => ({ id, branch: `${id.toLowerCase().replace('-', '')}-x`, sha: 'abcdef1234', files_changed: [`app/p${id.slice(2)}/page.tsx`], checks: [{ command: 'build', passed: true, output_tail: 'ok' }], not_checked: [], blocked: '' }) });
  assert.equal(calls.length, 6);
  assert.ok(maxLive <= 4, `cap exceeded: ${maxLive}`);
  assert.ok(calls.every((c) => c.opts.isolation === 'worktree' && c.opts.agentType === 'builder' && c.opts.schema));
  assert.match(calls[0].prompt, /ONLY files you may create or edit\): app\/p1\/page\.tsx/);
  assert.equal(out.ready.length, 6); assert.equal(out.merge_order[0], 't1-x@abcdef1');
});

test('a slice that edited outside its list, failed a check, or died is a problem, never ready', async () => {
  const { out } = await run({ base: 'abc', slices: slices(3) }, { result: (id) => (id === 'T-3' ? null : { id, branch: 'b', sha: 's', files_changed: id === 'T-1' ? ['app/p1/page.tsx', 'app/globals.css'] : ['app/p2/page.tsx'], checks: [{ command: 'lint', passed: id !== 'T-2', output_tail: '' }], not_checked: [], blocked: '' }) });
  assert.equal(out.ready.length, 0);
  assert.match(out.problems.find((p) => p.id === 'T-1').why, /outside its write-list: app\/globals\.css/);
  assert.match(out.problems.find((p) => p.id === 'T-2').why, /checks failed: lint/);
  assert.match(out.problems.find((p) => p.id === 'T-3').why, /died/);
});

test('a token budget builds what fits and names the rest', async () => {
  const { out, calls, logs } = await run({ base: 'abc', slices: slices(3) }, { budget: { total: 500000, remaining: () => 450000, spent: () => 0 } });
  assert.equal(calls.length, 2);
  assert.ok(out.problems.some((p) => p.id === 'T-3' && /token budget/.test(p.why)));
  assert.ok(logs.some((l) => /not building T-3/.test(l)));
});
