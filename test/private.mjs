// Data that belongs to one machine and never ships with the kit: real project paths for the opt-in live smoke
// tests, and the client names publish.mjs refuses to publish. File: $CLOCKWORK_PRIVATE, else
// ~/.claude/clockwork-private.json. Missing file = no private data (those tests skip). Shape: README "Private data".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PRIVATE_FILE = process.env.CLOCKWORK_PRIVATE || path.join(os.homedir(), '.claude', 'clockwork-private.json');

export function loadPrivate() {
  try { return JSON.parse(fs.readFileSync(PRIVATE_FILE, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`${PRIVATE_FILE}: ${e.message}`); }
}
