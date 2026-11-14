import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isSkillOnlyPack } from './host.js';
import { loadPluginManifestFromDir } from './manifest.js';

test('native-only route indexes need no JavaScript main but code plugins still do', () => {
  for (const id of ['elanous-observe', 'elanous-release']) {
    const root = join(import.meta.dir, '../../../plugins', id);
    const { manifest } = loadPluginManifestFromDir(root, { id });
    expect(existsSync(join(root, manifest.main))).toBe(false);
    expect(isSkillOnlyPack(root, manifest, false)).toBe(true);
    expect(isSkillOnlyPack(root, manifest, true)).toBe(false);
    expect(isSkillOnlyPack(root, { ...manifest, main: './missing.js' }, false)).toBe(false);
    expect(isSkillOnlyPack(root, { main: './plugin.ts', contributes: { aiTools: [{ handler: './code.ts' }] } }, false)).toBe(false);
  }
});
