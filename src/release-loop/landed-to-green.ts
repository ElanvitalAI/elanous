import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';

export interface JudgeSignal { condition: string | null; observe: string | null; expect: string | null }
export type ClassifiedSignal = { kind: 'measurable'; argv: string[] } | { kind: 'unmeasurable'; reason: string };
export type GreenVerdict = 'proposed' | 'unmeasurable' | 'not-passed';
export interface LandedCell { version: string; id: string; title: string; pr: number }
export interface LandedGreenDeps {
  cwd?: string;
  ledgerRoot?: string;
  run?: (argv: string[], cwd: string) => number;
  log?: typeof debug.log;
}

/** Only a field label after a semicolon starts a new field; unknown tails stay attached to the observation. */
export function parseJudgeSignals(text: string): JudgeSignal[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*판정 신호:\s*(.*)$/.exec(line);
    if (!match) return [];
    const signal: JudgeSignal = { condition: null, observe: null, expect: null };
    const body = match[1]!;
    const fields = [...body.matchAll(/(?:^|;)\s*(조건|관측|기대)\s*=/g)];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const value = body.slice(field.index! + field[0].length, fields[i + 1]?.index ?? body.length).trim();
      const key = ({ 조건: 'condition', 관측: 'observe', 기대: 'expect' } as const)[field[1] as '조건' | '관측' | '기대'];
      signal[key] = value || null;
    }
    return [signal];
  });
}

export function classifySignal(signal: JudgeSignal): ClassifiedSignal {
  const observe = signal.observe?.trim();
  if (!observe || /[;|&$`<>]/.test(observe)) return { kind: 'unmeasurable', reason: 'missing observation or shell metacharacter' };
  const argv = observe.split(/\s+/);
  if (argv.length < 3 || argv[0] !== 'bun' || argv[1] !== 'test' || argv.slice(2).some((path) => !path.endsWith('.test.ts') || path.startsWith('-'))) {
    return { kind: 'unmeasurable', reason: 'observation is not bun test with .test.ts paths' };
  }
  return { kind: 'measurable', argv };
}

function runTest(argv: string[], cwd: string): number {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, shell: false, timeout: 120_000, stdio: 'ignore' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Proposals are evidence, never a checklist status transition. All I/O errors are observed and swallowed. */
export function judgeLandedCell({ version, id, title, pr }: LandedCell, deps: LandedGreenDeps = {}): GreenVerdict | undefined {
  const log = deps.log ?? debug.log.bind(debug);
  try {
    const signals = parseJudgeSignals(title);
    const classified = signals.map(classifySignal);
    let verdict: GreenVerdict;
    let reason: string | undefined;
    if (!signals.length || classified.some((signal) => signal.kind === 'unmeasurable')) {
      verdict = 'unmeasurable';
      reason = !signals.length ? 'no judge signals' : classified.find((signal) => signal.kind === 'unmeasurable')!.reason;
    } else {
      verdict = 'proposed';
      for (const signal of classified) {
        if (signal.kind !== 'measurable' || (deps.run ?? runTest)(signal.argv, deps.cwd ?? process.cwd()) !== 0) {
          verdict = 'not-passed';
          break;
        }
      }
    }
    const dir = join(deps.ledgerRoot ?? releaseLedgerRoot(), 'release', version);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'green-proposals.jsonl'), JSON.stringify({ at: new Date().toISOString(), version, id, pr, verdict, signals, ...(reason ? { reason } : {}) }) + '\n');
    log('release.checklist', `landed-green-${verdict}`, { version, id, pr, verdict, signals, ...(reason ? { reason } : {}) });
    return verdict;
  } catch (error) {
    try { log('release.checklist', 'landed-green-error', { version, id, pr, error: String(error) }); } catch { /* Logging must not break the merge path. */ }
    return undefined;
  }
}
