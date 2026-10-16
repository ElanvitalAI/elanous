import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TrainLanding {
  componentPr: number;
  integrationPr: number;
  mergeSha: string;
  train: string;
}

interface TrainLedgerRow extends Omit<TrainLanding, 'mergeSha'> { mergePrefix: string }

/** HQ train ledger is advisory until the integration PR's exact merge commit is verified. */
export function trainLedgerPath(): string {
  return process.env.ELANOUS_TRAIN_LEDGER_PATH || join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'train-ledger.tsv');
}

export function trainLedgerComponent(text: string, componentPr: number): TrainLedgerRow | null {
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== 'time\ttrain\tintegrationPr\tmergeSha\tcomponentPrs\tsideHost\tresult') return null;
  let matched: TrainLedgerRow | null = null;
  let matchedLine: string | null = null;
  for (const line of lines) {
    const fields = line.split('\t');
    if (fields.length !== 7) return null;
    const integrationPr = Number(fields[2]);
    const mergePrefix = fields[3]?.toLowerCase() ?? '';
    const componentPrs = (fields[4] ?? '').split(',').map(Number);
    if (!componentPrs.every((pr) => Number.isSafeInteger(pr) && pr > 0)) return null;
    if (!componentPrs.includes(componentPr)) continue;
    if (fields[6] !== 'merged' || !Number.isSafeInteger(integrationPr) || integrationPr <= 0
      || !/^[a-f0-9]{12,40}$/.test(mergePrefix)) return null;
    const row = { componentPr, integrationPr, mergePrefix, train: fields[1] ?? '' };
    if (matchedLine !== null && matchedLine !== line) return null;
    matched = row;
    matchedLine = line;
  }
  return matched;
}

export type TrainPrView = (pr: number, cwd: string) => { state: string; mergeSha?: string } | null;

export function defaultTrainPrView(pr: number, cwd: string): ReturnType<TrainPrView> {
  const run = (env: NodeJS.ProcessEnv) => spawnSync('gh', ['pr', 'view', String(pr), '--json', 'state,mergeCommit'],
    { cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 512 * 1024 });
  let result = run(process.env);
  if (result.status !== 0) {
    const noProxy = { ...process.env };
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete noProxy[key];
    result = run(noProxy);
  }
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { state?: unknown; mergeCommit?: { oid?: unknown } };
    return typeof parsed.state === 'string' && typeof parsed.mergeCommit?.oid === 'string'
      ? { state: parsed.state, mergeSha: parsed.mergeCommit.oid } : null;
  } catch { return null; }
}

export function verifiedTrainLanding(componentPr: number, cwd: string, opts: {
  ledgerText?: string;
  readLedger?: () => string;
  trainPrView?: TrainPrView;
} = {}): TrainLanding | null {
  let ledger: string;
  try { ledger = opts.ledgerText ?? (opts.readLedger ?? (() => readFileSync(trainLedgerPath(), 'utf8')))(); }
  catch { return null; }
  const row = trainLedgerComponent(ledger, componentPr);
  if (!row) return null;
  let view: ReturnType<TrainPrView>;
  try { view = (opts.trainPrView ?? defaultTrainPrView)(row.integrationPr, cwd); } catch { return null; }
  const mergeSha = view?.mergeSha?.toLowerCase();
  return view?.state === 'MERGED' && mergeSha && /^[a-f0-9]{40}$/.test(mergeSha) && mergeSha.startsWith(row.mergePrefix)
    ? { componentPr, integrationPr: row.integrationPr, mergeSha, train: row.train } : null;
}
