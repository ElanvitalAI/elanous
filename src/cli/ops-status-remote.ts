import { RemotesStore } from './remotes.js';
import { bookmarkAttachDefaults, readRemoteFlag } from './remote-resolve.js';

/** ⛔ 상한이 없으면 무응답 원격을 「느리다」로 읽게 된다. */
const DEFAULT_REMOTE_OPS_STATUS_TIMEOUT_MS = 20_000;

export const REMOTE_OPS_TASKS_PATH = '/v1/tasks';
export const REMOTE_OPS_ARMING_PATH = '/v1/autopilot/arming';

/** Loops 목록·executionMode 는 이 표면에 라우트가 없다 — 0/빈 값으로 접지 않는다. */
export const REMOTE_OPS_LOOPS_UNAVAILABLE =
  '이 표면에서는 못 얻는다 — 목록·executionMode 를 내는 라우트가 없다 (arming 으로 만들지 않음)';

/**
 * 계산형 ops health 는 로컬 스토어 이상 판정이고 `/v1/health` 는 데몬 생존이다.
 * 이름만 같다. 이 착지는 `/v1/health` 를 부르지 않고 미획득을 말한다.
 */
export const REMOTE_OPS_HEALTH_UNAVAILABLE =
  '이 표면에서는 못 얻는다 — 계산형 ops health 는 이 표면에 없다 (/v1/health 는 데몬 생존 · 다른 축 · 호출하지 않음)';

type OpsStatusRemoteClassification =
  | 'ok'
  | 'usage-error'
  | 'remote-error'
  | 'http-error'
  | 'timeout'
  | 'transport-error'
  | 'server-error';

interface OpsStatusRemoteResult {
  exitCode: number;
  classification: OpsStatusRemoteClassification;
  message: string;
}

interface OpsStatusRemoteOpts {
  /** Raw CLI argv (after node/bun + script). `readRemoteFlag` owns `-r`/`--remote` grammar. */
  args?: readonly string[];
  /** `true` = value-less `-r`. string = `--remote <name>`. Fallback when argv is not supplied. */
  remote?: string | boolean;
  json?: boolean;
  allInstances?: boolean;
  timeoutMs?: number;
  remotesStore?: () => RemotesStore;
  out?: { log: (line: string) => void; error: (line: string) => void };
}

interface RemoteTasksView {
  total: number;
  open: number | undefined;
  terminal: number | undefined;
  byStatus: Record<string, number> | undefined;
}

interface RemoteArmingView {
  absorb: unknown;
  merge: unknown;
  reboot: unknown;
  materialize: unknown;
}

interface JsonGetOk {
  ok: true;
  body: unknown;
}

interface JsonGetFail {
  ok: false;
  status: number;
  timeout?: boolean;
  reason: string;
}

type JsonGetResult = JsonGetOk | JsonGetFail;

/**
 * Subcommand `-r`/`--remote` is not a root leading flag (`ops status -r`).
 * Slice from the first command-local flag so `readRemoteFlag` still owns the grammar.
 * ⛔ 자체 `-r`/`--remote` 파서를 두지 않는다.
 */
export function resolveOpsStatusRemoteFlag(opts: {
  args?: readonly string[];
  remote?: string | boolean;
}): { present: boolean; value: string } {
  const args = opts.args ?? [];
  const idx = args.findIndex((tok) => tok === '-r' || tok === '--remote');
  if (idx >= 0) return readRemoteFlag(args.slice(idx));
  if (opts.remote === true) return readRemoteFlag(['-r']);
  if (typeof opts.remote === 'string' && opts.remote.length > 0) {
    return readRemoteFlag(['--remote', opts.remote]);
  }
  return { present: false, value: '' };
}

