import { isRecord } from '../src/primitives/guards.js';

export const DISPLAY_KEY_CATEGORY = 'display.key';
export const DEFAULT_ELANOUS_COMMAND = ['bun', 'bin/elanous.mjs'] as const;
export const DEFAULT_KEY_ARRIVAL_LOG_SINCE = '5m';
export const DEFAULT_KEY_ARRIVAL_LOG_LIMIT = 50;
export const DISPLAY_KEY_ARRIVAL_EVENTS = ['no-match', 'when-false', 'chord-armed', 'selected'] as const;
export type DisplayKeyArrivalEvent = (typeof DISPLAY_KEY_ARRIVAL_EVENTS)[number];

export const KEY_ARRIVAL_ADAPTER_NAMES = [
  'captureCursor',
  'confirmScreen',
  'resetScreen',
  'sendKey',
  'wait',
] as const;
export type KeyArrivalAdapterName = (typeof KEY_ARRIVAL_ADAPTER_NAMES)[number];

export interface KeyArrivalAdapters {
  captureCursor: () => Promise<string | null | undefined> | string | null | undefined;
  confirmScreen: (screenRef: string) => Promise<boolean> | boolean;
  resetScreen: (screenRef: string) => Promise<void> | void;
  sendKey: (key: string) => Promise<void> | void;
  wait: () => Promise<void> | void;
}

export type KeyArrivalStatus =
  | 'arrived'
  | 'not-arrived'
  | 'query-failed'
  | 'truncated'
  | 'unmeasurable'
  | 'missing-screen'
  | 'missing-cursor'
  | 'missing-adapter'
  | 'could-not-send'
  | 'could-not-reset';

export interface KeyArrivalResult {
  key: string;
  status: KeyArrivalStatus;
  event?: DisplayKeyArrivalEvent;
  missing?: string;
}

export type KeyArrivalPlanActionName =
  | 'capture-cursor'
  | 'confirm-screen'
  | 'reset-screen'
  | 'send-key'
  | 'wait'
  | 'query-display-key';

export interface KeyArrivalPlanAction {
  key: string;
  action: KeyArrivalPlanActionName;
  detail?: string;
}

export interface MeasureKeyArrivalRequest {
  keys: readonly string[];
  screenRef: string;
  adapters: KeyArrivalAdapters;
  queryDisplayKey: (cursor: string) => Promise<string> | string;
  plan?: boolean;
}

export interface KeyArrivalReport {
  exitCode: number;
  results: KeyArrivalResult[];
  plan: KeyArrivalPlanAction[];
  formatted: string;
}

export interface KeyArrivalMeasurer {
  measure(request: Omit<MeasureKeyArrivalRequest, 'adapters'>): Promise<KeyArrivalReport>;
}

const FAILURE_STATUSES: ReadonlySet<KeyArrivalStatus> = new Set([
  'query-failed',
  'truncated',
  'unmeasurable',
  'missing-screen',
  'missing-cursor',
  'missing-adapter',
  'could-not-send',
  'could-not-reset',
]);

const LOG_QUERY_LIMIT_TYPE = 'log-query-limit';

const HUMAN_STATUS: Record<KeyArrivalStatus, string> = {
  arrived: '닿았다',
  'not-arrived': '안 닿았다',
  'query-failed': '조회 실패',
  truncated: '잘렸다',
  unmeasurable: '측정 불가',
  'missing-screen': '화면 참조 부재',
  'missing-cursor': '커서 부재',
  'missing-adapter': '어댑터 부재',
  'could-not-send': '못 보냈다',
  'could-not-reset': '되돌리지 못했다',
};

export interface MeasureKeyArrivalCliDeps {
  adapters: KeyArrivalAdapters;
  queryDisplayKey: (cursor: string) => Promise<string> | string;
}

export interface MeasureKeyArrivalCliResult {
  stdout: string;
  exitCode: number;
  human: string;
  machine: string;
}

