import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Kubectl } from './self-implement-pod.js';
import type { WarmWorkerCommand, WarmWorkerReply } from './pod-warm-worker-protocol.js';
import { WarmPodTransport, warmWorkerPodManifest, WARM_POD_ACK, WARM_POD_EXEC, WARM_POD_INSTALL, WARM_POD_ISOLATION_PROBE, WARM_POD_PREPARE, WARM_POD_READ, type WarmPodSpec } from './pod-warm-worker-pod.js';

const cutSha = 'a'.repeat(40);
const key = { context: 'pool-node-b', imageDigest: `sha256:${'b'.repeat(64)}`, lockHash: 'c'.repeat(64), architecture: 'amd64' };
const spec: WarmPodSpec = { name: 'warm-worker-1', namespace: 'elanous-test', kubectlContext: 'node-b',
  workerId: 'worker-1', image: `registry.example/elanous@${key.imageDigest}`,
  sourceUrl: 'https://github.com/ElanvitalAI/elanous.git', cutSha, key,
  hostProbeUrl: 'http://host.orb.internal:10001/health', prodProbeUrl: 'http://core.elanous-prod:10002/' };
const command = (attemptId: string): WarmWorkerCommand => ({ protocol: 1, runId: 'run-1', attemptId,
  cutSha, leaseId: 'lease-1', generation: 1, workerId: 'worker-1', key,
  deadlineAt: Date.now() + 60_000, files: ['src/example/worker.test.ts'], envProfile: 'gate-v1' });
const reply = (request: WarmWorkerCommand): WarmWorkerReply => ({ protocol: 1, runId: request.runId,
  attemptId: request.attemptId, cutSha: request.cutSha, leaseId: request.leaseId, generation: request.generation,
  workerId: request.workerId, key: request.key, envProfile: request.envProfile,
  startedAt: Date.now(), finishedAt: Date.now(), files: request.files.map(file => ({
    file, rc: 0, failureIds: [], errorIds: [], junitComplete: true,
  })) });
const artifactsDir = (request: WarmWorkerCommand) => `/workspace/data/artifacts/${[
  request.runId, request.attemptId, request.leaseId, String(request.generation), request.workerId,
].join('/')}`;
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const artifacts = (request: WarmWorkerCommand) => {
  const file = request.files[0]!;
  const junit = `<testsuites tests="1"><testsuite name="${file}" file="${file}" tests="1"><testcase name="works" file="${file}"/></testsuite></testsuites>`;
  const log = `[warm-worker] file=${file}\n[warm-worker] cut=${request.cutSha} attempt=${request.attemptId}\nbun test v1.0.0\n${file}:\n(pass) works\n1 pass\n0 fail\n0 errors\nRan 1 test across 1 file.\n[warm-worker] junit-sha256=${sha256(junit)}\n`;
  const meta = JSON.stringify({ rc: 0, files: [file], commit: request.cutSha, attemptId: request.attemptId,
    warmKey: request.key, jobExitCode: 0, jobFailed: false });
  const rc = '0';
  const manifest = JSON.stringify({ protocol: 1, cutSha: request.cutSha, attemptId: request.attemptId,
    file, rc: 0, logSha256: sha256(log), junitSha256: sha256(junit), metaSha256: sha256(meta), rcSha256: sha256(rc) });
  return { log, 'junit.xml': junit, json: meta, 'warm-manifest.json': manifest, rc };
};
const artifactHashes = (request: WarmWorkerCommand) => [Object.fromEntries(
  Object.entries(artifacts(request)).map(([name, content]) => [name, sha256(content)]))];
