import { expect, test, spyOn } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { runOpsUpgrade, tagFeedSource, type FeedSource } from './ops-upgrade-node.js';
import type { CommandRunner } from './node-verdict.js';

function withContext(input: Record<string, unknown>, check: () => void) {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.7', previousVersion: '0.2.6', ...input },
    outputs: { verify: { outcome: 'ok' }, publish: { outcome: 'ok', tag: 'v0.2.7' } } });
  try { check(); } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
}

const good = { status: 0, stdout: '{"exitCode":0,"installedVersion":"0.2.7"}\n', stderr: '' };
const TAG = 'c'.repeat(40);
const feedGood = { status: 0, stdout: `{"ok":true,"version":"0.2.7","commit":"${TAG}"}\n`, stderr: '' };
let cleaned = 0;
const tagSource = (): FeedSource => ({ checkout: '/tmp/tag-tree', commit: TAG, deps: 'linked', cleanup: () => { cleaned++; } });

test('checkout install fetches tag, detaches, then updates without release version', () => {
  withContext({ opsHosts: ['local'], opsRestart: true }, () => {
    const calls: Array<[string, string[], string | undefined]> = [];
    const run: CommandRunner = (cmd, args, cwd) => {
      calls.push([cmd, args, cwd]);
      if (cmd === 'git') return { status: 0, stdout: args[0] === 'rev-parse' ? 'abc123\n' : '', stderr: '' };
      if (args[0] === 'update') return { status: 0, stdout: '{"exitCode":0,"installedVersion":"0.2.7-abcdef123456"}\n', stderr: '' };
      return { status: 0, stdout: calls.filter(([c]) => c === 'elanous').length === 1 ? '0.2.6 old\n' : '0.2.7-abcdef123456 new\n', stderr: '' };
    };
    const result = runOpsUpgrade(run, { installSource: () => '/ops/private-checkout', exists: () => false });
    expect(result).toMatchObject({ outcome: 'ok', feed: 'skipped-no-path', hosts: [{ host: 'local', ok: true, after: '0.2.7-abcdef123456 new' }] });
    expect(calls.filter(([cmd]) => cmd === 'git')).toEqual([
      ['git', ['status', '--porcelain', '--untracked-files=all'], '/ops/private-checkout'],
      ['git', ['fetch', '--tags'], '/ops/private-checkout'],
      ['git', ['rev-parse', '--verify', 'refs/tags/v0.2.7^{commit}'], '/ops/private-checkout'],
      ['git', ['checkout', '--detach', 'v0.2.7'], '/ops/private-checkout'],
    ]);
    expect(calls[5]).toEqual(['elanous', ['update', '--json', '--restart'], undefined]);
  });
});

test('dirty checkout and missing tag fail without running update', () => {
  for (const failure of ['dirty', 'tag']) withContext({ opsHosts: ['local'] }, () => {
    const calls: string[] = [];
    const result = runOpsUpgrade((cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git' && args[0] === 'status' && failure === 'dirty') return { status: 0, stdout: ' M package.json\n', stderr: '' };
      if (cmd === 'git' && args[0] === 'rev-parse' && failure === 'tag') return { status: 1, stdout: '', stderr: 'not a valid tag' };
      return { status: 0, stdout: cmd === 'git' ? '' : '0.2.6 old\n', stderr: '' };
    }, { installSource: () => '/ops/private-checkout', exists: () => false });
    expect(result.outcome).toBe('fail');
    expect(result.hosts[0]?.error).toContain(failure === 'dirty' ? '체크아웃 변경 있음' : '태그 없음');
    expect(calls.some((call) => call.includes(' update '))).toBe(false);
  });
});

