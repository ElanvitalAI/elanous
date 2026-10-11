// ── AWS Bedrock (Claude in Amazon Bedrock) — 자격·리전·서명·모델 id (BEDROCK-PROVIDER · 2026-10-10) ──
//
// 대표 «Bedrock 까지 같이»(10-10). 이 모듈은 `llm.ts` 를 import 하지 않는다(순환 방지) —
// 공급자 본체(`makeBedrockProvider`)는 `llm.ts` 가 Anthropic 메시지 조립·SSE 파서를 그대로 재사용해 만든다.
//
// ⭐ 고른 API = «Claude in Amazon Bedrock» 메시지 엔드포인트(Mantle)
//    `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages` · SigV4 서비스 `bedrock-mantle`.
//    📏 출처: https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock (2026-10-10 확인)
//    — *"Unlike the InvokeModel-based integration, this endpoint uses standard SSE streaming and the same
//    request body shape as Anthropic's first-party API."* ⇒ 몸(`cache_control` 포함)·SSE 파서를 «바이트 그대로» 재사용한다.
//    (레거시 InvokeModel 은 AWS event-stream 이진 인코딩이라 별도 디코더가 필요하다.)
//
// ⭐ BEDROCK-RUNTIME-PATH(2026-10-11) — «경로» 둘. 모델 표의 `route` 칸이 고른다.
//    · `mantle`  = 위 메시지 엔드포인트. 📏 10-11 실측: mantle `GET /v1/models` 에 Sonnet/Haiku 5.5 가 «없다»
//                 (ap-northeast-2 = sonnet-5 뿐 · us-east-1 = opus-5-5·sonnet-5·haiku-4-5) ⇒ `anthropic.claude-sonnet-5-5` 는 404.
//    · `runtime` = `bedrock-runtime.{region}.amazonaws.com/model/{id}/invoke-with-response-stream` · SigV4 서비스 `bedrock`.
//                 몸은 같은 Anthropic Messages 꼴(`anthropic_version: bedrock-2023-05-31` · `model`·`stream` 은 빼고 URL 로) —
//                 `cache_control` 자리가 mantle 과 «같다». 응답은 eventstream 이진 프레임(`./bedrock-eventstream.ts`).
//                 📏 전역 추론 프로필 `global.anthropic.claude-{sonnet,haiku}-5-5` 가 ap-northeast-2 에서 200.
//    · `mantle-openai` = 같은 mantle 호스트의 OpenAI chat.completions 호환 엔드포인트(BEDROCK-MODELS-ALL · 비-Anthropic 모델).
//                 경로 `/openai/v1/chat/completions`(OpenAI 계열) · `/v1/chat/completions`(그 밖) · SigV4 서비스 `bedrock-mantle`
//                 · 고정 리전 us-east-1(📏 MK 실측 6/6 200) · 응답은 OpenAI SSE.
//
// ⛔ 자격 «값»은 이 모듈 밖으로 나가지 않는다 — 로그·에러·반환값 어디에도 싣지 않는다(값 미열람 원칙).
//    가용 판정은 «신호가 있나»(이름·파일 존재)만 보고, 실제 해석은 SDK 기본 자격 체인이 한다.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 사람용 별칭 접두. `bedrock/claude-sonnet-5-5` → `anthropic.claude-sonnet-5-5`. */
const BEDROCK_ALIAS_PREFIX = 'bedrock/';

/** runtime(InvokeModel*) 몸의 `anthropic_version` 값 — Bedrock 의 Anthropic Messages 고정값. */
const BEDROCK_RUNTIME_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/** runtime 경로의 SigV4 서명 서비스 이름(`bedrock-runtime` 호스트도 서명 스코프는 `bedrock`). */
const BEDROCK_RUNTIME_SIGV4_SERVICE = 'bedrock';

/** Bedrock 메시지 엔드포인트의 `anthropic-version` 헤더값(출처 문서의 cURL 예시 그대로). */
const BEDROCK_ANTHROPIC_VERSION = '2023-06-01';