const pod = (uid = 'pod-uid-1') => {
  const manifest = warmWorkerPodManifest(spec) as any;
  const admittedDefaults = (container: any) => ({ ...container, resources: {},
    terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File' });
  // These defaults were observed in pool-node-b server-side dry-run on 2026-10-16; no Pod was created.
  return { metadata: { name: spec.name, namespace: spec.namespace, uid, annotations: manifest.metadata.annotations },
    spec: { ...manifest.spec, nodeName: 'node-1', containers: manifest.spec.containers.map(admittedDefaults),
      initContainers: manifest.spec.initContainers.map(admittedDefaults),
      serviceAccount: 'default', serviceAccountName: 'default', schedulerName: 'default-scheduler',
      terminationGracePeriodSeconds: 30, preemptionPolicy: 'PreemptLowerPriority', priority: 0,
      tolerations: [{ effect: 'NoExecute', key: 'node.kubernetes.io/not-ready', operator: 'Exists', tolerationSeconds: 300 },
        { effect: 'NoExecute', key: 'node.kubernetes.io/unreachable', operator: 'Exists', tolerationSeconds: 300 }],
    }, status: { phase: 'Running', containerStatuses: [{ name: 'worker', ready: true }] } };
};
const node = () => ({ metadata: { name: 'node-1', labels: { 'kubernetes.io/arch': key.architecture } } });
const admissionFieldOrder = (value: any): any => Array.isArray(value) ? value.map(admissionFieldOrder)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse()
    .map(([name, item]) => [name, admissionFieldOrder(item)])) : value;
const getResult = (args: readonly string[], uid?: string) => ({ status: 0,
  stdout: JSON.stringify(args.includes('node') ? node() : admissionFieldOrder(pod(uid))), stderr: '' });

test('manifest pins image, source SHA and lock hash; worker stays Running for later exec requests', () => {
  const manifest = warmWorkerPodManifest(spec) as any;
  expect(manifest.kind).toBe('Pod');
  expect(manifest.spec.restartPolicy).toBe('Never');
  expect(manifest.spec.automountServiceAccountToken).toBe(false);
  expect(manifest.spec.nodeSelector).toEqual({ 'kubernetes.io/arch': 'amd64' });
  expect(manifest.spec.initContainers[0].name).toBe('isolation-gate');
  expect(manifest.spec.initContainers[0].env).toEqual(expect.arrayContaining([
    { name: 'WARM_HOST_PROBE_URL', value: spec.hostProbeUrl },
    { name: 'WARM_PROD_PROBE_URL', value: spec.prodProbeUrl },
  ]));
  expect(manifest.spec.initContainers[0].args).toBeUndefined();
  expect(manifest.spec.initContainers[1].image).toBe(spec.image);
  expect(manifest.spec.initContainers[1].securityContext).toEqual({ runAsUser: 0, allowPrivilegeEscalation: false });
  expect(manifest.spec.initContainers[1].env).toEqual(expect.arrayContaining([
    { name: 'WARM_CUT_SHA', value: cutSha }, { name: 'WARM_LOCK_HASH', value: key.lockHash },
  ]));
  expect(manifest.spec.containers[0].command).toEqual(['sleep', 'infinity']);
  expect(manifest.spec.containers[0].securityContext.runAsUser).toBe(0);
  expect(manifest.spec.containers[0].env).toContainEqual({ name: 'WARM_POD_UID',
    valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.uid' } } });
  expect(WARM_POD_PREPARE).toContain("['git', '-C', '/workspace/repo', 'remote', 'remove', 'origin']");
  expect(WARM_POD_PREPARE).not.toContain('bun install');
  expect(WARM_POD_INSTALL).toContain("['chmod', '-R', 'a+rX', '/workspace/repo']");
  expect(manifest.spec.initContainers[2].name).toBe('install');
  expect(manifest.spec.initContainers[2].volumeMounts).toEqual([{ name: 'workspace', mountPath: '/workspace' }]);
  expect(WARM_POD_EXEC).toContain("chmodSync('/workspace/data/scratch', 0o755)");
  expect(WARM_POD_EXEC).toContain('runFile: runWarmWorkerFile');
  expect(manifest.spec.containers[0].volumeMounts[0]).toEqual({ name: 'workspace', mountPath: '/workspace/repo', subPath: 'repo', readOnly: true });
  expect(manifest.spec.volumes).toEqual([{ name: 'workspace', emptyDir: {} }, { name: 'runtime-data', emptyDir: {} }]);
  expect(() => warmWorkerPodManifest({ ...spec, image: 'registry.example/elanous:latest' })).toThrow();
  expect(() => warmWorkerPodManifest({ ...spec, key: { ...key, lockHash: 'wrong' } })).toThrow();
  expect(() => warmWorkerPodManifest({ ...spec, hostProbeUrl: 'http://example.test:10001/health' })).toThrow();
  const mirrorSpec = { ...spec, sourceUrl: undefined, sourceMirrorHostPath: '/srv/elanous-mirror', nodeName: 'k3d-node-b-agent-0' };
  const mirrored = warmWorkerPodManifest(mirrorSpec) as any;
  expect(mirrored.spec.nodeName).toBe('k3d-node-b-agent-0');
  expect(mirrored.spec.initContainers[1].env[0]).toEqual({ name: 'WARM_SOURCE_URL', value: '/source-mirror' });
  expect(mirrored.spec.initContainers[1].volumeMounts).toContainEqual({ name: 'source-mirror', mountPath: '/source-mirror', readOnly: true });
  expect(mirrored.spec.initContainers[2].volumeMounts).not.toContainEqual({ name: 'source-mirror', mountPath: '/source-mirror', readOnly: true });
  expect(mirrored.spec.volumes).toContainEqual({ name: 'source-mirror', hostPath: { path: '/srv/elanous-mirror', type: 'Directory' } });
  expect(() => warmWorkerPodManifest({ ...spec, sourceMirrorHostPath: '/srv/elanous-mirror', nodeName: 'k3d-node-b-agent-0' })).toThrow();
  expect(() => warmWorkerPodManifest({ ...spec, sourceUrl: undefined, sourceMirrorHostPath: '/srv/elanous-mirror' })).toThrow();
  expect(() => warmWorkerPodManifest({ ...spec, sourceUrl: 'https://user:secret@github.com/example/repo.git' })).toThrow();
  expect(() => warmWorkerPodManifest({ ...spec, sourceUrl: 'https://github.com/example/repo.git?token=secret' })).toThrow();
});

test('two requests use kubectl exec in the same Pod, pass JSON by stdin, and keep file names out of shell code', async () => {
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const kubectl: Kubectl = (args, input) => {
    calls.push({ args, input });
    if (args.includes('get')) return getResult(args);
    if (args.includes(WARM_POD_ACK)) return { status: 0, stdout: 'ack', stderr: '' };
    if (args.includes(WARM_POD_READ)) {
      const path = args.at(-1)!;
      const attempt = path.includes('attempt-1') ? 'attempt-1' : 'attempt-2';
      const suffix = path.slice(path.indexOf('file-0.') + 'file-0.'.length) as keyof ReturnType<typeof artifacts>;
      return { status: 0, stdout: Buffer.from(artifacts(command(attempt))[suffix]).toString('base64'), stderr: '' };
    }
    const request = JSON.parse(input!) as WarmWorkerCommand;
    return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(request), artifactHashes: artifactHashes(request), reply: reply(request) }), stderr: '' };
  };
  const transport = new WarmPodTransport(spec, kubectl);
  const [first, second] = await Promise.all([transport.request(command('attempt-1')), transport.request(command('attempt-2'))]);
  expect(first.status).toBe('observed');
  expect(second.status).toBe('observed');
  expect(first.artifactsDir).not.toBe(second.artifactsDir);
  const execs = calls.filter(call => call.args.includes('exec') && call.args.includes('-i'));
  const requests = execs.filter(call => call.args.includes(WARM_POD_EXEC));
  expect(requests).toHaveLength(2);
  expect(execs.filter(call => call.args.includes(WARM_POD_ACK))).toHaveLength(2);
  for (const call of requests) {
    expect(call.args).toEqual(['--context', 'node-b', '-n', spec.namespace, 'exec', '-i', spec.name, '-c', 'worker', '--', 'bun', '-e', WARM_POD_EXEC]);
    expect(call.args.join(' ')).not.toContain('src/example/worker.test.ts');
    expect(JSON.parse(call.input!).files).toEqual(['src/example/worker.test.ts']);
  }
  expect(calls.some(call => call.args.includes('apply') || call.args.includes('create'))).toBe(false);
  expect(Buffer.from(first.artifacts?.[0]?.data['warm-manifest.json'] ?? '', 'base64').toString('utf8')).toContain('rcSha256');
});