export function missingAdapterNames(
  adapters: Partial<KeyArrivalAdapters> | null | undefined,
): KeyArrivalAdapterName[] {
  return KEY_ARRIVAL_ADAPTER_NAMES.filter((name) => typeof adapters?.[name] !== 'function');
}

export function planKeyArrival(
  keys: readonly string[],
  screenRef: string,
): KeyArrivalPlanAction[] {
  return keys.flatMap((key) => [
    { key, action: 'capture-cursor' },
    { key, action: 'confirm-screen', detail: screenRef },
    { key, action: 'reset-screen', detail: screenRef },
    { key, action: 'send-key', detail: key },
    { key, action: 'wait' },
    { key, action: 'query-display-key', detail: DISPLAY_KEY_CATEGORY },
  ]);
}

export function formatKeyArrivalReport(report: Pick<KeyArrivalReport, 'results' | 'plan'>): string {
  if (report.plan.length > 0 && report.results.length === 0) {
    return report.plan.map(formatPlanAction).join('\n');
  }
  return report.results.map((result) => {
    if (result.status === 'missing-adapter') {
      return `${result.key}: missing-adapter ${result.missing ?? ''}`.trimEnd();
    }
    if (result.status === 'arrived' && result.event) {
      return `${result.key}: arrived ${result.event}`;
    }
    return `${result.key}: ${result.status}`;
  }).join('\n');
}

export function createKeyArrivalMeasurer(adapters: KeyArrivalAdapters): KeyArrivalMeasurer {
  const missing = missingAdapterNames(adapters);
  if (missing.length > 0) {
    throw new Error(`missing-adapter: ${missing.join(', ')}`);
  }
  return {
    measure(request) {
      return measureKeyArrival({ ...request, adapters });
    },
  };
}

export async function measureKeyArrival(request: MeasureKeyArrivalRequest): Promise<KeyArrivalReport> {
  const keys = request.keys;
  const plan = planKeyArrival(keys, request.screenRef);

  const missing = missingAdapterNames(request.adapters);
  if (missing.length > 0) {
    return finishReport({
      exitCode: 1,
      results: missing.map((name) => ({ key: '*', status: 'missing-adapter', missing: name })),
      plan: [],
    });
  }
  if (request.plan) {
    return finishReport({ exitCode: 0, results: [], plan });
  }
  if (typeof request.queryDisplayKey !== 'function') {
    return finishReport({
      exitCode: 1,
      results: [{ key: '*', status: 'missing-adapter', missing: 'queryDisplayKey' }],
      plan: [],
    });
  }

  const results: KeyArrivalResult[] = [];
  for (const key of keys) {
    results.push(await measureOneKey(key, request.screenRef, request.adapters, request.queryDisplayKey));
  }
  const exitCode = results.some((result) => FAILURE_STATUSES.has(result.status)) ? 1 : 0;
  return finishReport({ exitCode, results, plan: [] });
}

async function measureOneKey(
  key: string,
  screenRef: string,
  adapters: KeyArrivalAdapters,
  queryDisplayKey: (cursor: string) => Promise<string> | string,
): Promise<KeyArrivalResult> {
  const cursor = await adapters.captureCursor();
  if (typeof cursor !== 'string' || cursor === '') {
    return { key, status: 'missing-cursor' };
  }

  const screenOk = await adapters.confirmScreen(screenRef);
  if (!screenRef.trim() || screenOk !== true) {
    return { key, status: 'missing-screen' };
  }

  try {
    await adapters.resetScreen(screenRef);
  } catch {
    return { key, status: 'could-not-reset' };
  }
  try {
    await adapters.sendKey(key);
  } catch {
    return { key, status: 'could-not-send' };
  }
  await adapters.wait();

  let raw: unknown;
  try {
    raw = await queryDisplayKey(cursor);
  } catch {
    return { key, status: 'query-failed' };
  }
  if (typeof raw !== 'string') {
    return { key, status: 'query-failed' };
  }
  const parsed = parseDisplayKeyQuery(raw);
  if (!parsed.ok) {
    return { key, status: 'query-failed' };
  }

  for (const row of parsed.records) {
    const event = arrivalEventForKey(row, key);
    if (event) return { key, status: 'arrived', event };
  }
  if (parsed.unmeasurable) return { key, status: 'unmeasurable' };
  if (parsed.truncated) return { key, status: 'truncated' };
  return { key, status: 'not-arrived' };
}