/** SigV4 서명 서비스 이름(출처 문서 cURL `--aws-sigv4 "aws:amz:us-east-1:bedrock-mantle"`). */
const BEDROCK_SIGV4_SERVICE = 'bedrock-mantle';

/** 어느 엔드포인트로 보내나 — `mantle`(Anthropic 메시지 엔드포인트) · `runtime`(InvokeModelWithResponseStream) ·
 *  `mantle-openai`(같은 mantle 호스트의 OpenAI chat.completions 호환 엔드포인트 — 비-Anthropic 모델). */
export type BedrockRoute = 'mantle' | 'runtime' | 'mantle-openai';

/** mantle-openai 경로 조각 — OpenAI 계열(`openai.gpt-6-*`)만 `/openai` 접두, 나머지는 `/v1`. */
export type BedrockOpenAIPath = '/openai/v1/chat/completions' | '/v1/chat/completions';

export interface BedrockModelEntry {
  /** 와이어 id(mantle = `model` 필드 · runtime = URL 의 모델/추론 프로필 id). */
  readonly id: string;
  /** 같은 모델의 1st-party id — 계열 판정(adaptive thinking·vision·temperature)에 쓴다. */
  readonly canonical: string;
  readonly tier: 'cheap' | 'balanced' | 'flagship';
  readonly supportsThinking: boolean;
  /** ⭐ 경로 칸 — 이 id 를 «실제로 내는» 엔드포인트. mantle 에 없는 id 를 mantle 로 보내지 않는다. */
  readonly route: BedrockRoute;
  /** `route: 'mantle-openai'` 행만 — chat.completions 경로. */
  readonly openaiPath?: BedrockOpenAIPath;
  /** `route: 'mantle-openai'` 행만 — 이 모델을 내는 고정 리전(📏 MK 실측 us-east-1 mantle 6/6 200). 사용자 리전과 무관하다. */
  readonly region?: string;
}

const MANTLE_OPENAI_REGION = 'us-east-1';

function openaiRow(id: string, tier: BedrockModelEntry['tier'], openaiPath: BedrockOpenAIPath): BedrockModelEntry {
  return { id, canonical: id, tier, supportsThinking: false, route: 'mantle-openai', openaiPath, region: MANTLE_OPENAI_REGION };
}

/** ⭐ 모델 표 = «경로» 결정표(BEDROCK-RUNTIME-PATH · 2026-10-11).
 *  · 5.5 계열 = 전역 추론 프로필(`global.anthropic.…`) ⊕ runtime — 📏 `aws bedrock list-inference-profiles`(ap-northeast-2)에
 *    셋 다 있고, sonnet/haiku 는 `converse` 200 실측. opus-5-5 는 «목록에 있음»까지만 쟀다(호출 0).
 *  · mantle 이 «실제로 내는» 모델(`GET /v1/models` 실측: sonnet-5)은 mantle 그대로.
 *  사람 별칭(`claude-sonnet-5-5`·`bedrock/claude-sonnet-5-5`·접두 없는 `anthropic.claude-sonnet-5-5`)은 canonical 로 이 표를 찾아 `id` 로 푼다.
 *  표 밖 id: 지역/전역 접두(`us.`·`apac.`·`global.`…)가 붙었으면 runtime, 아니면 종전대로 mantle(엔드포인트가 판정). */
