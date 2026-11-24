import { createHash, randomUUID } from 'node:crypto';
import { redactSecretText } from '../../debug/log.js';
import type { RunShellDispatchResult } from './shell.js';

type Step = { id: string; command: string[]; select: string[]; headLines: number; projection?: 'checklist-evidence' };
type StepReceipt = { id: string; outcome: string; exitCode: number | null; stdoutSha256: string; bytes: number;
  selected?: Record<string, string | number | boolean | null>; preview?: string; truncated: boolean; error?: string };

const ID = /^[a-z][a-z0-9_-]{0,31}$/;
const REF = /^\$ref:([a-z][a-z0-9_-]{0,31})\.([A-Za-z][A-Za-z0-9_.]{0,63})$/;
type ValueKind = 'seat' | 'query' | 'memory-type' | 'version' | 'duration' | 'axis' | 'revision' | 'count' | 'number' | 'cursor' | 'fields' | 'state' | 'endpoint' | 'get' | 'remote-repo' | 'namespace' | 'kube-output';
type ReadRule = { prefix: readonly string[]; positionals: readonly ValueKind[];
  options: Readonly<Record<string, ValueKind | null>>; minPositionals?: number };
const JSON_OPTION = { '--json': null } as const;
const READ_RULES: readonly ReadRule[] = [
  { prefix: ['memory', 'list'], positionals: ['memory-type'], minPositionals: 0, options: { '-n': 'count', '--limit': 'count' } },
  // memory search records usage and status can migrate/create stores: both require approval.
  { prefix: ['memory', 'index'], positionals: [], options: {} },
  { prefix: ['memory', 'where'], positionals: [], options: {} },
  // ops status/health may create stores and inventory crontab: require approval.
  // Mail content reads require approval; the exact body-free count form is handled below.
  { prefix: ['release', 'status'], positionals: ['version'], options: {} },
  { prefix: ['logs'], positionals: [], options: { ...JSON_OPTION, '--since': 'duration' } },
];
// Federation and cluster reads can contact another host or invoke credential helpers.
const ELN_NETWORK_READ_RULES: readonly ReadRule[] = [
  // These consult remote liveness / an optional Nexus endpoint even without remote argv.
  { prefix: ['msg', 'route'], positionals: ['seat'], options: JSON_OPTION },
  { prefix: ['release', 'checklist', 'status'], positionals: [], options: { ...JSON_OPTION, '--version': 'version' } },
  { prefix: ['release', 'checklist', 'list'], positionals: [], options: { ...JSON_OPTION, '--version': 'version' } },
  { prefix: ['fleet', 'list'], positionals: [], options: JSON_OPTION },
  { prefix: ['fleet', 'resources'], positionals: [], options: JSON_OPTION },
];
const HOST_READ_RULES: Readonly<Record<string, readonly ReadRule[]>> = {
  hostname: [{ prefix: [], positionals: [], options: {} }],
  uname: [{ prefix: [], positionals: [], options: { '-a': null, '-s': null, '-m': null, '-r': null } }],
  uptime: [{ prefix: [], positionals: [], options: {} }],
  whoami: [{ prefix: [], positionals: [], options: {} }],
  pwd: [{ prefix: [], positionals: [], options: {} }],
  date: [{ prefix: [], positionals: [], options: { '-u': null } }],
};
const HOST_APPROVAL_RULES: Readonly<Record<string, readonly ReadRule[]>> = {
  // df may stat remote filesystem mounts; keep it behind the human network boundary.
  df: [{ prefix: [], positionals: [], options: { '-h': null } }],
  // Process command lines can expose credentials; require explicit approval.
  ps: [{ prefix: [], positionals: [], options: { '-A': null, '-e': null, '-f': null } }],
};
const KUBE_RESOURCES = new Set(['pod', 'pods', 'node', 'nodes', 'deployment', 'deployments',
  'namespace', 'namespaces', 'event', 'events', 'service', 'services']);