interface DisplayKeyRecord {
  category?: string;
  event: string;
  data: Record<string, unknown>;
}

function parseDisplayKeyQuery(
  raw: string,
): { ok: true; records: DisplayKeyRecord[]; truncated: boolean; unmeasurable: boolean } | { ok: false } {
  const items = parseQueryItems(raw);
  if (!items) return { ok: false };

  const records: DisplayKeyRecord[] = [];
  let truncated = false;
  let unmeasurable = false;
  for (const item of items) {
    if (isMetaLine(item)) {
      if (item._meta.type === LOG_QUERY_LIMIT_TYPE) {
        if (item._meta.limitReached === true) truncated = true;
        else if (item._meta.limitReached !== false) unmeasurable = true;
      }
      continue;
    }
    const record = normalizeRecord(item);
    if (!record) return { ok: false };
    records.push(record);
  }
  return { ok: true, records, truncated, unmeasurable };
}

function parseQueryItems(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const lines = trimmed.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) return null;
    const items: unknown[] = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line) as unknown);
      } catch {
        return null;
      }
    }
    return items;
  }
}

function isMetaLine(value: unknown): value is { _meta: Record<string, unknown> } {
  return isRecord(value) && isRecord(value._meta) && value.event === undefined && value.data === undefined;
}

function normalizeRecord(row: unknown): DisplayKeyRecord | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const rec = row as Record<string, unknown>;
  if (typeof rec.event !== 'string') return null;
  if (rec.category != null && typeof rec.category !== 'string') return null;

  let data: unknown = rec.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      return null;
    }
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return null;

  const record: DisplayKeyRecord = {
    ...(typeof rec.category === 'string' ? { category: rec.category } : {}),
    event: rec.event,
    data: data as Record<string, unknown>,
  };
  if (record.category === DISPLAY_KEY_CATEGORY && typeof record.data.key !== 'string') {
    return null;
  }
  return record;
}

function arrivalEventForKey(row: DisplayKeyRecord, key: string): DisplayKeyArrivalEvent | undefined {
  if (row.category !== DISPLAY_KEY_CATEGORY) return undefined;
  if (!DISPLAY_KEY_ARRIVAL_EVENTS.includes(row.event as DisplayKeyArrivalEvent)) return undefined;
  if (row.data.key !== key) return undefined;
  return row.event as DisplayKeyArrivalEvent;
}

function formatPlanAction(step: KeyArrivalPlanAction): string {
  return step.detail === undefined ? `${step.key}: ${step.action}` : `${step.key}: ${step.action} ${step.detail}`;
}

function finishReport(report: Omit<KeyArrivalReport, 'formatted'>): KeyArrivalReport {
  return { ...report, formatted: formatKeyArrivalReport(report) };
}

export async function runMeasureKeyArrival(
  argv: readonly string[],
  deps: MeasureKeyArrivalCliDeps,
): Promise<MeasureKeyArrivalCliResult> {
  try {
    return await executeMeasureKeyArrivalCli(argv, deps);
  } catch (error) {
    return cliFailure(oneSentence(error), argv.includes('--json'));
  }
}