export const BEDROCK_MODELS: readonly BedrockModelEntry[] = [
  { id: 'global.anthropic.claude-sonnet-5-5', canonical: 'claude-sonnet-5-5', tier: 'balanced', supportsThinking: true, route: 'runtime' },
  { id: 'global.anthropic.claude-haiku-5-5', canonical: 'claude-haiku-5-5', tier: 'cheap', supportsThinking: true, route: 'runtime' },
  { id: 'global.anthropic.claude-opus-5-5', canonical: 'claude-opus-5-5', tier: 'flagship', supportsThinking: true, route: 'runtime' },
  { id: 'anthropic.claude-sonnet-5', canonical: 'claude-sonnet-5', tier: 'balanced', supportsThinking: true, route: 'mantle' },
  // 비-Anthropic = mantle OpenAI 호환 경로(IAM 변경 없이 가능). runtime Converse 모델(GLM 5.3·Kimi K3·Grok 4.7)은 IAM 결정 뒤라 «아직 없다».
  openaiRow('openai.gpt-6-sol', 'flagship', '/openai/v1/chat/completions'),
  openaiRow('openai.gpt-6-luna', 'balanced', '/openai/v1/chat/completions'),
  openaiRow('zai.glm-5', 'flagship', '/v1/chat/completions'),
  openaiRow('zai.glm-4.7-flash', 'cheap', '/v1/chat/completions'),
  openaiRow('deepseek.v3.2', 'balanced', '/v1/chat/completions'),
  openaiRow('moonshotai.kimi-k2.5', 'balanced', '/v1/chat/completions'),
  openaiRow('qwen.qwen3-coder-next', 'balanced', '/v1/chat/completions'),
  openaiRow('minimax.minimax-m2.5', 'cheap', '/v1/chat/completions'),
  openaiRow('mistral.devstral-2-123b', 'balanced', '/v1/chat/completions'),
];

export const BEDROCK_DEFAULT_MODEL = 'global.anthropic.claude-sonnet-5-5';

/** 지역/전역 추론 프로필 접두(`global.`·`us.`·`eu.`·`apac.`·`jp.`·`au.` …) — 이 꼴은 runtime 만 받는다. */
const BEDROCK_INFERENCE_PROFILE_PREFIX = /^[a-z]{2,6}\.anthropic\./i;

/** 와이어 id → 경로. 표에 있으면 표의 칸, 추론 프로필 접두면 runtime, 그 밖은 종전대로 mantle. */
export function bedrockRouteFor(wireId: string): BedrockRoute {
  const id = wireId.trim();
  const entry = BEDROCK_MODELS.find((m) => m.id === id);
  if (entry) return entry.route;
  return BEDROCK_INFERENCE_PROFILE_PREFIX.test(id) ? 'runtime' : 'mantle';
}

/** 지역/전역 추론 프로필 접두(`us.`·`eu.`·`jp.`·`au.`·`apac.`·`global.`)를 허용한다. */
const BEDROCK_CLAUDE_ID = /^(?:[a-z]{2,6}\.)?anthropic\.claude-[a-z0-9.\-:]+$/i;

/** 이 모델 id 가 «Bedrock 전용 꼴»인가 — `anthropic.claude-…`(접두 허용) 또는 `bedrock/…` 별칭. */
export function isBedrockModelId(model: string | undefined): boolean {
  const m = (model ?? '').trim();
  if (!m) return false;
  if (m.toLowerCase().startsWith(BEDROCK_ALIAS_PREFIX)) return true;
  return BEDROCK_CLAUDE_ID.test(m) || BEDROCK_MODELS.some((e) => e.route === 'mantle-openai' && e.id === m);
}

/** 와이어 id → 고정 리전(mantle-openai 행만). 그 밖은 `fallback`(사용자 리전). */
export function bedrockRegionFor(wireId: string, fallback: string): string {
  const entry = BEDROCK_MODELS.find((m) => m.id === wireId.trim());
  return entry?.route === 'mantle-openai' && entry.region ? entry.region : fallback;
}

/** 입력 → 와이어 id. `bedrock/claude-x` · `claude-x`(provider=bedrock 일 때) · 접두 없는 `anthropic.claude-x`
 *  는 표(canonical)에 있으면 표의 `id`(예 5.5 → `global.anthropic.…` runtime), 없으면 `anthropic.claude-x`.
 *  지역/전역 접두가 «이미» 붙은 id 는 그대로(데이터 거주 선택 보존). 그 밖은 그대로 돌려준다(엔드포인트가 판정한다). */
