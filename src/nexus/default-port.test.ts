import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_NEXUS_HTTP_PORT as leafPort } from './default-port.js';
import { DEFAULT_NEXUS_HTTP_PORT as serverPort } from './api/http-server.js';

test('default daemon port is a dependency-free leaf and keeps the HTTP server export', () => {
  const source = readFileSync(new URL('./default-port.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\bimport\s*(?:[\s\S]*?\sfrom\s*)?['"(]/);
  expect(leafPort).toBe(31415);
  expect(serverPort).toBe(leafPort);
});
