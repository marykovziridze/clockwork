// Intake answer key: does the record an intake leaves behind hold what the three Harbor Ceramics call notes say?
// The memory benchmark only grades what later sessions answer, so a record missing its whole task list can score
// full marks there. This grades the record itself: CLIENT.md, TASKS.md and FACTS.md after `client-memory.mjs setup`.
//   node benchmarks/intake-score.mjs <projectDir> [--reply <run folder or setup-intake.json>] [<projectDir> …] [--json <out.json>]
// A key item passes when some row holds it, whatever its row type: decision versus ask is a judgement call, and a
// later session reads every registry. Stale items fail when a row still treats a reversed or settled point as live.
// With the intake's final reply (--reply after a dir), a miss or stale row the reply puts to the user counts as asked:
// intake holds a reversal of a FACTS line, and a scope call without a signed quote, for the user by design.
import fs from 'node:fs';
import path from 'node:path';

const FILES = ['CLIENT.md', 'TASKS.md', 'FACTS.md'];

// What a complete intake of notes/2026-09-12, -19 and -26 holds. `in` limits the files; every pattern must match one row.
const KEY = [
  { id: 'prices-unchanged', group: 'decision', note: '12 Sep: class prices stay as they are this season', in: ['CLIENT.md', 'FACTS.md'], all: [/price/i, /unchanged|stay|same|no change|as they are|as is/i] },
  { id: 'closed-saturdays-oct', group: 'decision', note: '26 Sep: closed on Saturdays in October (kiln renovation)', in: ['CLIENT.md', 'FACTS.md'], all: [/saturday/i, /closed|not open|renovat|kiln/i], asked: [/closed (on )?saturdays|saturday reversal|26 sep reversal/i, /confirm|your go|your yes|held/i] },
  { id: 'winter-headline', group: 'decision', note: '26 Sep: headline becomes "New winter classes from November."', in: ['CLIENT.md'], all: [/winter classes/i], asked: [/winter classes|reversal/i, /confirm|your go|your yes|held/i] },
  { id: 'give-a-class-approved', group: 'decision', note: '26 Sep: gift card link wording "Give a class" approved', in: ['CLIENT.md'], all: [/give a class/i], asked: [/give a class|reversal/i, /confirm|your go|your yes|held/i] },
  { id: 'gift-card-ask', group: 'ask', note: '12 Sep: client wants a gift card link in the menu', in: ['CLIENT.md', 'TASKS.md'], all: [/gift.?card|give a class/i, /menu|header|nav|link/i] },
  { id: 'photos-due-10-oct', group: 'ask', note: '19 + 26 Sep: client sends new class photos by 10 October', in: ['CLIENT.md', 'FACTS.md'], all: [/photo/i, /10 oct|2026-10-10|10 october|oct(ober)? 10|10\/10/i] },
  { id: 'swap-photos', group: 'ask', note: '19 Sep: we swap the photos in when they arrive', in: ['CLIENT.md', 'TASKS.md'], all: [/photo/i, /swap|replace|update|put .*in|upload|add/i] },
  { id: 'newsletter-new-scope', group: 'ask', note: '19 Sep: newsletter signup is new work, needs a price first', in: ['CLIENT.md'], all: [/newsletter/i, /commercial|new scope|new work|quote|price/i] },
  { id: 'newsletter-price-owed', group: 'ask', note: '19 Sep: we owe Ilse a price for the newsletter', in: ['CLIENT.md', 'TASKS.md'], all: [/newsletter|signup/i, /send|owe|approves/i, /price|quote/i] },
  { id: 'no-saturday-ads', group: 'ask', note: '26 Sep: do not advertise Saturdays anywhere', in: FILES, all: [/saturday/i, /advertis|mention|remove|don.t|do not|no saturday|not .*saturday/i] },
  { id: 'task-winter-headline', group: 'task', note: 'task: set the homepage headline to the winter text', in: ['TASKS.md'], all: [/winter classes|headline/i] },
  { id: 'task-remove-saturdays', group: 'task', note: 'task: remove Saturday mentions from the site', in: ['TASKS.md'], all: [/saturday/i, /remove|find|search|every|site.?wide|whole site|all pages|any page/i] },
  { id: 'task-gift-card-link', group: 'task', note: 'task: add the "Give a class" link to the menu', in: ['TASKS.md'], all: [/gift.?card|give a class/i], asked: [/gift card/i, /quote|covered|new work|scope|decide/i] },
];

// Rows that must not be live once the notes are read in order.
const STALE = [
  { id: 'saturday-headline-live', note: 'the 12 Sep "Open Saturdays from October" headline still live (26 Sep reversed it)', in: FILES, all: [/open saturdays|saturdays from october|opening (on )?saturdays/i], unless: /closed|reversed|replac|superseded|void|withdrawn|cancel|off\b|no longer|instead/i, asked: [/saturday/i, /confirm|your go|your yes|held|decide/i] },
  { id: 'newsletter-build-task', note: 'the newsletter signup filed as a build task before any price was agreed', in: ['TASKS.md'], all: [/newsletter|signup/i], unless: /price|quote|commercial|approve/i },
  { id: 'gift-wording-still-owed', note: 'the gift card wording still listed as owed by the client (it arrived 26 Sep)', in: ['CLIENT.md'], all: [/wording/i, /gift|link/i], unless: /give a class|arrived|received|approved|closed|void|superseded/i, live: true, asked: [/wording/i, /decide|confirm|still says|owes/i] },
];

