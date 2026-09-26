import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import { renderMirrorList, validateMirrorManifest, type MirrorManifestEntry } from './mirror-manifest.js';

const REPO = join(import.meta.dir, '../..');
const YAML_PATH = join(REPO, 'docker/ref-mirror/ref-mirror.yaml');
const SYNC_PATH = join(REPO, 'docker/ref-mirror/sync.sh');

describe('validateMirrorManifest — only public https mirrors, never secrets', () => {
  test('decision signal: only the public https entry is accepted', () => {
    const entries: MirrorManifestEntry[] = [
      { id: 'hono', upstream: 'https://github.com/honojs/hono' },
      { id: 'x', upstream: 'https://user:tok@github.com/a/b' },
      { id: 'vault', path: '~/Obsidian/vault', localOnly: true },
      { id: 'cfg', path: '~/.elanous/config.json', localOnly: true },
      { id: 'bare' },
    ];
    const { accepted, refused } = validateMirrorManifest(entries);
    expect(accepted.map((e) => e.id)).toEqual(['hono']);
    expect(refused.map((e) => e.id)).toEqual(['x', 'vault', 'cfg', 'bare']);
    expect(refused[0]?.reason).toContain('credential');
    expect(refused[1]?.reason).toContain('forbidden-path');
    expect(refused[2]?.reason).toContain('forbidden-path');
    expect(refused[3]?.reason).toBe('no-source');
  });

  test('id must match ^[a-z0-9][a-z0-9._-]*$', () => {
    const { accepted, refused } = validateMirrorManifest([
      { id: 'Ok', upstream: 'https://github.com/a/b' },
      { id: '9ok.name_1-x', upstream: 'https://github.com/a/b' },
      { id: '', upstream: 'https://github.com/a/b' },
    ]);
    expect(accepted.map((e) => e.id)).toEqual(['9ok.name_1-x']);
    expect(refused.map((e) => e.reason)).toEqual(['bad-id', 'bad-id']);
  });

  test('upstream must be a public https git URL and must not carry a token query', () => {
    const { accepted, refused } = validateMirrorManifest([
      { id: 'git', upstream: 'git://github.com/a/b' },
      { id: 'empty', upstream: 'https://' },
      { id: 'loop', upstream: 'https://127.0.0.1/a/b' },
      { id: 'lan', upstream: 'https://192.168.1.9/a/b.git' },
      { id: 'tok', upstream: 'https://github.com/a/b?token=sekrit' },
      { id: 'at', upstream: 'https://github.com/a/b?access_token=sekrit' },
      { id: 'badq', upstream: 'https://github.com/a/b?%' },
      { id: 'ok', upstream: 'https://github.com/a/b?ref=main' },
    ]);
    expect(accepted.map((e) => e.id)).toEqual(['ok']);
    expect(refused.find((e) => e.id === 'git')?.reason).toBe('upstream-not-https');
    expect(refused.find((e) => e.id === 'empty')?.reason).toBe('upstream-not-https');
    expect(refused.find((e) => e.id === 'loop')?.reason).toBe('upstream-not-public');
    expect(refused.find((e) => e.id === 'lan')?.reason).toBe('upstream-not-public');
    expect(refused.find((e) => e.id === 'tok')?.reason).toBe('token-query');
    expect(refused.find((e) => e.id === 'at')?.reason).toBe('token-query');
    expect(refused.find((e) => e.id === 'badq')?.reason).toBe('token-query');
  });

  test('a single-label host and a non-public IPv6 address are refused', () => {
    const { accepted, refused } = validateMirrorManifest([
      { id: 'label', upstream: 'https://ref-mirror/repo' },
      { id: 'unspec', upstream: 'https://[::]/repo' },
      { id: 'pub', upstream: 'https://github.com/a/b' },
    ]);
    expect(accepted.map((e) => e.id)).toEqual(['pub']);
    expect(refused.find((e) => e.id === 'label')?.reason).toBe('upstream-not-public');
    expect(refused.find((e) => e.id === 'unspec')?.reason).toBe('upstream-not-public');
  });

  test('IPv4-mapped IPv6 hosts are refused with the same private-address rule', () => {
    const { accepted, refused } = validateMirrorManifest([
      { id: 'mapped', upstream: 'https://[::ffff:127.0.0.1]/repo' },
      { id: 'hex', upstream: 'https://[::ffff:7f00:1]/repo' },
      { id: 'lan6', upstream: 'https://[::ffff:192.168.1.9]/repo' },
      { id: 'pub6', upstream: 'https://[::ffff:8.8.8.8]/repo' },
    ]);
    expect(accepted.map((e) => e.id)).toEqual(['pub6']);
    expect(refused.find((e) => e.id === 'mapped')?.reason).toBe('upstream-not-public');
    expect(refused.find((e) => e.id === 'hex')?.reason).toBe('upstream-not-public');
    expect(refused.find((e) => e.id === 'lan6')?.reason).toBe('upstream-not-public');
  });

  test('forbidden home dirs and name tokens are refused with a reason string', () => {
    const homes = ['~/.elanous', '~/.monad', '~/.codex', '~/.grok', '~/.ssh', '~/.config'];
    const tokens = [
      { id: 'notes', path: '~/work/obsidian/x' },
      { id: 'clips', path: '~/work/yt-vault/x' },
      { id: 'db', path: '~/work/app.db' },
      { id: 'sec', path: '~/work/secrets/k' },
      { id: 'cred', path: '~/work/credentials.json' },
    ];
    const entries: MirrorManifestEntry[] = [
      ...homes.map((home, i) => ({ id: `h${i}`, path: `${home}/x`, localOnly: true as const })),
      ...tokens.map((t) => ({ ...t, localOnly: true as const })),
      { id: 'secrets', localOnly: true },
    ];
    const { accepted, refused } = validateMirrorManifest(entries);
    expect(accepted).toEqual([]);
    expect(refused).toHaveLength(entries.length);
    for (const row of refused) expect(row.reason.length).toBeGreaterThan(0);
  });

  test('a path is refused when it resolves into a forbidden home directory', () => {
    const { accepted, refused } = validateMirrorManifest([
      { id: 'dotdot', path: '~/work/../.ssh/id', localOnly: true },
      { id: 'win', path: '~\\work\\..\\.elanous\\config.json', localOnly: true },
      { id: 'ok', path: '~/work/../notes/id', localOnly: true },
    ]);
    expect(accepted.map((e) => e.id)).toEqual(['ok']);
    expect(refused.find((e) => e.id === 'dotdot')?.reason).toContain('forbidden-path');
    expect(refused.find((e) => e.id === 'win')?.reason).toContain('forbidden-path');
  });

  test('localOnly without upstream is a local mirror line', () => {
    const { accepted, refused } = validateMirrorManifest([{ id: 'mine', localOnly: true }]);
    expect(refused).toEqual([]);
    expect(renderMirrorList(accepted)).toBe('mine local');
  });

  test('renderMirrorList writes <id> <upstream|local> lines', () => {
    const { accepted } = validateMirrorManifest([
      { id: 'hono', upstream: 'https://github.com/honojs/hono' },
      { id: 'mine', localOnly: true },
    ]);
    expect(renderMirrorList(accepted)).toBe('hono https://github.com/honojs/hono\nmine local');
  });
});