test('remote missing nexus service is recorded as no-service only when installed version matches', () => {
  withContext({ opsHosts: ['node-b'], opsRestart: true }, () => {
    let probes = 0;
    const result = runOpsUpgrade((_cmd, args) => args[1]?.includes("'update'")
      ? { status: 1, stdout: '{"exitCode":1,"installedVersion":"0.2.7","reason":"재시작 실패: Could not find service \\"com.elanous.nexus\\" in domain for user gui: 501"}\n', stderr: '' }
      : args[1]?.includes('elanous-hooks.service') ? { status: 0, stdout: 'absent\n', stderr: '' }
      : { status: 0, stdout: ++probes === 1 ? '0.2.6 old\n' : '0.2.7 new\n', stderr: '' }, { exists: () => false });
    expect(result).toMatchObject({ outcome: 'ok', hosts: [{ host: 'node-b', ok: true, restart: 'no-service', after: '0.2.7 new' }] });
  });
  withContext({ opsHosts: ['cloud-vm'], opsRestart: true }, () => {
    const result = runOpsUpgrade((_cmd, args) => args[1]?.includes("'update'")
      ? { status: 1, stdout: '{"exitCode":1,"installedVersion":"0.2.7","reason":"재시작 실패: Unit elanous-nexus.service not found."}\n', stderr: '' }
      : { status: 0, stdout: '0.2.7 new\n', stderr: '' }, { exists: () => false });
    expect(result).toMatchObject({ outcome: 'ok', hosts: [{ host: 'cloud-vm', ok: true, restart: 'no-service' }] });
  });
  withContext({ opsHosts: ['cloud-vm'], opsRestart: true }, () => {
    const result = runOpsUpgrade((_cmd, args) => args[1]?.includes("'update'")
      ? { status: 1, stdout: '{"exitCode":1,"installedVersion":"0.2.7","reason":"재시작 실패: Failed to restart elanous-nexus.service: Unit elanous-nexus.service not found."}\n', stderr: '' }
      : { status: 0, stdout: '0.2.7 new\n', stderr: '' }, { exists: () => false });
    expect(result).toMatchObject({ outcome: 'ok', hosts: [{ host: 'cloud-vm', ok: true, restart: 'no-service' }] });
  });
  withContext({ opsHosts: ['node-b'], opsRestart: true }, () => {
    const result = runOpsUpgrade((_cmd, args) => args[1]?.includes("'update'")
      ? { status: 1, stdout: '{"exitCode":1,"installedVersion":"0.2.6","reason":"재시작 실패: Could not find service \\"com.elanous.nexus\\" in domain for user gui: 501"}\n', stderr: '' }
      : { status: 0, stdout: '0.2.6 old\n', stderr: '' }, { exists: () => false });
    expect(result).toMatchObject({ outcome: 'fail', hosts: [{ host: 'node-b', ok: false, error: expect.stringContaining('설치판 불일치') }] });
  });
});

test('unrelated restart not-found errors remain failures even if the installed version matches', () => {
  for (const message of ['not found', 'Could not find service', 'Could not find service "com.elanous.relay" in domain for user gui: 501', 'Unit unrelated.service not found.', 'binary not found', 'binary not found; Unit elanous-nexus.service not found']) {
    withContext({ opsHosts: ['node-b'], opsRestart: true }, () => {
      const result = runOpsUpgrade((_cmd, args) => args[1]?.includes("'update'")
        ? { status: 1, stdout: JSON.stringify({ exitCode: 1, installedVersion: '0.2.7', reason: `재시작 실패: ${message}` }), stderr: '' }
        : { status: 0, stdout: '0.2.7 new\n', stderr: '' }, { exists: () => false });
      expect(result).toMatchObject({ outcome: 'fail', hosts: [{ host: 'node-b', ok: false, error: `재시작 실패: ${message}` }] });
      expect(result.hosts[0]?.restart).toBeUndefined();
    });
  }
});

test('verify must pass before any host or feed command', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.7', previousVersion: '0.2.6', opsHosts: ['local'], internalDist: '/tmp/feed' }, outputs: { verify: { outcome: 'fail' }, publish: { tag: 'v0.2.7' } } });
  try {
    expect(() => runOpsUpgrade(() => { throw new Error('host changed before verify'); })).toThrow('verify must pass before ops upgrade');
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
});

