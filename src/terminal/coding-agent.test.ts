import { expect, test } from 'bun:test';
import { spawnCodingAgent } from './coding-agent.js';
import type { SessionSpawnSpec, TerminalSession } from './session-registry.js';
import { resetCapturedEnvForTesting, setCapturedEnvForTesting } from '../shell-env-bootstrap.js';

test('Codex PTY inherits only the access-only policy marker from the parent env', () => {
  const names = ['ELANOUS_REMOTE_CODEX_ACCESS_ONLY', 'OPENAI_API_KEY', 'CODEX_HOME', 'ELANOUS_REMOTE_CODEX_MIRROR_PATH', 'CODEX_ACCESS_TOKEN'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  setCapturedEnvForTesting({ PATH: '/usr/bin:/bin', HOME: '/home/test' });
  process.env.ELANOUS_REMOTE_CODEX_ACCESS_ONLY = '1';
  process.env.OPENAI_API_KEY = 'must-not-forward';
  process.env.CODEX_HOME = '/private/codex-home';
  process.env.ELANOUS_REMOTE_CODEX_MIRROR_PATH = '/private/mirror/auth.json';
  process.env.CODEX_ACCESS_TOKEN = 'must-not-forward';
  try {
    let childEnv: Record<string, string> | undefined;
    spawnCodingAgent({ brand: 'codex', cwd: '/tmp/worktree' }, {
      registry: { spawn(spec: SessionSpawnSpec) { childEnv = spec.env; return { id: 'codex-policy-pty' } as TerminalSession; } } as never,
      termCols: 80,
      termRows: 24,
      whichBinary: binary => binary === 'codex' ? '/usr/local/bin/codex' : null,
    });

    expect(childEnv).toMatchObject({ ELANOUS_REMOTE_CODEX_ACCESS_ONLY: '1', HOME: '/home/test', PATH: '/usr/bin:/bin' });
    for (const name of names.slice(1)) expect(childEnv).not.toHaveProperty(name);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    resetCapturedEnvForTesting();
  }
});

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
