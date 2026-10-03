import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repo = new URL('../..', import.meta.url).pathname;

type Identity = {
  spaceId: string;
  parentPtyId: string;
  parentPid: number;
  parentKind: string;
};

function runManifest(
  stateDir: string,
  env: Record<string, string | undefined>,
  script: string,
): unknown {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'production',
    ELANOUS_STATE_DIR: stateDir,
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }

  const result = Bun.spawnSync([process.execPath, '-e', `
    import { startPty, setPtyAdapterForTesting, unregisterPty } from './src/pty-shell/registry.ts';
    import { getPtyManifest, upsertPtyManifest } from './src/pty-shell/pty-manifest.ts';
    setPtyAdapterForTesting(() => ({
      pid: 42,
      write() {},
      kill() {},
      resize() {},
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
    }));
    ${script}
  `], {
    cwd: repo,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

function runManifestIdentity(stateDir: string): unknown {
  return runManifest(stateDir, {
    ELANOUS_RUN_ID: 'run-manifest-identity',
    ELANOUS_HARNESS_SPACE_ID: 'space-manifest-identity',
    ELANOUS_SESSION_ID: 'session-manifest-identity',
    ELANOUS_PARENT_PTY_ID: 'parent_1234abcd',
    ELANOUS_PTY_ID: undefined,
    ELANOUS_PTY_CHAIN_ORIGIN: 'identity-origin',
    ELANOUS_NEST_DEPTH: '3',
    ELANOUS_ORIGIN_ROOT: 'external-agent',
    ELANOUS_ORIGIN_AGENT: 'codex',
    ELANOUS_ORIGIN_SESSION: 'origin-session',
    ELANOUS_CONTROLLER: 'automation',
  }, `
    const handle = startPty({ id: 'identity_1234abcd', kind: 'identity', cmd: 'synthetic', detach: true });
    const row = getPtyManifest(handle.id);
    console.log(JSON.stringify({
      id: row?.id,
      kind: row?.kind,
      ptyPid: row?.ptyPid,
      runId: row?.runId,
      spaceId: row?.spaceId,
      sessionId: row?.sessionId,
      parentPtyId: row?.parentPtyId,
      parentPid: row?.parentPid,
      parentKind: row?.parentKind,
      chainOrigin: row?.chainOrigin,
      nestDepth: row?.nestDepth,
      originRoot: row?.originRoot,
      originAgent: row?.originAgent,
      originSession: row?.originSession,
      controller: row?.controller,
      terminalOriginCategory: row?.terminalOriginCategory,
      terminalOriginReason: row?.terminalOriginReason,
      externalToolName: row?.externalToolName,
    }));
    unregisterPty(handle.id);
  `);
}

function withStateDir<T = { identity: Identity; pid: number }>(
  env: Record<string, string | undefined>,
  script: string,
): T {
  const stateDir = mkdtempSync(join(tmpdir(), 'pty-manifest-identity-'));
  try {
    return runManifest(stateDir, env, script) as T;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function childManifestDepth(
  env: Record<string, string | undefined>,
  childEnv: string,
): { nestDepth?: number; parentKind: string } {
  const stateDir = mkdtempSync(join(tmpdir(), 'pty-manifest-identity-'));
  try {
    return runManifest(stateDir, env, `
      const handle = startPty({ cmd: 'x', detach: true, env: ${childEnv} });
      const { nestDepth, parentKind } = getPtyManifest(handle.id);
      console.log(JSON.stringify({ ...(nestDepth === undefined ? {} : { nestDepth }), parentKind }));
      unregisterPty(handle.id);
      process.exit(0);
    `) as { nestDepth?: number; parentKind: string };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function childManifestController(
  env: Record<string, string | undefined>,
  childEnv: string,
): string | null {
  const stateDir = mkdtempSync(join(tmpdir(), 'pty-manifest-identity-'));
  try {
    return runManifest(stateDir, env, `
      const handle = startPty({ cmd: 'x', detach: true, env: ${childEnv} });
      console.log(JSON.stringify(getPtyManifest(handle.id).controller ?? null));
      unregisterPty(handle.id);
      process.exit(0);
    `) as string | null;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const spawnedIdentity = `
  const handle = startPty({ cmd: 'x', detach: true });
  const { spaceId, parentPtyId, parentPid, parentKind } = getPtyManifest(handle.id);
  console.log(JSON.stringify({ identity: { spaceId, parentPtyId, parentPid, parentKind }, pid: process.pid }));
  unregisterPty(handle.id);
  process.exit(0);
`;

describe('registry manifest identity', () => {
  test('persists production child identity in the isolated manifest', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'pty-manifest-identity-'));
    try {
      expect(runManifestIdentity(stateDir)).toEqual({
        id: 'identity_1234abcd',
        kind: 'identity',
        ptyPid: 42,
        runId: 'run-manifest-identity',
        spaceId: 'space-manifest-identity',
        sessionId: 'session-manifest-identity',
        parentPtyId: 'parent_1234abcd',
        parentPid: expect.any(Number),
        parentKind: 'pty',
        chainOrigin: 'identity-origin',
        nestDepth: 3,
        originRoot: 'external-agent',
        originAgent: 'codex',
        originSession: 'origin-session',
        controller: 'automation',
        terminalOriginCategory: 'external-tool',
        terminalOriginReason: 'inherited-external-agent-marker',
        externalToolName: 'codex',
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('registry manifest child identity', () => {
  test('uses the registrar PTY and PID when the registrar has no parent PTY', () => {
    const result = withStateDir({
      ELANOUS_PTY_ID: 'pty_reg',
      ELANOUS_PARENT_PTY_ID: undefined,
      ELANOUS_HARNESS_SPACE_ID: undefined,
    }, spawnedIdentity);

    expect(result.identity.parentPtyId).toBe('pty_reg');
    expect(result.identity.parentKind).toBe('pty');
    expect(result.identity.parentPid).toBe(result.pid);
  }, 15_000);

  test('uses the registrar PTY rather than the registrar parent when child parent is absent', () => {
    const result = withStateDir({
      ELANOUS_PTY_ID: 'pty_reg',
      ELANOUS_PARENT_PTY_ID: 'pty_up',
      ELANOUS_HARNESS_SPACE_ID: undefined,
    }, spawnedIdentity);

    expect(result.identity).toEqual({
      spaceId: '',
      parentPtyId: 'pty_reg',
      parentPid: result.pid,
      parentKind: 'pty',
    });
  }, 15_000);

  test('uses explicit child space and parent identity overrides', () => {
    const result = withStateDir({ ELANOUS_PTY_ID: 'pty_reg' }, `
      const handle = startPty({ cmd: 'x', detach: true, env: { ELANOUS_HARNESS_SPACE_ID: 'dev-run-x', ELANOUS_PARENT_PTY_ID: 'pty_given' } });
      const { spaceId, parentPtyId, parentPid, parentKind } = getPtyManifest(handle.id);
      console.log(JSON.stringify({ identity: { spaceId, parentPtyId, parentPid, parentKind }, pid: process.pid }));
      unregisterPty(handle.id);
      process.exit(0);
    `);

    expect(result.identity).toEqual({
      spaceId: 'dev-run-x',
      parentPtyId: 'pty_given',
      parentPid: result.pid,
      parentKind: 'pty',
    });
  }, 15_000);

  test('preserves the registrar space when the child env omits it', () => {
    const result = withStateDir({
      ELANOUS_PTY_ID: 'pty_reg',
      ELANOUS_HARNESS_SPACE_ID: 'reg-space',
    }, spawnedIdentity);

    expect(result.identity.spaceId).toBe('reg-space');
  }, 15_000);

  test('records a valid child nest depth while retaining registrar parentKind', () => {
    expect(childManifestDepth({
      ELANOUS_NEST_DEPTH: undefined,
      ELANOUS_PARENT_PTY_ID: undefined,
      ELANOUS_PTY_ID: undefined,
    }, "{ ELANOUS_NEST_DEPTH: '1' }")).toEqual({ nestDepth: 1, parentKind: 'process' });
  }, 15_000);

  test('prefers a valid child nest depth over the registrar depth', () => {
    expect(childManifestDepth({
      ELANOUS_NEST_DEPTH: '1',
      ELANOUS_PARENT_PTY_ID: undefined,
      ELANOUS_PTY_ID: undefined,
    }, "{ ELANOUS_NEST_DEPTH: '2' }")).toEqual({ nestDepth: 2, parentKind: 'unknown' });
  }, 15_000);

  test('falls back to the registrar nest depth when the child depth is absent', () => {
    expect(childManifestDepth({
      ELANOUS_NEST_DEPTH: '1',
      ELANOUS_PARENT_PTY_ID: undefined,
      ELANOUS_PTY_ID: undefined,
    }, '{}')).toEqual({ nestDepth: 1, parentKind: 'unknown' });
  }, 15_000);

  test.each([
    ['non-numeric', 'abc'],
    ['overflowing', '9'.repeat(309)],
    ['precision-losing', '9007199254740993'],
  ])('falls back to the registrar nest depth when the child depth is %s', (_label, childDepth) => {
    expect(childManifestDepth({
      ELANOUS_NEST_DEPTH: '1',
      ELANOUS_PARENT_PTY_ID: undefined,
      ELANOUS_PTY_ID: undefined,
    }, `{ ELANOUS_NEST_DEPTH: '${childDepth}' }`)).toEqual({ nestDepth: 1, parentKind: 'unknown' });
  }, 15_000);

  test.each(['0', '9007199254740992'])('records exactly representable child nest depth %s', (childDepth) => {
    expect(childManifestDepth({
      ELANOUS_NEST_DEPTH: undefined,
      ELANOUS_PARENT_PTY_ID: undefined,
      ELANOUS_PTY_ID: undefined,
    }, `{ ELANOUS_NEST_DEPTH: '${childDepth}' }`)).toEqual({ nestDepth: Number(childDepth), parentKind: 'process' });
  }, 15_000);

  test('persists a child-only controller', () => {
    expect(childManifestController({ ELANOUS_CONTROLLER: undefined }, "{ ELANOUS_CONTROLLER: 'agent:claude-code' }")).toBe('agent:claude-code');
  }, 15_000);

  test('prefers a child controller over the registrar controller', () => {
    expect(childManifestController({ ELANOUS_CONTROLLER: 'pty:pty_owner' }, "{ ELANOUS_CONTROLLER: 'pty:pty_child_ctl' }")).toBe('pty:pty_child_ctl');
  }, 15_000);

  test('falls back to the registrar controller when the child controller is absent', () => {
    expect(childManifestController({ ELANOUS_CONTROLLER: 'pty:pty_owner' }, '{}')).toBe('pty:pty_owner');
  }, 15_000);

  test('uses registrar depth for an identity-less manifest row', () => {
    const result = withStateDir<{ nestDepth: number; parentKind: string }>({ ELANOUS_NEST_DEPTH: '1' }, `
      upsertPtyManifest({ id: 'identity-less-depth', kind: 'pty', cmd: 'x', startedAt: 0, now: 0 });
      const { nestDepth, parentKind } = getPtyManifest('identity-less-depth');
      console.log(JSON.stringify({ nestDepth, parentKind }));
      process.exit(0);
    `);

    expect(result).toEqual({ nestDepth: 1, parentKind: 'unknown' });
  }, 15_000);

  test('classifies identity-less nested rows without a parent PTY as unknown', () => {
    const result = withStateDir({
      ELANOUS_NEST_DEPTH: '1',
      ELANOUS_PARENT_PTY_ID: undefined,
      ELANOUS_PTY_ID: undefined,
    }, `
      upsertPtyManifest({ id: 'nested-unknown', kind: 'pty', cmd: 'x', startedAt: 0, now: 0 });
      const { spaceId, parentPtyId, parentPid, parentKind } = getPtyManifest('nested-unknown');
      console.log(JSON.stringify({ identity: { spaceId, parentPtyId, parentPid, parentKind }, pid: process.pid }));
      process.exit(0);
    `);

    expect(result.identity.parentPtyId).toBe('');
    expect(result.identity.parentKind).toBe('unknown');
  }, 15_000);

  test('classifies identity-less root rows without a parent PTY as process', () => {
    const result = withStateDir({
      ELANOUS_NEST_DEPTH: undefined,
      ELANOUS_PARENT_PTY_ID: undefined,
      ELANOUS_PTY_ID: undefined,
    }, `
      upsertPtyManifest({ id: 'root-process', kind: 'pty', cmd: 'x', startedAt: 0, now: 0 });
      const { spaceId, parentPtyId, parentPid, parentKind } = getPtyManifest('root-process');
      console.log(JSON.stringify({ identity: { spaceId, parentPtyId, parentPid, parentKind }, pid: process.pid }));
      process.exit(0);
    `);

    expect(result.identity.parentPtyId).toBe('');
    expect(result.identity.parentKind).toBe('process');
  }, 15_000);

  test('classifies identity-supplied parent PTY rows as pty', () => {
    const result = withStateDir({ ELANOUS_NEST_DEPTH: '2' }, `
      upsertPtyManifest({
        id: 'known-parent',
        kind: 'pty',
        cmd: 'x',
        startedAt: 0,
        now: 0,
        identity: { parentPtyId: 'pty_known' },
      });
      const { spaceId, parentPtyId, parentPid, parentKind } = getPtyManifest('known-parent');
      console.log(JSON.stringify({ identity: { spaceId, parentPtyId, parentPid, parentKind }, pid: process.pid }));
      process.exit(0);
    `);

    expect(result.identity.parentPtyId).toBe('pty_known');
    expect(result.identity.parentKind).toBe('pty');
  }, 15_000);
});