export function resolveBedrockModelId(model: string | undefined): string {
  const raw = (model ?? '').trim();
  if (!raw) return BEDROCK_DEFAULT_MODEL;
  let m = raw;
  if (m.toLowerCase().startsWith(BEDROCK_ALIAS_PREFIX)) m = m.slice(BEDROCK_ALIAS_PREFIX.length);
  if (BEDROCK_INFERENCE_PROFILE_PREFIX.test(m) && BEDROCK_CLAUDE_ID.test(m)) return m;
  const bare = /^anthropic\.claude-/i.test(m) ? m.slice('anthropic.'.length) : /^claude-/i.test(m) ? m : undefined;
  if (bare === undefined) return m;
  const entry = BEDROCK_MODELS.find((e) => e.canonical === bare.toLowerCase());
  return entry ? entry.id : `anthropic.${bare}`;
}

/** 와이어 id → 1st-party 꼴(`claude-…`). 계열 판정 헬퍼(adaptive·vision·temperature)가 이 꼴을 안다. */
export function bedrockCanonicalClaudeId(model: string | undefined): string {
  const wire = resolveBedrockModelId(model);
  return wire.replace(/^(?:[a-z]{2,6}\.)?anthropic\./i, '');
}

/** 표의 모델을 찾는다 — 지역/전역 추론 프로필 접두(`us.anthropic.…`)도 같은 모델로 본다(계열은 접두를 뗀 꼴로). */
export function findBedrockModel(id: string): BedrockModelEntry | undefined {
  const canonical = bedrockCanonicalClaudeId(id.trim()).toLowerCase();
  return BEDROCK_MODELS.find((m) => m.canonical === canonical);
}

// ── 리전 ──

type Env = Record<string, string | undefined>;

function awsConfigPath(env: Env): string {
  return env.AWS_CONFIG_FILE?.trim() || join(homedir(), '.aws', 'config');
}

function awsCredentialsPath(env: Env): string {
  return env.AWS_SHARED_CREDENTIALS_FILE?.trim() || join(homedir(), '.aws', 'credentials');
}

/** 설정 파일에서 «그 프로필의 region 한 칸»만 꺼낸다(동기). 다른 키는 읽어 들여도 보관·반환하지 않는다. */
export function regionFromAwsConfigText(text: string, profile: string): string | undefined {
  const wanted = profile === 'default' ? ['default', 'profile default'] : [`profile ${profile}`];
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inSection = wanted.includes(section[1]!.trim());
      continue;
    }
    if (!inSection) continue;
    const kv = /^region\s*=\s*(\S+)/.exec(line);
    if (kv) return kv[1];
  }
  return undefined;
}

export interface BedrockEnvDeps {
  env?: Env;
  /** 설정 파일 읽기 seam(시험). */
  readText?: (path: string) => string | undefined;
}

/** 리전 해석 — `AWS_REGION` → `AWS_DEFAULT_REGION` → 설정 파일(활성 프로필의 region). 없으면 undefined(=미가용). */
export function resolveBedrockRegion(deps: BedrockEnvDeps = {}): string | undefined {
  const env = deps.env ?? process.env;
  const fromEnv = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  if (fromEnv) return validBedrockRegion(fromEnv);
  const readText = deps.readText ?? ((p: string) => {
    try { return existsSync(p) ? readFileSync(p, 'utf8') : undefined; } catch { return undefined; }
  });
  const text = readText(awsConfigPath(env));
  if (!text) return undefined;
  return validBedrockRegion(regionFromAwsConfigText(text, env.AWS_PROFILE?.trim() || 'default'));
}

/** ⛔ 리전은 호스트 이름에 들어간다 — AWS 리전 꼴(`us-east-1`·`ap-northeast-2`·`us-gov-west-1`)만 받는다.
 *  `us-east-1@evil.example/` 같은 값이 URL 의 호스트를 바꿔 자격 헤더가 밖으로 나가는 것을 막는다(무효면 미가용). */
const AWS_REGION_SHAPE = /^[a-z]{2,4}(?:-[a-z]+)+-\d{1,2}$/;

