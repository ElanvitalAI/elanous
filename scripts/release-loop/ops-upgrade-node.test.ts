import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { runOpsUpgrade } from './ops-upgrade-node.js';
import type { CommandRunner } from './node-verdict.js';

function withContext(input: Record<string, unknown>, check: () => void) {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.7', previousVersion: '0.2.6', ...input },
    outputs: { verify: { outcome: 'ok' }, publish: { outcome: 'ok', tag: 'v0.2.7' } } });
  try { check(); } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
}

const good = { status: 0, stdout: '{"exitCode":0,"installedVersion":"0.2.7"}\n', stderr: '' };
const feedGood = { status: 0, stdout: '{"ok":true,"version":"0.2.7"}\n', stderr: '' };

test('absent and empty opsHosts do not invoke any command, even with an internal feed', () => {
  for (const opsHosts of [undefined, []]) withContext({ opsHosts, internalDist: '/tmp/dist' }, () => {
    expect(runOpsUpgrade(() => { throw new Error('unexpected command'); })).toEqual({ outcome: 'ok', verdict: 'pass', summary: '운영 대상 없음 — 건너뜀', hosts: [] });
  });
});

test('404 affects only its host; next host is attempted and failures retain before/after', () => {
  withContext({ opsHosts: ['node-b', 'local'] }, () => {
    const calls: Array<[string, string[]]> = [];
    const run: CommandRunner = (cmd, args) => {
      calls.push([cmd, args]);
      if (args.join(' ').includes('update') && cmd === 'ssh') return { status: 1, stdout: '', stderr: 'HTTP 404: not found\nmore detail' };
      if (args.join(' ').includes('update')) return good;
      return { status: 0, stdout: cmd === 'ssh' ? '0.2.6 aaaaaaa\n' : calls.filter(([c]) => c === 'elanous').length === 1 ? '0.2.6 bbbbbbb\n' : '0.2.7 ccccccc\n', stderr: '' };
    };
    const result = runOpsUpgrade(run);
    expect(result.outcome).toBe('fail');
    expect(result.hosts).toEqual([
      { host: 'node-b', ok: false, before: '0.2.6 aaaaaaa', after: '', error: '공급원에 판 없음 (404): HTTP 404: not found' },
      { host: 'local', ok: true, before: '0.2.6 bbbbbbb', after: '0.2.7 ccccccc' },
    ]);
    expect(result.summary).toContain('node-b: 공급원에 판 없음');
    expect(calls.filter(([cmd]) => cmd === 'elanous')).toHaveLength(3);
    expect(calls.every(([, args]) => !args.join(' ').includes('--restart'))).toBe(true);
    expect(calls[1]?.[1][1]).toContain('export PATH;');
    expect(calls[1]?.[1][1]).toContain('$HOME/.local/bin:$HOME/.bun/bin:');
  });
});

test('update JSON failure is not accepted even with a zero shell status', () => {
  withContext({ opsHosts: ['local'] }, () => {
    const result = runOpsUpgrade((_cmd, args) => args[0] === 'update'
      ? { status: 0, stdout: '{"exitCode":1,"installedVersion":null,"reason":"HTTP 404: missing"}\n', stderr: '' }
      : { status: 0, stdout: '0.2.6 abc\n', stderr: '' });
    expect(result).toMatchObject({ outcome: 'fail', hosts: [{ host: 'local', ok: false, error: '공급원에 판 없음 (404): HTTP 404: missing' }] });
  });
});

test('successful update with an unchanged reported version fails', () => {
  withContext({ opsHosts: ['local'] }, () => {
    let calls = 0;
    const result = runOpsUpgrade((_cmd, args) => args[0] === 'update' ? good
      : { status: 0, stdout: ++calls === 1 ? '0.2.6 before\n' : '0.2.6 unchanged\n', stderr: '' });
    expect(result).toMatchObject({ outcome: 'fail', hosts: [{ host: 'local', ok: false, before: '0.2.6 before', after: '0.2.6 unchanged', error: expect.stringContaining('올렸는데 판이 그대로') }] });
  });
});

test('internal feed expands a home-relative path before publishing', () => {
  withContext({ opsHosts: ['local'], internalDist: '~/internal-dist' }, () => {
    const calls: Array<[string, string[]]> = [];
    expect(runOpsUpgrade((cmd, args) => {
      calls.push([cmd, args]);
      return cmd === 'bun' ? feedGood : args[0] === 'update' ? good : { status: 0, stdout: '0.2.7 abc\n', stderr: '' };
    }).outcome).toBe('ok');
    expect(calls[0]?.[1].at(-1)).toBe(`${homedir()}/internal-dist`);
  });
});

