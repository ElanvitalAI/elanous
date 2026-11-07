import type { PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';
import { podJobManifest } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { createFakeKubectl } from './fake-kubectl.js';
import { createFakePrimaryControl } from './warm-pool-reuse-sim.js';

export type FakePrimaryControl = Awaited<ReturnType<typeof createFakePrimaryControl>>;
export type FakeKubernetesDevice = ReturnType<typeof createFakeKubectl>;

/** One isolated primary-control server and Kubernetes object store shared by both reuse providers. */
export interface PodReuseSharedFakeBoundary {
  primary: FakePrimaryControl;
  kubernetes: Map<string, FakeKubernetesDevice>;
  kubectl: PoolKubectl;
  stop(): void;
}

export interface HostMirrorMountAdapter {
  readonly readOnly: boolean;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  read(): Uint8Array;
  write(_bytes: Uint8Array): void;
}

type HostMirrorManifest = {
  spec: { template: { spec: { containers: Array<{
    volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  }> } } };
};

/** Build the production Job manifest first, then apply its mount flags to the in-memory adapter. */
export function createHostMirrorMountAdapter(options: { path: string; seed: Uint8Array }): HostMirrorMountAdapter {
  const manifest = podJobManifest({ name: 'pod-reuse-mirror-adapter', namespace: 'elanous-test', image: 'fixture',
    repoUrl: 'https://github.com/ElanvitalAI/elanous.git', args: [], passEnv: [], deadlineSeconds: 60,
    hostMirror: options.path }) as HostMirrorManifest;
  const mount = manifest.spec.template.spec.containers[0]?.volumeMounts?.find(row => row.name === 'host-mirror');
  if (!mount || mount.mountPath !== '/host-mirror' || mount.readOnly !== true)
    throw new Error('production Job manifest did not define a read-only host-mirror mount');
  let bytesRead = 0;
  let bytesWritten = 0;
  return {
    readOnly: mount.readOnly,
    get bytesRead() { return bytesRead; },
    get bytesWritten() { return bytesWritten; },
    read() { bytesRead += options.seed.byteLength; return options.seed.slice(); },
    write(bytes) {
      if (mount.readOnly) throw new Error('host-mirror mount is read-only');
      bytesWritten += bytes.byteLength;
    },
  };
}

export async function createPodReuseSharedFakeBoundary(): Promise<PodReuseSharedFakeBoundary> {
  const primary = await createFakePrimaryControl();
  const kubernetes = new Map<string, FakeKubernetesDevice>([
    ['pool-host-a-context', createFakeKubectl({ context: 'pool-host-a-context', node: 'pool-host-a-server-0',
      podReadinessOnCreate: true })],
    ['pool-host-b-context', createFakeKubectl({ context: 'pool-host-b-context', node: 'pool-host-b-server-0',
      podReadinessOnCreate: true })],
  ]);
  const kubectl: PoolKubectl = (args, input) => {
    const contextIndex = args.indexOf('--context');
    const context = contextIndex >= 0 ? args[contextIndex + 1] : undefined;
    const device = context ? kubernetes.get(context) : undefined;
    return device ? device.kubectl(args, input)
      : { status: 1, stdout: '', stderr: `unknown shared simulation context: ${context ?? '(missing)'}` };
  };
  return { primary, kubernetes, kubectl, stop: () => primary.stop() };
}
