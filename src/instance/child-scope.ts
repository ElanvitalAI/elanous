import { debug } from '../debug/log.js';
import { getUserConfig, type SelfImplementChildInstanceMode } from '../user-config.js';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot, measureUniverse, treeDerivedRootFor, universeMismatch, type UniverseMeasure } from './resolve.js';

interface ChildInstanceScope {
  configDir?: string;
  stateDir?: string;
  elanousBinRoot: string;
  /**
   * ⛔⭐⭐⭐ **이 `stateDir` 이 «파생»인가 — 자식이 그것을 알아야 한다**(2026-08-19 · `OBS-T121`).
   *
   * 🚨 왜 필요한가 — 자식은 `ELANOUS_STATE_DIR` «문자열 하나»만 받는다. 그래서
   *   ***「사람이 격리를 말했다」와 「부모가 트리에서 «파생»해 줬다」를 구분할 수 없다.***
   *   ⇒ 그 결과 「바깥 계정의 상태」(쿼터 신호)까지 그 우주에서 읽고, 아무도 갱신하지 않는
   *     사본이 낡아 ***회전이 이미 100% 인 계정을 골랐다*** — 같은 골이 «네 번» 429 로 죽었다.
   * ⭐ 이 함수는 그 구분을 ***이미 `why` 로 로그에 적고 있었다*** — 값으로 안 냈을 뿐이다(`F41`).
   * ⛔ `'preserved'`(부모 우주 물려받음)에는 «안 붙인다** — 그건 부모가 이미 들고 있는 딱지를
   *   env 상속으로 그대로 물려주는 것이 옳다(딱지를 새로 만들면 부모의 「명시」를 덮어쓴다).
   */
  stateDirSource?: 'derived';
}

/**
 * ⛔⭐⭐ **자식 우주의 config 는 «운영의 사본»이고, 한 번 뜬 뒤로 운영을 따라오지 않는다**
 *   (`elanous config sync-test` 가 물질화한 사본 — `src/cli/config-test-sync.ts`).
 *
 * 🚨 2026-09-23 실물 과금 인시던트: 한 트리의 격리 사본이 **2026-09-10 부터 `openai-codex` 로 얼어**
 *   있었고, 운영은 그 뒤 grok 으로 옮겨졌다. ***그 우주의 런들은 계속 codex 로 쐈고 아무도 몰랐다.***
 *   ⛔ 이 파일 머리말이 적은 「낡은 사본이 100% 계정을 골랐다」와 **같은 뿌리의 다른 축**이다
 *     (그때는 «쿼터 신호» 축만 고쳤다 — 이번은 «provider» 축).
 *
 * ⚠️ `isTestConfigStale`(mtime 비교)은 이 구멍을 **못 막는다** — ⑴ 호출부가 discord·telegram·pwa·
 *   `--state-dir` 넷뿐이고 ***하니스 발사 경로에 없으며***, ⑵ mtime 은 「무엇이 달라졌나」를 말하지 않는다.
 *   ⇒ 여기서는 ***돈이 걸린 한 칸(`llm.provider`)만*** 본다.
 *
 * ⛔ **막지 않는다 — 관측만 한다.** 자식 우주를 다른 provider 로 «일부러» 띄우는 실험이 정당하고,
 *   여기서 막으면 그 실험이 죽는다. 판정은 사람·상위 자의 몫이고 이 함수는 「그런 일이 있었다」만 남긴다.
 * ⛔ **세 결과다** — `same` / `differs` / ***`unknown`(못 쟀다)***. 못 읽은 것을 「같다」로 접지 않는다.
 */
function rawLlmProviderAt(root: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as Record<string, unknown>;
    const llm = raw.llm as Record<string, unknown> | undefined;
    const provider = llm?.provider;
    return typeof provider === 'string' && provider.length > 0 ? provider : null;
  } catch {
    return null;
  }
}

export interface ChildInstanceScopeDeps {
  effectiveRoot?: () => string;
  prodRoot?: () => string;
  derivedRoot?: (cwd: string) => string | null;
  cwd?: () => string;
  childInstanceMode?: () => SelfImplementChildInstanceMode;
  log?: (event: string, data: Record<string, unknown>, warn?: boolean) => void;
  /** Raw `llm.provider` at an instance root; tests inject. Returns `null` when it cannot be read. */
  rawProviderAt?: (root: string) => string | null;
}

function configuredChildInstanceMode(): SelfImplementChildInstanceMode {
  return getUserConfig().tools.selfImplement.childInstanceMode;
}

function instanceScopeLog(event: string, data: Record<string, unknown>, warn = false): void {
  debug.log('instance.identity', event, data, warn ? { level: 'warn' } : undefined);
}

/**
 * 부모가 도장(`ELANOUS_STATE_DIR`)으로 물려준 우주와 이 프로세스가 실제로 쓰는 우주를 대조한다.
 * 다르면 `instance.identity universe-mismatch` 경고 한 줄을 남긴다 — 막지 않고 적기만 한다.
 * 도장이 없으면(사람이 직접 띄운 입구) 비교할 부모가 없으므로 조용하다.
 */
