/** ⭐ 런 계약 — 그래프가 «시작할 때 한 번» 정하고 모든 노드가 따르는 약속(대표 2026-09-26).
 *
 *  대표: «초반에 계약을 기술하면 안에 있는 그래프 노드들이 그 계약(원격)을 준수하는 구조».
 *  🩸 그 전까지 그래프 선언에는 «실행 칸»을 적을 자리가 없었다(`graph-yaml.ts` 최상위 칸 여덟).
 *    `--substrate pod` 는 CLI 갈래였고, Pod 안의 그래프는 자기가 Pod 인 줄 몰랐다 —
 *    그래서 Pod 안에서 `completion: worktree-only` 로 끝나면 결과가 Pod 와 함께 사라질 수 있었다.
 *
 *  해석 순서(먼저 있는 것이 이긴다): 발사 인자 → 부모가 실어 준 계약(env) → 그래프 선언 → 기본(local).
 *  ⛔ 계약은 런 안에서 «바뀌지 않는다» — 미래 노드를 바꾸는 것은 계약에서 «파생»된 오버레이다(RFC §4.3 ⑴).
 */

export type RunSubstrate = 'local' | 'pod';
/** 허용 부작용(우주 RFC #20662 A3) — 발급 자격과 «짝»으로 검증된다(시크릿 콜렉션 뒤). */
export type RunEffects = 'none' | 'draft-pr' | 'merge' | 'outbound';
const EFFECTS: readonly RunEffects[] = ['none', 'draft-pr', 'merge', 'outbound'];
export function isRunEffects(value: unknown): value is RunEffects {
  return typeof value === 'string' && (EFFECTS as readonly string[]).includes(value);
}
export type RunContractSource = 'launch' | 'parent' | 'graph' | 'default';

export interface RunContract {
  readonly substrate: RunSubstrate;
  readonly source: RunContractSource;
  /** 주입 프로필 이름(우주 RFC #20662 A1) — 없으면 «선언 안 됨». */
  readonly profile?: string;
  readonly profileSource?: RunContractSource;
  readonly effects?: RunEffects;
  readonly effectsSource?: RunContractSource;
}

/** 그래프 YAML 의 `run_contract:` 칸(선택). */
export interface GraphRunContractSpec {
  readonly substrate?: RunSubstrate;
  readonly profile?: string;
  readonly effects?: RunEffects;
}

/** 부모가 자식(Pod)에게 계약을 싣는 환경 변수. */
export const RUN_CONTRACT_ENV = 'ELANOUS_RUN_CONTRACT';
/** 지금 프로세스가 «실제로» 어느 칸에서 도는가 — Pod 매니페스트가 단다. */
export const ACTUAL_SUBSTRATE_ENV = 'ELANOUS_SUBSTRATE';