describe('docker/ref-mirror/ref-mirror.yaml — read-only cluster mirror', () => {
  const docs = parseAllDocuments(readFileSync(YAML_PATH, 'utf8')).map((d) => d.toJS() as {
    kind: string;
    metadata: { name: string; namespace?: string; labels?: Record<string, string> };
    spec?: Record<string, unknown>;
    data?: Record<string, string>;
  });

  test('PVC 50Gi, one-replica infra Deployment, ClusterIP :9418, list ConfigMap', () => {
    const pvc = docs.find((d) => d.kind === 'PersistentVolumeClaim');
    const deploy = docs.find((d) => d.kind === 'Deployment');
    const svc = docs.find((d) => d.kind === 'Service' && d.metadata.name === 'ref-mirror');
    const list = docs.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'ref-mirror-list');
    expect(pvc?.metadata.namespace).toBe('elanous-test');
    const requests = (pvc?.spec as { resources: { requests: { storage: string } } }).resources.requests;
    expect(requests.storage).toBe('50Gi');
    expect(deploy?.metadata.namespace).toBe('elanous-test');
    expect(deploy?.metadata.labels?.['elanous.role']).toBe('infra');
    expect((deploy?.spec as { replicas: number }).replicas).toBe(1);
    const pod = (deploy?.spec as {
      template: { spec: { automountServiceAccountToken: boolean; containers: Array<{ args: string[] }>; volumes?: Array<{ secret?: unknown }> } };
    }).template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.volumes?.some((v) => v.secret)).toBeFalsy();
    const script = pod.containers[0]?.args.join('\n') ?? '';
    expect(script).toContain('git daemon --reuseaddr --base-path=/mirror --informative-errors');
    expect(script).toContain('--disable=receive-pack');
    expect(script).not.toContain('--export-all');
    expect(svc?.spec && (svc.spec as { type: string }).type).toBe('ClusterIP');
    const ports = (svc?.spec as { ports: Array<{ port: number }> }).ports;
    expect(ports[0]?.port).toBe(9418);
    expect(list?.metadata.namespace).toBe('elanous-test');
    expect(list?.data?.['mirrors.txt']).toBeDefined();
  });
});

