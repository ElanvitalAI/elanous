import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeclaredPluginHandler } from './declared-handler.js';

test('plugin handler loader resolves one declared module and rejects ambiguous registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'declared-handler-'));
  const install = (id: string) => {
    const dir = join(root, id);
    mkdirSync(join(dir, 'handlers'), { recursive: true });
    writeFileSync(join(dir, 'plugin.yaml'), `id: ${id}\nskills:\n  - { id: ${id}/build }\nhandlers:\n  boardApproval: { module: handlers/approval.ts, export: createApproval, skill: ${id}/build }\n`);
    writeFileSync(join(dir, 'handlers/approval.ts'), `export function createApproval() { return '${id}'; }\n`);
  };
  try {
    install('first');
    const factory = await loadDeclaredPluginHandler<() => string>(root, 'boardApproval');
    expect(factory?.()).toBe('first');
    install('second');
    await expect(loadDeclaredPluginHandler(root, 'boardApproval')).rejects.toThrow('ambiguous plugin handler');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
