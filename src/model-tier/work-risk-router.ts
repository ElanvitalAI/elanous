// HARNESS-DIFFICULTY-ROUTER (대표 11-17 «소총으로 끝낼 일에 탱크를 내지 않는다»)
//
// S: 같은 하니스에서 budget 모델은 문자열·UI 일은 1라운드에 끝내고, 영속·동시성 일은 3~4라운드를 돈다
//    (seat-state/ELN-DOGFOOD/AB-HARNESS-VS-MODEL-1117.md).
// C: 지금 자식 모델은 일감의 «위험»을 모른 채 한 등급으로 고정된다 — 쉬운 일에 강한 모델을 쓰거나,
//    어려운 일의 설계·판정까지 약한 모델에 맡긴다.
// Q: 일감마다 무엇을 근거로 등급을 고르고, 그 선택을 어떻게 사후에 검증하나?
// A: 바뀔 경로(구조 신호)만으로 위험 범주와 Bloom 단계를 정한다. 이 판정이 코어(`orchestration-core.ts`)의
//    «일감 신호» 입력이다. 등급 → 사다리 칸 → 모델은 코어만 푼다(호출 경로 하나).
//    ⛔ 골 산문에 정규식을 걸지 않는다(A205 · R-SIG) — 경로 문자열 분해와 선언된 범주·등급 칸만 읽는다.

import type { BloomStage, WorkLevel, WorkRiskCategory } from './orchestration-core.js';

export type { BloomStage, WorkLevel, WorkRiskCategory } from './orchestration-core.js';

export const WORK_RISK_CATEGORIES: readonly WorkRiskCategory[] = ['persistence', 'locking', 'cross-process', 'security'];
export const WORK_LEVELS: readonly WorkLevel[] = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

/** 경로 조각(디렉터리·파일 이름을 `/ . _ -`·camelCase 경계로 나눈 소문자 토큰) → 위험 범주.
 *  토큰 «전체 일치»만 본다(부분 문자열 아님) — `restore` 는 `store` 로 읽히지 않는다. */
export const WORK_RISK_PATH_TOKENS: Readonly<Record<WorkRiskCategory, readonly string[]>> = {
  persistence: ['store', 'stores', 'db', 'sqlite', 'database', 'ledger', 'ledgers', 'session', 'sessions',
    'persist', 'persistence', 'persisted', 'journal', 'wal', 'migration', 'migrations'],
  locking: ['lock', 'locks', 'locked', 'mutex', 'flock', 'semaphore', 'lease', 'leases'],
  'cross-process': ['daemon', 'ipc', 'socket', 'sockets', 'pty', 'nexus', 'rpc', 'spawn', 'herdr', 'supervisor'],
  // ⛔ `token` 은 넣지 않는다 — UI 디자인 토큰·토큰 수 세기 파일까지 L4 로 끌어올린다.
  security: ['secret', 'secrets', 'credential', 'credentials', 'cred', 'creds', 'auth', 'oauth', 'vault', 'keychain'],
};

const BLOOM_BY_LEVEL: Readonly<Record<WorkLevel, BloomStage>> = {
  L1: 'remember', L2: 'understand', L3: 'apply', L4: 'analyze', L5: 'evaluate', L6: 'create',
};

// ── 숫자 상수(NUMGUARD — 출처) ────────────────────────────────────────────────
/** 위험 없는 일감: 바꿀 코드 경로가 이 수 이하면 L1. 출처: ASK §1 «문자열·UI 1라운드» = 한 파일 손질. */
export const PLAIN_L1_MAX_PATHS = 1;
/** 위험 없는 일감: 이 수 이하면 L2, 넘으면 L3. 출처: 기존 small/medium 경계가 5경로 — 그 절반 아래를 «이해» 단계로 둔다. */
export const PLAIN_L2_MAX_PATHS = 3;
/** 원장 한 줄에 싣는 근거 수 상한 — 경로 수백 개 골이 원장 한 줄을 부풀리지 않게. 출처: 칸 «대상 경로» 관례 상한이 한 자릿수(OPERATIONS 칸 문면). */
export const WORK_ROUTE_MAX_REASONS = 20;

export interface WorkRiskInput {
  /** 바뀔 경로 또는 glob(저장소 상대). 문서(.md·docs/)는 런타임 위험이 없어 세지 않는다. */
  readonly paths: readonly string[];
  /** 칸·골 메타에 «선언된» 위험 범주(구조 칸). 모르는 이름은 버린다. */
  readonly declaredCategories?: readonly string[];
  /** 사람·칸이 정한 등급. 위험 범주가 있으면 그 하한(L4~) 아래로는 못 내린다. */
  readonly explicitLevel?: WorkLevel;
}

export interface WorkRiskClassification {
  readonly level: WorkLevel;
  readonly bloom: BloomStage;
  readonly reasons: readonly string[];
  readonly riskCategories: readonly WorkRiskCategory[];
}

export function isWorkLevel(value: unknown): value is WorkLevel {
  return typeof value === 'string' && (WORK_LEVELS as readonly string[]).includes(value);
}