export function isRunSubstrate(value: unknown): value is RunSubstrate {
  return value === 'local' || value === 'pod';
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export function parseGraphRunContract(raw: unknown): { spec?: GraphRunContractSpec; error?: string } {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object') return { error: 'run_contract 는 맵이어야 한다' };
  const r = raw as Record<string, unknown>;
  if (r.substrate !== undefined && !isRunSubstrate(r.substrate)) return { error: `run_contract.substrate 는 local|pod (받은 값: ${JSON.stringify(r.substrate)})` };
  if (r.profile !== undefined && (typeof r.profile !== 'string' || !PROFILE_NAME.test(r.profile))) return { error: `run_contract.profile 은 이름(영숫자·-·_) (받은 값: ${JSON.stringify(r.profile)})` };
  if (r.effects !== undefined && !isRunEffects(r.effects)) return { error: `run_contract.effects 는 ${EFFECTS.join('|')} (받은 값: ${JSON.stringify(r.effects)})` };
  return { spec: { ...(r.substrate !== undefined ? { substrate: r.substrate as RunSubstrate } : {}), ...(r.profile !== undefined ? { profile: r.profile as string } : {}), ...(r.effects !== undefined ? { effects: r.effects as RunEffects } : {}) } };
}

export function resolveRunContract(input: {
  launch?: RunSubstrate;
  launchProfile?: string;
  launchEffects?: RunEffects;
  graph?: GraphRunContractSpec;
  env?: NodeJS.ProcessEnv;
}): RunContract {
  const carried = readCarriedContract(input.env ?? process.env);
  // 칸마다 따로 푼다 — 발사 인자 → 부모가 실은 계약 → 그래프 선언 → 기본.
  const pick = <T>(launch: T | undefined, parent: T | undefined, graph: T | undefined): { value?: T; source?: RunContractSource } =>
    launch !== undefined ? { value: launch, source: 'launch' }
      : parent !== undefined ? { value: parent, source: 'parent' }
        : graph !== undefined ? { value: graph, source: 'graph' } : {};
  const sub = pick(input.launch, carried?.substrate, input.graph?.substrate);
  const profile = pick(input.launchProfile, carried?.profile, input.graph?.profile);
  const effects = pick(input.launchEffects, carried?.effects, input.graph?.effects);
  return {
    substrate: sub.value ?? 'local', source: sub.source ?? 'default',
    ...(profile.value !== undefined ? { profile: profile.value, profileSource: profile.source! } : {}),
    ...(effects.value !== undefined ? { effects: effects.value, effectsSource: effects.source! } : {}),
  };
}

function readCarriedContract(env: NodeJS.ProcessEnv): { substrate?: RunSubstrate; profile?: string; effects?: RunEffects } | null {
  const raw = env[RUN_CONTRACT_ENV]?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { substrate?: unknown; profile?: unknown; effects?: unknown };
    const out = {
      ...(isRunSubstrate(parsed.substrate) ? { substrate: parsed.substrate } : {}),
      ...(typeof parsed.profile === 'string' && PROFILE_NAME.test(parsed.profile) ? { profile: parsed.profile } : {}),
      ...(isRunEffects(parsed.effects) ? { effects: parsed.effects } : {}),
    };
    return Object.keys(out).length > 0 ? out : null;
  } catch { return null; }
}

/** 자식에게 실을 값 — 부모가 정한 계약을 그대로 넘긴다(자식이 다시 고르지 않는다). */
export function carryRunContract(contract: Pick<RunContract, 'substrate'> & Partial<Pick<RunContract, 'profile' | 'effects'>>): string {
  return JSON.stringify({ substrate: contract.substrate, ...(contract.profile ? { profile: contract.profile } : {}), ...(contract.effects ? { effects: contract.effects } : {}) });
}

export function actualSubstrate(env: NodeJS.ProcessEnv = process.env): RunSubstrate {
  return env[ACTUAL_SUBSTRATE_ENV] === 'pod' ? 'pod' : 'local';
}

/** 노드 진입마다 싣는 대조 — 「이 걸음이 계약대로의 칸에서 났나」를 원장이 답하게 한다. */
export function runContractAtNode(contract: RunContract, env: NodeJS.ProcessEnv = process.env): {
  readonly contractSubstrate: RunSubstrate;
  readonly actualSubstrate: RunSubstrate;
  readonly contractHonored: boolean;
  readonly profile?: string;
  readonly effects?: RunEffects;
  /** 발급 자격 ↔ effects 짝. ⛔ 시크릿 콜렉션(발급 원장)이 서기 전엔 잴 수 없다 — true 로 채우지 않는다. */
  readonly effectsHonored: boolean | 'unmeasured';
} {
  const actual = actualSubstrate(env);
  return {
    contractSubstrate: contract.substrate, actualSubstrate: actual, contractHonored: actual === contract.substrate,
    ...(contract.profile !== undefined ? { profile: contract.profile } : {}),
    ...(contract.effects !== undefined ? { effects: contract.effects } : {}),
    effectsHonored: 'unmeasured',
  };
}

/** 계약에서 파생된 완료 하한 — Pod 는 끝나면 사라지므로 작업 트리로만 끝내면 결과가 없어진다. */
export function completionFloorFor(contract: Pick<RunContract, 'substrate'>): 'pr' | null {
  return contract.substrate === 'pod' ? 'pr' : null;
}