const GIT_READ_RULES: readonly ReadRule[] = [
  { prefix: ['log'], positionals: ['revision'], minPositionals: 0,
    options: { '--oneline': null, '--no-patch': null, '--max-count': 'count', '-n': 'count' } },
  { prefix: ['show'], positionals: ['revision'], options: { '--stat': null, '--no-patch': null, '--name-only': null } },
  { prefix: ['rev-parse'], positionals: ['revision'], options: {} },
];
const GIT_APPROVAL_RULES: readonly ReadRule[] = [
  { prefix: ['status'], positionals: [], options: { '--short': null, '--porcelain=v1': null, '--branch': null } },
  { prefix: ['diff'], positionals: ['revision', 'revision'], minPositionals: 0,
    options: { '--stat': null, '--name-only': null, '--no-ext-diff': null, '--no-textconv': null } },
  { prefix: ['ls-remote'], positionals: ['remote-repo'], options: {} },
];
const GH_READ_RULES: readonly ReadRule[] = [
  { prefix: ['pr', 'view'], positionals: ['number'], minPositionals: 0, options: { '--json': 'fields' } },
  { prefix: ['pr', 'list'], positionals: [], options: { '--json': 'fields', '--limit': 'count', '--state': 'state' } },
  { prefix: ['pr', 'status'], positionals: [], options: {} },
  { prefix: ['pr', 'diff'], positionals: ['number'], options: { '--name-only': null, '--patch': null } },
  { prefix: ['issue', 'view'], positionals: ['number'], minPositionals: 0, options: { '--json': 'fields' } },
  { prefix: ['issue', 'list'], positionals: [], options: { '--json': 'fields', '--limit': 'count', '--state': 'state' } },
  { prefix: ['api'], positionals: ['endpoint'], options: { '--method': 'get' } },
];
export type ScriptCommandPolicy = 'read-local' | 'read-network' | 'approval' | 'deny';
const SUMMARY_LIMIT = 8192;

function parseSteps(value: unknown): Step[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error('RunShell script requires 1–8 steps');
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`RunShell script step ${index} must be an object`);
    const step = raw as Record<string, unknown>;
    if (Object.keys(step).some((key) => !['id', 'command', 'select', 'headLines', 'projection'].includes(key))) throw new Error('RunShell script step has unknown field');
    if (typeof step.id !== 'string' || !ID.test(step.id) || seen.has(step.id)) throw new Error('RunShell script step id is invalid or repeated');
    seen.add(step.id);
    if (!Array.isArray(step.command) || step.command.length < 1 || step.command.length > 20
      || step.command.some((part) => typeof part !== 'string' || !part || part.length > 1024)) throw new Error('RunShell script command is invalid');
    const select = step.select === undefined ? [] : step.select;
    if (!Array.isArray(select) || select.length > 18 || select.some((field) => typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(field))) {
      throw new Error('RunShell script select is invalid');
    }
    const headLines = step.headLines === undefined ? 2 : step.headLines;
    if (!Number.isInteger(headLines) || (headLines as number) < 0 || (headLines as number) > 4) throw new Error('RunShell script headLines is invalid');
    if (step.projection !== undefined && (step.projection !== 'checklist-evidence' || select.length !== 0 || (step.command as string[]).slice(0, 4).join(' ') !== 'eln release checklist evidence')) throw new Error('RunShell script projection is invalid');
    return { id: step.id, command: step.command as string[], select: select as string[], headLines: headLines as number, ...(step.projection === 'checklist-evidence' ? { projection: 'checklist-evidence' as const } : {}) };
  });
}

function allowedValue(kind: ValueKind, value: string): boolean {
  if (REF.test(value)) return true; // static precheck only; resolved argv is checked again.
  if (kind === 'remote-repo') return value === '.' || value === 'origin';
  if (kind === 'kube-output') return ['json', 'wide', 'name'].includes(value);
  if (kind === 'namespace') return value.length <= 63 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value);
  if (kind === 'memory-type') return ['user', 'feedback', 'project', 'reference'].includes(value);
  if (kind === 'revision') return !value.includes('..') && /^(?:[A-Fa-f0-9]{7,40}|[A-Za-z][A-Za-z0-9._/-]*(?:~[0-9]+)?)$/u.test(value);
  if (kind === 'endpoint') return !value.includes('..') && !/^\/?graphql(?:[/?]|$)/iu.test(value)
    && /^\/?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*(?:\?[A-Za-z0-9._~%=&-]*)?$/u.test(value);
  if (kind === 'count') return /^[1-9][0-9]{0,2}$/u.test(value) && Number(value) <= 100;
  if (kind === 'number') return /^[1-9][0-9]*$/u.test(value);
  if (kind === 'cursor') return /^(?:0|[1-9][0-9]*)$/u.test(value);
  if (kind === 'fields') return /^[A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)*$/u.test(value);
  if (kind === 'state') return ['open', 'closed', 'merged', 'all'].includes(value);
  if (kind === 'get') return value === 'GET';
  if (!value || value.startsWith('-') || value.startsWith('~') || value.includes('..')
    || /[\/\\\u0000-\u001f\u007f]/u.test(value)) return false;
  if (kind === 'seat') return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
  if (kind === 'version') return /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(value);
  if (kind === 'axis') return value === 'run' || value === 'role';
  if (kind === 'duration') return /^[1-9][0-9]*[smhd]$/u.test(value);
  return true; // query: ordinary text, including spaces and punctuation, but no path syntax.
}

