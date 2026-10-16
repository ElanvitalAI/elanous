#!/usr/bin/env bun
// Run on a host with kubectl access. Each arm launches a real k3d Job; no test seam replaces kubectl.
import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPodCommand } from '../../src/task-orchestrator/surfaces/pod-command-job';
import { PodPoolScheduler, type PodPoolMember } from '../../src/task-orchestrator/surfaces/pod-pool';
import { prepareHostDirsOnce, resetHostDirsPrepMemo } from '../../src/task-orchestrator/surfaces/pod-install-slots';

type Probe = { arm: 'node-prepared' | 'init-fallback'; job: string; exitCode: number; prep: Record<string, unknown> | null;
  hostPaths: string[]; initContainers: string[]; node: string; childWritable: boolean; artifactsError: string | null };

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} required`);
  return value;
}

async function main(): Promise<void> {
  const context = option('context');
  const host = option('host');
  const cluster = option('cluster', 'elanous-pool');
  const image = option('image');
  const namespace = option('namespace', 'elanous-test');
  const cacheBase = option('cache', '/var/lib/elanous/gate-probe-cache');
  const slotsBase = option('slots', '/var/lib/elanous/gate-probe-slots');
  for (const path of [cacheBase, slotsBase]) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.split('/').includes('..')) throw new Error(`unsafe host path: ${path}`);
  }
  const member: PodPoolMember = { context, sshHost: host, k3dCluster: cluster, capacity: 1 };
  const kubectl = (args: readonly string[], input?: string) => {
    const run = spawnSync('kubectl', args, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return { status: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? String(run.error ?? '') };
  };
  const check = kubectl(['--context', context, '-n', namespace, 'get', 'namespace', namespace]);
  if (check.status !== 0) throw new Error(`cluster/namespace unreadable: ${check.stderr.trim()}`);
  const artifactRoot = mkdtempSync(join(tmpdir(), 'gate-host-dirs-live-'));
  const nonce = `${Date.now().toString(36)}-${process.pid}`;
  const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER }).stdout?.trim() || null;
  const results: Probe[] = [];
  try {
    for (const arm of ['node-prepared', 'init-fallback'] as const) {
      const name = `gate-host-dirs-${arm}-${Date.now().toString(36)}`;
      // Distinct absent paths: the fallback arm cannot pass merely because the first arm already chowned its dirs.
      const cache = join(cacheBase, `${arm}-${nonce}`);
      const slots = join(slotsBase, `${arm}-${nonce}`);
      let prep: Record<string, unknown> | null = null;
      let completed = false;
      try {
        const result = await runPodCommand({
          command: ['sh', '-c', 'printf cache-ok > /bun-cache/.host-dir-probe && printf slots-ok > /gate-install-slots/.host-dir-probe && test "$(cat /bun-cache/.host-dir-probe)" = cache-ok && test "$(cat /gate-install-slots/.host-dir-probe)" = slots-ok && rm /bun-cache/.host-dir-probe /gate-install-slots/.host-dir-probe && echo HOST_DIRS_WRITTEN'],
          name,
          namespace, image, imageCommit: null, deadlineSeconds: 120, pollMs: 1_000, statusUnreadableMs: 30_000,
          memoryLimit: '2Gi',
          bunCache: cache, installSlots: slots, env: { NODE_ENV: 'test' }, configHostMirror: () => undefined,
          poolScheduler: new PodPoolScheduler([member]), artifactsRoot: artifactRoot,
          // The exact image was selected by the operator. This probe does not build or sync it.
          syncImages: async () => new Map([[context, { ok: true, action: 'fresh' as const, detail: 'operator-selected image', ms: 0 }]]),
          prepareHostDirs: arm === 'node-prepared'
            ? async (args) => prepareHostDirsOnce(args)
            : async () => ({ host, ok: false, ms: 0, detail: 'forced init fallback probe' }),
          kubectl,
          log: (_category, event, data) => { if (event === 'host-dirs-prep') prep = data; },
        });
        const job = kubectl(['--context', context, '-n', namespace, 'get', 'job', result.job, '-o', 'json']);
        if (job.status !== 0) throw new Error(`applied Job unreadable: ${job.stderr.trim()}`);
        const applied = JSON.parse(job.stdout) as { spec?: { template?: { spec?: {
          initContainers?: Array<{ name: string }>;
          containers?: Array<{ name: string; volumeMounts?: Array<{ name: string; mountPath: string }> }>;
          volumes?: Array<{ name: string; hostPath?: { path: string } }>;
        } } } };
        const podSpec = applied.spec?.template?.spec;
        const childMounts = podSpec?.containers?.find((item) => item.name === 'child')?.volumeMounts ?? [];
        const mountedPath = (name: string, mountPath: string): string | null => {
          if (!childMounts.some((mount) => mount.name === name && mount.mountPath === mountPath)) return null;
          return podSpec?.volumes?.find((volume) => volume.name === name)?.hostPath?.path ?? null;
        };
        const appliedCache = mountedPath('bun-cache', '/bun-cache');
        const appliedSlots = mountedPath('install-slots', '/gate-install-slots');
        if (appliedCache !== cache || appliedSlots !== slots) {
          throw new Error(`applied Job hostPath mismatch: cache=${appliedCache} slots=${appliedSlots}`);
        }
        const pod = kubectl(['--context', context, '-n', namespace, 'get', 'pod', '-l', `job-name=${result.job}`, '-o', 'jsonpath={.items[0].spec.nodeName}']);
        const child = readFileSync(join(result.artifactsDir, 'child.log'), 'utf8');
        results.push({ arm, job: result.job, exitCode: result.exitCode, prep, hostPaths: [appliedCache, appliedSlots],
          initContainers: applied.spec?.template?.spec?.initContainers?.map((item) => item.name) ?? [],
          node: pod.status === 0 ? pod.stdout.trim() : '',
          childWritable: child.includes('HOST_DIRS_WRITTEN'), artifactsError: result.artifacts?.error ?? null });
        completed = true;
      } finally {
        if (completed) {
          const deleted = kubectl(['--context', context, '-n', namespace, 'delete', 'job', name, '--ignore-not-found']);
          if (deleted.status !== 0) throw new Error(`probe Job cleanup failed: ${name}: ${deleted.stderr.trim()}`);
        } else console.error(`probe incomplete; retained Job for triage: ${name}`);
      }
    }
    const [warm, fallback] = results;
    const ok = warm?.prep?.ok === true && warm.initContainers.length === 0 && warm.exitCode === 0 && warm.childWritable && warm.artifactsError === null &&
      fallback?.prep?.ok === false && fallback.initContainers.includes('host-dirs') && fallback.exitCode === 0 && fallback.childWritable && fallback.artifactsError === null &&
      Boolean(warm.node && fallback.node);
    console.log(JSON.stringify({ verdict: ok ? 'pass' : 'fail', measuredAt: new Date().toISOString(), sourceCommit,
      context, namespace, image, results }));
    if (!ok) process.exitCode = 1;
  } finally {
    resetHostDirsPrepMemo();
    rmSync(artifactRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) main().catch((error) => { console.error(String(error)); process.exitCode = 2; });
