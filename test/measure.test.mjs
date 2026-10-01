// Tests for templates/claude/tools/measure.js (pure helpers; browser functions were exercised
// separately in Chrome through chrome-devtools evaluate_script). Offline, no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', 'templates', 'claude', 'tools', 'measure.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const cw = createRequire(import.meta.url)(FILE);

test('loads through require() and through the paste-into-a-function install path', () => {
  assert.equal(typeof cw.contrastRatio, 'function');
  const ctx = vm.createContext({ window: {} });
  const keys = vm.runInContext(`(() => { ${SRC}; return Object.keys(window.__cw) })()`, ctx);
  for (const k of ['harness', 'styles', 'overflowScan', 'contrastRatio', 'renderedContrast', 'imageResolution',
    'widthsTable', 'anchorLanding', 'selfTest', 'targetSizes', 'hideInk', 'animationStates', 'gap', 'focusState', 'baselineScan']) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
});

test('the file is a plain script: no import/export statements', () => {
  assert.doesNotMatch(SRC, /^\s*(import|export)\s/m);
});

test('contrastRatio matches WCAG reference values', () => {
  assert.equal(cw.contrastRatio('#000', '#fff'), 21);
  assert.equal(cw.contrastRatio('#fff', '#fff'), 1);
  assert.equal(cw.contrastRatio('#767676', '#ffffff'), 4.54); // smallest grey that passes AA on white
  assert.equal(cw.contrastRatio('#777777', '#ffffff'), 4.48); // one step lighter fails
  assert.equal(cw.contrastRatio('#ffffff', '#767676'), 4.54, 'order of fg/bg does not matter');
});

test('negative controls: unreadable colours return null, never a passing number', () => {
  assert.equal(cw.contrastRatio('lab(50% 20 30)', '#fff'), null);
  assert.equal(cw.contrastRatio('not-a-colour', '#fff'), null);
  assert.equal(cw.parseColor('rgb(a b c)'), null);
  assert.equal(cw.parseColor('#12345'), null);
});