function assertScriptExecutable(argv: readonly string[]): void {
  if (!['eln', 'elanous', 'git', 'gh', 'kubectl', ...Object.keys(HOST_READ_RULES), ...Object.keys(HOST_APPROVAL_RULES)].includes(argv[0] ?? '')) throw new Error('RunShell script refuses executable');
}

function matchesReadRule(argv: readonly string[], rule: ReadRule): boolean {
  if (!rule.prefix.every((part, index) => argv[index + 1] === part)) return false;
  const used = new Set<string>();
  const positionals: string[] = [];
  for (let i = rule.prefix.length + 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('-')) {
      if (!Object.hasOwn(rule.options, arg) || used.has(arg)) return false;
      used.add(arg);
      const kind = rule.options[arg];
      if (kind === undefined) return false;
      if (kind !== null) {
        const value = argv[++i];
        if (!value || !allowedValue(kind, value)) return false;
      }
      continue;
    }
    positionals.push(arg);
  }
  return positionals.length >= (rule.minPositionals ?? rule.positionals.length)
    && positionals.length <= rule.positionals.length
    && !positionals.some((value, index) => !allowedValue(rule.positionals[index]!, value));
}

function isLocal30MinuteCheck(argv: readonly string[]): boolean {
  if (argv[0] !== 'eln' || argv[1] !== 'ops' || argv[2] !== 'check-30m') return false;
  const seen = new Set<string>();
  for (let i = 3; i < argv.length; i++) {
    const option = argv[i]!;
    if (seen.has(option)) return false;
    seen.add(option);
    if (option === '--json') continue;
    if (option !== '--previous-green' && option !== '--expect-version') return false;
    const value = argv[++i];
    if (!value || value.trim() !== value) return false;
    if (option === '--previous-green' && !/^(?:0|[1-9][0-9]{0,3})$/u.test(value)) return false;
    if (option === '--expect-version' && !/^[0-9]+\.[0-9]+\.[0-9]+(?:-dev\.[0-9]+)?$/u.test(value)) return false;
  }
  return seen.has('--json');
}

/** Classify the whole argv. A gh read still needs approval because it reaches the network. */
export function scriptCommandPolicy(argv: readonly string[]): ScriptCommandPolicy {
  if (isLocal30MinuteCheck(argv)) return 'read-local';
  const cost = ['eln', 'usage', 'runs', '--since', '30m', '--by', 'role', '--json'];
  if (argv.length === cost.length && argv.every((part, index) => part === cost[index])) return 'read-local';
  if (argv[0] === 'eln' || argv[0] === 'elanous') {
    // Only exact body-free count forms for the supported seats are approval-free.
    if (argv[0] === 'eln' && argv.length === 6 && argv[1] === 'msg' && argv[2] === 'count'
    && argv[3] === '--to' && ['OP', 'JUD', 'JUD-B', 'REL', 'RES'].includes(argv[4]!) && argv[5] === '--json') return 'read-local';
    if (READ_RULES.some((rule) => matchesReadRule(argv, rule))) return 'read-local';
    if (ELN_NETWORK_READ_RULES.some((rule) => matchesReadRule(argv, rule))) return 'read-network';
    return 'approval';
  }
  if (argv[0] === 'git') {
    if (GIT_READ_RULES.some((rule) => matchesReadRule(argv, rule))) return 'read-local';
    if (GIT_APPROVAL_RULES.some((rule) => matchesReadRule(argv, rule))) return 'approval';
    return 'deny';
  }
  if (argv[0] === 'gh') return GH_READ_RULES.some((rule) => matchesReadRule(argv, rule)) ? 'read-network' : 'deny';
  if (argv[0] === 'kubectl') {
    const verb = argv[1];
    const resource = argv[2];
    if (!['get', 'describe'].includes(verb ?? '') || !KUBE_RESOURCES.has(resource ?? '')) return 'deny';
    const options: ReadRule['options'] = verb === 'get'
      ? { '-n': 'namespace', '--namespace': 'namespace', '-o': 'kube-output', '--output': 'kube-output', '--all-namespaces': null }
      : { '-n': 'namespace', '--namespace': 'namespace', '--all-namespaces': null };
    const rule: ReadRule = { prefix: [verb!, resource!], positionals: ['namespace'], minPositionals: 0, options };
    return matchesReadRule(argv, rule) ? 'read-network' : 'deny';
  }
  if (argv[0] && Object.hasOwn(HOST_READ_RULES, argv[0]))
    return HOST_READ_RULES[argv[0]]!.some((rule) => matchesReadRule(argv, rule)) ? 'read-local' : 'deny';
  if (argv[0] && Object.hasOwn(HOST_APPROVAL_RULES, argv[0]))
    return HOST_APPROVAL_RULES[argv[0]]!.some((rule) => matchesReadRule(argv, rule)) ? 'approval' : 'deny';
  return 'deny';
}

