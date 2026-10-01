// W9e-FU Z13-d · NEXUS DI wire — devices fleet source forward into
// http-server opts.devices. Source-grep guard.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(HERE, '..', '..', 'src', 'nexus', 'index.ts');
const SOURCE = readFileSync(INDEX_PATH, 'utf8');

describe('nexus/index.ts · Z13-d devices NEXUS DI forward (W9e-FU)', () => {
  test('startNexusHttpServer opts.devices forwards devicesSubstrateHandle.source', () => {
    expect(SOURCE).toMatch(/devicesSubstrateHandle\s*\?\s*\{\s*devices:\s*\{\s*fleetSource:\s*devicesSubstrateHandle\.source\s*\}\s*\}\s*:\s*\{\}/);
  });

  test('forward sits inside the startNexusHttpServer({...}) call block', () => {
    // The injected server function receives the opts object at this call site.
    const startIdx = SOURCE.indexOf('httpServer = startHttpServer({');
    expect(startIdx).toBeGreaterThan(-1);
    const tail = SOURCE.slice(startIdx);
    const closeIdx = tail.indexOf('\n    });');
    expect(closeIdx).toBeGreaterThan(-1);
    const optsBlock = tail.slice(0, closeIdx);
    expect(optsBlock).toContain('fleetSource: devicesSubstrateHandle.source');
    expect(optsBlock).toMatch(/devicesSubstrateHandle\s*\?\s*\{\s*devices:/);
  });

  test('forward is gated on devicesSubstrateHandle presence — devices block omitted when boot skipped completely', () => {
    // `cronEnabled: false` path still returns a substrate (source-only,
    // cron=null). The ternary still fires because `devicesSubstrateHandle`
    // is defined. Only path that drops devices entirely is the outer
    // try/catch failure — keep that contract frozen.
    expect(SOURCE).toMatch(/\.\.\.\(\s*devicesSubstrateHandle\s*\?\s*\{\s*devices:/);
  });
});