test('default feed is published if present; missing feed path is reported', () => {
  withContext({ opsHosts: ['node-b'] }, () => {
    const calls: Array<[string, string[]]> = [];
    const result = runOpsUpgrade((cmd, args) => {
      calls.push([cmd, args]);
      return cmd === 'bun' ? feedGood : args.join(' ').includes('update') ? good : { status: 0, stdout: '0.2.7 new\n', stderr: '' };
    }, { exists: (path) => path === `${homedir()}/.local/share/elanous-ops/internal-dist`, feedSource: tagSource });
    expect(result.feed).toBe('published');
    expect(calls[0]).toEqual(['bun', ['scripts/publish-internal-dist.ts', '--checkout', '/tmp/tag-tree', '--out', `${homedir()}/.local/share/elanous-ops/internal-dist`]]);
    expect(result.outcome).toBe('ok');
  });
  withContext({ opsHosts: ['node-b'] }, () => {
    const result = runOpsUpgrade((_cmd, args) => args.join(' ').includes('update') ? good : { status: 0, stdout: '0.2.7 new\n', stderr: '' }, { exists: () => false });
    expect(result.feed).toBe('skipped-no-path');
  });
});

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
    const result = runOpsUpgrade(run, { installSource: () => null, exists: () => false });
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
      : { status: 0, stdout: '0.2.6 abc\n', stderr: '' }, { installSource: () => null, exists: () => false });
    expect(result).toMatchObject({ outcome: 'fail', hosts: [{ host: 'local', ok: false, error: '공급원에 판 없음 (404): HTTP 404: missing' }] });
  });
});

test('successful update with an unchanged reported version fails', () => {
  withContext({ opsHosts: ['local'] }, () => {
    let calls = 0;
    const result = runOpsUpgrade((_cmd, args) => args[0] === 'update' ? good
      : { status: 0, stdout: ++calls === 1 ? '0.2.6 before\n' : '0.2.6 unchanged\n', stderr: '' }, { installSource: () => null, exists: () => false });
    expect(result).toMatchObject({ outcome: 'fail', hosts: [{ host: 'local', ok: false, before: '0.2.6 before', after: '0.2.6 unchanged', error: expect.stringContaining('올렸는데 판이 그대로') }] });
  });
});

test('internal feed expands a home-relative path before publishing', () => {
  withContext({ opsHosts: ['local'], internalDist: '~/internal-dist' }, () => {
    const calls: Array<[string, string[]]> = [];
    expect(runOpsUpgrade((cmd, args) => {
      calls.push([cmd, args]);
      return cmd === 'bun' ? feedGood : args[0] === 'update' ? good : { status: 0, stdout: '0.2.7 abc\n', stderr: '' };
    }, { installSource: () => null, feedSource: tagSource }).outcome).toBe('ok');
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
    }, { installSource: () => null, feedSource: tagSource });
    expect(result.outcome).toBe('ok');
    expect(result.hosts.map((host) => host.ok)).toEqual([true, true]);
    expect(calls[0]).toEqual(['bun', ['scripts/publish-internal-dist.ts', '--checkout', '/tmp/tag-tree', '--out', '/tmp/internal dist']]);
    expect(calls.filter(([cmd]) => cmd === 'bun')).toHaveLength(1);
    expect(calls.filter(([cmd, args]) => cmd === 'ssh' && args[1]?.includes("'update'")).every(([, args]) => !args[1]?.includes("'--version'"))).toBe(true);
    expect(calls.filter(([, args]) => args.join(' ').includes('update')).every(([, args]) => args.join(' ').includes('--restart'))).toBe(true);
  });
});