async function executeMeasureKeyArrivalCli(
  argv: readonly string[],
  deps: MeasureKeyArrivalCliDeps,
): Promise<MeasureKeyArrivalCliResult> {
  const parsed = parseMeasureKeyArrivalArgv(argv);
  if (parsed.help) return cliHelp();
  if (parsed.error) return cliFailure(parsed.error, parsed.json);
  if (!parsed.screenRef) return cliFailure('화면 참조가 없습니다.', parsed.json);
  if (parsed.keys.length === 0) return cliFailure('키 목록이 없습니다.', parsed.json);

  const missing = missingAdapterNames(deps.adapters);
  if (missing.length > 0) return cliFailure(`어댑터가 없습니다: ${missing.join(', ')}`, parsed.json);
  if (!parsed.plan && typeof deps.queryDisplayKey !== 'function') {
    return cliFailure('어댑터가 없습니다: queryDisplayKey', parsed.json);
  }

  const report = await measureKeyArrival({
    keys: parsed.keys,
    screenRef: parsed.screenRef,
    adapters: deps.adapters,
    queryDisplayKey: deps.queryDisplayKey,
    plan: parsed.plan,
  });
  const failure = humanFailureMessage(report.results);
  if (failure || report.exitCode !== 0) {
    const message = failure ?? '측정 실패';
    const surfaces = {
      exitCode: report.exitCode === 0 ? 1 : report.exitCode,
      human: message,
      machine: formatMachineCliOutput(report),
    };
    return {
      ...surfaces,
      stdout: parsed.json ? surfaces.machine : surfaces.human,
    };
  }
  const surfaces = {
    exitCode: report.exitCode,
    human: formatHumanCliOutput(report),
    machine: formatMachineCliOutput(report),
  };
  return {
    ...surfaces,
    stdout: parsed.json ? surfaces.machine : surfaces.human,
  };
}

const MEASURE_KEY_ARRIVAL_HELP_OPTIONS = [
  '--help',
  '--screen',
  '--screen-ref',
  '--key',
  '--plan',
  '--json',
  '--json-data',
  '--since',
  '--limit',
  '--all',
  '--include-test',
  '--exact-category',
  '--enter',
  '--actor',
] as const;

function parseMeasureKeyArrivalArgv(argv: readonly string[]): {
  screenRef: string | undefined;
  keys: string[];
  plan: boolean;
  json: boolean;
  help?: boolean;
  error?: string;
} {
  const keys: string[] = [];
  let screenRef: string | undefined;
  let plan = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help') {
      return { screenRef, keys, plan, json, help: true };
    }
    if (arg === '--plan') {
      plan = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--screen' || arg === '--screen-ref') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { screenRef, keys, plan, json, error: '화면 참조가 없습니다.' };
      screenRef = value;
      i += 1;
      continue;
    }
    if (arg === '--key') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { screenRef, keys, plan, json, error: '키 목록이 없습니다.' };
      keys.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) return { screenRef, keys, plan, json, error: `알 수 없는 옵션 ${arg}` };
    keys.push(arg);
  }
  return { screenRef, keys, plan, json };
}

function humanFailureMessage(results: KeyArrivalResult[]): string | undefined {
  for (const status of FAILURE_STATUSES) {
    const hit = results.find((result) => result.status === status);
    if (!hit) continue;
    if (status === 'missing-adapter' && hit.missing) {
      return `어댑터가 없습니다: ${hit.missing}`;
    }
    return HUMAN_STATUS[status];
  }
  return undefined;
}

function formatHumanCliOutput(report: KeyArrivalReport): string {
  if (report.plan.length > 0 && report.results.length === 0) {
    return ['키\t동작', ...report.plan.map((step) => (
      step.detail === undefined ? `${step.key}\t${step.action}` : `${step.key}\t${step.action} ${step.detail}`
    ))].join('\n');
  }
  return ['키\t판정', ...report.results.map(formatHumanResultRow)].join('\n');
}