test('internal feed is published once before remote updates and restart is explicit', () => {
  withContext({ opsHosts: ['local', 'node-b'], internalDist: '/tmp/internal dist', opsRestart: true }, () => {
    const calls: Array<[string, string[]]> = [];
    const result = runOpsUpgrade((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'bun') return feedGood;
      return args.join(' ').includes('--version') && !args.join(' ').includes('update')
        ? { status: 0, stdout: '0.2.7 revised\n', stderr: '' } : good;
    });
    expect(result.outcome).toBe('ok');
    expect(result.hosts.map((host) => host.ok)).toEqual([true, true]);
    expect(calls[0]).toEqual(['bun', ['scripts/publish-internal-dist.ts', '--checkout', process.cwd(), '--out', '/tmp/internal dist']]);
    expect(calls.filter(([cmd]) => cmd === 'bun')).toHaveLength(1);
    expect(calls.filter(([, args]) => args.join(' ').includes('update')).every(([, args]) => args.join(' ').includes('--restart'))).toBe(true);
  });
});

test('internal feed failure with only local target is still reported', () => {
  withContext({ opsHosts: ['local'], internalDist: '/tmp/dist' }, () => {
    const result = runOpsUpgrade((cmd, args) => cmd === 'bun' ? { status: 1, stdout: '', stderr: 'pack failed' }
      : args[0] === 'update' ? good : { status: 0, stdout: '0.2.7 abc\n', stderr: '' });
    expect(result).toMatchObject({ outcome: 'fail', summary: expect.stringContaining('내부 피드 발행 실패'), hosts: [{ host: 'local', ok: true }] });
  });
});

test('failed internal feed skips remotes, continues local and records the feed failure', () => {
  withContext({ opsHosts: ['node-b', 'local', 'msb2'], internalDist: '/tmp/dist' }, () => {
    const calls: Array<[string, string[]]> = [];
    const result = runOpsUpgrade((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'bun') return { status: 1, stdout: '', stderr: 'pack failed\n' };
      return args[0] === 'update' ? good : { status: 0, stdout: '0.2.7 abc\n', stderr: '' };
    });
    expect(calls.map(([cmd]) => cmd)).toEqual(['bun', 'elanous', 'elanous', 'elanous']);
    expect(result.outcome).toBe('fail');
    expect(result.hosts).toEqual([
      { host: 'node-b', ok: false, before: '', after: '', skipped: '내부 피드 발행 실패', error: '내부 피드 발행 실패: pack failed' },
      { host: 'local', ok: true, before: '0.2.7 abc', after: '0.2.7 abc' },
      { host: 'msb2', ok: false, before: '', after: '', skipped: '내부 피드 발행 실패', error: '내부 피드 발행 실패: pack failed' },
    ]);
  });
});

test('remote hosts see the installer bin dir, and opsRestart restarts the hooks receiver where it runs', () => {
  withContext({ opsHosts: ['cloud-vm', 'node-b'], opsRestart: true }, () => {
    const calls: Array<[string, string[]]> = [];
    const result = runOpsUpgrade((cmd, args) => {
      calls.push([cmd, args]);
      const line = args.join(' ');
      if (line.includes('elanous-hooks.service')) return { status: 0, stdout: args[0] === 'cloud-vm' ? 'active\n' : 'absent\n', stderr: '' };
      return line.includes('--version') && !line.includes('update') ? { status: 0, stdout: '0.2.7 revised\n', stderr: '' } : good;
    });
    expect(result.outcome).toBe('ok');
    const updates = calls.filter(([, args]) => args.join(' ').includes(' update '));
    expect(updates.every(([, args]) => args[1]!.startsWith('PATH="$HOME/.local/share/elanous/bin:'))).toBe(true);
    expect(result.hosts.map((h) => [h.host, (h as { hooks?: string }).hooks])).toEqual([['cloud-vm', 'active'], ['node-b', 'absent']]);
  });
});

test('without opsRestart the hooks receiver is not touched', () => {
  withContext({ opsHosts: ['cloud-vm'] }, () => {
    const calls: string[] = [];
    runOpsUpgrade((cmd, args) => { calls.push(args.join(' ')); return args.join(' ').includes('--version') && !args.join(' ').includes('update') ? { status: 0, stdout: '0.2.7 revised\n', stderr: '' } : good; });
    expect(calls.some((c) => c.includes('elanous-hooks.service'))).toBe(false);
  });
});