function resolvedCommand(step: Step, prior: Map<string, StepReceipt>): string[] {
  const argv = step.command.map((part) => {
    const ref = REF.exec(part);
    if (!ref) return part;
    const value = prior.get(ref[1]!)?.selected?.[ref[2]!];
    if (value === undefined || value === null) throw new Error(`RunShell script unresolved ${part}`);
    return String(value);
  });
  assertScriptExecutable(argv);
  if (scriptCommandPolicy(argv) === 'deny') throw new Error('RunShell script refuses CLI action or argument');
  return argv;
}

function projectFailure(stdout: string): Pick<StepReceipt, 'selected'> {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const error = record.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? record.error as Record<string, unknown> : {};
    const selected: NonNullable<StepReceipt['selected']> = {};
    if (typeof record.complete === 'boolean') selected.complete = record.complete;
    if (typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(error.code)) selected['error.code'] = error.code;
    if (typeof error.message === 'string') selected['error.message'] = redactSecretText(error.message)
      .replace(/(?:[A-Za-z]:)?\/(?:[^\s/]+\/)*[^\s]*/gu, '[path]').slice(0, 200);
    return Object.keys(selected).length ? { selected } : {};
  } catch { return {}; }
}

function project(step: Step, result: RunShellDispatchResult): Pick<StepReceipt, 'selected' | 'preview'> {
  if (step.projection === 'checklist-evidence') {
    let chain: any;
    try { chain = JSON.parse(result.stdout); } catch { throw new Error(`RunShell script ${step.id} expected evidence JSON`); }
    if (!chain || typeof chain !== 'object' || typeof chain.id !== 'string' || typeof chain.version !== 'string' || typeof chain.greenEligible !== 'boolean' || !Array.isArray(chain.stages)) throw new Error(`RunShell script ${step.id} evidence fields missing`);
    const selected: NonNullable<StepReceipt['selected']> = { id: chain.id, version: chain.version, greenEligible: chain.greenEligible };
    for (const id of ['E1', 'E3', 'E4', 'E5']) {
      const matches = chain.stages.filter((row: any) => row && row.id === id);
      if (matches.length !== 1 || !['observed', 'missing', 'unmeasurable'].includes(matches[0].state)) throw new Error(`RunShell script ${step.id} evidence ${id} invalid`);
      selected[id] = matches[0].state;
    }
    return { selected };
  }
  if (step.select.length) {
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error(`RunShell script ${step.id} expected JSON stdout`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`RunShell script ${step.id} expected a JSON object`);
    const record = parsed as Record<string, unknown>;
    const selected: NonNullable<StepReceipt['selected']> = {};
    for (const field of step.select) {
      const value = field.split('.').reduce<unknown>((current, part) =>
        current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>)[part] : undefined, record);
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(`RunShell script ${step.id} missing scalar ${field}`);
      }
      selected[field] = typeof value === 'string' ? redactSecretText(value.slice(0, 256)) : value;
    }
    return { selected };
  }
  const preview = redactSecretText(result.stdout.split(/\r?\n/).slice(0, step.headLines).join('\n').slice(0, 512));
  return { preview };
}

