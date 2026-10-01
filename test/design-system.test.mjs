// Tests for B9's templates/claude/rules/design-system.md. node --test, offline, read-only.
// Budget: 16 KB since 2026-10-01 (the user raised it for the Baseline section; WHY.md). Was CONTRACT §2's 9 KB. Frontmatter: https://code.claude.com/docs/en/memory#path-specific-rules
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(KIT, 'templates', 'claude', 'rules', 'design-system.md');
const text = readFileSync(FILE, 'utf8');

test('budget: ≤ 16 KB and under the 200-line instruction-file warning', () => {
  const bytes = Buffer.byteLength(text);
  assert.ok(bytes <= 16384, `design-system.md is ${bytes} bytes, template budget 16384`);
  assert.ok(text.split('\n').length < 200, 'over 200 lines');
});

function frontPaths() {
  assert.ok(text.startsWith('---\n'), 'must start with frontmatter');
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'frontmatter not closed');
  const fm = text.slice(4, end).split('\n').filter((l) => !/^\s*#/.test(l));
  assert.equal(fm[0], 'paths:', 'first key must be paths (the only key Claude Code reads from a rule)');
  const items = fm.slice(1).map((l) => /^ {2}- "([^"]+)"$/.exec(l)?.[1]);
  assert.ok(items.length && items.every(Boolean), 'paths must be a YAML list of quoted globs');
  return items;
}
function expand(p) { const m = /\{([^{}]*)\}/.exec(p); return m ? m[1].split(',').flatMap((x) => expand(p.slice(0, m.index) + x + p.slice(m.index + m[0].length))) : [p]; }
function globRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith('**/', i)) { s += '(?:.*/)?'; i += 2; } else if (g.startsWith('**', i)) { s += '.*'; i += 1; } else if (g[i] === '*') s += '[^/]*';
    else s += g[i].replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}

test('paths frontmatter loads the rule for UI files only', () => {
  const pats = frontPaths().flatMap(expand);
  const hit = (f) => pats.some((p) => globRe(p).test(f));
  for (const f of ['app/globals.css', 'src/styles/a.scss', 'src/components/ui/button.tsx', 'src/App.jsx', 'src/Card.vue', 'src/Nav.svelte',
    'views/page.twig', 'wp-content/themes/x/patterns/hero.php', 'casa-lumen-theme/templates/page.html', 'theme/parts/header.html', 'theme.json',
    'site/theme.json', 'tailwind.config.ts', 'web/tailwind.config.js'])
    assert.ok(hit(f), `${f} should load the design rules`);
  for (const f of ['package.json', 'README.md', 'AGENTS.md', 'src/lib/db.ts', '.claude/TASKS.md', 'supabase/migrations/1.sql'])
    assert.ok(!hit(f), `${f} should not load the design rules`);
});

const AREAS = ['Spacing and layout', 'Typography', 'Colour and contrast', 'Components and states', 'Motion', 'Responsive widths and locales', 'Imagery', 'Banned patterns'];
const HEADER = '| Rule | Value / token | How to measure | Source |';

function tables() {
  const out = {};
  for (const a of AREAS) {
    const i = text.indexOf(`\n## ${a}\n`);
    assert.ok(i >= 0, `missing area "## ${a}"`);
    const body = text.slice(i + a.length + 5).split('\n## ')[0].trim().split('\n');
    assert.equal(body[0], HEADER, `${a}: table header must be ${HEADER}`);
    assert.equal(body[1], '|---|---|---|---|', `${a}: separator row`);
    out[a] = body.slice(2).filter(Boolean);
  }
  return out;
}

test('one table per area; every row has an ID, a value cell, a measuring method and a source', () => {
  const ids = new Set();
  const SOURCE = /^(DS §[A-Z]|V §\d|L\d{2,3}\b|P1 §\d|P2 §[A-Z]|`\{\{CD-n\}\}`)/;
  for (const [area, rows] of Object.entries(tables())) {
    assert.ok(rows.length >= 3, `${area}: only ${rows.length} rows`);
    for (const r of rows) {
      assert.ok(r.startsWith('| ') && r.endsWith(' |'), `not a table row: ${r}`);
      const cells = r.slice(2, -2).split(' | ');
      assert.equal(cells.length, 4, `4 cells expected: ${r}`);
      const [rule, value, how, source] = cells.map((c) => c.trim());
      const id = /^([A-Z]+-\d+) \S/.exec(rule)?.[1];
      assert.ok(id, `rule cell must open with an ID: ${rule}`);
      assert.ok(!ids.has(id), `duplicate ID ${id}`); ids.add(id);
      assert.ok(value.length > 0, `${id}: empty value cell (use - for none)`);
      assert.ok(how.length >= 8 && how !== '-', `${id}: no measuring method`);
      for (const s of source.split('; ')) assert.match(s, SOURCE, `${id}: unrecognised source "${s}"`);
    }
  }
  assert.ok(ids.size >= 45, `only ${ids.size} rules`);
});

test('no unsourced extrapolations the critic flagged (L88 verification)', () => {
  for (const bad of [/two CTAs/i, /cream-on-cream/i, /cream on cream/i]) assert.doesNotMatch(text, bad);
});

