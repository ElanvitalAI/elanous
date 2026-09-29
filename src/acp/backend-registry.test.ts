import { expect, test } from 'bun:test';
import { ACP_BACKENDS } from './backend-registry.js';

test('Claude ACP registry uses the pinned subscription adapter and its actual npm bin', async () => {
  const installed = await import('@agentclientprotocol/claude-agent-acp/package.json');
  const project = await import('../../package.json');
  const dependencies: Record<string, string> = project.dependencies;
  const claude = ACP_BACKENDS.claude!;
  expect(claude.npmPackage).toBe('@agentclientprotocol/claude-agent-acp');
  expect(claude.npmVersion).toBe('0.81.2');
  expect(claude.command).toBe(Object.keys(installed.bin)[0]);
  expect(installed.version).toBe(claude.npmVersion);
  expect(dependencies[claude.npmPackage]).toBe(claude.npmVersion);
  expect(dependencies['@agentclientprotocol/sdk']).toBe(installed.dependencies['@agentclientprotocol/sdk']);
  expect(dependencies['@zed-industries/claude-code-acp']).toBeUndefined();
});