const DONE = /✅|VERIFIED|DONE|closed|void|superseded|withdrawn|replaced|cancel/i;
// a cancelled row holds nothing a later session should act on; only its own status counts ("T-1, now VOID" in another row does not)
const VOID = /^\s*(✖|VOID\b|superseded|withdrawn|cancel)/i;

function rows(dir) {
  const cfgPath = path.join(dir, '.claude/clockwork.json');
  const regDir = fs.existsSync(cfgPath) ? (JSON.parse(fs.readFileSync(cfgPath, 'utf8')).registryDir || '.claude') : '.claude';
  const out = [];
  for (const file of FILES) {
    const p = path.join(dir, regDir, file);
    if (!fs.existsSync(p)) continue;
    let section = '';
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (line.startsWith('## ')) section = line.slice(3).trim();
      if (!line.startsWith('|') || /^\|\s*[-:]+\s*\|/.test(line)) continue;
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
      if (!cells.length || /^(ID|Fact|Obligation)$/i.test(cells[0])) continue;
      if (cells.slice(1).every((c) => !c)) continue; // a template row with no value yet
      const id = /^[A-Z]{1,3}-\d+$/.test(cells[0]) ? cells[0] : '';
      out.push({ file, section, id, text: cells.join(' | '), status: cells[cells.length - 1] });
    }
  }
  return out;
}

function score(dir, reply = '') {
  const rs = rows(dir);
  // asked: one paragraph or bullet of the reply names the item and puts it to the user, not two distant mentions
  const parts = reply.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/);
  const asked = (x) => !!(reply && x.asked && parts.some((p) => x.asked.every((re) => re.test(p))));
  const match = (k) => rs.filter((r) => k.in.includes(r.file) && k.all.every((re) => re.test(r.text)));
  const key = KEY.map((k) => { const m = match(k).filter((r) => !VOID.test(r.status)); return { id: k.id, group: k.group, note: k.note, ok: m.length > 0, asked: m.length === 0 && asked(k), rows: m.map((r) => r.id || `${r.file}: ${r.text.slice(0, 50)}`) }; });
  const stale = STALE.map((s) => {
    const m = match(s).filter((r) => !s.unless.test(r.text) && (!s.live || !DONE.test(r.status)));
    return { id: s.id, note: s.note, hit: m.length > 0, asked: m.length > 0 && asked(s), rows: m.map((r) => r.id || `${r.file}: ${r.text.slice(0, 50)}`) };
  });
  const count = (prefix) => new Set(rs.filter((r) => r.id.startsWith(`${prefix}-`)).map((r) => r.id)).size;
  const silent = key.filter((k) => !k.ok && !k.asked).length + stale.filter((s) => s.hit && !s.asked).length;
  return { dir, captured: key.filter((k) => k.ok).length, of: key.length, staleHits: stale.filter((s) => s.hit).length, silentErrors: silent, rowsBy: { T: count('T'), C: count('C'), CD: count('CD') }, key, stale };
}

const args = process.argv.slice(2);
const ji = args.indexOf('--json'); const jsonOut = ji >= 0 ? args.splice(ji, 2)[1] : null;
if (!args.length) { console.error('usage: node benchmarks/intake-score.mjs <projectDir> [...] [--json out.json]'); process.exit(2); }
// Everything the intake said to the user: a run folder's *.jsonl logs (every assistant message, so a hold asked in an
// earlier turn counts) plus each *.json `final`; or one setup-intake.json.
function readReply(p) {
  try {
    if (!fs.statSync(p).isDirectory()) return JSON.parse(fs.readFileSync(p, 'utf8')).final || '';
    let text = '';
    for (const f of fs.readdirSync(p).sort()) {
      const fp = path.join(p, f);
      if (f.endsWith('.jsonl')) for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
        try { const m = JSON.parse(line); if (m.type === 'assistant') for (const c of m.message?.content || []) if (c.type === 'text') text += `${c.text}\n`; } catch {}
      }
      if (f.endsWith('.json')) try { text += `${JSON.parse(fs.readFileSync(fp, 'utf8')).final || ''}\n`; } catch {}
    }
    return text;
  } catch { return ''; }
}
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--reply') { const t = targets[targets.length - 1]; const r = args[++i]; if (t) t.reply = readReply(r); continue; }
  targets.push({ dir: args[i], reply: '' });
}
const results = targets.map((t) => score(t.dir, t.reply));
for (const r of results) {
  console.log(`\n${r.dir}\n  captured ${r.captured}/${r.of} · stale ${r.staleHits} · silent errors ${r.silentErrors} · rows T ${r.rowsBy.T} C ${r.rowsBy.C} CD ${r.rowsBy.CD}`);
  for (const k of r.key.filter((k) => !k.ok)) console.log(`  missing${k.asked ? ' (asked the user)' : ''}  ${k.id}: ${k.note}`);
  for (const s of r.stale.filter((s) => s.hit)) console.log(`  stale${s.asked ? ' (asked the user)' : ''}  ${s.id}: ${s.note} [${s.rows.join(', ')}]`);
}
if (results.length > 1) {
  console.log('\nper item, runs that captured it:');
  for (const k of KEY) console.log(`  ${String(results.filter((r) => r.key.find((x) => x.id === k.id).ok).length).padStart(2)}/${results.length}  ${k.id}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