export function observeUniverseMismatch(
  deps: { stamp?: string | undefined; effectiveRoot?: () => string; log?: ChildInstanceScopeDeps['log'] } = {},
): { parentRoot: string; childRoot: string } | null {
  const stamp = 'stamp' in deps ? deps.stamp : process.env.ELANOUS_STATE_DIR;
  const mismatch = universeMismatch(stamp, (deps.effectiveRoot ?? effectiveInstanceRoot)());
  if (mismatch) (deps.log ?? instanceScopeLog)('universe-mismatch', { ...mismatch, why: 'child resolved a different universe than the one its parent stamped' }, true);
  return mismatch;
}

/**
 * 읽을 우주가 비어 있으면 «0» 이 아니라 «측정 불가(빈 우주)» 라고 `instance.identity universe-unmeasurable` 로 적는다.
 * 새 test 우주는 늘 비어 있으므로 경고(warn)가 아니라 정보 한 줄이다 — 막지 않고 적기만 한다.
 */
export function observeEmptyUniverse(
  root: string,
  deps: { entries?: (dir: string) => string[]; log?: ChildInstanceScopeDeps['log'] } = {},
): UniverseMeasure {
  const measure = measureUniverse(root, deps.entries);
  if (!measure.measurable) (deps.log ?? instanceScopeLog)('universe-unmeasurable', { root, reason: measure.reason, why: '읽을 우주가 비어 있어 0 이 아니라 측정 불가로 취급한다' });
  return measure;
}

/** Resolve the current universe once; operational parents derive an isolated child universe by default. */
export function childInstanceScope(deps: ChildInstanceScopeDeps = {}): ChildInstanceScope {
  const elanousBinRoot = resolve(import.meta.dir, '../..');
  const root = (deps.effectiveRoot ?? effectiveInstanceRoot)();
  const prodRoot = (deps.prodRoot ?? prodInstanceRoot)();
  const parentIsProduction = root === prodRoot;
  const mode = (deps.childInstanceMode ?? configuredChildInstanceMode)();
  const log = deps.log ?? instanceScopeLog;
  if (!deps.effectiveRoot) {
    observeUniverseMismatch({ effectiveRoot: () => root, log });
    observeEmptyUniverse(root, { log });
  }

  const readProvider = deps.rawProviderAt ?? rawLlmProviderAt;
  /** 자식이 갈 우주의 provider 가 운영과 어긋나는지 «한 칸»으로 남긴다. 판정하지 않고 적기만 한다. */
  const observeProviderDrift = (childRoot: string, why: string): void => {
    const child = readProvider(childRoot);
    const prod = readProvider(prodRoot);
    // ⛔⭐ **「둘 다 못 읽음」은 «어긋남이 아니다»** — 아직 config 가 물질화되지 않은 새 우주에서 늘 그렇다.
    //   거기에 경고를 내면 정상 상태가 매번 시끄러워지고, ***그 소음이 진짜 한 줄을 덮는다.***
    //   ⇒ 적을 가치가 있는 「못 쟀다」는 ***비대칭***뿐이다 — 한쪽은 읽히는데 다른 쪽이 안 읽히는 경우.
    if (child === null && prod === null) return;
    const verdict = child === null || prod === null ? 'unknown' : child === prod ? 'same' : 'differs';
    if (verdict === 'same') return; // 같으면 조용하다 — 소음을 만들지 않는다.
    log('child-config-provider-drift', {
      verdict, childProvider: child, prodProvider: prod, childRoot, prodRoot, why,
    }, verdict === 'differs');
  };

  if (!parentIsProduction) {
    const scope = { configDir: root, stateDir: root, elanousBinRoot };
    log('child-scope', { parentIsProduction, mode, scope, why: 'parent is already non-production; preserve its universe' });
    observeProviderDrift(root, 'parent universe preserved; its config copy may predate the operational one');
    return scope;
  }
  if (mode === 'inherit') {
    const scope = { elanousBinRoot };
    log('child-scope', { parentIsProduction, mode, scope, why: 'operator selected parent-universe inheritance' });
    return scope;
  }

  try {
    const childRoot = (deps.derivedRoot ?? treeDerivedRootFor)((deps.cwd ?? process.cwd)());
    if (!childRoot) throw new Error('derived child root is unavailable');
    const scope = { configDir: childRoot, stateDir: childRoot, elanousBinRoot, stateDirSource: 'derived' as const };
    log('child-scope', { parentIsProduction, mode, scope, why: 'operational parent defaults to a resolver-derived isolated child universe' });
    observeProviderDrift(childRoot, 'derived child universe carries a materialized copy that does not follow production');
    return scope;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log('child-scope-failed', {
      parentIsProduction,
      mode,
      reason,
      why: 'could not derive an isolated child universe; refusing to spawn into the operational parent universe',
    }, true);
    throw new Error(`unable to derive isolated child universe: ${reason}`, { cause: error });
  }
}