test('parseColor reads hex, rgb (legacy + modern), alpha and transparent', () => {
  assert.deepEqual(cw.parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(cw.parseColor('#11223380'), { r: 17, g: 34, b: 51, a: 128 / 255 });
  assert.deepEqual(cw.parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(cw.parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(cw.parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
});

test('oklch / oklab / display-p3 / color(srgb) match Chrome canvas conversion (measured 2026-09-30)', () => {
  const chrome = {
    'oklch(0.25 0.05 260)': [19, 33, 57], 'oklch(0.7 0.15 30)': [237, 118, 101],
    'oklch(0.62 0.21 145)': [0, 164, 28], 'oklch(55% 0.2 300)': [134, 74, 210],
    'oklab(0.6 0.1 -0.1)': [159, 99, 186], 'color(display-p3 0.2 0.6 0.4)': [0, 156, 97],
    'color(srgb 0.5 0.25 0.75)': [128, 64, 191],
  };
  for (const [c, rgb] of Object.entries(chrome)) {
    const p = cw.parseColor(c);
    assert.deepEqual([p.r, p.g, p.b].map(Math.round), rgb, c);
  }
});

test('alpha foreground is composited over the background before the ratio', () => {
  const half = cw.composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(half.r, 127.5);
  assert.equal(cw.contrastRatio('rgba(0,0,0,0.5)', '#fff'), cw.contrastRatio(half, '#fff'));
  assert.ok(cw.contrastRatio('rgba(0,0,0,0.5)', '#fff') < cw.contrastRatio('#000', '#fff'));
});

test('requiredContrast uses WCAG large-text thresholds (24px, or 18.66px bold)', () => {
  assert.equal(cw.requiredContrast(16, '400'), 4.5);
  assert.equal(cw.requiredContrast(24, '400'), 3);
  assert.equal(cw.requiredContrast(18.66, '700'), 3);
  assert.equal(cw.requiredContrast(18, '700'), 4.5);
  assert.equal(cw.requiredContrast(20, '600'), 4.5);
});

test('drawnImageWidth follows object-fit (a cover crop draws wider than its box)', () => {
  assert.equal(cw.drawnImageWidth(400, 200, 100, 100, 'cover'), 200);
  assert.equal(cw.drawnImageWidth(400, 200, 100, 100, 'contain'), 100);
  assert.equal(cw.drawnImageWidth(400, 200, 100, 100, 'fill'), 100);
  assert.equal(cw.drawnImageWidth(400, 200, 100, 100, 'none'), 400);
  assert.equal(cw.drawnImageWidth(400, 200, 100, 100, 'scale-down'), 100);
});

test('resolution = served px / (drawn width x dpr), null when nothing was served', () => {
  assert.deepEqual(cw.resolution(400, 200, 3), { perDevicePx: 0.67, perCssPx: 2 });
  assert.deepEqual(cw.resolution(1200, 200, 3), { perDevicePx: 2, perCssPx: 6 });
  assert.equal(cw.resolution(0, 200, 2), null);
});

test('harnessVerdict refuses hidden tabs, wrong widths, zero rects, loading fonts', () => {
  const good = { href: 'https://x.test/a', visibilityState: 'visible', innerWidth: 390, readyState: 'complete', fonts: 'loaded', rect: { selector: 'body', w: 390, h: 900 } };
  assert.deepEqual(cw.harnessVerdict(good, { expectWidth: 390, expectUrl: 'https://x.test/' }), { ok: true, reasons: [] });
  const cases = [
    [{ visibilityState: 'hidden' }, /visibilityState=hidden/],
    [{ innerWidth: 1920 }, /innerWidth 1920 != expected 390/],
    [{ rect: { selector: 'main', w: 0, h: 0 } }, /zero rect for main/],
    [{ fonts: 'loading' }, /fonts loading/],
    [{ readyState: 'interactive' }, /readyState=interactive/],
    [{ href: 'http://localhost:3000/a' }, /is not https:\/\/x.test\//],
  ];
  for (const [patch, re] of cases) {
    const v = cw.harnessVerdict({ ...good, ...patch }, { expectWidth: 390, expectUrl: 'https://x.test/' });
    assert.equal(v.ok, false, JSON.stringify(patch));
    assert.match(v.reasons.join(' | '), re);
  }
});

test('widthsTable: 12 ascending widths 320-2560 incl. 1024 and 1710; emulate strings', () => {
  const w = cw.widthsTable.map((r) => r.width);
  assert.equal(w.length, 12);
  assert.deepEqual([...w].sort((a, b) => a - b), w);
  for (const need of [320, 390, 1024, 1440, 1710, 1920, 2560]) assert.ok(w.includes(need), `missing ${need}`);
  assert.equal(cw.viewportFor(390), '390x842x3,mobile,touch');
  assert.equal(cw.viewportFor(1440), '1440x810x2');
  assert.match(cw.viewportFor(999), /^999x\d+x2,mobile,touch$/);
});

// Baseline floors (design-system.md BL rows). baselineScan itself was run in Chrome 2026-10-01 on two fixture pages
// (a padded one: every list empty at 390 and 1440; a cramped one: every part caught, selfTest allCaught with the new
// edge and buttonPadding controls).
test('gutterFor follows the Material 3 breakpoints: 16 below 600, 24 from 600', () => {
  assert.equal(cw.gutterFor(320), 16); assert.equal(cw.gutterFor(599), 16);
  assert.equal(cw.gutterFor(600), 24); assert.equal(cw.gutterFor(1440), 24); assert.equal(cw.gutterFor(2560), 24);
});

test('onGrid: multiples of 4 pass, one-off values fail', () => {
  for (const v of [4, 8, 12, 16, 24, 48, 96, 128, -8]) assert.equal(cw.onGrid(v), true, String(v));
  for (const v of [6, 10, 13, 18, 22.5, 33.14]) assert.equal(cw.onGrid(v), false, String(v));
  assert.equal(cw.onGrid(10, 5), true, 'a project base other than 4');
});

test('charsPerLine = text length over the line count read from ink height', () => {
  assert.equal(cw.charsPerLine(300, 96, 24), 75); // 4 lines
  assert.equal(cw.charsPerLine(300, 72, 24), 100); // 3 lines: over the 75 cap
  assert.equal(cw.charsPerLine(40, 20, 24), 40, 'one line');
  assert.equal(cw.charsPerLine(40, 0, 24), null, 'no ink: no number, never a pass');
});

test('stretchPx: fill stretches, cover and contain crop or letterbox', () => {
  assert.equal(cw.stretchPx(400, 200, 200, 100, 'fill'), 0);
  assert.equal(cw.stretchPx(400, 200, 200, 200, 'fill'), 100, 'a 2:1 file drawn square is squashed by 100px');
  assert.equal(cw.stretchPx(400, 200, 200, 200, 'cover'), 0);
  assert.equal(cw.stretchPx(400, 200, 200, 200, 'contain'), 0);
  assert.equal(cw.stretchPx(0, 200, 200, 200, 'fill'), null);
});

test('selfTest carries the baseline negative controls', () => {
  assert.match(SRC, /edge: b\.edges\.items\.some/);
  assert.match(SRC, /buttonPadding: b\.buttons\.items\.some/);
});