function formatHumanResultRow(result: KeyArrivalResult): string {
  const label = HUMAN_STATUS[result.status];
  if (result.status === 'missing-adapter') return `${result.key}\t${label}\t${result.missing ?? ''}`.trimEnd();
  if (result.status === 'arrived' && result.event) return `${result.key}\t${label}\t${result.event}`;
  return `${result.key}\t${label}`;
}

function formatMachineCliOutput(report: KeyArrivalReport): string {
  return JSON.stringify({ exitCode: report.exitCode, results: report.results, plan: report.plan });
}

function cliFailure(message: string, json = false): MeasureKeyArrivalCliResult {
  const machine = JSON.stringify({ error: message });
  return { stdout: json ? machine : message, exitCode: 1, human: message, machine };
}

function formatMeasureKeyArrivalHelp(): string {
  return [
    'Usage: bun run scripts/measure-key-arrival.ts [options] [keys...]',
    '',
    'Options:',
    ...MEASURE_KEY_ARRIVAL_HELP_OPTIONS.map((name) => `  ${name}`),
  ].join('\n');
}

function cliHelp(): MeasureKeyArrivalCliResult {
  const text = formatMeasureKeyArrivalHelp();
  return { stdout: text, exitCode: 0, human: text, machine: text };
}

function oneSentence(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n').find((part) => part.trim().length > 0);
  return line?.trim() || '측정 실패';
}

export interface ElanousCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ElanousCommandRunner = (argv: readonly string[]) => Promise<ElanousCommandResult> | ElanousCommandResult;

export interface RealKeyArrivalAdapterOptions {
  command?: readonly string[];
  run?: ElanousCommandRunner;
  logSince?: string;
  logLimit?: number;
  waitMs?: number;
  actor?: string;
  enter?: boolean;
}

export function createRealKeyArrivalAdapters(
  options: RealKeyArrivalAdapterOptions = {},
): MeasureKeyArrivalCliDeps {
  const command = options.command ?? DEFAULT_ELANOUS_COMMAND;
  const run = options.run ?? defaultElanousRunner;
  const logSince = options.logSince ?? DEFAULT_KEY_ARRIVAL_LOG_SINCE;
  const logLimit = options.logLimit ?? DEFAULT_KEY_ARRIVAL_LOG_LIMIT;
  const waitMs = options.waitMs ?? 0;
  let screenRef = '';
  let queryFloor: string | null = null;

  const invoke = (args: readonly string[]) => run([...command, ...args]);

  function sendArgs(key: string): string[] {
    return buildPtySendArgs(screenRef, key, options);
  }

  async function readLatestCursor(): Promise<string | null> {
    const result = await invoke(logQueryArgs(logSince, logLimit));
    if (result.exitCode !== 0) return null;
    const items = parseLogItems(result.stdout);
    if (!items) return null;
    return latestRowId(items);
  }

  function wait() {
    if (waitMs <= 0) return;
    return new Promise<void>((resolve) => {
      setTimeout(resolve, waitMs);
    });
  }

  return {
    adapters: {
      async captureCursor() {
        const cursor = await readLatestCursor();
        queryFloor = cursor;
        return cursor;
      },
      async confirmScreen(ref) {
        screenRef = ref;
        const result = await invoke(['pty', 'snapshot', ref]);
        return result.exitCode === 0;
      },
      async resetScreen(ref) {
        screenRef = ref;
        const result = await invoke(['pty', 'key', ref, 'ctrl+u']);
        if (result.exitCode !== 0) {
          throw new Error(oneSentence(result.stderr || result.stdout || `pty key 실패: ${ref}`));
        }
        await wait();
        const cursor = await readLatestCursor();
        if (cursor == null) {
          throw new Error('되돌린 뒤 커서를 읽지 못했다');
        }
        queryFloor = cursor;
      },
      async sendKey(key) {
        const args = sendArgs(key);
        const result = await invoke(args);
        if (result.exitCode !== 0) {
          throw new Error(oneSentence(result.stderr || result.stdout || `pty 전송 실패: ${screenRef}`));
        }
      },
      wait,
    },
    async queryDisplayKey(cursor) {
      const result = await invoke(logQueryArgs(logSince, logLimit));
      if (result.exitCode !== 0) {
        throw new Error(oneSentence(result.stderr || result.stdout || '로그 조회 실패'));
      }
      const items = parseLogItems(result.stdout);
      if (!items) throw new Error('로그 조회 실패');
      return JSON.stringify(rowsAfterCursor(items, laterQueryFloor(cursor, queryFloor)));
    },
  };
}

