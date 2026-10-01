// The public face of the kit: README.md, docs/ and LICENSE. Every relative link and image resolves, the figures carry
// their text as outlines (a README image cannot load web fonts), and the pages hold no emoji and no em dashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(KIT, rel), 'utf8');
const PAGES = ['README.md', ...fs.readdirSync(path.join(KIT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

// Relative targets of markdown links/images and of src/srcset attributes, outside code spans and fences.
function targets(md) {
  const prose = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out = [];
  for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]);
  for (const m of prose.matchAll(/\b(?:src|srcset)="([^"]+)"/g)) out.push(m[1]);
  return out.filter((t) => !/^(?:[a-z]+:|#)/i.test(t)).map((t) => t.split('#')[0]);
}

test('README and docs/: every relative link and image points to a file in the kit', () => {
  for (const page of PAGES) {
    const found = targets(read(page));
    if (page === 'README.md') assert.ok(found.length >= 6, `README links only ${found.length} files`);
    for (const t of found) assert.ok(fs.existsSync(path.join(KIT, path.dirname(page), t)), `${page} links ${t}, which does not exist`);
  }
});

test('the cycle figures exist in light and dark, with text as outlines', () => {
  for (const f of ['docs/assets/cycle-light.svg', 'docs/assets/cycle-dark.svg']) {
    const svg = read(f);
    assert.match(svg, /^<svg[^>]+viewBox="0 0 880 420"/);
    assert.doesNotMatch(svg, /<text\b/, `${f} has live text; it renders in a fallback font on GitHub`);
    assert.doesNotMatch(svg, /<script|href="http/i, `${f} loads or runs something`);
  }
  assert.match(read('README.md'), /<source media="\(prefers-color-scheme: dark\)" srcset="docs\/assets\/cycle-dark\.svg">/);
});

test('README, docs/ and LICENSE hold no emoji and no em dashes', () => {
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  for (const page of [...PAGES, 'LICENSE']) {
    read(page).split('\n').forEach((l, i) => {
      assert.doesNotMatch(l, EMOJI, `${page}:${i + 1} has an emoji`);
      assert.ok(!l.includes('—'), `${page}:${i + 1} has an em dash`);
    });
  }
});

test('LICENSE is MIT with a holder and year, and the README says no support is offered', () => {
  const lic = read('LICENSE');
  assert.match(lic, /^MIT License\n\nCopyright \(c\) \d{4} \S.+\n/);
  assert.match(lic, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.match(read('README.md'), /without support/);
});
