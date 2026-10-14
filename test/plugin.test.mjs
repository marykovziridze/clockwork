// Tests for the Claude Code plugin packaging: plugin.mjs, .claude-plugin/{plugin,marketplace}.json, skills/onboard/SKILL.md.
// Offline. `claude plugin validate` runs only when the claude binary is on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(KIT, rel), 'utf8');
const { pluginSkill } = await import(pathToFileURL(path.join(KIT, 'plugin.mjs')).href);
const hasClaude = spawnSync('claude', ['--version']).error?.code !== 'ENOENT';

test('plugin files are current with onboard/SKILL.md and VERSION (node plugin.mjs --check)', () => {
  const r = spawnSync(process.execPath, [path.join(KIT, 'plugin.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('plugin.json carries the kit version; marketplace.json lists the plugin at the repo root under the same name', () => {
  const p = JSON.parse(read('.claude-plugin/plugin.json'));
  const m = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.equal(p.version, read('VERSION').trim());
  assert.equal(p.name, 'clockwork');
  assert.deepEqual(m.plugins.map((x) => [x.name, x.source]), [['clockwork', './']]);
});

test('the plugin skill is /clockwork:onboard, finds the kit at ${CLAUDE_PLUGIN_ROOT}, and keeps no placeholder path', () => {
  const s = read('skills/onboard/SKILL.md');
  assert.match(s, /^name: onboard$/m);
  assert.match(s, /^disable-model-invocation: true$/m, 'only the user starts onboarding');
  assert.doesNotMatch(s, /\/path\/to\/clockwork|\/clockwork-onboard/);
  const kits = s.match(/KIT="\$\{CLOCKWORK_KIT:-\$\{CLAUDE_PLUGIN_ROOT\}\}"/g) || [];
  assert.equal(kits.length, (read('onboard/SKILL.md').match(/KIT="\$\{CLOCKWORK_KIT:-/g) || []).length, 'every KIT line is rewritten');
  assert.throws(() => pluginSkill('no kit line'), /no KIT=/);
});

test('the plugin root adds no hooks, agents or MCP servers: Clockwork hooks belong to the projects it onboards', () => {
  for (const d of ['hooks', 'agents', 'commands', '.mcp.json']) assert.ok(!fs.existsSync(path.join(KIT, d)), `${d} at the plugin root would load in every project`);
});

test('claude plugin validate --strict passes', { skip: !hasClaude && 'claude not on PATH' }, () => {
  const r = spawnSync('claude', ['plugin', 'validate', '--strict', KIT], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Validation passed/);
});
