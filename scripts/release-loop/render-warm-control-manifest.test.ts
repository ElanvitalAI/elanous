import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAllDocuments } from 'yaml';

test('warm control init restores a persisted token file to mode 0600 without replacing its contents', () => {
  const image = `registry.example/harness@sha256:${'a'.repeat(64)}`; // Source: #36630
  const rendered = spawnSync(process.execPath, [join(import.meta.dir, 'render-warm-control-manifest.ts'),
    '--image', image, '--namespace', 'elanous-test'], { encoding: 'utf8' });
  expect(rendered.status).toBe(0);
  const deployment = parseAllDocuments(rendered.stdout)
    .map(document => document.toJS() as any)
    .find(row => row?.kind === 'Deployment' && row?.metadata?.name === 'elanous-control');
  const script = deployment?.spec?.template?.spec?.initContainers
    ?.find((row: any) => row.name === 'seed-control-token')?.args?.[0];
  expect(typeof script).toBe('string');

  const root = mkdtempSync(join(tmpdir(), 'warm-control-mode-'));
  try {
    const controlDir = join(root, 'control');
    const tokenFile = join(controlDir, 'tokens.json');
    const seedFile = join(root, 'seed.json');
    mkdirSync(controlDir);
    writeFileSync(tokenFile, 'persisted-token', { mode: 0o660 }); // Source: #36630
    writeFileSync(seedFile, 'different-seed', { mode: 0o600 }); // Source: #36630
    const isolated = script
      .replaceAll('/var/lib/elanous/control/tokens.json', tokenFile)
      .replaceAll('/var/lib/elanous/control', controlDir)
      .replaceAll('/run/secrets/control-tokens.json', seedFile);
    const result = spawnSync('sh', ['-ec', isolated], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600); // Source: #36630
    expect(readFileSync(tokenFile, 'utf8')).toBe('persisted-token');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