test('a second request queued during the first exec cannot execute before the first ACK', async () => {
  const events: string[] = [];
  let transport: WarmPodTransport;
  let second: Promise<Awaited<ReturnType<WarmPodTransport['request']>>> | undefined;
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('get')) return getResult(args);
    if (args.includes(WARM_POD_ACK)) {
      events.push(`ack:${(JSON.parse(input!) as WarmWorkerCommand).attemptId}`);
      return { status: 0, stdout: 'ack', stderr: '' };
    }
    if (args.includes(WARM_POD_READ)) {
      const path = args.at(-1)!;
      const attempt = path.includes('attempt-1') ? 'attempt-1' : 'attempt-2';
      const suffix = path.slice(path.indexOf('file-0.') + 'file-0.'.length) as keyof ReturnType<typeof artifacts>;
      return { status: 0, stdout: Buffer.from(artifacts(command(attempt))[suffix]).toString('base64'), stderr: '' };
    }
    const request = JSON.parse(input!) as WarmWorkerCommand;
    events.push(`exec:${request.attemptId}`);
    if (request.attemptId === 'attempt-1') second = transport.request(command('attempt-2'));
    return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(request), artifactHashes: artifactHashes(request), reply: reply(request) }), stderr: '' };
  };
  transport = new WarmPodTransport(spec, kubectl);
  expect((await transport.request(command('attempt-1'))).status).toBe('observed');
  expect((await second)?.status).toBe('observed');
  expect(events).toEqual(['exec:attempt-1', 'ack:attempt-1', 'exec:attempt-2', 'ack:attempt-2']);
});