/** Each resolved argv goes through the ordinary RunShell approval, audit, cancellation and isolation path. */
export async function runShellScript(
  rawSteps: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  dispatchOne: (command: string[], description: string, signal: AbortSignal | undefined) => Promise<RunShellDispatchResult>,
  tolerateCheckInboxFailure = false,
): Promise<RunShellDispatchResult> {
  const steps = parseSteps(rawSteps);
  // A later statically unsafe step must not let an earlier step run. References are checked again after substitution.
  for (const step of steps) {
    assertScriptExecutable(step.command);
    if (scriptCommandPolicy(step.command) === 'deny') throw new Error('RunShell script refuses CLI action or argument');
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const stepSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const runId = randomUUID();
  const receipts: StepReceipt[] = [];
  const prior = new Map<string, StepReceipt>();
  let elapsedMs = 0;
  let outcome: RunShellDispatchResult['outcome'] = 'exit';
  let exitCode: number | null = 0;
  let sandboxed = false;
  let sandboxTool: RunShellDispatchResult['sandboxTool'] = 'none';
  let truncated = false;
  for (const step of steps) {
    if (stepSignal.aborted) { outcome = deadline.aborted && !signal?.aborted ? 'timeout' : 'aborted'; exitCode = null; break; }
    const argv = resolvedCommand(step, prior);
    let result: RunShellDispatchResult;
    try { result = await dispatchOne(argv, `script:${runId}:${step.id}`, stepSignal); }
    catch (error) {
      receipts.push({ id: step.id, outcome: 'spawn-error', exitCode: null, stdoutSha256: '', bytes: 0,
        truncated: false, error: redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 256) });
      outcome = 'spawn-error'; exitCode = null;
      break;
    }
    elapsedMs += result.elapsedMs;
    sandboxed ||= result.sandboxed;
    if (result.sandboxTool !== 'none') sandboxTool = result.sandboxTool;
    truncated ||= result.truncated;
    const stepOutcome = deadline.aborted && !signal?.aborted && result.outcome === 'aborted' ? 'timeout' : result.outcome;
    let projection: Pick<StepReceipt, 'selected' | 'preview'> = {};
    let projectionError = '';
    if (result.outcome === 'exit' && result.exitCode === 0) {
      try { projection = project(step, result); }
      catch (error) { projectionError = redactSecretText(error instanceof Error ? error.message : String(error)).slice(0, 256); }
    } else if (stepOutcome === 'exit' && result.exitCode !== null && result.exitCode !== 0) {
      projection = projectFailure(result.stdout);
    }
    const receipt: StepReceipt = {
      id: step.id, outcome: stepOutcome, exitCode: result.exitCode,
      stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
      bytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      truncated: result.truncated,
      ...projection,
      ...(projectionError ? { error: projectionError } : {}),
    };
    receipts.push(receipt);
    prior.set(step.id, receipt);
    if (tolerateCheckInboxFailure && step.id === 'inbox' && !stepSignal.aborted
      && (projectionError || (stepOutcome === 'exit' && result.exitCode !== 0))) continue;
    if (projectionError) { outcome = 'spawn-error'; exitCode = null; break; }
    if (stepOutcome !== 'exit' || result.exitCode !== 0) {
      outcome = stepOutcome;
      exitCode = result.exitCode;
      break;
    }
  }
  let stdout = JSON.stringify({ runId, steps: receipts });
  if (Buffer.byteLength(stdout) > SUMMARY_LIMIT) {
    stdout = JSON.stringify({ runId, steps: receipts.map(({ id, outcome: stepOutcome, exitCode: code, stdoutSha256, bytes, truncated: wasTruncated }) =>
      ({ id, outcome: stepOutcome, exitCode: code, stdoutSha256, bytes, truncated: wasTruncated })), summaryTruncated: true });
    truncated = true;
  }
  return {
    output: `RunShell script outcome=${outcome} steps=${receipts.length}/${steps.length} runId=${runId}`,
    exitCode, outcome, elapsedMs, stdout, stderr: '', truncated,
    approvalKey: `script:${runId}`, sandboxed, sandboxTool,
  };
}
