/** Deterministic, offline GCP capacity alternatives. Every rate is synthetic. */
import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;
export type CapacityTier = 'small' | 'medium' | 'large';
export interface TieredRequirement {
  title: string;
  summary: string;
  requirements: string[];
  region: string;
  dataClass: 'public' | 'internal' | 'confidential';
  traffic: { monthlyRequests: number; cpuSecondsPerRequest: number; memoryGibSecondsPerRequest: number;
    peakConcurrent: number; targetLatencySeconds: number; monthlyNotifications: number;
    storageGib: number; egressGib: number; logGib: number };
}
export interface TieredPlan {
  tier: CapacityTier;
  id: string;
  services: string[];
  monthlySimUsd: number;
  costStatus: 'synthetic-only';
  design: Row;
}

// Source: fixed test-world rates, chosen solely to exercise cost arithmetic. These are not GCP prices.
const SIM_RATES = Object.freeze({ cpuSecond: 0.00004, memoryGibSecond: 0.000004, request: 0.0000005,
  storageGibMonth: 0.03, sqlHour: 0.5, redisHour: 0.2, gkeVcpuHour: 0.08, gkeGibHour: 0.01,
  spannerHour: 0.7, pubsubMillion: 0.5, taskMillion: 0.4, deliveryMessage: 0.0002,
  egressGib: 0.12, logGib: 0.5 });
// Source: synthetic 730-hour billing month used by this simulator for equal comparison.
const SIM_MONTH_HOURS = 730;
const ICON = Object.freeze({ network: 'Category Icons/Networking/PNG/Networking-512-color.png',
  run: 'Unique Icons/Cloud Run/PNG/CloudRun-512-color-rgb.png', storage: 'Unique Icons/Cloud Storage/PNG/Cloud_Storage-512-color.png',
  sql: 'Unique Icons/Cloud SQL/PNG/CloudSQL-512-color.png', database: 'Category Icons/Databases/PNG/Databases-512-color.png',
  gke: 'Unique Icons/GKE/PNG/GKE-512-color.png', spanner: 'Unique Icons/Cloud Spanner/PNG/CloudSpanner-512-color.png',
  integration: 'Category Icons/Integration Services/PNG/IntegrationServices-512-color.png',
  observe: 'Category Icons/Observability/PNG/Observability-512-color.png',
  security: 'Category Icons/Security Identity/PNG/SecurityIdentity-512-color.png' });

const object = (value: unknown): Row | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const money = (value: number) => Math.round(value * 100) / 100; // Source: synthetic receipt displays USD cents.

export function parseTieredRequirement(raw: unknown): TieredRequirement {
  const data = object(raw);
  const traffic = object(data?.traffic);
  if (!data || !nonempty(data.title) || !nonempty(data.summary) || !Array.isArray(data.requirements)
    || data.requirements.length === 0 || !data.requirements.every(nonempty) || !nonempty(data.region)
    || !/^[a-z]+-[a-z]+\d$/u.test(data.region)
    || !['public', 'internal', 'confidential'].includes(String(data.dataClass)) || !traffic
    || !positive(traffic.monthlyRequests) || !positive(traffic.cpuSecondsPerRequest)
    || !positive(traffic.memoryGibSecondsPerRequest) || !positive(traffic.peakConcurrent)
    || !positive(traffic.targetLatencySeconds) || !nonnegative(traffic.monthlyNotifications)
    || !nonnegative(traffic.storageGib) || !nonnegative(traffic.egressGib) || !nonnegative(traffic.logGib))
    throw new Error('tiered design requires a classified requirement and explicit finite traffic assumptions');
  // Source: one requirement per OP design slot and the fixed-format seven-page PDF sample budget.
  if (data.title.trim().length > 80 || data.summary.trim().length > 200
    || data.requirements.length !== 1 || data.requirements.some((item: string) => item.trim().length > 160))
    throw new Error('tiered design prose exceeds the fixed-format PDF budget');
  return { title: data.title.trim(), summary: data.summary.trim(), requirements: data.requirements.map((item: string) => item.trim()),
    region: data.region.trim(), dataClass: data.dataClass as TieredRequirement['dataClass'],
    traffic: traffic as unknown as TieredRequirement['traffic'] };
}

