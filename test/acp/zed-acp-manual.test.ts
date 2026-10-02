import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAcpBootArgs } from '../../src/boot/acp-server.js';

const manual = readFileSync(resolve(import.meta.dir, '../../docs/manual/MANUAL-zed-acp.md'), 'utf8');
const index = readFileSync(resolve(import.meta.dir, '../../docs/_index.md'), 'utf8');

test('Zed launch example is valid JSON and uses the ACP stdio boot path', () => {
  const example = manual.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!example) throw new Error('Missing settings.json example');
  const settings = JSON.parse(example) as {
    agent_servers?: { elanous?: { command?: string; args?: string[] } };
  };
  expect(settings.agent_servers?.elanous).toEqual({
    command: 'elanous',
    args: ['--acp-server', '--transport=stdio'],
  });
  expect(parseAcpBootArgs(settings.agent_servers!.elanous!.args!).transport).toBe('stdio');
});

test('manual names every accepted transport and keeps registry listing separate', () => {
  const accepted = (() => {
    try {
      parseAcpBootArgs(['--transport=invalid']);
    } catch (error) {
      return String(error).match(/\(expected ([^)]+)\)/)?.[1]?.split(/\s*\|\s*/);
    }
  })();
  if (!accepted) throw new Error('ACP parser does not advertise accepted transports');
  for (const transport of accepted) expect(manual).toContain(`--transport=${transport}`);
  expect(manual).toContain('command -v elanous');
  expect(manual).toContain("Zed's agent panel");
  expect(manual).toContain('0.2.10 E10');
  expect(manual).toContain('`elanous-login`');
  expect(manual).toContain('--acp-server --login');
  expect(index).toContain('manual/MANUAL-zed-acp.md');
});
