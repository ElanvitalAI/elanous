import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  listPty,
  resetForTesting,
  setPtyAdapterForTesting,
  type StartOpts,
} from '../../pty-shell/registry.js';
import {
  _resetSshHostsForTesting,
  setSshHostsPathForTesting,
} from '../../ssh/ssh-hosts.js';
import { buildPtyShellStartTool, dispatchPtyShellStart } from './pty.js';

const captured: StartOpts[] = [];

function mockSpawn() {
  return {
    pid: 4242,
    write() {},
    kill() {},
    onData() { return { dispose() {} }; },
    onExit() { return { dispose() {} }; },
  };
}

beforeEach(() => {
  captured.length = 0;
  setPtyAdapterForTesting((opts) => {
    captured.push(opts);
    return mockSpawn();
  });
});

afterEach(() => {
  resetForTesting();
  setPtyAdapterForTesting(null);
  _resetSshHostsForTesting();
});

function withHosts(hosts: Array<{ name: string; host: string; user?: string }>): void {
  const dir = mkdtempSync(joinPath(tmpdir(), 'pty-ssh-hosts-'));
  writeFileSync(joinPath(dir, 'ssh-hosts.json'), JSON.stringify({ hosts }), 'utf-8');
  setSshHostsPathForTesting(joinPath(dir, 'ssh-hosts.json'));
}

/** Error text must stay one physical line: no CR/LF/NEL/LS/PS and no leftover Unicode Cc. */
function expectOneLineNoControls(msg: string): void {
  expect(msg.includes('\n')).toBe(false);
  expect(msg.includes('\r')).toBe(false);
  expect(msg.includes('\u0085')).toBe(false);
  expect(msg.includes('\u2028')).toBe(false);
  expect(msg.includes('\u2029')).toBe(false);
  expect(msg.split(/\r\n|\n|\r|\u0085|\u2028|\u2029/)).toHaveLength(1);
  expect(/[\u0000-\u001F\u007F-\u009F]/.test(msg)).toBe(false);
}