export function validBedrockRegion(region: string | undefined): string | undefined {
  const r = region?.trim();
  return r && AWS_REGION_SHAPE.test(r) ? r : undefined;
}

/** 활성 프로필 섹션에 «자격을 낳는 키 이름»이 있나(값은 보지 않는다 — 키 이름만). */
const CONFIG_CREDENTIAL_KEYS = [
  'aws_access_key_id', 'sso_session', 'sso_start_url', 'role_arn', 'credential_process',
  'source_profile', 'web_identity_token_file', 'credential_source', 'login_session',
];

function profileHasCredentialKeys(text: string, sectionNames: readonly string[]): boolean {
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inSection = sectionNames.includes(section[1]!.trim());
      continue;
    }
    if (!inSection) continue;
    const key = /^([A-Za-z0-9_]+)\s*=/.exec(line)?.[1]?.toLowerCase();
    if (key && CONFIG_CREDENTIAL_KEYS.includes(key)) return true;
  }
  return false;
}

/** 자격 «신호»가 있나 — ⚠️ 근사다(값을 읽지 않는다: env 이름 · 활성 프로필 섹션의 키 이름만).
 *  실제 해석(체인)은 호출 때 `buildSignedBedrockRequest` 가 하고, 못 풀면 그 자리에서 사유와 함께 실패한다. */
export function bedrockCredentialSignal(deps: BedrockEnvDeps = {}): string | undefined {
  const env = deps.env ?? process.env;
  const has = (k: string) => !!env[k]?.trim();
  if (has('AWS_BEARER_TOKEN_BEDROCK')) return 'bearer-env';
  if (has('AWS_ACCESS_KEY_ID') && has('AWS_SECRET_ACCESS_KEY')) return 'env';
  if (has('AWS_WEB_IDENTITY_TOKEN_FILE')) return 'web-identity';
  if (has('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI') || has('AWS_CONTAINER_CREDENTIALS_FULL_URI')) return 'container';
  const readText = deps.readText ?? ((p: string) => {
    try { return existsSync(p) ? readFileSync(p, 'utf8') : undefined; } catch { return undefined; }
  });
  const profile = env.AWS_PROFILE?.trim() || 'default';
  const credText = readText(awsCredentialsPath(env));
  if (credText && profileHasCredentialKeys(credText, [profile])) return 'shared-credentials-file';
  const cfgText = readText(awsConfigPath(env));
  const cfgSections = profile === 'default' ? ['default', 'profile default'] : [`profile ${profile}`];
  if (cfgText && profileHasCredentialKeys(cfgText, cfgSections)) return 'shared-config-profile';
  // 신호가 없어도 체인은 EC2 인스턴스 역할(IMDS)로 풀 수 있다 — 그 경로는 동기로 볼 수 없다.
  return undefined;
}

/** 관측용 신호 이름 — 신호가 없으면 `chain`(IMDS 등 체인에 맡김). */
export function bedrockCredentialSignalLabel(deps: BedrockEnvDeps = {}): string {
  return bedrockCredentialSignal(deps) ?? 'chain';
}

export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type BedrockCredentialResolver = () => Promise<BedrockCredentials>;

/** SDK 기본 자격 체인(env → SSO → ini 프로필 → process → web identity → ECS/IMDS). 지연 import. */
async function defaultBedrockCredentialResolver(): Promise<BedrockCredentials> {
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
  const c = await defaultProvider()();
  return {
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
  };
}

/** 동기 가용 판정 = «가용 후보» = 리전이 풀리나. ⭐ 자격은 판정하지 않고 체인에 맡긴다(codex 확인판 must-fix ①):
 *  리전 ⊕ EC2 인스턴스 역할(IMDS)만 있는 호스트도 기본 자격 체인의 정당한 경로인데, 동기로는 IMDS 를 볼 수 없다.
 *  ⇒ 실제 해석은 보내기 «전»에 체인이 하고, 못 풀면 송신 0 으로 실패한다(`BedrockCredentialsUnresolvedError`).
 *  ⛔ bedrock 은 명시 선택 전용이라 «후보»로 둬도 자동 선택·폴백에는 안 들어간다(시험으로 고정). */