function node(id: string, label: string, layer: string, zone: string, service: string, icon?: string) {
  return { id, label, layer, zone, service, ...(icon ? { icon } : {}) };
}
function flow(from: string, to: string, label: string, kind: 'sync' | 'async' | 'telemetry' = 'sync') {
  return { from, to, label, kind };
}

export function buildTieredDesigns(raw: unknown): { requirementHash: string; plans: TieredPlan[]; realGcpCalls: 0 } {
  const requirement = parseTieredRequirement(raw);
  const digest = createHash('sha256').update(JSON.stringify(requirement)).digest('hex');
  const t = requirement.traffic;
  // Source: synthetic per-instance concurrency, CPU and memory allocations for this comparison, not GCP quotas.
  const smallConcurrentPerInstance = 80;
  const mediumConcurrentPerInstance = 40;
  const smallVcpuPerInstance = 1;
  const smallGibPerInstance = 2;
  const mediumVcpuPerInstance = 2;
  const mediumGibPerInstance = 4;
  const gkeConcurrentPerNode = 50;
  const gkeVcpuPerNode = 2;
  const gkeGibPerNode = 8;
  const demandedVcpu = Math.ceil(t.peakConcurrent * t.cpuSecondsPerRequest / t.targetLatencySeconds);
  const demandedGib = Math.ceil(t.peakConcurrent * t.memoryGibSecondsPerRequest / t.targetLatencySeconds);
  const smallInstances = Math.max(Math.ceil(t.peakConcurrent / smallConcurrentPerInstance),
    Math.ceil(demandedVcpu / smallVcpuPerInstance), Math.ceil(demandedGib / smallGibPerInstance));
  const mediumInstances = Math.max(2, Math.ceil(t.peakConcurrent / mediumConcurrentPerInstance),
    Math.ceil(demandedVcpu / mediumVcpuPerInstance), Math.ceil(demandedGib / mediumGibPerInstance)); // Source: two-instance synthetic redundancy floor.
  const gkeNodes = Math.max(3, Math.ceil(t.peakConcurrent / gkeConcurrentPerNode),
    Math.ceil(demandedVcpu / gkeVcpuPerNode), Math.ceil(demandedGib / gkeGibPerNode)); // Source: three-node synthetic redundancy floor.
  const gkeVcpu = gkeNodes * gkeVcpuPerNode;
  const gkeGib = gkeNodes * gkeGibPerNode;
  const common = {
    compute: (t.monthlyRequests + t.monthlyNotifications) * (t.cpuSecondsPerRequest * SIM_RATES.cpuSecond
      + t.memoryGibSecondsPerRequest * SIM_RATES.memoryGibSecond + SIM_RATES.request),
    storage: t.storageGib * SIM_RATES.storageGibMonth,
    transfer: t.egressGib * SIM_RATES.egressGib + t.logGib * SIM_RATES.logGib,
    delivery: t.monthlyNotifications * SIM_RATES.deliveryMessage,
  };
  const costs: Record<CapacityTier, Array<{ item: string; formula: string; monthlyUsd: number }>> = {
    small: [
      { item: 'Cloud Run app + notification worker SIM', formula: '(monthlyRequests + monthlyNotifications) × (cpuSecondsPerRequest × simCpuRate + memoryGibSecondsPerRequest × simMemoryRate + simRequestRate)', monthlyUsd: money(common.compute) },
      { item: 'Cloud Tasks SIM', formula: '(monthlyNotifications / 1,000,000) × simTaskMillionRate', monthlyUsd: money(t.monthlyNotifications / 1_000_000 * SIM_RATES.taskMillion) }, // Source: synthetic per-million task unit.
      { item: 'Notification delivery adapter SIM', formula: 'monthlyNotifications × simDeliveryMessageRate', monthlyUsd: money(common.delivery) },
      { item: 'Cloud Storage SIM', formula: 'storageGib × simStorageRate', monthlyUsd: money(common.storage) },
      { item: 'network + logs SIM', formula: 'egressGib × simEgressRate + logGib × simLogRate', monthlyUsd: money(common.transfer) },
    ],
    medium: [
      { item: 'Cloud Run app + notification worker SIM', formula: '(monthlyRequests + monthlyNotifications) × (cpuSecondsPerRequest × simCpuRate + memoryGibSecondsPerRequest × simMemoryRate + simRequestRate)', monthlyUsd: money(common.compute) },
      { item: 'Cloud SQL SIM', formula: 'simMonthHours × simSqlHourlyRate', monthlyUsd: money(SIM_MONTH_HOURS * SIM_RATES.sqlHour) },
      { item: 'Memorystore SIM', formula: 'simMonthHours × simRedisHourlyRate', monthlyUsd: money(SIM_MONTH_HOURS * SIM_RATES.redisHour) },
      { item: 'Pub/Sub SIM', formula: '(monthlyNotifications / 1,000,000) × simPubsubMillionRate', monthlyUsd: money(t.monthlyNotifications / 1_000_000 * SIM_RATES.pubsubMillion) }, // Source: synthetic per-million message unit.
      { item: 'Notification delivery adapter SIM', formula: 'monthlyNotifications × simDeliveryMessageRate', monthlyUsd: money(common.delivery) },
      { item: 'storage + network + logs SIM', formula: 'storageGib × simStorageRate + egressGib × simEgressRate + logGib × simLogRate', monthlyUsd: money(common.storage + common.transfer) },
    ],
    large: [
      { item: 'GKE Standard app + notification worker SIM', formula: 'simMonthHours × (gkeVcpu × simGkeVcpuRate + gkeGib × simGkeGibRate)', monthlyUsd: money(SIM_MONTH_HOURS * (gkeVcpu * SIM_RATES.gkeVcpuHour + gkeGib * SIM_RATES.gkeGibHour)) },
      { item: 'Spanner SIM', formula: 'simMonthHours × simSpannerHourlyRate', monthlyUsd: money(SIM_MONTH_HOURS * SIM_RATES.spannerHour) },
      { item: 'Pub/Sub SIM', formula: '(monthlyNotifications / 1,000,000) × simPubsubMillionRate', monthlyUsd: money(t.monthlyNotifications / 1_000_000 * SIM_RATES.pubsubMillion) }, // Source: synthetic per-million message unit.
      { item: 'Notification delivery adapter SIM', formula: 'monthlyNotifications × simDeliveryMessageRate', monthlyUsd: money(common.delivery) },
      { item: 'storage + network + logs SIM', formula: 'storageGib × simStorageRate + egressGib × simEgressRate + logGib × simLogRate', monthlyUsd: money(common.storage + common.transfer) },
    ],
  };
  const services: Record<CapacityTier, string[]> = {
    small: ['Cloud Run', 'Cloud Tasks', 'Cloud Storage', 'Cloud Monitoring'],
    medium: ['Cloud Run', 'Cloud SQL', 'Memorystore', 'Pub/Sub', 'Cloud Monitoring'],
    large: ['Cloud CDN', 'GKE Standard', 'Spanner', 'Pub/Sub', 'Cloud Monitoring'],
  };
  const tiers = ['small', 'medium', 'large'] as const;
  const plans = tiers.map((tier): TieredPlan => {
    const large = tier === 'large';
    const medium = tier === 'medium';
    const dataNode = large ? node('database', 'Durable data', 'data', 'project', 'Spanner', ICON.spanner)
      : medium ? node('database', 'Durable data', 'data', 'project', 'Cloud SQL', ICON.sql)
        : node('storage', 'Object data', 'data', 'project', 'Cloud Storage', ICON.storage);
    const dataId = large || medium ? 'database' : 'storage';
    const nodes = [node('users', 'Users', 'users', 'external', 'Browser clients'),
      node('edge', 'Ingress', 'edge', 'project', large ? 'Cloud CDN' : 'HTTPS ingress', ICON.network),
      node('app', 'Application', 'application', large ? 'vpc' : 'project', large ? 'GKE Standard' : 'Cloud Run', large ? ICON.gke : ICON.run),
      dataNode,
      ...(medium ? [node('cache', 'Hot data', 'data', 'project', 'Memorystore', ICON.database)] : []),
      node('events', 'Change events', 'data', 'project', large || medium ? 'Pub/Sub' : 'Cloud Tasks', ICON.integration),
      node('worker', 'Notification worker', 'application', large ? 'vpc' : 'project', large ? 'GKE Standard' : 'Cloud Run', large ? ICON.gke : ICON.run),
      node('delivery', 'Message delivery', 'edge', 'external', 'External notification adapter', ICON.integration),
      node('observe', 'Telemetry', 'observability', 'project', 'Cloud Monitoring', ICON.observe),
      node('security', 'Trust controls', 'security', 'external', 'IAM + encryption', ICON.security)];
    const flows = [flow('users', 'edge', 'TLS request'), flow('edge', 'app', 'routed request'),
      flow('app', dataId, 'read and write'),
      ...(medium ? [flow('app', 'cache', 'cache access')] : []),
      flow('app', 'events', 'publish change event', 'async'),
      flow('events', 'worker', 'consume and retry', 'async'),
      flow('worker', 'delivery', 'send notification', 'async'),
      flow('delivery', 'users', 'changed reservation alert', 'async'),
      flow('app', 'observe', 'metrics and logs', 'telemetry')];
    const monthlySimUsd = money(costs[tier].reduce((sum, row) => sum + row.monthlyUsd, 0)); // Source: sum of synthetic cost rows, zero is the additive identity.
    const design = {
      schemaVersion: 1, // Source: plugins/architecture-deliverables/references/structured-design.schema.json.
      title: `${requirement.title} — ${tier.toUpperCase()} SIM`, version: '1.0', // Source: structured-design schema version format.
      summary: `${requirement.summary} This is a simulated cost comparison, not a GCP quote.`,
      background: `One requirement and its declared traffic assumptions produce three capacity choices. Rates are synthetic only; verify official regional SKUs before approval.`,
      deployment: { provider: 'gcp', project: `elanous-${tier}-sim`, region: requirement.region, vpc: `${tier}-vpc` },
      nodes, flows,
      requirements: requirement.requirements.map((statement, index) => ({ id: `R${index + 1}`, kind: 'user', statement,
        verification: 'Review against measured workload before deployment' })), // Source: one-based requirement IDs in the PDF table.
      security: [{ class: requirement.dataClass, data: 'Declared workload data', controls: 'Least privilege, encryption, audit logging' }],
      capacity: [
        { item: 'monthly requests', assumption: String(t.monthlyRequests), verification: 'Measure request count' },
        { item: 'monthly notifications', assumption: String(t.monthlyNotifications), verification: 'Measure delivered messages and retries' },
        { item: 'peak concurrent / latency target', assumption: `${t.peakConcurrent} / ${t.targetLatencySeconds}s`, verification: 'Load test and revise tier' },
        { item: 'compute allocation', assumption: large ? `${gkeNodes} synthetic GKE Standard nodes × ${gkeVcpuPerNode} vCPU / ${gkeGibPerNode} GiB`
          : `${medium ? mediumInstances : smallInstances} Cloud Run max instances; ${medium ? mediumConcurrentPerInstance : smallConcurrentPerInstance} concurrent, ${medium ? mediumVcpuPerInstance : smallVcpuPerInstance} vCPU / ${medium ? mediumGibPerInstance : smallGibPerInstance} GiB each`, // Source: synthetic concurrency and resource allocations above.
          verification: 'Load test CPU, memory, concurrency and retries before deployment' },
        { item: 'data volume GiB', assumption: String(t.storageGib), verification: 'Measure stored bytes' },
      ],
      costs: costs[tier],
      savings: [{ name: tier === 'small' ? 'Scale to zero' : 'Right-size', mechanism: tier === 'small' ? 'Request-based Cloud Run' : 'Measure actual utilization',
        guardrail: 'Check minimum instances and non-compute resources' }],
      alternatives: tiers.filter(other => other !== tier).map(other => ({ name: other.toUpperCase(), when: 'Traffic or reliability need changes',
        tradeoff: 'Re-evaluate service capability and official price' })),
      decisions: [{ id: 'ADR-1', decision: `Present ${tier} as an option`, rationale: 'Matches one capacity step in the simulated comparison',
        revisit: 'Before any real deployment or price quote' }], // Source: first decision record for this simulated design.
      references: [{ title: 'GCP architect decision table', url: 'packs/gcp-architect-expand/content/decision-table.md' },
        { title: 'Official Cloud Billing Catalog API', url: 'https://docs.cloud.google.com/billing/v1/how-tos/catalog-api' }],
      simulation: { requirementHash: digest, tier, costStatus: 'synthetic-only', monthlySimUsd,
        rateSource: 'synthetic fixture in src/ux-sim/gcp-architect-expand/tiered-design.ts', rates: SIM_RATES,
        traffic: t, costVariables: { monthlyRequests: t.monthlyRequests, monthlyNotifications: t.monthlyNotifications,
          cpuSecondsPerRequest: t.cpuSecondsPerRequest, memoryGibSecondsPerRequest: t.memoryGibSecondsPerRequest,
          storageGib: t.storageGib, egressGib: t.egressGib, logGib: t.logGib,
          simCpuRate: SIM_RATES.cpuSecond, simMemoryRate: SIM_RATES.memoryGibSecond,
          simRequestRate: SIM_RATES.request, simStorageRate: SIM_RATES.storageGibMonth,
          simSqlHourlyRate: SIM_RATES.sqlHour, simRedisHourlyRate: SIM_RATES.redisHour,
          simGkeVcpuRate: SIM_RATES.gkeVcpuHour, simGkeGibRate: SIM_RATES.gkeGibHour,
          simSpannerHourlyRate: SIM_RATES.spannerHour, simPubsubMillionRate: SIM_RATES.pubsubMillion,
          simTaskMillionRate: SIM_RATES.taskMillion, simDeliveryMessageRate: SIM_RATES.deliveryMessage,
          simEgressRate: SIM_RATES.egressGib, simLogRate: SIM_RATES.logGib,
          simMonthHours: SIM_MONTH_HOURS, smallConcurrentPerInstance, mediumConcurrentPerInstance,
          smallVcpuPerInstance, smallGibPerInstance, mediumVcpuPerInstance, mediumGibPerInstance,
          gkeConcurrentPerNode, gkeVcpuPerNode, gkeGibPerNode, demandedVcpu, demandedGib,
          smallInstances, mediumInstances, gkeNodes, gkeVcpu, gkeGib },
        realGcpCalls: 0 }, // Source: offline simulation has no Google Cloud invocation.
    };
    return { tier, id: `${digest.slice(0, 12)}-${tier}`, services: services[tier], monthlySimUsd,
      costStatus: 'synthetic-only', design };
  });
  return { requirementHash: digest, plans, realGcpCalls: 0 }; // Source: offline design generator contains no cloud call.
}