describe('PtyShellStart sshHost', () => {
  test('schema advertises optional sshHost', () => {
    const spec = buildPtyShellStartTool();
    const props = spec.parameters.properties as Record<string, { type?: string }>;
    expect(props.sshHost).toBeDefined();
    expect(props.sshHost.type).toBe('string');
    expect(spec.parameters.required).toEqual(['cmd']);
  });

  test('omitted sshHost keeps local cmd/args spawn', async () => {
    const r = await dispatchPtyShellStart({ cmd: 'sh', args: ['-c', 'echo hi'], yield_time_ms: 1 });
    expect(r.output).toMatch(/^PtyShellStart process_id=pty_/);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.cmd).toBe('sh');
    expect(captured[0]!.args).toEqual(['-c', 'echo hi']);
  });

  test('skills runner shared start path rejects a nested TUI launch before spawn', async () => {
    const previousParent = process.env.ELANOUS_PARENT_PTY_ID;
    const previousDepth = process.env.ELANOUS_NEST_DEPTH;
    process.env.ELANOUS_PARENT_PTY_ID = 'pty-skill-parent';
    process.env.ELANOUS_NEST_DEPTH = '1';
    try {
      const r = await dispatchPtyShellStart({ cmd: 'eln', args: ['chat'], yield_time_ms: 1 });
      expect(r.output).toContain('[TUI 자기중첩 거부]');
      expect(captured).toHaveLength(0);
    } finally {
      if (previousParent === undefined) delete process.env.ELANOUS_PARENT_PTY_ID;
      else process.env.ELANOUS_PARENT_PTY_ID = previousParent;
      if (previousDepth === undefined) delete process.env.ELANOUS_NEST_DEPTH;
      else process.env.ELANOUS_NEST_DEPTH = previousDepth;
    }
  });

  test('known sshHost starts ssh -t <resolved-target> only', async () => {
    withHosts([{ name: 'node-b', host: 'node-b' }]);
    await dispatchPtyShellStart({ cmd: 'sh', sshHost: 'node-b', yield_time_ms: 1 });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.cmd).toBe('ssh');
    expect(captured[0]!.args).toEqual(['-t', 'node-b']);
  });

  test('known sshHost with user resolves user@host', async () => {
    withHosts([{ name: 'mbp', host: 'mbp.tail.ts.net', user: 'user' }]);
    await dispatchPtyShellStart({ cmd: 'sh', sshHost: 'mbp', yield_time_ms: 1 });
    expect(captured[0]!.cmd).toBe('ssh');
    expect(captured[0]!.args).toEqual(['-t', 'user@mbp.tail.ts.net']);
  });

  test('unknown sshHost rejects with known names and does not spawn', async () => {
    withHosts([{ name: 'mba', host: 'mba' }, { name: 'node-b', host: 'node-b' }]);
    const before = listPty().length;
    await expect(dispatchPtyShellStart({ cmd: 'sh', sshHost: 'no-such-box', yield_time_ms: 1 }))
      .rejects.toThrow(/unknown sshHost 'no-such-box' — known: mba, node-b/);
    expect(captured).toHaveLength(0);
    expect(listPty().length).toBe(before);
  });

  test('unknown sshHost with embedded newlines and controls stays one line', async () => {
    withHosts([{ name: 'mba', host: 'mba' }]);
    const cases: Array<{ sshHost: string; escaped: string }> = [
      { sshHost: 'no\nsuch', escaped: 'no\\nsuch' },
      { sshHost: 'no\r\nsuch', escaped: 'no\\r\\nsuch' },
      { sshHost: 'no\tsuch', escaped: 'no\\tsuch' },
      { sshHost: 'no\x07such', escaped: 'no\\x07such' },
      { sshHost: 'no\u0085such', escaped: 'no\\x85such' },
      { sshHost: 'no\u0080such', escaped: 'no\\x80such' },
      { sshHost: 'no\u009fsuch', escaped: 'no\\x9fsuch' },
      { sshHost: 'no\u2028such', escaped: 'no\\u2028such' },
    ];
    for (const { sshHost, escaped } of cases) {
      let err: unknown;
      try {
        await dispatchPtyShellStart({ cmd: 'sh', sshHost, yield_time_ms: 1 });
        throw new Error(`expected reject for ${JSON.stringify(sshHost)}`);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expectOneLineNoControls(msg);
      expect(msg).toBe(`unknown sshHost '${escaped}' — known: mba`);
      expect(captured).toHaveLength(0);
    }
  });

  test('registry host names with control chars stay one line in unknown sshHost error', async () => {
    withHosts([
      { name: 'mba\nbox', host: 'mba' },
      { name: 'msb\r\n1', host: 'node-b' },
      { name: 'mbp\x07', host: 'mbp' },
      { name: 'min\u0085io', host: 'minio' },
      { name: 'c1\u0080lo', host: 'c1lo' },
      { name: 'c1\u009fhi', host: 'c1hi' },
    ]);
    let err: unknown;
    try {
      await dispatchPtyShellStart({ cmd: 'sh', sshHost: 'no-such-box', yield_time_ms: 1 });
      throw new Error('expected reject');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expectOneLineNoControls(msg);
    expect(msg).toBe("unknown sshHost 'no-such-box' — known: mba\\nbox, msb\\r\\n1, mbp\\x07, min\\x85io, c1\\x80lo, c1\\x9fhi");
    expect(captured).toHaveLength(0);
  });

  test('unknown sshHost C1 NEL and C1 bounds leave no raw Cc or Unicode line breaks', async () => {
    withHosts([{ name: 'mba\u0085', host: 'mba' }, { name: 'pad\u0080', host: 'pad' }, { name: 'apc\u009f', host: 'apc' }]);
    const sshHost = 'bad\u0085\u0080\u009f';
    let err: unknown;
    try {
      await dispatchPtyShellStart({ cmd: 'sh', sshHost, yield_time_ms: 1 });
      throw new Error('expected reject');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expectOneLineNoControls(msg);
    expect(msg).toBe("unknown sshHost 'bad\\x85\\x80\\x9f' — known: mba\\x85, pad\\x80, apc\\x9f");
    expect(captured).toHaveLength(0);
  });

  test('requireApproval + sshHost uses the same ssh -t target for approval and spawn', async () => {
    withHosts([{ name: 'node-b', host: 'node-b' }]);
    let prompt: { cmd: string; args?: string[]; cwd?: string } | null = null;
    const r = await dispatchPtyShellStart(
      { cmd: 'sh', args: ['-c', 'echo hi'], sshHost: 'node-b', yield_time_ms: 1 },
      {
        requireApproval: true,
        approver: async (req) => { prompt = req; return true; },
      },
    );
    expect(r.output).toMatch(/^PtyShellStart process_id=pty_/);
    expect(prompt).not.toBeNull();
    expect(prompt!.cmd).toBe('ssh');
    expect(prompt!.args).toEqual(['-t', 'node-b']);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.cmd).toBe(prompt!.cmd);
    expect(captured[0]!.args).toEqual(prompt!.args);
  });

  test('requireApproval deny with sshHost reports spawn cmd and does not spawn', async () => {
    withHosts([{ name: 'node-b', host: 'node-b' }]);
    const before = listPty().length;
    const r = await dispatchPtyShellStart(
      { cmd: 'sh', sshHost: 'node-b', yield_time_ms: 1 },
      { requireApproval: true, approver: async () => false },
    );
    expect(r.output).toContain('denied');
    expect(r.output).toContain('cmd=ssh');
    expect(captured).toHaveLength(0);
    expect(listPty().length).toBe(before);
  });
});