export function bedrockAvailable(deps: BedrockEnvDeps = {}): boolean {
  return resolveBedrockRegion(deps) !== undefined;
}

/** 응답 본문의 AWS 식별자(ARN · 12자리 계정 번호)를 가린다 — 403 `permission_error` 본문이 IAM 주체 ARN 을 그대로 싣는다
 *  (📏 BEDROCK-CHECK 10-11 실호출). `redactSecrets` 는 ARN 을 모른다 ⇒ 에러 문면·로그로 계정이 새지 않게 여기서 한 번 더 지운다. */
export function redactAwsIdentifiers(text: string): string {
  return text
    .replace(/arn:aws[a-z-]*:[^\s"',;]*/gi, 'arn:<redacted>')
    .replace(/(?<![0-9])[0-9]{12}(?![0-9])/g, '<account>');
}

/** SDK 자격 체인이 내는 «고정» 에러 이름 — 이것만 메시지·로그에 싣는다. 그 밖은 `CredentialResolutionError`. */
const KNOWN_CREDENTIAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  'CredentialsProviderError', 'ProviderError', 'TokenProviderError', 'TimeoutError',
  'AbortError', 'ExpiredTokenException', 'InvalidIdentityToken', 'AccessDeniedException',
  'UnrecognizedClientException', 'InvalidGrantException', 'UnauthorizedException',
]);

/** 에러 이름 정규화 — 허용 목록이면 그 이름, 아니면 고정 문자열(임의 문자열이 로그·메시지로 새지 않게). */
export function sanitizeCredentialErrorName(err: unknown): string {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === 'string' && KNOWN_CREDENTIAL_ERROR_NAMES.has(name) ? name : 'CredentialResolutionError';
}

/** 체인이 자격을 못 풀었을 때의 에러 — 에러 «이름»만 싣는다(값·경로 없음). */
export class BedrockCredentialsUnresolvedError extends Error {
  constructor(causeName: string) {
    super(`Bedrock unavailable: AWS 기본 자격 체인이 자격을 못 풀었다 (${causeName}) — aws sso login · AWS_PROFILE · AWS_ACCESS_KEY_ID 등을 확인`);
    this.name = 'BedrockCredentialsUnresolvedError';
  }
}

// ── 요청 서명 ──

export function bedrockMessagesUrl(region: string): string {
  const valid = validBedrockRegion(region);
  if (!valid) throw new Error('Bedrock: 리전 값이 AWS 리전 꼴이 아니다 — 요청을 만들지 않는다');
  const url = `https://bedrock-mantle.${valid}.api.aws/anthropic/v1/messages`;
  // 이중 확인 — 자격을 붙이기 «전»에 호스트가 기대한 Bedrock 호스트인지 본다.
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== `bedrock-mantle.${valid}.api.aws` || u.username || u.password) {
    throw new Error('Bedrock: 요청 호스트가 Bedrock 엔드포인트가 아니다 — 요청을 만들지 않는다');
  }
  return url;
}

/** ⭐ mantle OpenAI 호환 URL — 경로는 모델 표의 `openaiPath` 칸이 정한다(표 밖 id 는 거부 · 호스트는 메시지 엔드포인트와 같다). */
export function bedrockMantleOpenAIUrl(region: string, modelId: string): string {
  const valid = validBedrockRegion(region);
  if (!valid) throw new Error('Bedrock: 리전 값이 AWS 리전 꼴이 아니다 — 요청을 만들지 않는다');
  const entry = BEDROCK_MODELS.find((m) => m.id === modelId.trim());
  if (entry?.route !== 'mantle-openai' || !entry.openaiPath) throw new Error('Bedrock: 모델이 mantle OpenAI 경로 표에 없다 — 요청을 만들지 않는다');
  const host = `bedrock-mantle.${valid}.api.aws`;
  const url = `https://${host}${entry.openaiPath}`;
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== host || u.username || u.password || u.search || u.hash) {
    throw new Error('Bedrock: 요청 호스트가 Bedrock 엔드포인트가 아니다 — 요청을 만들지 않는다');
  }
  return url;
}

