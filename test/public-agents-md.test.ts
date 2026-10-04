import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const source = join(root, 'release/public/AGENTS.md');
const exported = !existsSync(source);
const agents = exported ? join(root, 'AGENTS.md') : source;
const docs = exported ? join(root, 'docs') : join(root, 'release/public/docs');
const text = readFileSync(agents, 'utf8');

setDefaultTimeout(30_000);

test('public agent instructions lead with philosophy and a harness entrance', () => {
  expect(text).toContain('## Philosophy');
  expect(text).toContain('## Driving elanous from a coding agent');
  expect(text).toContain('harness say');
});

test('every public manual link in AGENTS.md exists in the exported docs', () => {
  const links = [...text.matchAll(/\]\((docs\/[^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((match) => match[1]!);
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(existsSync(join(docs, link.slice('docs/'.length)))).toBe(true);
});

test('documented public CLI entrances expose real help', () => {
  const commands = [
    'harness say', 'harness ask', 'loop status', 'wf',
    'agent-mission mission', 'decisions raise', 'self run-ledger', 'doctor',
  ];
  for (const command of commands) {
    const result = spawnSync('bun', [join(root, 'bin/elanous.mjs'), '--test', ...command.split(' '), '--help'], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
    });
    const help = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, `${command}: ${help}`).toBe(0);
    expect(help.toLowerCase(), command).not.toContain('unknown command');
    expect(help).toMatch(/Usage: elanous /);
  }
});

test('public AGENTS.md fits one screen', () => {
  expect([...text].length).toBeLessThanOrEqual(6_000);
});

test.skipIf(!existsSync(join(root, 'docs/brand/brand-rules.yaml')))('public AGENTS.md passes the public-docs brand checker', () => {
  const result = spawnSync('bun', [join(root, 'scripts/brand/check.ts'), '--scope', 'public-docs', '--json', agents], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ scope: 'public-docs', files: 1, missing: false, findings: [] });
});
