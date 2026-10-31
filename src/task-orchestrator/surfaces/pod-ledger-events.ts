import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { podTerminalRow } from './pod-failure-reason.js';

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
  const childRows = rows.filter(row => row.event === 'pod-child-run' && row.data?.job === job
    && row.data.childRunId === first.childRunId && Number.isSafeInteger(row.data.attempt)
    && (row.data.attempt as number) > 0);
  const attempt = childRows.length ? childRows[childRows.length - 1]!.data!.attempt as number : undefined;
  const evidenceDir = join(artifactDir, 'pod-failure-capture', runId, job, first.childRunId as string);
  // A failed kubectl/SSH read is itself the missing diagnostic. Keep its stderr in
  // the private artifact directory and put only the path and exit status in the ledger.
  const captureStderr = (reason: string, result: { status: number | null; stderr: string }): Record<string, unknown> => {
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
    return { kubectlStatus: result.status, stderrEvidence, stderrCaptureStatus };
  };
  const readFailure = (reason: string, result: { status: number | null; stderr: string }, extra: Record<string, unknown> = {}): void => {
    finish('failed', reason, { ...location, ...extra, ...captureStderr(reason, result) });
  };
  const previous = rows.find(row => row.event === 'pod-failure-capture' && row.data?.job === job && row.data?.outcome === 'collected'
    && row.data.childRunId === first.childRunId && row.data.jobUid === first.jobUid
    && row.data.host === first.host && row.data.context === first.context && row.data.namespace === first.namespace);
  const priorLogEvidence = previous?.data?.logEvidence;
  const priorPreviousLogEvidence = previous?.data?.previousLogEvidence;
  const priorCurrentReadStatus = previous?.data?.currentLogReadStatus;
  const priorPreviousReadStatus = previous?.data?.previousLogReadStatus;
  // A ledger row describes a prior collection; it does not guarantee that its files survived.
  // Validate the required artifacts and every log artifact claimed by the prior row before deduping.
  // Unknown restart count is terminal for this Job snapshot: another identical Pod read cannot recover it.
  const previousReadComplete = priorCurrentReadStatus === 'captured'
    ? ['captured', 'empty', 'not-needed', 'unknown'].includes(String(priorPreviousReadStatus))
    : priorCurrentReadStatus === 'empty' && priorPreviousReadStatus === 'captured';
  const currentLogEvidencePresent = priorCurrentReadStatus === 'captured'
    && priorLogEvidence === join(evidenceDir, 'child.log')
    && (() => { try { return statSync(priorLogEvidence).isFile(); } catch { return false; } })();
  const previousLogEvidencePresent = priorPreviousReadStatus === 'captured'
    && priorPreviousLogEvidence === join(evidenceDir, 'child.previous.log')
    && (() => { try { return statSync(priorPreviousLogEvidence).isFile(); } catch { return false; } })();
  const logEvidenceComplete = currentLogEvidencePresent
    ? priorPreviousReadStatus !== 'captured' || previousLogEvidencePresent
    : priorCurrentReadStatus === 'empty' && previousLogEvidencePresent;
  if (previous && previousReadComplete && ([['jobEvidence', 'job.json'], ['podEvidence', 'pods.json']] as const)
    .every(([field, filename]) => {
      const path = join(evidenceDir, filename);
      if (previous.data?.[field] !== path) return false;
      try { return statSync(path).isFile(); } catch { return false; }
    })
    && logEvidenceComplete) return;
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
    const pods = JSON.parse(podResult.stdout) as { items?: Array<{
      metadata?: { name?: string; uid?: string; ownerReferences?: Array<{ uid?: string }> };
      status?: { phase?: string; containerStatuses?: Array<{ name?: string; restartCount?: number;
        state?: { terminated?: { reason?: string; exitCode?: number; finishedAt?: string } } }> };
    }> };
    if (!pods.items?.length || pods.items.some(p => !p.metadata?.ownerReferences?.some(owner => owner.uid === jobBody.metadata?.uid))) {
      finish('failed', 'pod-owner-mismatch', { ...location, jobEvidence }); return;
    }
    const podEvidence = save('pods.json', podResult.stdout);
    const pod = pods.items[0]!;
    const podName = pod.metadata?.name;
    if (pods.items.length !== 1 || !podName || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(podName)) {
      finish('failed', 'pod-ambiguous', { ...location, jobEvidence, podEvidence }); return;
    }
    const childStatus = pod.status?.containerStatuses?.find(status => status.name === 'child');
    const terminated = childStatus?.state?.terminated;
    const shortCode = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) && !SECRET_VALUE.test(value) ? value : undefined;
    const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const exitCode = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
    const restartCount = numeric(childStatus?.restartCount);
    const podSummary: Record<string, unknown> = {
      ...location,
      ...(attempt !== undefined ? { attempt } : {}), podName,
      ...(shortCode(pod.metadata?.uid) ? { podUid: shortCode(pod.metadata?.uid) } : {}),
      ...(shortCode(pod.status?.phase) ? { podPhase: shortCode(pod.status?.phase) } : {}),
      ...(shortCode(terminated?.reason) ? { containerReason: shortCode(terminated?.reason) } : {}),
      ...(exitCode(terminated?.exitCode) !== undefined ? { containerExitCode: exitCode(terminated?.exitCode) } : {}),
      ...(typeof terminated?.finishedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(terminated.finishedAt) ? { containerFinishedAt: terminated.finishedAt } : {}),
      ...(restartCount !== undefined ? { containerRestartCount: restartCount } : {}),
    };
    const logs = kubectl(first.host as string, [...args, 'logs', `pod/${podName}`, '-c', 'child']);
    const currentLogReadStatus = logs.status === 0 ? (logs.stdout.trim() ? 'captured' : 'empty') : 'failed';
    const currentLogBytes = logs.status === 0 ? Buffer.byteLength(logs.stdout) : 0;
    let logEvidence: string | undefined;
    let previousLogEvidence: string | undefined;
    let previousLogReadStatus = restartCount === undefined || restartCount > 0 ? 'unknown' : 'not-needed';
    let previousLogBytes: number | undefined;
    let previousLogFailure: Record<string, unknown> = {};
    let resultMarkerPresent = false;
    if (logs.status === 0 && logs.stdout.trim()) {
      logEvidence = save('child.log', logs.stdout);
      resultMarkerPresent = hasTerminalMarker(logs.stdout);
    }
    if (restartCount !== undefined && restartCount > 0) {
      const previousLogs = kubectl(first.host as string, [...args, 'logs', `pod/${podName}`, '-c', 'child', '--previous']);
      previousLogReadStatus = previousLogs.status === 0 ? (previousLogs.stdout.trim() ? 'captured' : 'empty') : 'failed';
      previousLogBytes = previousLogs.status === 0 ? Buffer.byteLength(previousLogs.stdout) : 0;
      if (previousLogs.status !== 0) {
        const failure = captureStderr('previous-logs-read-failed', previousLogs);
        previousLogFailure = {
          previousLogKubectlStatus: failure.kubectlStatus,
          previousLogStderrEvidence: failure.stderrEvidence,
          previousLogStderrCaptureStatus: failure.stderrCaptureStatus,
        };
      }
      if (previousLogs.status === 0 && previousLogs.stdout.trim()) {
        previousLogEvidence = save('child.previous.log', previousLogs.stdout);
        resultMarkerPresent ||= hasTerminalMarker(previousLogs.stdout);
      }
    }
    const summary = { ...podSummary, jobEvidence, podEvidence, currentLogReadStatus, currentLogBytes,
      previousLogReadStatus, ...(previousLogBytes !== undefined ? { previousLogBytes } : {}), ...previousLogFailure, resultMarkerPresent,
      ...(logEvidence ? { logEvidence } : {}), ...(previousLogEvidence ? { previousLogEvidence } : {}) };
    if (currentLogReadStatus !== 'captured' && previousLogReadStatus !== 'captured') {
      if (logs.status !== 0) { readFailure('logs-read-failed', logs, summary); return; }
      finish('failed', 'logs-empty', summary); return;
    }
    if (logs.status !== 0) finish('collected', 'job-failed', { ...summary, ...captureStderr('logs-read-failed', logs) });
    else finish('collected', 'job-failed', summary);
  } catch { finish('failed', 'capture-error', location); }
}