export async function runOpsStatusRemote(opts: OpsStatusRemoteOpts): Promise<OpsStatusRemoteResult> {
  const out = opts.out ?? defaultOut();

  if (opts.allInstances === true) {
    return fail(
      out,
      'usage-error',
      'elanous ops status: --all-instances is a local federation scope and has no meaning with --remote; drop it (the remote daemon decides its own scope).',
    );
  }

  let flag: { present: boolean; value: string };
  try {
    flag = resolveOpsStatusRemoteFlag(opts);
  } catch (err) {
    return fail(out, 'usage-error', err instanceof Error ? err.message : String(err));
  }
  if (!flag.present) {
    return fail(out, 'usage-error', 'elanous ops status: -r / --remote is required for remote ops status');
  }

  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const store = (opts.remotesStore ?? (() => new RemotesStore()))();
  const named = flag.value.length > 0 ? flag.value : undefined;
  const entry = named ? store.getRemote(named) : store.getDefaultRemote();
  const label = named ?? defaultBookmarkName(store) ?? '<default>';
  if (!entry) return fail(out, 'remote-error', bookmarkError(named));

  let defaults: { host: string; tokenFile: string };
  try {
    defaults = bookmarkAttachDefaults(entry);
  } catch (err) {
    return fail(
      out,
      'remote-error',
      `elanous ops status: remote bookmark ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const token = store.readToken(entry)?.trim();
  if (!token) {
    return fail(
      out,
      'remote-error',
      `elanous ops status: remote bookmark ${label} (${entry.host}): token file is missing or empty (${defaults.tokenFile})`,
    );
  }

  let origin: string;
  try {
    origin = opsStatusRemoteHttpOrigin(defaults.host);
  } catch (err) {
    return fail(
      out,
      'remote-error',
      `elanous ops status: remote bookmark ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tasksUrl = `${origin}${REMOTE_OPS_TASKS_PATH}`;
  const armingUrl = `${origin}${REMOTE_OPS_ARMING_PATH}`;

  const [tasksGot, armingGot] = await Promise.all([
    liveGetJson(tasksUrl, token, timeoutMs),
    liveGetJson(armingUrl, token, timeoutMs),
  ]);

  const failed = firstFailedFetch([
    { path: REMOTE_OPS_TASKS_PATH, url: tasksUrl, got: tasksGot },
    { path: REMOTE_OPS_ARMING_PATH, url: armingUrl, got: armingGot },
  ]);
  if (failed) {
    return fail(
      out,
      classifyFetchFailure(failed.got),
      `elanous ops status: remote bookmark ${label}: lookup failed for GET ${failed.path} at ${failed.url}: ${failed.got.reason}`,
    );
  }

  let tasks: RemoteTasksView;
  let arming: RemoteArmingView;
  try {
    tasks = parseTasksBody((tasksGot as JsonGetOk).body);
    arming = parseArmingBody((armingGot as JsonGetOk).body);
  } catch (err) {
    return fail(
      out,
      'server-error',
      `elanous ops status: remote bookmark ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const message = opts.json === true
    ? JSON.stringify({
      bookmark: label,
      tasks: {
        total: tasks.total,
        open: tasks.open,
        terminal: tasks.terminal,
        byStatus: tasks.byStatus,
        route: REMOTE_OPS_TASKS_PATH,
      },
      arming: { ...arming, route: REMOTE_OPS_ARMING_PATH },
      loops: { unavailable: true, reason: REMOTE_OPS_LOOPS_UNAVAILABLE },
      health: { unavailable: true, reason: REMOTE_OPS_HEALTH_UNAVAILABLE },
    }, null, 2)
    : formatRemoteOpsStatus({ bookmark: label, tasks, arming });
  out.log(message);
  return { exitCode: 0, classification: 'ok', message };
}

/** Own GET `fetch()` — 공용 HTTP 계층이 없고 다른 문의 liveFetch 를 import 하지 않는다. */
async function liveGetJson(
  url: string,
  token: string,
  timeoutMs = DEFAULT_REMOTE_OPS_STATUS_TIMEOUT_MS,
): Promise<JsonGetResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        ok: false,
        status: 0,
        timeout: true,
        reason: `no response within ${timeoutMs}ms (remote daemon unreachable or hung)`,
      };
    }
    return { ok: false, status: 0, reason: (error as Error).message };
  }
  if (!response.ok) {
    const body = await readBody(response);
    return {
      ok: false,
      status: response.status,
      reason: `HTTP ${response.status}${body ? `: ${body}` : ''}`,
    };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, status: response.status, reason: `invalid JSON: ${(error as Error).message}` };
  }
}

function formatRemoteOpsStatus(view: {
  bookmark: string;
  tasks: RemoteTasksView;
  arming: RemoteArmingView;
}): string {
  const taskBits = [
    view.tasks.open !== undefined ? `open ${view.tasks.open}` : undefined,
    view.tasks.terminal !== undefined ? `terminal ${view.tasks.terminal}` : undefined,
  ].filter((bit): bit is string => bit !== undefined);
  const taskExtra = taskBits.length > 0 ? ` — ${taskBits.join(' · ')}` : '';
  const armingBits = [
    `absorb=${renderArmingBit(view.arming.absorb)}`,
    `merge=${renderArmingBit(view.arming.merge)}`,
    `reboot=${renderArmingBit(view.arming.reboot)}`,
    `materialize=${renderArmingBit(view.arming.materialize)}`,
  ].join(' ');
  return [
    `원격 운영 상태 북마크 ${view.bookmark}`,
    `  태스크  ${view.tasks.total}건${taskExtra}  · GET ${REMOTE_OPS_TASKS_PATH}`,
    `  arming  ${armingBits}  · GET ${REMOTE_OPS_ARMING_PATH}`,
    `  루프    ${REMOTE_OPS_LOOPS_UNAVAILABLE}`,
    `  건강    ${REMOTE_OPS_HEALTH_UNAVAILABLE}`,
  ].join('\n');
}

function parseTasksBody(body: unknown): RemoteTasksView {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`remote ${REMOTE_OPS_TASKS_PATH} response is not an object`);
  }
  const rec = body as Record<string, unknown>;
  if (rec.summary === null || typeof rec.summary !== 'object' || Array.isArray(rec.summary)) {
    throw new Error(`remote ${REMOTE_OPS_TASKS_PATH} response is missing a summary object`);
  }
  const summary = rec.summary as Record<string, unknown>;
  if (typeof summary.total !== 'number' || !Number.isFinite(summary.total)) {
    throw new Error(`remote ${REMOTE_OPS_TASKS_PATH} response is missing summary.total`);
  }
  return {
    total: summary.total,
    open: typeof summary.open === 'number' && Number.isFinite(summary.open) ? summary.open : undefined,
    terminal: typeof summary.terminal === 'number' && Number.isFinite(summary.terminal) ? summary.terminal : undefined,
    byStatus: isStringCountMap(summary.byStatus) ? summary.byStatus : undefined,
  };
}

function parseArmingBody(body: unknown): RemoteArmingView {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`remote ${REMOTE_OPS_ARMING_PATH} response is not an object`);
  }
  const rec = body as Record<string, unknown>;
  if (rec.arming === null || typeof rec.arming !== 'object' || Array.isArray(rec.arming)) {
    throw new Error(`remote ${REMOTE_OPS_ARMING_PATH} response is missing an arming object`);
  }
  const arming = rec.arming as Record<string, unknown>;
  return {
    absorb: arming.absorb,
    merge: arming.merge,
    reboot: arming.reboot,
    materialize: arming.materialize,
  };
}

function isStringCountMap(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((n) => typeof n === 'number' && Number.isFinite(n));
}

function renderArmingBit(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === undefined) return 'unknown';
  if (value === null) return 'none';
  return String(value);
}

function firstFailedFetch(
  rows: Array<{ path: string; url: string; got: JsonGetResult }>,
): { path: string; url: string; got: JsonGetFail } | undefined {
  for (const row of rows) {
    if (!row.got.ok) return { path: row.path, url: row.url, got: row.got };
  }
  return undefined;
}

function classifyFetchFailure(got: JsonGetFail): Exclude<OpsStatusRemoteClassification, 'ok'> {
  if (got.timeout === true || got.reason.includes('no response within')) return 'timeout';
  if (got.status >= 400) return 'http-error';
  if (got.reason.includes('invalid JSON') || got.reason.startsWith('remote ')) return 'server-error';
  return 'transport-error';
}

function opsStatusRemoteHttpOrigin(host: string): string {
  const raw = host.trim();
  if (!raw) throw new Error('remote bookmark host is empty');
  const parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`remote bookmark host has unsupported protocol ${parsed.protocol}`);
  }
  return parsed.origin;
}

function defaultBookmarkName(store: RemotesStore): string | undefined {
  return store.listRemotes().find((row) => row.isDefault)?.name;
}

function bookmarkError(named: string | undefined): string {
  return named
    ? `--remote ${named}: unknown bookmark. Run \`elanous nexus list\` to see available remotes.`
    : 'no default remote bookmark. Run `elanous nexus connect <host> --default` to set one.';
}

/** ⛔ env override 를 «두지 않는다» — 이 판의 수용 기준에 없는 외부 계약이 되고,
 *  이 저장소의 새 노브는 env 가 아니라 user-config 가 먼저다. 호출자가 값을 주면 그것을 쓴다. */
function resolveTimeoutMs(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_REMOTE_OPS_STATUS_TIMEOUT_MS;
}

async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

function fail(
  out: NonNullable<OpsStatusRemoteOpts['out']>,
  classification: Exclude<OpsStatusRemoteClassification, 'ok'>,
  message: string,
): OpsStatusRemoteResult {
  out.error(message);
  return { exitCode: 1, classification, message };
}

function defaultOut(): NonNullable<OpsStatusRemoteOpts['out']> {
  return {
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
  };
}