test('key drift and unready Pod fall back without an exec', async () => {
  let calls = 0;
  const kubectl: Kubectl = args => { calls++; return { status: 0, stdout: JSON.stringify({ ...pod(), status: { phase: 'Pending' } }), stderr: '' }; };
  const transport = new WarmPodTransport(spec, kubectl);
  expect(await transport.request({ ...command('attempt-1'), key: { ...key, lockHash: 'd'.repeat(64) } }))
    .toMatchObject({ status: 'fallback', reason: 'key-drift', reply: null });
  expect(calls).toBe(0);
  expect(await transport.request({ ...command('attempt-1'), envProfile: 'unexpected' }))
    .toMatchObject({ status: 'fallback', reason: 'key-drift' });
  expect(calls).toBe(0);
  expect(await transport.request(command('attempt-1'))).toMatchObject({ status: 'fallback', reason: 'pod-unready' });
  expect(calls).toBe(1);
});

test('a Running Pod on the wrong node architecture never receives a request', async () => {
  let execs = 0;
  const kubectl: Kubectl = args => {
    if (args.includes('node')) return { status: 0, stdout: JSON.stringify({ metadata: { labels: { 'kubernetes.io/arch': 'arm64' } } }), stderr: '' };
    if (args.includes('exec')) execs++;
    return getResult(args);
  };
  expect(await new WarmPodTransport(spec, kubectl).request(command('attempt-1')))
    .toMatchObject({ status: 'fallback', reason: 'pod-unready' });
  expect(execs).toBe(0);
});

test('admission refuses host, privilege and execution-field mutations', async () => {
  for (const mutate of [
    (value: any) => { value.spec.hostNetwork = true; },
    (value: any) => { value.spec.hostPID = true; },
    (value: any) => { value.spec.containers[0].securityContext = { privileged: true }; },
    (value: any) => { value.spec.containers[0].ports = [{ containerPort: 8080, hostPort: 8080 }]; },
    (value: any) => { value.spec.initContainers[0].securityContext = { privileged: true }; },
    (value: any) => { value.spec.initContainers[1].args = ['--exec=unsafe']; },
    (value: any) => { value.spec.containers[0].args = ['1']; },
    (value: any) => { value.spec.containers[0].workingDir = '/workspace/data'; },
    (value: any) => { value.spec.containers[0].startupProbe = { exec: { command: ['sh', '-c', 'true'] } }; },
    (value: any) => { value.spec.hostAliases = [{ ip: '127.0.0.1', hostnames: ['core.elanous-prod'] }]; },
  ]) {
    const unsafe = pod();
    mutate(unsafe);
    let execs = 0;
    const kubectl: Kubectl = args => { if (args.includes('exec')) execs++; return { status: 0,
      stdout: JSON.stringify(args.includes('node') ? node() : unsafe), stderr: '' }; };
    expect(await new WarmPodTransport(spec, kubectl).request(command('attempt-1')))
      .toMatchObject({ status: 'fallback', reason: 'pod-unready' });
    expect(execs).toBe(0);
  }
});

test('host verification failure leaves the Pod request fence for a new transport instance', async () => {
  const request = command('attempt-1');
  let fenced = false;
  let acknowledgements = 0;
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('get')) return getResult(args);
    if (args.includes(WARM_POD_ACK)) { acknowledgements++; fenced = false; return { status: 0, stdout: 'ack', stderr: '' }; }
    if (args.includes(WARM_POD_READ)) {
      const suffix = args.at(-1)!.slice(args.at(-1)!.indexOf('file-0.') + 'file-0.'.length) as keyof ReturnType<typeof artifacts>;
      return { status: 0, stdout: Buffer.from(suffix === 'junit.xml' ? '<tampered/>' : artifacts(request)[suffix]).toString('base64'), stderr: '' };
    }
    if (fenced) return { status: 0, stdout: JSON.stringify({ reply: null, quarantineWorker: true, reason: 'quarantined' }), stderr: '' };
    fenced = true;
    return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(request), artifactHashes: artifactHashes(request), reply: reply(JSON.parse(input!)) }), stderr: '' };
  };
  expect(await new WarmPodTransport(spec, kubectl).request(request))
    .toMatchObject({ status: 'fallback', reason: 'invalid-result' });
  expect(acknowledgements).toBe(0);
  expect(fenced).toBe(true);
  expect(await new WarmPodTransport(spec, kubectl).request(command('attempt-2')))
    .toMatchObject({ status: 'fallback', reason: 'worker-quarantined' });
  expect(WARM_POD_EXEC).toContain("active + '/identity'");
  expect(WARM_POD_EXEC).toContain("controlStat.uid !== Number(process.env.WARM_BRIDGE_UID)");
});

