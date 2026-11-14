/** GCP design entry: explicit read-only observation, or an honest no-connection result. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { gcloud } from '../../cli/role-cli.js';
import { elanousStateRoot } from '../../autopilot/state-paths.js';
import { runArchitectureDeliverables } from '../architecture-deliverables.js';
import { ticketDesignFromArchitectureJson } from '../../../scripts/gcp-architect-expand/demo/design-result.js';
import {
  emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration,
  type GraphCapabilityRegistry,
} from '../capabilities.js';
import type { InProcessHandlerContext, InProcessHandlerResult } from '../in-process-registry.js';

interface Resource { id: string; name: string; status: string; zone: string }
export interface GcpObserveConnection { projectId: string }
export interface GcpObserveOptions {
  /** An explicit user-selected connection; absent is never interpreted as an empty project. */
  connection?: () => GcpObserveConnection | null;
  /** Read-only Compute list seam. A test supplies this without contacting GCP. */
  listInstances?: (projectId: string) => Promise<unknown>;
  /** Isolated artifact root for tests; operating runs use the state root. */
  artifactRoot?: () => string;
}
const projectId = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const observeContract = 'cloud-resource.observe@1';
const designContract = 'cloud-resource.design@1';
const deliverablesContract = 'cloud-resource.architecture-deliverables@1';

function structuredRequirementsDesign(spec: Record<string, unknown>): Record<string, unknown> {
  const requirements = spec.requirements;
  const components = spec.localComponents;
  if (typeof spec.title !== 'string' || typeof spec.summary !== 'string' || typeof spec.region !== 'string'
    || !Array.isArray(requirements) || requirements.length < 3 || !requirements.every(item => typeof item === 'string' && item.trim())
    || !Array.isArray(components) || !components.length || !components.every(item => typeof item === 'string' && item.trim()))
    throw new Error('requirements design incomplete');
  const dataClass = spec.dataClass === 'public' ? 'public' : 'internal';
  return {
    schemaVersion: 1, title: `${spec.title} — 클라우드 연결 전 설계`, version: '1.0',
    summary: `${spec.summary} 현재 클라우드 연결이 없어 실제 자원·견적은 확인하지 않았습니다.`,
    background: `요구 기반 설계 초안. 기존 구성: ${components.join(', ')}. 연결·배포 승인은 별도입니다.`,
    deployment: { provider: 'generic', project: 'unconnected-design-only', region: spec.region, vpc: 'proposed-network' },
    nodes: [
      { id: 'users', label: 'Users', layer: 'users', zone: 'external', service: 'Clients' },
      { id: 'edge', label: 'Proposed edge', layer: 'edge', zone: 'project', service: 'Request boundary' },
      { id: 'application', label: 'Proposed workload', layer: 'application', zone: 'vpc', service: String(spec.offloadWorkload ?? 'Application workload') },
      { id: 'data', label: 'Proposed data', layer: 'data', zone: 'vpc', service: String(spec.exportData ?? 'Data transfer') },
      { id: 'observe', label: 'Proposed telemetry', layer: 'observability', zone: 'vpc', service: 'Metrics and logs' },
      { id: 'security', label: 'Trust boundary', layer: 'security', zone: 'external', service: 'Access controls' },
    ],
    flows: [
      { from: 'users', to: 'edge', label: 'request', kind: 'sync' },
      { from: 'edge', to: 'application', label: 'admitted work', kind: 'sync' },
      { from: 'application', to: 'data', label: 'approved data', kind: 'async' },
      { from: 'application', to: 'observe', label: 'telemetry', kind: 'telemetry' },
    ],
    requirements: requirements.map((statement, index) => ({ id: `R${index + 1}`, kind: 'requirement', statement,
      verification: '연결 후 실제 환경에서 검증 필요' })),
    security: [{ class: dataClass, data: '요구 문서의 데이터 분류', controls: '연결 전 접근 금지·최소 권한 검토' }],
    capacity: [{ item: '확장 용량', assumption: '요구에서만 추정; 실제 자원 미관측', verification: '연결 후 측정 필요' }],
    costs: [{ item: '클라우드 비용', formula: '미산정 — 연결 후 실제 SKU·사용량 확인 필요', monthlyUsd: null }],
    savings: [{ name: '승인 전 비용 방지', mechanism: '설계만 생성하고 자원 생성 0', guardrail: '연결·별도 승인 전 배포 금지' }],
    alternatives: [{ name: '현재 로컬 구성 유지', when: '클라우드 연결 전', tradeoff: '확장 용량은 미검증' }],
    decisions: [{ id: 'ADR-1', decision: '연결 전 설계만 보존', rationale: '실제 자원 관측·지출 승인 없음', revisit: '연결 후 검증·승인 시' }],
    references: [{ title: 'Submitted design SHA256', url: `urn:sha256:${spec.inputSha256}` }],
  };
}

