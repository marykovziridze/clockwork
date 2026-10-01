// Every `registry.mjs status|append T-<n> "…"` line the kit's markdown tells a session to run is run here against a
// fixture, with its placeholders filled. A documented command the tool refuses (a bare "✅ VERIFIED") fails the test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(KIT, 'templates', 'claude', 'tools', 'registry.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cw doc commands '));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const mdFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? mdFiles(path.join(d, e.name)) : e.name.endsWith('.md') ? [path.join(d, e.name)] : []));
const FILL = [[/<sha7>/g, 'abc1234'], [/<their reason>/g, 'user: ship it before the client call'], [/<one evidence line>/g, 'verifier PASS reports/T-1-verify-abc1234.md'],
  [/reports\/T-<n>-verify-abc1234\.md/g, 'reports/T-1-verify-abc1234.md'], [/<n>/g, '1'], [/…/g, 'x'], [/<[^>]+>/g, 'x']];
const fill = (t) => FILL.reduce((s, [re, v]) => s.replace(re, v), t);

function commands() {
  const out = [];
  for (const f of mdFiles(path.join(KIT, 'templates'))) {
    const text = fs.readFileSync(f, 'utf8'), rel = path.relative(KIT, f);
    for (const m of text.matchAll(/\bstatus T-<n> "([^"]*)"/g)) if (!/<marker>/.test(m[1])) out.push({ rel, kind: 'status', text: m[1] });
    for (const m of text.matchAll(/\bappend T-<n> --text "([^"]*)"/g)) out.push({ rel, kind: 'append', text: m[1] });
  }
  return out;
}

function fixture(i) {
  const root = path.join(TMP, `p${i}`);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'clockwork.json'), JSON.stringify({ project: 'x', registryDir: '.claude', siteDir: '.' }));
  fs.writeFileSync(path.join(root, '.claude', 'TASKS.md'), '# TASKS\nx\n**Last updated:** 2026-09-01\n> **ID counter — next free: `T-2`**\n\n## Open\n| ID | Task | Status |\n|---|---|---|\n| T-1 | a | 🔧 BUILT · sha abc1234 |\n');
  fs.mkdirSync(path.join(root, '.claude', 'reports'), { recursive: true }); // the verifier's report exists: ✅ VERIFIED checks it
  fs.writeFileSync(path.join(root, '.claude', 'reports', 'T-1-verify-abc1234.md'), '# verify T-1\nPASS\n');
  return root;
}

test('the kit documents status and append commands (the scan finds them)', () => {
  const c = commands();
  assert.ok(c.filter((x) => x.kind === 'status').length >= 5, JSON.stringify(c));
  assert.ok(c.some((x) => x.text.startsWith('✅ VERIFIED')), 'a VERIFIED closing step is documented');
});

test('every documented status/append command is accepted by registry.mjs on a BUILT row', () => {
  commands().forEach((c, i) => {
    const root = fixture(i);
    const args = c.kind === 'status' ? ['status', 'T-1', fill(c.text)] : ['append', 'T-1', '--text', fill(c.text)];
    const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CLOCKWORK_ROOT: '' }) });
    assert.equal(r.status, 0, `${c.rel}: ${c.kind} "${c.text}" → ${r.stdout.trim().split('\n').pop()}`);
  });
});