function hasTerminalMarker(logs: string): boolean {
  for (const line of logs.split(/\r?\n/)) {
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row) && podTerminalRow(row as Record<string, unknown>)) return true;
    } catch { /* ordinary child output is not a terminal result marker */ }
  }
  return false;
}

const SECRET_FIELD = /token|secret|password|authorization|key/i;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+\S+|\b(?:token|secret|password|authorization|api[-_]?key|access[-_]?key|private[-_]?key)\b\s*(?:is|[=:])\s*["']?\S+|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}))\b/i;
const MAX_FIELDS = 32;
// Review R2: only lifecycle events the host needs to see, and no free text. Event names must start with a known
// lifecycle prefix; string fields survive only when they are short code-like values in a fixed set of keys.
const EVENT_ALLOWED = /^(?:gate|gated|review|reviewed|repair|repaired|rework|merge|merged|pr|land|landed|stage|round|supervisor|child|plan|planned|decompose|decomposed|shard|stall|harvest|decision|run|pipeline|progress|human|start|started|finish|finished|done|implement|implemented|commit|test|typecheck)(?:-(?:started|finished|round|opened|closed|failed|passed|blocked|done|entry|node|outcome|delivery|decision|stop|merged|ready|requested|resolved|result|fix|must-fix|verdict|skipped|origin|cleared))*$/;
const CODE_FIELDS = new Set(['stage', 'outcome', 'verdict', 'status', 'kind', 'phase', 'role', 'result', 'containerReason',
  'podPhase', 'currentLogReadStatus', 'previousLogReadStatus', 'previousLogStderrCaptureStatus', 'stderrCaptureStatus']);
const CODE_VALUE = /^[a-z0-9_.:-]{1,40}$/i;
const IDENTITY_FIELDS = new Set(['job', 'jobUid', 'childRunId', 'host', 'context', 'namespace', 'podName', 'podUid']);
const SAFE_ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

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
  if (containsCredential(entry.event) || (!EVENT_ALLOWED.test(entry.event) && entry.event !== 'pod-failure-capture'
    && entry.event !== 'ask-auto-target-candidates' && entry.event !== 'ask-auto-reauthor')) return undefined;

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
        const acceptedCode = CODE_FIELDS.has(name) && CODE_VALUE.test(value);
        const acceptedIdentity = IDENTITY_FIELDS.has(name) && SAFE_ID_VALUE.test(value);
        const acceptedTimestamp = name === 'containerFinishedAt' && SAFE_ISO_TIMESTAMP.test(value);
        if ((!acceptedCode && !acceptedIdentity && !acceptedTimestamp) || containsCredential(value)) continue;
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
