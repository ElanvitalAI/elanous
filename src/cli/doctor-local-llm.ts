import { debug } from '../debug/log.js';
import { probeDocker } from '../llm/local-manager/docker-probe.js';
import { probeLmstudio } from '../llm/local-manager/lmstudio-probe.js';
import { probeMlx } from '../llm/local-manager/mlx-probe.js';
import { listNodes } from '../llm/local-manager/node-registry.js';
import { probeOllama } from '../llm/local-manager/ollama-probe.js';
import type { LlmInventory, LlmModel, LlmNode, LlmRuntime } from '../llm/local-manager/types.js';

export interface DoctorLocalLlm {
  nodes: { kind: 'ollama' | 'lmstudio' | 'mlx' | 'docker'; baseUrl: string; reachable: boolean; models: string[] }[];
  timedOut: boolean;
  /** Inventory lookup failed; absence of servers was not established. */
  failed?: boolean;
}

const kinds = ['ollama', 'lmstudio', 'mlx', 'docker'] as const;
type Kind = (typeof kinds)[number];

const baseUrlFields: Record<Kind, 'ollamaBaseUrl' | 'lmstudioBaseUrl' | 'mlxBaseUrl' | 'dockerBaseUrl'> = {
  ollama: 'ollamaBaseUrl', lmstudio: 'lmstudioBaseUrl', mlx: 'mlxBaseUrl', docker: 'dockerBaseUrl',
};

type Probe = (node: { id: string; isLocal: boolean }, deps: { timeoutMs?: number }) => Promise<{ reachable: boolean; models: readonly LlmModel[]; warnings: readonly string[] }>;

/** Doctor shows only this machine, so it probes only the local node — the full inventory also probes every remote
 *  fleet node over ssh and took ~7 s cold, past the 3 s cap («시간 초과» with LM Studio running · 10-01). */
export async function localInventory(deps: {
  nodes?: () => readonly LlmNode[];
  probes?: Record<'lmstudio' | 'ollama' | 'mlx' | 'docker', Probe>;
  now?: () => number;
} = {}): Promise<LlmInventory> {
  const probes = deps.probes ?? { lmstudio: probeLmstudio, ollama: probeOllama, mlx: probeMlx, docker: probeDocker } as Record<'lmstudio' | 'ollama' | 'mlx' | 'docker', Probe>;
  const read = deps.nodes ?? listNodes;
  const nodes: LlmNode[] = [];
  const models: LlmModel[] = [];
  const warnings: string[] = [];
  for (const node of read().filter((n) => n.isLocal)) {
    const seed = { id: node.id, isLocal: true };
    const order = ['lmstudio', 'ollama', 'mlx', 'docker'] as const;
    const results = await Promise.all(order.map((kind) => probes[kind](seed, { timeoutMs: 2500 })));
    const runtimes: LlmRuntime[] = order.filter((_, i) => results[i]!.reachable);
    for (const [i, r] of results.entries()) { models.push(...r.models); for (const w of r.warnings) warnings.push(`${node.id}:${order[i]}:${w}`); }
    // Probes record base URLs in the registry on success — read the node back for them.
    const fresh = read().find((n) => n.id === node.id) ?? node;
    nodes.push({ ...fresh, reachable: runtimes.length > 0, runtimes });
  }
  return { nodes, models, at: (deps.now ?? Date.now)(), cached: false, warnings };
}

export async function probeDoctorLocalLlm(inventory: () => Promise<LlmInventory> = () => localInventory(), timeoutMs = 3000): Promise<DoctorLocalLlm> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: DoctorLocalLlm;
  try {
    const snapshot = await Promise.race([
      Promise.resolve().then(inventory),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    result = snapshot === null
      ? { nodes: [], timedOut: true }
      : {
        nodes: snapshot.nodes.filter((node) => node.isLocal).flatMap((node) => kinds.flatMap((kind) => {
          const baseUrl = node[baseUrlFields[kind]];
          if (!node.runtimes.includes(kind) && !baseUrl) return [];
          return [{
            kind,
            baseUrl: baseUrl ?? '',
            reachable: node.reachable === true && node.runtimes.includes(kind),
            models: snapshot.models.filter((model) => model.nodeId === node.id && model.runtime === kind).map((model) => model.id),
          }];
        })),
        timedOut: false,
      };
  } catch {
    result = { nodes: [], timedOut: false, failed: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  debug.log('doctor.local-llm', 'probed', {
    nodes: result.nodes.length,
    reachable: result.nodes.filter((node) => node.reachable).length,
    models: result.nodes.reduce((total, node) => total + node.models.length, 0),
    timedOut: result.timedOut,
  });
  return result;
}

export function formatDoctorLocalLlm(result: DoctorLocalLlm): string[] {
  if (result.timedOut) return ['Local LLM:', '  시간 초과'];
  if (result.failed) return ['Local LLM:', '  로컬 LLM 인벤토리를 조회하지 못했다'];
  if (result.nodes.length === 0) return ['Local LLM:', '  로컬 LLM 서버를 찾지 못했다 — Ollama(:11434) · LM Studio(:1234) 를 띄우면 여기 보인다'];
  return [
    'Local LLM:',
    ...result.nodes.map((node) => `  ${node.kind} · ${node.baseUrl} · ${node.reachable ? '닿음' : '안 닿음'} · 모델 ${node.models.length}개${node.models.length ? ` · ${node.models.slice(0, 5).join(', ')}` : ''}`),
  ];
}
