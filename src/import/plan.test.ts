import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatImportPlan, IMPORT_STATUSES, planImport } from './plan.js';

const TG = '7000000001:AAFAKEtelegramTOKENopenclaw_value_xx';
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function skill(root: string, name: string, body = `# ${name}\n`): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), body);
}

/** A home with every source and every status once. */
function fixture(): { home: string; active: string } {
  const home = mkdtempSync(join(tmpdir(), 'en4-import-'));
  homes.push(home);
  const active = join(home, '.agents', 'skills');
  skill(active, 'shared');
  skill(active, 'dup', 'same body');
  skill(active, 'clash', 'elanous body');
  skill(join(home, '.claude', 'skills'), 'fresh');
  skill(join(home, '.claude', 'skills'), 'dup', 'same body');
  skill(join(home, '.codex', 'skills'), 'clash', 'codex body');
  skill(join(home, '.codex', 'skills'), '.system');
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# rules\n');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { plain: { command: 'x' }, keyed: { command: 'y', env: { API_KEY: 'sk-never-print' } }, known: { command: 'z' } } }));
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.repl]\ncommand = "node"\n\n[mcp_servers."quoted-name"]\ncommand = "a"\n[mcp_servers."quoted-name".env]\nTOKEN = "never"\n');
  writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{"access_token":"never"}}');
  mkdirSync(join(home, '.openclaw'));
  writeFileSync(join(home, '.openclaw', 'openclaw.json'), `{ "channels": { "telegram": { "botToken": "${TG}" } }, "mcp": { "servers": { "oc": { "command": "o" } } } }`);
  mkdirSync(join(home, '.hermes'));
  writeFileSync(join(home, '.hermes', 'config.yaml'), 'model: x\nmcp_servers:\n  hermes-fs:\n    command: fs\n');
  return { home, active };
}

const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort().map((p) => `${p}:${statSync(join(dir, p)).mtimeMs}`);

test('every source is detected and each item gets one of the six statuses', () => {
  const { home, active } = fixture();
  const plan = planImport({ home, activeSkillDirs: [active], mcpServerIds: ['known'] });
  expect(plan.sources.filter((s) => s.detected).map((s) => s.id)).toEqual(['agents', 'claude', 'codex', 'openclaw', 'hermes']);
  const status = (source: string, kind: string, name: string) => plan.items.find((i) => i.source === source && i.kind === kind && i.name === name)?.status;
  expect(status('agents', 'skill', 'shared')).toBe('same');
  expect(status('claude', 'skill', 'fresh')).toBe('new');
  expect(status('claude', 'skill', 'dup')).toBe('same');
  expect(status('codex', 'skill', 'clash')).toBe('conflict');
  expect(status('claude', 'instructions', 'CLAUDE.md')).toBe('unsupported');
  expect(status('claude', 'hooks', 'Stop')).toBe('archived-only');
  expect(status('claude', 'mcp', 'plain')).toBe('new');
  expect(status('claude', 'mcp', 'keyed')).toBe('secret');
  expect(status('claude', 'mcp', 'known')).toBe('same');
  expect(status('codex', 'mcp', 'repl')).toBe('new');
  expect(status('codex', 'mcp', 'quoted-name')).toBe('secret');
  expect(status('codex', 'credentials', 'login')).toBe('secret');
  expect(status('openclaw', 'mcp', 'oc')).toBe('new');
  expect(status('openclaw', 'channel-bot', 'telegram')).toBe('secret');
  expect(status('hermes', 'mcp', 'hermes-fs')).toBe('unsupported');
  expect(plan.items.some((i) => i.name === '.system')).toBe(false);
  expect(new Set(plan.items.map((i) => i.status))).toEqual(new Set(IMPORT_STATUSES));
  expect(plan.items.find((i) => i.name === 'fresh')!.next).toBe('elanous connect claude');
  expect(plan.items.find((i) => i.kind === 'channel-bot')!.next).toBe('elanous nexus channel-bot import');
});

test('planning writes nothing and never prints a secret value', () => {
  const { home, active } = fixture();
  const before = snapshot(home);
  const plan = planImport({ home, activeSkillDirs: [active], mcpServerIds: [] });
  const out = `${JSON.stringify(plan)}\n${formatImportPlan(plan)}`;
  expect(snapshot(home)).toEqual(before);
  for (const secret of [TG, 'sk-never-print', 'never']) expect(out).not.toContain(secret);
  expect(out).not.toContain(home);
  expect(formatImportPlan(plan)).toContain('아무것도 쓰지 않았습니다');
  expect(formatImportPlan(plan)).toContain('`elanous connect claude`');
});

test('an empty home says no agent was found', () => {
  const home = mkdtempSync(join(tmpdir(), 'en4-empty-'));
  homes.push(home);
  const plan = planImport({ home, activeSkillDirs: [], mcpServerIds: [] });
  expect(plan.items).toEqual([]);
  expect(formatImportPlan(plan)).toContain('쓰던 에이전트를 찾지 못했습니다');
});

test('a codex root that elanous already reads marks every skill same', () => {
  const { home } = fixture();
  const plan = planImport({ home, activeSkillDirs: [join(home, '.codex', 'skills')], mcpServerIds: [] });
  expect(plan.items.filter((i) => i.source === 'codex' && i.kind === 'skill').every((i) => i.status === 'same')).toBe(true);
});