function isWorkRiskCategory(value: unknown): value is WorkRiskCategory {
  return typeof value === 'string' && (WORK_RISK_CATEGORIES as readonly string[]).includes(value);
}

function isDocumentationPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.startsWith('docs/') || lower.includes('/docs/');
}

/** 경로 → 소문자 토큰(디렉터리·파일·camelCase 경계). glob 기호는 버린다. */
export function workPathTokens(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s/._\-*?{}[\],]+/)
    .filter(Boolean);
}

function levelIndex(level: WorkLevel): number {
  return WORK_LEVELS.indexOf(level);
}

function maxLevel(a: WorkLevel, b: WorkLevel): WorkLevel {
  return levelIndex(a) >= levelIndex(b) ? a : b;
}

/** 순수 판정 — 같은 입력이면 같은 출력. 범주 1개 = L4 · 2개 = L5 · 3개 이상 = L6. */
export function classifyWorkRisk(input: WorkRiskInput): WorkRiskClassification {
  const evidence: string[] = [];
  const found = new Set<WorkRiskCategory>();
  const codePaths = [...new Set(input.paths.map((path) => path.trim()).filter(Boolean))]
    .filter((path) => !isDocumentationPath(path));
  for (const declared of input.declaredCategories ?? []) {
    const name = declared.trim().toLowerCase();
    if (!isWorkRiskCategory(name)) continue;
    found.add(name);
    evidence.push(`declared:${name}`);
  }
  for (const path of codePaths) {
    const tokens = new Set(workPathTokens(path));
    for (const category of WORK_RISK_CATEGORIES) {
      if (WORK_RISK_PATH_TOKENS[category].some((token) => tokens.has(token))) {
        found.add(category);
        evidence.push(`path:${category}:${path}`);
      }
    }
  }
  const riskCategories = WORK_RISK_CATEGORIES.filter((category) => found.has(category));
  // 요약 근거(등급을 정한 줄)를 앞에 — 상한으로 잘려도 «왜 이 등급인가»는 남는다.
  const summary: string[] = [];
  let level: WorkLevel;
  if (riskCategories.length > 0) {
    // 범주 수 1·2·3+ → L4·L5·L6 (L4 부터 범주 하나마다 한 단계 · 상한 L6).
    level = WORK_LEVELS[Math.min(levelIndex('L4') + riskCategories.length - 1, levelIndex('L6'))]!;
    summary.push(`risk-floor:${level}`);
  } else if (codePaths.length === 0) {
    level = 'L3';
    summary.push('no-code-paths:L3');
  } else {
    level = codePaths.length <= PLAIN_L1_MAX_PATHS ? 'L1' : codePaths.length <= PLAIN_L2_MAX_PATHS ? 'L2' : 'L3';
    summary.push(`plain-paths:${codePaths.length}:${level}`);
  }
  if (input.explicitLevel) {
    const explicit = input.explicitLevel;
    const resolved = riskCategories.length > 0 ? maxLevel(explicit, level) : explicit;
    summary.push(resolved === explicit ? `explicit:${explicit}` : `explicit-below-risk-floor:${explicit}->${resolved}`);
    level = resolved;
  }
  return {
    level,
    bloom: BLOOM_BY_LEVEL[level],
    reasons: [...summary, ...evidence].slice(0, WORK_ROUTE_MAX_REASONS),
    riskCategories,
  };
}

/** L4 이상 = 위험 일감(설계·판정 강 · 구현 중). 등급 → 모델은 코어(`model-orchestration.ts`)만 푼다. */
export function isRiskyLevel(level: WorkLevel): boolean {
  return levelIndex(level) >= levelIndex('L4');
}

/** 문서의 «구조 칸» 줄(`<칸>: 값`) — 줄 머리 일치만 본다(산문 정규식 아님). */
export function structuredFieldValue(document: string, field: string): string | undefined {
  const prefix = `${field}:`;
  const line = document.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value ? value : undefined;
}

/** 가벼운 판정 입력 — `대상 경로:` · `위험 범주:` · `위험 등급:` 줄만(골 저작기 의존 없음 · 고 루프 자식용).
 *  `paths` 를 넘기면(발사측이 골 문서에서 이미 뽑은 경로) 그것을 쓴다. */
export function workRiskInputFromFields(document: string, paths?: readonly string[]): WorkRiskInput {
  const strip = (value: string) => value.replace(/`/g, '').trim();
  const targetPaths = paths ?? structuredFieldValue(document, '대상 경로')?.split(' · ').map(strip).filter(Boolean) ?? [];
  const declared = structuredFieldValue(document, '위험 범주')?.split(/\s*[·,]\s*/).map(strip).filter(Boolean);
  const explicit = structuredFieldValue(document, '위험 등급')?.replace(/`/g, '').trim().toUpperCase();
  return {
    paths: [...targetPaths],
    ...(declared?.length ? { declaredCategories: declared } : {}),
    ...(isWorkLevel(explicit) ? { explicitLevel: explicit } : {}),
  };
}
