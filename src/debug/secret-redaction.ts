/** Pure secret redaction helpers shared by runtime and low-level log modules. */
function safeStringSlice(value: string, limit: number, fromEnd = false): string {
  const slice = fromEnd ? value.slice(-limit) : value.slice(0, limit);
  if (!slice) return slice;
  if (!fromEnd && /[\uD800-\uDBFF]$/.test(slice)) return slice.slice(0, -1);
  if (fromEnd && /^[\uDC00-\uDFFF]/.test(slice)) return slice.slice(1);
  return slice;
}

/**
 * ⭐ **텍스트 축 비밀 마스킹** (2026-07-27) — `redactSecrets` 는 **객체 키**(`authorization` 등)를 가린다.
 * 그런데 비밀은 **값 안의 자유 텍스트**로도 들어온다 — 대표적으로 **LLM 출력**(리뷰 지적·요약)이
 * 원문 diff 의 토큰을 그대로 인용하는 경우다. 키 축만으로는 그게 통과한다.
 *
 * ⚠️ **재발명 금지 조사 결과**(2026-07-27 · omni-crawl):
 *   · npm 의 `fast-redact`/`slow-redact`/`deep-redact`/`redact-secrets` 는 전부 **객체 경로** redaction —
 *     "필드를 아는" 경우용이라 자유 텍스트에 안 맞는다.
 *   · 자유 텍스트 탐지의 성숙한 자산은 **gitleaks**(MIT·27.7k★)인데 **외부 Go 바이너리**라
 *     로그 1줄마다 셸아웃할 수 없다(in-process 필요).
 *   ⇒ **런타임이 아니라 규칙(지식)을 재사용**한다 — 아래 패턴은 gitleaks 기본 config(MIT)의
 *     해당 rule 정규식을 **그대로 이식**했다. 출처를 rule id 로 남겨 상류 갱신 시 대조 가능하게 한다.
 *     https://github.com/gitleaks/gitleaks `config/gitleaks.toml`
 *
 * ⚠️ **한계 정직 표기**: 완전한 비밀 탐지는 원리적으로 불가능하다(일반 문자열과 구분 불가).
 * 이건 **최선의 방어**이지 보장이 아니며, 근본 방어는 애초에 **원문을 길게 싣지 않는 것**이다.
 */
/** 규칙 = gitleaks 기본 config(MIT)의 rule 정규식 이식. `re` 의 **그룹1이 식별 접두**이고 나머지가
 *  비밀 본문이다(그룹이 없으면 전체를 가린다). 접두를 남기는 이유 = "무엇이 샜나"는 읽혀야 한다. */
