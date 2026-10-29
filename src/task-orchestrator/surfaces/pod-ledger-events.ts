import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Capture a failed Job against its recorded placement, never the caller's current kubectl context. */
export function captureFailedPodJobs(input: {
  runId: string;
  job: string;
  childRunId?: string;
  ledgerPath: string;
  artifactDir: string;
  kubectl: (host: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  record: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
}): void {
  const { runId, job, ledgerPath, artifactDir, kubectl, record } = input;
  const capturedAt = new Date((input.now ?? Date.now)()).toISOString();
  const base = { runId, job, capturedAt };
  const finish = (outcome: 'collected' | 'failed' | 'vanished', reason: string, extra: Record<string, unknown> = {}) =>
    record('pod-failure-capture', { ...base, ...extra, outcome, reason });
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(job)) { finish('failed', 'job-invalid'); return; }
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) { finish('failed', 'run-id-invalid'); return; }
  let rows: Array<{ runId?: string; event?: string; data?: Record<string, unknown> }>;
  try {
    rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('invalid ledger row');
  } catch { finish('failed', 'ledger-unavailable'); return; }
  if (rows.some(row => row.runId !== runId)) { finish('failed', 'ledger-run-mismatch'); return; }
  const placements = rows.filter(row => row.event === 'pod-job-applied' && row.data?.job === job).map(row => row.data!);
  if (!placements.length || placements.some(p => !['host', 'context', 'namespace', 'childRunId'].every(key => typeof p[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(p[key] as string))
    || typeof p.jobUid !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(p.jobUid))) {
    finish('failed', 'placement-incomplete'); return;
  }
  const selected = input.childRunId ? placements.filter(p => p.childRunId === input.childRunId) : placements;
  if (!selected.length) { finish('failed', 'placement-incomplete'); return; }
  const first = selected[0]!;
  if (placements.some(p => ['host', 'context', 'namespace'].some(key => p[key] !== first[key]))
    || selected.some(p => ['childRunId', 'jobUid'].some(key => p[key] !== first[key]))) {
    finish('failed', 'placement-conflict'); return;
  }
  const location = { host: first.host, context: first.context, namespace: first.namespace, childRunId: first.childRunId, jobUid: first.jobUid };
  const evidenceDir = join(artifactDir, 'pod-failure-capture', runId, job, first.childRunId as string);
  // A failed kubectl/SSH read is itself the missing diagnostic. Keep its stderr in
  // the private artifact directory and put only the path and exit status in the ledger.
  const readFailure = (reason: string, result: { status: number | null; stderr: string }, extra: Record<string, unknown> = {}): void => {
    let stderrEvidence: string | null = null;
    let stderrCaptureStatus: 'saved' | 'redacted' | 'empty' | 'write-failed' = result.stderr ? 'saved' : 'empty';
    if (result.stderr) {
      try {
        mkdirSync(evidenceDir, { recursive: true });
        const tail = result.stderr.slice(-8192).split(/\r?\n/).map(line => {
          if (!SECRET_VALUE.test(line)) return line;
          stderrCaptureStatus = 'redacted';
          return '[redacted credential line]';
        }).join('\n');
        const digest = createHash('sha256').update(tail).digest('hex').slice(0, 16);
        stderrEvidence = join(evidenceDir, `${reason}-${digest}.stderr.log`);
        try { writeFileSync(stderrEvidence, tail, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(stderrEvidence, 'utf8') !== tail) throw error;
        }
      } catch { stderrEvidence = null; stderrCaptureStatus = 'write-failed'; }
    }
    finish('failed', reason, { ...location, ...extra, kubectlStatus: result.status, stderrEvidence, stderrCaptureStatus });
  };
  const previous = rows.find(row => row.event === 'pod-failure-capture' && row.data?.job === job && row.data?.outcome === 'collected'
    && row.data.childRunId === first.childRunId && row.data.jobUid === first.jobUid
    && row.data.host === first.host && row.data.context === first.context && row.data.namespace === first.namespace);
  // A ledger row describes a prior collection; it does not guarantee that its files survived.
  // Check all three expected paths before treating it as complete, then recapture any missing evidence.
  if (previous && ([['jobEvidence', 'job.json'], ['podEvidence', 'pods.json'], ['logEvidence', 'child.log']] as const)
    .every(([field, filename]) => {
      const path = join(evidenceDir, filename);
      if (previous.data?.[field] !== path) return false;
      try { return statSync(path).isFile(); } catch { return false; }
    })) return;
  const args = ['--context', first.context as string, '-n', first.namespace as string] as const;
  try {
    const jobResult = kubectl(first.host as string, [...args, 'get', 'job', job, '-o', 'json']);
    if (jobResult.status !== 0) {
      if (/\bNotFound\b|not found/i.test(jobResult.stderr)) finish('vanished', 'job-not-found', { ...location, kubectlStatus: jobResult.status });
      else readFailure('job-read-failed', jobResult);
      return;
    }
    const jobBody = JSON.parse(jobResult.stdout) as { metadata?: { name?: string; uid?: string } };
    if (jobBody.metadata?.name !== job || jobBody.metadata.uid !== first.jobUid) { finish('failed', 'job-identity-mismatch', location); return; }
    mkdirSync(evidenceDir, { recursive: true });
    const save = (filename: string, bytes: string, sameJob?: (existing: string) => boolean): string => {
      const path = join(evidenceDir, filename);
      try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = readFileSync(path, 'utf8');
        if (existing !== bytes && !sameJob?.(existing)) throw error;
      }
      return path;
    };
    const jobEvidence = save('job.json', jobResult.stdout, existing => {
      try {
        const metadata = (JSON.parse(existing) as { metadata?: { name?: string; uid?: string } }).metadata;
        return metadata?.name === job && metadata.uid === first.jobUid;
      } catch { return false; }
    });
    const podResult = kubectl(first.host as string, [...args, 'get', 'pods', '-l', `job-name=${job}`, '-o', 'json']);
    if (podResult.status !== 0) { readFailure('pods-read-failed', podResult, { jobEvidence }); return; }
    const pods = JSON.parse(podResult.stdout) as { items?: Array<{ metadata?: { name?: string; ownerReferences?: Array<{ uid?: string }> } }> };
    if (!pods.items?.length || pods.items.some(p => !p.metadata?.ownerReferences?.some(owner => owner.uid === jobBody.metadata?.uid))) {
      finish('failed', 'pod-owner-mismatch', { ...location, jobEvidence }); return;
    }
    const podEvidence = save('pods.json', podResult.stdout);
    const podName = pods.items[0]?.metadata?.name;
    if (pods.items.length !== 1 || !podName || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(podName)) {
      finish('failed', 'pod-ambiguous', { ...location, jobEvidence, podEvidence }); return;
    }
    const logs = kubectl(first.host as string, [...args, 'logs', `pod/${podName}`, '-c', 'child']);
    if (logs.status !== 0) { readFailure('logs-read-failed', logs, { jobEvidence, podEvidence }); return; }
    if (!logs.stdout.trim()) { finish('failed', 'logs-empty', { ...location, jobEvidence, podEvidence }); return; }
    const logEvidence = save('child.log', logs.stdout);
    finish('collected', 'job-failed', { ...location, jobEvidence, podEvidence, logEvidence });
  } catch { finish('failed', 'capture-error', location); }
}