/** ⭐ runtime 경로 URL — 리전 꼴 검증 ⊕ 모델 id 꼴 검증 ⊕ 호스트 이중 확인(자격을 붙이기 «전»).
 *  모델 id 는 경로 조각이라 `/`·`?`·`#`·`@` 등을 받지 않는다(추론 프로필 id 꼴 `[A-Za-z0-9._:-]` 만). */
const BEDROCK_RUNTIME_MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function bedrockRuntimeInvokeUrl(region: string, modelId: string): string {
  const valid = validBedrockRegion(region);
  if (!valid) throw new Error('Bedrock: 리전 값이 AWS 리전 꼴이 아니다 — 요청을 만들지 않는다');
  const id = modelId.trim();
  if (!BEDROCK_RUNTIME_MODEL_ID_SHAPE.test(id)) throw new Error('Bedrock: 모델 id 가 추론 프로필 id 꼴이 아니다 — 요청을 만들지 않는다');
  const host = `bedrock-runtime.${valid}.amazonaws.com`;
  const url = `https://${host}/model/${encodeURIComponent(id)}/invoke-with-response-stream`;
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== host || u.username || u.password || u.search || u.hash) {
    throw new Error('Bedrock: 요청 호스트가 Bedrock runtime 엔드포인트가 아니다 — 요청을 만들지 않는다');
  }
  return url;
}

/** 서명 «직전» 호스트 확인 — 경로별로 허용 호스트는 «하나»다. 아니면 자격을 붙이지 않는다. */
export function assertBedrockHost(url: string, region: string, route: BedrockRoute): void {
  const valid = validBedrockRegion(region);
  const u = new URL(url);
  const want = route === 'runtime' ? `bedrock-runtime.${valid}.amazonaws.com` : `bedrock-mantle.${valid}.api.aws`;
  if (!valid || u.protocol !== 'https:' || u.hostname !== want || u.username || u.password) {
    throw new Error('Bedrock: 요청 호스트가 Bedrock 엔드포인트가 아니다 — 자격을 붙이지 않는다');
  }
}

export interface SignedBedrockRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** SigV4 서명 seam — 기본은 `@smithy/signature-v4`(SDK 와 같은 서명기). */
export type BedrockSigner = (input: {
  url: string;
  region: string;
  headers: Record<string, string>;
  body: string;
  credentials: BedrockCredentials;
  /** SigV4 서비스 — mantle `bedrock-mantle` · runtime `bedrock`. 없으면 mantle. */
  service?: string;
}) => Promise<Record<string, string>>;

export const defaultBedrockSigner: BedrockSigner = async ({ url, region, headers, body, credentials, service }) => {
  const [{ SignatureV4 }, { Hash }] = await Promise.all([
    import('@smithy/signature-v4'),
    import('@smithy/hash-node'),
  ]);
  const u = new URL(url);
  const signer = new SignatureV4({
    service: service ?? BEDROCK_SIGV4_SERVICE,
    region,
    credentials,
    sha256: Hash.bind(null, 'sha256'),
  });
  const signed = await signer.sign({
    method: 'POST',
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    headers: { ...headers, host: u.hostname },
    body,
  });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(signed.headers)) out[k] = String(v);
  return out;
};

/** runtime 몸 — mantle 몸에서 `model`(URL 로 간다)·`stream`(엔드포인트가 정한다)을 빼고 `anthropic_version` 을 앞에 둔다.
 *  나머지 칸(`messages`·`system`·`tools`·`cache_control` 자리)은 «바이트 그대로» 같다. */
export function bedrockRuntimeBody(body: Record<string, unknown>): Record<string, unknown> {
  const { model: _model, stream: _stream, ...rest } = body;
  return { anthropic_version: BEDROCK_RUNTIME_ANTHROPIC_VERSION, ...rest };
}

