import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTAKE_PROMISE_SOURCES, type IntakeCheckDeps } from '../../src/intake-plane/check.js';

/** Minimal readable ruler sources; individual tests add only the evidence they need. */
export function createIntakeFakeRepo(roots: string[], prefix = 'intake-check-'): IntakeCheckDeps {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  for (const dir of ['catalog', 'src/cli', 'docs']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'catalog/resources.yaml'), 'resources: []\n');
  writeFileSync(join(root, 'catalog/external-commands.yaml'), 'commands: []\n');
  writeFileSync(join(root, 'src/index.ts'), '');
  for (const rel of INTAKE_PROMISE_SOURCES) writeFileSync(join(root, rel), '# FAQ\n');
  return { root, readFile: (path) => readFileSync(path, 'utf8'), commit: () => 'fixture',
    draftDir: join(root, 'drafts'), log: () => {} };
}