const SECRET_FIELD = /token|secret|password|authorization|key/i;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+\S+|\b(?:token|secret|password|authorization|api[-_]?key|access[-_]?key|private[-_]?key)\b\s*(?:is|[=:])\s*["']?\S+|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}))\b/i;
const MAX_FIELDS = 32;
// Review R2: only lifecycle events the host needs to see, and no free text. Event names must start with a known
// lifecycle prefix; string fields survive only when they are short code-like values in a fixed set of keys.
const EVENT_ALLOWED = /^(?:gate|gated|review|reviewed|repair|repaired|rework|merge|merged|pr|land|landed|stage|round|supervisor|child|plan|planned|decompose|decomposed|shard|stall|harvest|decision|run|pipeline|progress|human|start|started|finish|finished|done|implement|implemented|commit|test|typecheck)(?:-(?:started|finished|round|opened|closed|failed|passed|blocked|done|entry|node|outcome|delivery|decision|stop|merged|ready|requested|resolved|result|fix|must-fix|verdict|skipped|origin|cleared))*$/;
const CODE_FIELDS = new Set(['stage', 'outcome', 'verdict', 'status', 'kind', 'phase', 'role', 'result']);
const CODE_VALUE = /^[a-z0-9_.:-]{1,40}$/i;

function secretValues(root: Record<string, unknown>): string[] {
  const secrets: string[] = [];
  const pending: unknown[] = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [name, value] of Object.entries(current)) {
      if (SECRET_FIELD.test(name) && typeof value === 'string' && value.length >= 3) secrets.push(value);
      if (value && typeof value === 'object') pending.push(value);
    }
  }
  return secrets;
}

/** Project bounded ledger metadata, excluding named secrets and recognizable credential values. */
export function ledgerLineToLogEvent(line: string, runId: string): {
  category: string;
  event: string;
  data: Record<string, unknown>;
} | undefined {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return undefined; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !('event' in entry) || typeof entry.event !== 'string') return undefined;
  // The real run-ledger writer wraps observer fields in `data`; older/synthetic lines can be flat.
  const details = 'data' in entry && entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
    ? entry.data as Record<string, unknown> : undefined;
  const sources = [entry, details].filter((source): source is Record<string, unknown> => source !== undefined);
  const knownSecrets = secretValues(entry);
  const containsCredential = (value: string) => SECRET_VALUE.test(value) || knownSecrets.some((secret) => value.includes(secret));
  if (containsCredential(entry.event) || (!EVENT_ALLOWED.test(entry.event) && entry.event !== 'ask-auto-target-candidates' && entry.event !== 'ask-auto-reauthor')) return undefined;

  const data: Record<string, unknown> = { runId };
  let fields = 0;
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (name === 'event' || name === 'runId' || name === 'data' || !SAFE_FIELD.test(name) || SECRET_FIELD.test(name)) continue;
      if (fields >= MAX_FIELDS) break;
      const countName = `${name}Count`;
      const outputName = Array.isArray(value) || value && typeof value === 'object' ? countName : name;
      if (!SAFE_FIELD.test(outputName) || SECRET_FIELD.test(outputName) || Object.hasOwn(data, outputName)) continue;
      if (typeof value === 'string') {
        // Free text (reasons, messages, patches) never leaves the pod ledger; only short code values in known keys.
        if (!CODE_FIELDS.has(name) || !CODE_VALUE.test(value) || containsCredential(value)) continue;
        data[name] = value;
      } else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' || value === null) {
        data[name] = value;
      } else if (Array.isArray(value) || value && typeof value === 'object') {
        data[countName] = Array.isArray(value) ? value.length : Object.keys(value).length;
      } else continue;
      fields += 1;
    }
  }
  return { category: 'self-implement.pod.ledger', event: entry.event, data };
}
