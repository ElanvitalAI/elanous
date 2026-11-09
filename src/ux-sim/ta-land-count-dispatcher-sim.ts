/**
 * Test-only boundary for the OP TA dispatcher consuming `eln tasks land-count --json`.
 * It parses only an injected command receipt; it never launches a process, reads a
 * ledger, or starts a task itself.
 */
export interface LandCountCommandEvidence {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LandCountJson {
  readonly count: number | null;
  readonly active: readonly string[];
  readonly terminal: readonly string[];
  readonly unknown: readonly string[];
  readonly error?: string;
}

export interface TaLandCountDispatchInput {
  readonly target: number;
  readonly command: LandCountCommandEvidence;
}

export interface TaLandCountDispatchResult {
  readonly decision: {
    readonly dispatch: boolean;
    readonly activeCount: number | null;
    readonly remaining: number | null;
    readonly reason: 'capacity-available' | 'capacity-full' | 'count-unavailable' | 'invalid-count-evidence' | 'invalid-command' | 'invalid-target';
  };
  /** Raw CLI receipt is preserved alongside the parsed evidence for audit. */
  readonly evidence: {
    readonly command: LandCountCommandEvidence;
    readonly parsed: LandCountJson | null;
    readonly countedIds: readonly string[];
  };
}

const EXPECTED_ARGV = ['eln', 'tasks', 'land-count', '--json'] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function parseLandCount(stdout: string): LandCountJson | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (value.count !== null && (!Number.isInteger(value.count) || Number(value.count) < 0)) return null;
    if (!isStringArray(value.active) || !isStringArray(value.terminal) || !isStringArray(value.unknown)) return null;
    if (value.error !== undefined && typeof value.error !== 'string') return null;
    return {
      count: value.count as number | null,
      active: value.active,
      terminal: value.terminal,
      unknown: value.unknown,
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    };
  } catch {
    return null;
  }
}

/** Replays the dispatcher decision after consuming one captured land-count CLI result. */
export function simulateTaLandCountDispatch(input: TaLandCountDispatchInput): TaLandCountDispatchResult {
  const evidence = { command: input.command, parsed: parseLandCount(input.command.stdout), countedIds: [] as string[] };
  const refuse = (reason: TaLandCountDispatchResult['decision']['reason'], activeCount: number | null = null): TaLandCountDispatchResult => ({
    decision: { dispatch: false, activeCount, remaining: null, reason },
    evidence,
  });

  if (input.command.argv.length !== EXPECTED_ARGV.length || input.command.argv.some((arg, index) => arg !== EXPECTED_ARGV[index])) return refuse('invalid-command');
  if (!Number.isInteger(input.target) || input.target <= 0) return refuse('invalid-target');
  if (input.command.exitCode !== 0 || evidence.parsed?.error !== undefined || evidence.parsed?.count === null || evidence.parsed?.unknown.length) return refuse('count-unavailable');

  const parsed = evidence.parsed;
  if (!parsed || parsed.count === null || parsed.count !== parsed.active.length || new Set(parsed.active).size !== parsed.active.length) return refuse('invalid-count-evidence');
  evidence.countedIds = [...parsed.active];
  const activeCount = parsed.count;
  const remaining = Math.max(0, input.target - activeCount);
  return {
    decision: {
      dispatch: activeCount < input.target,
      activeCount,
      remaining,
      reason: activeCount < input.target ? 'capacity-available' : 'capacity-full',
    },
    evidence,
  };
}
