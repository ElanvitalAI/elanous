import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Structural input from guardHotspotStart in the open #35929 change. */
export interface HotspotStartObservation {
  readonly status: 'allow' | 'refuse' | 'unknown';
  readonly hotspots: readonly { file: string; prs: readonly { number: number; headSha: string }[] }[];
  readonly reason?: string;
  readonly approval?: string;
}

export interface HotspotStartForecastRow {
  readonly schema: 'conflict-forecast.v1';
  readonly at: string;
  readonly kind: 'pr-overlap';
  readonly detector: 'open-guard';
  readonly pr: null;
  readonly head: null;
  readonly base: string;
  readonly otherPr: number | null;
  readonly files: string[];
  readonly conflict: null;
  readonly owner: string | null;
  readonly unmeasuredReason?: string;
}

function appendDefault(row: HotspotStartForecastRow): void {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is unavailable for hotspot start forecast');
  const path = join(home, 'elanous-hq/seat-state/OP/train-manager/conflict-forecast.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** Record a planned-file guard's observed peers without claiming a merge conflict was measured. */
export function recordHotspotStartForecast(input: {
  base: string;
  owner?: string | null;
  verdict: HotspotStartObservation;
  now?: () => Date;
  append?: (row: HotspotStartForecastRow) => void;
}): HotspotStartForecastRow[] {
  // Source: conflict-forecast.v1 head/base identity contract in RFC-train-manager-loop-agent.md §3c.
  if (!/^[a-f0-9]{40}$/i.test(input.base)) throw new Error('hotspot forecast base must be a SHA');
  const at = (input.now?.() ?? new Date()).toISOString();
  const observations = input.verdict.status === 'unknown'
    ? [{ otherPr: null, files: [] as string[], unmeasuredReason: input.verdict.reason ?? 'open-guard-unknown' }]
    : input.verdict.hotspots.flatMap(hotspot => hotspot.prs.map(peer => ({ otherPr: peer.number, files: [hotspot.file] })));
  const rows = observations.map(observation => ({
    schema: 'conflict-forecast.v1' as const, at, kind: 'pr-overlap' as const, detector: 'open-guard' as const,
    pr: null, head: null, base: input.base, otherPr: observation.otherPr, files: observation.files,
    conflict: null, owner: input.owner ?? null,
    ...('unmeasuredReason' in observation ? { unmeasuredReason: observation.unmeasuredReason } : {}),
  }));
  for (const row of rows) (input.append ?? appendDefault)(row);
  return rows;
}