const SECRET_TEXT_RULES: readonly { readonly id: string; readonly re: RegExp; readonly to: string }[] = [
  // gitleaks: private-key — 블록 전체를 가린다(접두 보존 없음).
  { id: 'private-key', re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/gi, to: '<private-key redacted>' },
  { id: 'anthropic-api-key', re: /\b(sk-ant-(?:api|admin)[0-9]{0,2}-)[A-Za-z0-9_-]{8,}/g, to: '$1***' },
  { id: 'openai-api-key-scoped', re: /\b(sk-(?:proj|svcacct|admin)-)[A-Za-z0-9_-]{8,}/g, to: '$1***' },
  { id: 'openrouter-api-key', re: /\b(sk-or-v1-)[A-Za-z0-9]{16,}/g, to: '$1***' },
  { id: 'openai-api-key', re: /\b(sk-)[A-Za-z0-9]{16,}/g, to: '$1***' },
  { id: 'xai-api-key', re: /\b(xai-)[A-Za-z0-9]{20,}/g, to: '$1***' },
  { id: 'github-fine-grained-pat', re: /\b(github_pat_)\w{20,}/g, to: '$1***' },
  { id: 'github-token', re: /\b((?:ghp|gho|ghu|ghs|ghr)_)[0-9a-zA-Z]{20,}/g, to: '$1***' },
  { id: 'aws-access-token', re: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA))[A-Z2-7]{16}\b/g, to: '$1***' },
  { id: 'slack-token', re: /\b(xox[abprs]-)[0-9A-Za-z-]{10,}/g, to: '$1***' },
  { id: 'gcp-api-key', re: /\b(AIza)[0-9A-Za-z_-]{35}\b/g, to: '$1***' },
  { id: 'jwt', re: /\b(ey)[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9._\\/-]{10,}/g, to: '$1***' },
  // gitleaks: generic-api-key 축소판 — `key = value` 형태.
  { id: 'generic-api-key', re: /\b(access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|token|credential)\b(\s*[:=]\s*)["']?[^\s"',;)]{4,}/gi, to: '$1$2***' },
  // 환경변수 형태 `OPENROUTER_API_KEY=…` — 위 규칙은 `_API_KEY` 앞에 단어 경계가 없어 못 잡는다. 값에 글자가 있어야 한다(`MAX_TOKEN=4096` 은 그대로).
  { id: 'env-secret', re: /\b([A-Z][A-Z0-9]*_(?:[A-Z0-9]+_)*(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY))(\s*[:=]\s*)["']?(?=[^\s"',;)]*[A-Za-z])[^\s"',;)]{8,}/g, to: '$1$2***' },
  // BEDROCK-PROVIDER — `AWS_BEARER_TOKEN_BEDROCK=…` 은 이름이 TOKEN 으로 «끝나지» 않아 위 규칙이 못 잡는다.
  { id: 'aws-bedrock-bearer-env', re: /\b(AWS_BEARER_TOKEN_BEDROCK)(\s*[:=]\s*)["']?[^\s"',;)]{8,}/g, to: '$1$2***' },
  // Authorization 헤더(로그에서 흔하다).
  { id: 'authorization-header', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, to: '$1 ***' },
];

/**
 * 자유 텍스트에서 알려진 비밀 패턴을 가린다(순수). **식별 접두는 남기고 본문만** 가려
 * "무엇이 샜나"는 읽히되 값은 복원 불가하게 한다.
 * ⚠️ `redactSecrets` 의 문자열 값에도 적용된다(키 축 ⊕ 텍스트 축).
 */
export function redactSecretText(input: string): string {
  let out = String(input ?? '');
  for (const { re, to } of SECRET_TEXT_RULES) {
    re.lastIndex = 0;              // g 플래그 재사용 안전(순서 의존 제거)
    out = out.replace(re, to);
  }
  return out;
}

/** Redact common secret fields from a payload. Used by callers
 *  before handing objects to debug.log — we never want
 *  `Authorization: Bearer sk-...` written to disk.
 *  ⭐ 2026-07-27 — **문자열 값에는 텍스트 축(`redactSecretText`)도 적용**한다(키 축만으론 값 안의
 *  토큰이 통과한다). 비-문자열·구조는 종전과 동일. */
export function redactSecrets<T>(obj: T): T {
  if (obj == null || typeof obj !== 'object') return obj;
  const copy: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (
      keyLower === 'authorization'
      || keyLower === 'api-key' || keyLower === 'apikey'
      || keyLower === 'x-api-key'
      || keyLower === 'openai-api-key'
      || keyLower === 'cookie'
      || keyLower === 'access_token' || keyLower === 'accesstoken'
      || keyLower === 'refresh_token' || keyLower === 'refreshtoken'
    ) {
      copy[k] = typeof v === 'string' && v.length > 12
        ? safeStringSlice(v, 4) + '…' + safeStringSlice(v, 4, true)
        : '<redacted>';
    } else if (typeof v === 'object' && v !== null) {
      copy[k] = redactSecrets(v);
    } else if (typeof v === 'string') {
      copy[k] = redactSecretText(v);   // ⭐ 텍스트 축 — 값 안의 토큰도 가린다
    } else {
      copy[k] = v;
    }
  }
  return copy as T;
}