/** 요청 한 건을 조립·서명한다. 베어러 토큰(`AWS_BEARER_TOKEN_BEDROCK`)이 있으면 mantle 은 `x-api-key`(출처 문서 «Bearer tokens»),
 *  runtime 은 `authorization: Bearer`(Bedrock API 키 규약).
 *  mantle-openai 는 OpenAI 호환 엔드포인트 규약대로 베어러를 `authorization: Bearer` 로 보낸다(몸은 mantle 과 같은 `{...body, stream:true}`).
 *  `route` 가 없으면 몸의 `model` 로 표를 본다(`bedrockRouteFor`). */
export async function buildSignedBedrockRequest(input: {
  region: string;
  body: Record<string, unknown>;
  env?: Env;
  resolveCredentials?: BedrockCredentialResolver;
  sign?: BedrockSigner;
  route?: BedrockRoute;
}): Promise<SignedBedrockRequest> {
  const env = input.env ?? process.env;
  const route = input.route ?? bedrockRouteFor(String(input.body.model ?? ''));
  const url = route === 'runtime'
    ? bedrockRuntimeInvokeUrl(input.region, String(input.body.model ?? ''))
    : route === 'mantle-openai'
      ? bedrockMantleOpenAIUrl(input.region, String(input.body.model ?? ''))
      : bedrockMessagesUrl(input.region);
  // URL 과 서명 스코프가 «같은» 정규화 리전을 쓴다(URL 빌더가 무효면 이미 던졌다).
  const region = validBedrockRegion(input.region)!;
  assertBedrockHost(url, region, route);
  const body = route === 'runtime'
    ? JSON.stringify(bedrockRuntimeBody(input.body))
    : JSON.stringify({ ...input.body, stream: true });
  const base: Record<string, string> = route === 'runtime'
    ? { 'content-type': 'application/json', accept: 'application/vnd.amazon.eventstream' }
    : route === 'mantle-openai'
      ? { 'content-type': 'application/json', accept: 'text/event-stream' }
      : { 'content-type': 'application/json', 'anthropic-version': BEDROCK_ANTHROPIC_VERSION };
  const bearer = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  if (bearer) {
    return { url, headers: route === 'mantle' ? { ...base, 'x-api-key': bearer } : { ...base, authorization: `Bearer ${bearer}` }, body };
  }
  let credentials: BedrockCredentials;
  try {
    credentials = await (input.resolveCredentials ?? defaultBedrockCredentialResolver)();
  } catch (err) {
    throw new BedrockCredentialsUnresolvedError(sanitizeCredentialErrorName(err));
  }
  const service = route === 'runtime' ? BEDROCK_RUNTIME_SIGV4_SERVICE : BEDROCK_SIGV4_SERVICE;
  const headers = await (input.sign ?? defaultBedrockSigner)({ url, region, headers: base, body, credentials, service });
  return { url, headers, body };
}

/** 호스트의 replace-env 자식(`childLlmSelectionEnv` · run-context.ts)에 넘길 AWS env 이름 — Pod 와 무관하다.
 *  자격이 «파일»(~/.aws)이면 자식이 HOME 으로 읽고, «env» 면 이 목록대로 릴레이한다. */
const BEDROCK_RELAY_ENV_KEYS: readonly string[] = [
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  // IMDS(EC2 인스턴스 역할) 체인 조절 — 부모가 바꿨으면 자식도 같은 길로.
  'AWS_EC2_METADATA_DISABLED', 'AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
  'AWS_STS_REGIONAL_ENDPOINTS',
];

/** 호스트 자식 릴레이 env — 값이 있는 이름만 싣는다(값은 어디에도 찍지 않는다). */
export function bedrockChildRelayEnv(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BEDROCK_RELAY_ENV_KEYS) {
    const val = env[key];
    if (val !== undefined && val !== '') out[key] = val;
  }
  return out;
}
