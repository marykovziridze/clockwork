#!/usr/bin/env node
// Clockwork prompt-intake (UserPromptSubmit, no matcher). Managed file: do not edit in a project.
//
// Formats (verified 2026-09-30 against https://code.claude.com/docs/en/hooks.md#userpromptsubmit):
//  - stdin: { session_id, cwd, hook_event_name:"UserPromptSubmit", prompt }. Pasted text arrives expanded in place; in sessions
//    that mark pasted text it sits between <pasted_content id="…"> lines.
//  - stdout: { hookSpecificOutput:{ hookEventName:"UserPromptSubmit", additionalContext } } adds context next to the prompt.
//  - It never blocks and never prints anything for an ordinary prompt. Default timeout on this event is 30 s; ours is tiny.
//
// Detection is deliberately narrow: a wrong nudge costs the user attention, a missed one only costs one sentence.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MESSAGE = 'This looks like client source material (a pasted transcript, email or feedback document). Run the `intake` skill before anything else, unless the user said what to do with it.';

const HEADER_NAMES = ['from', 'sent', 'to', 'cc', 'subject', 'date', 'van', 'aan', 'verzonden', 'onderwerp'];
// Teams: "Anna Visser   2:23 Hello"; Zoom/Teams chat: "[10:05:30] Name: text" or "10:05 AM Name: text"
const SPEAKER_TS = /^\s*[\p{Lu}][\p{L}.'’-]*(?: [\p{L}.'’-]+){0,3}\s{1,}\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\s+\S/u;
const TS_SPEAKER = /^\s*\[?\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\]?\s+(?:From\s+)?[\p{Lu}][\p{L}.'’ -]{0,40}\s?:\s*\S/u;
const RECAP_MARKERS = [
  /\bMeeting Transcript\b/i, /^\s*started transcription\b/im, /\bZoom AI Companion\b/i, /\bMeeting Summary with AI Companion\b/i,
  /^\s*Meeting (?:recap|summary)\b/im, /\bIntelligent recap\b/i, /\bNotes by Gemini\b/i, /\bGemini notes\b/i,
];

export function looksLikeSourceMaterial(prompt) {
  if (typeof prompt !== 'string') return false;
  if (prompt.includes('<pasted_content')) return true;
  const len = prompt.length;
  const lines = prompt.split('\n');
  if (len >= 150) {
    const seen = new Set();
    for (const l of lines) {
      const m = l.match(/^[\s>]*([\p{L}]{2,12}):\s*\S/u);
      if (m && HEADER_NAMES.includes(m[1].toLowerCase())) seen.add(m[1].toLowerCase());
    }
    const mail = (seen.has('from') || seen.has('van')) && (seen.size >= 2);
    const mailNoFrom = (seen.has('subject') && seen.has('sent')) || (seen.has('onderwerp') && seen.has('verzonden'));
    if (mail || mailNoFrom) return true;
  }
  if (len >= 600 && RECAP_MARKERS.some((re) => re.test(prompt))) return true;
  if (len >= 1200) {
    let hits = 0;
    for (const l of lines) if (SPEAKER_TS.test(l) || TS_SPEAKER.test(l)) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

// Async stdin read: readFileSync(0) throws EAGAIN when Claude Code writes the input after node started.
function readStdin(ms = 5000) {
  return new Promise((done) => {
    let raw = '', over = false;
    const end = (why) => { if (over) return; over = true; clearTimeout(t); done({ raw, why }); };
    const t = setTimeout(() => end('no input within 5 s'), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => end(null));
    process.stdin.on('error', (e) => end(`read error: ${e.message}`));
  });
}

async function main() {
  let input = {};
  if (!process.stdin.isTTY) {
    const got = await readStdin();
    const warn = (why) => { fs.writeSync(1, JSON.stringify({ systemMessage: `Clockwork prompt-intake: could not read the prompt (${why}); no intake check ran.` })); process.exit(0); };
    if (got.why) return warn(got.why);
    try { input = JSON.parse(got.raw || '{}'); } catch { return warn('not JSON'); }
  }
  if (!input || typeof input !== 'object') input = {};
  let hit = false;
  try { hit = looksLikeSourceMaterial(input.prompt); } catch (e) {
    fs.writeSync(1, JSON.stringify({ systemMessage: `Clockwork prompt-intake failed (${e && e.message}); no intake nudge was added.` }));
    process.exit(0);
  }
  if (hit) fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: MESSAGE } }));
  process.exit(0);
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