test('replacement Pod or incomplete reply quarantines the transport', async () => {
  let gets = 0;
  let execs = 0;
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('get')) return getResult(args, args.includes('pod') ? (++gets <= 4 ? 'old-uid' : 'new-uid') : undefined);
    if (args.includes(WARM_POD_ACK)) return { status: 0, stdout: 'ack', stderr: '' };
    if (args.includes(WARM_POD_READ)) {
      const path = args.at(-1)!;
      const suffix = path.slice(path.indexOf('file-0.') + 'file-0.'.length) as keyof ReturnType<typeof artifacts>;
      return { status: 0, stdout: Buffer.from(artifacts(command('attempt-1'))[suffix]).toString('base64'), stderr: '' };
    }
    execs++;
    const request = JSON.parse(input!) as WarmWorkerCommand;
    return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(request), artifactHashes: artifactHashes(request), reply: reply(request) }), stderr: '' };
  };
  const transport = new WarmPodTransport(spec, kubectl);
  expect((await transport.request(command('attempt-1'))).status).toBe('observed');
  expect(await transport.request(command('attempt-2'))).toMatchObject({ status: 'fallback', reason: 'pod-replaced' });
  expect(await transport.request(command('attempt-3'))).toMatchObject({ status: 'fallback', reason: 'worker-quarantined' });
  expect(execs).toBe(1);

  const malformed: Kubectl = (args, input) => args.includes('get')
    ? getResult(args)
    : { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(JSON.parse(input!)), artifactHashes: artifactHashes(JSON.parse(input!)),
      reply: { ...reply(JSON.parse(input!)), files: [] } }), stderr: '' };
  expect(await new WarmPodTransport(spec, malformed).request(command('attempt-1')))
    .toMatchObject({ status: 'fallback', reason: 'invalid-result' });
});

test('a changed JUnit after the worker reply is unmeasured on the host', async () => {
  const request = command('attempt-1');
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('get')) return getResult(args);
    if (args.includes(WARM_POD_ACK)) return { status: 0, stdout: 'ack', stderr: '' };
    if (args.includes(WARM_POD_READ)) {
      const suffix = args.at(-1)!.slice(args.at(-1)!.indexOf('file-0.') + 'file-0.'.length) as keyof ReturnType<typeof artifacts>;
      return { status: 0, stdout: Buffer.from(suffix === 'junit.xml' ? '<testsuites/>' : artifacts(request)[suffix]).toString('base64'), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(request), artifactHashes: artifactHashes(request), reply: reply(JSON.parse(input!)) }), stderr: '' };
  };
  const transport = new WarmPodTransport(spec, kubectl);
  expect(await transport.request(request)).toMatchObject({ status: 'fallback', reason: 'invalid-result', reply: null });
  expect(await transport.request(command('attempt-2'))).toMatchObject({ status: 'fallback', reason: 'worker-quarantined' });
});

test('a paired JUnit and manifest rewrite still fails the exec-time artifact digest', async () => {
  const request = command('attempt-1');
  const changed = artifacts(request);
  changed['junit.xml'] = changed['junit.xml'].replace('works', 'rewritten');
  changed['warm-manifest.json'] = JSON.stringify({ ...JSON.parse(changed['warm-manifest.json']),
    junitSha256: sha256(changed['junit.xml']) });
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('get')) return getResult(args);
    if (args.includes(WARM_POD_ACK)) return { status: 0, stdout: 'ack', stderr: '' };
    if (args.includes(WARM_POD_READ)) {
      const suffix = args.at(-1)!.slice(args.at(-1)!.indexOf('file-0.') + 'file-0.'.length) as keyof typeof changed;
      return { status: 0, stdout: Buffer.from(changed[suffix]).toString('base64'), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(request), artifactHashes: artifactHashes(request), reply: reply(JSON.parse(input!)) }), stderr: '' };
  };
  expect(await new WarmPodTransport(spec, kubectl).request(request))
    .toMatchObject({ status: 'fallback', reason: 'invalid-result' });
});