test('internal feed failure with only local target is still reported', () => {
  withContext({ opsHosts: ['local'], internalDist: '/tmp/dist' }, () => {
    const result = runOpsUpgrade((cmd, args) => cmd === 'bun' ? { status: 1, stdout: '', stderr: 'pack failed' }
      : args[0] === 'update' ? good : { status: 0, stdout: '0.2.7 abc\n', stderr: '' }, { installSource: () => null, feedSource: tagSource });
    expect(result).toMatchObject({ outcome: 'fail', feed: 'failed', summary: expect.stringContaining('내부 피드 발행 실패'), hosts: [{ host: 'local', ok: true }] });
  });
});

test('failed internal feed skips remotes, continues local and records the feed failure', () => {
  withContext({ opsHosts: ['node-b', 'local', 'msb2'], internalDist: '/tmp/dist' }, () => {
    const calls: Array<[string, string[]]> = [];
    const result = runOpsUpgrade((cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'bun') return { status: 1, stdout: '', stderr: 'pack failed\n' };
      return args[0] === 'update' ? good : { status: 0, stdout: '0.2.7 abc\n', stderr: '' };
    }, { installSource: () => null, feedSource: tagSource });
    expect(calls.map(([cmd]) => cmd)).toEqual(['bun', 'elanous', 'elanous', 'elanous']);
    expect(result.outcome).toBe('fail');
    expect(result.feed).toBe('failed');
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
    }, { exists: () => false, installSource: () => null });
    expect(result.outcome).toBe('ok');
    const updates = calls.filter(([, args]) => args.join(' ').includes(' update '));
    expect(updates.every(([, args]) => args[1]!.startsWith('PATH="$HOME/.local/share/elanous/bin:'))).toBe(true);
    expect(result.hosts.map((h) => [h.host, (h as { hooks?: string }).hooks])).toEqual([['cloud-vm', 'active'], ['node-b', 'absent']]);
  });
});

test('without opsRestart the hooks receiver is not touched', () => {
  withContext({ opsHosts: ['cloud-vm'] }, () => {
    const calls: string[] = [];
    runOpsUpgrade((cmd, args) => { calls.push(args.join(' ')); return args.join(' ').includes('--version') && !args.join(' ').includes('update') ? { status: 0, stdout: '0.2.7 revised\n', stderr: '' } : good; }, { exists: () => false, installSource: () => null });
    expect(calls.some((c) => c.includes('elanous-hooks.service'))).toBe(false);
  });
});