test('how-to-use carries the reversal format and the token-only rule', () => {
  assert.match(text, /reversed <YYYY-MM-DD> <CD-n>/);
  assert.match(text, /## Confirmed Decisions/);
  assert.match(text, /Tokens are the only source of sizes and colours/);
});

test('RW-1 widths equal measure.js widthsTable, 320 to 2560', () => {
  const row = text.split('\n').find((l) => l.startsWith('| RW-1 '));
  const widths = row.split(' | ')[1].match(/\b\d{3,4}\b/g).map(Number);
  const cw = createRequire(import.meta.url)(join(KIT, 'templates', 'claude', 'tools', 'measure.js'));
  assert.deepEqual(widths, cw.widthsTable.map((w) => w.width));
  assert.equal(widths[0], 320); assert.equal(widths.at(-1), 2560); assert.ok(widths.includes(1024) && widths.includes(1710));
});

test('every measure.js function named in the table exists', () => {
  const cw = createRequire(import.meta.url)(join(KIT, 'templates', 'claude', 'tools', 'measure.js'));
  const named = new Set([...text.matchAll(/\b([a-z][A-Za-z]+)\(/g)].map((m) => m[1]).filter((n) => !['clamp', 'minmax', 'min', 'scale'].includes(n)));
  named.add('hideInk');
  for (const n of named) assert.equal(typeof cw[n], 'function', `measure.js has no ${n}()`);
});

test('D14: rows the user ratified differently in their projects are per-project decisions with an unfilled value, not kit rules', () => {
  const row = (id) => text.split('\n').find((l) => l.startsWith(`| ${id} `)) || '';
  for (const id of ['MO-2', 'MO-6', 'CO-1']) {
    assert.match(row(id), /decide per project/, `${id} says decide per project`);
    assert.match(row(id).split(' | ')[1], /\{\{[^}]+\}\}/, `${id} value is unfilled until the user decides`);
  }
  assert.doesNotMatch(text, /under 300ms|no hover backplate/i, 'no contested value is asserted as a rule');
  assert.match(text, /hold the page to the Baseline row that backs it/);
  assert.match(text, /not measurable \(no value, no baseline\)/);
});

function baselineRows() {
  const i = text.indexOf('\n## Baseline (applies until the project sets its own value)\n');
  assert.ok(i >= 0, 'missing "## Baseline (applies until the project sets its own value)"');
  const body = text.slice(i + 1).split('\n## ')[0].split('\n');
  const h = body.indexOf(HEADER);
  assert.ok(h > 0, 'Baseline table header');
  assert.equal(body[h + 1], '|---|---|---|---|');
  return body.slice(h + 2).filter((l) => l.startsWith('| '));
}

test('Baseline: every row has a real minimum, a measure.js method at named widths, and a checkable source', () => {
  const rows = baselineRows();
  assert.ok(rows.length >= 10, `only ${rows.length} baseline rows`);
  const ids = new Set(text.split('\n').map((l) => /^\| ([A-Z]+-\d+) /.exec(l)?.[1]).filter(Boolean));
  for (const r of rows) {
    const [rule, value, how, source] = r.slice(2, -2).split(' | ').map((c) => c.trim());
    const id = /^(BL-\d+) \S/.exec(rule)?.[1];
    assert.ok(id, `baseline rule cell opens with BL-n: ${rule}`);
    assert.doesNotMatch(value, /\{\{|^-$/, `${id}: a baseline value is never unfilled`);
    assert.match(value, /\d/, `${id}: a baseline value is a number`);
    assert.match(how, /baselineScan\(\)\.\w+ (at \d|@W)/, `${id}: measured by baselineScan at named widths`);
    const parts = source.split('; ');
    assert.ok(parts.some((x) => /^https:\/\/(www\.w3\.org|m3\.material\.io|developer\.apple\.com|developer\.mozilla\.org)\//.test(x) || /^[a-z-]+\/[\w/.-]+\.md\b/.test(x)),
      `${id}: cites W3C, Material 3, Apple HIG, MDN or an installed skill file: ${source}`);
    for (const m of source.matchAll(/https:\/\/[^\s;)]+/g)) assert.match(m[0], /^https:\/\/(www\.w3\.org\/WAI\/WCAG22|m3\.material\.io|developer\.apple\.com\/design|developer\.mozilla\.org)\//, `${id}: ${m[0]}`);
    for (const b of (/\(backs ([^)]+)\)/.exec(rule)?.[1] || '').split(', ').filter(Boolean)) assert.ok(ids.has(b) && !b.startsWith('BL-'), `${id} backs ${b}, which is not a project row`);
  }
  assert.match(text, /stricter floor is kept/);
});


// A verifier read each cited page (M3 rendered in Chrome, 2026-10-01): text-fields/specs "Default container height 56dp",
// "Target size 56dp", left/right padding 16dp (12dp with icons); cards/specs gives "Left/right padding 16dp" only;
// buttons/specs small button padding 24dp (M3), 16dp (M3 Expressive). interface-design validation.md "12px 16px" is an
// example inside a memory-format template, not a rule.
test('Baseline source notes say no more than their sources (BL-3, BL-4, BL-5)', () => {
  const src = (id) => baselineRows().find((r) => r.startsWith(`| ${id} `)).slice(2, -2).split(' | ')[3];
  assert.doesNotMatch(src('BL-3'), /validation\.md/, 'a template example is not a source');
  assert.match(src('BL-3'), /24dp in M3, 16dp in M3 Expressive/);
  assert.match(src('BL-4'), /left\/right padding 16dp; top\/bottom not given/);
  assert.doesNotMatch(src('BL-5'), /48dp/, 'M3 text fields are 56dp; 48 is not on that page');
  assert.match(src('BL-5'), /56dp container is a default, not a minimum/);
  assert.match(src('BL-5'), /target-size-enhanced\.html \(44 by 44 CSS px, AAA\)/);
});