test('host reparses JUnit and rejects malformed XML even with matching artifact hashes', async () => {
  const request = command('attempt-1');
  const changed = artifacts(request);
  changed['junit.xml'] = '<testsuites tests="1"><testsuite tests="1"><testcase file="src/example/worker.test.ts"/>';
  changed['warm-manifest.json'] = JSON.stringify({ ...JSON.parse(changed['warm-manifest.json']),
    junitSha256: sha256(changed['junit.xml']) });
  const hashes = [Object.fromEntries(Object.entries(changed).map(([name, value]) => [name, sha256(value)]))];
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('get')) return getResult(args);
    if (args.includes(WARM_POD_READ)) {
      const suffix = args.at(-1)!.slice(args.at(-1)!.indexOf('file-0.') + 'file-0.'.length) as keyof typeof changed;
      return { status: 0, stdout: Buffer.from(changed[suffix]).toString('base64'), stderr: '' };
    }
    if (args.includes(WARM_POD_ACK)) throw new Error('malformed XML must never be acknowledged');
    return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(request), artifactHashes: hashes, reply: reply(JSON.parse(input!)) }), stderr: '' };
  };
  expect(await new WarmPodTransport(spec, kubectl).request(request))
    .toMatchObject({ status: 'fallback', reason: 'invalid-result' });
});

test('artifact collection refuses a replaced Pod and a forged isolation init command', async () => {
  const request = command('attempt-1');
  let gets = 0;
  const replaced: Kubectl = (args, input) => {
    if (args.includes('get')) return getResult(args, args.includes('pod') ? (++gets <= 2 ? 'old' : 'new') : undefined);
    if (args.includes(WARM_POD_ACK)) return { status: 0, stdout: 'ack', stderr: '' };
    if (args.includes(WARM_POD_READ)) {
      const suffix = args.at(-1)!.slice(args.at(-1)!.indexOf('file-0.') + 'file-0.'.length) as keyof ReturnType<typeof artifacts>;
      return { status: 0, stdout: Buffer.from(artifacts(request)[suffix]).toString('base64'), stderr: '' };
    }
    return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
      artifactsDir: artifactsDir(request), artifactHashes: artifactHashes(request), reply: reply(JSON.parse(input!)) }), stderr: '' };
  };
  expect(await new WarmPodTransport(spec, replaced).request(request))
    .toMatchObject({ status: 'fallback', reason: 'invalid-result' });

  let execs = 0;
  const forged: Kubectl = args => {
    if (!args.includes('get')) execs++;
    const wrong = pod();
    wrong.spec.initContainers[0].command = ['true'];
    return { status: 0, stdout: JSON.stringify(wrong), stderr: '' };
  };
  expect(await new WarmPodTransport(spec, forged).request(request))
    .toMatchObject({ status: 'fallback', reason: 'pod-unready' });
  expect(execs).toBe(0);
});

test('same-UID ephemeral container added during exec, artifact fetch or ACK invalidates the Pod', async () => {
  for (const injectAt of [2, 3, 4]) {
    const request = command(`attempt-${injectAt}`);
    const ledgerDir = injectAt === 4 ? mkdtempSync(join(tmpdir(), 'warm-pod-ledger-')) : undefined;
    let podGets = 0;
    let acknowledgements = 0;
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('get') && args.includes('node')) return { status: 0, stdout: JSON.stringify(node()), stderr: '' };
      if (args.includes('get')) {
        podGets++;
        const value = pod();
        if (podGets >= injectAt && (injectAt !== 4 || podGets === 4))
          value.spec.ephemeralContainers = [{ name: 'late-debugger', image: spec.image }];
        return { status: 0, stdout: JSON.stringify(value), stderr: '' };
      }
      if (args.includes(WARM_POD_ACK)) { acknowledgements++; return { status: 0, stdout: 'ack', stderr: '' }; }
      if (args.includes(WARM_POD_READ)) {
        const suffix = args.at(-1)!.slice(args.at(-1)!.indexOf('file-0.') + 'file-0.'.length) as keyof ReturnType<typeof artifacts>;
        return { status: 0, stdout: Buffer.from(artifacts(request)[suffix]).toString('base64'), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify({ reason: 'complete', quarantineWorker: false,
        artifactsDir: artifactsDir(request), artifactHashes: artifactHashes(request), reply: reply(JSON.parse(input!)) }), stderr: '' };
    };
    const transport = new WarmPodTransport(spec, kubectl, ledgerDir);
    expect((await transport.request(request)).status).toBe('fallback');
    expect(await transport.request(command('later'))).toMatchObject({ status: 'fallback', reason: 'worker-quarantined' });
    expect(acknowledgements).toBe(injectAt === 4 ? 1 : 0);
    if (injectAt === 4) {
      const freshKubectl: Kubectl = (args, input) => kubectl(args, input);
      expect(await new WarmPodTransport(spec, freshKubectl, ledgerDir).request(command('fresh-client')))
        .toMatchObject({ status: 'fallback', reason: 'worker-quarantined' });
      rmSync(ledgerDir!, { recursive: true, force: true });
    }
  }
});

