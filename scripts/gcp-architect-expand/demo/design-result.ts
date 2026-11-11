/** Projection from the general architect's structured JSON into a GCP proposal input. */
export interface DesignAssumption {
  field: string;
  value: unknown;
  source: 'gcp-adapter-default';
  requiresConfirmation: true;
}
export type TicketDesign = {
  schemaVersion: 1; sourceKind: string; title: string; summary: string; requirements: string[];
  localComponents: string[]; offloadWorkload: string; offloadKind: 'batch'; retryable: true;
  checkpointable: true; exportData: string; containsPii: false; dataClass: 'public' | 'internal';
  region: string; usage: { vcpuHours: number; gibHours: number };
  assumptions: DesignAssumption[]; sourceSessionId?: string; sourceGraphRunId?: string;
};
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const phrase = (value: unknown): string => nonempty(value) ? value.trim() : '';
function phrases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === 'string' ? item : phrase(record(item)?.name)
    || phrase(record(item)?.label) || phrase(record(item)?.statement)
    || phrase(record(item)?.description) || phrase(record(item)?.text)).map(item => item.trim()).filter(Boolean);
}
function candidates(value: unknown, depth = 0): Array<Record<string, unknown>> {
  const object = record(value);
  if (!object || depth > 4) return [];
  const nested = ['ticketDesign', 'designResult', 'design', 'architecture', 'systemDesign', 'result']
    .flatMap(key => candidates(object[key], depth + 1));
  return [...nested, object];
}

/** Explicit unsafe values reject; absent batch/export fields become visible, unconfirmed assumptions. */
export function ticketDesignFromArchitectureJson(raw: unknown): TicketDesign {
  const root = record(raw);
  if (!root) throw new Error('architecture design JSON must be an object');
  if (record(root.ticketDesign) && ('inputSha256' in root || 'estimate' in root))
    throw new Error('GCP proposal output cannot be used as Scene 4 design input');
  const found = candidates(root);
  if (Array.isArray(root.nodes)) {
    for (const node of root.nodes) {
      const item = record(node);
      if (!item || !['design', 'architecture-design', 'system-design'].includes(String(item.nodeId))) continue;
      let output: unknown = item.output;
      if (typeof output === 'string') {
        try { output = JSON.parse(output); } catch { throw new Error('design graph node output is not structured JSON'); }
      }
      found.push(...candidates(output));
    }
  }
  const design = found.find(item => phrase(item.title || item.name) && phrase(item.summary || item.overview))
    ?? found.find(item => phrase(item.title || item.name));
  if (!design) throw new Error('architecture result has no structured design title');
  const title = phrase(design.title || design.name);
  const summary = phrase(design.summary || design.overview || design.description);
  const requirements = phrases(design.requirements);
  const localComponents = design.localComponents !== undefined || design.components !== undefined
    ? phrases(design.localComponents ?? design.components)
    : Array.isArray(design.nodes) ? phrases(design.nodes.filter(node => {
      const item = record(node);
      return item && ['application', 'data', 'observability'].includes(String(item.layer)) && item.zone !== 'external';
    })) : [];
  if (!title || !summary || requirements.length < 3 || !localComponents.length)
    throw new Error('architecture result lacks title, summary, three requirements, or named components');
  const assumptions: DesignAssumption[] = [];
  const assume = <T>(field: string, value: T): T => {
    assumptions.push({ field, value, source: 'gcp-adapter-default', requiresConfirmation: true });
    return value;
  };
  const offloadKind = design.offloadKind === undefined ? assume('offloadKind', 'batch' as const) : design.offloadKind;
  const retryable = design.retryable === undefined ? assume('retryable', true as const) : design.retryable;
  const checkpointable = design.checkpointable === undefined ? assume('checkpointable', true as const) : design.checkpointable;
  const containsPii = design.containsPii === undefined ? assume('containsPii', false as const) : design.containsPii;
  const dataClass = design.dataClass === undefined ? assume('dataClass', 'internal' as const) : design.dataClass;
  const exportData = design.exportData === undefined ? assume('exportData', '식별자 제거된 집계 이벤트' as const) : design.exportData;
  const offloadWorkload = design.offloadWorkload === undefined
    ? assume('offloadWorkload', '비식별 이벤트 집계·리포트 생성' as const) : design.offloadWorkload;
  const region = design.region === undefined ? assume('region', 'asia-northeast3' as const) : design.region;
  const usage = record(design.usage);
  const vcpuHours = usage?.vcpuHours === undefined ? assume('usage.vcpuHours', 4) : usage.vcpuHours;
  const gibHours = usage?.gibHours === undefined ? assume('usage.gibHours', 8) : usage.gibHours;
  if (offloadKind !== 'batch' || retryable !== true || checkpointable !== true || containsPii !== false ||
      !['public', 'internal'].includes(String(dataClass)) || !phrase(exportData) || !phrase(offloadWorkload) ||
      !phrase(region) || !positive(vcpuHours) || !positive(gibHours)) {
    throw new Error('ticketing purchase or sensitive path cannot be moved: explicit design value conflicts with safe batch proposal');
  }
  const source = record(root.source);
  return { schemaVersion: 1, sourceKind: phrase(design.sourceKind) || phrase(source?.kind) || 'structured-architecture-design-json',
    title, summary, requirements, localComponents, offloadWorkload: phrase(offloadWorkload), offloadKind, retryable, checkpointable,
    exportData: phrase(exportData), containsPii, dataClass: dataClass as 'public' | 'internal', region: phrase(region), usage: { vcpuHours, gibHours },
    assumptions,
    ...(phrase(design.sourceSessionId) || phrase(source?.sessionId) ? { sourceSessionId: phrase(design.sourceSessionId) || phrase(source?.sessionId) } : {}),
    ...(phrase(design.sourceGraphRunId) || phrase(root.runId) ? { sourceGraphRunId: phrase(design.sourceGraphRunId) || phrase(root.runId) } : {}),
  };
}