test('feed is packed from the release tag checkout, not the working tree, and carries the tag commit (10-04 0.2.11)', () => {
  withContext({ opsHosts: ['node-b'], internalDist: '/tmp/dist' }, () => {
    const calls: Array<[string, string[], string | undefined]> = [];
    const run: CommandRunner = (cmd, args, cwd) => {
      calls.push([cmd, args, cwd]);
      if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${TAG}\n`, stderr: '' };
      // A real tag checkout has apps/pwa — without it the feed's PWA node_modules link fails on hosts that have one (0.2.12 gate Pod).
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(join(args[3]!, 'apps/pwa'), { recursive: true });
        for (const file of ['bun.lock', 'package.json', 'apps/pwa/bun.lock', 'apps/pwa/package.json'])
          writeFileSync(join(args[3]!, file), readFileSync(join(process.cwd(), file)));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'bun' && args[0] === 'bin/elanous.mjs') return { status: 0, stdout: 'built\n', stderr: '' };
      if (cmd === 'bun') return feedGood;
      return args.join(' ').includes('update') ? good : { status: 0, stdout: '0.2.7 new\n', stderr: '' };
    };
    const result = runOpsUpgrade(run, { feedSource: tagFeedSource(run, process.cwd()) });
    expect(result).toMatchObject({ outcome: 'ok', feed: 'published' });
    expect(calls).toContainEqual(['git', ['rev-parse', '--verify', 'refs/tags/v0.2.7^{commit}'], process.cwd()]);
    const pack = calls.find(([cmd, args]) => cmd === 'bun' && args[0] === 'scripts/publish-internal-dist.ts')!;
    const tree = pack[1][2]!;
    expect(tree).not.toBe(process.cwd());
    expect(calls).toContainEqual(['git', ['worktree', 'add', '--detach', tree, TAG], process.cwd()]);
    expect(calls.findIndex(([cmd, args]) => cmd === 'bun' && args.join(' ') === 'bin/elanous.mjs nexus build'))
      .toBeLessThan(calls.indexOf(pack));
    expect(calls).toContainEqual(['git', ['worktree', 'remove', '--force', tree], process.cwd()]);
    expect(existsSync(tree)).toBe(false);
  });
});

test('feed-source observation records linked or installed dependencies', () => {
  for (const deps of ['linked', 'installed'] as const) withContext({ opsHosts: ['node-b'], internalDist: '/tmp/dist' }, () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = runOpsUpgrade((_cmd, args) => args[0] === 'scripts/publish-internal-dist.ts' ? feedGood
        : args.join(' ').includes('update') ? good : { status: 0, stdout: '0.2.7 new\n', stderr: '' },
      { feedSource: () => ({ ...tagSource(), deps }) });
      expect(result.feed).toBe('published');
      expect(log.mock.calls.some(([category, event, data]) => category === 'release-loop.ops-upgrade'
        && event === 'feed-source' && (data as { deps?: string }).deps === deps)).toBe(true);
    } finally { log.mockRestore(); }
  });
});

test('tag feed links matching dependencies and installs differing locks or manifests before building', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ops-feed-deps-test-'));
  const files = ['bun.lock', 'package.json', 'apps/pwa/bun.lock', 'apps/pwa/package.json'];
  try {
    mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
    mkdirSync(join(repo, 'node_modules'));
    mkdirSync(join(repo, 'apps/pwa/node_modules'));
    for (const file of files) writeFileSync(join(repo, file), file.endsWith('package.json') ? '{"dependencies":{"x":"1"}}' : 'lock-v1');
    for (const changed of [undefined, 'bun.lock', 'apps/pwa/bun.lock', 'package.json', 'apps/pwa/package.json',
      'package.json:overrides', 'package.json:trustedDependencies', 'apps/pwa/package.json:overrides']) {
      const calls: Array<[string, string[], string | undefined]> = [];
      let tree = '';
      const [changedFile, changedField] = changed?.split(':') ?? [];
      const run: CommandRunner = (cmd, args, cwd) => {
        calls.push([cmd, args, cwd]);
        if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${TAG}\n`, stderr: '' };
        if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
          tree = args[3]!;
          mkdirSync(join(tree, 'apps/pwa'), { recursive: true });
          for (const file of files) writeFileSync(join(tree, file), file === changedFile
            ? changedField ? JSON.stringify({ dependencies: { x: '1' }, [changedField]: changedField === 'overrides' ? { x: '2' } : ['x'] })
              : file.endsWith('package.json') ? '{"dependencies":{"x":"2"}}' : 'lock-v2'
            : readFileSync(join(repo, file)));
        }
        if (cmd === 'bun' && args[0] === 'install') mkdirSync(join(cwd!, 'node_modules'));
        return { status: 0, stdout: '', stderr: '' };
      };
      const source = tagFeedSource(run, repo)('0.2.7');
      try {
        expect(source.deps).toBe(changed ? 'installed' : 'linked');
        expect(calls.filter(([cmd, args]) => cmd === 'bun' && args[0] === 'install'))
          .toEqual(changed ? [
            ['bun', ['install', '--frozen-lockfile'], tree],
            ['bun', ['install', '--frozen-lockfile'], join(tree, 'apps/pwa')],
          ] : []);
        if (changed) {
          expect(lstatSync(join(tree, 'node_modules')).isDirectory()).toBe(true);
          expect(lstatSync(join(tree, 'apps/pwa/node_modules')).isDirectory()).toBe(true);
        } else {
          expect(lstatSync(join(tree, 'node_modules')).isSymbolicLink()).toBe(true);
          expect(lstatSync(join(tree, 'apps/pwa/node_modules')).isSymbolicLink()).toBe(true);
        }
        expect(calls.at(-1)).toEqual(['bun', ['bin/elanous.mjs', 'nexus', 'build'], tree]);
      } finally { source.cleanup(); }
      expect(existsSync(tree)).toBe(false);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('failed tag dependency install fails the feed, skips remotes and preserves local upgrade', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ops-feed-install-fail-'));
  try {
    mkdirSync(join(repo, 'apps/pwa'), { recursive: true });
    for (const file of ['bun.lock', 'apps/pwa/bun.lock']) writeFileSync(join(repo, file), 'main-lock');
    for (const file of ['package.json', 'apps/pwa/package.json']) writeFileSync(join(repo, file), '{}');
    withContext({ opsHosts: ['node-b', 'local'], internalDist: '/tmp/dist' }, () => {
      const calls: Array<[string, string[], string | undefined]> = [];
      let tree = '';
      const run: CommandRunner = (cmd, args, cwd) => {
        calls.push([cmd, args, cwd]);
        if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${TAG}\n`, stderr: '' };
        if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
          tree = args[3]!;
          mkdirSync(join(tree, 'apps/pwa'), { recursive: true });
          for (const file of ['package.json', 'apps/pwa/package.json']) writeFileSync(join(tree, file), '{}');
          writeFileSync(join(tree, 'bun.lock'), 'tag-lock');
          writeFileSync(join(tree, 'apps/pwa/bun.lock'), 'main-lock');
        }
        if (cmd === 'bun' && args[0] === 'install') {
          mkdirSync(join(cwd!, 'node_modules'));
          return { status: 1, stdout: '', stderr: 'install failed' };
        }
        return args[0] === 'update' ? good : { status: 0, stdout: '0.2.7 abc\n', stderr: '' };
      };
      const result = runOpsUpgrade(run, { feedSource: tagFeedSource(run, repo), installSource: () => null });
      expect(result).toMatchObject({ outcome: 'fail', feed: 'failed', hosts: [
        { host: 'node-b', ok: false, skipped: '내부 피드 발행 실패', error: expect.stringContaining('태그 의존성 설치 실패: install failed') },
        { host: 'local', ok: true },
      ] });
      expect(calls.filter(([cmd]) => cmd === 'bun')).toEqual([['bun', ['install', '--frozen-lockfile'], tree]]);
      expect(calls.filter(([cmd]) => cmd === 'ssh')).toHaveLength(0);
      expect(calls.filter(([cmd, args]) => cmd === 'elanous' && args[0] === 'update')).toHaveLength(1);
      expect(calls).toContainEqual(['git', ['worktree', 'remove', '--force', tree], repo]);
      expect(existsSync(tree)).toBe(false);
    });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('feed refuses a tag that is not the release cut, or a pack that is not the tag commit', () => {
  const prior = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.7', previousVersion: '0.2.6', opsHosts: ['node-b'], internalDist: '/tmp/dist' },
      outputs: { verify: { outcome: 'ok' }, publish: { outcome: 'ok', tag: 'v0.2.7' }, 'version-release': { outcome: 'ok', commit: 'd'.repeat(40) } } });
    const before = cleaned;
    const calls: string[] = [];
    const result = runOpsUpgrade((cmd, args) => { calls.push(cmd); return cmd === 'bun' ? feedGood : good; }, { feedSource: tagSource });
    expect(result).toMatchObject({ outcome: 'fail', feed: 'failed', summary: expect.stringContaining('컷') });
    expect(calls).not.toContain('bun');
    expect(cleaned).toBe(before + 1);
  } finally { if (prior === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = prior; }
  withContext({ opsHosts: ['node-b'], internalDist: '/tmp/dist' }, () => {
    const result = runOpsUpgrade((cmd) => cmd === 'bun' ? { status: 0, stdout: `{"ok":true,"version":"0.2.7","commit":"${'e'.repeat(40)}"}\n`, stderr: '' } : good, { feedSource: tagSource });
    expect(result).toMatchObject({ outcome: 'fail', feed: 'failed', summary: expect.stringContaining('≠ 태그') });
  });
});