function configMapSyncScript(): string {
  const docs = parseAllDocuments(readFileSync(YAML_PATH, 'utf8')).map((d) => d.toJS() as {
    kind: string;
    metadata: { name: string };
    data?: Record<string, string>;
  });
  const sync = docs.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'ref-mirror-sync');
  const script = sync?.data?.['sync.sh'];
  if (!script) throw new Error('ref-mirror-sync.data.sync.sh missing');
  return script.endsWith('\n') ? script : `${script}\n`;
}

describe('docker/ref-mirror/sync.sh — continue after one failure, JSON last line', () => {
  test('ConfigMap script matches the canonical file and updates real git refs', () => {
    const embedded = configMapSyncScript();
    expect(embedded).toBe(readFileSync(SYNC_PATH, 'utf8'));

    const root = mkdtempSync(join(tmpdir(), 'ref-mirror-'));
    const upstream = join(root, 'upstream.git');
    const mirror = join(root, 'mirror');
    mkdirSync(mirror);
    spawnSync('git', ['init', '--bare', upstream], { encoding: 'utf8' });
    const work = join(root, 'work');
    spawnSync('git', ['clone', upstream, work], { encoding: 'utf8' });
    writeFileSync(join(work, 'README'), 'hi\n');
    spawnSync('git', ['-C', work, 'add', 'README'], { encoding: 'utf8' });
    spawnSync('git', ['-C', work, 'config', 'user.email', 't@example.com'], { encoding: 'utf8' });
    spawnSync('git', ['-C', work, 'config', 'user.name', 't'], { encoding: 'utf8' });
    spawnSync('git', ['-C', work, 'commit', '-m', 'init'], { encoding: 'utf8' });
    spawnSync('git', ['-C', work, 'push', 'origin', 'HEAD:refs/heads/main'], { encoding: 'utf8' });
    const tip = spawnSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

    const list = join(root, 'mirrors.txt');
    writeFileSync(list, [
      `good ${upstream}`,
      'mine local',
      'bad https://127.0.0.1:1/no/such.git',
      '',
    ].join('\n'));
    const podScript = join(root, 'sync.sh');
    writeFileSync(podScript, embedded);
    chmodSync(podScript, 0o755);
    const first = spawnSync('sh', [podScript, list], {
      encoding: 'utf8',
      env: { ...process.env, MIRROR_ROOT: mirror },
    });
    const line = first.stdout.trim().split('\n').at(-1) ?? '';
    const status = JSON.parse(line) as { ok: boolean; synced: number; failed: string[] };
    expect(status.ok).toBe(false);
    expect(status.synced).toBe(1);
    expect(status.failed).toEqual(['bad']);
    expect(readFileSync(join(mirror, '.last-sync'), 'utf8').trim()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const mirrored = spawnSync('git', ['--git-dir', join(mirror, 'good.git'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim();
    expect(mirrored).toBe(tip);
    expect(readFileSync(join(mirror, 'good.git', 'git-daemon-export-ok'), 'utf8')).toBe('');
    expect(readFileSync(join(mirror, 'mine.git', 'git-daemon-export-ok'), 'utf8')).toBe('');
    const cfg = readFileSync(join(mirror, 'mine.git', 'config'), 'utf8');
    expect(cfg).toContain('bare = true');
    expect(cfg).not.toContain('receive');

    writeFileSync(join(work, 'README'), 'again\n');
    spawnSync('git', ['-C', work, 'commit', '-am', 'again'], { encoding: 'utf8' });
    spawnSync('git', ['-C', work, 'push', 'origin', 'HEAD:refs/heads/main'], { encoding: 'utf8' });
    writeFileSync(list, `good ${upstream}\nmine local\n`);
    const second = spawnSync('sh', [podScript, list], {
      encoding: 'utf8',
      env: { ...process.env, MIRROR_ROOT: mirror },
    });
    const again = JSON.parse(second.stdout.trim().split('\n').at(-1) ?? '') as { ok: boolean; synced: number; failed: string[] };
    expect(again).toEqual({ ok: true, synced: 1, failed: [] });
    const updated = spawnSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const mirroredAgain = spawnSync('git', ['--git-dir', join(mirror, 'good.git'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim();
    expect(updated).not.toBe(tip);
    expect(mirroredAgain).toBe(updated);

    const other = join(root, 'other.git');
    spawnSync('git', ['init', '--bare', other], { encoding: 'utf8' });
    const otherWork = join(root, 'other-work');
    spawnSync('git', ['clone', other, otherWork], { encoding: 'utf8' });
    writeFileSync(join(otherWork, 'README'), 'other\n');
    spawnSync('git', ['-C', otherWork, 'add', 'README'], { encoding: 'utf8' });
    spawnSync('git', ['-C', otherWork, 'config', 'user.email', 't@example.com'], { encoding: 'utf8' });
    spawnSync('git', ['-C', otherWork, 'config', 'user.name', 't'], { encoding: 'utf8' });
    spawnSync('git', ['-C', otherWork, 'commit', '-m', 'other'], { encoding: 'utf8' });
    spawnSync('git', ['-C', otherWork, 'push', 'origin', 'HEAD:refs/heads/main'], { encoding: 'utf8' });
    const otherTip = spawnSync('git', ['-C', otherWork, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

    writeFileSync(list, `good ${other}\n`);
    const retarget = spawnSync('sh', [podScript, list], {
      encoding: 'utf8',
      env: { ...process.env, MIRROR_ROOT: mirror },
    });
    const retargeted = JSON.parse(retarget.stdout.trim().split('\n').at(-1) ?? '') as { ok: boolean; synced: number; failed: string[] };
    expect(retargeted).toEqual({ ok: true, synced: 1, failed: [] });
    const origin = spawnSync('git', ['--git-dir', join(mirror, 'good.git'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
    expect(origin).toBe(other);
    const switched = spawnSync('git', ['--git-dir', join(mirror, 'good.git'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim();
    expect(switched).toBe(otherTip);
    expect(switched).not.toBe(updated);

    writeFileSync(list, 'good local\n');
    const toLocal = spawnSync('sh', [podScript, list], {
      encoding: 'utf8',
      env: { ...process.env, MIRROR_ROOT: mirror },
    });
    const localized = JSON.parse(toLocal.stdout.trim().split('\n').at(-1) ?? '') as { ok: boolean; synced: number; failed: string[] };
    expect(localized).toEqual({ ok: true, synced: 0, failed: [] });
    const leftover = spawnSync('git', ['--git-dir', join(mirror, 'good.git'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    expect(leftover.status).not.toBe(0);
    const oldRef = spawnSync('git', ['--git-dir', join(mirror, 'good.git'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' });
    expect(oldRef.status).not.toBe(0);
    expect(readFileSync(join(mirror, 'good.git', 'config'), 'utf8')).toContain('bare = true');
    expect(readFileSync(join(mirror, 'good.git', 'git-daemon-export-ok'), 'utf8')).toBe('');
    rmSync(root, { recursive: true, force: true });
  });
});
