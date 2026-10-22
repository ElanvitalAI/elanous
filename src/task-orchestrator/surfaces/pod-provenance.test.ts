import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podProvenanceMetadata } from './pod-provenance.js';
import { podCommandJobManifest, runPodCommand } from './pod-command-job.js';

const identity = { actorKind: 'seat', actor: 'OPC', kind: 'gate-shard', run: '92e9c344-a-long-run-id',
  phase: 'release-gate', requestedAt: '2026-10-20T09:19:46Z', character: 'gate-shard-runner',
  cell: 'GATE-SHARD-FAILURE-CAPTURE', reason: 'triage token=secret123456',
  argv: 'bash -lc --token=secret123456' };

describe('Pod launch provenance', () => {
  test('Job and Pod carry searchable labels, redacted annotations, and child env', () => {
    const job = podCommandJobManifest({ name: 'gate-1', namespace: 'elanous-test', image: 'harness',
      repoUrl: 'repo', command: ['true'], skills: [], deadlineSeconds: 60, provenance: identity });
    const meta = job.metadata as { labels: Record<string, string>; annotations: Record<string, string> };
    const template = (job.spec as { template: { metadata: typeof meta; spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } }).template;
    expect(meta.labels['elanous.ai/actor']).toBe('opc');
    expect(template.metadata.labels['elanous.ai/run']).toBe('92e9c344');
    expect(template.metadata.labels['elanous.ai/cell']).toBe('gate-shard-failure-capture');
    expect(meta.annotations['elanous.ai/run']).toBe(identity.run);
    expect(template.spec.containers[0]!.env).toContainEqual({ name: 'ELANOUS_POD_RUN', value: identity.run });
    expect(JSON.stringify(job)).not.toContain('secret123456');
  });

  test('a command Job exposes an unknown reason when the caller has none', () => {
    const job = podCommandJobManifest({ name: 'command-1', namespace: 'elanous-test', image: 'harness',
      repoUrl: 'repo', command: ['true'], skills: [], deadlineSeconds: 60,
      provenance: { actorKind: 'seat', actor: 'OPC', kind: 'command', run: 'run-1', phase: 'exec', requestedAt: '2026-10-20T09:19:46Z' } });
    const meta = job.metadata as { annotations: Record<string, string> };
    const container = (job.spec as { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } }).template.spec.containers[0]!;
    expect(meta.annotations['elanous.ai/reason']).toBe('unknown');
    expect(container.env).toContainEqual({ name: 'ELANOUS_POD_REASON', value: 'unknown' });
  });

  test('missing required fields refuse a non-gate Job before kubectl', async () => {
    let calls = 0;
    await expect(runPodCommand({ command: ['true'], provenance: { actorKind: 'seat', actor: 'OPC' },
      kubectl: () => { calls++; return { status: 0, stdout: '', stderr: '' }; } })).rejects.toThrow('pod provenance missing');
    expect(calls).toBe(0);
  });

  test('direct manifest creation refuses missing identity', () => {
    expect(() => podCommandJobManifest({ name: 'missing', namespace: 'elanous-test', image: 'harness',
      repoUrl: 'repo', command: ['true'], skills: [], deadlineSeconds: 60 })).toThrow('pod provenance missing');
  });

  test('a generic command cannot claim the gate unknown exception', async () => {
    let calls = 0;
    await expect(runPodCommand({ command: ['true'], provenanceGate: true,
      provenance: { actorKind: 'loop', kind: 'command' },
      kubectl: () => { calls++; return { status: 0, stdout: '', stderr: '' }; } })).rejects.toThrow('gate exception requires');
    expect(calls).toBe(0);
  });

  test('an unconfigured shard entrance cannot claim the gate unknown exception', async () => {
    const previousEntrance = process.env.ELANOUS_RELEASE_ENTRANCE;
    delete process.env.ELANOUS_RELEASE_ENTRANCE;
    let calls = 0;
    try {
      await expect(runPodCommand({ command: ['true'], provenanceGate: true,
        provenance: { actorKind: 'loop', kind: 'gate-shard', entrance: 'unconfigured-entry' },
        clone: true, source: { kind: 'commit', sha: 'a'.repeat(40) },
        kubectl: () => { calls++; return { status: 0, stdout: '', stderr: '' }; } })).rejects.toThrow('gate exception requires');
      expect(calls).toBe(0);
    } finally {
      if (previousEntrance === undefined) delete process.env.ELANOUS_RELEASE_ENTRANCE;
      else process.env.ELANOUS_RELEASE_ENTRANCE = previousEntrance;
    }
  });

  test('the fake kubectl apply receives the same identity as the command child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-provenance-'));
    let applied: Record<string, unknown> | undefined;
    try {
      const result = await runPodCommand({ command: ['true'], provenance: identity, name: 'prov-test',
        imageCommit: null, env: {}, configHostMirror: () => undefined, artifactsRoot: root,
        kubectl: (args, stdin) => {
          if (args[0] === 'apply') applied = JSON.parse(stdin ?? '{}') as Record<string, unknown>;
          return { status: 0, stdout: args.includes('logs') ? 'child-ok\n' : args.includes('get') ? 'Complete' : '', stderr: '' };
        },
      });
      expect(result.exitCode).toBe(0);
      const jobMeta = applied?.metadata as { labels: Record<string, string> };
      const template = (applied?.spec as { template: { metadata: { labels: Record<string, string> }; spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } }).template;
      expect(jobMeta.labels['elanous.ai/phase']).toBe('release-gate');
      expect(template.metadata.labels['elanous.ai/actor']).toBe('opc');
      expect(template.spec.containers[0]!.env).toContainEqual({ name: 'ELANOUS_POD_CHARACTER', value: 'gate-shard-runner' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a release gate records unknown fields and reports exactly which fields were absent', () => {
    const meta = podProvenanceMetadata({ actorKind: 'loop', kind: 'gate-shard' }, true);
    expect(meta.missing).toEqual(['actor', 'run', 'phase', 'requested-at']);
    expect(meta.labels['elanous.ai/actor']).toBe('unknown');
    expect(meta.annotations['elanous.ai/requested-at']).toBe('unknown');
  });

  test('a gate Job applies unknown provenance and logs missing fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-gate-provenance-'));
    const previousEntrance = process.env.ELANOUS_RELEASE_ENTRANCE;
    process.env.ELANOUS_RELEASE_ENTRANCE = 'custom-release-entry';
    let applied: Record<string, unknown> | undefined;
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    try {
      const result = await runPodCommand({ command: ['true'], provenanceGate: true,
        provenance: { actorKind: 'loop', kind: 'gate-shard', entrance: 'custom-release-entry' },
        source: { kind: 'commit', sha: 'a'.repeat(40) }, clone: true, name: 'gate-prov-test',
        imageCommit: null, ghToken: () => 'test-token', env: {}, configHostMirror: () => undefined, artifactsRoot: root,
        log: (category, event, data) => { events.push({ category, event, data }); },
        kubectl: (args, stdin) => {
          if (args[0] === 'apply') applied = JSON.parse(stdin ?? '{}') as Record<string, unknown>;
          return { status: 0, stdout: args.includes('logs') ? 'child-ok\n' : args.includes('get') ? 'Complete' : '', stderr: '' };
        },
      });
      expect(result.exitCode).toBe(0);
      expect(events).toContainEqual({ category: 'pod.provenance', event: 'missing-gate-fields',
        data: { missing: ['actor', 'run', 'phase', 'requested-at'] } });
      const jobMeta = applied?.metadata as { labels: Record<string, string> };
      const template = (applied?.spec as { template: { metadata: { labels: Record<string, string> } } }).template;
      expect(jobMeta.labels['elanous.ai/actor']).toBe('unknown');
      expect(template.metadata.labels['elanous.ai/run']).toBe('unknown');
    } finally {
      if (previousEntrance === undefined) delete process.env.ELANOUS_RELEASE_ENTRANCE;
      else process.env.ELANOUS_RELEASE_ENTRANCE = previousEntrance;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