async function deliverRequirementsDesign(context: InProcessHandlerContext, artifactRoot: () => string): Promise<InProcessHandlerResult> {
  const observed = context.outputs.detect as { result?: { connection?: unknown } } | undefined;
  if (observed?.result?.connection !== 'none')
    return { ok: false, outcome: 'failed', error: 'no-connection deliverables require absent connection' };
  const design = context.outputs.design as { result?: { architectureSpec?: unknown } } | undefined;
  const spec = design?.result?.architectureSpec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, outcome: 'failed', error: 'design result missing' };
  try {
    const root = artifactRoot();
    if (!isAbsolute(root)) throw new Error('artifact root must be absolute');
    const work = join(root, 'gcp-architect-expand', context.runId);
    mkdirSync(work, { recursive: true });
    const structuredDesignPath = join(work, 'requirements-design.json');
    writeFileSync(structuredDesignPath, JSON.stringify(structuredRequirementsDesign(spec as Record<string, unknown>)));
    const outDir = join(work, 'deliverables');
    const delivered = await runArchitectureDeliverables({
      pluginRoot: resolve(import.meta.dir, '../../../plugins/architecture-deliverables'),
      structuredDesignPath, outDir, resourceRoot: resolve(import.meta.dir, '../../..'), stateRoot: join(work, 'graph-state'),
    });
    const names = ['architecture.excalidraw', 'architecture.png', 'architecture.pdf', 'architecture.html'] as const;
    const attachments = names.map(name => ({ name, path: join(delivered.bundleDir, name),
      sha256: delivered.receipt.sha256?.[name] }));
    return { ok: true, outcome: 'connection-needed', result: {
      attachments, verificationPath: join(outDir, 'verification.json'),
      connection: 'none', fakeResources: 0, realGcpWrites: 0,
    }, evidence: { contract: delivered.receipt.contract, status: delivered.receipt.status, realGcpWrites: 0 } };
  } catch (error) {
    return { ok: false, outcome: 'failed', error: error instanceof Error ? error.message : 'deliverables failed' };
  }
}

function configuredConnection(): GcpObserveConnection | null {
  const value = process.env.ELANOUS_GCP_OBSERVE_PROJECT?.trim();
  return value ? { projectId: value } : null;
}

async function listGcpInstances(project: string): Promise<unknown> {
  const binary = gcloud();
  if (!binary) throw new Error('gcloud unavailable');
  const result = spawnSync(binary, ['compute', 'instances', 'list', `--project=${project}`, '--format=json'], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000,
  });
  if (result.error || result.status !== 0) throw new Error('GCP read unavailable');
  return JSON.parse(result.stdout);
}

function resourcesFromRead(value: unknown): Resource[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('GCP list response invalid');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('GCP resource invalid');
    const row = item as Record<string, unknown>;
    if ((typeof row.id !== 'string' && typeof row.id !== 'number') || typeof row.name !== 'string'
      || typeof row.status !== 'string' || typeof row.zone !== 'string') throw new Error('GCP resource invalid');
    return { id: String(row.id), name: row.name, status: row.status, zone: row.zone.split('/').at(-1) ?? '' };
  });
}

function designFromRequirements(context: InProcessHandlerContext): InProcessHandlerResult {
  const input = context.graphInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, outcome: 'failed', error: 'design input missing' };
  const path = (input as Record<string, unknown>).ticketDesignPath;
  if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, outcome: 'failed', error: 'absolute ticketDesignPath required' };
  try {
    const file = resolve(path);
    const raw = readFileSync(file);
    if (raw.byteLength > 1_000_000) throw new Error('design input too large');
    const design = ticketDesignFromArchitectureJson(JSON.parse(raw.toString('utf8')) as unknown);
    const hash = createHash('sha256').update(raw).digest('hex');
    const observation = context.outputs.detect as { result?: { connection?: unknown } } | undefined;
    const connection = observation?.result?.connection;
    if (connection !== 'none' && connection !== 'connected') throw new Error('resource observation missing');
    return { ok: true, outcome: connection === 'none' ? 'requirements-only' : 'observed-design', result: {
      architectureSpec: { source: 'requirements-only', inputSha256: hash, title: design.title,
        summary: design.summary, requirements: design.requirements, dataClass: design.dataClass,
        localComponents: design.localComponents, offloadWorkload: design.offloadWorkload,
        exportData: design.exportData, region: design.region, estimate: { price: 'unpriced' },
        cloudResources: [], fakeResources: 0, realGcpWrites: 0 },
    }, evidence: { inputSha256: hash, resourceObservation: context.outputs.detect ?? null,
      costStatus: 'unpriced', realGcpWrites: 0 } };
  } catch {
    return { ok: false, outcome: 'failed', error: 'structured design input invalid' };
  }
}

/** Register only observation and requirement design. Provisioning remains unavailable. */
export function createGcpResourceObserveRegistry(options: GcpObserveOptions = {}): GraphCapabilityRegistry {
  let registry = emptyGraphCapabilityRegistry();
  for (const id of [observeContract, designContract, deliverablesContract] as const) {
    registry = registerGraphCapabilityContract(registry, { id, input: { type: 'object' }, output: { type: 'object' } });
  }
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'gcp-resource-observe', provides: [observeContract, designContract, deliverablesContract], tier: 'free',
    invoke: async context => {
      if (context.requires === designContract) return designFromRequirements(context);
      if (context.requires === deliverablesContract) return deliverRequirementsDesign(context, options.artifactRoot ?? elanousStateRoot);
      if (context.requires !== observeContract) return { ok: false, outcome: 'failed', error: 'unsupported contract' };
      const connection = (options.connection ?? configuredConnection)();
      if (!connection) return { ok: true, outcome: 'no-connection', result: {
        connection: 'none', message: '연결 없음', resources: [], resourceCount: 0,
      }, evidence: { source: 'explicit-connection-check', realGcpReads: 0, realGcpWrites: 0 } };
      if (!projectId.test(connection.projectId)) return { ok: false, outcome: 'unknown', error: 'invalid GCP project' };
      try {
        const resources = resourcesFromRead(await (options.listInstances ?? listGcpInstances)(connection.projectId));
        return { ok: true, outcome: 'observed', result: {
          connection: 'connected', projectId: connection.projectId, resources, resourceCount: resources.length,
        }, evidence: { source: 'gcloud-compute-instances-list', realGcpReads: 1, realGcpWrites: 0 } };
      } catch {
        return { ok: false, outcome: 'unknown', error: 'GCP read unavailable' };
      }
    },
  });
}