test('the explicit shadow CLI reaches an existing Pod through kubectl without creating one', () => {
  const request = command('attempt-cli');
  const dir = mkdtempSync(join(tmpdir(), 'warm-pod-cli-'));
  try {
    const script = join(dir, 'kubectl');
    const payload = join(dir, 'payload.json');
    writeFileSync(payload, JSON.stringify({ spec, command: request }));
    writeFileSync(script, `#!/usr/bin/env bun
const args = process.argv.slice(2);
const data = ${JSON.stringify(artifacts(request))};
if (args.includes('get')) process.stdout.write(JSON.stringify(args.includes('node') ? ${JSON.stringify(node())} : ${JSON.stringify(pod())}));
else if (args.includes(${JSON.stringify(WARM_POD_ACK)})) process.stdout.write('ack');
else if (args.includes(${JSON.stringify(WARM_POD_READ)})) { const path = args.at(-1); process.stdout.write(Buffer.from(data[path.slice(path.indexOf('file-0.') + 7)]).toString('base64')); }
else { const request = JSON.parse(await Bun.stdin.text()); process.stdout.write(JSON.stringify({ reason: 'complete', quarantineWorker: false,
  artifactsDir: ${JSON.stringify(artifactsDir(request))}, artifactHashes: ${JSON.stringify(artifactHashes(request))},
  reply: ${JSON.stringify(reply(request))} })); }
`, { mode: 0o755 });
    const result = spawnSync(process.execPath,
      [join(import.meta.dir, 'pod-warm-worker-pod.ts'), '--shadow-request', payload],
      { encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: dir,
        PATH: `${dir}:${process.env.PATH}` }, timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('observed');
    expect(JSON.parse(result.stdout).artifacts[0].file).toBe(request.files[0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test('actual Bun bridge keeps a second request fenced until ACK and transports raw artifact bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'warm-bridge-'));
  try {
    const workspace = join(root, 'workspace');
    const moduleDir = join(workspace, 'repo/src/task-orchestrator/surfaces');
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(join(workspace, 'data'));
    writeFileSync(join(workspace, 'repo/bun.lock'), 'pinned-lock');
    writeFileSync(join(moduleDir, 'pod-warm-worker-runtime.ts'), `
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
const hash = value => createHash('sha256').update(value).digest('hex');
export class WarmWorkerRuntime {
  async handle(command) {
    const dir = process.env.WARM_TEST_ARTIFACTS + '/' + [command.runId, command.attemptId, command.leaseId, command.generation, command.workerId].join('--');
    mkdirSync(dir, { recursive: true });
    const prefix = dir + '/file-0';
    const log = Buffer.from([255, 0, 65]);
    const junit = Buffer.from('<testsuites tests="1"/>');
    const meta = Buffer.from(JSON.stringify({ rc: 0 }));
    const rc = Buffer.from('0');
    const manifest = Buffer.from(JSON.stringify({ logSha256: hash(log), junitSha256: hash(junit) }));
    for (const [suffix, bytes] of Object.entries({ log, 'junit.xml': junit, json: meta, 'warm-manifest.json': manifest, rc }))
      writeFileSync(prefix + '.' + suffix, bytes);
    return { reason: 'complete', quarantineWorker: false, artifactsDir: dir, reply: { files: [{ file: command.files[0], rc: 0 }] } };
  }
}`);
    writeFileSync(join(moduleDir, 'pod-warm-worker-runner.ts'), 'export const runWarmWorkerFile = async () => 0;');
    const repoDir = join(workspace, 'repo');
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { encoding: 'utf8', timeout: 20_000 });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
      return result.stdout.trim();
    };
    git(['init', '-q', repoDir]);
    git(['-C', repoDir, 'config', 'user.name', 'Warm Test']);
    git(['-C', repoDir, 'config', 'user.email', 'warm-test@example.invalid']);
    git(['-C', repoDir, 'add', '.']);
    git(['-C', repoDir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
    const fixtureSha = git(['-C', repoDir, 'rev-parse', 'HEAD']);
    const fixtureKey = { ...key, lockHash: sha256('pinned-lock') };
    const bridgeCommand = (attemptId: string): WarmWorkerCommand => ({ ...command(attemptId), cutSha: fixtureSha, key: fixtureKey });
    const env = { ...process.env, WARM_BRIDGE_UID: String(process.getuid?.() ?? 0),
      WARM_CUT_SHA: fixtureSha, WARM_LOCK_HASH: fixtureKey.lockHash, WARM_WORKER_ID: spec.workerId,
      WARM_CONTEXT: key.context, WARM_IMAGE_DIGEST: key.imageDigest, WARM_ARCHITECTURE: key.architecture,
      WARM_TEST_ARTIFACTS: join(workspace, 'data/artifacts') };
    const script = WARM_POD_EXEC.replace(WARM_POD_ISOLATION_PROBE, 'async function warmIsolationEnforced() { return true; }');
    const run = (source: string, input: unknown) => spawnSync(process.execPath, ['-e', source.replaceAll('/workspace', workspace)],
      { input: JSON.stringify(input), encoding: 'utf8', env, timeout: 20_000 });
    const wrongImage = bridgeCommand('wrong-image');
    expect(run(script, { ...wrongImage, key: { ...wrongImage.key, imageDigest: `sha256:${'d'.repeat(64)}` } }).status).not.toBe(0);
    const first = run(script, bridgeCommand('attempt-1'));
    if (first.status !== 0) throw new Error(first.stderr);
    expect(first.status).toBe(0);
    const result = JSON.parse(first.stdout);
    expect(result.reason).toBe('complete');
    const blocked = run(script, bridgeCommand('attempt-2'));
    expect(JSON.parse(blocked.stdout).quarantineWorker).toBe(true);
    const logPath = `${result.artifactsDir}/file-0.log`;
    const read = spawnSync(process.execPath, ['-e', WARM_POD_READ, logPath], { encoding: 'utf8', env, timeout: 20_000 });
    expect(read.status).toBe(0);
    expect(Buffer.from(read.stdout, 'base64')).toEqual(Buffer.from([255, 0, 65]));
    expect(sha256(Buffer.from(read.stdout, 'base64'))).toBe(result.artifactHashes[0].log);
    const ack = run(WARM_POD_ACK, { runId: 'run-1', attemptId: 'attempt-1', leaseId: 'lease-1', generation: 1 });
    expect(ack.stdout).toBe('ack');
    const second = run(script, bridgeCommand('attempt-2'));
    expect(JSON.parse(second.stdout).reason).toBe('complete');
    const secondAck = run(WARM_POD_ACK, { runId: 'run-1', attemptId: 'attempt-2', leaseId: 'lease-1', generation: 1 });
    expect(secondAck.stdout).toBe('ack');
    const denied = WARM_POD_EXEC.replace(WARM_POD_ISOLATION_PROBE, 'async function warmIsolationEnforced() { return false; }');
    expect(run(denied, bridgeCommand('attempt-3')).status).not.toBe(0);
    expect(JSON.parse(run(script, bridgeCommand('attempt-4')).stdout).quarantineWorker).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('actual bridge fences a host run because the file runner requires a dedicated Pod namespace', () => {
  const data = mkdtempSync(join(tmpdir(), 'warm-real-bridge-'));
  try {
    const repoDir = resolve(import.meta.dir, '../../..');
    const cut = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const dirty = spawnSync('git', ['-C', repoDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
    expect(dirty.status).toBe(0);
    expect(dirty.stdout.trim()).toBe('');
    const lockHash = sha256(readFileSync(join(repoDir, 'bun.lock')));
    const files = ['src/task-orchestrator/surfaces/pod-warm-worker-protocol.test.ts'];
    const request: WarmWorkerCommand = { ...command('real-bridge'), cutSha: cut,
      key: { ...key, lockHash }, files, deadlineAt: Date.now() + 90_000 };
    const env = { ...process.env, WARM_BRIDGE_UID: String(process.getuid?.() ?? 0),
      WARM_CUT_SHA: cut, WARM_LOCK_HASH: lockHash, WARM_WORKER_ID: spec.workerId,
      WARM_CONTEXT: key.context, WARM_IMAGE_DIGEST: key.imageDigest, WARM_ARCHITECTURE: key.architecture };
    const script = WARM_POD_EXEC.replace(WARM_POD_ISOLATION_PROBE,
      'async function warmIsolationEnforced() { return true; }')
      .replaceAll('/workspace/repo', repoDir).replaceAll('/workspace/data', data);
    const run = spawnSync(process.execPath, ['-e', script],
      { input: JSON.stringify(request), encoding: 'utf8', env, timeout: 120_000 });
    if (run.status !== 0) throw new Error(run.stderr);
    const outcome = JSON.parse(run.stdout);
    expect(outcome.quarantineWorker).toBe(true);
    expect(outcome.reply).toBeNull();
    expect(outcome.reason).toBe('execution-error');
    expect(readFileSync(join(data, 'control/quarantine'), 'utf8')).toBe('execution-error');
  } finally { rmSync(data, { recursive: true, force: true }); }
}, 120_000);
