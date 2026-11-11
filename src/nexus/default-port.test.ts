import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_NEXUS_HTTP_PORT as leafPort } from './default-port.js';
import { DEFAULT_NEXUS_HTTP_PORT as serverPort } from './api/http-server.js';

test('default daemon port loads in isolation and matches the HTTP server export', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c8-nexus-port-'));
  try {
    const isolated = join(root, 'default-port.ts');
    copyFileSync(new URL('./default-port.ts', import.meta.url), isolated);
    const module = await import(pathToFileURL(isolated).href);
    expect(module.DEFAULT_NEXUS_HTTP_PORT).toBe(leafPort);
    const browserBundle = await Bun.build({ entrypoints: [isolated], target: 'browser' });
    expect(browserBundle.success).toBe(true);
    const browserModule = await import(`data:text/javascript;base64,${Buffer.from(await browserBundle.outputs[0]!.text()).toString('base64')}`);
    expect(browserModule.DEFAULT_NEXUS_HTTP_PORT).toBe(leafPort);
    expect(leafPort).toBe(31415);
    expect(serverPort).toBe(leafPort);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
