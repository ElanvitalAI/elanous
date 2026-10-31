import { expect, test } from 'bun:test';
import { spawnCodingAgent } from './coding-agent.js';
import type { SessionSpawnSpec, TerminalSession } from './session-registry.js';

test('Grok sidetab starts the subscribed CLI with API-key auth disabled and secrets scrubbed', () => {
  let captured: { command: string; env?: Record<string, string>; agentBrand?: string } | undefined;
  spawnCodingAgent({ brand: 'grok', cwd: '/tmp/demo', env: { XAI_API_KEY: 'explicit-secret', GROK_API_KEY: 'other-secret' } }, {
    registry: {
      spawn(spec: SessionSpawnSpec) {
        captured = { command: spec.command ?? '', env: spec.env, agentBrand: spec.agentBrand };
        return { id: 'grok-pty' } as TerminalSession;
      },
    } as never,
    termCols: 80,
    termRows: 24,
    whichBinary: (binary) => binary === 'grok' ? '/usr/local/bin/grok' : null,
  });

  expect(captured).toMatchObject({ command: 'grok --always-approve', agentBrand: 'grok' });
  expect(captured?.env?.GROK_DISABLE_API_KEY_AUTH).toBe('1');
  expect(captured?.env).not.toHaveProperty('XAI_API_KEY');
  expect(captured?.env).not.toHaveProperty('GROK_API_KEY');
  expect(captured?.env).not.toHaveProperty('GROK_CODE_XAI_API_KEY');
});

test('Grok sidetab fails before spawning when the grok binary is missing', () => {
  let spawned = false;
  expect(() => spawnCodingAgent({ brand: 'grok', cwd: '/tmp/demo' }, {
    registry: { spawn() { spawned = true; return {} as TerminalSession; } } as never,
    termCols: 80,
    termRows: 24,
    whichBinary: () => null,
  })).toThrow('grok binary not found in PATH');
  expect(spawned).toBe(false);
});
