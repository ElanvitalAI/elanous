import { createFakeKubectl } from './fake-kubectl.js';
import type { PoolKubectl } from '../task-orchestrator/surfaces/pod-pool.js';
import type { SshRunner } from '../task-agent/parent-host.js';

export interface FakeFleetCluster {
  readonly host: string;
  readonly context: string;
  readonly nodes: readonly string[];
}

export interface FakeFleetSshScript {
  readonly host: string;
  /** The next invocation for this host must contain this text; mismatches fail closed. */
  readonly includes: string;
  readonly delayMs?: number;
  readonly result: { readonly status: number | null; readonly stdout: string; readonly stderr: string };
}

export interface FakeFleetDeviceOptions {
  readonly clusters: readonly FakeFleetCluster[];
  readonly sshScripts?: readonly FakeFleetSshScript[];
  /** Injection point for deterministic tests; production use blocks for the scripted latency. */
  readonly wait?: (ms: number) => void;
}

export interface FakeFleetDevice {
  readonly clusters: readonly FakeFleetCluster[];
  readonly kubectl: PoolKubectl;
  readonly ssh: SshRunner;
  readonly kubectlCalls: Array<{ context: string; args: string[] }>;
  readonly sshCalls: Array<{ host: string; script: string; timeoutMs: number; stdin?: string }>;
  setHostOnline(host: string, online: boolean): void;
  hostOnline(host: string): boolean;
  remainingSshScripts(host?: string): number;
}

const fail = (message: string) => ({ status: 1, stdout: '', stderr: `fake fleet: ${message}` });
const waitSync = (ms: number): void => {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);
};

/**
 * A composable multi-host device: each Kubernetes context owns isolated fake state and any number
 * of nodes; SSH responses are scripted per host. It opens no sockets, invokes no real SSH/kubectl,
 * and unknown contexts, hosts, or script steps fail closed.
 */
export function createFakeFleetDevice(options: FakeFleetDeviceOptions): FakeFleetDevice {
  const clusters = options.clusters.map((cluster) => ({ ...cluster, nodes: [...cluster.nodes] }));
  if (clusters.length === 0) throw new Error('fake fleet requires at least one cluster');
  const hosts = new Set<string>();
  const contexts = new Map<string, ReturnType<typeof createFakeKubectl>>();
  const online = new Map<string, boolean>();
  for (const cluster of clusters) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cluster.host) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cluster.context)) {
      throw new Error('fake fleet host and context must be safe identifiers');
    }
    if (contexts.has(cluster.context)) throw new Error(`fake fleet duplicate context: ${cluster.context}`);
    if (cluster.nodes.length === 0 || cluster.nodes.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      || new Set(cluster.nodes).size !== cluster.nodes.length) {
      throw new Error(`fake fleet ${cluster.host} requires unique safe node names`);
    }
    hosts.add(cluster.host);
    online.set(cluster.host, true);
    contexts.set(cluster.context, createFakeKubectl({ context: cluster.context, node: cluster.nodes[0]!, nodes: cluster.nodes }));
  }
  const scriptsByHost = new Map<string, FakeFleetSshScript[]>();
  for (const step of options.sshScripts ?? []) {
    if (!hosts.has(step.host)) throw new Error(`fake fleet SSH script references unknown host: ${step.host}`);
    if (!step.includes.trim()) throw new Error('fake fleet SSH script requires a non-empty includes matcher');
    if (step.delayMs !== undefined && (!Number.isFinite(step.delayMs) || step.delayMs < 0)) throw new Error('fake fleet SSH delay must be a finite non-negative number');
    const queue = scriptsByHost.get(step.host) ?? [];
    queue.push(step);
    scriptsByHost.set(step.host, queue);
  }

  const kubectlCalls: FakeFleetDevice['kubectlCalls'] = [];
  const kubectl: PoolKubectl = (args, input) => {
    const contextIndex = args.indexOf('--context');
    const context = contextIndex >= 0 ? args[contextIndex + 1] : undefined;
    if (!context) return fail('kubectl invocation needs --context');
    kubectlCalls.push({ context, args: [...args] });
    const cluster = clusters.find((candidate) => candidate.context === context);
    const device = contexts.get(context);
    if (!device || !cluster) return fail(`unknown kubectl context ${context}`);
    if (!online.get(cluster.host)) return { status: 1, stdout: '', stderr: `fake fleet: host ${cluster.host} unreachable` };
    return device.kubectl(args, input);
  };

  const sshCalls: FakeFleetDevice['sshCalls'] = [];
  const ssh: SshRunner = (host, script, timeoutMs, stdin) => {
    sshCalls.push({ host, script, timeoutMs, ...(stdin !== undefined ? { stdin } : {}) });
    if (!online.has(host)) return { status: 255, stdout: '', stderr: `fake fleet: unknown SSH host ${host}` };
    if (!online.get(host)) return { status: 255, stdout: '', stderr: `fake fleet: host ${host} unreachable` };
    const queue = scriptsByHost.get(host) ?? [];
    const step = queue[0];
    if (!step || !script.includes(step.includes)) return { status: 1, stdout: '', stderr: `fake fleet: no scripted SSH response for ${host}` };
    queue.shift();
    const delayMs = step.delayMs ?? 0;
    const timedOut = delayMs > timeoutMs;
    const waitedMs = timedOut ? Math.max(0, timeoutMs) : delayMs;
    if (waitedMs > 0) (options.wait ?? waitSync)(waitedMs);
    if (timedOut) return { status: null, stdout: '', stderr: `fake fleet: SSH timeout after ${timeoutMs}ms` };
    return { ...step.result };
  };

  return {
    clusters: clusters.map((cluster) => ({ ...cluster, nodes: [...cluster.nodes] })),
    kubectl,
    ssh,
    kubectlCalls,
    sshCalls,
    setHostOnline(host, isOnline) {
      if (!online.has(host)) throw new Error(`fake fleet unknown host ${host}`);
      online.set(host, isOnline);
    },
    hostOnline(host) { return online.get(host) ?? false; },
    remainingSshScripts(host) {
      if (host !== undefined) return scriptsByHost.get(host)?.length ?? 0;
      return [...scriptsByHost.values()].reduce((total, queue) => total + queue.length, 0);
    },
  };
}
