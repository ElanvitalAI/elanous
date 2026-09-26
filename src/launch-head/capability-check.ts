/**
 * 발사 앞 머리 ① — 골 문서만 보고 «Pod 로 가도 되나(any) · 이 기계에서만 되나(local-only)».
 *
 * 순수 함수다. 파일·네트워크·프로세스를 부르지 않는다. 입력은 인자로만 받는다.
 * 요구 능력은 이 파일의 규칙 표 한 곳에서만 뽑는다.
 */

export type CapabilityOutcome = 'local-only' | 'any';

export interface CapabilityCheckInput {
  goalText: string;
  /** 호출자가 이미 알고 있으면 넘긴다. 없으면 골 문서 첫 줄 `대상 경로:` 에서 읽는다. */
  targetPaths?: readonly string[];
}

export interface CapabilityCheckResult {
  outcome: CapabilityOutcome;
  required: string[];
  reasons: string[];
}

interface PathRule {
  /** 경로 glob. `**` 는 슬래시를 포함한 나머지, `*` 는 슬래시를 제외한 한 조각. */
  glob: string;
  capability: string | null;
}

interface TextRule {
  /** 골 문면에서 이 표지가 보이면 capability 를 요구한다. */
  marker: string;
  capability: string;
}

/**
 * 대상 경로 → 요구 능력. `capability: null` 은 «이 경로는 요구가 없다»는 명시 규칙이다.
 * 예: apps/ios/** → xcode · src/install/launchd* · **\/launchd*.ts → host-launchd · apps/pwa/** 는 요구 없음.
 */
export const PATH_CAPABILITY_RULES: readonly PathRule[] = [
  { glob: 'apps/ios/**', capability: 'xcode' },
  { glob: 'src/install/launchd*', capability: 'host-launchd' },
  { glob: '**/launchd*.ts', capability: 'host-launchd' },
  { glob: 'apps/pwa/**', capability: null },
];

/**
 * 골 문면 표지 → 요구 능력.
 * «라이브 TUI» · pty snapshot · --hold → live-tui
 * «운영 우주» · ~/.elanous 에 쓰기 → host-universe
 * 키체인 → host-keychain
 */
export const TEXT_CAPABILITY_RULES: readonly TextRule[] = [
  { marker: '라이브 TUI', capability: 'live-tui' },
  { marker: 'pty snapshot', capability: 'live-tui' },
  { marker: '--hold', capability: 'live-tui' },
  { marker: '운영 우주', capability: 'host-universe' },
  { marker: '~/.elanous', capability: 'host-universe' },
  { marker: '키체인', capability: 'host-keychain' },
];

/**
 * Pod 가 가진 능력. 하나뿐인 상수.
 *
 * 빈 집합이다. 위 규칙이 이름으로 드는 능력(xcode · host-launchd · live-tui ·
 * host-universe · host-keychain)은 전부 «이 기계에서만» 되는 호스트 능력이고,
 * Pod 이미지 안에 없다고 이 골이 정한다. 요구가 하나도 없으면(규칙에 안 걸리는
 * 경로 · apps/pwa/** 처럼 요구 없음으로 적힌 경로) 요구 ⊆ Pod 라 `any` 다.
 * 요구가 하나라도 이 집합 밖이면 `local-only` 다.
 */
export const POD_CAPABILITIES: readonly string[] = [];

const TARGET_PATHS_PREFIX = '대상 경로:';
const NO_TARGET_PATHS_REASON = '대상 경로 없음';

/** 골 문서 첫 줄 `대상 경로:` 를 `·` 로 갈라 읽는다. 표지가 없으면 빈 목록. */
export function readTargetPaths(goalText: string): string[] {
  const firstLine = goalText.split(/\r?\n/, 1)[0] ?? '';
  const trimmed = firstLine.trim();
  if (!trimmed.startsWith(TARGET_PATHS_PREFIX)) return [];
  const rest = trimmed.slice(TARGET_PATHS_PREFIX.length).trim();
  if (!rest) return [];
  return rest.split('·').map((part) => part.trim()).filter((part) => part.length > 0);
}

function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else if ('\\^$+?.()|{}[]'.includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  source += '$';
  return new RegExp(source);
}

const PATH_RULE_REGEX: readonly { rule: PathRule; re: RegExp }[] = PATH_CAPABILITY_RULES.map((rule) => ({
  rule,
  re: globToRegExp(rule.glob),
}));

function capabilitiesForPath(targetPath: string): { capability: string; glob: string }[] {
  const normalized = targetPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const hits: { capability: string; glob: string }[] = [];
  for (const { rule, re } of PATH_RULE_REGEX) {
    if (rule.capability && re.test(normalized)) hits.push({ capability: rule.capability, glob: rule.glob });
  }
  return hits;
}

export function checkCapability(input: CapabilityCheckInput): CapabilityCheckResult {
  const goalText = input.goalText ?? '';
  const explicit = input.targetPaths;
  const fromDoc = readTargetPaths(goalText);
  const targetPaths = explicit !== undefined ? [...explicit] : fromDoc;
  const missingTargetPaths = targetPaths.length === 0;

  const required: string[] = [];
  const reasons: string[] = [];
  const seen = new Set<string>();

  const push = (capability: string, reason: string): void => {
    if (!seen.has(capability)) {
      seen.add(capability);
      required.push(capability);
    }
    reasons.push(reason);
  };

  if (missingTargetPaths) reasons.push(NO_TARGET_PATHS_REASON);

  for (const targetPath of targetPaths) {
    for (const hit of capabilitiesForPath(targetPath)) {
      push(hit.capability, `${targetPath} → ${hit.capability} (${hit.glob})`);
    }
  }

  for (const rule of TEXT_CAPABILITY_RULES) {
    if (goalText.includes(rule.marker)) {
      push(rule.capability, `«${rule.marker}» → ${rule.capability}`);
    }
  }

  const pod = new Set(POD_CAPABILITIES);
  const blocked = required.filter((capability) => !pod.has(capability));
  if (blocked.length === 0) {
    return { outcome: 'any', required, reasons };
  }
  for (const capability of blocked) {
    reasons.push(`${capability} 는 POD_CAPABILITIES 밖이라 local-only`);
  }
  return { outcome: 'local-only', required, reasons };
}
