import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillSource } from '../user-config.js';
import { applyImport, formatApplied, readImportManifest, undoImport, type ApplyDeps } from './apply.js';
import { planImport } from './plan.js';

const TG = '7000000001:AAFAKEtelegramTOKENopenclaw_value_xx';
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function skill(root: string, name: string, body = `# ${name}\n`): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), body);
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'en7-import-'));
  homes.push(home);
  const active = join(home, '.agents', 'skills');
  skill(active, 'clash', 'elanous body');
  skill(join(home, '.claude', 'skills'), 'fresh');
  skill(join(home, '.claude', 'skills'), 'other');
  skill(join(home, '.codex', 'skills'), 'clash', 'codex body');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { plain: { command: 'npx', args: ['-y', 'srv'] }, web: { type: 'http', url: 'https://mcp.example/x' }, keyed: { command: 'y', env: { API_KEY: 'sk-never-print' } } } }));
  mkdirSync(join(home, '.openclaw'));
  writeFileSync(join(home, '.openclaw', 'openclaw.json'), `{ "channels": { "telegram": { "botToken": "${TG}" } } }`);
  const configDir = join(home, '.elanous');
  mkdirSync(configDir);
  const configPath = join(configDir, 'config.json');
  const original = '{\n  "skills": { "activeSet": "claudecode" },\n  "mcp": { "servers": [ { "id": "mine", "command": ["x"] } ] }\n}\n';
  writeFileSync(configPath, original);
  const saved: Array<{ sources: SkillSource[]; servers: Array<Record<string, unknown>> }> = [];
  const deps: ApplyDeps = {
    home, configPath, importRoot: join(configDir, 'import'), sources: [], rawMcpServers: [{ id: 'mine', command: ['x'] }],
    save: (sources, servers) => { saved.push({ sources, servers }); writeFileSync(configPath, JSON.stringify({ skills: { sources }, mcp: { servers } })); },
    now: () => new Date('2026-10-02T03:00:00Z'),
  };
  const plan = planImport({ home, activeSkillDirs: [active], mcpServerIds: ['mine'] });
  return { home, configPath, original, deps, saved, plan };
}

test('ref apply registers the skill folder in place, adds MCP switched off, keeps secrets and hooks, and undo restores the config bytes', () => {
  const { home, configPath, original, deps, saved, plan } = setup();
  const m = applyImport(plan, {}, deps);
  expect(m.mode).toBe('ref');
  expect(saved).toHaveLength(1);
  expect(saved[0]!.sources).toEqual([{ id: 'claude', path: join(home, '.claude', 'skills'), kind: 'connected', enabled: true }]);
  expect(saved[0]!.servers).toEqual([
    { id: 'mine', command: ['x'] },
    { id: 'plain', command: ['npx', '-y', 'srv'], enabled: false },
    { id: 'web', transport: 'http', url: 'https://mcp.example/x', enabled: false },
  ]);
  const kept = Object.fromEntries(m.kept.map((k) => [k.id, k.status]));
  expect(kept).toMatchObject({ 'claude:mcp:keyed': 'secret', 'claude:hooks:Stop': 'archived-only', 'codex:skill:clash': 'conflict', 'openclaw:channel-bot:telegram': 'secret' });
  expect(m.created).toEqual([]);
  const shown = `${formatApplied(m)}\n${readFileSync(join(deps.importRoot, 'last-apply.json'), 'utf8').replace(original, '')}`;
  for (const secret of [TG, 'sk-never-print']) expect(shown).not.toContain(secret);
  expect(() => applyImport(plan, {}, deps)).toThrow('import --undo');
  expect(undoImport(deps.importRoot)).not.toBeNull();
  expect(readFileSync(configPath, 'utf8')).toBe(original);
  expect(readImportManifest(deps.importRoot)).toBeNull();
  expect(undoImport(deps.importRoot)).toBeNull();
});

test('link and copy create per-skill entries under the import folder and undo removes them', () => {
  for (const mode of ['link', 'copy'] as const) {
    const { home, configPath, original, deps, saved, plan } = setup();
    const m = applyImport(plan, { mode, pick: ['claude:skill:fresh'] }, deps);
    const target = join(deps.importRoot, 'skills', 'claude', 'fresh');
    expect(m.applied).toEqual([{ id: 'claude:skill:fresh', how: `${mode} ~/.claude/skills/fresh` }]);
    expect(m.created).toEqual([target]);
    expect(lstatSync(target).isSymbolicLink()).toBe(mode === 'link');
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('# fresh\n');
    expect(existsSync(join(deps.importRoot, 'skills', 'claude', 'other'))).toBe(false);
    expect(saved[0]!.sources).toEqual([{ id: 'import:claude', path: join(deps.importRoot, 'skills', 'claude'), kind: 'connected', enabled: true }]);
    undoImport(deps.importRoot);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(home, '.claude', 'skills', 'fresh', 'SKILL.md'))).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  }
});

test('a missing config file is removed again on undo, and an apply with nothing new writes no config', () => {
  const { configPath, deps, plan } = setup();
  rmSync(configPath);
  applyImport(plan, { pick: ['claude:mcp:plain'] }, deps);
  expect(existsSync(configPath)).toBe(true);
  undoImport(deps.importRoot);
  expect(existsSync(configPath)).toBe(false);
  const m = applyImport(plan, { pick: ['claude:mcp:keyed'] }, deps);
  expect(m.applied).toEqual([]);
  expect(existsSync(configPath)).toBe(false);
});
