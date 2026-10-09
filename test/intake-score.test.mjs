// Tests for benchmarks/intake-score.mjs: the answer key must pass a complete record and name what a flawed one lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCORER = path.join(here, '..', 'benchmarks', 'intake-score.mjs');

const CLIENT_HEAD = '# Client\n\n## Client asks\n| ID | Ask | Who | Owed by | Source | Status |\n|---|---|---|---|---|---|\n';
const CD_HEAD = '\n## Confirmed Decisions\n| ID | Decision | Date · who | Source | Status |\n|---|---|---|---|---|\n';
const SO_HEAD = '\n## Standing Obligations\n| Obligation | Cadence or date | Owner | Next due | Source |\n|---|---|---|---|---|\n';
const TASKS_HEAD = '# Tasks\n\n## Open\n| ID | Task | Closes when | Deploy class | Source | Status |\n|---|---|---|---|---|---|\n';
const FACTS_HEAD = '# Facts\n\n## Facts\n| Fact | Value | As of | Source |\n|---|---|---|---|\n| Launch date | | | |\n';

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-score-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.claude', f), body);
  return dir;
}
function score(dir) {
  const out = path.join(dir, 'score.json');
  execFileSync(process.execPath, [SCORER, dir, '--json', out], { encoding: 'utf8' });
  return JSON.parse(fs.readFileSync(out, 'utf8'))[0];
}
const src = 'PM/meetings/x/source.md @ L3';

test('a complete record captures every key item and has no stale rows', () => {
  const dir = project({
    'CLIENT.md': CLIENT_HEAD +
      `| C-1 | Homepage headline "Open Saturdays from October." | Ilse | us | ${src} | void: replaced by CD-3 |\n` +
      `| C-2 | Gift card link in the menu | Ilse | us | ${src} | ⬜ OPEN |\n` +
      `| C-3 | Client sends the gift card link wording | Ilse | Ilse | ${src} | ✅ closed: wording arrived 26 Sep |\n` +
      `| C-4 | Client sends new class photos by 10 October | Ilse | Ilse due 2026-10-10 | ${src} | ⬜ OPEN |\n` +
      `| C-5 | We owe: swap the class photos in when they arrive | Sam | us | ${src} | ⬜ OPEN |\n` +
      `| C-6 | Commercial question: newsletter signup at the bottom of the homepage | Ilse | the user: quote before content | ${src} | ⬜ OPEN |\n` +
      `| C-7 | User approves: send Ilse a price for the newsletter signup | Sam | us | ${src} | ⬜ OPEN |\n` +
      CD_HEAD +
      `| CD-1 | Class prices unchanged this season | 2026-09-12 · Ilse | ${src} | ✅ VERIFIED |\n` +
      `| CD-2 | Closed on Saturdays in October (kiln renovation); don't advertise Saturdays anywhere | 2026-09-26 · Ilse | ${src} | ✅ VERIFIED |\n` +
      `| CD-3 | Homepage headline: "New winter classes from November." | 2026-09-26 · Ilse | ${src} | ✅ VERIFIED |\n` +
      `| CD-4 | Gift card link wording: "Give a class" (approved) | 2026-09-26 · Ilse | ${src} | ✅ VERIFIED |\n` +
      SO_HEAD + `| Client delivers new class photos | 2026-10-10 | Ilse | 2026-10-10 | ${src} |\n`,
    'TASKS.md': TASKS_HEAD +
      `| T-1 | Set the homepage headline to 'New winter classes from November.' | headline reads it | preview | ${src} | ⬜ OPEN |\n` +
      `| T-2 | Remove any Saturday advertising from the whole site | no Saturday mention | preview | ${src} | ⬜ OPEN |\n` +
      `| T-3 | Add the gift card link to the menu, labelled 'Give a class' | link in menu | preview | ${src} | ⬜ OPEN |\n`,
    'FACTS.md': FACTS_HEAD + `| Opening days | Closed on Saturdays in October (kiln renovation) | 2026-09-26 | ${src} |\n`,
  });
  const r = score(dir);
  assert.deepEqual(r.key.filter((k) => !k.ok).map((k) => k.id), []);
  assert.equal(r.captured, r.of);
  assert.equal(r.staleHits, 0);
  assert.deepEqual(r.rowsBy, { T: 3, C: 7, CD: 4 });
});

test('a record with no tasks and live stale rows is named item by item', () => {
  const dir = project({
    'CLIENT.md': CLIENT_HEAD +
      `| C-1 | Homepage headline: Open Saturdays from October | Ilse | us | ${src} | ⬜ OPEN |\n` +
      `| C-2 | Client sends the gift card link wording | Ilse | Ilse | ${src} | ⬜ OPEN |\n` +
      CD_HEAD +
      `| CD-1 | Class prices unchanged this season | 2026-09-12 · Ilse | ${src} | ✅ VERIFIED |\n`,
    'TASKS.md': TASKS_HEAD + `| T-1 | Add the newsletter signup to the homepage | form posts | preview | ${src} | ⬜ OPEN |\n`,
    'FACTS.md': FACTS_HEAD,
  });
  const r = score(dir);
  const missing = r.key.filter((k) => !k.ok).map((k) => k.id);
  for (const id of ['task-winter-headline', 'task-remove-saturdays', 'task-gift-card-link', 'winter-headline', 'give-a-class-approved', 'closed-saturdays-oct']) assert.ok(missing.includes(id), id);
  assert.ok(!missing.includes('prices-unchanged'));
  assert.deepEqual(r.stale.filter((s) => s.hit).map((s) => s.id).sort(), ['gift-wording-still-owed', 'newsletter-build-task', 'saturday-headline-live']);
});

test('an empty project scores zero without crashing', () => {
  const r = score(project({}));
  assert.equal(r.captured, 0);
  assert.equal(r.staleHits, 0);
});

test('a cancelled row does not count as captured', () => {
  const dir = project({
    'CLIENT.md': CLIENT_HEAD + CD_HEAD + `| CD-1 | Class prices unchanged this season | 2026-09-12 · Ilse | ${src} | ✖ VOID superseded by CD-2 |\n`,
    'TASKS.md': TASKS_HEAD, 'FACTS.md': FACTS_HEAD,
  });
  const r = score(dir);
  assert.equal(r.key.find((k) => k.id === 'prices-unchanged').ok, false);
});

test('a headline task that only avoids Saturdays is not the site-wide removal task; a mention of another row\'s VOID does not cancel this row', () => {
  const dir = project({
    'CLIENT.md': CLIENT_HEAD + CD_HEAD + `| CD-2 | Closed on Saturdays in October (kiln renovation) | 2026-09-26 · Ilse | ${src} | ✅ VERIFIED · replaces T-1, now VOID |\n`,
    'TASKS.md': TASKS_HEAD + `| T-1 | Set headline to 'Open Saturdays from October.' | x | preview | ${src} | ✖ VOID superseded by T-2 |\n` +
      `| T-2 | Set homepage headline to 'New winter classes from November.' with no Saturday mention | x | preview | ${src} | ⬜ OPEN |\n`,
    'FACTS.md': FACTS_HEAD,
  });
  const r = score(dir);
  const ok = (id) => r.key.find((k) => k.id === id).ok;
  assert.equal(ok('task-remove-saturdays'), false);
  assert.equal(ok('task-winter-headline'), true);
  assert.equal(ok('closed-saturdays-oct'), true);
});