function laterQueryFloor(cursor: string, queryFloor: string | null): string {
  if (queryFloor == null) return cursor;
  const captured = Number(cursor);
  const reset = Number(queryFloor);
  if (Number.isFinite(captured) && Number.isFinite(reset)) return String(Math.max(captured, reset));
  return queryFloor;
}

function ctrlLetterPtyKey(key: string): string | undefined {
  const match = /^C-([a-z])$/i.exec(key);
  if (!match) return undefined;
  return `ctrl+${match[1]!.toLowerCase()}`;
}

function isLiteralTextKey(key: string): boolean {
  return ctrlLetterPtyKey(key) === undefined && !/^[CSAM]-/i.test(key) && !key.includes('+');
}

function buildPtySendArgs(
  screenRef: string,
  key: string,
  options: RealKeyArrivalAdapterOptions,
): string[] {
  const ctrl = ctrlLetterPtyKey(key);
  const args = ctrl !== undefined
    ? ['pty', 'key', screenRef, ctrl]
    : isLiteralTextKey(key)
      ? ['pty', 'text', screenRef, key]
      : ['pty', 'key', screenRef, key];
  if (options.enter) args.push('--enter');
  if (options.actor) args.push('--actor', options.actor);
  return args;
}

function logQueryArgs(since: string, limit: number): string[] {
  return [
    'logs',
    '--exact-category', DISPLAY_KEY_CATEGORY,
    '--since', since,
    '--limit', String(limit),
    '--json',
    '--json-data',
    '--all',
    '--include-test',
  ];
}

function defaultElanousRunner(argv: readonly string[]): ElanousCommandResult {
  const child = Bun.spawnSync({ cmd: [...argv], stdout: 'pipe', stderr: 'pipe' });
  return {
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    exitCode: child.exitCode ?? 1,
  };
}

function parseLogItems(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  return parseQueryItems(trimmed);
}

function latestRowId(items: readonly unknown[]): string {
  let max: number | null = null;
  for (const item of items) {
    const id = rowId(item);
    if (id === null) continue;
    if (max === null || id > max) max = id;
  }
  return max === null ? '0' : String(max);
}

function rowsAfterCursor(items: readonly unknown[], cursor: string): unknown[] {
  const baseline = Number(cursor);
  const floor = Number.isFinite(baseline) ? baseline : 0;
  const kept: unknown[] = [];
  for (const item of items) {
    if (isMetaLine(item)) {
      kept.push(item);
      continue;
    }
    const id = rowId(item);
    if (id !== null && id > floor) kept.push(item);
  }
  return kept;
}

function rowId(item: unknown): number | null {
  if (!isRecord(item) || isMetaLine(item)) return null;
  return typeof item.id === 'number' && Number.isFinite(item.id) ? item.id : null;
}

if (import.meta.main) {
  const command = process.env.MEASURE_KEY_ARRIVAL_COMMAND?.trim().split(/\s+/).filter(Boolean);
  const result = await runMeasureKeyArrival(
    process.argv.slice(2),
    createRealKeyArrivalAdapters(command && command.length > 0 ? { command } : {}),
  );
  const out = result.stdout;
  process.stdout.write(out.length === 0 || out.endsWith('\n') ? out : `${out}\n`);
  process.exitCode = result.exitCode;
}
