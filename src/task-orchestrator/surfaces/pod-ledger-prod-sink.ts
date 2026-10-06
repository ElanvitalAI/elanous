import { debug } from '../../debug/log.js';
import { LogStore, logsDbPath } from '../../mss/logging/log-store.js';

type Emit = (category: string, event: string, data: Record<string, unknown>) => void;
type Store = Pick<LogStore, 'insertBatch'>;

/** 발사한 부모(`harness say --config-dir …`)가 정한 집의 logs.db — 부모가 자식 `self orchestrate` 에 env 로 넘긴다. */
export const POD_REEMIT_LOGS_DB_ENV = 'ELANOUS_POD_REEMIT_LOGS_DB';
export function launchHomeLogsDb(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[POD_REEMIT_LOGS_DB_ENV]?.trim() || undefined;
}

let cached: { path: string; store: Store } | null = null;
let announced = '';

/**
 * POD-OBS(10-06 · 0.2.16 P0 · OP 사양): Pod 자식 원장 «재방출»만 부모가 발사 때 정한 집(A)의 logs.db 로 보낸다.
 * 자식 orchestrate 는 트리 파생 test 우주(B)에서 돌아, 지금은 재방출이 B 에만 쌓였다(24h `ledger-collected` 운영 2 vs 다른 우주 250).
 * 자식 우주 원장·격리는 그대로 둔다. A 를 못 열면 조용히 버리지 않고 B 로 떨어뜨리며 경고한다.
 * env 가 없거나(옛 발사) A == B 이거나 시험 프로세스면 null → 호출측이 지금처럼 B 에만 쓴다.
 */
export function operationalReemit(opts: {
  currentDb?: string;
  operationalDb?: string;
  open?: (path: string) => Store;
  testProcess?: boolean;
  fallback?: Emit;
} = {}): Emit | null {
  const operationalDb = opts.operationalDb ?? launchHomeLogsDb();
  if (!operationalDb) return null;
  const currentDb = opts.currentDb ?? logsDbPath();
  const testProcess = opts.testProcess ?? (process.env.NODE_ENV === 'test' || !!process.env.ELANOUS_TEST_HOME);
  if (testProcess && !opts.open) return null;
  if (currentDb === operationalDb) return null;
  const open = opts.open ?? ((path: string) => new LogStore(path, { instance: 'prod' }));
  const fallback: Emit = opts.fallback ?? ((c, e, d) => debug.log(c, e, d));
  const write = (category: string, event: string, data: Record<string, unknown>): void => {
    if (!cached || cached.path !== operationalDb || opts.open) cached = { path: operationalDb, store: open(operationalDb) };
    cached.store.insertBatch([{ rec: { ts: new Date().toISOString(), category, event, data }, surface: 'pod-reemit' }]);
  };
  let warned = false;
  return (category, event, data) => {
    try {
      if (announced !== `${currentDb}->${operationalDb}` || opts.open) {
        // 어느 우주로 보냈는지 한 줄(A 에) — 조회자가 «B 에 왜 없나»를 여기서 본다.
        write('self-implement.pod', 'reemit-target', { targetUniverse: operationalDb, childUniverse: currentDb });
        announced = `${currentDb}->${operationalDb}`;
      }
      write(category, event, data);
    } catch (error) {
      fallback(category, event, data);
      if (warned) return;
      // 경고는 싱크(발사 하나)당 한 번 — 줄마다 찍으면 경고가 원장을 덮는다.
      warned = true;
      try {
        fallback('self-implement.pod', 'reemit-target-unavailable', {
          targetUniverse: operationalDb, childUniverse: currentDb, reason: error instanceof Error ? error.message : String(error),
        });
      } catch { /* nothing */ }
    }
  };
}

let shared: { key: string; emit: Emit } | null = null;

/** 재방출 기본 경로: 집(A)이 정해져 있으면 A 에만, 아니면 지금처럼 지금 우주(B)의 debug.log.
 *  프로세스(발사)당 싱크 하나 — collector 의 `log`·`emit`, follower 가 같은 싱크를 써서 경고·대상 줄이 한 번이다. */
export function defaultPodReemit(): Emit {
  const key = `${launchHomeLogsDb() ?? ''}->${logsDbPath()}`;
  if (shared?.key === key) return shared.emit;
  const operational = operationalReemit();
  const emit: Emit = operational ?? ((category, event, data) => { debug.log(category, event, data); });
  shared = { key, emit };
  return emit;
}
